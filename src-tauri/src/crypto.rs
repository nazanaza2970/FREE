use std::fs;
use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};

const BLOB_VERSION: &str = "v1";
const KEY_BYTES: usize = 32;

/// Device-level master key store. Lives in the app config dir; a legacy
/// `~/.termius-free/keystore.json` is imported on first load.
pub struct Keystore {
    key: [u8; KEY_BYTES],
}

#[derive(Serialize, Deserialize)]
struct KeystoreFile {
    key: String,
}

impl Keystore {
    pub fn load(config_dir: &Path) -> Result<Self, String> {
        let path = config_dir.join("keystore.json");
        if !path.exists() {
            Self::import_legacy(&path);
        }
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(file) = serde_json::from_str::<KeystoreFile>(&raw) {
                if let Ok(bytes) = B64.decode(file.key.trim()) {
                    if bytes.len() == KEY_BYTES {
                        let mut key = [0u8; KEY_BYTES];
                        key.copy_from_slice(&bytes);
                        return Ok(Self { key });
                    }
                }
            }
        }
        let mut key = [0u8; KEY_BYTES];
        rand::thread_rng().fill_bytes(&mut key);
        fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
        let payload = serde_json::to_string_pretty(&KeystoreFile {
            key: B64.encode(key),
        })
        .map_err(|e| e.to_string())?;
        fs::write(&path, format!("{payload}\n")).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
        Ok(Self { key })
    }

    fn import_legacy(new_path: &Path) {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        let legacy = Path::new(&home).join(".termius-free").join("keystore.json");
        if legacy.exists() {
            let _ = fs::copy(&legacy, new_path);
        }
    }

    /// Encrypts plaintext into a `v1.<iv>.<tag>.<data>` base64 blob.
    pub fn encrypt(&self, plain: &str) -> String {
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&self.key));
        let iv = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = cipher
            .encrypt(&iv, plain.as_bytes())
            .expect("aes-gcm encryption cannot fail");
        format!(
            "{BLOB_VERSION}.{}.{}.{}",
            B64.encode(iv),
            B64.encode(&ciphertext[ciphertext.len() - 16..]),
            B64.encode(&ciphertext[..ciphertext.len() - 16])
        )
    }

    /// Reverses [`Keystore::encrypt`]; errors on tamper or version mismatch.
    pub fn decrypt(&self, blob: &str) -> Result<String, String> {
        let parts: Vec<&str> = blob.split('.').collect();
        let [version, iv_b64, tag_b64, data_b64] = parts.as_slice() else {
            return Err("unsupported snippet blob".into());
        };
        if *version != BLOB_VERSION {
            return Err("unsupported snippet blob".into());
        }
        let iv = B64.decode(iv_b64).map_err(|e| e.to_string())?;
        let tag = B64.decode(tag_b64).map_err(|e| e.to_string())?;
        let mut data = B64.decode(data_b64).map_err(|e| e.to_string())?;
        data.extend_from_slice(&tag);
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&self.key));
        let plaintext = cipher
            .decrypt(aes_gcm::Nonce::from_slice(&iv), data.as_slice())
            .map_err(|_| "decrypt failed: authentication tag mismatch".to_string())?;
        String::from_utf8(plaintext).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let ks = Keystore {
            key: [7u8; KEY_BYTES],
        };
        let blob = ks.encrypt("hunter2 🔑");
        assert!(blob.starts_with("v1."));
        assert_eq!(ks.decrypt(&blob).unwrap(), "hunter2 🔑");
    }

    #[test]
    fn tamper_detected() {
        let ks = Keystore {
            key: [7u8; KEY_BYTES],
        };
        let blob = ks.encrypt("secret");
        let mut parts: Vec<String> = blob.split('.').map(str::to_string).collect();
        parts[3] = B64.encode(b"not the ciphertext");
        assert!(ks.decrypt(&parts.join(".")).is_err());
    }
}
