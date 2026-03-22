use crate::agent::skill_registry::AgentSkillPackage;
use crate::core::errors::ApiError;
use crate::history::{HistoryMessage, SessionInfo};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupExportRequest {
    pub passphrase: String,
    #[serde(default = "default_true")]
    pub include_chat_history: bool,
    #[serde(default = "default_true")]
    pub include_settings: bool,
    #[serde(default = "default_true")]
    pub include_characters: bool,
    #[serde(default = "default_true")]
    pub include_executors: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupEnvelope {
    pub version: u32,
    pub algorithm: String,
    pub nonce_hex: String,
    pub ciphertext_hex: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    pub schema_version: u64,
    pub exported_at: String,
    pub include_chat_history: bool,
    pub include_settings: bool,
    pub include_characters: bool,
    pub include_executors: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSession {
    pub session: SessionInfo,
    pub messages: Vec<HistoryMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupPayload {
    pub manifest: BackupManifest,
    #[serde(default)]
    pub config: Option<Value>,
    #[serde(default)]
    pub agent_skills: Vec<AgentSkillPackage>,
    #[serde(default)]
    pub sessions: Vec<BackupSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupExportPayload {
    pub filename: String,
    pub archive: BackupEnvelope,
    pub manifest: BackupManifest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupImportRequest {
    pub passphrase: String,
    pub archive: BackupEnvelope,
    pub stage: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupImportResult {
    pub stage: String,
    pub manifest: BackupManifest,
    pub sessions: usize,
    pub applied: bool,
}

pub fn build_backup_config(config: &Value, request: &BackupExportRequest) -> Option<Value> {
    if request.include_settings {
        return Some(config.clone());
    }
    let root = config.as_object()?;
    let mut partial = Map::new();
    if request.include_characters {
        if let Some(value) = root.get("characters") {
            partial.insert("characters".to_string(), value.clone());
        }
    }

    if partial.is_empty() {
        None
    } else {
        Some(Value::Object(partial))
    }
}

pub fn encrypt_backup(passphrase: &str, plaintext: &[u8]) -> Result<BackupEnvelope, ApiError> {
    let key = Sha256::digest(passphrase.as_bytes());
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(ApiError::internal)?;
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
        .map_err(|_| ApiError::Internal("Failed to encrypt backup".to_string()))?;
    Ok(BackupEnvelope {
        version: 1,
        algorithm: "aes-256-gcm".to_string(),
        nonce_hex: hex::encode(nonce_bytes),
        ciphertext_hex: hex::encode(ciphertext),
    })
}

pub fn decrypt_backup(passphrase: &str, archive: &BackupEnvelope) -> Result<Vec<u8>, ApiError> {
    if archive.version != 1 {
        return Err(ApiError::BadRequest(
            "Unsupported backup archive version".to_string(),
        ));
    }
    let key = Sha256::digest(passphrase.as_bytes());
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(ApiError::internal)?;
    let nonce_bytes = hex::decode(&archive.nonce_hex).map_err(ApiError::internal)?;
    if nonce_bytes.len() != 12 {
        return Err(ApiError::BadRequest("Invalid backup nonce".to_string()));
    }
    let ciphertext = hex::decode(&archive.ciphertext_hex).map_err(ApiError::internal)?;
    cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
        .map_err(|_| ApiError::BadRequest("Backup decryption failed".to_string()))
}

fn default_true() -> bool {
    true
}
