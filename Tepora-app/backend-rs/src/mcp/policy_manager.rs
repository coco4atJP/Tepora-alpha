use std::collections::HashMap;
use std::fs;

use chrono::Utc;
use reqwest::Url;
use serde_json::Value;

use crate::core::errors::ApiError;

use super::config_store::McpConfigStore;
use super::types::{McpPolicy, McpServerConfig, McpServerPermission};

#[derive(Clone)]
pub(crate) struct McpPolicyManager {
    config_store: McpConfigStore,
}

impl McpPolicyManager {
    pub(crate) fn new(config_store: McpConfigStore) -> Self {
        Self { config_store }
    }

    pub(crate) fn load_policy(&self) -> Result<McpPolicy, ApiError> {
        let path = self.config_store.policy_path();
        if !path.exists() {
            self.save_policy(&McpPolicy::default())?;
        }
        let contents = fs::read_to_string(&path).unwrap_or_default();
        if contents.trim().is_empty() {
            return Ok(McpPolicy::default());
        }
        let policy = serde_json::from_str::<McpPolicy>(&contents).unwrap_or_default();
        Ok(policy)
    }

    pub(crate) fn save_policy(&self, policy: &McpPolicy) -> Result<(), ApiError> {
        let path = self.config_store.policy_path();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let serialized = serde_json::to_string_pretty(policy).map_err(ApiError::internal)?;
        fs::write(path, serialized).map_err(ApiError::internal)?;
        Ok(())
    }

    pub(crate) fn update_policy(&self, payload: &Value) -> Result<McpPolicy, ApiError> {
        let mut policy = self.load_policy().unwrap_or_default();
        if let Some(value) = payload.get("policy").and_then(|v| v.as_str()) {
            policy.policy = value.to_string();
        }
        if let Some(value) = payload
            .get("server_permissions")
            .and_then(|v| v.as_object())
        {
            let mut permissions = HashMap::new();
            for (name, entry) in value {
                if let Some(entry_obj) = entry.as_object() {
                    let allowed = entry_obj
                        .get("allowed")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let transport_types = entry_obj
                        .get("transport_types")
                        .or_else(|| entry_obj.get("transportTypes"))
                        .and_then(|v| v.as_array())
                        .map(|list| {
                            list.iter()
                                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                                .collect::<Vec<String>>()
                        })
                        .unwrap_or_default();
                    let approved_at = entry_obj
                        .get("approved_at")
                        .or_else(|| entry_obj.get("approvedAt"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let approved_by = entry_obj
                        .get("approved_by")
                        .or_else(|| entry_obj.get("approvedBy"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    permissions.insert(
                        name.to_string(),
                        McpServerPermission {
                            allowed,
                            transport_types,
                            approved_at,
                            approved_by,
                        },
                    );
                }
            }
            policy.server_permissions = permissions;
        }
        if let Some(value) = payload.get("blocked_commands").and_then(|v| v.as_array()) {
            let mut blocked = Vec::new();
            for entry in value {
                if let Some(item) = entry.as_str() {
                    blocked.push(item.to_string());
                }
            }
            policy.blocked_commands = blocked;
        }
        if let Some(value) = payload
            .get("require_tool_confirmation")
            .and_then(|v| v.as_bool())
        {
            policy.require_tool_confirmation = value;
        }
        if let Some(value) = payload
            .get("first_use_confirmation")
            .and_then(|v| v.as_bool())
        {
            policy.first_use_confirmation = value;
        }
        self.save_policy(&policy)?;
        Ok(policy)
    }

    pub(crate) fn approve_server(
        &self,
        server_name: &str,
        transport_types: Option<Vec<String>>,
    ) -> Result<McpPolicy, ApiError> {
        let mut policy = self.load_policy().unwrap_or_default();
        policy.server_permissions.insert(
            server_name.to_string(),
            McpServerPermission {
                allowed: true,
                transport_types: transport_types.unwrap_or_else(|| vec!["stdio".to_string()]),
                approved_at: Some(Utc::now().to_rfc3339()),
                approved_by: Some("user".to_string()),
            },
        );
        self.save_policy(&policy)?;
        Ok(policy)
    }

    pub(crate) fn revoke_server(&self, server_name: &str) -> Result<(McpPolicy, bool), ApiError> {
        let mut policy = self.load_policy().unwrap_or_default();
        let removed = policy.server_permissions.remove(server_name).is_some();
        self.save_policy(&policy)?;
        Ok((policy, removed))
    }

    pub(crate) fn policy_allows_connection(
        &self,
        name: &str,
        server: &McpServerConfig,
    ) -> Result<(), String> {
        let policy = self.load_policy().map_err(|err| err.to_string())?;
        let transport = server.transport.to_lowercase();

        // コマンドインジェクション検査
        if contains_injection_risk(&server.command) {
            return Err(format!(
                "Command '{}' contains potentially dangerous characters",
                server.command
            ));
        }
        for arg in &server.args {
            if contains_injection_risk(arg) {
                return Err(format!(
                    "Argument '{}' contains potentially dangerous characters",
                    arg
                ));
            }
        }

        let mut command_text = server.command.clone();
        if !server.args.is_empty() {
            command_text.push(' ');
            command_text.push_str(&server.args.join(" "));
        }

        for blocked in &policy.blocked_commands {
            if !blocked.trim().is_empty()
                && command_text
                    .to_lowercase()
                    .contains(&blocked.to_lowercase())
            {
                return Err(format!("Blocked command pattern detected: {}", blocked));
            }
        }

        let is_local = match transport.as_str() {
            "stdio" | "" => true,
            _ => server
                .url
                .as_ref()
                .and_then(|raw| Url::parse(raw).ok())
                .and_then(|url| url.host_str().map(|host| host.to_string()))
                .map(|host| {
                    let host_lower = host.to_lowercase();
                    host_lower == "localhost" || host_lower == "127.0.0.1" || host_lower == "::1"
                })
                .unwrap_or(false),
        };

        match policy.policy.to_lowercase().as_str() {
            "allow_all" => {
                tracing::warn!(
                    "MCP policy 'allow_all' permits any connection — server: '{}'",
                    name
                );
                Ok(())
            }
            "stdio_only" => {
                if transport != "stdio" && !transport.is_empty() {
                    Err("Policy 'stdio_only' only allows stdio transport".to_string())
                } else {
                    Ok(())
                }
            }
            "local_only" => {
                if !is_local {
                    Err("Policy 'local_only' only allows local servers".to_string())
                } else {
                    Ok(())
                }
            }
            "allowlist" => {
                if let Some(perm) = policy.server_permissions.get(name) {
                    if !perm.allowed {
                        return Err(format!("Server '{}' not in allowlist", name));
                    }
                    if !perm.transport_types.is_empty()
                        && !perm
                            .transport_types
                            .iter()
                            .any(|t| t.eq_ignore_ascii_case(&transport))
                    {
                        return Err(format!(
                            "Transport '{}' not allowed for '{}'",
                            transport, name
                        ));
                    }
                    Ok(())
                } else {
                    Err(format!("Server '{}' not in allowlist", name))
                }
            }
            other => Err(format!("Unknown MCP policy '{}'", other)),
        }
    }
}

/// シェルメタ文字やコマンドチェーン演算子を検出する。
const DANGEROUS_COMMAND_CHARS: &[char] = &[';', '|', '`', '$', '(', ')'];

fn contains_injection_risk(text: &str) -> bool {
    text.contains("&&") || text.chars().any(|c| DANGEROUS_COMMAND_CHARS.contains(&c))
}
