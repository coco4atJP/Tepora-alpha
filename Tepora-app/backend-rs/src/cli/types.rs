use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::core::security_controls::PermissionRiskLevel;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CliProfilesConfig {
    #[serde(default)]
    pub cli_profiles: HashMap<String, CliProfileConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliProfileConfig {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    pub bin: String,
    pub description: String,
    #[serde(default)]
    pub allowed_prefixes: Vec<Vec<String>>,
    #[serde(default)]
    pub default_args: Vec<String>,
    #[serde(default)]
    pub json_mode: Option<CliJsonMode>,
    #[serde(default)]
    pub cwd_policy: CliCwdPolicy,
    #[serde(default)]
    pub env_allowlist: Vec<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub risk_level: PermissionRiskLevel,
    #[serde(default = "default_output_limit_bytes")]
    pub max_output_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliJsonMode {
    pub strategy: String,
    #[serde(default)]
    pub flags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliCwdPolicy {
    #[serde(default = "default_cwd_mode")]
    pub mode: String,
    #[serde(default)]
    pub path: Option<String>,
}

impl Default for CliCwdPolicy {
    fn default() -> Self {
        Self {
            mode: default_cwd_mode(),
            path: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CliToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub risk_level: PermissionRiskLevel,
    pub profile_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CliToolInput {
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

pub fn cli_tool_input_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "args": {
                "type": "array",
                "items": { "type": "string" }
            },
            "cwd": {
                "type": ["string", "null"]
            },
            "reason": {
                "type": ["string", "null"]
            }
        },
        "required": ["args"]
    })
}

fn default_enabled() -> bool {
    true
}

fn default_timeout_ms() -> u64 {
    20_000
}

fn default_output_limit_bytes() -> usize {
    64 * 1024
}

fn default_cwd_mode() -> String {
    "workspace".to_string()
}
