use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use futures_util::stream::SplitSink;
use futures_util::SinkExt;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::actor::ActorDispatchError;
use crate::core::errors::ApiError;
use crate::models::event::{AgentEvent, AgentEventType};
use crate::state::AppState;

use super::request::GenerationRequest;

pub async fn route_via_actor_model(
    sender: &mut SplitSink<WebSocket, Message>,
    state: &Arc<AppState>,
    request: &GenerationRequest,
) -> Result<(), ApiError> {
    tracing::info!(
        "Routing message for session {} via Actor Model",
        request.session_id
    );

    let command = crate::actor::messages::SessionCommand::ProcessMessage {
        session_id: request.session_id.clone(),
        message: request.message_text.clone(),
        mode: request.mode.clone(),
        attachments: request.attachments.clone(),
        search_mode: request.search_mode.clone(),
        thinking_budget: request.thinking_budget,
        agent_id: request.requested_agent_id.clone(),
        agent_mode: request.requested_agent_mode.clone(),
        skip_web_search: request.skip_search,
    };

    let mut rx = state.runtime().actor_manager.subscribe();

    if let Err(err) = state
        .runtime()
        .actor_manager
        .dispatch(&request.session_id, state.clone(), command)
        .await
    {
        record_queue_saturation_event(state, &request.session_id, &err).await;
        return Err(map_actor_dispatch_error(err));
    }

    while let Ok(event) = rx.recv().await {
        use crate::actor::messages::SessionEvent;
        match event {
            SessionEvent::Token {
                session_id: ev_session,
                text,
            } if ev_session == request.session_id => {
                let _ = send_json(sender, json!({ "type": "chunk", "message": text })).await;
            }
            SessionEvent::Thought {
                session_id: ev_session,
                content,
            } if ev_session == request.session_id => {
                let _ = send_json(sender, json!({ "type": "thought", "content": content })).await;
            }
            SessionEvent::Status {
                session_id: ev_session,
                message,
            } if ev_session == request.session_id => {
                let _ = send_json(sender, json!({ "type": "status", "message": message })).await;
            }
            SessionEvent::NodeCompleted {
                session_id: ev_session,
                node_id,
                output,
            } if ev_session == request.session_id => {
                let _ = send_json(
                    sender,
                    json!({ "type": "node_completed", "nodeId": node_id, "output": output }),
                )
                .await;
            }
            SessionEvent::MemoryGeneration {
                session_id: ev_session,
                status,
            } if ev_session == request.session_id => {
                let _ = send_json(
                    sender,
                    json!({ "type": "memory_generation", "status": status }),
                )
                .await;
            }
            SessionEvent::Error {
                session_id: ev_session,
                message,
            } if ev_session == request.session_id => {
                let _ = send_json(sender, json!({ "type": "error", "message": message })).await;
            }
            SessionEvent::GenerationComplete {
                session_id: ev_session,
            } if ev_session == request.session_id => {
                let _ = send_json(sender, json!({"type": "done"})).await;
                let _ = send_json(
                    sender,
                    json!({"type": "interaction_complete", "sessionId": request.session_id}),
                )
                .await;
                break;
            }
            _ => {}
        }
    }

    Ok(())
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

async fn record_queue_saturation_event(
    state: &Arc<AppState>,
    session_id: &str,
    err: &ActorDispatchError,
) {
    let reason = match err {
        ActorDispatchError::SessionBusy(_) => "session_busy",
        ActorDispatchError::TooManySessions { .. } => "too_many_sessions",
        ActorDispatchError::Internal { .. } => return,
    };
    let event = AgentEvent {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        node_name: "actor_manager".to_string(),
        event_type: AgentEventType::QueueSaturated,
        metadata: json!({
            "reason": reason,
        }),
        created_at: chrono::Utc::now(),
    };
    if let Err(save_err) = state.runtime().history.save_agent_event(&event).await {
        tracing::warn!(
            "Failed to persist queue_saturated event for session {}: {}",
            session_id,
            save_err
        );
    }
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
