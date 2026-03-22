use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::core::errors::ApiError;

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

pub fn default_permission_ttl_seconds(config: &Value, default_ttl_seconds: u64) -> u64 {
    config
        .get("permissions")
        .and_then(|value| value.get("default_ttl_seconds"))
        .and_then(|value| value.as_u64())
        .unwrap_or(default_ttl_seconds)
}

pub fn expiry_options_seconds() -> Vec<u64> {
    vec![15 * 60, 60 * 60, 24 * 60 * 60, 7 * 24 * 60 * 60]
}

pub fn list_permissions(config: &mut Value) -> Result<(Vec<PermissionEntry>, bool), ApiError> {
    let mut entries = Vec::new();
    let mut changed = false;
    for scope_kind in [
        PermissionScopeKind::NativeTool,
        PermissionScopeKind::McpServer,
    ] {
        changed |= collect_permissions(config, scope_kind, &mut entries)?;
    }
    entries.sort_by(|left, right| {
        left.scope_kind
            .as_str()
            .cmp(right.scope_kind.as_str())
            .then_with(|| left.scope_name.cmp(&right.scope_name))
    });
    Ok((entries, changed))
}

pub fn permission_for(
    config: &mut Value,
    scope_kind: PermissionScopeKind,
    scope_name: &str,
) -> Result<(Option<PermissionEntry>, bool), ApiError> {
    let mut entries = Vec::new();
    let changed = collect_permissions(config, scope_kind, &mut entries)?;
    Ok((
        entries
            .into_iter()
            .find(|entry| entry.scope_name == scope_name),
        changed,
    ))
}

pub fn persist_permission(
    config: &mut Value,
    scope_kind: PermissionScopeKind,
    scope_name: &str,
    decision: ApprovalDecision,
    ttl_seconds: Option<u64>,
    default_ttl_seconds: u64,
) -> Result<Option<PermissionEntry>, ApiError> {
    if matches!(decision, ApprovalDecision::Once) {
        return Ok(None);
    }

    let now = Utc::now();
    let ttl = ttl_seconds.unwrap_or(default_ttl_seconds);
    let expires_at = matches!(decision, ApprovalDecision::AlwaysUntilExpiry)
        .then(|| (now + Duration::seconds(ttl as i64)).to_rfc3339());
    let entry = PermissionEntry {
        scope_kind,
        scope_name: scope_name.to_string(),
        decision,
        expires_at,
        created_at: Some(now.to_rfc3339()),
        updated_at: Some(now.to_rfc3339()),
    };

    let root = config
        .as_object_mut()
        .ok_or_else(|| ApiError::BadRequest("Invalid config root".to_string()))?;
    let permissions = ensure_object(root, "permissions");
    let section = ensure_object(permissions, scope_kind.config_key());
    section.insert(
        scope_name.to_string(),
        serde_json::to_value(&entry).map_err(ApiError::internal)?,
    );
    Ok(Some(entry))
}

pub fn revoke_permission(
    config: &mut Value,
    scope_kind: PermissionScopeKind,
    scope_name: &str,
) -> bool {
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
    removed
}

pub fn decision_label(decision: ApprovalDecision) -> &'static str {
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
