use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use axum::extract::ws::{Message, WebSocket};
use futures_util::stream::SplitSink;
use futures_util::SinkExt;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::state::AppState;
use crate::llm::ChatMessage;
use crate::models::types::ModelRuntimeConfig;
use crate::core::errors::ApiError;
use crate::tools::execute_tool;
use super::modes::RequestedAgentMode;
use super::policy::CustomToolPolicy;
use super::instructions::build_agent_instructions;
use super::planner::{generate_execution_plan, requires_fast_mode_planning};

#[derive(Debug, Clone)]
pub struct CustomAgentRuntime {
    pub id: String,
    pub name: String,
    pub system_prompt: String,
    pub model_config_name: Option<String>,
    pub tool_policy: CustomToolPolicy,
}

enum AgentDecision {
    Final(String),
    ToolCall { name: String, args: Value },
}

#[allow(clippy::too_many_arguments)]
pub async fn run_agent_mode(
    state: &AppState,
    config: &Value,
    session_id: &str,
    mut messages: Vec<ChatMessage>,
    user_input: &str,
    attachments: &[Value],
    thinking_mode: bool,
    requested_agent_id: Option<&str>,
    requested_agent_mode: Option<&str>,
    sender: &mut SplitSink<WebSocket, Message>,
    pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
    approved_mcp_tools: Arc<Mutex<HashSet<String>>>,
) -> Result<String, ApiError> {
    let requested_mode = RequestedAgentMode::parse(requested_agent_mode);
    let selected_agent = choose_agent_from_manager(state, requested_agent_id, user_input);

    if matches!(requested_mode, RequestedAgentMode::Direct) {
        if let Some(requested) = requested_agent_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let enabled = state
                .exclusive_agents
                .get(requested)
                .map(|agent| agent.enabled)
                .unwrap_or(false);
            if !enabled {
                return Err(ApiError::BadRequest(format!(
                    "Requested agent '{}' is not available or not enabled",
                    requested
                )));
            }
        }
    }

    let selected_agent_name = selected_agent
        .as_ref()
        .map(|a| a.name.clone())
        .unwrap_or_else(|| "Default Agent".to_string());

    let route_requires_planning = matches!(requested_mode, RequestedAgentMode::High)
        || (matches!(requested_mode, RequestedAgentMode::Low)
            && requires_fast_mode_planning(user_input));

    let route_label = if route_requires_planning {
        "High/Complex (Planning Enabled)"
    } else {
        "Fast/Direct (Planning Disabled)"
    };

    send_activity(
        sender,
        "supervisor",
        "processing",
        "Evaluating request and selecting execution route",
        "Supervisor",
    )
    .await?;

    let routing_message = format!(
        "Mode={}, route={}, agent={}",
        requested_mode.as_str(),
        route_label,
        selected_agent_name
    );
    send_activity(sender, "supervisor", "done", &routing_message, "Supervisor").await?;

    let max_steps = config
        .get("app")
        .and_then(|v| v.get("graph_recursion_limit"))
        .and_then(|v| v.as_u64())
        .unwrap_or(6) as usize;

    let active_policy = selected_agent
        .as_ref()
        .map(|agent| agent.tool_policy.clone())
        .unwrap_or_else(CustomToolPolicy::allow_all_policy);

    let mut tool_list = vec!["native_web_fetch".to_string(), "native_search".to_string()];
    let rag_tool_requested = active_policy.allowed_tools.contains("native_rag_search")
        || active_policy.allowed_tools.contains("native_rag_ingest")
        || active_policy.require_confirmation.contains("native_rag_search")
        || active_policy.require_confirmation.contains("native_rag_ingest");
    if rag_tool_requested {
        tool_list.push("native_rag_search".to_string());
        tool_list.push("native_rag_ingest".to_string());
    }
    let mcp_tools = state.mcp.list_tools().await;
    let mut mcp_tool_set = HashSet::new();
    for tool in mcp_tools {
        mcp_tool_set.insert(tool.name.clone());
        tool_list.push(tool.name);
    }
    tool_list.retain(|tool_name| active_policy.is_tool_allowed(tool_name));
    tool_list.sort();
    tool_list.dedup();

    let agent_chat_config = build_agent_chat_config(config, selected_agent.as_ref());

    if let Some(agent) = selected_agent.as_ref() {
        if !agent.system_prompt.trim().is_empty() {
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: agent.system_prompt.clone(),
            });
        }
    }

    messages.push(ChatMessage {
        role: "system".to_string(),
        content: build_agent_instructions(
            &tool_list,
            requested_mode,
            thinking_mode,
            selected_agent.as_ref(),
        ),
    });

    if let Some(attachment_text) = format_attachments(attachments) {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: attachment_text,
        });
    }

    if route_requires_planning {
        send_activity(
            sender,
            "generate_order",
            "processing",
            "Generating execution plan",
            "Planner",
        )
        .await?;
        let plan = generate_execution_plan(
            state,
            &agent_chat_config,
            user_input,
            selected_agent.as_ref(),
            thinking_mode,
        )
        .await?;
        send_activity(
            sender,
            "generate_order",
            "done",
            "Execution plan generated",
            "Planner",
        )
        .await?;
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!(
                "Planner output (follow this unless strong evidence requires adjustment):\n{}",
                plan
            ),
        });
    }

    messages.push(ChatMessage {
        role: "user".to_string(),
        content: user_input.to_string(),
    });

    for step in 0..max_steps {
        let step_message = format!("Reasoning step {}/{}", step + 1, max_steps);
        send_activity(
            sender,
            "agent_reasoning",
            "processing",
            &step_message,
            &selected_agent_name,
        )
        .await?;

        let model_cfg = ModelRuntimeConfig::for_chat(&agent_chat_config)?;
        let response = state
            .llama
            .chat(&model_cfg, messages.clone())
            .await?;
        let decision = parse_agent_decision(&response);

        match decision {
            AgentDecision::Final(content) => {
                send_activity(
                    sender,
                    "synthesize_final_response",
                    "done",
                    "Final response prepared",
                    &selected_agent_name,
                )
                .await?;
                send_json(
                    sender,
                    json!({
                        "type": "chunk",
                        "message": content,
                        "mode": "agent",
                        "agentName": selected_agent_name,
                        "nodeId": "synthesize_final_response"
                    }),
                )
                .await?;
                send_json(sender, json!({"type": "done"})).await?;
                return Ok(content);
            }
            AgentDecision::ToolCall { name, args } => {
                if !active_policy.is_tool_allowed(&name) {
                    let rejection =
                        format!("Tool `{}` is blocked by the selected agent's policy.", name);
                    send_activity(sender, "tool_guard", "error", &rejection, "Tool Guard").await?;
                    messages.push(ChatMessage {
                        role: "system".to_string(),
                        content: rejection,
                    });
                    continue;
                }

                send_activity(
                    sender,
                    "tool_node",
                    "processing",
                    &format!("Executing tool `{}`", name),
                    "Tool Handler",
                )
                .await?;

                let mut requires_confirmation = active_policy.requires_confirmation(&name);
                if mcp_tool_set.contains(&name) {
                    let policy = state.mcp.load_policy().unwrap_or_default();
                    let is_first_use = {
                        let set = approved_mcp_tools.lock().map_err(ApiError::internal)?;
                        !set.contains(&name)
                    };
                    requires_confirmation = if is_first_use && policy.first_use_confirmation {
                        true
                    } else {
                        requires_confirmation || policy.require_tool_confirmation
                    };
                    if requires_confirmation {
                        let approved = request_tool_approval(
                            sender,
                            pending.clone(),
                            &name,
                            &args,
                            approval_timeout(config),
                        )
                        .await?;
                        if !approved {
                            let denial = format!("Tool `{}` was not approved by the user.", name);
                            send_activity(sender, "tool_node", "error", &denial, "Tool Handler")
                                .await?;
                            messages.push(ChatMessage {
                                role: "system".to_string(),
                                content: denial.clone(),
                            });
                            let _ = send_json(
                                sender,
                                json!({
                                    "type": "status",
                                    "message": format!("Tool {} denied by user", name),
                                }),
                            )
                            .await;
                            continue;
                        }
                        if let Ok(mut set) = approved_mcp_tools.lock() {
                            set.insert(name.clone());
                        }
                    }
                } else if requires_confirmation {
                    let approved = request_tool_approval(
                        sender,
                        pending.clone(),
                        &name,
                        &args,
                        approval_timeout(config),
                    )
                    .await?;
                    if !approved {
                        let denial = format!("Tool `{}` was not approved by the user.", name);
                        send_activity(sender, "tool_node", "error", &denial, "Tool Handler")
                            .await?;
                        messages.push(ChatMessage {
                            role: "system".to_string(),
                            content: denial.clone(),
                        });
                        continue;
                    }
                }

                let execution = match execute_tool(
                    Some(state),
                    config,
                    Some(&state.mcp),
                    Some(session_id),
                    &name,
                    &args,
                )
                .await
                {
                    Ok(value) => value,
                    Err(err) => {
                        let failure = format!("Tool `{}` failed: {}", name, err);
                        send_activity(sender, "tool_node", "error", &failure, "Tool Handler")
                            .await?;
                        messages.push(ChatMessage {
                            role: "system".to_string(),
                            content: failure,
                        });
                        continue;
                    }
                };

                if let Some(results) = &execution.search_results {
                    let _ = send_json(sender, json!({ "type": "search_results", "data": results }))
                        .await;
                }

                let tool_payload = format!("Tool `{}` result:\\n{}", name, execution.output);

                let tool_kwargs =
                    json!({"timestamp": chrono::Utc::now().to_rfc3339(), "tool": name});
                state
                    .history
                    .add_message(session_id, "tool", &tool_payload, Some(tool_kwargs))
                    .await?;

                messages.push(ChatMessage {
                    role: "system".to_string(),
                    content: tool_payload,
                });

                send_activity(
                    sender,
                    "tool_node",
                    "done",
                    &format!("Tool `{}` finished", name),
                    "Tool Handler",
                )
                .await?;

                let _ = send_json(
                    sender,
                    json!({
                        "type": "status",
                        "message": format!("Executed tool {} (step {}/{})", name, step + 1, max_steps),
                    }),
                )
                .await;
            }
        }
    }

    let fallback = "Agent reached the maximum number of steps without a final answer.".to_string();
    send_activity(
        sender,
        "synthesize_final_response",
        "error",
        &fallback,
        &selected_agent_name,
    )
    .await?;
    send_json(
        sender,
        json!({
            "type": "chunk",
            "message": fallback,
            "mode": "agent",
            "agentName": selected_agent_name,
            "nodeId": "synthesize_final_response"
        }),
    )
    .await?;
    send_json(sender, json!({"type": "done"})).await?;
    Ok(fallback)
}

fn build_agent_chat_config(config: &Value, selected_agent: Option<&CustomAgentRuntime>) -> Value {
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

async fn send_activity(
    sender: &mut SplitSink<WebSocket, Message>,
    id: &str,
    status: &str,
    message: &str,
    agent_name: &str,
) -> Result<(), ApiError> {
    send_json(
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

pub async fn send_json(
    sender: &mut SplitSink<WebSocket, Message>,
    payload: Value,
) -> Result<(), ApiError> {
    let text = serde_json::to_string(&payload).map_err(ApiError::internal)?;
    sender
        .send(Message::Text(text))
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}

fn parse_agent_decision(text: &str) -> AgentDecision {
    if let Some(json_value) = parse_json_from_text(text) {
        if let Some(decision) = parse_agent_decision_from_value(&json_value) {
            return decision;
        }
    }
    AgentDecision::Final(text.trim().to_string())
}

fn parse_agent_decision_from_value(value: &Value) -> Option<AgentDecision> {
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
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        return Some(AgentDecision::Final(content));
    }

    None
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

fn format_attachments(attachments: &[Value]) -> Option<String> {
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

async fn request_tool_approval(
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
    send_json(sender, payload).await?;

    let approval = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx)
        .await
        .unwrap_or(Ok(false))
        .unwrap_or(false);

    if let Ok(mut map) = pending.lock() {
        map.remove(&request_id);
    }

    Ok(approval)
}

fn approval_timeout(config: &Value) -> u64 {
    config
        .get("app")
        .and_then(|v| v.get("tool_approval_timeout"))
        .and_then(|v| v.as_u64())
        .unwrap_or(300)
}

fn choose_agent_from_manager(
    state: &AppState,
    requested_agent_id: Option<&str>,
    user_input: &str,
) -> Option<CustomAgentRuntime> {
    state
        .exclusive_agents
        .choose_agent(requested_agent_id, user_input)
        .map(|agent| CustomAgentRuntime {
            id: agent.id,
            name: agent.name,
            system_prompt: agent.system_prompt,
            model_config_name: agent.model_config_name,
            tool_policy: agent.tool_policy.to_custom_tool_policy(),
        })
}
