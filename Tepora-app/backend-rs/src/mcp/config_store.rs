use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock as StdRwLock};

use serde_json::{json, Map, Value};

use crate::core::config::{AppPaths, ConfigService};
use crate::core::errors::ApiError;

use super::state::McpRuntimeState;
use super::types::McpToolsConfig;

#[derive(Clone)]
pub(crate) struct McpConfigStore {
    paths: Arc<AppPaths>,
    config_service: ConfigService,
    config_path: Arc<StdRwLock<PathBuf>>,
    policy_path: Arc<StdRwLock<PathBuf>>,
}

impl McpConfigStore {
    pub(crate) fn new(paths: Arc<AppPaths>, config_service: ConfigService) -> Self {
        let initial_config = config_service
            .load_config()
            .unwrap_or_else(|_| Value::Object(Map::new()));
        let config_path = resolve_mcp_config_path(&initial_config, &paths);
        let policy_path = resolve_mcp_policy_path(&config_path);

        Self {
            paths,
            config_service,
            config_path: Arc::new(StdRwLock::new(config_path)),
            policy_path: Arc::new(StdRwLock::new(policy_path)),
        }
    }

    pub(crate) fn load_application_config(&self) -> Value {
        self.config_service
            .load_config()
            .unwrap_or_else(|_| Value::Object(Map::new()))
    }

    pub(crate) fn refresh_paths_from(&self, config: &Value) {
        let config_path = resolve_mcp_config_path(config, &self.paths);
        let policy_path = resolve_mcp_policy_path(&config_path);

        if let Ok(mut path_guard) = self.config_path.write() {
            *path_guard = config_path;
        }
        if let Ok(mut path_guard) = self.policy_path.write() {
            *path_guard = policy_path;
        }
    }

    pub(crate) fn config_path(&self) -> PathBuf {
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

    pub(crate) fn policy_path(&self) -> PathBuf {
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

    pub(crate) async fn load_tools_config(
        &self,
        runtime: &McpRuntimeState,
    ) -> Result<McpToolsConfig, ApiError> {
        let config_path = self.config_path();
        ensure_config_file(&config_path)?;
        let contents = fs::read_to_string(&config_path).unwrap_or_default();
        if contents.trim().is_empty() {
            let empty = McpToolsConfig::default();
            *runtime.config.write().await = empty.clone();
            return Ok(empty);
        }
        let parsed = match serde_json::from_str::<McpToolsConfig>(&contents) {
            Ok(config) => config,
            Err(e) => {
                tracing::warn!(
                    config_path = %config_path.display(),
                    line = e.line(),
                    column = e.column(),
                    error = %e,
                    "Failed to parse MCP config; using current in-memory config. \
                     Please fix the configuration file to avoid silent rollback."
                );
                return Ok(runtime.config.read().await.clone());
            }
        };
        *runtime.config.write().await = parsed.clone();
        Ok(parsed)
    }

    pub(crate) fn save_tools_config(&self, config: &McpToolsConfig) -> Result<(), ApiError> {
        let config_path = self.config_path();
        if let Some(parent) = config_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let data = serde_json::to_string_pretty(config).map_err(ApiError::internal)?;
        fs::write(config_path, data).map_err(ApiError::internal)?;
        Ok(())
    }

    pub(crate) fn load_raw_config(&self) -> Result<Value, ApiError> {
        let config_path = self.config_path();
        ensure_config_file(&config_path)?;
        let contents = fs::read_to_string(&config_path).unwrap_or_default();
        if contents.trim().is_empty() {
            return Ok(json!({ "mcpServers": {} }));
        }
        serde_json::from_str(&contents).map_err(ApiError::internal)
    }

    pub(crate) fn save_raw_config(&self, config: &Value) -> Result<(), ApiError> {
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
