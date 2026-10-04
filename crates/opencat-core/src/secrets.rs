//! Encryption at rest for stored secrets.
//!
//! Connection passwords cannot be hashed (we must replay them to the server), so
//! they are encrypted with AES-256-GCM using a per-installation master key.
//!
//! The master key lives next to the workspace files with owner-only permissions.
//! Stored values carry a version prefix so that plaintext files written by older
//! builds keep loading, and so the format can be migrated later.

use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, Nonce};
use base64::Engine as _;
use rand::RngCore;

use crate::error::{CoreError, Result};

const PREFIX: &str = "enc:v1:";
const KEY_FILE: &str = "master.key";

/// Encrypts and decrypts values stored in the OpenCat workspace.
pub struct SecretStore {
    cipher: Aes256Gcm,
    #[allow(dead_code)]
    key_path: PathBuf,
}

impl std::fmt::Debug for SecretStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretStore(<redacted>)")
    }
}

impl SecretStore {
    /// Load the master key from `dir`, generating one on first run.
    pub fn load_or_create(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let key_path = dir.join(KEY_FILE);

        let key_bytes: [u8; 32] = if key_path.exists() {
            let raw = std::fs::read_to_string(&key_path)?;
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(raw.trim())
                .map_err(|e| CoreError::Config(format!("master key is corrupt: {e}")))?;
            decoded
                .as_slice()
                .try_into()
                .map_err(|_| CoreError::Config("master key has the wrong length".into()))?
        } else {
            let mut buf = [0u8; 32];
            OsRng.fill_bytes(&mut buf);
            let encoded = base64::engine::general_purpose::STANDARD.encode(buf);
            write_private(&key_path, encoded.as_bytes())?;
            buf
        };

        let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
        Ok(SecretStore {
            cipher: Aes256Gcm::new(key),
            key_path,
        })
    }

    /// Build a store from an in-memory key. Used by tests.
    pub fn from_key(key_bytes: [u8; 32]) -> Self {
        let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
        SecretStore {
            cipher: Aes256Gcm::new(key),
            key_path: PathBuf::new(),
        }
    }

    /// Encrypt `plain` into an opaque, storable string. Empty input stays empty so
    /// that "no password" is representable.
    pub fn encrypt(&self, plain: &str) -> Result<String> {
        if plain.is_empty() {
            return Ok(String::new());
        }
        if plain.starts_with(PREFIX) {
            // Already encrypted; avoid double wrapping.
            return Ok(plain.to_string());
        }
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = self
            .cipher
            .encrypt(&nonce, plain.as_bytes())
            .map_err(|e| CoreError::Config(format!("failed to encrypt secret: {e}")))?;
        let mut blob = nonce.to_vec();
        blob.extend_from_slice(&ciphertext);
        Ok(format!(
            "{PREFIX}{}",
            base64::engine::general_purpose::STANDARD.encode(blob)
        ))
    }

    /// Reverse [`SecretStore::encrypt`]. Values without the version prefix are
    /// returned unchanged so legacy plaintext files still work.
    pub fn decrypt(&self, stored: &str) -> Result<String> {
        if stored.is_empty() || !stored.starts_with(PREFIX) {
            return Ok(stored.to_string());
        }
        let body = &stored[PREFIX.len()..];
        let blob = base64::engine::general_purpose::STANDARD
            .decode(body)
            .map_err(|e| CoreError::Config(format!("stored secret is corrupt: {e}")))?;
        if blob.len() < 13 {
            return Err(CoreError::Config("stored secret is truncated".into()));
        }
        let (nonce_bytes, ciphertext) = blob.split_at(12);
        let nonce = Nonce::from_slice(nonce_bytes);
        let plain = self.cipher.decrypt(nonce, ciphertext).map_err(|_| {
            CoreError::Config("could not decrypt stored secret (master key changed?)".into())
        })?;
        String::from_utf8(plain)
            .map_err(|e| CoreError::Config(format!("stored secret is not utf-8: {e}")))
    }

    /// Convenience wrapper for optional values.
    pub fn decrypt_opt(&self, stored: Option<&String>) -> Result<Option<String>> {
        match stored {
            None => Ok(None),
            Some(s) if s.is_empty() => Ok(None),
            Some(s) => self.decrypt(s).map(Some),
        }
    }
}

/// Write a file readable only by the current user.
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(path, perms)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_secret() {
        let store = SecretStore::from_key([7u8; 32]);
        let enc = store.encrypt("hunter2").unwrap();
        assert!(enc.starts_with(PREFIX));
        assert_ne!(enc, "hunter2");
        assert_eq!(store.decrypt(&enc).unwrap(), "hunter2");
    }

    #[test]
    fn empty_and_plaintext_pass_through() {
        let store = SecretStore::from_key([1u8; 32]);
        assert_eq!(store.encrypt("").unwrap(), "");
        assert_eq!(
            store.decrypt("legacy-plaintext").unwrap(),
            "legacy-plaintext"
        );
    }

    #[test]
    fn ciphertext_is_not_reused() {
        let store = SecretStore::from_key([9u8; 32]);
        assert_ne!(
            store.encrypt("same").unwrap(),
            store.encrypt("same").unwrap()
        );
    }
}
