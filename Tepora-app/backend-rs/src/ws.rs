use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use chrono::Utc;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::errors::ApiError;
use crate::llama::ChatMessage;
use crate::search::{self, SearchResult};
use crate::state::AppState;
use crate::tooling::execute_tool;
use crate::vector_math;

const WS_APP_PROTOCOL: &str = "tepora.v1";
const WS_TOKEN_PREFIX: &str = "tepora-token.";

#[derive(Debug, Deserialize, Default)]
struct WsIncomingMessage {
    #[serde(rename = "type")]
    msg_type: Option<String>,
    message: Option<String>,
    mode: Option<String>,
    #[serde(default)]
    attachments: Vec<Value>,
    #[serde(rename = "skipWebSearch")]
    skip_web_search: Option<bool>,
    #[serde(rename = "thinkingMode")]
    thinking_mode: Option<bool>,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
    #[serde(rename = "agentMode")]
    agent_mode: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    approved: Option<bool>,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let origin_ok = validate_origin(&headers, &state);
    let token_ok = validate_token(&headers, &state);

    ws.protocols([WS_APP_PROTOCOL])
        .on_upgrade(move |socket| handle_socket(socket, state, origin_ok, token_ok))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>, origin_ok: bool, token_ok: bool) {
    let (mut sender, mut receiver) = socket.split();

    if !origin_ok {
        let _ = sender
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 4003,
                reason: "Forbidden: Invalid Origin".into(),
            })))
            .await;
        return;
    }

    if !token_ok {
        let _ = sender
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 4001,
                reason: "Unauthorized: Invalid Token".into(),
            })))
            .await;
        return;
    }

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<WsIncomingMessage>();
    let pending = Arc::new(Mutex::new(HashMap::<
        String,
        tokio::sync::oneshot::Sender<bool>,
    >::new()));
    let pending_rx = pending.clone();

    tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => {
                    if let Ok(incoming) = serde_json::from_str::<WsIncomingMessage>(&text) {
                        if incoming.msg_type.as_deref() == Some("tool_confirmation_response") {
                            if let (Some(request_id), Some(approved)) =
                                (incoming.request_id.clone(), incoming.approved)
                            {
                                if let Ok(mut map) = pending_rx.lock() {
                                    if let Some(tx) = map.remove(&request_id) {
                                        let _ = tx.send(approved);
                                    }
                                }
                            }
                            continue;
                        }
                        let _ = tx.send(incoming);
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    let mut current_session_id = "default".to_string();
    let approved_mcp_tools = Arc::new(Mutex::new(HashSet::<String>::new()));

    while let Some(incoming) = rx.recv().await {
        if let Err(err) = handle_message(
            &mut sender,
            &state,
            &mut current_session_id,
            pending.clone(),
            approved_mcp_tools.clone(),
            incoming,
        )
        .await
        {
            let _ = send_json(
                &mut sender,
                json!({"type": "error", "message": err.to_string()}),
            )
            .await;
        }
    }
}

async fn handle_message(
    sender: &mut SplitSink<WebSocket, Message>,
    state: &Arc<AppState>,
    current_session_id: &mut String,
    pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
    approved_mcp_tools: Arc<Mutex<HashSet<String>>>,
    data: WsIncomingMessage,
) -> Result<(), ApiError> {
    let msg_type = data.msg_type.as_deref().unwrap_or("");

    match msg_type {
        "stop" => {
            send_json(sender, json!({"type": "stopped"})).await?;
            return Ok(());
        }
        "get_stats" => {
            send_json(
                sender,
                json!({
                    "type": "stats",
                    "data": {"total_events": 0, "char_memory": {"total_events": 0}, "prof_memory": {"total_events": 0}}
                }),
            )
            .await?;
            return Ok(());
        }
        "set_session" => {
            if let Some(session_id) = data.session_id {
                *current_session_id = session_id;
                send_json(
                    sender,
                    json!({"type": "session_changed", "sessionId": current_session_id}),
                )
                .await?;
                send_history(sender, state, current_session_id).await?;
            }
            return Ok(());
        }
        "tool_confirmation_response" => {
            return Ok(());
        }
        _ => {}
    }

    let message_text = data.message.unwrap_or_default();
    if message_text.is_empty() && data.attachments.is_empty() {
        return Ok(());
    }

    let session_id = data
        .session_id
        .unwrap_or_else(|| current_session_id.clone());
    let mode = data.mode.unwrap_or_else(|| "chat".to_string());
    let timestamp = Utc::now().to_rfc3339();

    let user_kwargs = json!({
        "timestamp": timestamp,
        "mode": mode,
        "attachments": data.attachments,
        "thinking_mode": data.thinking_mode,
        "agent_id": data.agent_id,
        "agent_mode": data.agent_mode,
        "skip_web_search": data.skip_web_search,
    });

    state
        .history
        .add_message(&session_id, "human", &message_text, &user_kwargs)
        .await?;
    let _ = state.history.touch_session(&session_id).await;

    let config = state.config.load_config()?;
    let system_prompt = extract_system_prompt(&config);
    let history_limit = extract_history_limit(&config);
    let history_messages = state
        .history
        .get_history(&session_id, history_limit)
        .await?;
    let mut chat_messages = Vec::new();

    if let Some(prompt) = system_prompt {
        if !prompt.trim().is_empty() {
            chat_messages.push(ChatMessage {
                role: "system".to_string(),
                content: prompt,
            });
        }
    }

    for msg in history_messages {
        let role = match msg.message_type.as_str() {
            "ai" => "assistant",
            "system" => "system",
            "tool" => "assistant",
            _ => "user",
        };
        if msg.content.trim().is_empty() {
            continue;
        }
        chat_messages.push(ChatMessage {
            role: role.to_string(),
            content: msg.content,
        });
    }

    if mode == "search" {
        let allow_search = config
            .get("privacy")
            .and_then(|v| v.get("allow_web_search"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let skip_search = data.skip_web_search.unwrap_or(false);

        if allow_search && !skip_search {
            match search::perform_search(&config, &message_text).await {
                Ok(results) => {
                    let reranked_results = rerank_search_results_with_embeddings(
                        state,
                        &config,
                        &message_text,
                        results,
                    )
                    .await;
                    let _ = send_json(
                        sender,
                        json!({ "type": "search_results", "data": reranked_results }),
                    )
                    .await;

                    let summary =
                        serde_json::to_string_pretty(&reranked_results).unwrap_or_default();
                    if !summary.is_empty() {
                        chat_messages.push(ChatMessage {
                            role: "system".to_string(),
                            content: format!(
                                "Web search results (use these as sources and cite as [Source: URL]):\n{}",
                                summary
                            ),
                        });
                    }
                }
                Err(err) => {
                    let _ = send_json(
                        sender,
                        json!({"type": "status", "message": format!("Search failed: {}", err)}),
                    )
                    .await;
                }
            }
        } else {
            chat_messages.push(ChatMessage {
                role: "system".to_string(),
                content: "Web search is disabled or skipped. Answer without external search."
                    .to_string(),
            });
        }
    } else if mode == "agent" {
        let agent_response = run_agent_mode(
            &state,
            &config,
            &session_id,
            chat_messages,
            &message_text,
            &data.attachments,
            sender,
            pending,
            approved_mcp_tools,
        )
        .await?;

        let assistant_kwargs = json!({"timestamp": timestamp, "mode": mode});
        state
            .history
            .add_message(&session_id, "ai", &agent_response, &assistant_kwargs)
            .await?;
        return Ok(());
    }

    let mut stream = match state.llama.stream_chat(&config, chat_messages).await {
        Ok(rx) => rx,
        Err(err) => {
            send_json(
                sender,
                json!({"type": "error", "message": format!("{}", err)}),
            )
            .await?;
            return Ok(());
        }
    };

    let mut full_response = String::new();
    while let Some(chunk_result) = stream.recv().await {
        match chunk_result {
            Ok(chunk) => {
                if chunk.is_empty() {
                    continue;
                }
                full_response.push_str(&chunk);
                send_json(
                    sender,
                    json!({
                        "type": "chunk",
                        "message": chunk,
                        "mode": mode,
                    }),
                )
                .await?;
            }
            Err(err) => {
                send_json(
                    sender,
                    json!({"type": "error", "message": format!("{}", err)}),
                )
                .await?;
                return Ok(());
            }
        }
    }

    send_json(sender, json!({"type": "done"})).await?;

    let assistant_kwargs = json!({"timestamp": timestamp, "mode": mode});
    state
        .history
        .add_message(&session_id, "ai", &full_response, &assistant_kwargs)
        .await?;

    Ok(())
}

async fn rerank_search_results_with_embeddings(
    state: &Arc<AppState>,
    config: &Value,
    query: &str,
    results: Vec<SearchResult>,
) -> Vec<SearchResult> {
    if !embedding_rerank_enabled(config) || query.trim().is_empty() || results.len() < 2 {
        return results;
    }

    let mut inputs = Vec::with_capacity(results.len() + 1);
    inputs.push(query.to_string());
    for result in &results {
        inputs.push(format!("{}\n{}", result.title, result.snippet));
    }

    let embeddings = match state.llama.embed(config, &inputs).await {
        Ok(vectors) => vectors,
        Err(err) => {
            tracing::debug!("Search rerank skipped (embedding unavailable): {}", err);
            return results;
        }
    };

    if embeddings.len() != inputs.len() {
        tracing::debug!(
            "Search rerank skipped (embedding size mismatch): {} != {}",
            embeddings.len(),
            inputs.len()
        );
        return results;
    }

    let query_embedding = &embeddings[0];
    let candidate_embeddings = embeddings[1..].to_vec();
    let ranking =
        match vector_math::rank_descending_by_cosine(query_embedding, &candidate_embeddings) {
            Ok(scores) => scores,
            Err(err) => {
                tracing::debug!("Search rerank skipped (cosine scoring failed): {}", err);
                return results;
            }
        };

    let mut reranked = Vec::with_capacity(results.len());
    for (idx, _) in ranking {
        if let Some(result) = results.get(idx).cloned() {
            reranked.push(result);
        }
    }

    if reranked.len() == results.len() {
        reranked
    } else {
        results
    }
}

fn embedding_rerank_enabled(config: &Value) -> bool {
    config
        .get("search")
        .and_then(|v| v.get("embedding_rerank"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

async fn send_history(
    sender: &mut SplitSink<WebSocket, Message>,
    state: &Arc<AppState>,
    session_id: &str,
) -> Result<(), ApiError> {
    let messages = state.history.get_history(session_id, 100).await?;
    let formatted: Vec<Value> = messages
        .into_iter()
        .map(|msg| {
            let role = match msg.message_type.as_str() {
                "ai" => "assistant",
                "system" => "system",
                _ => "user",
            };
            let timestamp = msg
                .additional_kwargs
                .get("timestamp")
                .and_then(|v| v.as_str())
                .unwrap_or(&msg.created_at)
                .to_string();
            let mode = msg
                .additional_kwargs
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("chat")
                .to_string();

            json!({
                "id": Uuid::new_v4().to_string(),
                "role": role,
                "content": msg.content,
                "timestamp": timestamp,
                "mode": mode,
                "isComplete": true
            })
        })
        .collect();

    send_json(sender, json!({"type": "history", "messages": formatted})).await
}

async fn send_json(
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

fn validate_origin(headers: &HeaderMap, state: &AppState) -> bool {
    let origin = headers.get("origin").and_then(|v| v.to_str().ok());
    if origin.is_none() {
        let env = std::env::var("TEPORA_ENV").unwrap_or_else(|_| "production".to_string());
        return env != "production";
    }

    let allowed = state
        .config
        .load_config()
        .ok()
        .and_then(|cfg| {
            cfg.get("server")
                .and_then(|server| server.as_object())
                .and_then(|server| {
                    server
                        .get("ws_allowed_origins")
                        .or_else(|| server.get("cors_allowed_origins"))
                        .or_else(|| server.get("allowed_origins"))
                        .cloned()
                })
        })
        .and_then(|list| list.as_array().cloned())
        .unwrap_or_else(|| {
            vec![
                Value::String("tauri://localhost".to_string()),
                Value::String("https://tauri.localhost".to_string()),
                Value::String("http://tauri.localhost".to_string()),
                Value::String("http://localhost".to_string()),
                Value::String("http://localhost:5173".to_string()),
                Value::String("http://localhost:3000".to_string()),
                Value::String("http://127.0.0.1:5173".to_string()),
                Value::String("http://127.0.0.1:3000".to_string()),
                Value::String("http://127.0.0.1:8000".to_string()),
                Value::String("http://127.0.0.1".to_string()),
            ]
        });

    let origin = origin.unwrap_or("");
    for entry in allowed {
        if let Some(allowed_origin) = entry.as_str() {
            if origin == allowed_origin || origin.starts_with(&format!("{}/", allowed_origin)) {
                return true;
            }
        }
    }
    false
}

fn validate_token(headers: &HeaderMap, state: &AppState) -> bool {
    extract_token_from_protocol_header(headers)
        .map(|token| token == state.session_token.value())
        .unwrap_or(false)
}

fn extract_token_from_protocol_header(headers: &HeaderMap) -> Option<String> {
    let protocol_header = headers.get("sec-websocket-protocol")?.to_str().ok()?;
    for item in protocol_header.split(',') {
        let protocol = item.trim();
        let Some(encoded) = protocol.strip_prefix(WS_TOKEN_PREFIX) else {
            continue;
        };
        if encoded.is_empty() {
            return None;
        }
        let bytes = hex::decode(encoded).ok()?;
        let token = String::from_utf8(bytes).ok()?;
        if !token.is_empty() {
            return Some(token);
        }
    }
    None
}

fn extract_system_prompt(config: &Value) -> Option<String> {
    let active = config
        .get("active_agent_profile")
        .and_then(|v| v.as_str())
        .unwrap_or("bunny_girl");
    config
        .get("characters")
        .and_then(|v| v.get(active))
        .and_then(|v| v.get("system_prompt"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn extract_history_limit(config: &Value) -> i64 {
    config
        .get("chat_history")
        .and_then(|v| v.get("default_limit"))
        .and_then(|v| v.as_i64())
        .unwrap_or(40)
}

enum AgentDecision {
    Final(String),
    ToolCall { name: String, args: Value },
}

async fn run_agent_mode(
    state: &AppState,
    config: &Value,
    session_id: &str,
    mut messages: Vec<ChatMessage>,
    user_input: &str,
    attachments: &[Value],
    sender: &mut SplitSink<WebSocket, Message>,
    pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
    approved_mcp_tools: Arc<Mutex<HashSet<String>>>,
) -> Result<String, ApiError> {
    let max_steps = config
        .get("app")
        .and_then(|v| v.get("graph_recursion_limit"))
        .and_then(|v| v.as_u64())
        .unwrap_or(6) as usize;

    let mut tool_list = vec!["native_web_fetch".to_string(), "native_search".to_string()];
    let mcp_tools = state.mcp.list_tools().await;
    let mut mcp_tool_set = HashSet::new();
    for tool in mcp_tools {
        mcp_tool_set.insert(tool.name.clone());
        tool_list.push(tool.name);
    }
    messages.push(ChatMessage {
        role: "system".to_string(),
        content: build_agent_instructions(&tool_list),
    });

    if let Some(attachment_text) = format_attachments(attachments) {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: attachment_text,
        });
    }

    messages.push(ChatMessage {
        role: "user".to_string(),
        content: user_input.to_string(),
    });

    for step in 0..max_steps {
        let response = state.llama.chat(config, messages.clone()).await?;
        let decision = parse_agent_decision(&response);

        match decision {
            AgentDecision::Final(content) => {
                send_json(
                    sender,
                    json!({
                        "type": "chunk",
                        "message": content,
                        "mode": "agent"
                    }),
                )
                .await?;
                send_json(sender, json!({"type": "done"})).await?;
                return Ok(content);
            }
            AgentDecision::ToolCall { name, args } => {
                if mcp_tool_set.contains(&name) {
                    let policy = state.mcp.load_policy().unwrap_or_default();
                    let is_first_use = {
                        let set = approved_mcp_tools.lock().map_err(ApiError::internal)?;
                        !set.contains(&name)
                    };
                    let requires_confirmation = if is_first_use && policy.first_use_confirmation {
                        true
                    } else {
                        policy.require_tool_confirmation
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
                }

                let execution = execute_tool(config, Some(&state.mcp), &name, &args).await?;

                if let Some(results) = &execution.search_results {
                    let _ = send_json(sender, json!({ "type": "search_results", "data": results }))
                        .await;
                }

                let tool_payload = format!("Tool `{}` result:\\n{}", name, execution.output);

                let tool_kwargs =
                    json!({"timestamp": chrono::Utc::now().to_rfc3339(), "tool": name});
                state
                    .history
                    .add_message(session_id, "tool", &tool_payload, &tool_kwargs)
                    .await?;

                messages.push(ChatMessage {
                    role: "system".to_string(),
                    content: tool_payload,
                });

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
    send_json(
        sender,
        json!({
            "type": "chunk",
            "message": fallback,
            "mode": "agent"
        }),
    )
    .await?;
    send_json(sender, json!({"type": "done"})).await?;
    Ok(fallback)
}

fn build_agent_instructions(tool_names: &[String]) -> String {
    let tools = tool_names.join(", ");
    format!(
        "You are operating in agent mode. You have access to the following tools: {}.\n\
When you need to use a tool, respond ONLY with JSON in this format:\n\
{{\"type\":\"tool_call\",\"tool_name\":\"<tool>\",\"tool_args\":{{...}}}}\n\
When you have the final answer, respond ONLY with JSON in this format:\n\
{{\"type\":\"final\",\"content\":\"...\"}}\n\
Do not include any extra text outside the JSON.",
        tools
    )
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

impl From<ApiError> for StatusCode {
    fn from(_: ApiError) -> Self {
        StatusCode::INTERNAL_SERVER_ERROR
    }
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
            "toolArgs": if tool_args.is_object() { tool_args } else { json!({ "input": tool_args }) },
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
