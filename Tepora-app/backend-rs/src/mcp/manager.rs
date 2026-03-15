use std::sync::Arc;

use serde_json::{json, Value};

use crate::core::config::{AppPaths, ConfigService};
use crate::core::errors::ApiError;

use super::config_store::McpConfigStore;
use super::connection_manager::McpConnectionManager;
use super::policy_manager::McpPolicyManager;
use super::state::McpRuntimeState;
use super::tool_executor::McpToolExecutor;
use super::types::{McpPolicy, McpServerStatus, McpToolInfo, McpToolsConfig};

/// Manages Model Context Protocol (MCP) servers and tools.
///
/// Handles:
/// - Server configuration and connection management
/// - Tool discovery and execution
/// - Policy enforcement (permissions, blocked commands)
/// - Configuration persistence
#[derive(Clone)]
pub struct McpManager {
    config_store: McpConfigStore,
    policy_manager: McpPolicyManager,
    connection_manager: McpConnectionManager,
    tool_executor: McpToolExecutor,
    runtime: McpRuntimeState,
}

impl McpManager {
    pub fn new(paths: Arc<AppPaths>, config_service: ConfigService) -> Self {
        let config_store = McpConfigStore::new(paths.clone(), config_service.clone());
        let runtime = McpRuntimeState::new();
        let policy_manager = McpPolicyManager::new(config_store.clone());
        let connection_manager = McpConnectionManager::new(
            paths,
            config_service,
            policy_manager.clone(),
            runtime.clone(),
        );
        let tool_executor = McpToolExecutor::new(runtime.clone());

        Self {
            config_store,
            policy_manager,
            connection_manager,
            tool_executor,
            runtime,
        }
    }

    pub fn initialized(&self) -> bool {
        self.runtime.initialized()
    }

    pub fn config_path(&self) -> std::path::PathBuf {
        self.config_store.config_path()
    }

    pub fn policy_path(&self) -> std::path::PathBuf {
        self.config_store.policy_path()
    }

    pub async fn init_error(&self) -> Option<String> {
        self.runtime.init_error.read().await.clone()
    }

    pub async fn initialize(&self) -> Result<(), ApiError> {
        let config = self.config_store.load_application_config();
        self.config_store.refresh_paths_from(&config);

        let tools_config = self.config_store.load_tools_config(&self.runtime).await?;
        let init_error = self
            .connection_manager
            .connect_all(&tools_config)
            .await
            .err()
            .map(|err| err.to_string());
        *self.runtime.init_error.write().await = init_error;
        self.runtime.set_initialized(true);
        Ok(())
    }

    pub async fn reload(&self) -> Result<(), ApiError> {
        let tools_config = self.config_store.load_tools_config(&self.runtime).await?;
        self.connection_manager.connect_all(&tools_config).await?;
        *self.runtime.init_error.write().await = None;
        Ok(())
    }

    pub async fn get_config(&self) -> McpToolsConfig {
        self.runtime.config.read().await.clone()
    }

    pub async fn status_snapshot(&self) -> std::collections::HashMap<String, McpServerStatus> {
        self.runtime.status.read().await.clone()
    }

    pub async fn list_tools(&self) -> Vec<McpToolInfo> {
        self.tool_executor.list_tools().await
    }

    pub async fn server_name_for_tool(&self, tool_name: &str) -> Result<String, ApiError> {
        self.tool_executor.server_name_for_tool(tool_name).await
    }

    pub async fn execute_tool(&self, tool_name: &str, args: &Value) -> Result<String, ApiError> {
        self.tool_executor.execute_tool(tool_name, args).await
    }

    pub async fn update_config(&self, payload: &Value) -> Result<(), ApiError> {
        let servers_value = payload
            .get("mcpServers")
            .cloned()
            .unwrap_or_else(|| payload.clone());
        let config_value = json!({ "mcpServers": servers_value });
        let parsed: McpToolsConfig = serde_json::from_value(config_value)
            .map_err(|e| ApiError::BadRequest(format!("Invalid MCP config: {}", e)))?;

        self.config_store.save_tools_config(&parsed)?;
        *self.runtime.config.write().await = parsed.clone();
        self.connection_manager.connect_all(&parsed).await?;
        *self.runtime.init_error.write().await = None;
        Ok(())
    }

    pub async fn set_server_enabled(
        &self,
        server_name: &str,
        enabled: bool,
    ) -> Result<bool, ApiError> {
        let mut raw = self.config_store.load_raw_config()?;
        let servers = raw
            .get_mut("mcpServers")
            .and_then(|v| v.as_object_mut())
            .ok_or_else(|| ApiError::BadRequest("Invalid MCP config format".to_string()))?;

        let Some(server) = servers.get_mut(server_name).and_then(|v| v.as_object_mut()) else {
            return Ok(false);
        };
        server.insert("enabled".to_string(), Value::Bool(enabled));

        self.config_store.save_raw_config(&raw)?;
        self.reload().await?;
        Ok(true)
    }

    pub async fn delete_server(&self, server_name: &str) -> Result<bool, ApiError> {
        let mut raw = self.config_store.load_raw_config()?;
        let servers = raw
            .get_mut("mcpServers")
            .and_then(|v| v.as_object_mut())
            .ok_or_else(|| ApiError::BadRequest("Invalid MCP config format".to_string()))?;

        if servers.remove(server_name).is_none() {
            return Ok(false);
        }

        self.config_store.save_raw_config(&raw)?;
        self.reload().await?;
        Ok(true)
    }

    pub fn load_policy(&self) -> Result<McpPolicy, ApiError> {
        self.policy_manager.load_policy()
    }

    pub fn save_policy(&self, policy: &McpPolicy) -> Result<(), ApiError> {
        self.policy_manager.save_policy(policy)
    }

    pub fn update_policy(&self, payload: &Value) -> Result<McpPolicy, ApiError> {
        self.policy_manager.update_policy(payload)
    }

    pub fn approve_server(
        &self,
        server_name: &str,
        transport_types: Option<Vec<String>>,
    ) -> Result<McpPolicy, ApiError> {
        self.policy_manager
            .approve_server(server_name, transport_types)
    }

    pub fn revoke_server(&self, server_name: &str) -> Result<(McpPolicy, bool), ApiError> {
        self.policy_manager.revoke_server(server_name)
    }
}
