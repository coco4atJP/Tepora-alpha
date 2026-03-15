use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    pub input_schema: Option<Value>,
}

fn default_enabled() -> bool {
    true
}

fn default_transport() -> String {
    "stdio".to_string()
}
