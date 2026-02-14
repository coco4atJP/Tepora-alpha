use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::http::{HeaderMap};
use axum::response::IntoResponse;
use chrono::Utc;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::core::errors::ApiError;
use crate::state::AppState;
use crate::context::pipeline::ContextPipeline;
use crate::agent::runtime::run_agent_mode; // Import from agent runtime
use super::protocol::{WsIncomingMessage, WS_APP_PROTOCOL, WS_TOKEN_PREFIX};

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
    let skip_search = data.skip_web_search.unwrap_or(false);

    let context_result = ContextPipeline::build_chat_context(
        state,
        &config,
        &session_id,
        &message_text,
        &mode,
        skip_search,
    )
    .await?;

    let chat_messages = context_result.messages;

    if let Some(results) = context_result.search_results {
        let _ = send_json(
            sender,
            json!({ "type": "search_results", "data": results }),
        )
        .await;
    }

    if mode == "agent" {
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
