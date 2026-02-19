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

use crate::core::errors::ApiError;
use crate::graph::{AgentState, NodeContext};
use crate::state::AppState;

use super::protocol::{WsIncomingMessage, WS_APP_PROTOCOL, WS_TOKEN_PREFIX};

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let origin_ok = validate_origin(&headers, &state);
    let token_ok = validate_token(&headers, &state);

    if !origin_ok {
        tracing::warn!("WebSocket handshake failed: Invalid Origin");
    }
    if !token_ok {
        tracing::warn!("WebSocket handshake failed: Invalid Token");
    }

    ws.protocols([WS_APP_PROTOCOL])
        .on_upgrade(move |socket| handle_socket(socket, state, origin_ok, token_ok))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>, origin_ok: bool, token_ok: bool) {
    tracing::info!("WebSocket connection upgraded");
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

    let mut heartbeat_interval = tokio::time::interval(std::time::Duration::from_secs(10));
    heartbeat_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            Some(incoming) = rx.recv() => {
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
                        "char_memory": {"total_events": stats.total_events},
                        "prof_memory": {"total_events": 0}
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
            return Ok(());
        }
        _ => {}
    }

    let message_text = data.message.unwrap_or_default();
    let attachments = data.attachments;
    if message_text.is_empty() && attachments.is_empty() {
        return Ok(());
    }

    let session_id = data
        .session_id
        .unwrap_or_else(|| current_session_id.clone());
    let mode = data.mode.unwrap_or_else(|| "chat".to_string());
    let thinking_mode = data.thinking_mode.unwrap_or(false);
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
        "thinking_mode": thinking_mode,
        "agent_id": requested_agent_id.clone(),
        "agent_mode": requested_agent_mode.clone(),
        "skip_web_search": data.skip_web_search,
    });

    state
        .history
        .add_message(&session_id, "human", &message_text, Some(user_kwargs))
        .await?;
    let _ = state.history.touch_session(&session_id).await;

    let mut graph_state = AgentState::from_ws_message(
        session_id.clone(),
        &message_text,
        &mode,
        requested_agent_id.as_deref(),
        requested_agent_mode.as_deref(),
        thinking_mode,
        skip_search,
        attachments,
        Vec::new(),
    );

    let timeout_override = data.timeout.map(std::time::Duration::from_millis);

    let mut node_ctx = NodeContext {
        app_state: state,
        config: &config,
        sender,
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
        "thinking_mode": thinking_mode,
        "agent_id": requested_agent_id,
        "agent_mode": requested_agent_mode,
    });
    state
        .history
        .add_message(&session_id, "ai", &assistant_output, Some(assistant_kwargs))
        .await?;

    let embedding_model_id = resolve_embedding_model_id(state);
    let _ = state
        .em_memory_service
        .ingest_interaction(
            &session_id,
            &message_text,
            &assistant_output,
            &state.llm,
            &embedding_model_id,
        )
        .await;

    Ok(())
}

fn resolve_embedding_model_id(state: &AppState) -> String {
    state
        .models
        .get_registry()
        .ok()
        .and_then(|registry| {
            registry
                .role_assignments
                .get("embedding")
                .cloned()
                .or_else(|| {
                    registry
                        .models
                        .iter()
                        .find(|model| model.role == "embedding")
                        .map(|model| model.id.clone())
                })
                .or_else(|| registry.models.first().map(|model| model.id.clone()))
        })
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
    tracing::warn!("Origin blocked: {}", origin);
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
