use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agent::policy::CustomToolPolicy;
use crate::agent::skill_registry::AgentSkillPackage;
use crate::core::native_tools::{resolve_tool_alias, NATIVE_TOOLS};
use crate::llm::types::StructuredResponseSpec;
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentDecisionPayload {
    #[serde(rename = "type")]
    pub action_type: String,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub tool_args: Option<Value>,
    #[serde(default)]
    pub content: Option<String>,
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

    let mcp_tools = state.integration.mcp.list_tools().await;
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
        .ai()
        .skill_registry
        .choose_skill(requested_agent_id, user_input)
        .and_then(|skill| state.ai().skill_registry.get(&skill.id))
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
        .ai()
        .skill_registry
        .get(selected_agent_id)
        .map(|skill| map_selected_agent(state, skill))
}

fn map_selected_agent(state: &AppState, skill: AgentSkillPackage) -> SelectedAgentRuntime {
    let assigned_model_id = state
        .ai()
        .models
        .resolve_assignment_model_id(&format!("agent:{}", skill.summary.id))
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
    _state: &AppState,
    config: &Value,
    _selected_agent: Option<&SelectedAgentRuntime>,
) -> Value {
    config.clone()
}

pub fn resolve_execution_model_id(
    state: &AppState,
    config: &Value,
    selected_agent: Option<&SelectedAgentRuntime>,
) -> String {
    let active_character = config
        .get("active_character")
        .or_else(|| config.get("active_agent_profile"))
        .and_then(|v| v.as_str());

    selected_agent
        .and_then(|agent| agent.assigned_model_id.clone())
        .or_else(|| {
            let assignment_key = active_character
                .map(|value| format!("character:{value}"))
                .unwrap_or_else(|| "character".to_string());
            state
                .ai()
                .models
                .resolve_assignment_model_id(&assignment_key)
                .ok()
                .flatten()
        })
        .unwrap_or_else(|| "default".to_string())
}

pub fn agent_decision_structured_spec() -> StructuredResponseSpec {
    StructuredResponseSpec {
        name: "agent_decision".to_string(),
        description: Some("Structured agent decision payload".to_string()),
        schema: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "type": {
                    "type": "string",
                    "enum": ["tool_call", "final"]
                },
                "tool_name": {
                    "type": ["string", "null"]
                },
                "tool_args": {
                    "type": ["object", "null"],
                    "additionalProperties": true
                },
                "content": {
                    "type": ["string", "null"]
                }
            },
            "required": ["type"],
            "allOf": [
                {
                    "if": {
                        "properties": {
                            "type": { "const": "tool_call" }
                        }
                    },
                    "then": {
                        "required": ["tool_name", "tool_args"]
                    }
                },
                {
                    "if": {
                        "properties": {
                            "type": { "const": "final" }
                        }
                    },
                    "then": {
                        "required": ["content"]
                    }
                }
            ]
        }),
    }
}

pub fn structured_payload_to_agent_decision(
    payload: AgentDecisionPayload,
) -> Result<AgentDecision, String> {
    match payload.action_type.as_str() {
        "tool_call" => {
            let name = payload
                .tool_name
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "tool_call requires tool_name".to_string())?;
            let args = payload
                .tool_args
                .unwrap_or_else(|| Value::Object(Default::default()));
            if !args.is_object() {
                return Err("tool_call requires tool_args to be an object".to_string());
            }
            Ok(AgentDecision::ToolCall { name, args })
        }
        "final" => Ok(AgentDecision::Final(payload.content.unwrap_or_default())),
        other => Err(format!("unsupported agent decision type: {other}")),
    }
}

pub fn format_attachments(config: &Value, attachments: &[Value]) -> Option<String> {
    if attachments.is_empty() {
        return None;
    }

    let max_attachments = config
        .get("agent")
        .and_then(|v| v.get("max_attachments"))
        .and_then(|v| v.as_u64())
        .unwrap_or(5)
        .clamp(1, 100) as usize;
    let preview_chars = config
        .get("agent")
        .and_then(|v| v.get("attachment_preview_chars"))
        .and_then(|v| v.as_u64())
        .unwrap_or(500)
        .clamp(1, 1_000_000) as usize;

    let mut blocks = Vec::new();
    for attachment in attachments.iter().take(max_attachments) {
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
            let preview = truncate_attachment_preview(content, preview_chars);
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

fn truncate_attachment_preview(content: &str, preview_chars: usize) -> String {
    let mut chars = content.chars();
    let preview: String = chars.by_ref().take(preview_chars).collect();
    if chars.next().is_some() {
        format!("{}... (truncated)", preview)
    } else {
        content.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn truncate_attachment_preview_handles_ascii() {
        let preview = truncate_attachment_preview("abcdefghijklmnopqrstuvwxyz", 5);
        assert_eq!(preview, "abcde... (truncated)");
    }

    #[test]
    fn truncate_attachment_preview_handles_multibyte_text() {
        let preview = truncate_attachment_preview("これは日本語の長い添付テキストです", 6);
        assert_eq!(preview, "これは日本語... (truncated)");
    }

    #[test]
    fn truncate_attachment_preview_handles_emoji() {
        let preview = truncate_attachment_preview("🙂🙂🙂🙂🙂🙂", 4);
        assert_eq!(preview, "🙂🙂🙂🙂... (truncated)");
    }

    #[test]
    fn format_attachments_respects_max_attachment_limit() {
        let config = json!({
            "agent": {
                "max_attachments": 2,
                "attachment_preview_chars": 10
            }
        });
        let attachments = vec![
            json!({ "name": "a", "path": "/tmp/a", "content": "one" }),
            json!({ "name": "b", "path": "/tmp/b", "content": "two" }),
            json!({ "name": "c", "path": "/tmp/c", "content": "three" }),
        ];

        let formatted = format_attachments(&config, &attachments).unwrap();
        assert_eq!(formatted.matches("Attachment: ").count(), 2);
        assert!(formatted.contains("Attachment: a"));
        assert!(formatted.contains("Attachment: b"));
        assert!(!formatted.contains("Attachment: c"));
    }
}
