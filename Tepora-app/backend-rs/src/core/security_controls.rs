use std::path::PathBuf;
use std::sync::Arc;

use crate::agent::skill_registry::{SkillExportBundle, SkillRegistry};
use chrono::Utc;
use serde_json::{json, Map, Value};

use crate::core::config::{AppPaths, ConfigService};
use crate::core::errors::ApiError;
use crate::workspace::ProjectHistoryStore;

#[allow(unused_imports)]
pub use super::pii_detection::{detect_pii, detect_pii_in_attachments, PiiFinding};
use super::security_audit::{record_audit as write_audit_record, verify_audit_chain};
#[allow(unused_imports)]
pub use super::security_audit::{AuditRecord, AuditVerifyResult};
use super::security_backup::{
    build_backup_config, decrypt_backup, encrypt_backup, BackupPayload, BackupSession,
};
#[allow(unused_imports)]
pub use super::security_backup::{
    BackupEnvelope, BackupExportPayload, BackupExportRequest, BackupImportRequest,
    BackupImportResult, BackupManifest,
};
#[allow(unused_imports)]
pub use super::security_credentials::CredentialStatus;
use super::security_credentials::{
    credential_statuses as build_credential_statuses, rotate_credential as update_credential_config,
};
use super::security_permissions::{
    decision_label, expiry_options_seconds as permission_expiry_options_seconds,
    list_permissions as collect_permission_entries, permission_for as find_permission_entry,
    persist_permission as store_permission_entry, revoke_permission as remove_permission_entry,
};
#[allow(unused_imports)]
pub use super::security_permissions::{
    ApprovalDecision, PermissionEntry, PermissionRiskLevel, PermissionScopeKind,
    ToolApprovalRequestPayload, ToolApprovalResponsePayload,
};

const DEFAULT_PERMISSION_TTL_SECONDS: u64 = 24 * 60 * 60;
const AUDIT_LOG_FILE_NAME: &str = "security-audit.ndjson";

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
            .map(|config| {
                super::security_permissions::default_permission_ttl_seconds(
                    &config,
                    DEFAULT_PERMISSION_TTL_SECONDS,
                )
            })
            .unwrap_or(DEFAULT_PERMISSION_TTL_SECONDS)
    }

    pub fn expiry_options_seconds(&self) -> Vec<u64> {
        permission_expiry_options_seconds()
    }

    pub fn list_permissions(&self) -> Result<Vec<PermissionEntry>, ApiError> {
        let mut config = self.config.load_config()?;
        let (entries, changed) = collect_permission_entries(&mut config)?;
        if changed {
            self.config.update_config(config, false)?;
        }
        Ok(entries)
    }

    pub fn permission_for(
        &self,
        scope_kind: PermissionScopeKind,
        scope_name: &str,
    ) -> Result<Option<PermissionEntry>, ApiError> {
        let mut config = self.config.load_config()?;
        let (entry, changed) = find_permission_entry(&mut config, scope_kind, scope_name)?;
        if changed {
            self.config.update_config(config, false)?;
        }
        Ok(entry)
    }

    pub fn persist_permission(
        &self,
        scope_kind: PermissionScopeKind,
        scope_name: &str,
        decision: ApprovalDecision,
        ttl_seconds: Option<u64>,
    ) -> Result<Option<PermissionEntry>, ApiError> {
        let mut config = self.config.load_config()?;
        let entry = store_permission_entry(
            &mut config,
            scope_kind,
            scope_name,
            decision,
            ttl_seconds,
            self.default_permission_ttl_seconds(),
        )?;
        let Some(entry) = entry else {
            return Ok(None);
        };
        self.config.update_config(config, false)?;
        self.record_audit(
            "permission_saved",
            decision_label(decision),
            json!({
                "scope_kind": scope_kind.as_str(),
                "scope_name": scope_name,
                "ttl_seconds": ttl_seconds,
                "expires_at": entry.expires_at.clone(),
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
        let removed = remove_permission_entry(&mut config, scope_kind, scope_name);
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
        write_audit_record(
            &self.audit_log_path(),
            &Utc::now().to_rfc3339(),
            event_type,
            outcome,
            payload,
        )
    }

    pub fn verify_audit_chain(&self) -> Result<AuditVerifyResult, ApiError> {
        verify_audit_chain(&self.audit_log_path())
    }

    pub fn credential_statuses(&self) -> Result<Vec<CredentialStatus>, ApiError> {
        let config = self.config.load_config()?;
        Ok(build_credential_statuses(&config))
    }
    pub fn rotate_credential(
        &self,
        provider: &str,
        secret: &str,
        expires_at: Option<&str>,
    ) -> Result<(), ApiError> {
        let mut config = self.config.load_config()?;
        update_credential_config(
            &mut config,
            provider,
            secret,
            expires_at,
            &Utc::now().to_rfc3339(),
        )?;
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
        history: &ProjectHistoryStore,
        skill_registry: &SkillRegistry,
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
            agent_skills: if request.include_executors {
                skill_registry.export_bundle().skills
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
        history: &ProjectHistoryStore,
        skill_registry: &SkillRegistry,
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
                skill_registry.import_bundle(&SkillExportBundle {
                    roots: skill_registry
                        .list_roots()
                        .into_iter()
                        .map(|root| crate::agent::skill_registry::SkillRootConfig {
                            path: root.path,
                            enabled: root.enabled,
                            label: root.label,
                        })
                        .collect(),
                    skills: payload.agent_skills.clone(),
                })?;
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

fn ensure_object<'a>(root: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let value = root
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("object ensured")
}
