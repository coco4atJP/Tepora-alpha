use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use futures_util::future::BoxFuture;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};

use crate::core::errors::ApiError;
use crate::core::security_controls::ToolApprovalResponsePayload;
use crate::graph::{AgentState, NodeContext};
use crate::state::{AppState, AppStateWrite};

use super::actor_bridge::route_via_actor_model;
use super::auth::{validate_origin, validate_token};
use super::control::{handle_control_message, ControlDispatch};
use super::protocol::{WsIncomingMessage, WS_APP_PROTOCOL};
use super::request::build_generation_request;
use super::session::{build_history_payload, persist_graph_interaction};

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppStateWrite>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    if !validate_origin(&headers, state.as_ref()) {
        tracing::warn!("WebSocket handshake rejected: Invalid Origin");
        return Err(ApiError::Forbidden);
    }
    if !validate_token(&headers, state.as_ref()).await {
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
        tokio::sync::oneshot::Sender<ToolApprovalResponsePayload>,
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
        state
            .runtime()
            .actor_manager
            .shutdown_session(&current_session_id)
            .await;
    }

    tracing::info!("WebSocket connection closed");
}

pub(super) type PendingApprovals =
    Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<ToolApprovalResponsePayload>>>>;

pub(super) trait JsonPayloadSink {
    fn send_payload<'a>(&'a mut self, payload: Value) -> BoxFuture<'a, Result<(), ApiError>>;

    fn websocket_sink(&mut self) -> Option<&mut SplitSink<WebSocket, Message>> {
        None
    }
}

impl JsonPayloadSink for SplitSink<WebSocket, Message> {
    fn send_payload<'a>(&'a mut self, payload: Value) -> BoxFuture<'a, Result<(), ApiError>> {
        Box::pin(async move {
            let text = serde_json::to_string(&payload).map_err(ApiError::internal)?;
            self.send(Message::Text(text))
                .await
                .map_err(ApiError::internal)?;
            Ok(())
        })
    }

    fn websocket_sink(&mut self) -> Option<&mut SplitSink<WebSocket, Message>> {
        Some(self)
    }
}

async fn handle_message<S: JsonPayloadSink + ?Sized>(
    sender: &mut S,
    state: &Arc<AppState>,
    current_session_id: &mut String,
    pending: PendingApprovals,
    approved_mcp_tools: Arc<Mutex<HashSet<String>>>,
    data: WsIncomingMessage,
) -> Result<(), ApiError> {
    let control = handle_control_message(
        sender,
        state,
        current_session_id,
        pending.clone(),
        data,
        is_perf_probe_enabled(),
    )
    .await?;

    let (data, is_regenerate) = match control {
        ControlDispatch::Handled => return Ok(()),
        ControlDispatch::Forward {
            data,
            is_regenerate,
        } => (data, is_regenerate),
    };

    let Some(websocket_sender) = sender.websocket_sink() else {
        return Err(ApiError::BadRequest(
            "deterministic replay only supports control-path WebSocket messages".to_string(),
        ));
    };

    handle_message_internal(
        websocket_sender,
        state,
        current_session_id,
        pending,
        approved_mcp_tools,
        data,
        is_regenerate,
    )
    .await
}

#[allow(clippy::ptr_arg)]
async fn handle_message_internal(
    sender: &mut SplitSink<WebSocket, Message>,
    state: &Arc<AppState>,
    current_session_id: &mut String,
    pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<ToolApprovalResponsePayload>>>>,
    approved_mcp_tools: Arc<Mutex<HashSet<String>>>,
    data: WsIncomingMessage,
    is_regenerate: bool,
) -> Result<(), ApiError> {
    let request = build_generation_request(state, current_session_id, data)?;
    if request.message_text.is_empty() && request.attachments.is_empty() {
        return Ok(());
    }

    let config = state.core().config.load_config()?;

    if !is_regenerate {
        state
            .runtime()
            .history
            .add_message(
                &request.session_id,
                "human",
                &request.message_text,
                Some(request.user_kwargs.clone()),
            )
            .await?;
        let _ = state
            .runtime()
            .history
            .touch_session(&request.session_id)
            .await;
    }

    if state.is_redesign_enabled("actor_model") {
        route_via_actor_model(sender, state, &request).await?;
        return Ok(());
    }

    let mut graph_state = AgentState::from_ws_message(
        request.session_id.clone(),
        &request.message_text,
        &request.mode,
        request.search_mode.as_deref(),
        request.requested_agent_id.as_deref(),
        request.requested_agent_mode.as_deref(),
        request.thinking_budget,
        request.skip_search,
        request.attachments.clone(),
        Vec::new(),
    );

    let mut graph_streamer = crate::graph::stream::GraphStreamer::WebSocket(sender);

    let mut node_ctx = NodeContext {
        app_state: state,
        config: &config,
        sender: &mut graph_streamer,
        pending_approvals: pending,
        approved_mcp_tools,
    };

    state
        .runtime()
        .graph_runtime
        .run(&mut graph_state, &mut node_ctx, request.timeout_override)
        .await
        .map_err(ApiError::from)?;

    let assistant_output = graph_state.output.clone().unwrap_or_default();

    let _ = send_json(
        sender,
        json!({
            "type": "memory_generation",
            "status": "started",
            "sessionId": request.session_id,
        }),
    )
    .await;

    persist_graph_interaction(state, &request, &assistant_output).await?;

    let _ = send_json(
        sender,
        json!({
            "type": "memory_generation",
            "status": "completed",
            "sessionId": request.session_id,
        }),
    )
    .await;

    // Send an event to notify the frontend that all database writes for this interaction are complete.
    // This allows the frontend to refresh its session list and see the updated message count.
    let _ = send_json(
        sender,
        json!({
            "type": "interaction_complete",
            "sessionId": request.session_id,
        }),
    )
    .await;

    Ok(())
}
pub(super) async fn send_history<S: JsonPayloadSink + ?Sized>(
    sender: &mut S,
    state: &Arc<AppState>,
    session_id: &str,
) -> Result<(), ApiError> {
    send_json(sender, build_history_payload(state, session_id).await?).await
}

pub(super) async fn send_json<S: JsonPayloadSink + ?Sized>(
    sender: &mut S,
    payload: Value,
) -> Result<(), ApiError> {
    sender.send_payload(payload).await
}

fn is_perf_probe_enabled() -> bool {
    std::env::var("TEPORA_PERF_PROBE_ENABLED")
        .map(|raw| {
            let normalized = raw.trim().to_ascii_lowercase();
            normalized == "1" || normalized == "true"
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::test_support::ENV_LOCK;
    use std::env;
    use std::fs;
    use std::path::Path;

    use serde_json::json;
    use tempfile::{tempdir, TempDir};

    struct EnvGuard {
        originals: Vec<(String, Option<String>)>,
    }

    impl EnvGuard {
        fn new() -> Self {
            Self {
                originals: Vec::new(),
            }
        }

        fn set_var(&mut self, key: &str, value: impl AsRef<str>) {
            let key_string = key.to_string();
            if !self
                .originals
                .iter()
                .any(|(existing, _)| existing == &key_string)
            {
                self.originals
                    .push((key_string.clone(), env::var(&key_string).ok()));
            }
            env::set_var(key, value.as_ref());
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, previous) in self.originals.iter().rev() {
                match previous {
                    Some(value) => env::set_var(key, value),
                    None => env::remove_var(key),
                }
            }
        }
    }

    #[derive(Default)]
    struct ReplaySink {
        payloads: Vec<Value>,
    }

    impl JsonPayloadSink for ReplaySink {
        fn send_payload<'a>(&'a mut self, payload: Value) -> BoxFuture<'a, Result<(), ApiError>> {
            Box::pin(async move {
                self.payloads.push(payload);
                Ok(())
            })
        }
    }

    async fn init_replay_state() -> (TempDir, EnvGuard, Arc<AppState>) {
        let sandbox = tempdir().expect("failed to create tempdir");
        let project_root = sandbox.path().join("project");
        let data_dir = sandbox.path().join("data");
        fs::create_dir_all(&project_root).expect("failed to create project root");
        fs::create_dir_all(&data_dir).expect("failed to create data dir");

        let config_path = project_root.join("config.yml");
        fs::write(
            &config_path,
            "features:\n  redesign:\n    actor_model: false\n",
        )
        .expect("failed to write config");

        let mut env_guard = EnvGuard::new();
        configure_replay_environment(&mut env_guard, &project_root, &data_dir, &config_path);

        let state = AppState::initialize()
            .await
            .expect("AppState should initialize for ws replay tests");

        (sandbox, env_guard, state)
    }

    fn configure_replay_environment(
        env_guard: &mut EnvGuard,
        project_root: &Path,
        data_dir: &Path,
        config_path: &Path,
    ) {
        env_guard.set_var("TEPORA_ROOT", project_root.to_string_lossy());
        env_guard.set_var("TEPORA_DATA_DIR", data_dir.to_string_lossy());
        env_guard.set_var("TEPORA_CONFIG_PATH", config_path.to_string_lossy());
        env_guard.set_var("TEPORA_PERF_PROBE_ENABLED", "1");
    }

    async fn replay_session_messages(
        state: Arc<AppState>,
        messages: Vec<WsIncomingMessage>,
    ) -> Result<Vec<Value>, ApiError> {
        let mut sink = ReplaySink::default();
        let mut current_session_id = "default".to_string();
        let pending = Arc::new(Mutex::new(HashMap::<
            String,
            tokio::sync::oneshot::Sender<ToolApprovalResponsePayload>,
        >::new()));
        let approved_mcp_tools = Arc::new(Mutex::new(HashSet::<String>::new()));

        for message in messages {
            handle_message(
                &mut sink,
                &state,
                &mut current_session_id,
                pending.clone(),
                approved_mcp_tools.clone(),
                message,
            )
            .await?;
        }

        Ok(sink.payloads)
    }

    fn set_session_message(session_id: &str) -> WsIncomingMessage {
        WsIncomingMessage {
            msg_type: Some("set_session".to_string()),
            session_id: Some(session_id.to_string()),
            ..Default::default()
        }
    }

    fn perf_probe_message() -> WsIncomingMessage {
        WsIncomingMessage {
            msg_type: Some("perf_probe".to_string()),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn ws_session_deterministic_replay_produces_stable_transcript() {
        let _lock = ENV_LOCK.lock().expect("failed to acquire env lock");
        let (_sandbox, _env_guard, state) = init_replay_state().await;

        let session_id = "replay-session";
        let history_id = state
            .runtime()
            .history
            .add_message(
                session_id,
                "human",
                "replay me",
                Some(json!({
                    "timestamp": "2026-03-09T00:00:00Z",
                    "mode": "chat"
                })),
            )
            .await
            .expect("failed to seed history");

        let sequence = vec![set_session_message(session_id), perf_probe_message()];
        let first = replay_session_messages(state.clone(), sequence.clone())
            .await
            .expect("first replay should succeed");
        let second = replay_session_messages(state, sequence)
            .await
            .expect("second replay should succeed");

        let expected = vec![
            json!({"type": "session_changed", "sessionId": session_id}),
            json!({
                "type": "history",
                "messages": [{
                    "id": history_id.to_string(),
                    "role": "user",
                    "content": "replay me",
                    "timestamp": "2026-03-09T00:00:00Z",
                    "mode": "chat",
                    "isComplete": true
                }]
            }),
            json!({"type": "status", "message": "perf_probe_ready"}),
            json!({"type": "chunk", "message": "probe"}),
            json!({"type": "done"}),
        ];

        assert_eq!(first, expected);
        assert_eq!(second, expected);
    }

    #[tokio::test]
    async fn ws_session_deterministic_replay_uses_persisted_history_ids() {
        let _lock = ENV_LOCK.lock().expect("failed to acquire env lock");
        let (_sandbox, _env_guard, state) = init_replay_state().await;

        let session_id = "history-replay-session";
        let first_id = state
            .runtime()
            .history
            .add_message(
                session_id,
                "human",
                "hello",
                Some(json!({
                    "timestamp": "2026-03-09T00:00:00Z",
                    "mode": "chat"
                })),
            )
            .await
            .expect("failed to seed first history message");
        let second_id = state
            .runtime()
            .history
            .add_message(
                session_id,
                "ai",
                "world",
                Some(json!({
                    "timestamp": "2026-03-09T00:00:01Z",
                    "mode": "chat"
                })),
            )
            .await
            .expect("failed to seed second history message");

        let replay = replay_session_messages(state, vec![set_session_message(session_id)])
            .await
            .expect("replay should succeed");
        let history_payload = replay
            .into_iter()
            .find(|payload| payload.get("type") == Some(&Value::String("history".to_string())))
            .expect("history payload should be present");
        let ids: Vec<String> = history_payload["messages"]
            .as_array()
            .expect("history messages should be an array")
            .iter()
            .filter_map(|message| message.get("id").and_then(|value| value.as_str()))
            .map(|value| value.to_string())
            .collect();

        assert_eq!(ids, vec![first_id.to_string(), second_id.to_string()]);
    }
}
