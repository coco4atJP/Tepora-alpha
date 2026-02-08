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
    let thinking_mode = data.thinking_mode.unwrap_or(false);
    let requested_agent_id = data.agent_id.clone();
    let requested_agent_mode = data.agent_mode.clone();
    let timestamp = Utc::now().to_rfc3339();

    let user_kwargs = json!({
        "timestamp": timestamp,
        "mode": mode,
        "attachments": data.attachments,
        "thinking_mode": thinking_mode,
        "agent_id": requested_agent_id.clone(),
        "agent_mode": requested_agent_mode.clone(),
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
            state,
            &config,
            &session_id,
            chat_messages,
            &message_text,
            &data.attachments,
            thinking_mode,
            requested_agent_id.as_deref(),
            requested_agent_mode.as_deref(),
            sender,
            pending,
            approved_mcp_tools,
        )
        .await?;

        let assistant_kwargs = json!({
            "timestamp": timestamp,
            "mode": mode,
            "thinking_mode": thinking_mode,
            "agent_id": requested_agent_id,
            "agent_mode": requested_agent_mode,
        });
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RequestedAgentMode {
    Fast,
    High,
    Direct,
}

impl RequestedAgentMode {
    fn parse(value: Option<&str>) -> Self {
        match value
            .map(|v| v.trim().to_lowercase())
            .unwrap_or_else(|| "fast".to_string())
            .as_str()
        {
            "high" => RequestedAgentMode::High,
            "direct" => RequestedAgentMode::Direct,
            _ => RequestedAgentMode::Fast,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            RequestedAgentMode::Fast => "fast",
            RequestedAgentMode::High => "high",
            RequestedAgentMode::Direct => "direct",
        }
    }
}

#[derive(Debug, Clone)]
struct CustomToolPolicy {
    allow_all: bool,
    allowed_tools: HashSet<String>,
    denied_tools: HashSet<String>,
    require_confirmation: HashSet<String>,
}

impl CustomToolPolicy {
    fn allow_all_policy() -> Self {
        Self {
            allow_all: true,
            allowed_tools: HashSet::new(),
            denied_tools: HashSet::new(),
            require_confirmation: HashSet::new(),
        }
    }

    fn from_agent_config(agent: &Value) -> Self {
        let policy = agent
            .get("tool_policy")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();

        let allow_defined = policy.contains_key("allowed_tools") || policy.contains_key("allow");
        let allowed_raw =
            parse_string_set(policy.get("allowed_tools").or_else(|| policy.get("allow")));
        let allow_all = !allow_defined || allowed_raw.contains("*");

        let allowed_tools = allowed_raw
            .into_iter()
            .filter(|tool| tool != "*")
            .collect::<HashSet<_>>();
        let denied_tools =
            parse_string_set(policy.get("denied_tools").or_else(|| policy.get("deny")));
        let require_confirmation = parse_string_set(policy.get("require_confirmation"));

        Self {
            allow_all,
            allowed_tools,
            denied_tools,
            require_confirmation,
        }
    }

    fn is_tool_allowed(&self, tool_name: &str) -> bool {
        if self.denied_tools.contains(tool_name) {
            return false;
        }
        if self.allow_all {
            return true;
        }
        self.allowed_tools.contains(tool_name)
    }

    fn requires_confirmation(&self, tool_name: &str) -> bool {
        self.require_confirmation.contains(tool_name)
    }
}

#[derive(Debug, Clone)]
struct CustomAgentRuntime {
    id: String,
    name: String,
    description: String,
    system_prompt: String,
    model_config_name: Option<String>,
    tool_policy: CustomToolPolicy,
}

async fn run_agent_mode(
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
    let custom_agents = load_enabled_custom_agents(config);
    let selected_agent = choose_agent(&custom_agents, requested_agent_id, user_input);

    if matches!(requested_mode, RequestedAgentMode::Direct) {
        if let Some(requested) = requested_agent_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !custom_agents.contains_key(requested) {
                return Err(ApiError::BadRequest(format!(
                    "Requested agent '{}' is not available or not enabled",
                    requested
                )));
            }
        }
    }

    let route_requires_planning = match requested_mode {
        RequestedAgentMode::High => true,
        RequestedAgentMode::Fast => requires_fast_mode_planning(user_input),
        RequestedAgentMode::Direct => false,
    };
    let route_label = if route_requires_planning {
        "planner"
    } else {
        "direct"
    };

    let selected_agent_name = selected_agent
        .as_ref()
        .map(|agent| agent.name.clone())
        .unwrap_or_else(|| "Professional Agent".to_string());
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

        let response = state
            .llama
            .chat(&agent_chat_config, messages.clone())
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

                let execution = match execute_tool(config, Some(&state.mcp), &name, &args).await {
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
                    .add_message(session_id, "tool", &tool_payload, &tool_kwargs)
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

fn build_agent_instructions(
    tool_names: &[String],
    mode: RequestedAgentMode,
    thinking_mode: bool,
    selected_agent: Option<&CustomAgentRuntime>,
) -> String {
    let tools = if tool_names.is_empty() {
        "None (you must solve without tools unless the user asks to change policy)".to_string()
    } else {
        tool_names.join(", ")
    };
    let selected_agent_text = selected_agent
        .map(|agent| format!("Selected professional agent: {} ({})", agent.name, agent.id))
        .unwrap_or_else(|| "Selected professional agent: default".to_string());
    let thinking_note = if thinking_mode {
        "Thinking mode is enabled. Reason step-by-step before each tool call."
    } else {
        "Thinking mode is disabled. Keep reasoning concise."
    };
    format!(
        "You are operating in agent mode ({mode}).\n\
{selected_agent_text}\n\
{thinking_note}\n\
You have access to the following tools: {tools}.\n\
When you need to use a tool, respond ONLY with JSON in this format:\n\
{{\"type\":\"tool_call\",\"tool_name\":\"<tool>\",\"tool_args\":{{...}}}}\n\
When you have the final answer, respond ONLY with JSON in this format:\n\
{{\"type\":\"final\",\"content\":\"...\"}}\n\
Do not include any extra text outside the JSON.",
        mode = mode.as_str()
    )
}

async fn generate_execution_plan(
    state: &AppState,
    chat_config: &Value,
    user_input: &str,
    selected_agent: Option<&CustomAgentRuntime>,
    thinking_mode: bool,
) -> Result<String, ApiError> {
    let selected = selected_agent
        .map(|agent| format!("{} ({})", agent.name, agent.id))
        .unwrap_or_else(|| "default".to_string());
    let detail = if thinking_mode { "detailed" } else { "compact" };

    let planning_messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: "You are a planner for a tool-using AI agent.\n\
Create a practical execution plan with up to 6 ordered steps.\n\
Use concise markdown bullets and include fallback actions.\n\
Do not add any text before or after the plan."
                .to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: format!(
                "User request:\n{}\n\nPreferred executor:\n{}\n\nDetail level:\n{}",
                user_input, selected, detail
            ),
        },
    ];

    let plan = state.llama.chat(chat_config, planning_messages).await?;
    let trimmed = plan.trim();
    if trimmed.is_empty() {
        return Ok(
            "- Clarify objective and constraints\n- Gather required evidence\n- Execute tools safely\n- Synthesize final answer"
                .to_string(),
        );
    }
    Ok(trimmed.to_string())
}

fn load_enabled_custom_agents(config: &Value) -> HashMap<String, CustomAgentRuntime> {
    let mut out = HashMap::new();
    let Some(agents) = config.get("custom_agents").and_then(|v| v.as_object()) else {
        return out;
    };

    for (id, raw_agent) in agents {
        let enabled = raw_agent
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        if !enabled {
            continue;
        }

        let name = raw_agent
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(id)
            .to_string();
        let description = raw_agent
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let system_prompt = raw_agent
            .get("system_prompt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let model_config_name = raw_agent
            .get("model_config_name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(|v| v.to_string());

        out.insert(
            id.to_string(),
            CustomAgentRuntime {
                id: id.to_string(),
                name,
                description,
                system_prompt,
                model_config_name,
                tool_policy: CustomToolPolicy::from_agent_config(raw_agent),
            },
        );
    }
    out
}

fn parse_string_set(value: Option<&Value>) -> HashSet<String> {
    let mut out = HashSet::new();
    let Some(list) = value.and_then(|v| v.as_array()) else {
        return out;
    };
    for item in list {
        if let Some(value) = item.as_str().map(str::trim).filter(|v| !v.is_empty()) {
            out.insert(value.to_string());
        }
    }
    out
}

fn choose_agent(
    custom_agents: &HashMap<String, CustomAgentRuntime>,
    requested_agent_id: Option<&str>,
    user_input: &str,
) -> Option<CustomAgentRuntime> {
    if let Some(requested) = requested_agent_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(agent) = custom_agents.get(requested) {
            return Some(agent.clone());
        }
    }

    if custom_agents.is_empty() {
        return None;
    }

    let query = user_input.to_lowercase();
    let mut ranked = custom_agents.values().cloned().collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        let left_score = score_agent_for_query(left, &query);
        let right_score = score_agent_for_query(right, &query);
        right_score
            .cmp(&left_score)
            .then_with(|| left.id.cmp(&right.id))
    });
    ranked.into_iter().next()
}

fn score_agent_for_query(agent: &CustomAgentRuntime, query: &str) -> usize {
    let corpus = format!(
        "{} {} {} {}",
        agent.id, agent.name, agent.description, agent.system_prompt
    )
    .to_lowercase();

    query
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .map(str::trim)
        .filter(|token| token.len() >= 3)
        .take(20)
        .filter(|token| corpus.contains(token))
        .count()
}

fn requires_fast_mode_planning(user_input: &str) -> bool {
    let lowered = user_input.to_lowercase();
    if lowered.len() > 220 {
        return true;
    }

    let indicators = [
        "step by step",
        "plan",
        "roadmap",
        "architecture",
        "migration",
        "strategy",
        "analysis",
        "complex",
        "比較",
        "分析",
        "計画",
        "設計",
        "段階",
        "手順",
        "移行",
        "包括",
        "複雑",
    ];
    indicators.iter().any(|keyword| lowered.contains(keyword))
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use serde_json::json;

    #[test]
    fn requested_agent_mode_parses_supported_values() {
        assert_eq!(
            RequestedAgentMode::parse(Some("high")),
            RequestedAgentMode::High
        );
        assert_eq!(
            RequestedAgentMode::parse(Some("direct")),
            RequestedAgentMode::Direct
        );
        assert_eq!(
            RequestedAgentMode::parse(Some("fast")),
            RequestedAgentMode::Fast
        );
        assert_eq!(RequestedAgentMode::parse(None), RequestedAgentMode::Fast);
        assert_eq!(
            RequestedAgentMode::parse(Some("unknown")),
            RequestedAgentMode::Fast
        );
    }

    #[test]
    fn custom_tool_policy_respects_allow_deny_and_confirmation() {
        let agent = json!({
            "tool_policy": {
                "allowed_tools": ["native_search", "native_web_fetch"],
                "denied_tools": ["native_web_fetch"],
                "require_confirmation": ["native_search"]
            }
        });
        let policy = CustomToolPolicy::from_agent_config(&agent);

        assert!(policy.is_tool_allowed("native_search"));
        assert!(!policy.is_tool_allowed("native_web_fetch"));
        assert!(policy.requires_confirmation("native_search"));
        assert!(!policy.requires_confirmation("native_web_fetch"));
    }

    #[test]
    fn custom_tool_policy_defaults_to_allow_all_when_not_defined() {
        let policy = CustomToolPolicy::from_agent_config(&json!({}));
        assert!(policy.is_tool_allowed("native_search"));
        assert!(policy.is_tool_allowed("some_mcp_tool"));
    }

    #[test]
    fn fast_mode_planning_heuristic_detects_complex_requests() {
        assert!(requires_fast_mode_planning(
            "移行計画を段階的に設計して、比較分析も含めてください"
        ));
        assert!(!requires_fast_mode_planning("今日の天気を教えて"));
    }

    #[test]
    fn choose_agent_prefers_explicit_request() {
        let mut agents = HashMap::new();
        agents.insert(
            "coder".to_string(),
            CustomAgentRuntime {
                id: "coder".to_string(),
                name: "Coder".to_string(),
                description: "Writes code".to_string(),
                system_prompt: "Coding expert".to_string(),
                model_config_name: None,
                tool_policy: CustomToolPolicy::allow_all_policy(),
            },
        );
        agents.insert(
            "research".to_string(),
            CustomAgentRuntime {
                id: "research".to_string(),
                name: "Researcher".to_string(),
                description: "Does web research".to_string(),
                system_prompt: "Research expert".to_string(),
                model_config_name: None,
                tool_policy: CustomToolPolicy::allow_all_policy(),
            },
        );

        let selected = choose_agent(
            &agents,
            Some("research"),
            "Need implementation details for Rust.",
        )
        .expect("agent should be selected");
        assert_eq!(selected.id, "research");
    }

    #[test]
    fn extract_token_from_protocol_header_parses_token_protocol() {
        let mut headers = HeaderMap::new();
        let encoded = hex::encode("secret-token");
        headers.insert(
            "sec-websocket-protocol",
            HeaderValue::from_str(&format!(
                "{},{}{}",
                WS_APP_PROTOCOL, WS_TOKEN_PREFIX, encoded
            ))
            .expect("header value should be valid"),
        );

        let token = extract_token_from_protocol_header(&headers);
        assert_eq!(token.as_deref(), Some("secret-token"));
    }

    #[test]
    fn extract_token_from_protocol_header_rejects_invalid_hex() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "sec-websocket-protocol",
            HeaderValue::from_str(&format!("{},{}xyz", WS_APP_PROTOCOL, WS_TOKEN_PREFIX))
                .expect("header value should be valid"),
        );

        let token = extract_token_from_protocol_header(&headers);
        assert_eq!(token, None);
    }

    #[test]
    fn extract_token_from_protocol_header_returns_none_when_missing() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "sec-websocket-protocol",
            HeaderValue::from_static(WS_APP_PROTOCOL),
        );

        let token = extract_token_from_protocol_header(&headers);
        assert_eq!(token, None);
    }
}
