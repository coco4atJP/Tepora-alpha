use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket};
use futures_util::stream::SplitSink;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::agent::policy::CustomToolPolicy;
use crate::core::errors::ApiError;
use crate::state::AppState;

#[derive(Debug, Clone)]
pub struct SelectedAgentRuntime {
    pub id: String,
    pub name: String,
    pub system_prompt: String,
    pub model_config_name: Option<String>,
    pub tool_policy: CustomToolPolicy,
}

#[derive(Debug, Clone)]
pub enum AgentDecision {
    Final(String),
    ToolCall { name: String, args: Value },
}

pub async fn build_allowed_tool_list(
    state: &AppState,
    active_policy: &CustomToolPolicy,
) -> (Vec<String>, HashSet<String>) {
    let mut tool_list = vec![
        "native_web_fetch".to_string(),
        "native_search".to_string(),
        "native_rag_search".to_string(),
        "native_rag_ingest".to_string(),
        "native_rag_text_search".to_string(),
        "native_rag_get_chunk".to_string(),
        "native_rag_get_chunk_window".to_string(),
        "native_rag_clear_session".to_string(),
        "native_rag_reindex".to_string(),
    ];

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
        .exclusive_agents
        .choose_agent(requested_agent_id, user_input)
        .map(map_selected_agent)
}

pub fn resolve_selected_agent(
    state: &AppState,
    selected_agent_id: Option<&str>,
) -> Option<SelectedAgentRuntime> {
    let selected_agent_id = selected_agent_id
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    state
        .exclusive_agents
        .get(selected_agent_id)
        .map(map_selected_agent)
}

fn map_selected_agent(agent: crate::agent::exclusive_manager::ExecutionAgent) -> SelectedAgentRuntime {
    SelectedAgentRuntime {
        id: agent.id,
        name: agent.name,
        system_prompt: agent.system_prompt,
        model_config_name: agent.model_config_name,
        tool_policy: agent.tool_policy.to_custom_tool_policy(),
    }
}

pub fn build_agent_chat_config(config: &Value, selected_agent: Option<&SelectedAgentRuntime>) -> Value {
    let mut overridden = config.clone();
    let Some(model_key) = selected_agent
        .and_then(|agent| agent.model_config_name.as_deref())
        .filter(|value| !value.is_empty())
    else {
        return overridden;
    };

    let model_entry = config
        .get("models_gguf")
        .and_then(|v| v.get(model_key))
        .cloned();
    let Some(model_entry) = model_entry else {
        return overridden;
    };

    if let Some(root) = overridden.as_object_mut() {
        let models_gguf = root
            .entry("models_gguf".to_string())
            .or_insert_with(|| Value::Object(Default::default()));
        if let Some(models_obj) = models_gguf.as_object_mut() {
            models_obj.insert("text_model".to_string(), model_entry);
        }
    }

    overridden
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

pub async fn send_activity(
    sender: &mut SplitSink<WebSocket, Message>,
    id: &str,
    status: &str,
    message: &str,
    agent_name: &str,
) -> Result<(), ApiError> {
    crate::server::ws::handler::send_json(
        sender,
        json!({
            "type": "activity",
            "data": {
                "id": id,
                "status": status,
                "message": message,
                "agentName": agent_name,
            }
        }),
    )
    .await
}

pub async fn request_tool_approval(
    sender: &mut SplitSink<WebSocket, Message>,
    pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
    tool_name: &str,
    tool_args: &Value,
    timeout_secs: u64,
) -> Result<bool, ApiError> {
    let request_id = Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();

    {
        let mut map = pending.lock().map_err(ApiError::internal)?;
        map.insert(request_id.clone(), tx);
    }

    let payload = json!({
        "type": "tool_confirmation_request",
        "data": {
            "requestId": request_id,
            "toolName": tool_name,
            "toolArgs": if tool_args.is_object() { tool_args.clone() } else { json!({ "input": tool_args }) },
            "description": format!("Tool '{}' requires your approval to execute.", tool_name),
        }
    });
    crate::server::ws::handler::send_json(sender, payload).await?;

    let approval = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx)
        .await
        .unwrap_or(Ok(false))
        .unwrap_or(false);

    if let Ok(mut map) = pending.lock() {
        map.remove(&request_id);
    }

    Ok(approval)
}

pub fn approval_timeout(config: &Value) -> u64 {
    config
        .get("app")
        .and_then(|v| v.get("tool_approval_timeout"))
        .and_then(|v| v.as_u64())
        .unwrap_or(300)
}
