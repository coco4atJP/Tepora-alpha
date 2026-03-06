//! ExclusiveAgentManager — Manages ExecutionAgent definitions from `config.yml`.
//!
//! Agent definitions are now persisted under `custom_agents` via `ConfigService`
//! so they are managed through the same centralized configuration channel as
//! other application settings. Existing `agents.yaml` is treated as a legacy
//! source and migrated on first load when `custom_agents` is empty.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tracing;

use crate::agent::policy::CustomToolPolicy;
use crate::core::config::{AppPaths, ConfigService};
use crate::core::errors::ApiError;
use crate::core::native_tools::resolve_tool_alias;

/// A single agent definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionAgent {
    /// Unique identifier.
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// Short description for UI / LLM.
    #[serde(default)]
    pub description: String,
    /// Whether this agent is enabled.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// System prompt injected into the LLM context.
    #[serde(default)]
    pub system_prompt: String,
    /// Optional model config name override (e.g. "coding_model").
    #[serde(default)]
    pub model_config_name: Option<String>,
    /// Tool permission policy.
    #[serde(default)]
    pub tool_policy: AgentToolPolicy,
    /// Priority for auto-selection (higher = more preferred).
    #[serde(default = "default_priority")]
    pub priority: i32,
    /// Tags for matching user queries to agents.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Optional icon (emoji or short text) for UI.
    #[serde(default)]
    pub icon: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_priority() -> i32 {
    0
}

/// Tool policy definition for an execution agent.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentToolPolicy {
    /// If true, all tools are allowed unless explicitly denied.
    #[serde(default)]
    pub allow_all: Option<bool>,
    /// Explicit tool allowlist (supports `mcp:server_tool` prefix).
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    /// Explicit tool denylist.
    #[serde(default)]
    pub denied_tools: Vec<String>,
    /// Tools that require user confirmation before execution.
    #[serde(default)]
    pub require_confirmation: Vec<String>,
}

impl AgentToolPolicy {
    /// Convert to existing `CustomToolPolicy` for runtime compatibility.
    pub fn to_custom_tool_policy(&self) -> CustomToolPolicy {
        let allow_all = self.allow_all.unwrap_or(self.allowed_tools.is_empty());

        CustomToolPolicy {
            allow_all,
            allowed_tools: self
                .allowed_tools
                .iter()
                .map(|t| resolve_tool_name(t))
                .collect(),
            denied_tools: self
                .denied_tools
                .iter()
                .map(|t| resolve_tool_name(t))
                .collect(),
            require_confirmation: self
                .require_confirmation
                .iter()
                .map(|t| resolve_tool_name(t))
                .collect(),
        }
    }
}

/// Stored shape for each agent in persisted config.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct AgentEntry {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    system_prompt: String,
    #[serde(default)]
    model_config_name: Option<String>,
    #[serde(default)]
    tool_policy: AgentToolPolicy,
    #[serde(default = "default_priority")]
    priority: i32,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    icon: Option<String>,
}

/// Legacy `agents.yaml` root format.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct AgentsFile {
    #[serde(default)]
    agents: HashMap<String, AgentEntry>,
}

/// Resolve a tool name from persisted syntax.
fn resolve_tool_name(raw: &str) -> String {
    resolve_tool_alias(raw)
}

/// Manages execution-agent definitions and persistence.
#[derive(Clone)]
pub struct ExclusiveAgentManager {
    agents: Arc<RwLock<HashMap<String, ExecutionAgent>>>,
    config_service: ConfigService,
    legacy_path: PathBuf,
}

impl ExclusiveAgentManager {
    /// Create manager backed by centralized config service.
    pub fn new(paths: &AppPaths, config_service: ConfigService) -> Self {
        let manager = Self {
            agents: Arc::new(RwLock::new(HashMap::new())),
            config_service,
            legacy_path: paths.user_data_dir.join("config").join("agents.yaml"),
        };

        if let Err(e) = manager.reload() {
            tracing::warn!("Failed to load custom_agents on init: {}", e);
        }

        manager
    }

    /// Reload agents from config (with one-way legacy migration support).
    pub fn reload(&self) -> Result<(), ApiError> {
        let config = self
            .config_service
            .load_config()
            .unwrap_or_else(|_| Value::Object(Map::new()));

        let mut agents = load_agents_from_config(&config)?;

        if agents.is_empty() {
            let legacy_agents = load_agents_from_file(&self.legacy_path)?;
            if !legacy_agents.is_empty() {
                tracing::info!(
                    "Migrating {} agent(s) from legacy agents.yaml into config.yml",
                    legacy_agents.len()
                );
                self.persist_agents_map(&legacy_agents)?;
                agents = legacy_agents;
            }
        }

        let mut guard = self
            .agents
            .write()
            .map_err(|e| ApiError::internal(format!("Lock poisoned: {e}")))?;
        *guard = agents;
        Ok(())
    }

    /// Get all enabled agents.
    pub fn list_enabled(&self) -> Vec<ExecutionAgent> {
        let guard = self.agents.read().unwrap_or_else(|e| e.into_inner());
        guard.values().filter(|a| a.enabled).cloned().collect()
    }

    /// Get all agents (including disabled).
    pub fn list_all(&self) -> Vec<ExecutionAgent> {
        let guard = self.agents.read().unwrap_or_else(|e| e.into_inner());
        guard.values().cloned().collect()
    }

    /// Get a specific agent by ID.
    pub fn get(&self, agent_id: &str) -> Option<ExecutionAgent> {
        let guard = self.agents.read().unwrap_or_else(|e| e.into_inner());
        guard.get(agent_id).cloned()
    }

    /// Choose the best agent for a given request.
    pub fn choose_agent(
        &self,
        requested_agent_id: Option<&str>,
        user_input: &str,
    ) -> Option<ExecutionAgent> {
        let guard = self.agents.read().unwrap_or_else(|e| e.into_inner());

        if let Some(id) = requested_agent_id.map(str::trim).filter(|v| !v.is_empty()) {
            if let Some(agent) = guard.get(id).filter(|a| a.enabled) {
                return Some(agent.clone());
            }
        }

        let enabled: Vec<&ExecutionAgent> = guard.values().filter(|a| a.enabled).collect();
        if enabled.is_empty() {
            return None;
        }

        let query = user_input.to_lowercase();
        let mut ranked: Vec<(&ExecutionAgent, i32)> = enabled
            .into_iter()
            .map(|agent| {
                let tag_score = score_agent_tags(agent, &query);
                let final_score = agent.priority + tag_score;
                (agent, final_score)
            })
            .collect();

        ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.id.cmp(&b.0.id)));

        ranked.into_iter().next().map(|(agent, _)| agent.clone())
    }

    /// Save current in-memory agents to centralized config.
    pub fn save(&self) -> Result<(), ApiError> {
        let guard = self.agents.read().unwrap_or_else(|e| e.into_inner());
        self.persist_agents_map(&guard)
    }

    /// Add or update an agent definition.
    pub fn upsert(&self, agent: ExecutionAgent) -> Result<(), ApiError> {
        let mut guard = self
            .agents
            .write()
            .map_err(|e| ApiError::internal(format!("Lock poisoned: {e}")))?;
        guard.insert(agent.id.clone(), agent);
        drop(guard);
        self.save()
    }

    /// Delete an agent by ID.
    pub fn delete(&self, agent_id: &str) -> Result<bool, ApiError> {
        let mut guard = self
            .agents
            .write()
            .map_err(|e| ApiError::internal(format!("Lock poisoned: {e}")))?;
        let removed = guard.remove(agent_id).is_some();
        drop(guard);
        if removed {
            self.save()?;
        }
        Ok(removed)
    }

    /// Seed default agent set into centralized config.
    pub fn create_default_config(&self) -> Result<(), ApiError> {
        let defaults = default_agents();
        self.persist_agents_map(&defaults)?;
        let mut guard = self
            .agents
            .write()
            .map_err(|e| ApiError::internal(format!("Lock poisoned: {e}")))?;
        *guard = defaults;
        Ok(())
    }

    fn persist_agents_map(&self, agents: &HashMap<String, ExecutionAgent>) -> Result<(), ApiError> {
        let mut config = self
            .config_service
            .load_config()
            .unwrap_or_else(|_| Value::Object(Map::new()));

        let root = config.as_object_mut().ok_or_else(|| {
            ApiError::BadRequest(
                "Invalid root configuration while saving custom_agents".to_string(),
            )
        })?;

        let mut entries = HashMap::new();
        for (id, agent) in agents {
            entries.insert(
                id.clone(),
                AgentEntry {
                    name: agent.name.clone(),
                    description: agent.description.clone(),
                    enabled: agent.enabled,
                    system_prompt: agent.system_prompt.clone(),
                    model_config_name: agent.model_config_name.clone(),
                    tool_policy: agent.tool_policy.clone(),
                    priority: agent.priority,
                    tags: agent.tags.clone(),
                    icon: agent.icon.clone(),
                },
            );
        }

        let value = serde_json::to_value(entries).map_err(ApiError::internal)?;
        root.insert("custom_agents".to_string(), value);
        self.config_service.update_config(config, false)
    }
}

fn load_agents_from_config(config: &Value) -> Result<HashMap<String, ExecutionAgent>, ApiError> {
    let Some(section) = config.get("custom_agents") else {
        return Ok(HashMap::new());
    };

    if section.is_null() {
        return Ok(HashMap::new());
    }

    let entries: HashMap<String, AgentEntry> = if section
        .as_object()
        .and_then(|obj| obj.get("agents"))
        .is_some()
    {
        // Compatibility: allow { custom_agents: { agents: { ... } } }
        let legacy: AgentsFile = serde_json::from_value(section.clone()).map_err(|e| {
            ApiError::BadRequest(format!("Invalid custom_agents legacy format: {e}"))
        })?;
        legacy.agents
    } else {
        serde_json::from_value(section.clone())
            .map_err(|e| ApiError::BadRequest(format!("Invalid custom_agents section: {e}")))?
    };

    let mut agents = HashMap::new();
    for (id, entry) in entries {
        agents.insert(
            id.clone(),
            ExecutionAgent {
                id,
                name: entry.name,
                description: entry.description,
                enabled: entry.enabled,
                system_prompt: entry.system_prompt,
                model_config_name: entry.model_config_name,
                tool_policy: entry.tool_policy,
                priority: entry.priority,
                tags: entry.tags,
                icon: entry.icon,
            },
        );
    }

    Ok(agents)
}

fn load_agents_from_file(path: &Path) -> Result<HashMap<String, ExecutionAgent>, ApiError> {
    if !path.exists() {
        return Ok(HashMap::new());
    }

    let contents = fs::read_to_string(path).map_err(ApiError::internal)?;
    if contents.trim().is_empty() {
        return Ok(HashMap::new());
    }

    let file: AgentsFile = serde_yaml::from_str(&contents)
        .map_err(|e| ApiError::internal(format!("Failed to parse agents.yaml: {e}")))?;

    let mut agents = HashMap::new();
    for (id, entry) in file.agents {
        agents.insert(
            id.clone(),
            ExecutionAgent {
                id,
                name: entry.name,
                description: entry.description,
                enabled: entry.enabled,
                system_prompt: entry.system_prompt,
                model_config_name: entry.model_config_name,
                tool_policy: entry.tool_policy,
                priority: entry.priority,
                tags: entry.tags,
                icon: entry.icon,
            },
        );
    }

    Ok(agents)
}

fn score_agent_tags(agent: &ExecutionAgent, query: &str) -> i32 {
    let mut score = 0i32;

    for tag in &agent.tags {
        if query.contains(&tag.to_lowercase()) {
            score += 5;
        }
    }

    let corpus = format!("{} {}", agent.name, agent.description).to_lowercase();
    let tokens: Vec<&str> = query
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .filter(|t| t.len() >= 3)
        .take(20)
        .collect();

    for token in tokens {
        if corpus.contains(token) {
            score += 1;
        }
    }

    score
}

fn default_agents() -> HashMap<String, ExecutionAgent> {
    let mut agents = HashMap::new();

    agents.insert(
        "general".to_string(),
        ExecutionAgent {
            id: "general".to_string(),
            name: "General Assistant".to_string(),
            description: "General-purpose task assistant.".to_string(),
            enabled: true,
            system_prompt: String::new(),
            model_config_name: None,
            tool_policy: AgentToolPolicy {
                allow_all: Some(true),
                ..Default::default()
            },
            priority: 0,
            tags: vec!["general".to_string(), "default".to_string()],
            icon: Some("🤖".to_string()),
        },
    );

    agents.insert(
        "coder".to_string(),
        ExecutionAgent {
            id: "coder".to_string(),
            name: "Code Assistant".to_string(),
            description: "Specialized in software engineering tasks.".to_string(),
            enabled: true,
            system_prompt: "You are an expert programmer. Prioritize correctness, error handling, and maintainability.".to_string(),
            model_config_name: None,
            tool_policy: AgentToolPolicy {
                allow_all: Some(true),
                ..Default::default()
            },
            priority: 10,
            tags: vec![
                "code".to_string(),
                "programming".to_string(),
                "debug".to_string(),
                "implement".to_string(),
            ],
            icon: Some("🧠".to_string()),
        },
    );

    agents.insert(
        "researcher".to_string(),
        ExecutionAgent {
            id: "researcher".to_string(),
            name: "Research Assistant".to_string(),
            description: "Specialized in information gathering and analysis.".to_string(),
            enabled: true,
            system_prompt: "You are a rigorous researcher. Clearly separate facts from inference and provide traceable reasoning.".to_string(),
            model_config_name: None,
            tool_policy: AgentToolPolicy {
                allow_all: Some(false),
                allowed_tools: vec!["web_search".to_string(), "fetch_url".to_string(), "mcp:*".to_string()],
                denied_tools: Vec::new(),
                require_confirmation: Vec::new(),
            },
            priority: 5,
            tags: vec![
                "research".to_string(),
                "search".to_string(),
                "analyze".to_string(),
            ],
            icon: Some("📚".to_string()),
        },
    );

    agents
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn make_paths(temp: &TempDir) -> Arc<AppPaths> {
        let root = temp.path().to_path_buf();
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        Arc::new(AppPaths {
            project_root: root.clone(),
            user_data_dir: data.clone(),
            log_dir: data.join("logs"),
            db_path: data.join("tepora_core.db"),
            secrets_path: data.join("secrets.yaml"),
        })
    }

    fn setup_manager(temp: &TempDir) -> (ConfigService, ExclusiveAgentManager) {
        let paths = make_paths(temp);
        let config = ConfigService::new(paths.clone());
        let manager = ExclusiveAgentManager::new(paths.as_ref(), config.clone());
        (config, manager)
    }

    #[test]
    fn loads_agents_from_config_section() {
        let temp = TempDir::new().unwrap();
        let paths = make_paths(&temp);
        let config = ConfigService::new(paths.clone());

        let initial = serde_json::json!({
            "custom_agents": {
                "coder": {
                    "name": "Coder",
                    "description": "Coding",
                    "enabled": true,
                    "system_prompt": "help",
                    "priority": 10,
                    "tags": ["code"],
                    "tool_policy": { "allow_all": true }
                }
            }
        });
        config.update_config(initial, false).unwrap();

        let manager = ExclusiveAgentManager::new(paths.as_ref(), config.clone());
        let agents = manager.list_all();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "coder");
        assert_eq!(agents[0].name, "Coder");
    }

    #[test]
    fn migrates_legacy_agents_yaml_when_config_empty() {
        let temp = TempDir::new().unwrap();
        let (config, manager) = setup_manager(&temp);

        let legacy_path = temp.path().join("data").join("config").join("agents.yaml");
        fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
        fs::write(
            &legacy_path,
            r#"agents:
  legacy_agent:
    name: Legacy Agent
    description: migrated
    enabled: true
    system_prompt: legacy prompt
    priority: 3
    tags: [legacy]
    tool_policy:
      allow_all: true
"#,
        )
        .unwrap();

        manager.reload().unwrap();
        let agents = manager.list_all();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "legacy_agent");

        let saved = config.load_config().unwrap();
        assert!(saved
            .get("custom_agents")
            .and_then(|v| v.get("legacy_agent"))
            .is_some());
    }

    #[test]
    fn upsert_and_delete_are_persisted_to_config() {
        let temp = TempDir::new().unwrap();
        let (config, manager) = setup_manager(&temp);

        manager
            .upsert(ExecutionAgent {
                id: "alpha".to_string(),
                name: "Alpha".to_string(),
                description: "desc".to_string(),
                enabled: true,
                system_prompt: "prompt".to_string(),
                model_config_name: None,
                tool_policy: AgentToolPolicy {
                    allow_all: Some(true),
                    ..Default::default()
                },
                priority: 1,
                tags: vec!["one".to_string()],
                icon: Some("A".to_string()),
            })
            .unwrap();

        let saved = config.load_config().unwrap();
        assert!(saved
            .get("custom_agents")
            .and_then(|v| v.get("alpha"))
            .is_some());

        assert!(manager.delete("alpha").unwrap());

        let saved = config.load_config().unwrap();
        assert!(saved
            .get("custom_agents")
            .and_then(|v| v.get("alpha"))
            .is_none());
    }

    #[test]
    fn choose_agent_prefers_tag_match() {
        let temp = TempDir::new().unwrap();
        let (_config, manager) = setup_manager(&temp);

        manager.create_default_config().unwrap();
        let selected = manager
            .choose_agent(None, "Please help me debug this code path")
            .unwrap();
        assert_eq!(selected.id, "coder");
    }

    #[test]
    fn tool_policy_conversion_uses_alias_resolution() {
        let policy = AgentToolPolicy {
            allow_all: Some(false),
            allowed_tools: vec!["web_search".to_string(), "mcp:fs_read".to_string()],
            denied_tools: vec!["mcp:fs_delete".to_string()],
            require_confirmation: vec!["fetch_url".to_string()],
        };

        let custom = policy.to_custom_tool_policy();
        assert!(!custom.allow_all);
        assert!(custom.allowed_tools.contains("native_search"));
        assert!(custom.allowed_tools.contains("fs_read"));
        assert!(custom.denied_tools.contains("fs_delete"));
        assert!(custom.require_confirmation.contains("native_web_fetch"));
    }
}
