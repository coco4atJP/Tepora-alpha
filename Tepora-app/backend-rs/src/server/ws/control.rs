use std::sync::Arc;

use serde_json::json;

use crate::core::errors::ApiError;
use crate::core::security_controls::{ApprovalDecision, ToolApprovalResponsePayload};
use crate::state::AppState;

use super::handler::{send_history, send_json, JsonPayloadSink, PendingApprovals};
use super::protocol::WsIncomingMessage;

pub(super) enum ControlDispatch {
    Handled,
    Forward {
        data: Box<WsIncomingMessage>,
        is_regenerate: bool,
    },
}

pub(super) async fn handle_control_message<S: JsonPayloadSink + ?Sized>(
    sender: &mut S,
    state: &Arc<AppState>,
    current_session_id: &mut String,
    pending: PendingApprovals,
    data: WsIncomingMessage,
    perf_probe_enabled: bool,
) -> Result<ControlDispatch, ApiError> {
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
                        .runtime()
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
            Ok(ControlDispatch::Handled)
        }
        "get_stats" => {
            let stats = state.memory().memory_service.stats().await?;
            send_json(
                sender,
                json!({
                    "type": "stats",
                    "data": {
                        "total_events": stats.total_events,
                        "episodic_memory_enabled": stats.enabled,
                        "memory_events": stats.total_events,
                        "retrieval": {
                            "limit": stats.retrieval_limit,
                            "min_score": stats.min_score,
                        },
                        "character_memory": {
                            "total_events": stats.char_events,
                            "layer_counts": {
                                "lml": stats.char_lml,
                                "sml": stats.char_sml
                            },
                            "mean_strength": stats.char_mean_strength
                        },
                        "professional_memory": {
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
            Ok(ControlDispatch::Handled)
        }
        "perf_probe" => {
            if !perf_probe_enabled {
                return Err(ApiError::BadRequest(
                    "perf_probe is disabled (set TEPORA_PERF_PROBE_ENABLED=1)".to_string(),
                ));
            }
            send_json(
                sender,
                json!({"type": "status", "message": "perf_probe_ready"}),
            )
            .await?;
            send_json(sender, json!({"type": "chunk", "message": "probe"})).await?;
            send_json(sender, json!({"type": "done"})).await?;
            Ok(ControlDispatch::Handled)
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
            Ok(ControlDispatch::Handled)
        }
        "tool_confirmation_response" => {
            if let Some(request_id) = data.request_id.clone() {
                let approval = normalized_approval(&data);
                if state.is_redesign_enabled("actor_model") {
                    let session_id = data
                        .session_id
                        .clone()
                        .unwrap_or_else(|| current_session_id.clone());
                    if !session_id.is_empty() {
                        if let Err(err) = state
                            .runtime()
                            .actor_manager
                            .dispatch(
                                &session_id,
                                state.clone(),
                                crate::actor::messages::SessionCommand::ToolApprovalResponse {
                                    session_id: session_id.clone(),
                                    request_id,
                                    approval,
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
                        let _ = reply_to.send(approval);
                    }
                }
            }
            Ok(ControlDispatch::Handled)
        }
        "regenerate" => handle_regenerate(sender, state, current_session_id.as_str(), data).await,
        _ => Ok(ControlDispatch::Forward {
            data: Box::new(data),
            is_regenerate: false,
        }),
    }
}

fn normalized_approval(data: &WsIncomingMessage) -> ToolApprovalResponsePayload {
    if data.approval.approved.is_some()
        || !matches!(data.approval.decision, ApprovalDecision::Once)
        || data.approval.ttl_seconds.is_some()
    {
        data.approval.clone()
    } else if let Some(approved) = data.approved {
        if approved {
            ToolApprovalResponsePayload::approved_once()
        } else {
            ToolApprovalResponsePayload::denied()
        }
    } else {
        ToolApprovalResponsePayload::denied()
    }
}

async fn handle_regenerate<S: JsonPayloadSink + ?Sized>(
    sender: &mut S,
    state: &Arc<AppState>,
    current_session_id: &str,
    data: WsIncomingMessage,
) -> Result<ControlDispatch, ApiError> {
    let session_id = data
        .session_id
        .clone()
        .unwrap_or_else(|| current_session_id.to_owned());
    if session_id.is_empty() {
        return Ok(ControlDispatch::Handled);
    }

    let _ = send_json(sender, json!({"type": "regenerate_started"})).await;

    let last_user_message = state
        .runtime()
        .history
        .get_last_user_message(&session_id)
        .await?;
    if let Some(user_msg) = last_user_message {
        state
            .runtime()
            .history
            .delete_trailing_assistant_messages(&session_id)
            .await?;

        let mut new_data = data.clone();
        new_data.message = Some(user_msg.content);

        if let Some(kwargs) = user_msg.additional_kwargs.as_ref() {
            new_data.mode = kwargs
                .get("mode")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            new_data.agent_id = kwargs
                .get("agent_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            new_data.agent_mode = kwargs
                .get("agent_mode")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            if let Some(arr) = kwargs.get("attachments").and_then(|v| v.as_array()) {
                new_data.attachments = arr.clone();
            }
            if let Some(budget) = kwargs.get("thinking_budget").and_then(|v| v.as_u64()) {
                new_data.thinking_budget = Some(budget as u8);
            }
            if let Some(skip) = kwargs.get("skip_web_search").and_then(|v| v.as_bool()) {
                new_data.skip_web_search = Some(skip);
            }
            if let Some(search_mode) = kwargs.get("search_mode").and_then(|v| v.as_str()) {
                new_data.search_mode = Some(search_mode.to_string());
            }
        }

        new_data.msg_type = None;
        return Ok(ControlDispatch::Forward {
            data: Box::new(new_data),
            is_regenerate: true,
        });
    }

    let _ = send_json(
        sender,
        json!({"type": "error", "message": "No user message found to regenerate from."}),
    )
    .await;
    Ok(ControlDispatch::Handled)
}
