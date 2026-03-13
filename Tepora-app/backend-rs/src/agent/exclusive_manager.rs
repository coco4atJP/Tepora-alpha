//! ExclusiveAgentManager - Manages file-based ExecutionAgent packages.
//!
//! Agent definitions are persisted under
//! `<user_data_dir>/execution_agents/<id>/agent.toml` + `SKILL.md`.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use tracing;

use crate::agent::policy::CustomToolPolicy;
use crate::core::config::{AppPaths, ConfigService};
use crate::core::errors::ApiError;
use crate::core::native_tools::resolve_tool_alias;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionAgent {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub controller_summary: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub model_config_name: Option<String>,
    #[serde(default)]
    pub tool_policy: AgentToolPolicy,
    #[serde(default = "default_priority")]
    pub priority: i32,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub icon: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_priority() -> i32 {
    0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AgentManifest {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    controller_summary: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentToolPolicy {
    #[serde(default)]
    pub allow_all: Option<bool>,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub denied_tools: Vec<String>,
    #[serde(default)]
    pub require_confirmation: Vec<String>,
}

impl AgentToolPolicy {
    pub fn to_custom_tool_policy(&self) -> CustomToolPolicy {
        let allow_all = self.allow_all.unwrap_or(self.allowed_tools.is_empty());

        CustomToolPolicy {
            allow_all,
            allowed_tools: self
                .allowed_tools
                .iter()
                .map(|tool| resolve_tool_alias(tool))
                .collect(),
            denied_tools: self
                .denied_tools
                .iter()
                .map(|tool| resolve_tool_alias(tool))
                .collect(),
            require_confirmation: self
                .require_confirmation
                .iter()
                .map(|tool| resolve_tool_alias(tool))
                .collect(),
        }
    }
}

#[derive(Clone)]
pub struct ExclusiveAgentManager {
    agents: Arc<RwLock<HashMap<String, ExecutionAgent>>>,
    packages_dir: std::path::PathBuf,
}

impl ExclusiveAgentManager {
    pub fn new(paths: &AppPaths, _config_service: ConfigService) -> Self {
        let manager = Self {
            agents: Arc::new(RwLock::new(HashMap::new())),
            packages_dir: paths.user_data_dir.join("execution_agents"),
        };

        if let Err(err) = manager.reload() {
            tracing::warn!("Failed to load execution agent packages on init: {}", err);
        }

        manager
    }

    pub fn reload(&self) -> Result<(), ApiError> {
        fs::create_dir_all(&self.packages_dir).map_err(ApiError::internal)?;
        let agents = load_agents_from_packages(&self.packages_dir)?;
        let mut guard = self
            .agents
            .write()
            .map_err(|e| ApiError::internal(format!("Lock poisoned: {e}")))?;
        *guard = agents;
        Ok(())
    }

    pub fn list_enabled(&self) -> Vec<ExecutionAgent> {
        let guard = self.agents.read().unwrap_or_else(|e| e.into_inner());
        guard
            .values()
            .filter(|agent| agent.enabled)
            .cloned()
            .collect()
    }

    pub fn list_all(&self) -> Vec<ExecutionAgent> {
        let guard = self.agents.read().unwrap_or_else(|e| e.into_inner());
        guard.values().cloned().collect()
    }

    pub fn get(&self, agent_id: &str) -> Option<ExecutionAgent> {
        let guard = self.agents.read().unwrap_or_else(|e| e.into_inner());
        guard.get(agent_id).cloned()
    }

    pub fn choose_agent(
        &self,
        requested_agent_id: Option<&str>,
        user_input: &str,
    ) -> Option<ExecutionAgent> {
        let guard = self.agents.read().unwrap_or_else(|e| e.into_inner());

        if let Some(id) = requested_agent_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if let Some(agent) = guard.get(id).filter(|agent| agent.enabled) {
                return Some(agent.clone());
            }
        }

        let enabled: Vec<&ExecutionAgent> = guard.values().filter(|agent| agent.enabled).collect();
        if enabled.is_empty() {
            return None;
        }

        let query = user_input.to_lowercase();
        let mut ranked: Vec<(&ExecutionAgent, i32)> = enabled
            .into_iter()
            .map(|agent| (agent, agent.priority + score_agent_tags(agent, &query)))
            .collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.id.cmp(&b.0.id)));
        ranked.into_iter().next().map(|(agent, _)| agent.clone())
    }

    pub fn save(&self) -> Result<(), ApiError> {
        let guard = self.agents.read().unwrap_or_else(|e| e.into_inner());
        self.persist_agents_map(&guard)
    }

    pub fn upsert(&self, agent: ExecutionAgent) -> Result<(), ApiError> {
        let mut guard = self
            .agents
            .write()
            .map_err(|e| ApiError::internal(format!("Lock poisoned: {e}")))?;
        guard.insert(agent.id.clone(), agent);
        drop(guard);
        self.save()
    }

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

    pub fn replace_all(&self, agents: Vec<ExecutionAgent>) -> Result<(), ApiError> {
        let replacement = agents
            .into_iter()
            .map(|agent| (agent.id.clone(), agent))
            .collect::<HashMap<_, _>>();
        self.persist_agents_map(&replacement)?;
        let mut guard = self
            .agents
            .write()
            .map_err(|e| ApiError::internal(format!("Lock poisoned: {e}")))?;
        *guard = replacement;
        Ok(())
    }

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
        fs::create_dir_all(&self.packages_dir).map_err(ApiError::internal)?;
        sync_agent_packages(&self.packages_dir, agents)
    }
}

fn load_agents_from_packages(dir: &Path) -> Result<HashMap<String, ExecutionAgent>, ApiError> {
    if !dir.exists() {
        return Ok(HashMap::new());
    }

    let mut agents = HashMap::new();
    for entry in fs::read_dir(dir).map_err(ApiError::internal)? {
        let entry = entry.map_err(ApiError::internal)?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Some(agent) = load_agent_from_package(&path)? {
            agents.insert(agent.id.clone(), agent);
        }
    }

    Ok(agents)
}

fn load_agent_from_package(dir: &Path) -> Result<Option<ExecutionAgent>, ApiError> {
    let manifest_path = dir.join("agent.toml");
    if !manifest_path.exists() {
        return Ok(None);
    }

    let manifest_text = fs::read_to_string(&manifest_path).map_err(ApiError::internal)?;
    let manifest: AgentManifest = toml::from_str(&manifest_text).map_err(|e| {
        ApiError::internal(format!(
            "Failed to parse agent manifest {}: {e}",
            manifest_path.display()
        ))
    })?;

    let skill_path = dir.join("SKILL.md");
    let system_prompt = if skill_path.exists() {
        fs::read_to_string(&skill_path).map_err(ApiError::internal)?
    } else {
        String::new()
    };

    Ok(Some(ExecutionAgent {
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        enabled: manifest.enabled,
        controller_summary: manifest.controller_summary,
        system_prompt,
        model_config_name: manifest.model_config_name,
        tool_policy: manifest.tool_policy,
        priority: manifest.priority,
        tags: manifest.tags,
        icon: manifest.icon,
    }))
}

fn sync_agent_packages(
    dir: &Path,
    agents: &HashMap<String, ExecutionAgent>,
) -> Result<(), ApiError> {
    fs::create_dir_all(dir).map_err(ApiError::internal)?;

    let existing_ids = fs::read_dir(dir)
        .map_err(ApiError::internal)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect::<std::collections::HashSet<_>>();

    for agent in agents.values() {
        write_agent_package(dir, agent)?;
    }

    for stale_id in existing_ids {
        if !agents.contains_key(&stale_id) {
            let stale_dir = dir.join(&stale_id);
            if stale_dir.exists() {
                fs::remove_dir_all(&stale_dir).map_err(ApiError::internal)?;
            }
        }
    }

    Ok(())
}

fn write_agent_package(dir: &Path, agent: &ExecutionAgent) -> Result<(), ApiError> {
    let agent_dir = dir.join(&agent.id);
    fs::create_dir_all(&agent_dir).map_err(ApiError::internal)?;

    let manifest = AgentManifest {
        id: agent.id.clone(),
        name: agent.name.clone(),
        description: agent.description.clone(),
        enabled: agent.enabled,
        controller_summary: agent.controller_summary.clone(),
        model_config_name: agent.model_config_name.clone(),
        tool_policy: agent.tool_policy.clone(),
        priority: agent.priority,
        tags: agent.tags.clone(),
        icon: agent.icon.clone(),
    };

    let manifest_text = toml::to_string_pretty(&manifest)
        .map_err(|e| ApiError::internal(format!("Failed to serialize agent manifest: {e}")))?;
    fs::write(agent_dir.join("agent.toml"), manifest_text).map_err(ApiError::internal)?;
    fs::write(agent_dir.join("SKILL.md"), agent.system_prompt.as_bytes())
        .map_err(ApiError::internal)?;
    Ok(())
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
        .filter(|token| token.len() >= 3)
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
            controller_summary: "General-purpose helper for common desktop tasks.".to_string(),
            system_prompt: String::new(),
            model_config_name: None,
            tool_policy: AgentToolPolicy {
                allow_all: Some(true),
                ..Default::default()
            },
            priority: 0,
            tags: vec!["general".to_string(), "default".to_string()],
            icon: Some("[bot]".to_string()),
        },
    );

    agents.insert(
        "coder".to_string(),
        ExecutionAgent {
            id: "coder".to_string(),
            name: "Code Assistant".to_string(),
            description: "Specialized in software engineering tasks.".to_string(),
            enabled: true,
            controller_summary: "Use for implementation, debugging, refactoring, and code review tasks.".to_string(),
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
            icon: Some("[code]".to_string()),
        },
    );

    agents.insert(
        "gui_designer".to_string(),
        ExecutionAgent {
            id: "gui_designer".to_string(),
            name: "GUI Designer".to_string(),
            description: "Specialized in frontend UX, visual hierarchy, and implementation-ready interface design.".to_string(),
            enabled: true,
            controller_summary: "Use for GUI polish, layout redesign, interaction improvements, component styling, and frontend implementation guidance.".to_string(),
            system_prompt: "You are Tepora's GUI and frontend design specialist. Optimize for implementation-ready interface quality, not vague design advice. Work from the existing product structure and improve hierarchy, spacing, typography, state design, interaction clarity, and visual consistency. Prefer concrete component-level changes, realistic layout refinements, and strong rationale tied to usability. Avoid generic praise, avoid abstract moodboard language, and avoid redesigns that ignore existing constraints. When proposing UI changes, specify user-facing impact, affected components, edge states, responsive behavior, and implementation notes that another frontend engineer can apply directly.".to_string(),
            model_config_name: None,
            tool_policy: AgentToolPolicy {
                allow_all: Some(true),
                ..Default::default()
            },
            priority: 7,
            tags: vec![
                "gui".to_string(),
                "ui".to_string(),
                "ux".to_string(),
                "frontend".to_string(),
                "design".to_string(),
                "layout".to_string(),
            ],
            icon: Some("[ui]".to_string()),
        },
    );

    agents.insert(
        "researcher".to_string(),
        ExecutionAgent {
            id: "researcher".to_string(),
            name: "Research Assistant".to_string(),
            description: "Specialized in information gathering and analysis.".to_string(),
            enabled: true,
            controller_summary: "Use for search-heavy tasks, information gathering, and evidence-based summaries.".to_string(),
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
            icon: Some("[research]".to_string()),
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

    fn setup_manager(temp: &TempDir) -> ExclusiveAgentManager {
        let paths = make_paths(temp);
        let config = ConfigService::new(paths.clone());
        ExclusiveAgentManager::new(paths.as_ref(), config)
    }

    #[test]
    fn loads_agents_from_packages() {
        let temp = TempDir::new().unwrap();
        let manager = setup_manager(&temp);
        let agent_dir = temp
            .path()
            .join("data")
            .join("execution_agents")
            .join("coder");
        fs::create_dir_all(&agent_dir).unwrap();
        fs::write(
            agent_dir.join("agent.toml"),
            "id = \"coder\"\nname = \"Coder\"\nenabled = true\ncontroller_summary = \"code help\"\n",
        )
        .unwrap();
        fs::write(agent_dir.join("SKILL.md"), "full skill").unwrap();

        manager.reload().unwrap();
        let agents = manager.list_all();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "coder");
        assert_eq!(agents[0].system_prompt, "full skill");
    }

    #[test]
    fn upsert_and_delete_are_persisted_to_packages() {
        let temp = TempDir::new().unwrap();
        let manager = setup_manager(&temp);

        manager
            .upsert(ExecutionAgent {
                id: "alpha".to_string(),
                name: "Alpha".to_string(),
                description: "desc".to_string(),
                enabled: true,
                controller_summary: "summary".to_string(),
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

        let alpha_dir = temp
            .path()
            .join("data")
            .join("execution_agents")
            .join("alpha");
        assert!(alpha_dir.join("agent.toml").exists());
        assert!(alpha_dir.join("SKILL.md").exists());

        assert!(manager.delete("alpha").unwrap());
        assert!(!alpha_dir.exists());
    }

    #[test]
    fn choose_agent_prefers_tag_match() {
        let temp = TempDir::new().unwrap();
        let manager = setup_manager(&temp);

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
