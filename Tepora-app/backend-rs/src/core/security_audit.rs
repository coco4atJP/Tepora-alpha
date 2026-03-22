use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::core::errors::ApiError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditRecord {
    pub event_id: String,
    pub timestamp: String,
    pub event_type: String,
    pub outcome: String,
    pub payload: Value,
    pub prev_hash: String,
    pub entry_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditVerifyResult {
    pub valid: bool,
    pub entries: usize,
    #[serde(default)]
    pub failure_at: Option<usize>,
    #[serde(default)]
    pub message: Option<String>,
}

pub fn record_audit(
    path: &Path,
    timestamp: &str,
    event_type: &str,
    outcome: &str,
    payload: Value,
) -> Result<(), ApiError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(ApiError::internal)?;
    }
    let prev_hash = read_last_audit_hash(path)?;
    let canonical_payload = serde_json::to_string(&payload).map_err(ApiError::internal)?;
    let entry_hash = digest_hex(
        format!("{prev_hash}|{timestamp}|{event_type}|{outcome}|{canonical_payload}").as_bytes(),
    );
    let record = AuditRecord {
        event_id: uuid::Uuid::new_v4().to_string(),
        timestamp: timestamp.to_string(),
        event_type: event_type.to_string(),
        outcome: outcome.to_string(),
        payload,
        prev_hash,
        entry_hash,
    };
    let serialized = serde_json::to_string(&record).map_err(ApiError::internal)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(ApiError::internal)?;
    writeln!(file, "{serialized}").map_err(ApiError::internal)?;
    Ok(())
}

pub fn verify_audit_chain(path: &Path) -> Result<AuditVerifyResult, ApiError> {
    if !path.exists() {
        return Ok(AuditVerifyResult {
            valid: true,
            entries: 0,
            failure_at: None,
            message: Some("Audit log does not exist yet".to_string()),
        });
    }

    let file = fs::File::open(path).map_err(ApiError::internal)?;
    let reader = BufReader::new(file);
    let mut prev_hash = String::new();
    let mut entries = 0usize;
    for (index, line) in reader.lines().enumerate() {
        let line = line.map_err(ApiError::internal)?;
        if line.trim().is_empty() {
            continue;
        }
        entries += 1;
        let record: AuditRecord = serde_json::from_str(&line).map_err(ApiError::internal)?;
        let payload = serde_json::to_string(&record.payload).map_err(ApiError::internal)?;
        let expected = digest_hex(
            format!(
                "{}|{}|{}|{}|{}",
                record.prev_hash, record.timestamp, record.event_type, record.outcome, payload
            )
            .as_bytes(),
        );
        if record.prev_hash != prev_hash || record.entry_hash != expected {
            return Ok(AuditVerifyResult {
                valid: false,
                entries,
                failure_at: Some(index + 1),
                message: Some("Audit chain verification failed".to_string()),
            });
        }
        prev_hash = record.entry_hash;
    }

    Ok(AuditVerifyResult {
        valid: true,
        entries,
        failure_at: None,
        message: None,
    })
}

fn read_last_audit_hash(path: &Path) -> Result<String, ApiError> {
    if !path.exists() {
        return Ok(String::new());
    }
    let file = fs::File::open(path).map_err(ApiError::internal)?;
    let reader = BufReader::new(file);
    let mut last = String::new();
    for line in reader.lines() {
        let line = line.map_err(ApiError::internal)?;
        if line.trim().is_empty() {
            continue;
        }
        let record: AuditRecord = serde_json::from_str(&line).map_err(ApiError::internal)?;
        last = record.entry_hash;
    }
    Ok(last)
}

fn digest_hex(input: &[u8]) -> String {
    hex::encode(Sha256::digest(input))
}
