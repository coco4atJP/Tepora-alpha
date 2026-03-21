use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};

use super::messages::{SessionCommand, SessionEvent};
use crate::core::security_controls::ToolApprovalResponsePayload;
use crate::graph::stream::GraphStreamer;
use crate::graph::{AgentState, Mode};
use crate::state::AppState;

use std::collections::{HashMap, HashSet};

pub struct SessionActor {
    pub session_id: String,
    pub rx: mpsc::Receiver<SessionCommand>,
    pub app_state: Arc<AppState>,
    pub events_tx: broadcast::Sender<SessionEvent>,
    pub current_task: Option<tokio::task::JoinHandle<()>>,
    pub pending_approvals: Arc<
        std::sync::Mutex<
            HashMap<String, tokio::sync::oneshot::Sender<ToolApprovalResponsePayload>>,
        >,
    >,
    pub approved_mcp_tools: Arc<std::sync::Mutex<HashSet<String>>>,
}

impl SessionActor {
    pub fn new(
        session_id: String,
        rx: mpsc::Receiver<SessionCommand>,
        app_state: Arc<AppState>,
        events_tx: broadcast::Sender<SessionEvent>,
    ) -> Self {
        Self {
            session_id,
            rx,
            app_state,
            events_tx,
            current_task: None,
            pending_approvals: Arc::new(std::sync::Mutex::new(HashMap::new())),
            approved_mcp_tools: Arc::new(std::sync::Mutex::new(HashSet::new())),
        }
    }

    pub async fn run(mut self) {
        tracing::debug!("SessionActor started for {}", self.session_id);

        while let Some(command) = self.rx.recv().await {
            match command {
                SessionCommand::ProcessMessage {
                    message,
                    mode,
                    attachments,
                    thinking_budget,
                    agent_id,
                    agent_mode,
                    skip_web_search,
                    ..
                } => {
                    // Implement concurrent execution tracking so it can be aborted
                    if let Some(handle) = self.current_task.take() {
                        handle.abort();
                    }

                    let state_clone = self.app_state.clone();
                    let tx_clone = self.events_tx.clone();
                    let session_clone = self.session_id.clone();
                    let pending_clone = self.pending_approvals.clone();
                    let approved_tools_clone = self.approved_mcp_tools.clone();

                    self.current_task = Some(tokio::spawn(async move {
                        Self::execute_process_message(
                            session_clone,
                            state_clone,
                            tx_clone,
                            pending_clone,
                            approved_tools_clone,
                            message,
                            mode,
                            attachments,
                            thinking_budget,
                            agent_id,
                            agent_mode,
                            skip_web_search,
                        )
                        .await;
                    }));
                }
                SessionCommand::StopGeneration { .. } => {
                    // Logic to interrupt the current graph execution if possible
                    if let Some(handle) = self.current_task.take() {
                        handle.abort();
                    }
                    let _ = self.events_tx.send(SessionEvent::Status {
                        session_id: self.session_id.clone(),
                        message: "Generation stopped".into(),
                    });
                }
                SessionCommand::ToolApprovalResponse {
                    session_id,
                    request_id,
                    approval,
                } => {
                    if session_id != self.session_id {
                        tracing::debug!(
                            "Ignoring tool approval response for mismatched session: command={}, actor={}",
                            session_id,
                            self.session_id
                        );
                        continue;
                    }

                    match self.pending_approvals.lock() {
                        Ok(mut pending) => {
                            if let Some(reply_to) = pending.remove(&request_id) {
                                let _ = reply_to.send(approval);
                            } else {
                                tracing::warn!(
                                    "Tool approval response received for unknown request_id: {}",
                                    request_id
                                );
                            }
                        }
                        Err(err) => {
                            tracing::warn!("Failed to lock pending_approvals: {}", err);
                        }
                    }
                }
                SessionCommand::Shutdown { .. } => {
                    tracing::debug!("SessionActor {} shutting down", self.session_id);
                    break;
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn execute_process_message(
        session_id: String,
        app_state: Arc<AppState>,
        events_tx: broadcast::Sender<SessionEvent>,
        pending_approvals: Arc<
            std::sync::Mutex<
                HashMap<String, tokio::sync::oneshot::Sender<ToolApprovalResponsePayload>>,
            >,
        >,
        approved_mcp_tools: Arc<std::sync::Mutex<HashSet<String>>>,
        message: String,
        mode_str: String,
        attachments: Vec<Value>,
        thinking_budget: u8,
        agent_id: Option<String>,
        agent_mode: Option<String>,
        skip_web_search: bool,
    ) {
        let mode = match mode_str.as_str() {
            "chat" => Mode::Chat,
            "search" => Mode::Search,
            "search_agentic" => Mode::SearchAgentic,
            "agent" => Mode::Agent,
            _ => Mode::Chat,
        };

        let mut agent_state = AgentState::new(session_id.clone(), message.clone(), mode);
        agent_state.search_attachments = attachments;
        agent_state.thinking_budget = thinking_budget;
        agent_state.agent_id = agent_id.clone();
        agent_state.agent_mode = crate::graph::state::AgentMode::from_str(agent_mode.as_deref());
        agent_state.skip_web_search = skip_web_search;

        let _ = events_tx.send(SessionEvent::Status {
            session_id: session_id.clone(),
            message: "Processing started".into(),
        });

        let config = app_state
            .config
            .load_config()
            .unwrap_or_else(|_| serde_json::json!({}));

        let mut streamer = GraphStreamer::Actor {
            session_id: session_id.clone(),
            tx: events_tx.clone(),
        };

        let mut node_ctx = crate::graph::NodeContext {
            app_state: &app_state,
            config: &config,
            sender: &mut streamer,
            pending_approvals,
            approved_mcp_tools,
        };

        if let Err(e) = app_state
            .graph_runtime
            .run(&mut agent_state, &mut node_ctx, None)
            .await
        {
            let _ = events_tx.send(SessionEvent::Error {
                session_id: session_id.clone(),
                message: e.to_string(),
            });
        }

        let assistant_output = agent_state.output.clone().unwrap_or_default();
        let timestamp = chrono::Utc::now().to_rfc3339();

        let assistant_kwargs = serde_json::json!({
            "timestamp": timestamp,
            "mode": mode_str.clone(),
            "thinking_budget": thinking_budget,
            "agent_id": agent_id,
            "agent_mode": agent_mode,
        });

        if let Err(e) = app_state
            .history
            .add_message(&session_id, "ai", &assistant_output, Some(assistant_kwargs))
            .await
        {
            tracing::error!("Failed to save actor message to history: {}", e);
        }

        let text_model_id = app_state
            .models
            .resolve_agent_model_id(agent_id.as_deref())
            .ok()
            .flatten()
            .unwrap_or_else(|| "default".to_string());

        let embedding_model_id = app_state
            .models
            .resolve_embedding_model_id()
            .ok()
            .flatten()
            .unwrap_or_else(|| "default".to_string());

        let legacy_enabled = app_state.is_redesign_enabled("legacy_memory");

        let message_text_for_ingest = message.clone();

        let _ = events_tx.send(SessionEvent::MemoryGeneration {
            session_id: session_id.clone(),
            status: "started".into(),
        });

        // Use tokio::spawn to not block the actor, or just await it. Awaiting is fine here since it's already in a spawned task.
        let _ = app_state
            .memory_adapter
            .ingest_interaction(
                &session_id,
                &message_text_for_ingest,
                &assistant_output,
                &app_state.llm,
                &text_model_id,
                &embedding_model_id,
                legacy_enabled,
            )
            .await;

        let _ = events_tx.send(SessionEvent::MemoryGeneration {
            session_id: session_id.clone(),
            status: "completed".into(),
        });

        let _ = events_tx.send(SessionEvent::GenerationComplete {
            session_id: session_id.clone(),
        });
    }
}
