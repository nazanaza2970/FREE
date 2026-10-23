//! SSH/Telnet/Mosh core: host-key fingerprints, key generation, and the
//! russh client handler. Ported from `server/ssh/*`, `server/telnet.ts`
//! and `server/mosh.ts` for byte-identical protocol behavior.

use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use russh::client;
use russh::keys::{self, PublicKeyBase64, PublicKeyOrCertificate};
use sha2::{Digest, Sha256};

use crate::models::Host;
use crate::state::AppState;

/// `SHA256:<base64(sha256(wire-blob))>` — same format the TS server stored,
/// including base64 padding.
pub fn host_key_fingerprint(blob: &[u8]) -> String {
    format!("SHA256:{}", B64.encode(Sha256::digest(blob)))
}

/// First length-prefixed string of an SSH wire blob (the algorithm name).
pub fn host_key_alg(blob: &[u8]) -> String {
    if blob.len() < 5 {
        return "unknown".into();
    }
    let len = u32::from_be_bytes([blob[0], blob[1], blob[2], blob[3]]) as usize;
    if len == 0 || len > blob.len() - 4 {
        return "unknown".into();
    }
    let alg = String::from_utf8_lossy(&blob[4..4 + len]).into_owned();
    if alg
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "@.-".contains(c))
    {
        alg
    } else {
        "unknown".into()
    }
}

pub struct GeneratedKey {
    pub key_type: String,
    pub private: String,
    pub public: String,
    pub fingerprint: String,
}

/// Generate an OpenSSH keypair. RSA keys are always 4096-bit (ssh-key's
/// `PrivateKey::random` does not expose the bit size); ed25519 ignores bits.
pub fn generate_keypair(key_type: &str, bits: u32, comment: Option<&str>) -> Result<GeneratedKey, String> {
    let algorithm = match key_type {
        "ed25519" => keys::Algorithm::Ed25519,
        "rsa" => keys::Algorithm::Rsa { hash: None },
        other => return Err(format!("unsupported key type: {other}")),
    };
    let mut rng = keys::key::safe_rng();
    let mut key = keys::PrivateKey::random(&mut rng, algorithm)
        .map_err(|e| format!("keygen failed: {e}"))?;
    let comment = comment.unwrap_or("").trim();
    if !comment.is_empty() {
        key.set_comment(comment);
    }
    let private = key
        .to_openssh(keys::ssh_key::LineEnding::LF)
        .map_err(|e| format!("key encoding failed: {e}"))?
        .to_string();
    let public_key = key.public_key();
    let blob = public_key.public_key_bytes();
    let alg = host_key_alg(&blob);
    let mut public = format!("{alg} {}", B64.encode(&blob));
    if !comment.is_empty() {
        public.push(' ');
        public.push_str(comment);
    }
    let _ = bits; // RSA bit size is fixed at 4096 by ssh-key.
    Ok(GeneratedKey {
        key_type: key_type.to_string(),
        private,
        public,
        fingerprint: host_key_fingerprint(&blob),
    })
}

/// Client handler that captures the server's host key during KEX.
/// Trust decisions happen after connect (parity with the old `hostVerifier`
/// that always approved, then compared fingerprints).
pub struct TermHandler {
    pub host_key: Arc<Mutex<Option<Vec<u8>>>>,
    /// When set, serves the in-app ssh-agent on forwarded agent channels
    /// (parity with ssh2's `config.agent = new InAppAgent(...)`).
    agent: Option<AppState>,
}

impl TermHandler {
    pub fn new() -> (Self, Arc<Mutex<Option<Vec<u8>>>>) {
        Self::with_agent(None)
    }

    pub fn with_agent(agent: Option<AppState>) -> (Self, Arc<Mutex<Option<Vec<u8>>>>) {
        let host_key = Arc::new(Mutex::new(None));
        (
            Self {
                host_key: Arc::clone(&host_key),
                agent,
            },
            host_key,
        )
    }
}

impl client::Handler for TermHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let blob = server_public_key.public_key().public_key_bytes();
        *self.host_key.lock().expect("host key mutex") = Some(blob);
        Ok(true)
    }

    async fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if let Some(state) = self.agent.clone() {
            reply.accept().await;
            tokio::spawn(crate::agent::serve_agent(channel, state));
        }
        // No agent configured: drop the handle → reject.
        Ok(())
    }
}

/// Client handler for tunnel connections (parity with the ssh2 client in
/// `server/forwards.ts`): accepts the server's host key unconditionally (the
/// old code configured no hostVerifier) and services remote-forward inbound
/// channels by connecting to the recorded local target.
pub struct FwdHandler {
    /// bind port → (target host, target port) for active remote forwards.
    pub remote_targets: Arc<Mutex<std::collections::HashMap<u16, (String, u32)>>>,
}

impl client::Handler for FwdHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let target = self
            .remote_targets
            .lock()
            .expect("remote targets mutex")
            .get(&(connected_port as u16))
            .cloned();
        match target {
            Some((host, port)) => {
                reply.accept().await;
                tokio::spawn(async move {
                    let addr = format!("{host}:{port}");
                    if let Ok(stream) = tokio::net::TcpStream::connect(&addr).await {
                        crate::forwards::pipe_channel_socket(stream, channel).await;
                    }
                });
                Ok(())
            }
            None => {
                // No matching forward: drop the handle → reject.
                Ok(())
            }
        }
    }
}

pub type SshHandle = client::Handle<TermHandler>;
pub type FwdHandle = client::Handle<FwdHandler>;

/// Auth setup mirroring `buildAuthConfig` in server/ssh/auth.ts.
pub enum SshAuth {
    Password(String),
    PrivateKey(keys::PrivateKey),
}

pub fn build_auth(host: &Host) -> Result<SshAuth, String> {
    if host.auth_method == "key" {
        let Some(private_key) = host.private_key.as_ref().filter(|k| !k.is_empty()) else {
            return Err("no private key configured for host".into());
        };
        let key = keys::decode_secret_key(private_key, host.pass_phrase.as_deref())
            .map_err(|e| format!("failed to load private key: {e}"))?;
        Ok(SshAuth::PrivateKey(key))
    } else {
        let Some(password) = host.password.as_ref().filter(|p| !p.is_empty()) else {
            return Err("no credentials configured for host".into());
        };
        Ok(SshAuth::Password(password.clone()))
    }
}

pub async fn authenticate<H>(
    handle: &mut client::Handle<H>,
    username: &str,
    auth: SshAuth,
) -> Result<(), String>
where
    H: client::Handler<Error = russh::Error>,
{
    let ok = match auth {
        SshAuth::Password(password) => handle
            .authenticate_password(username, password)
            .await
            .map_err(|e| e.to_string())?
            .success(),
        SshAuth::PrivateKey(key) => {
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten();
            handle
                .authenticate_publickey(
                    username,
                    keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(|e| e.to_string())?
                .success()
        }
    };
    if ok {
        Ok(())
    } else {
        Err("authentication failed".into())
    }
}

// ---------------------------------------------------------------------------
// Telnet (parity with server/telnet.ts: WONT/DONT negotiation, subneg
// discard, IAC/IP and IAC/IA passthrough).
// ---------------------------------------------------------------------------

const IAC: u8 = 0xff;
const DONT: u8 = 0xfc;
const DO: u8 = 0xfd;
const WONT: u8 = 0xfe;
const WILL: u8 = 0xfb;
const SB: u8 = 0xfa;
const SE: u8 = 0xf0;
const IP: u8 = 0xf9;
const IA: u8 = 0xf1;

/// Filter one TCP chunk through the telnet state machine, returning the
/// payload bytes to surface and the reply bytes to send back.
pub struct TelnetFilter {
    pending_iac: bool,
    in_subneg: bool,
}

impl TelnetFilter {
    pub fn new() -> Self {
        Self {
            pending_iac: false,
            in_subneg: false,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut out = Vec::new();
        let mut reply = Vec::new();
        let mut i = 0;
        while i < chunk.len() {
            let b = chunk[i];
            if self.in_subneg {
                if b == SE {
                    self.in_subneg = false;
                }
                i += 1;
                continue;
            }
            if self.pending_iac {
                self.pending_iac = false;
                match b {
                    DO => {
                        reply.extend_from_slice(&[IAC, WONT, chunk.get(i + 1).copied().unwrap_or(0)]);
                        i += 1;
                    }
                    WILL => {
                        reply.extend_from_slice(&[IAC, DONT, chunk.get(i + 1).copied().unwrap_or(0)]);
                        i += 1;
                    }
                    SB => self.in_subneg = true,
                    IP => out.extend_from_slice(&[IAC, IP]),
                    IA => out.extend_from_slice(&[IAC, IA]),
                    _ => {}
                }
                i += 1;
                continue;
            }
            if b == IAC {
                self.pending_iac = true;
                i += 1;
                continue;
            }
            out.push(b);
            i += 1;
        }
        (out, reply)
    }
}

/// `which`-style lookup used for mosh binaries.
pub fn which(bin: &str) -> Option<String> {
    let shell = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    let output = std::process::Command::new(shell).arg(bin).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.trim().lines().next().map(|l| l.trim().to_string())
}

pub fn has_mosh() -> bool {
    which("mosh-client").is_some() && which("mosh-server").is_some()
}
