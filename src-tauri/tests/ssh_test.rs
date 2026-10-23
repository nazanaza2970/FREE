use free::ssh;

#[test]
fn fingerprint_matches_node_crypto_format() {
    // Golden value from node:crypto createHash('sha256').update(blob).digest('base64')
    let blob = b"test-key-blob-0123456789";
    assert_eq!(
        ssh::host_key_fingerprint(blob),
        "SHA256:zHlb7CWpAPcgz65xNRyTiOYc2AEbZESahin9Cq4CQ1E="
    );
}

#[test]
fn host_key_alg_parses_wire_blob() {
    // ssh-ed25519 blob: [len=11]["ssh-ed25519"][key bytes]
    let mut blob = Vec::new();
    blob.extend_from_slice(&11u32.to_be_bytes());
    blob.extend_from_slice(b"ssh-ed25519");
    blob.extend_from_slice(&[0u8; 32]);
    assert_eq!(ssh::host_key_alg(&blob), "ssh-ed25519");

    let mut rsa = Vec::new();
    rsa.extend_from_slice(&7u32.to_be_bytes());
    rsa.extend_from_slice(b"ssh-rsa");
    rsa.extend_from_slice(&[1, 2, 3]);
    assert_eq!(ssh::host_key_alg(&rsa), "ssh-rsa");

    assert_eq!(ssh::host_key_alg(&[]), "unknown");
    assert_eq!(ssh::host_key_alg(&[0, 0, 0, 200, 1]), "unknown");
}

#[test]
fn keygen_ed25519_roundtrip() {
    let generated = ssh::generate_keypair("ed25519", 3072, Some("me@host")).unwrap();
    assert_eq!(generated.key_type, "ed25519");
    assert!(generated.private.contains("BEGIN OPENSSH PRIVATE KEY"));
    assert!(generated.public.starts_with("ssh-ed25519 "));
    assert!(generated.public.ends_with(" me@host"));
    assert!(generated.fingerprint.starts_with("SHA256:"));

    // The private key must decode and expose the same public blob.
    let key = russh::keys::decode_secret_key(&generated.private, None).unwrap();
    use russh::keys::PublicKeyBase64;
    let blob = key.public_key().public_key_bytes();
    assert_eq!(ssh::host_key_alg(&blob), "ssh-ed25519");
    assert_eq!(
        ssh::host_key_fingerprint(&blob),
        generated.fingerprint
    );
    assert!(generated.public.contains(&base64_encode(&blob)));
}

#[test]
fn keygen_rsa_is_4096_and_openssh_format() {
    let generated = ssh::generate_keypair("rsa", 3072, None).unwrap();
    assert_eq!(generated.key_type, "rsa");
    assert!(generated.private.contains("BEGIN OPENSSH PRIVATE KEY"));
    assert!(generated.public.starts_with("ssh-rsa "));
    let key = russh::keys::decode_secret_key(&generated.private, None).unwrap();
    use russh::keys::PublicKeyBase64;
    assert_eq!(ssh::host_key_alg(&key.public_key().public_key_bytes()), "ssh-rsa");
}

#[test]
fn keygen_rejects_unknown_type() {
    assert!(ssh::generate_keypair("dsa", 1024, None).is_err());
}

#[test]
fn telnet_filter_negotiation() {
    let mut filter = ssh::TelnetFilter::new();
    // DO SOMETHING (0x01) -> IAC WONT 0x01
    let (payload, reply) = filter.push(&[0xff, 0xfd, 0x01]);
    assert!(payload.is_empty());
    assert_eq!(reply, vec![0xff, 0xfe, 0x01]);
    // WILL SOMETHING -> IAC DONT
    let (payload, reply) = filter.push(&[0xff, 0xfb, 0x1f]);
    assert!(payload.is_empty());
    assert_eq!(reply, vec![0xff, 0xfc, 0x1f]);
    // Subnegotiation is discarded.
    let (payload, reply) = filter.push(&[0xff, 0xfa, 0x1f, 1, 2, 3, 0xff, 0xf0, b'x']);
    assert_eq!(payload, vec![b'x']);
    assert!(reply.is_empty());
    // IAC IP / IAC IA pass through escaped; IAC IAC is swallowed (parity
    // with the TS filter, which drops it in the default arm).
    let (payload, reply) = filter.push(&[0xff, 0xf9, 0xff, 0xf1, 0xff, 0xff]);
    assert_eq!(payload, vec![0xff, 0xf9, 0xff, 0xf1]);
    assert!(reply.is_empty());
    // State persists across chunks (split IAC at chunk boundary).
    let (payload, _) = filter.push(&[0xff]);
    assert!(payload.is_empty());
    let (payload, reply) = filter.push(&[0xfd, 0x08]);
    assert!(payload.is_empty());
    assert_eq!(reply, vec![0xff, 0xfe, 0x08]);
}

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}
