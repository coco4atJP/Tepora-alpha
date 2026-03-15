use std::collections::HashSet;

use serde::Deserialize;
use serde_json::Value;

use crate::agent::policy::CustomToolPolicy;
use crate::agent::skill_registry::AgentSkillPackage;
use crate::core::native_tools::{resolve_tool_alias, NATIVE_TOOLS};
use crate::state::AppState;

#[derive(Debug, Clone)]
pub struct SelectedAgentRuntime {
    pub id: String,
    pub name: String,
    pub controller_summary: String,
    pub skill_body: String,
    pub resource_prompt: Option<String>,
    pub assigned_model_id: Option<String>,
    pub tool_policy: CustomToolPolicy,
}

#[derive(Debug, Clone)]
pub enum AgentDecision {
    Final(String),
    ToolCall { name: String, args: Value },
}

#[derive(Debug, Clone, Default, Deserialize)]
struct SkillToolPolicy {
    #[serde(default)]
    allow_all: Option<bool>,
    #[serde(default)]
    allowed_tools: Vec<String>,
    #[serde(default)]
    denied_tools: Vec<String>,
    #[serde(default)]
    require_confirmation: Vec<String>,
}

pub fn approval_timeout(config: &Value) -> u64 {
    config
        .get("app")
        .and_then(|v| v.get("tool_approval_timeout"))
        .and_then(|v| v.as_u64())
        .unwrap_or(300)
}

pub async fn build_allowed_tool_list(
    state: &AppState,
    active_policy: &CustomToolPolicy,
) -> (Vec<String>, HashSet<String>) {
    let mut tool_list: Vec<String> = NATIVE_TOOLS.iter().map(|t| t.name.to_string()).collect();

    let mcp_tools = state.mcp.list_tools().await;
    let mut mcp_tool_set = HashSet::new();
    for tool in mcp_tools {
        mcp_tool_set.insert(tool.name.clone());
        tool_list.push(tool.name);
    }

    tool_list.retain(|tool_name| active_policy.is_tool_allowed(tool_name));
    tool_list.sort();
    tool_list.dedup();

    (tool_list, mcp_tool_set)
}

pub fn choose_agent_from_manager(
    state: &AppState,
    requested_agent_id: Option<&str>,
    user_input: &str,
) -> Option<SelectedAgentRuntime> {
    state
        .skill_registry
        .choose_skill(requested_agent_id, user_input)
        .and_then(|skill| state.skill_registry.get(&skill.id))
        .map(|skill| map_selected_agent(state, skill))
}

pub fn resolve_selected_agent(
    state: &AppState,
    selected_agent_id: Option<&str>,
) -> Option<SelectedAgentRuntime> {
    let selected_agent_id = selected_agent_id
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    state
        .skill_registry
        .get(selected_agent_id)
        .map(|skill| map_selected_agent(state, skill))
}

fn map_selected_agent(state: &AppState, skill: AgentSkillPackage) -> SelectedAgentRuntime {
    let assigned_model_id = state
        .models
        .resolve_agent_model_id(Some(&skill.summary.id))
        .ok()
        .flatten();

    SelectedAgentRuntime {
        id: skill.summary.id.clone(),
        name: skill.summary.name.clone(),
        controller_summary: skill.summary.description.clone(),
        skill_body: skill.skill_body.clone(),
        resource_prompt: crate::agent::skill_registry::build_skill_resource_prompt(&skill),
        assigned_model_id,
        tool_policy: extract_tool_policy(&skill),
    }
}

fn extract_tool_policy(skill: &AgentSkillPackage) -> CustomToolPolicy {
    let candidate = skill
        .summary
        .metadata
        .get("tool_policy")
        .cloned()
        .or_else(|| {
            skill
                .summary
                .metadata
                .get("metadata")
                .and_then(|value| value.get("tool_policy"))
                .cloned()
        });

    let Some(candidate) = candidate else {
        return CustomToolPolicy::allow_all_policy();
    };
    let Ok(policy) = serde_json::from_value::<SkillToolPolicy>(candidate) else {
        return CustomToolPolicy::allow_all_policy();
    };

    CustomToolPolicy {
        allow_all: policy.allow_all.unwrap_or(policy.allowed_tools.is_empty()),
        allowed_tools: policy
            .allowed_tools
            .iter()
            .map(|tool| resolve_tool_alias(tool))
            .collect(),
        denied_tools: policy
            .denied_tools
            .iter()
            .map(|tool| resolve_tool_alias(tool))
            .collect(),
        require_confirmation: policy
            .require_confirmation
            .iter()
            .map(|tool| resolve_tool_alias(tool))
            .collect(),
    }
}

pub fn build_agent_chat_config(
    state: &AppState,
    config: &Value,
    selected_agent: Option<&SelectedAgentRuntime>,
) -> Value {
    let mut overridden = config.clone();

    if let Some(model_id) = selected_agent
        .and_then(|agent| agent.assigned_model_id.as_deref())
        .filter(|value| !value.is_empty())
    {
        if let Ok(Some(model_entry)) = state.models.get_model(model_id) {
            if let Some(root) = overridden.as_object_mut() {
                let models_gguf = root
                    .entry("models_gguf".to_string())
                    .or_insert_with(|| Value::Object(Default::default()));
                if let Some(models_obj) = models_gguf.as_object_mut() {
                    let text_model = models_obj
                        .entry("text_model".to_string())
                        .or_insert_with(|| Value::Object(Default::default()));
                    if !text_model.is_object() {
                        *text_model = Value::Object(Default::default());
                    }
                    if let Some(text_model_obj) = text_model.as_object_mut() {
                        text_model_obj
                            .insert("path".to_string(), Value::String(model_entry.file_path));
                    }
                }
            }
        }
    }

    overridden
}

pub fn resolve_execution_model_id(
    state: &AppState,
    config: &Value,
    selected_agent: Option<&SelectedAgentRuntime>,
) -> String {
    let active_character = config.get("active_agent_profile").and_then(|v| v.as_str());

    selected_agent
        .and_then(|agent| agent.assigned_model_id.clone())
        .or_else(|| {
            state
                .models
                .resolve_character_model_id(active_character)
                .ok()
                .flatten()
        })
        .unwrap_or_else(|| "default".to_string())
}

pub fn parse_agent_decision(text: &str) -> AgentDecision {
    if let Some(json_value) = parse_json_from_text(text) {
        if let Some(decision) = parse_decision_from_value(&json_value) {
            return decision;
        }
    }
    AgentDecision::Final(text.trim().to_string())
}

fn parse_json_from_text(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Some(value);
    }

    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<Value>(&trimmed[start..=end]).ok()
}

fn parse_decision_from_value(value: &Value) -> Option<AgentDecision> {
    let action_type = value
        .get("type")
        .or_else(|| value.get("action"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if action_type == "tool_call" {
        let name = value
            .get("tool_name")
            .or_else(|| value.get("name"))
            .or_else(|| value.get("tool"))
            .and_then(|v| v.as_str())?;
        let args = value
            .get("tool_args")
            .or_else(|| value.get("args"))
            .cloned()
            .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
        return Some(AgentDecision::ToolCall {
            name: name.to_string(),
            args,
        });
    }

    if action_type == "final" {
        let content = value
            .get("content")
            .or_else(|| value.get("message"))
            .or_else(|| value.get("response"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        return Some(AgentDecision::Final(content));
    }

    None
}

pub fn format_attachments(attachments: &[Value]) -> Option<String> {
    if attachments.is_empty() {
        return None;
    }

    let mut blocks = Vec::new();
    for attachment in attachments.iter().take(5) {
        if let Some(obj) = attachment.as_object() {
            let name = obj
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("attachment");
            let path = obj
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("(path unavailable)");
            let content = obj.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let preview = if content.len() > 500 {
                format!("{}... (truncated)", &content[..500])
            } else {
                content.to_string()
            };
            blocks.push(format!(
                "Attachment: {}\\nPath: {}\\nPreview: {}",
                name, path, preview
            ));
        }
    }

    if blocks.is_empty() {
        return None;
    }

    Some(format!(
        "User provided attachments. Use them if relevant:\\n{}",
        blocks.join("\n---\n")
    ))
}
