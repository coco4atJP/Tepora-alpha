use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock as StdRwLock};

use chrono::Utc;
use reqwest::Url;
use rmcp::model::CallToolRequestParams;
use rmcp::service::RoleClient;
use rmcp::service::RunningService;
use rmcp::transport::{ConfigureCommandExt, StreamableHttpClientTransport, TokioChildProcess};
use rmcp::ServiceExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::process::Command;
use tokio::sync::RwLock;

use crate::core::config::{AppPaths, ConfigService};
use crate::core::errors::ApiError;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct McpToolsConfig {
    #[serde(rename = "mcpServers", default)]
    pub mcp_servers: HashMap<String, McpServerConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerMetadata {
    pub name: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default = "default_transport")]
    pub transport: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub metadata: Option<McpServerMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerStatus {
    pub status: String,
    pub tools_count: usize,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub last_connected: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpPolicy {
    pub policy: String,
    #[serde(default)]
    pub server_permissions: HashMap<String, McpServerPermission>,
    #[serde(default)]
    pub blocked_commands: Vec<String>,
    pub require_tool_confirmation: bool,
    pub first_use_confirmation: bool,
}

impl Default for McpPolicy {
    fn default() -> Self {
        Self {
            policy: "LOCAL_ONLY".to_string(),
            server_permissions: HashMap::new(),
            blocked_commands: vec![
                "sudo".to_string(),
                "rm -rf".to_string(),
                "format".to_string(),
                "del /f".to_string(),
                "shutdown".to_string(),
            ],
            require_tool_confirmation: true,
            first_use_confirmation: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct McpServerPermission {
    #[serde(default)]
    pub allowed: bool,
    #[serde(default)]
    pub transport_types: Vec<String>,
    #[serde(default)]
    pub approved_at: Option<String>,
    #[serde(default)]
    pub approved_by: Option<String>,
}

#[derive(Debug, Clone)]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
}

trait SafeMcpService: Send + Sync {
    fn call_tool_boxed(
        &self,
        params: CallToolRequestParams,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<rmcp::model::CallToolResult, rmcp::ServiceError>,
                > + Send
                + '_,
        >,
    >;
}

impl SafeMcpService for RunningService<RoleClient, ()> {
    fn call_tool_boxed(
        &self,
        params: CallToolRequestParams,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<rmcp::model::CallToolResult, rmcp::ServiceError>,
                > + Send
                + '_,
        >,
    > {
        Box::pin(self.call_tool(params))
    }
}

#[derive(Clone)]
struct McpClientEntry {
    service: Arc<dyn SafeMcpService>,
    tools: Vec<Value>,
}

#[derive(Clone)]
pub struct McpManager {
    paths: Arc<AppPaths>,
    config_service: ConfigService,
    config: Arc<RwLock<McpToolsConfig>>,
    status: Arc<RwLock<HashMap<String, McpServerStatus>>>,
    clients: Arc<RwLock<HashMap<String, McpClientEntry>>>,
    initialized: Arc<AtomicBool>,
    init_error: Arc<RwLock<Option<String>>>,
    config_path: Arc<StdRwLock<PathBuf>>,
    policy_path: Arc<StdRwLock<PathBuf>>,
}

impl McpManager {
    pub fn new(paths: Arc<AppPaths>, config_service: ConfigService) -> Self {
        let initial_config = config_service
            .load_config()
            .unwrap_or_else(|_| Value::Object(Map::new()));
        let config_path = resolve_mcp_config_path(&initial_config, &paths);
        let policy_path = resolve_mcp_policy_path(&config_path);

        Self {
            paths,
            config_service,
            config: Arc::new(RwLock::new(McpToolsConfig::default())),
            status: Arc::new(RwLock::new(HashMap::new())),
            clients: Arc::new(RwLock::new(HashMap::new())),
            initialized: Arc::new(AtomicBool::new(false)),
            init_error: Arc::new(RwLock::new(None)),
            config_path: Arc::new(StdRwLock::new(config_path)),
            policy_path: Arc::new(StdRwLock::new(policy_path)),
        }
    }

    pub fn initialized(&self) -> bool {
        self.initialized.load(Ordering::SeqCst)
    }

    pub fn config_path(&self) -> PathBuf {
        self.config_path
            .read()
            .map(|p| p.clone())
            .unwrap_or_else(|_| {
                self.paths
                    .user_data_dir
                    .join("config")
                    .join("mcp_tools_config.json")
            })
    }

    pub fn policy_path(&self) -> PathBuf {
        self.policy_path
            .read()
            .map(|p| p.clone())
            .unwrap_or_else(|_| {
                self.paths
                    .user_data_dir
                    .join("config")
                    .join("mcp_policy.json")
            })
    }

    pub async fn init_error(&self) -> Option<String> {
        self.init_error.read().await.clone()
    }

    pub async fn initialize(&self) -> Result<(), ApiError> {
        let config = self
            .config_service
            .load_config()
            .unwrap_or_else(|_| Value::Object(Map::new()));
        self.refresh_paths_from(&config);

        let tools_config = self.load_tools_config().await?;
        if let Err(err) = self.connect_all(&tools_config).await {
            let mut error_guard = self.init_error.write().await;
            *error_guard = Some(err.to_string());
        } else {
            let mut error_guard = self.init_error.write().await;
            *error_guard = None;
        }

        self.initialized.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub async fn reload(&self) -> Result<(), ApiError> {
        let tools_config = self.load_tools_config().await?;
        self.connect_all(&tools_config).await?;
        Ok(())
    }

    pub async fn get_config(&self) -> McpToolsConfig {
        self.config.read().await.clone()
    }

    pub async fn status_snapshot(&self) -> HashMap<String, McpServerStatus> {
        self.status.read().await.clone()
    }

    pub async fn list_tools(&self) -> Vec<McpToolInfo> {
        let clients = self.clients.read().await;
        let mut result = Vec::new();

        for (server_name, entry) in clients.iter() {
            for tool_value in &entry.tools {
                let name = tool_value
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if name.is_empty() {
                    continue;
                }
                let description = tool_value
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                result.push(McpToolInfo {
                    name: format!("{}_{}", server_name, name),
                    description,
                });
            }
        }

        result.sort_by(|a, b| a.name.cmp(&b.name));
        result
    }

    pub async fn execute_tool(&self, tool_name: &str, args: &Value) -> Result<String, ApiError> {
        let (server_name, short_name) = self.resolve_tool_name(tool_name).await?;
        let entry = {
            let clients = self.clients.read().await;
            clients.get(&server_name).cloned().ok_or_else(|| {
                ApiError::NotFound(format!("MCP server '{}' not connected", server_name))
            })?
        };

        let arguments = build_tool_arguments(args);
        let params = CallToolRequestParams {
            name: short_name.into(),
            arguments,
            meta: None,
            task: None,
        };

        let result = entry
            .service
            .call_tool_boxed(params)
            .await
            .map_err(ApiError::internal)?;

        Ok(format_tool_result(&result))
    }

    pub async fn update_config(&self, payload: &Value) -> Result<(), ApiError> {
        let servers_value = payload
            .get("mcpServers")
            .cloned()
            .unwrap_or_else(|| payload.clone());
        let config_value = json!({ "mcpServers": servers_value });
        let parsed: McpToolsConfig =
            serde_json::from_value(config_value.clone()).unwrap_or_default();

        self.save_tools_config(&parsed)?;
        *self.config.write().await = parsed.clone();
        self.connect_all(&parsed).await?;
        Ok(())
    }

    pub async fn set_server_enabled(
        &self,
        server_name: &str,
        enabled: bool,
    ) -> Result<bool, ApiError> {
        let mut raw = self.load_raw_config()?;
        let servers = raw
            .get_mut("mcpServers")
            .and_then(|v| v.as_object_mut())
            .ok_or_else(|| ApiError::BadRequest("Invalid MCP config format".to_string()))?;

        let Some(server) = servers.get_mut(server_name).and_then(|v| v.as_object_mut()) else {
            return Ok(false);
        };
        server.insert("enabled".to_string(), Value::Bool(enabled));

        self.save_raw_config(&raw)?;
        self.reload().await?;
        Ok(true)
    }

    pub async fn delete_server(&self, server_name: &str) -> Result<bool, ApiError> {
        let mut raw = self.load_raw_config()?;
        let servers = raw
            .get_mut("mcpServers")
            .and_then(|v| v.as_object_mut())
            .ok_or_else(|| ApiError::BadRequest("Invalid MCP config format".to_string()))?;

        if servers.remove(server_name).is_none() {
            return Ok(false);
        }

        self.save_raw_config(&raw)?;
        self.reload().await?;
        Ok(true)
    }

    pub fn load_policy(&self) -> Result<McpPolicy, ApiError> {
        let path = self.policy_path();
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

    pub fn save_policy(&self, policy: &McpPolicy) -> Result<(), ApiError> {
        let path = self.policy_path();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let serialized = serde_json::to_string_pretty(policy).map_err(ApiError::internal)?;
        fs::write(path, serialized).map_err(ApiError::internal)?;
        Ok(())
    }

    pub fn update_policy(&self, payload: &Value) -> Result<McpPolicy, ApiError> {
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

    pub fn approve_server(
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

    pub fn revoke_server(&self, server_name: &str) -> Result<(McpPolicy, bool), ApiError> {
        let mut policy = self.load_policy().unwrap_or_default();
        let removed = policy.server_permissions.remove(server_name).is_some();
        self.save_policy(&policy)?;
        Ok((policy, removed))
    }

    fn refresh_paths_from(&self, config: &Value) {
        let config_path = resolve_mcp_config_path(config, &self.paths);
        let policy_path = resolve_mcp_policy_path(&config_path);

        if let Ok(mut path_guard) = self.config_path.write() {
            *path_guard = config_path;
        }
        if let Ok(mut path_guard) = self.policy_path.write() {
            *path_guard = policy_path;
        }
    }

    async fn connect_all(&self, tools_config: &McpToolsConfig) -> Result<(), ApiError> {
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

        *self.clients.write().await = new_clients;
        *self.status.write().await = new_status;
        Ok(())
    }

    async fn connect_server(
        &self,
        name: &str,
        server: &McpServerConfig,
    ) -> Result<McpClientEntry, String> {
        self.policy_allows_connection(name, server)?;

        let transport_name = server.transport.to_lowercase();
        let service = if transport_name == "stdio" || transport_name.is_empty() {
            let command = server.command.trim();
            if command.is_empty() {
                return Err("MCP command is required for stdio transport".to_string());
            }
            let mut cmd = Command::new(command);
            cmd.args(&server.args);
            if !server.env.is_empty() {
                cmd.envs(&server.env);
            }
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

        Ok(McpClientEntry {
            service: Arc::new(service),
            tools: tool_values,
        })
    }

    fn policy_allows_connection(&self, name: &str, server: &McpServerConfig) -> Result<(), String> {
        let policy = self.load_policy().map_err(|err| err.to_string())?;
        let transport = server.transport.to_lowercase();

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
            "allow_all" => Ok(()),
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

    async fn resolve_tool_name(&self, tool_name: &str) -> Result<(String, String), ApiError> {
        let clients = self.clients.read().await;
        let mut match_name: Option<String> = None;
        for server_name in clients.keys() {
            let prefix = format!("{}_", server_name);
            if tool_name.starts_with(&prefix) {
                let is_better = match_name
                    .as_ref()
                    .map(|current| server_name.len() > current.len())
                    .unwrap_or(true);
                if is_better {
                    match_name = Some(server_name.clone());
                }
            }
        }

        let Some(server_name) = match_name else {
            return Err(ApiError::NotFound(format!(
                "Unknown MCP tool: {}",
                tool_name
            )));
        };

        let short_name = tool_name
            .strip_prefix(&format!("{}_", server_name))
            .unwrap_or(tool_name)
            .to_string();
        Ok((server_name, short_name))
    }

    async fn load_tools_config(&self) -> Result<McpToolsConfig, ApiError> {
        let config_path = self.config_path();
        ensure_config_file(&config_path)?;
        let contents = fs::read_to_string(&config_path).unwrap_or_default();
        if contents.trim().is_empty() {
            let empty = McpToolsConfig::default();
            *self.config.write().await = empty.clone();
            return Ok(empty);
        }
        let parsed = serde_json::from_str::<McpToolsConfig>(&contents).unwrap_or_default();
        *self.config.write().await = parsed.clone();
        Ok(parsed)
    }

    fn save_tools_config(&self, config: &McpToolsConfig) -> Result<(), ApiError> {
        let config_path = self.config_path();
        if let Some(parent) = config_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let data = serde_json::to_string_pretty(config).map_err(ApiError::internal)?;
        fs::write(config_path, data).map_err(ApiError::internal)?;
        Ok(())
    }

    fn load_raw_config(&self) -> Result<Value, ApiError> {
        let config_path = self.config_path();
        ensure_config_file(&config_path)?;
        let contents = fs::read_to_string(&config_path).unwrap_or_default();
        if contents.trim().is_empty() {
            return Ok(json!({ "mcpServers": {} }));
        }
        serde_json::from_str(&contents).map_err(ApiError::internal)
    }

    fn save_raw_config(&self, config: &Value) -> Result<(), ApiError> {
        let config_path = self.config_path();
        if let Some(parent) = config_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let data = serde_json::to_string_pretty(config).map_err(ApiError::internal)?;
        fs::write(config_path, data).map_err(ApiError::internal)?;
        Ok(())
    }
}

fn resolve_mcp_config_path(config: &Value, paths: &AppPaths) -> PathBuf {
    let default_path = "config/mcp_tools_config.json";
    let raw = config
        .get("app")
        .and_then(|v| v.get("mcp_config_path"))
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(default_path);

    let candidate = PathBuf::from(raw);
    if candidate.is_absolute() {
        candidate
    } else {
        paths.user_data_dir.join(candidate)
    }
}

fn resolve_mcp_policy_path(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("mcp_policy.json")
}

fn ensure_config_file(path: &Path) -> Result<(), ApiError> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let payload = json!({ "mcpServers": {} });
    let contents = serde_json::to_string_pretty(&payload).map_err(ApiError::internal)?;
    fs::write(path, contents).map_err(ApiError::internal)?;
    Ok(())
}

fn default_enabled() -> bool {
    true
}

fn default_transport() -> String {
    "stdio".to_string()
}

fn build_tool_arguments(args: &Value) -> Option<Map<String, Value>> {
    match args {
        Value::Object(map) => Some(map.clone()),
        Value::Null => None,
        _ => {
            let mut map = Map::new();
            map.insert("input".to_string(), args.clone());
            Some(map)
        }
    }
}

fn format_tool_result(result: &impl Serialize) -> String {
    let value = serde_json::to_value(result).unwrap_or(Value::Null);
    let mut parts = Vec::new();
    if let Some(content) = value.get("content").and_then(|v| v.as_array()) {
        for item in content {
            let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if item_type == "text" {
                if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                    if !text.trim().is_empty() {
                        parts.push(text.to_string());
                        continue;
                    }
                }
            }
            parts.push(item.to_string());
        }
    }

    if parts.is_empty() {
        return serde_json::to_string_pretty(&value).unwrap_or_default();
    }

    let mut output = parts.join("\n");
    let is_error = value
        .get("is_error")
        .or_else(|| value.get("isError"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if is_error {
        output = format!("Tool error: {}", output);
    }
    output
}
