use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use chrono::Utc;
use rmcp::transport::{ConfigureCommandExt, StreamableHttpClientTransport, TokioChildProcess};
use rmcp::ServiceExt;
use serde_json::{json, Map, Value};
use tokio::process::Command;

use crate::core::config::{AppPaths, ConfigService};
use crate::core::errors::ApiError;
use crate::core::security_controls::SecurityControls;
#[cfg(feature = "redesign_sandbox")]
use crate::sandbox::build_wasm_launch_spec;

use super::policy_manager::McpPolicyManager;
use super::state::{McpClientEntry, McpRuntimeState};
use super::types::{McpServerConfig, McpServerStatus, McpToolsConfig};

#[derive(Clone)]
pub(crate) struct McpConnectionManager {
    paths: Arc<AppPaths>,
    config_service: ConfigService,
    policy_manager: McpPolicyManager,
    runtime: McpRuntimeState,
}

impl McpConnectionManager {
    pub(crate) fn new(
        paths: Arc<AppPaths>,
        config_service: ConfigService,
        policy_manager: McpPolicyManager,
        runtime: McpRuntimeState,
    ) -> Self {
        Self {
            paths,
            config_service,
            policy_manager,
            runtime,
        }
    }

    pub(crate) async fn connect_all(&self, tools_config: &McpToolsConfig) -> Result<(), ApiError> {
        let mut new_clients = HashMap::new();
        let mut new_status = HashMap::new();

        for (name, server) in tools_config.mcp_servers.iter() {
            if !server.enabled {
                new_status.insert(
                    name.clone(),
                    McpServerStatus {
                        status: "disconnected".to_string(),
                        tools_count: 0,
                        error_message: None,
                        last_connected: None,
                    },
                );
                continue;
            }

            new_status.insert(
                name.clone(),
                McpServerStatus {
                    status: "connecting".to_string(),
                    tools_count: 0,
                    error_message: None,
                    last_connected: None,
                },
            );

            match self.connect_server(name, server).await {
                Ok(entry) => {
                    let tool_count = entry.tools.len();
                    new_status.insert(
                        name.clone(),
                        McpServerStatus {
                            status: "connected".to_string(),
                            tools_count: tool_count,
                            error_message: None,
                            last_connected: Some(Utc::now().to_rfc3339()),
                        },
                    );
                    new_clients.insert(name.clone(), entry);
                }
                Err(err) => {
                    new_status.insert(
                        name.clone(),
                        McpServerStatus {
                            status: "error".to_string(),
                            tools_count: 0,
                            error_message: Some(err),
                            last_connected: None,
                        },
                    );
                }
            }
        }

        *self.runtime.clients.write().await = new_clients;
        *self.runtime.status.write().await = new_status;
        Ok(())
    }

    async fn connect_server(
        &self,
        name: &str,
        server: &McpServerConfig,
    ) -> Result<McpClientEntry, String> {
        self.policy_manager.policy_allows_connection(name, server)?;

        let transport_name = server.transport.to_lowercase();
        let sandbox_mcp_enabled = self.is_redesign_feature_enabled("sandbox_mcp")
            || self.is_redesign_feature_enabled("sandbox");
        tracing::info!(
            target: "mcp",
            server = %name,
            transport = %transport_name,
            sandbox_mcp_enabled,
            "Connecting MCP server"
        );
        let service = if transport_name == "stdio" || transport_name.is_empty() {
            let cmd = self.build_stdio_command(name, server, sandbox_mcp_enabled)?;
            let transport = TokioChildProcess::new(cmd.configure(|cmd| {
                let _ = cmd;
            }))
            .map_err(|err| format!("Failed to spawn MCP server '{}': {}", name, err))?;
            ().serve(transport)
                .await
                .map_err(|err| format!("Failed to connect MCP server '{}': {}", name, err))?
        } else if transport_name == "streamable_http"
            || transport_name == "http"
            || transport_name == "sse"
        {
            let url = server
                .url
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "MCP server URL is required for HTTP transport".to_string())?;

            let transport = StreamableHttpClientTransport::from_uri(url);
            ().serve(transport)
                .await
                .map_err(|err| format!("Failed to connect MCP server '{}': {}", name, err))?
        } else {
            return Err(format!("Unsupported MCP transport '{}'", server.transport));
        };

        let tools_result = service
            .list_tools(Default::default())
            .await
            .map_err(|err| format!("Failed to list tools for '{}': {}", name, err))?;
        let tool_values = serde_json::to_value(&tools_result)
            .ok()
            .and_then(|value| value.get("tools").cloned())
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default();

        tracing::info!(
            target: "mcp",
            server = %name,
            tools_count = tool_values.len(),
            "Connected MCP server"
        );

        Ok(McpClientEntry {
            service: Arc::new(service),
            tools: tool_values,
        })
    }

    fn build_stdio_command(
        &self,
        server_name: &str,
        server: &McpServerConfig,
        sandbox_mcp_enabled: bool,
    ) -> Result<Command, String> {
        #[cfg(not(feature = "redesign_sandbox"))]
        let _ = server_name;

        let command = server.command.trim();
        if command.is_empty() {
            return Err("MCP command is required for stdio transport".to_string());
        }

        let is_wasm_command = looks_like_wasm_server_command(command);
        if self.quarantine_requires_safe_runner(if is_wasm_command { "wasm" } else { "stdio" })
            && !is_wasm_command
        {
            let reason =
                "Quarantine is required for stdio MCP servers but no safe runner is available";
            self.audit_quarantine_reject(server_name, "stdio", reason);
            return Err(reason.to_string());
        }
        if is_wasm_command && !sandbox_mcp_enabled {
            let reason = "Wasm MCP command requires `features.redesign.sandbox_mcp=true` in config";
            if self.quarantine_requires_safe_runner("wasm") {
                self.audit_quarantine_reject(server_name, "wasm", reason);
            }
            return Err(reason.to_string());
        }

        if is_wasm_command {
            #[cfg(feature = "redesign_sandbox")]
            {
                let spec = build_wasm_launch_spec(command, &server.args, &server.env)?;
                let mut cmd = Command::new(&spec.executable);
                cmd.args(&spec.args);
                if spec.clear_env {
                    cmd.env_clear();
                }
                if !spec.env.is_empty() {
                    cmd.envs(&spec.env);
                }
                tracing::info!(
                    target: "mcp",
                    server = %server_name,
                    runtime = %spec.executable,
                    module = ?spec.module_path(),
                    "Launching Wasm MCP server in sandbox"
                );
                return Ok(cmd);
            }

            #[cfg(not(feature = "redesign_sandbox"))]
            {
                let reason =
                    "Wasm MCP command requires backend build with '--features redesign_sandbox'";
                if self.quarantine_requires_safe_runner("wasm") {
                    self.audit_quarantine_reject(server_name, "wasm", reason);
                }
                return Err(reason.to_string());
            }
        }

        let mut cmd = Command::new(command);
        cmd.args(&server.args);
        if !server.env.is_empty() {
            cmd.envs(&server.env);
        }
        Ok(cmd)
    }

    fn security_controls(&self) -> SecurityControls {
        SecurityControls::new(self.paths.clone(), self.config_service.clone())
    }

    fn quarantine_requires_safe_runner(&self, transport_name: &str) -> bool {
        let config = self
            .config_service
            .load_config()
            .unwrap_or_else(|_| Value::Object(Map::new()));
        let quarantine = config.get("quarantine").and_then(|value| value.as_object());
        let enabled = quarantine
            .and_then(|value| value.get("enabled"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let required = quarantine
            .and_then(|value| value.get("required"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        if !enabled || !required {
            return false;
        }
        let transports = quarantine
            .and_then(|value| value.get("required_transports"))
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(|value| value.to_ascii_lowercase()))
                    .collect::<Vec<String>>()
            })
            .filter(|items| !items.is_empty())
            .unwrap_or_else(|| vec!["stdio".to_string(), "wasm".to_string()]);
        transports
            .iter()
            .any(|item| item.eq_ignore_ascii_case(transport_name))
    }

    fn audit_quarantine_reject(&self, server_name: &str, transport_name: &str, reason: &str) {
        let _ = self.security_controls().record_audit(
            "quarantine_reject",
            "blocked",
            json!({
                "server_name": server_name,
                "transport": transport_name,
                "reason": reason,
            }),
        );
    }

    fn is_redesign_feature_enabled(&self, feature: &str) -> bool {
        self.config_service
            .load_config()
            .ok()
            .and_then(|c| c.get("features").cloned())
            .and_then(|f| f.get("redesign").cloned())
            .and_then(|r| r.get(feature).cloned())
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }
}

fn looks_like_wasm_server_command(command: &str) -> bool {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.starts_with("wasm:") {
        return true;
    }
    Path::new(trimmed)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("wasm"))
        .unwrap_or(false)
}
