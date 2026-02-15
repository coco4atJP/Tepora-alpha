//! ExclusiveAgentManager — Manages ExecutionAgent definitions from `agents.yaml`.
//!
//! Replaces the legacy `custom_agents` section in config.yml with a standalone
//! `agents.yaml` file for agent definitions.  Provides agent selection,
//! tool-name resolution (native / `mcp:` prefix), and hot-reload support.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use tracing;

use crate::agent::policy::CustomToolPolicy;
use crate::core::config::AppPaths;
use crate::core::errors::ApiError;

// ---------------------------------------------------------------------------
// ExecutionAgent
// ---------------------------------------------------------------------------

/// A single agent definition loaded from `agents.yaml`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionAgent {
    /// Unique identifier (the YAML key).
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
}

fn default_true() -> bool {
    true
}

fn default_priority() -> i32 {
    0
}

/// Tool policy definition in agents.yaml.
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
    /// Convert to the existing `CustomToolPolicy` for compatibility.
    pub fn to_custom_tool_policy(&self) -> CustomToolPolicy {
        let allow_all = self
            .allow_all
            .unwrap_or(self.allowed_tools.is_empty());

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

// ---------------------------------------------------------------------------
// Tool name resolution
// ---------------------------------------------------------------------------

/// Resolve a tool name from agents.yaml syntax.
///
/// - `"web_search"` → native tool → `"native_search"`
/// - `"fetch_url"` → native tool → `"native_web_fetch"`  
/// - `"mcp:server_tool"` → MCP tool → `"server_tool"`
/// - `"native_search"` → pass-through
/// - anything else → pass-through
fn resolve_tool_name(raw: &str) -> String {
    let trimmed = raw.trim();

    // MCP prefix shorthand
    if let Some(mcp_name) = trimmed.strip_prefix("mcp:") {
        return mcp_name.to_string();
    }

    // Native tool aliases
    match trimmed {
        "web_search" | "search" => "native_search".to_string(),
        "fetch_url" | "fetch" | "web_fetch" => "native_web_fetch".to_string(),
        "rag_search" => "native_rag_search".to_string(),
        "rag_ingest" => "native_rag_ingest".to_string(),
        "rag_text_search" => "native_rag_text_search".to_string(),
        "rag_get_chunk" => "native_rag_get_chunk".to_string(),
        "rag_get_chunk_window" => "native_rag_get_chunk_window".to_string(),
        "rag_clear_session" => "native_rag_clear_session".to_string(),
        "rag_reindex" => "native_rag_reindex".to_string(),
        other => other.to_string(),
    }
}

// ---------------------------------------------------------------------------
// agents.yaml file format
// ---------------------------------------------------------------------------

/// Root structure of the `agents.yaml` file.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct AgentsFile {
    #[serde(default)]
    agents: HashMap<String, AgentEntry>,
}

/// Single agent definition in the YAML file.
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
}

// ---------------------------------------------------------------------------
// ExclusiveAgentManager
// ---------------------------------------------------------------------------

/// Manages `ExecutionAgent` definitions loaded from `agents.yaml`.
///
/// Designed to be stored inside `AppState` and shared via `Arc`.
#[derive(Clone)]
pub struct ExclusiveAgentManager {
    agents: Arc<RwLock<HashMap<String, ExecutionAgent>>>,
    config_path: PathBuf,
}

impl ExclusiveAgentManager {
    /// Create a new manager with the given app paths.
    pub fn new(paths: &AppPaths) -> Self {
        let config_path = paths.user_data_dir.join("config").join("agents.yaml");
        let manager = Self {
            agents: Arc::new(RwLock::new(HashMap::new())),
            config_path,
        };
        if let Err(e) = manager.reload() {
            tracing::warn!("Failed to load agents.yaml on init: {}", e);
        }
        manager
    }

    /// Create a manager with a custom path (for testing).
    pub fn with_path(path: impl Into<PathBuf>) -> Self {
        let config_path = path.into();
        let manager = Self {
            agents: Arc::new(RwLock::new(HashMap::new())),
            config_path,
        };
        if let Err(e) = manager.reload() {
            tracing::debug!("No agents.yaml found at {:?}: {}", manager.config_path, e);
        }
        manager
    }

    /// Reload agents from disk.
    pub fn reload(&self) -> Result<(), ApiError> {
        let agents = load_agents_from_file(&self.config_path)?;
        let mut guard = self
            .agents
            .write()
            .map_err(|e| ApiError::internal(format!("Lock poisoned: {e}")))?;
        *guard = agents;
        tracing::info!(
            "Loaded {} agent(s) from {:?}",
            guard.len(),
            self.config_path
        );
        Ok(())
    }

    /// Get all enabled agents.
    pub fn list_enabled(&self) -> Vec<ExecutionAgent> {
        let guard = self.agents.read().unwrap_or_else(|e| e.into_inner());
        guard
            .values()
            .filter(|a| a.enabled)
            .cloned()
            .collect()
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
    ///
    /// Priority:
    /// 1. Exact match on `requested_agent_id`
    /// 2. Tag-based matching against the user query
    /// 3. Highest priority agent
    pub fn choose_agent(
        &self,
        requested_agent_id: Option<&str>,
        user_input: &str,
    ) -> Option<ExecutionAgent> {
        let guard = self.agents.read().unwrap_or_else(|e| e.into_inner());

        // 1. Exact ID match
        if let Some(id) = requested_agent_id
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            if let Some(agent) = guard.get(id).filter(|a| a.enabled) {
                return Some(agent.clone());
            }
        }

        // Get enabled agents
        let enabled: Vec<&ExecutionAgent> = guard.values().filter(|a| a.enabled).collect();
        if enabled.is_empty() {
            return None;
        }

        // 2. Tag + description matching
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

    /// Save agent definitions back to disk.
    pub fn save(&self) -> Result<(), ApiError> {
        let guard = self.agents.read().unwrap_or_else(|e| e.into_inner());

        let mut entries = HashMap::new();
        for (id, agent) in guard.iter() {
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
                },
            );
        }

        let file = AgentsFile { agents: entries };
        let yaml = serde_yaml::to_string(&file).map_err(ApiError::internal)?;

        if let Some(parent) = self.config_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(&self.config_path, yaml).map_err(ApiError::internal)?;
        Ok(())
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

    /// Get the path to the agents.yaml file.
    pub fn config_path(&self) -> &Path {
        &self.config_path
    }

    /// Create a default agents.yaml file with example agents.
    pub fn create_default_config(&self) -> Result<(), ApiError> {
        let default_yaml = r#"# Tepora Agents Configuration
# Each agent defines a specialized execution profile with its own
# system prompt, tool policy, and priority settings.

agents:
  general:
    name: "General Assistant"
    description: "汎用アシスタント。タスクに合わせて柔軟に対応します。"
    enabled: true
    system_prompt: ""
    priority: 0
    tags: ["general", "default"]
    tool_policy:
      allow_all: true

  coder:
    name: "Code Assistant"
    description: "コーディングとソフトウェア開発に特化したアシスタント。"
    enabled: true
    system_prompt: |
      You are an expert programmer. When writing code:
      - Always include proper error handling
      - Follow best practices for the given language
      - Write clear, self-documenting code
      - Consider edge cases
    priority: 10
    tags: ["code", "programming", "development", "debug", "fix", "implement"]
    tool_policy:
      allow_all: true

  researcher:
    name: "Research Assistant"
    description: "情報収集と分析に特化したアシスタント。"
    enabled: true
    system_prompt: |
      You are a thorough researcher. When answering questions:
      - Cite your sources clearly
      - Distinguish between facts and inference
      - Present multiple perspectives when relevant
      - Use structured formatting for clarity
    priority: 5
    tags: ["research", "search", "analyze", "investigate", "study", "learn"]
    tool_policy:
      allowed_tools:
        - web_search
        - fetch_url
        - "mcp:*"
"#;
        if let Some(parent) = self.config_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(&self.config_path, default_yaml).map_err(ApiError::internal)?;
        self.reload()
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn load_agents_from_file(path: &Path) -> Result<HashMap<String, ExecutionAgent>, ApiError> {
    if !path.exists() {
        return Ok(HashMap::new());
    }

    let contents = fs::read_to_string(path).map_err(ApiError::internal)?;
    if contents.trim().is_empty() {
        return Ok(HashMap::new());
    }

    let file: AgentsFile = serde_yaml::from_str(&contents).map_err(|e| {
        ApiError::internal(format!("Failed to parse agents.yaml: {e}"))
    })?;

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
            },
        );
    }

    Ok(agents)
}

fn score_agent_tags(agent: &ExecutionAgent, query: &str) -> i32 {
    let mut score = 0i32;

    // Check tags
    for tag in &agent.tags {
        if query.contains(&tag.to_lowercase()) {
            score += 5;
        }
    }

    // Check name and description words
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn test_agents_yaml() -> String {
        r#"
agents:
  test_general:
    name: "Test General"
    description: "A general test agent"
    enabled: true
    priority: 0
    tags: ["general"]
    tool_policy:
      allow_all: true

  test_coder:
    name: "Test Coder"
    description: "A coding test agent"
    enabled: true
    priority: 10
    tags: ["code", "programming"]
    tool_policy:
      allowed_tools:
        - web_search
        - "mcp:filesystem_read_file"
      denied_tools:
        - "mcp:filesystem_delete"

  test_disabled:
    name: "Disabled Agent"
    description: "Should not appear in enabled list"
    enabled: false
    priority: 100
"#
        .to_string()
    }

    #[test]
    fn test_load_agents() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(test_agents_yaml().as_bytes()).unwrap();

        let manager = ExclusiveAgentManager::with_path(file.path());

        let all = manager.list_all();
        assert_eq!(all.len(), 3);

        let enabled = manager.list_enabled();
        assert_eq!(enabled.len(), 2);
    }

    #[test]
    fn test_get_agent() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(test_agents_yaml().as_bytes()).unwrap();

        let manager = ExclusiveAgentManager::with_path(file.path());

        let agent = manager.get("test_coder");
        assert!(agent.is_some());
        let agent = agent.unwrap();
        assert_eq!(agent.name, "Test Coder");
        assert_eq!(agent.priority, 10);
    }

    #[test]
    fn test_choose_agent_by_id() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(test_agents_yaml().as_bytes()).unwrap();

        let manager = ExclusiveAgentManager::with_path(file.path());
        let chosen = manager.choose_agent(Some("test_coder"), "");
        assert!(chosen.is_some());
        assert_eq!(chosen.unwrap().id, "test_coder");
    }

    #[test]
    fn test_choose_agent_by_tag_match() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(test_agents_yaml().as_bytes()).unwrap();

        let manager = ExclusiveAgentManager::with_path(file.path());
        let chosen = manager.choose_agent(None, "Please help me write some code");
        assert!(chosen.is_some());
        assert_eq!(chosen.unwrap().id, "test_coder");
    }

    #[test]
    fn test_choose_agent_by_priority() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(test_agents_yaml().as_bytes()).unwrap();

        let manager = ExclusiveAgentManager::with_path(file.path());
        // No tags match, should pick highest priority enabled agent
        let chosen = manager.choose_agent(None, "do something random xyz");
        assert!(chosen.is_some());
        assert_eq!(chosen.unwrap().id, "test_coder"); // priority 10 > 0
    }

    #[test]
    fn test_tool_name_resolution() {
        assert_eq!(resolve_tool_name("web_search"), "native_search");
        assert_eq!(resolve_tool_name("search"), "native_search");
        assert_eq!(resolve_tool_name("fetch_url"), "native_web_fetch");
        assert_eq!(resolve_tool_name("rag_search"), "native_rag_search");
        assert_eq!(resolve_tool_name("rag_ingest"), "native_rag_ingest");
        assert_eq!(resolve_tool_name("rag_text_search"), "native_rag_text_search");
        assert_eq!(resolve_tool_name("rag_get_chunk"), "native_rag_get_chunk");
        assert_eq!(
            resolve_tool_name("rag_get_chunk_window"),
            "native_rag_get_chunk_window"
        );
        assert_eq!(resolve_tool_name("rag_clear_session"), "native_rag_clear_session");
        assert_eq!(resolve_tool_name("rag_reindex"), "native_rag_reindex");
        assert_eq!(resolve_tool_name("mcp:server_tool"), "server_tool");
        assert_eq!(resolve_tool_name("native_search"), "native_search");
        assert_eq!(resolve_tool_name("custom_tool"), "custom_tool");
    }

    #[test]
    fn test_tool_policy_conversion() {
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

    #[test]
    fn test_empty_file() {
        let manager = ExclusiveAgentManager::with_path("/nonexistent/path/agents.yaml");
        assert!(manager.list_all().is_empty());
        assert!(manager.list_enabled().is_empty());
    }
}
