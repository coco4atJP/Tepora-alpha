use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use chrono::{Duration, Utc};
use rand::RngCore;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::agent::exclusive_manager::{ExclusiveAgentManager, ExecutionAgent};

use crate::core::config::{AppPaths, ConfigService};
use crate::core::errors::ApiError;
use crate::history::{HistoryMessage, HistoryStore, SessionInfo};

const DEFAULT_PERMISSION_TTL_SECONDS: u64 = 24 * 60 * 60;
const EXPIRING_SOON_DAYS: i64 = 7;
const AUDIT_LOG_FILE_NAME: &str = "security-audit.ndjson";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Deny,
    Once,
    AlwaysUntilExpiry,
}

impl ApprovalDecision {
    pub fn is_allowed(self) -> bool {
        matches!(self, Self::Once | Self::AlwaysUntilExpiry)
    }
}

impl Default for ApprovalDecision {
    fn default() -> Self {
        Self::Once
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionScopeKind {
    NativeTool,
    McpServer,
}

impl PermissionScopeKind {
    pub fn config_key(self) -> &'static str {
        match self {
            Self::NativeTool => "native_tools",
            Self::McpServer => "mcp_servers",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::NativeTool => "native_tool",
            Self::McpServer => "mcp_server",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionRiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

impl Default for PermissionRiskLevel {
    fn default() -> Self {
        Self::Medium
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionEntry {
    pub scope_kind: PermissionScopeKind,
    pub scope_name: String,
    pub decision: ApprovalDecision,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

impl PermissionEntry {
    pub fn is_expired(&self) -> bool {
        let Some(expires_at) = self.expires_at.as_deref() else {
            return false;
        };
        chrono::DateTime::parse_from_rfc3339(expires_at)
            .map(|value| value.with_timezone(&Utc) <= Utc::now())
            .unwrap_or(false)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolApprovalRequestPayload {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "toolName")]
    pub tool_name: String,
    #[serde(rename = "toolArgs")]
    pub tool_args: Value,
    #[serde(default)]
    pub description: Option<String>,
    pub scope: PermissionScopeKind,
    #[serde(rename = "scopeName")]
    pub scope_name: String,
    #[serde(rename = "riskLevel")]
    pub risk_level: PermissionRiskLevel,
    #[serde(rename = "expiryOptions")]
    pub expiry_options: Vec<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ToolApprovalResponsePayload {
    #[serde(default)]
    pub decision: ApprovalDecision,
    #[serde(rename = "ttlSeconds", default)]
    pub ttl_seconds: Option<u64>,
    #[serde(default)]
    pub approved: Option<bool>,
}

impl ToolApprovalResponsePayload {
    pub fn approved_once() -> Self {
        Self {
            decision: ApprovalDecision::Once,
            ttl_seconds: None,
            approved: Some(true),
        }
    }

    pub fn denied() -> Self {
        Self {
            decision: ApprovalDecision::Deny,
            ttl_seconds: None,
            approved: Some(false),
        }
    }

    pub fn final_decision(&self) -> ApprovalDecision {
        match self.approved {
            Some(true) => ApprovalDecision::Once,
            Some(false) => ApprovalDecision::Deny,
            None => self.decision,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialStatus {
    pub provider: String,
    pub status: String,
    pub present: bool,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub last_rotated_at: Option<String>,
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiiFinding {
    pub category: String,
    pub preview: String,
}

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
    pub execution_agents: Vec<ExecutionAgent>,
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

fn default_true() -> bool {
    true
}

#[derive(Clone)]
pub struct SecurityControls {
    paths: Arc<AppPaths>,
    config: ConfigService,
}

impl SecurityControls {
    pub fn new(paths: Arc<AppPaths>, config: ConfigService) -> Self {
        Self { paths, config }
    }

    pub fn audit_log_path(&self) -> PathBuf {
        self.paths.log_dir.join(AUDIT_LOG_FILE_NAME)
    }

    pub fn is_lockdown_enabled(&self) -> bool {
        self.config
            .load_config()
            .ok()
            .and_then(|config| {
                config
                    .get("privacy")
                    .and_then(|value| value.get("lockdown"))
                    .and_then(|value| value.get("enabled"))
                    .and_then(|value| value.as_bool())
            })
            .unwrap_or(false)
    }

    pub fn ensure_lockdown_disabled(&self, capability: &str) -> Result<(), ApiError> {
        if self.is_lockdown_enabled() {
            self.record_audit(
                "lockdown_reject",
                "blocked",
                json!({ "capability": capability }),
            )?;
            return Err(ApiError::Conflict(format!(
                "Privacy Lockdown is enabled; '{}' is currently blocked",
                capability
            )));
        }
        Ok(())
    }

    pub fn update_lockdown(&self, enabled: bool, reason: Option<&str>) -> Result<Value, ApiError> {
        let mut config = self.config.load_config()?;
        let root = config
            .as_object_mut()
            .ok_or_else(|| ApiError::BadRequest("Invalid config root".to_string()))?;
        let privacy = ensure_object(root, "privacy");
        let lockdown = ensure_object(privacy, "lockdown");
        lockdown.insert("enabled".to_string(), Value::Bool(enabled));
        lockdown.insert(
            "updated_at".to_string(),
            Value::String(Utc::now().to_rfc3339()),
        );
        if let Some(reason) = reason {
            lockdown.insert("reason".to_string(), Value::String(reason.to_string()));
        }
        self.config.update_config(config.clone(), false)?;
        self.record_audit(
            "lockdown_changed",
            if enabled { "enabled" } else { "disabled" },
            json!({ "reason": reason }),
        )?;
        Ok(config)
    }

    pub fn default_permission_ttl_seconds(&self) -> u64 {
        self.config
            .load_config()
            .ok()
            .and_then(|config| {
                config
                    .get("permissions")
                    .and_then(|value| value.get("default_ttl_seconds"))
                    .and_then(|value| value.as_u64())
            })
            .unwrap_or(DEFAULT_PERMISSION_TTL_SECONDS)
    }

    pub fn expiry_options_seconds(&self) -> Vec<u64> {
        vec![15 * 60, 60 * 60, 24 * 60 * 60, 7 * 24 * 60 * 60]
    }

    pub fn list_permissions(&self) -> Result<Vec<PermissionEntry>, ApiError> {
        let mut config = self.config.load_config()?;
        let mut entries = Vec::new();
        let mut changed = false;
        for scope_kind in [
            PermissionScopeKind::NativeTool,
            PermissionScopeKind::McpServer,
        ] {
            changed |= collect_permissions(&mut config, scope_kind, &mut entries)?;
        }
        if changed {
            self.config.update_config(config, false)?;
        }
        entries.sort_by(|left, right| {
            left.scope_kind
                .as_str()
                .cmp(right.scope_kind.as_str())
                .then_with(|| left.scope_name.cmp(&right.scope_name))
        });
        Ok(entries)
    }
    pub fn permission_for(
        &self,
        scope_kind: PermissionScopeKind,
        scope_name: &str,
    ) -> Result<Option<PermissionEntry>, ApiError> {
        let mut config = self.config.load_config()?;
        let mut entries = Vec::new();
        let changed = collect_permissions(&mut config, scope_kind, &mut entries)?;
        if changed {
            self.config.update_config(config, false)?;
        }
        Ok(entries
            .into_iter()
            .find(|entry| entry.scope_name == scope_name))
    }

    pub fn persist_permission(
        &self,
        scope_kind: PermissionScopeKind,
        scope_name: &str,
        decision: ApprovalDecision,
        ttl_seconds: Option<u64>,
    ) -> Result<Option<PermissionEntry>, ApiError> {
        if matches!(decision, ApprovalDecision::Once) {
            return Ok(None);
        }

        let now = Utc::now();
        let ttl = ttl_seconds.unwrap_or_else(|| self.default_permission_ttl_seconds());
        let expires_at = matches!(decision, ApprovalDecision::AlwaysUntilExpiry)
            .then(|| (now + Duration::seconds(ttl as i64)).to_rfc3339());
        let entry = PermissionEntry {
            scope_kind,
            scope_name: scope_name.to_string(),
            decision,
            expires_at: expires_at.clone(),
            created_at: Some(now.to_rfc3339()),
            updated_at: Some(now.to_rfc3339()),
        };

        let mut config = self.config.load_config()?;
        let root = config
            .as_object_mut()
            .ok_or_else(|| ApiError::BadRequest("Invalid config root".to_string()))?;
        let permissions = ensure_object(root, "permissions");
        let section = ensure_object(permissions, scope_kind.config_key());
        section.insert(
            scope_name.to_string(),
            serde_json::to_value(&entry).map_err(ApiError::internal)?,
        );
        self.config.update_config(config, false)?;
        self.record_audit(
            "permission_saved",
            decision_label(decision),
            json!({
                "scope_kind": scope_kind.as_str(),
                "scope_name": scope_name,
                "ttl_seconds": ttl_seconds,
                "expires_at": expires_at,
            }),
        )?;
        Ok(Some(entry))
    }

    pub fn revoke_permission(
        &self,
        scope_kind: PermissionScopeKind,
        scope_name: &str,
    ) -> Result<bool, ApiError> {
        let mut config = self.config.load_config()?;
        let mut removed = false;
        if let Some(root) = config.as_object_mut() {
            if let Some(permissions) = root
                .get_mut("permissions")
                .and_then(|value| value.as_object_mut())
            {
                if let Some(section) = permissions
                    .get_mut(scope_kind.config_key())
                    .and_then(|value| value.as_object_mut())
                {
                    removed = section.remove(scope_name).is_some();
                }
            }
        }
        if removed {
            self.config.update_config(config, false)?;
            self.record_audit(
                "permission_revoked",
                "revoked",
                json!({ "scope_kind": scope_kind.as_str(), "scope_name": scope_name }),
            )?;
        }
        Ok(removed)
    }

    pub fn record_audit(
        &self,
        event_type: &str,
        outcome: &str,
        payload: Value,
    ) -> Result<(), ApiError> {
        let path = self.audit_log_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(ApiError::internal)?;
        }
        let prev_hash = read_last_audit_hash(&path)?;
        let timestamp = Utc::now().to_rfc3339();
        let canonical_payload = serde_json::to_string(&payload).map_err(ApiError::internal)?;
        let entry_hash = digest_hex(
            format!("{prev_hash}|{timestamp}|{event_type}|{outcome}|{canonical_payload}")
                .as_bytes(),
        );
        let record = AuditRecord {
            event_id: uuid::Uuid::new_v4().to_string(),
            timestamp,
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

    pub fn verify_audit_chain(&self) -> Result<AuditVerifyResult, ApiError> {
        let path = self.audit_log_path();
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

    pub fn credential_statuses(&self) -> Result<Vec<CredentialStatus>, ApiError> {
        let config = self.config.load_config()?;
        let providers = [
            ("google_search", "google_search_api_key"),
            ("brave_search", "brave_search_api_key"),
            ("bing_search", "bing_search_api_key"),
        ];
        let mut statuses = Vec::new();
        for (provider, field) in providers {
            let present = config
                .get("tools")
                .and_then(|value| value.get(field))
                .and_then(|value| value.as_str())
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false);
            let metadata = config
                .get("credentials")
                .and_then(|value| value.get(provider));
            let expires_at = metadata
                .and_then(|value| value.get("expires_at"))
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned);
            let last_rotated_at = metadata
                .and_then(|value| value.get("last_rotated_at"))
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned);
            let status = match (present, expires_at.as_deref()) {
                (false, _) => "missing".to_string(),
                (true, Some(expires_at)) => match chrono::DateTime::parse_from_rfc3339(expires_at)
                    .map(|value| value.with_timezone(&Utc))
                    .ok()
                {
                    Some(expiry) if expiry <= Utc::now() => "expired".to_string(),
                    Some(expiry) if expiry <= Utc::now() + Duration::days(EXPIRING_SOON_DAYS) => {
                        "expiring_soon".to_string()
                    }
                    _ => metadata
                        .and_then(|value| value.get("status"))
                        .and_then(|value| value.as_str())
                        .unwrap_or("active")
                        .to_string(),
                },
                (true, None) => metadata
                    .and_then(|value| value.get("status"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("active")
                    .to_string(),
            };
            statuses.push(CredentialStatus {
                provider: provider.to_string(),
                status,
                present,
                expires_at,
                last_rotated_at,
            });
        }
        Ok(statuses)
    }
    pub fn rotate_credential(
        &self,
        provider: &str,
        secret: &str,
        expires_at: Option<&str>,
    ) -> Result<(), ApiError> {
        let secret_field = match provider {
            "google_search" => "google_search_api_key",
            "brave_search" => "brave_search_api_key",
            "bing_search" => "bing_search_api_key",
            _ => {
                return Err(ApiError::BadRequest(format!(
                    "Unknown credential provider '{}'",
                    provider
                )))
            }
        };
        let mut config = self.config.load_config()?;
        let root = config
            .as_object_mut()
            .ok_or_else(|| ApiError::BadRequest("Invalid config root".to_string()))?;
        let tools = ensure_object(root, "tools");
        tools.insert(secret_field.to_string(), Value::String(secret.to_string()));
        let credentials = ensure_object(root, "credentials");
        let metadata = ensure_object(credentials, provider);
        metadata.insert("status".to_string(), Value::String("active".to_string()));
        metadata.insert(
            "last_rotated_at".to_string(),
            Value::String(Utc::now().to_rfc3339()),
        );
        match expires_at {
            Some(value) if !value.trim().is_empty() => {
                metadata.insert("expires_at".to_string(), Value::String(value.to_string()));
            }
            _ => {
                metadata.remove("expires_at");
            }
        }
        self.config.update_config(config, false)?;
        self.record_audit(
            "credential_rotated",
            "updated",
            json!({ "provider": provider, "expires_at": expires_at }),
        )?;
        Ok(())
    }

    pub async fn export_backup(
        &self,
        request: &BackupExportRequest,
        history: &HistoryStore,
        exclusive_agents: &ExclusiveAgentManager,
    ) -> Result<BackupExportPayload, ApiError> {
        if request.passphrase.trim().is_empty() {
            return Err(ApiError::BadRequest(
                "Backup passphrase is required".to_string(),
            ));
        }
        let config = self.config.load_config()?;
        let manifest = BackupManifest {
            schema_version: config
                .get("schema_version")
                .and_then(|value| value.as_u64())
                .unwrap_or(0),
            exported_at: Utc::now().to_rfc3339(),
            include_chat_history: request.include_chat_history,
            include_settings: request.include_settings,
            include_characters: request.include_characters,
            include_executors: request.include_executors,
        };
        let config_payload = build_backup_config(&config, request);
        let mut sessions = Vec::new();
        if request.include_chat_history {
            for session in history.list_sessions().await? {
                let messages = history.get_history(&session.id, 0).await?;
                sessions.push(BackupSession { session, messages });
            }
        }
        let payload = BackupPayload {
            manifest: manifest.clone(),
            config: config_payload,
            execution_agents: if request.include_executors {
                exclusive_agents.list_all()
            } else {
                Vec::new()
            },
            sessions,
        };
        let serialized = serde_json::to_vec(&payload).map_err(ApiError::internal)?;
        let archive = encrypt_backup(&request.passphrase, &serialized)?;
        self.record_audit(
            "backup_export",
            "success",
            json!({
                "include_chat_history": request.include_chat_history,
                "include_settings": request.include_settings,
                "include_characters": request.include_characters,
                "include_executors": request.include_executors,
            }),
        )?;
        Ok(BackupExportPayload {
            filename: format!("tepora-backup-{}.json", Utc::now().format("%Y%m%d-%H%M%S")),
            archive,
            manifest,
        })
    }

    pub async fn import_backup(
        &self,
        request: &BackupImportRequest,
        history: &HistoryStore,
        exclusive_agents: &ExclusiveAgentManager,
    ) -> Result<BackupImportResult, ApiError> {
        let stage = request.stage.trim().to_lowercase();
        if !["verify", "dry_run", "apply"].contains(&stage.as_str()) {
            return Err(ApiError::BadRequest(
                "backup import stage must be one of verify, dry_run, apply".to_string(),
            ));
        }

        let config = self.config.load_config()?;
        let restore_enabled = config
            .get("backup")
            .and_then(|value| value.get("enable_restore"))
            .and_then(|value| value.as_bool())
            .unwrap_or(true);
        if stage == "apply" && !restore_enabled {
            return Err(ApiError::Conflict(
                "Backup restore is disabled in settings".to_string(),
            ));
        }

        let decrypted = decrypt_backup(&request.passphrase, &request.archive)?;
        let payload: BackupPayload =
            serde_json::from_slice(&decrypted).map_err(ApiError::internal)?;
        if payload.manifest.schema_version > 2 {
            return Err(ApiError::Conflict(format!(
                "Backup schema_version={} is newer than this app supports",
                payload.manifest.schema_version
            )));
        }

        if stage == "apply" {
            if let Some(config_value) = payload.config.clone() {
                self.config.update_config(config_value, false)?;
            }
            if payload.manifest.include_executors {
                exclusive_agents.replace_all(payload.execution_agents.clone())?;
            }
            for session in &payload.sessions {
                let _ = history.delete_session(&session.session.id).await;
                for message in &session.messages {
                    history
                        .add_message(
                            &session.session.id,
                            &message.message_type,
                            &message.content,
                            message.additional_kwargs.clone(),
                        )
                        .await?;
                }
                if let Some(title) = session.session.title.as_deref() {
                    let _ = history
                        .update_session_title(&session.session.id, title)
                        .await;
                }
            }
        }

        self.record_audit(
            "backup_import",
            stage.as_str(),
            json!({
                "sessions": payload.sessions.len(),
                "schema_version": payload.manifest.schema_version,
            }),
        )?;
        Ok(BackupImportResult {
            stage,
            manifest: payload.manifest,
            sessions: payload.sessions.len(),
            applied: request.stage.eq_ignore_ascii_case("apply"),
        })
    }
}

pub fn detect_pii(text: &str) -> Vec<PiiFinding> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let mut findings = Vec::new();
    collect_regex_findings(email_regex(), text, "email", &mut findings);
    collect_phone_findings(text, &mut findings);
    collect_regex_findings(api_key_regex(), text, "api_key", &mut findings);
    collect_regex_findings(token_regex(), text, "token", &mut findings);
    collect_card_findings(text, &mut findings);
    dedupe_findings(findings)
}

pub fn detect_pii_in_attachments(attachments: &[Value]) -> Vec<PiiFinding> {
    let mut findings = Vec::new();
    for attachment in attachments {
        let Some(object) = attachment.as_object() else {
            continue;
        };
        if object
            .get("piiConfirmed")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            continue;
        }
        if let Some(url) = object.get("url").and_then(|value| value.as_str()) {
            findings.extend(detect_pii(url));
        }
        let attachment_type = object
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let is_text = attachment_type.eq_ignore_ascii_case("text")
            || attachment_type.starts_with("text/")
            || attachment_type == "application/json"
            || attachment_type == "application/xml"
            || attachment_type == "application/yaml"
            || attachment_type == "application/toml";
        if !is_text {
            continue;
        }
        if let Some(content) = object.get("content").and_then(|value| value.as_str()) {
            if !content.starts_with("data:") {
                findings.extend(detect_pii(content));
            }
        }
    }
    dedupe_findings(findings)
}
fn decision_label(decision: ApprovalDecision) -> &'static str {
    match decision {
        ApprovalDecision::Deny => "deny",
        ApprovalDecision::Once => "once",
        ApprovalDecision::AlwaysUntilExpiry => "always_until_expiry",
    }
}

fn ensure_object<'a>(root: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let value = root
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("object ensured")
}

fn collect_permissions(
    config: &mut Value,
    scope_kind: PermissionScopeKind,
    target: &mut Vec<PermissionEntry>,
) -> Result<bool, ApiError> {
    let Some(root) = config.as_object_mut() else {
        return Ok(false);
    };
    let Some(permissions) = root
        .get_mut("permissions")
        .and_then(|value| value.as_object_mut())
    else {
        return Ok(false);
    };
    let Some(section) = permissions
        .get_mut(scope_kind.config_key())
        .and_then(|value| value.as_object_mut())
    else {
        return Ok(false);
    };

    let mut expired = Vec::new();
    for (scope_name, entry_value) in section.iter() {
        let Some(entry_object) = entry_value.as_object() else {
            continue;
        };
        let entry = PermissionEntry {
            scope_kind,
            scope_name: scope_name.to_string(),
            decision: parse_decision(entry_object.get("decision")),
            expires_at: entry_object
                .get("expires_at")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned),
            created_at: entry_object
                .get("created_at")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned),
            updated_at: entry_object
                .get("updated_at")
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned),
        };
        if entry.is_expired() {
            expired.push(scope_name.to_string());
            continue;
        }
        target.push(entry);
    }

    let had_expired = !expired.is_empty();
    for scope_name in expired {
        section.remove(&scope_name);
    }
    Ok(had_expired)
}

fn parse_decision(value: Option<&Value>) -> ApprovalDecision {
    match value.and_then(|value| value.as_str()) {
        Some("deny") => ApprovalDecision::Deny,
        Some("always_until_expiry") => ApprovalDecision::AlwaysUntilExpiry,
        _ => ApprovalDecision::Once,
    }
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

fn build_backup_config(config: &Value, request: &BackupExportRequest) -> Option<Value> {
    if request.include_settings {
        return Some(config.clone());
    }
    let Some(root) = config.as_object() else {
        return None;
    };
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

fn encrypt_backup(passphrase: &str, plaintext: &[u8]) -> Result<BackupEnvelope, ApiError> {
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

fn decrypt_backup(passphrase: &str, archive: &BackupEnvelope) -> Result<Vec<u8>, ApiError> {
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

fn collect_regex_findings(
    regex: &Regex,
    text: &str,
    category: &str,
    findings: &mut Vec<PiiFinding>,
) {
    for found in regex.find_iter(text) {
        findings.push(PiiFinding {
            category: category.to_string(),
            preview: preview(found.as_str()),
        });
    }
}

fn collect_phone_findings(text: &str, findings: &mut Vec<PiiFinding>) {
    for found in phone_regex().find_iter(text) {
        let digits = found
            .as_str()
            .chars()
            .filter(|value| value.is_ascii_digit())
            .count();
        if digits >= 10 {
            findings.push(PiiFinding {
                category: "phone".to_string(),
                preview: preview(found.as_str()),
            });
        }
    }
}

fn collect_card_findings(text: &str, findings: &mut Vec<PiiFinding>) {
    for found in card_regex().find_iter(text) {
        let digits = found
            .as_str()
            .chars()
            .filter(|value| value.is_ascii_digit())
            .collect::<String>();
        if (13..=19).contains(&digits.len()) && luhn_valid(&digits) {
            findings.push(PiiFinding {
                category: "card".to_string(),
                preview: preview(found.as_str()),
            });
        }
    }
}

fn dedupe_findings(findings: Vec<PiiFinding>) -> Vec<PiiFinding> {
    let mut seen = HashSet::new();
    findings
        .into_iter()
        .filter(|finding| seen.insert((finding.category.clone(), finding.preview.clone())))
        .collect()
}

fn preview(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.chars().count() <= 12 {
        return trimmed.to_string();
    }
    let prefix: String = trimmed.chars().take(4).collect();
    let suffix: String = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{prefix}...{suffix}")
}

fn email_regex() -> &'static Regex {
    static EMAIL: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    EMAIL.get_or_init(|| {
        Regex::new(r"(?i)\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b").expect("valid email regex")
    })
}

fn phone_regex() -> &'static Regex {
    static PHONE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    PHONE.get_or_init(|| Regex::new(r"(?x)(?:\+?\d[\d\-\s().]{7,}\d)").expect("valid phone regex"))
}

fn api_key_regex() -> &'static Regex {
    static API_KEY: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    API_KEY.get_or_init(|| {
        Regex::new(r"(?i)\b(?:sk-[a-z0-9]{20,}|ghp_[a-z0-9]{20,}|AIza[0-9A-Za-z\-_]{20,}|AKIA[0-9A-Z]{16})\b")
            .expect("valid api key regex")
    })
}

fn token_regex() -> &'static Regex {
    static TOKEN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    TOKEN.get_or_init(|| {
        Regex::new(r"(?i)\b(?:token|bearer|jwt)[=: ]+[a-z0-9._\-]{16,}\b")
            .expect("valid token regex")
    })
}

fn card_regex() -> &'static Regex {
    static CARD: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    CARD.get_or_init(|| Regex::new(r"\b(?:\d[ -]*?){13,19}\b").expect("valid card regex"))
}

fn luhn_valid(digits: &str) -> bool {
    let mut sum = 0;
    let mut alternate = false;
    for ch in digits.chars().rev() {
        let Some(mut value) = ch.to_digit(10) else {
            return false;
        };
        if alternate {
            value *= 2;
            if value > 9 {
                value -= 9;
            }
        }
        sum += value;
        alternate = !alternate;
    }
    sum % 10 == 0
}
