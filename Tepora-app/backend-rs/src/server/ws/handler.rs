use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use chrono::Utc;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::actor::ActorDispatchError;
use crate::core::errors::ApiError;
use crate::graph::{AgentState, NodeContext};
use crate::state::{AppState, AppStateWrite};

use super::protocol::{WsIncomingMessage, WS_APP_PROTOCOL, WS_TOKEN_PREFIX};

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    if !validate_origin(&headers, &state) {
        tracing::warn!("WebSocket handshake rejected: Invalid Origin");
        return Err(ApiError::Forbidden);
    }
    if !validate_token(&headers, &state).await {
        tracing::warn!("WebSocket handshake rejected: Invalid Token");
        return Err(ApiError::Unauthorized);
    }

    Ok(ws
        .protocols([WS_APP_PROTOCOL])
        .on_upgrade(move |socket| handle_socket(socket, state.shared())))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    tracing::info!("WebSocket connection upgraded");
    let (mut sender, mut receiver) = socket.split();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<WsIncomingMessage>();
    let pending = Arc::new(Mutex::new(HashMap::<
        String,
        tokio::sync::oneshot::Sender<bool>,
    >::new()));

    tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => {
                    if let Ok(incoming) = serde_json::from_str::<WsIncomingMessage>(&text) {
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

    let mut heartbeat_interval = tokio::time::interval(std::time::Duration::from_secs(10));
    heartbeat_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            Some(incoming) = rx.recv() => {
                use tracing::Instrument;
                
                let request_id = uuid::Uuid::new_v4().to_string();
                let span = tracing::info_span!(
                    "ws_message",
                    %request_id,
                    session_id = %current_session_id
                );

                if let Err(err) = handle_message(
                    &mut sender,
                    &state,
                    &mut current_session_id,
                    pending.clone(),
                    approved_mcp_tools.clone(),
                    incoming,
                )
                .instrument(span)
                .await
                {
                    let _ = send_json(
                        &mut sender,
                        json!({"type": "error", "message": err.to_string()}),
                    )
                    .await;
                }
            }
            _ = heartbeat_interval.tick() => {
                if sender.send(Message::Ping(vec![])).await.is_err() {
                     tracing::warn!("Failed to send heartbeat, closing connection");
                     break;
                 }
                 tracing::debug!("Heartbeat sent");
            }
            else => break,
        }
    }

    if !current_session_id.is_empty() && state.is_redesign_enabled("actor_model") {
        state.actor_manager.shutdown_session(&current_session_id).await;
    }

    tracing::info!("WebSocket connection closed");
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
            if state.is_redesign_enabled("actor_model") {
                let session_id = data
                    .session_id
                    .clone()
                    .unwrap_or_else(|| current_session_id.clone());
                if !session_id.is_empty() {
                    if let Err(err) = state
                        .actor_manager
                        .dispatch(
                            &session_id,
                            state.clone(),
                            crate::actor::messages::SessionCommand::StopGeneration {
                                session_id: session_id.clone(),
                            },
                        )
                        .await
                    {
                        tracing::warn!("Failed to dispatch stop command for {session_id}: {err}");
                    }
                }
            }
            return Ok(());
        }
        "get_stats" => {
            let stats = state.em_memory_service.stats().await?;
            send_json(
                sender,
                json!({
                    "type": "stats",
                    "data": {
                        "total_events": stats.total_events,
                        "em_llm_enabled": stats.enabled,
                        "memory_events": stats.total_events,
                        "retrieval": {
                            "limit": stats.retrieval_limit,
                            "min_score": stats.min_score,
                        },
                        "char_memory": {
                            "total_events": stats.char_events,
                            "layer_counts": {
                                "lml": stats.char_lml,
                                "sml": stats.char_sml
                            },
                            "mean_strength": stats.char_mean_strength
                        },
                        "prof_memory": {
                            "total_events": stats.prof_events,
                            "layer_counts": {
                                "lml": stats.prof_lml,
                                "sml": stats.prof_sml
                            },
                            "mean_strength": stats.prof_mean_strength
                        }
                    }
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
            if let (Some(request_id), Some(approved)) = (data.request_id.clone(), data.approved) {
                if state.is_redesign_enabled("actor_model") {
                    let session_id = data
                        .session_id
                        .clone()
                        .unwrap_or_else(|| current_session_id.clone());
                    if !session_id.is_empty() {
                        if let Err(err) = state
                            .actor_manager
                            .dispatch(
                                &session_id,
                                state.clone(),
                                crate::actor::messages::SessionCommand::ToolApprovalResponse {
                                    session_id: session_id.clone(),
                                    request_id,
                                    approved,
                                },
                            )
                            .await
                        {
                            tracing::warn!(
                                "Failed to dispatch tool approval response for {session_id}: {err}"
                            );
                        }
                    }
                } else if let Ok(mut map) = pending.lock() {
                    if let Some(reply_to) = map.remove(&request_id) {
                        let _ = reply_to.send(approved);
                    }
                }
            }
            return Ok(());
        }
        "regenerate" => {
            let session_id = data
                .session_id
                .clone()
                .unwrap_or_else(|| current_session_id.clone());
            if session_id.is_empty() {
                return Ok(());
            }

            // Acknowledge regeneration start
            let _ = send_json(sender, json!({"type": "regenerate_started"})).await;

            let last_user_message = state.history.get_last_user_message(&session_id).await?;
            if let Some(user_msg) = last_user_message {
                // Remove trailing assistant and system error messages
                state
                    .history
                    .delete_trailing_assistant_messages(&session_id)
                    .await?;

                // Reroute into a mock incoming message to continue the generation as if it was sent by the user
                let mut new_data = data.clone();
                new_data.message = Some(user_msg.content);
                
                if let Some(kwargs) = user_msg.additional_kwargs.as_ref() {
                    new_data.mode = kwargs.get("mode").and_then(|v| v.as_str()).map(|s| s.to_string());
                    new_data.agent_id = kwargs.get("agent_id").and_then(|v| v.as_str()).map(|s| s.to_string());
                    new_data.agent_mode = kwargs.get("agent_mode").and_then(|v| v.as_str()).map(|s| s.to_string());
                    
                    if let Some(arr) = kwargs.get("attachments").and_then(|v| v.as_array()) {
                        new_data.attachments = arr.clone();
                    }
                    if let Some(budget) = kwargs.get("thinking_budget").and_then(|v| v.as_u64()) {
                        new_data.thinking_budget = Some(budget as u8);
                    }
                    if let Some(skip) = kwargs.get("skip_web_search").and_then(|v| v.as_bool()) {
                        new_data.skip_web_search = Some(skip);
                    }
                }
                
                // Clear msg_type so it falls through to the normal generation flow
                new_data.msg_type = None;
                
                // Recursively call handle_message to process the "new" user message
                // This time it will not be "regenerate" and will insert the new assistant response
                return handle_message_internal(
                    sender,
                    state,
                    current_session_id,
                    pending,
                    approved_mcp_tools,
                    new_data,
                    true // is_regenerate flag
                )
                .await;
            } else {
                let _ = send_json(sender, json!({"type": "error", "message": "No user message found to regenerate from."})).await;
                return Ok(());
            }
        }
        _ => {}
    }

    handle_message_internal(sender, state, current_session_id, pending, approved_mcp_tools, data, false).await
}

#[allow(clippy::ptr_arg)]
async fn handle_message_internal(
    sender: &mut SplitSink<WebSocket, Message>,
    state: &Arc<AppState>,
    current_session_id: &mut String,
    pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
    approved_mcp_tools: Arc<Mutex<HashSet<String>>>,
    data: WsIncomingMessage,
    is_regenerate: bool,
) -> Result<(), ApiError> {
    let message_text = data.message.unwrap_or_default();
    let attachments = data.attachments;
    if message_text.is_empty() && attachments.is_empty() {
        return Ok(());
    }

    let session_id = data
        .session_id
        .unwrap_or_else(|| current_session_id.clone());
    let mode = data.mode.unwrap_or_else(|| "chat".to_string());
    let thinking_budget = std::cmp::min(data.thinking_budget.unwrap_or(0), 3);
    let requested_agent_id = data.agent_id;
    let requested_agent_mode = data.agent_mode;
    let skip_search = data.skip_web_search.unwrap_or(false);
    let timestamp = Utc::now().to_rfc3339();
    let attachments_for_history = attachments.clone();

    let config = state.config.load_config()?;

    // Input Validation
    let max_input_length = config
        .get("app")
        .and_then(|app| app.get("max_input_length"))
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(4096);

    if message_text.len() > max_input_length {
        return Err(ApiError::BadRequest(format!(
            "Message length {} exceeds maximum allowed {}",
            message_text.len(),
            max_input_length
        )));
    }

    let dangerous_patterns = config
        .get("app")
        .and_then(|app| app.get("dangerous_patterns"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();

    for pattern in dangerous_patterns {
        if let Ok(re) = regex::Regex::new(&pattern) {
            if re.is_match(&message_text) {
                return Err(ApiError::BadRequest(
                    "Message contains restricted content".to_string(),
                ));
            }
        }
    }

    // Prepare user kwargs
    let user_kwargs = json!({
        "timestamp": timestamp.clone(),
        "mode": mode.clone(),
        "attachments": attachments_for_history,
        "thinking_budget": thinking_budget,
        "agent_id": requested_agent_id.clone(),
        "agent_mode": requested_agent_mode.clone(),
        "skip_web_search": data.skip_web_search,
    });

    if !is_regenerate {
        state
            .history
            .add_message(&session_id, "human", &message_text, Some(user_kwargs))
            .await?;
        let _ = state.history.touch_session(&session_id).await;
    }

    // Feature Flag Check API logic
    if state.is_redesign_enabled("actor_model") {
        tracing::info!("Routing message for session {} via Actor Model", session_id);
        
        let command = crate::actor::messages::SessionCommand::ProcessMessage {
            session_id: session_id.clone(),
            message: message_text.clone(),
            mode: mode.clone(),
            attachments: attachments.clone(),
            thinking_budget,
            agent_id: requested_agent_id.clone(),
            agent_mode: requested_agent_mode.clone(),
            skip_web_search: skip_search,
        };
        
        // Subscribe to global events before dispatching to not miss anything
        let mut rx = state.actor_manager.subscribe();

        state
            .actor_manager
            .dispatch(&session_id, state.clone(), command)
            .await
            .map_err(map_actor_dispatch_error)?;
        
        // Loop over events from the actor
        while let Ok(event) = rx.recv().await {
            use crate::actor::messages::SessionEvent;
            match event {
                SessionEvent::Token { session_id: ev_session, text } if ev_session == session_id => {
                    let _ = send_json(sender, json!({ "type": "chunk", "message": text })).await;
                }
                SessionEvent::Thought { session_id: ev_session, content } if ev_session == session_id => {
                    let _ = send_json(sender, json!({ "type": "thought", "content": content })).await;
                }
                SessionEvent::Status { session_id: ev_session, message } if ev_session == session_id => {
                    let _ = send_json(sender, json!({ "type": "status", "message": message })).await;
                }
                SessionEvent::NodeCompleted { session_id: ev_session, node_id, output } if ev_session == session_id => {
                    let _ = send_json(sender, json!({ "type": "node_completed", "nodeId": node_id, "output": output })).await;
                }
                SessionEvent::Error { session_id: ev_session, message } if ev_session == session_id => {
                    let _ = send_json(sender, json!({ "type": "error", "message": message })).await;
                }
                SessionEvent::GenerationComplete { session_id: ev_session } if ev_session == session_id => {
                    let _ = send_json(sender, json!({"type": "done"})).await;
                    let _ = send_json(sender, json!({"type": "interaction_complete", "sessionId": session_id})).await;
                    break;
                }
                _ => {} // Ignore events for other sessions
            }
        }

        return Ok(());
    }

    let mut graph_state = AgentState::from_ws_message(
        session_id.clone(),
        &message_text,
        &mode,
        requested_agent_id.as_deref(),
        requested_agent_mode.as_deref(),
        thinking_budget,
        skip_search,
        attachments,
        Vec::new(),
    );

    let timeout_override = data.timeout.map(std::time::Duration::from_millis);

    let mut graph_streamer = crate::graph::stream::GraphStreamer::WebSocket(sender);

    let mut node_ctx = NodeContext {
        app_state: state,
        config: &config,
        sender: &mut graph_streamer,
        pending_approvals: pending,
        approved_mcp_tools,
    };

    state
        .graph_runtime
        .run(&mut graph_state, &mut node_ctx, timeout_override)
        .await
        .map_err(ApiError::from)?;

    let assistant_output = graph_state.output.clone().unwrap_or_default();

    let assistant_kwargs = json!({
        "timestamp": timestamp,
        "mode": mode.clone(),
        "thinking_budget": thinking_budget,
        "agent_id": requested_agent_id,
        "agent_mode": requested_agent_mode,
    });
    state
        .history
        .add_message(&session_id, "ai", &assistant_output, Some(assistant_kwargs))
        .await?;

    let text_model_id = state
        .models
        .resolve_agent_model_id(requested_agent_id.as_deref())
        .ok()
        .flatten()
        .unwrap_or_else(|| "default".to_string());
    let embedding_model_id = resolve_embedding_model_id(state);
    let legacy_enabled = state.is_redesign_enabled("legacy_memory");
    let _ = state
        .memory_adapter
        .ingest_interaction(
            &session_id,
            &message_text,
            &assistant_output,
            &state.llm,
            &text_model_id,
            &embedding_model_id,
            legacy_enabled,
        )
        .await;

    // Send an event to notify the frontend that all database writes for this interaction are complete.
    // This allows the frontend to refresh its session list and see the updated message count.
    let _ = send_json(
        sender,
        json!({
            "type": "interaction_complete",
            "sessionId": session_id,
        }),
    )
    .await;

    Ok(())
}

fn resolve_embedding_model_id(state: &AppState) -> String {
    state
        .models
        .resolve_embedding_model_id()
        .ok()
        .flatten()
        .unwrap_or_else(|| "default".to_string())
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
                .as_ref()
                .and_then(|k| k.get("timestamp"))
                .and_then(|v| v.as_str())
                .unwrap_or(&msg.created_at)
                .to_string();
            let mode = msg
                .additional_kwargs
                .as_ref()
                .and_then(|k| k.get("mode"))
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
    if let Some(o) = origin {
        tracing::debug!("Checking Origin: {}", o);
    } else {
        tracing::debug!("No Origin header found");
    }

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

    // Allow any localhost/127.0.0.1 origin (useful for Vite random ports)
    if origin.starts_with("http://localhost:") || origin.starts_with("http://127.0.0.1:") {
        return true;
    }

    tracing::warn!("Origin blocked: {}", origin);
    false
}

async fn validate_token(headers: &HeaderMap, state: &AppState) -> bool {
    let token = state.session_token.read().await;
    extract_token_from_protocol_header(headers)
        .map(|extracted| extracted == token.value())
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

fn map_actor_dispatch_error(err: ActorDispatchError) -> ApiError {
    match err {
        ActorDispatchError::SessionBusy(session_id) => ApiError::ServiceUnavailable(format!(
            "Session '{session_id}' is busy. Please retry in a moment."
        )),
        ActorDispatchError::TooManySessions { max_sessions } => ApiError::ServiceUnavailable(
            format!("Too many active sessions (limit: {max_sessions})"),
        ),
        ActorDispatchError::Internal { reason, .. } => ApiError::internal(reason),
    }
}
