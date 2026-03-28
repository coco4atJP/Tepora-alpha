use std::path::PathBuf;
use tauri::{RunEvent, AppHandle, Emitter, Manager};
use tauri_plugin_log::{Target, TargetKind};
use tepora_backend::state::AppState;
use tepora_backend::actor::ActorDispatchError;
use tepora_backend::actor::messages::{SessionCommand, SessionEvent};
use tepora_backend::core::security_controls::ToolApprovalResponsePayload;
use tepora_backend::server::ws::protocol::WsIncomingMessage;
use std::sync::Arc;
use serde_json::json;

struct BackendState(Arc<AppState>);

fn map_actor_dispatch_error(err: ActorDispatchError) -> String {
    match err {
        ActorDispatchError::SessionBusy(session_id) => {
            format!("Session '{}' is busy. Please retry in a moment.", session_id)
        }
        ActorDispatchError::TooManySessions { max_sessions } => {
            format!("Too many active sessions (limit: {})", max_sessions)
        }
        ActorDispatchError::Internal { reason, .. } => reason,
    }
}

#[tauri::command]
async fn chat_command(
    app: AppHandle,
    state: tauri::State<'_, BackendState>,
    payload: String,
) -> Result<(), String> {
    let app_state = &state.0;
    
    let data: WsIncomingMessage = 
        serde_json::from_str(&payload).map_err(|e| e.to_string())?;

    let msg_type = data.msg_type.as_deref().unwrap_or("");
    
    match msg_type {
        "stop" => {
            let _ = app.emit("chat_event", json!({"type": "stopped"}).to_string());
            let session_id = data.session_id.unwrap_or_else(|| "default".to_string());
            if !session_id.is_empty() {
                if let Err(err) = app_state
                    .runtime
                    .actor_manager
                    .dispatch(
                        &session_id,
                        app_state.clone(),
                        SessionCommand::StopGeneration {
                            session_id: session_id.clone(),
                        },
                    )
                    .await
                {
                    let _ = app.emit(
                        "chat_event",
                        json!({"type": "error", "message": map_actor_dispatch_error(err)}).to_string(),
                    );
                }
            }
            return Ok(());
        }
        "get_stats" => {
            let stats = app_state.memory.memory_service.stats().await.map_err(|e| e.to_string())?;
            let _ = app.emit(
                "chat_event",
                json!({
                    "type": "stats",
                    "data": {
                        "total_events": stats.total_events,
                        "episodic_memory_enabled": stats.enabled,
                        "total_episodic_memories": stats.char_events,
                        "retrieval": {
                            "limit": stats.retrieval_limit,
                            "min_score": stats.min_score,
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
                })
                .to_string(),
            );
            return Ok(());
        }
        "set_session" => {
            if let Some(session_id) = data.session_id {
                let _ = app.emit(
                    "chat_event",
                    json!({"type": "session_changed", "sessionId": session_id}).to_string(),
                );

                let messages = app_state
                    .runtime
                    .history
                    .get_history(&session_id, 100)
                    .await
                    .map_err(|e| e.to_string())?;

                let formatted: Vec<serde_json::Value> = messages
                    .into_iter()
                    .enumerate()
                    .map(|(idx, msg)| {
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
                            "id": format!("{}-{}", session_id, idx),
                            "role": role,
                            "content": msg.content,
                            "timestamp": timestamp,
                            "mode": mode,
                            "isComplete": true
                        })
                    })
                    .collect();

                let _ = app.emit(
                    "chat_event",
                    json!({"type": "history", "messages": formatted}).to_string(),
                );
            }
            return Ok(());
        }
        "tool_confirmation_response" => {
            if let Some(request_id) = data.request_id.clone() {
                let session_id = data.session_id.unwrap_or_else(|| "default".to_string());
                if !session_id.is_empty() {
                    let approval = if data.approved.unwrap_or(false) {
                        ToolApprovalResponsePayload::approved_once()
                    } else {
                        ToolApprovalResponsePayload::denied()
                    };

                    if let Err(err) = app_state
                        .runtime
                        .actor_manager
                        .dispatch(
                            &session_id,
                            app_state.clone(),
                            SessionCommand::ToolApprovalResponse {
                                session_id: session_id.clone(),
                                request_id,
                                approval,
                            },
                        )
                        .await
                    {
                        let _ = app.emit(
                            "chat_event",
                            json!({"type": "error", "message": map_actor_dispatch_error(err)}).to_string(),
                        );
                    }
                }
            }
            return Ok(());
        }
        _ => {}
    }

    let message_text = data.message.unwrap_or_default();
    if message_text.is_empty() && data.attachments.is_empty() {
        return Ok(());
    }

    let session_id = data.session_id.unwrap_or_else(|| "default".to_string());

    let command = SessionCommand::ProcessMessage {
        session_id: session_id.clone(),
        message: message_text.clone(),
        mode: data.mode.unwrap_or_else(|| "chat".to_string()),
        attachments: data.attachments.clone(),
        search_mode: data.search_mode.clone(),
        thinking_budget: std::cmp::min(data.thinking_budget.unwrap_or(0), 3),
        agent_id: data.agent_id.clone(),
        agent_mode: data.agent_mode.clone(),
        skip_web_search: data.skip_web_search.unwrap_or(false),
    };

    let mut rx = app_state.runtime.actor_manager.subscribe();
    app_state
        .runtime
        .actor_manager
        .dispatch(&session_id, app_state.clone(), command)
        .await
        .map_err(map_actor_dispatch_error)?;

    while let Ok(event) = rx.recv().await {
        match event {
            SessionEvent::Token { session_id: ev_session, text } if ev_session == session_id => {
                let _ = app.emit("chat_event", json!({ "type": "chunk", "message": text }).to_string());
            }
            SessionEvent::Status { session_id: ev_session, message } if ev_session == session_id => {
                let _ = app.emit("chat_event", json!({ "type": "status", "message": message }).to_string());
            }
            SessionEvent::NodeCompleted { session_id: ev_session, node_id, output } if ev_session == session_id => {
                let _ = app.emit("chat_event", json!({ "type": "node_completed", "nodeId": node_id, "output": output }).to_string());
            }
            SessionEvent::Error { session_id: ev_session, message } if ev_session == session_id => {
                let _ = app.emit("chat_event", json!({ "type": "error", "message": message }).to_string());
            }
            SessionEvent::GenerationComplete { session_id: ev_session } if ev_session == session_id => {
                let _ = app.emit("chat_event", json!({"type": "done"}).to_string());
                let _ = app.emit("chat_event", json!({"type": "interaction_complete", "sessionId": session_id}).to_string());
                break;
            }
            _ => {}
        }
    }

    Ok(())
}

#[tauri::command]
fn read_session_token() -> Option<String> {
    if let Ok(token) = std::env::var("TEPORA_SESSION_TOKEN") {
        let token = token.trim().to_string();
        if !token.is_empty() {
            return Some(token);
        }
    }

    let home_dir = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    let token_path = home_dir.join(".tepora").join(".session_token");
    let token = std::fs::read_to_string(token_path).ok()?;
    let token = token.trim().to_string();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            tauri::async_runtime::block_on(async {
                if let Ok(app_state) = AppState::initialize().await {
                    app.manage(BackendState(app_state));
                } else {
                    log::error!("Failed to initialize Tepora AppState");
                }
            });
            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())

        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .target(Target::new(TargetKind::LogDir {
                    file_name: Some("tepora".to_string()),
                }))
                .build(),
        )
        .invoke_handler(tauri::generate_handler![read_session_token, chat_command])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        match event {
            RunEvent::ExitRequested { api: _, code: _, .. } => {
                // ウィンドウが閉じられた時、アプリ終了を許可
                // 何もしなければデフォルトで終了する
                log::info!("Exit requested, allowing application to exit");
            }
            RunEvent::Exit => {
                // アプリ終了時のクリーンアップ
                log::info!("Application exiting");
                // 念のため強制終了して、サイドカープロセス等の残留を防ぐ
                std::process::exit(0);
            }
            _ => {}
        }
    });
}
