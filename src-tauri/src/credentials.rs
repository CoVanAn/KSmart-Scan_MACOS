use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use hex::{decode, encode};
use rand::{rng, Rng};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credential {
    pub username: String,
    pub password: Option<String>,
    #[serde(rename = "httpPort", default = "default_http_port")]
    pub http_port: u16,
    #[serde(rename = "rtspPort", default = "default_rtsp_port")]
    pub rtsp_port: u16,
    #[serde(default)]
    pub tls: bool,
    #[serde(rename = "rtspPath")]
    pub rtsp_path: Option<String>,
    #[serde(default)]
    pub legacy: bool,
    #[serde(rename = "savedAt")]
    pub saved_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SafeCredential {
    pub ip: String,
    pub username: String,
    #[serde(rename = "httpPort")]
    pub http_port: u16,
    #[serde(rename = "rtspPort")]
    pub rtsp_port: u16,
    pub tls: bool,
    #[serde(rename = "rtspPath")]
    pub rtsp_path: Option<String>,
    pub legacy: bool,
    #[serde(rename = "savedAt")]
    pub saved_at: String,
}

fn default_http_port() -> u16 {
    80
}

fn default_rtsp_port() -> u16 {
    554
}

#[derive(Clone)]
pub struct CredentialStore {
    file_path: PathBuf,
    map: Arc<RwLock<HashMap<String, Credential>>>,
    cipher_key: Key<Aes256Gcm>,
}

impl CredentialStore {
    pub fn new(data_dir: PathBuf) -> Self {
        let file_path = data_dir.join("credentials.enc");
        let key_file = data_dir.join(".cred.key");

        fs::create_dir_all(&data_dir).ok();

        let cipher_key = Self::load_key(&key_file);

        let mut store = Self {
            file_path,
            map: Arc::new(RwLock::new(HashMap::new())),
            cipher_key,
        };

        store.load();
        store
    }

    fn load_key(key_file: &Path) -> Key<Aes256Gcm> {
        if let Ok(env_key) = std::env::var("CRED_KEY") {
            let buf = decode(env_key.trim()).expect("CRED_KEY must be valid hex");
            assert_eq!(buf.len(), 32, "CRED_KEY must be 64 hex chars (32 bytes)");
            return (*Key::<Aes256Gcm>::from_slice(&buf)).clone();
        }

        if let Ok(key_content) = fs::read_to_string(key_file) {
            if let Ok(buf) = decode(key_content.trim()) {
                if buf.len() == 32 {
                    return (*Key::<Aes256Gcm>::from_slice(&buf)).clone();
                }
            }
        }

        let mut key_bytes = [0u8; 32];
        rng().fill_bytes(&mut key_bytes);
        fs::write(key_file, encode(key_bytes)).unwrap_or_else(|e| eprintln!("Failed to save key: {}", e));
        
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(mut perms) = fs::metadata(key_file).map(|m| m.permissions()) {
                perms.set_mode(0o600);
                fs::set_permissions(key_file, perms).ok();
            }
        }

        (*Key::<Aes256Gcm>::from_slice(&key_bytes)).clone()
    }

    fn encrypt(&self, plain: &str) -> String {
        let cipher = Aes256Gcm::new(&self.cipher_key);
        let mut n = [0u8; 12]; rng().fill_bytes(&mut n); let nonce = Nonce::from_slice(&n);
        
        let mut ciphertext_with_tag = cipher.encrypt(&nonce, plain.as_bytes().as_ref()).expect("encryption failure");
        
        // Compatible with Node.js logic: IV + TAG + CIPHERTEXT
        let tag_start = ciphertext_with_tag.len() - 16;
        let tag = ciphertext_with_tag.split_off(tag_start); 
        
        let mut result = nonce.to_vec();
        result.extend_from_slice(&tag);
        result.extend_from_slice(&ciphertext_with_tag);
        
        BASE64.encode(result)
    }

    fn decrypt(&self, payload: &str) -> Result<String, anyhow::Error> {
        let raw = BASE64.decode(payload)?;
        if raw.len() < 12 + 16 {
            return Err(anyhow::anyhow!("Invalid payload length"));
        }
        
        let nonce = Nonce::from_slice(&raw[0..12]);
        let tag = &raw[12..28];
        let ciphertext = &raw[28..];
        
        // Reconstruct for Rust aes_gcm: CIPHERTEXT + TAG
        let mut rust_payload = Vec::with_capacity(ciphertext.len() + tag.len());
        rust_payload.extend_from_slice(ciphertext);
        rust_payload.extend_from_slice(tag);
        
        let cipher = Aes256Gcm::new(&self.cipher_key);
        let plaintext = cipher.decrypt(nonce, rust_payload.as_ref()).map_err(|_| anyhow::anyhow!("Decryption failed"))?;
        
        Ok(String::from_utf8(plaintext)?)
    }

    fn load(&mut self) {
        if !self.file_path.exists() {
            return;
        }

        if let Ok(content) = fs::read_to_string(&self.file_path) {
            if let Ok(json_str) = self.decrypt(&content) {
                if let Ok(parsed) = serde_json::from_str::<HashMap<String, Credential>>(&json_str) {
                    let mut map = self.map.write().unwrap();
                    *map = parsed;
                }
            } else {
                eprintln!("[cred] Failed to decrypt credentials store. Ignoring old file.");
            }
        }
    }

    fn persist(&self) {
        let map = self.map.read().unwrap();
        if let Ok(json_str) = serde_json::to_string(&*map) {
            let enc = self.encrypt(&json_str);
            fs::write(&self.file_path, enc).unwrap_or_else(|e| eprintln!("Failed to save credentials: {}", e));
            
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(mut perms) = fs::metadata(&self.file_path).map(|m| m.permissions()) {
                    perms.set_mode(0o600);
                    fs::set_permissions(&self.file_path, perms).ok();
                }
            }
        }
    }

    pub fn get(&self, ip: &str) -> Option<Credential> {
        self.map.read().unwrap().get(ip).cloned()
    }

    pub fn has(&self, ip: &str) -> bool {
        self.map.read().unwrap().contains_key(ip)
    }

    pub fn set(
        &self,
        ip: &str,
        username: String,
        password: Option<String>,
        http_port: u16,
        rtsp_port: u16,
        tls: bool,
        rtsp_path: Option<String>,
        legacy: bool,
    ) -> Credential {
        let cred = Credential {
            username,
            password,
            http_port,
            rtsp_port,
            tls,
            rtsp_path,
            legacy,
            saved_at: Utc::now().to_rfc3339(),
        };

        self.map.write().unwrap().insert(ip.to_string(), cred.clone());
        self.persist();
        cred
    }

    pub fn remove(&self, ip: &str) -> bool {
        let removed = self.map.write().unwrap().remove(ip).is_some();
        if removed {
            self.persist();
        }
        removed
    }

    pub fn list_safe(&self) -> Vec<SafeCredential> {
        self.map
            .read()
            .unwrap()
            .iter()
            .map(|(ip, c)| SafeCredential {
                ip: ip.clone(),
                username: c.username.clone(),
                http_port: c.http_port,
                rtsp_port: c.rtsp_port,
                tls: c.tls,
                rtsp_path: c.rtsp_path.clone(),
                legacy: c.legacy,
                saved_at: c.saved_at.clone(),
            })
            .collect()
    }
}
