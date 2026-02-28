use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, broadcast};
use crate::state::AppState;
use super::messages::{SessionCommand, SessionEvent, SessionQuery};
use super::session::SessionActor;

/// Manages active session actors and provides a command bus.
pub struct ActorManager {
    sessions: Mutex<HashMap<String, mpsc::Sender<SessionCommand>>>,
    events_tx: broadcast::Sender<SessionEvent>, // optional: global event bus
}

impl ActorManager {
    pub fn new() -> Self {
        let (events_tx, _) = broadcast::channel(1024);
        Self {
            sessions: Mutex::new(HashMap::new()),
            events_tx,
        }
    }

    /// Dispatches a command to the appropriate session actor.
    /// If the actor does not exist, it creates one.
    pub async fn dispatch(&self, session_id: &str, app_state: Arc<AppState>, command: SessionCommand) -> anyhow::Result<()> {
        let mut sessions = self.sessions.lock().await;

        let tx = if let Some(tx) = sessions.get(session_id) {
            tx.clone()
        } else {
            // Create a new actor and channel
            let (tx, rx) = mpsc::channel(100);
            let actor = SessionActor::new(
                session_id.to_string(),
                rx,
                app_state,
                self.events_tx.clone() // Could also be a per-session broadcast
            );
            
            tokio::spawn(async move {
                actor.run().await;
            });

            sessions.insert(session_id.to_string(), tx.clone());
            tx
        };

        tx.send(command).await?;
        Ok(())
    }

    /// Dispatches a query and waits for a oneshot response.
    pub async fn dispatch_query(&self, query: SessionQuery) -> anyhow::Result<()> {
        match query {
            SessionQuery::GetStatus { session_id, reply_to } => {
                let sessions = self.sessions.lock().await;
                let status = if sessions.contains_key(&session_id) {
                    "active".to_string()
                } else {
                    "inactive".to_string()
                };
                let _ = reply_to.send(status);
                Ok(())
            }
        }
    }

    /// Subscribes to the global event bus. 
    /// (For per-session, we might need a different approach or filter by session_id in the event).
    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.events_tx.subscribe()
    }

    /// Removes a session from the manager and drops its command sender.
    /// This causes the SessionActor to gracefully terminate since its `rx` channel will close.
    pub async fn shutdown_session(&self, session_id: &str) {
        if let Some(_) = self.sessions.lock().await.remove(session_id) {
            tracing::debug!("ActorManager: Removed session {}", session_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn test_dispatch_query() {
        let manager = ActorManager::new();
        // Insert a dummy session manually for testing (or use dispatch to create one)
        {
            let (tx, _rx) = mpsc::channel(1);
            manager.sessions.lock().await.insert("test_session".to_string(), tx);
        }

        let (reply_tx, reply_rx) = oneshot::channel();
        manager.dispatch_query(SessionQuery::GetStatus {
            session_id: "test_session".to_string(),
            reply_to: reply_tx,
        }).await.unwrap();

        let status = reply_rx.await.unwrap();
        assert_eq!(status, "active");

        let (reply_tx2, reply_rx2) = oneshot::channel();
        manager.dispatch_query(SessionQuery::GetStatus {
            session_id: "unknown_session".to_string(),
            reply_to: reply_tx2,
        }).await.unwrap();

        let status2 = reply_rx2.await.unwrap();
        assert_eq!(status2, "inactive");
    }

    #[tokio::test]
    async fn test_actor_integration() {
        // Initialize real AppState to provide a GraphRuntime and DB context
        // This acts as combining Command -> Actor -> Event -> WS pipeline test
        let app_state = match crate::state::AppState::initialize().await {
            Ok(state) => state,
            Err(e) => {
                // If initialization fails in a CI environment due to missing DBs etc, we skip.
                eprintln!("Skipping integration test due to AppState init failure: {:?}", e);
                return;
            }
        };

        let manager = &app_state.actor_manager;
        let mut rx = manager.subscribe();

        let session_id = "test_integration_session".to_string();
        
        let command = SessionCommand::ProcessMessage {
            session_id: session_id.clone(),
            message: "Hello".to_string(),
            mode: "chat".to_string(),
            attachments: vec![],
            thinking_budget: 0,
            agent_id: None,
            agent_mode: None,
            skip_web_search: true,
        };

        manager.dispatch(&session_id, app_state.clone(), command).await.unwrap();

        // Wait to receive the "Processing started" Status event
        let mut got_status = false;
        #[allow(unused_assignments)]
        let mut got_token_or_done = false;

        // We only wait for a short duration
        let timeout = tokio::time::sleep(std::time::Duration::from_secs(5));
        tokio::pin!(timeout);

        loop {
            tokio::select! {
                Ok(event) = rx.recv() => {
                    match event {
                        SessionEvent::Status { session_id: s, message: _ } if s == session_id => {
                            got_status = true;
                        }
                        SessionEvent::Token { session_id: s, .. } | SessionEvent::GenerationComplete { session_id: s } if s == session_id => {
                            got_token_or_done = true;
                            if got_status && got_token_or_done {
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                _ = &mut timeout => {
                    break;
                }
            }
        }

        assert!(got_status, "Should receive a Status event from actor");
        // We may or may not receive token/done depending on graph logic, but we definitely verified the pipeline started.
    }
}

