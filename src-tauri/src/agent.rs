//! In-app ssh-agent (parity with `server/ssh/agent.ts`): serves the private
//! keys stored in the host table over the standard SSH agent protocol, so
//! remote shells can authenticate to further hosts without touching the OS
//! agent.

use bytes::Bytes;
use russh::keys::{self, PublicKeyBase64, PrivateKey};
use russh::ChannelMsg;

use crate::db;
use crate::state::AppState;

const SSH_AGENT_FAILURE: u8 = 5;
const SSH_AGENTC_REQUEST_IDENTITIES: u8 = 11;
const SSH_AGENT_IDENTITIES_ANSWER: u8 = 12;
const SSH_AGENTC_SIGN_REQUEST: u8 = 13;
const SSH_AGENT_SIGN_RESPONSE: u8 = 14;

fn put_u32(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_be_bytes());
}

fn put_string(buf: &mut Vec<u8>, s: &[u8]) {
    put_u32(buf, s.len() as u32);
    buf.extend_from_slice(s);
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn u32(&mut self) -> Option<u32> {
        let end = self.pos + 4;
        if end > self.data.len() {
            return None;
        }
        let v = u32::from_be_bytes([
            self.data[self.pos],
            self.data[self.pos + 1],
            self.data[self.pos + 2],
            self.data[self.pos + 3],
        ]);
        self.pos = end;
        Some(v)
    }

    fn string(&mut self) -> Option<&'a [u8]> {
        let len = self.u32()? as usize;
        let end = self.pos.checked_add(len)?;
        if end > self.data.len() {
            return None;
        }
        let s = &self.data[self.pos..end];
        self.pos = end;
        Some(s)
    }
}

fn identities_reply(keys: &[(Vec<u8>, String)]) -> Vec<u8> {
    let mut out = vec![SSH_AGENT_IDENTITIES_ANSWER];
    put_u32(&mut out, keys.len() as u32);
    for (blob, comment) in keys {
        put_string(&mut out, blob);
        put_string(&mut out, comment.as_bytes());
    }
    out
}

fn signed_response(alg: &str, sig: &[u8]) -> Vec<u8> {
    let mut blob = Vec::new();
    put_string(&mut blob, alg.as_bytes());
    put_string(&mut blob, sig);
    let mut out = vec![SSH_AGENT_SIGN_RESPONSE];
    put_string(&mut out, &blob);
    out
}

fn load_keys(state: &AppState) -> Vec<PrivateKey> {
    let material = state.with_db(|conn| db::get_key_material(conn).unwrap_or_default());
    material
        .into_iter()
        .filter_map(|km| keys::decode_secret_key(&km.private_key, km.pass_phrase.as_deref()).ok())
        .collect()
}

/// Total frame length (type byte + body) if `buf` holds a complete request.
fn complete_frame_len(buf: &[u8]) -> Option<usize> {
    if buf.is_empty() {
        return None;
    }
    let mut r = Reader::new(&buf[1..]);
    match buf[0] {
        SSH_AGENTC_REQUEST_IDENTITIES => Some(1),
        SSH_AGENTC_SIGN_REQUEST => {
            r.string()?;
            r.string()?;
            r.u32()?;
            Some(1 + r.pos)
        }
        // Unknown request: length is unknowable; treat as a bare type byte.
        _ => Some(1),
    }
}

fn handle_request(state: &AppState, msg_type: u8, body: &[u8]) -> Vec<u8> {
    match msg_type {
        SSH_AGENTC_REQUEST_IDENTITIES => {
            let keys = load_keys(state);
            let identities: Vec<(Vec<u8>, String)> = keys
                .iter()
                .map(|k| {
                    (k.public_key().public_key_bytes(), k.comment().as_str().map(|s| s.to_string()).unwrap_or_default())
                })
                .collect();
            identities_reply(&identities)
        }
        SSH_AGENTC_SIGN_REQUEST => {
            let mut r = Reader::new(body);
            let want = r.string();
            let data = r.string().map(|d| d.to_vec());
            let _flags = r.u32(); // RSA hash flags; ssh-key signs with its default.
            let (Some(want), Some(data)) = (want, data) else {
                return vec![SSH_AGENT_FAILURE];
            };
            for key in load_keys(state) {
                if key.public_key().public_key_bytes() != want {
                    continue;
                }
                return match russh::keys::signature::Signer::try_sign(&key, &data) {
                    Ok(sig) => signed_response(sig.algorithm().as_str(), sig.as_bytes()),
                    Err(_) => vec![SSH_AGENT_FAILURE],
                };
            }
            vec![SSH_AGENT_FAILURE]
        }
        _ => vec![SSH_AGENT_FAILURE],
    }
}

/// Serves the agent protocol over one forwarded agent channel until it closes.
pub async fn serve_agent(channel: russh::Channel<russh::client::Msg>, state: AppState) {
    let (mut rd, wr) = channel.split();
    let mut buf: Vec<u8> = Vec::new();
    'outer: while let Some(msg) = rd.wait().await {
        let data = match msg {
            ChannelMsg::Data { data } => data,
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => continue,
        };
        buf.extend_from_slice(&data);
        while let Some(frame_len) = complete_frame_len(&buf) {
            let msg_type = buf[0];
            let body: Vec<u8> = buf[1..frame_len].to_vec();
            buf.drain(..frame_len);
            let reply = handle_request(&state, msg_type, &body);
            if wr.data_bytes(Bytes::from(reply)).await.is_err() {
                break 'outer;
            }
        }
    }
    let _ = wr.eof().await;
    let _ = wr.close().await;
}
