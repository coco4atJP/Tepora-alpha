use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{broadcast, mpsc, Mutex};

use crate::state::AppState;

use super::messages::{SessionCommand, SessionEvent, SessionQuery};
use super::session::SessionActor;

const DEFAULT_SESSION_CHANNEL_CAPACITY: usize = 64;
const DEFAULT_MAX_SESSIONS: usize = 32;
const DEFAULT_SESSION_TTL_SECS: u64 = 30 * 60;
const DEFAULT_GC_INTERVAL_SECS: u64 = 5 * 60;

#[derive(Debug, Clone)]
pub struct ActorManagerConfig {
    pub session_channel_capacity: usize,
    pub max_sessions: usize,
    pub session_ttl: Duration,
    pub gc_interval: Duration,
}

impl Default for ActorManagerConfig {
    fn default() -> Self {
        Self {
            session_channel_capacity: DEFAULT_SESSION_CHANNEL_CAPACITY,
            max_sessions: DEFAULT_MAX_SESSIONS,
            session_ttl: Duration::from_secs(DEFAULT_SESSION_TTL_SECS),
            gc_interval: Duration::from_secs(DEFAULT_GC_INTERVAL_SECS),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ActorDispatchError {
    #[error("session '{0}' is busy")]
    SessionBusy(String),
    #[error("maximum active sessions reached ({max_sessions})")]
    TooManySessions { max_sessions: usize },
    #[error("failed to dispatch command for session '{session_id}': {reason}")]
    Internal { session_id: String, reason: String },
}

#[derive(Clone)]
struct SessionHandle {
    tx: mpsc::Sender<SessionCommand>,
    last_active: Instant,
}

/// Manages active session actors and provides a command bus.
pub struct ActorManager {
    sessions: Mutex<HashMap<String, SessionHandle>>,
    events_tx: broadcast::Sender<SessionEvent>,
    config: ActorManagerConfig,
    gc_started: AtomicBool,
}

impl Default for ActorManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ActorManager {
    pub fn new() -> Self {
        Self::new_with_config(ActorManagerConfig::default())
    }

    pub fn new_with_config(config: ActorManagerConfig) -> Self {
        let session_channel_capacity = config.session_channel_capacity.max(1);
        let max_sessions = config.max_sessions.max(1);
        let gc_interval = config.gc_interval.max(Duration::from_millis(1));
        let session_ttl = config.session_ttl.max(gc_interval);
        let (events_tx, _) = broadcast::channel(1024);
        Self {
            sessions: Mutex::new(HashMap::new()),
            events_tx,
            config: ActorManagerConfig {
                session_channel_capacity,
                max_sessions,
                session_ttl,
                gc_interval,
            },
            gc_started: AtomicBool::new(false),
        }
    }

    pub fn config(&self) -> &ActorManagerConfig {
        &self.config
    }

    pub fn start_gc(self: Arc<Self>) {
        if self.gc_started.swap(true, Ordering::SeqCst) {
            return;
        }

        let gc_interval = self.config.gc_interval;
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(gc_interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                ticker.tick().await;
                let removed = self.reap_expired_sessions().await;
                if removed > 0 {
                    tracing::debug!(removed, "ActorManager GC removed expired session actors");
                }
            }
        });
    }

    /// Dispatches a command to the appropriate session actor.
    /// If the actor does not exist, it creates one.
    pub async fn dispatch(
        &self,
        session_id: &str,
        app_state: Arc<AppState>,
        command: SessionCommand,
    ) -> Result<(), ActorDispatchError> {
        let _ = self.reap_expired_sessions().await;

        let tx = self
            .ensure_session_sender(session_id, app_state.clone())
            .await?;
        match tx.try_send(command) {
            Ok(()) => Ok(()),
            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                Err(ActorDispatchError::SessionBusy(session_id.to_string()))
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(command)) => {
                {
                    let mut sessions = self.sessions.lock().await;
                    sessions.remove(session_id);
                }

                let retry_tx = self.ensure_session_sender(session_id, app_state).await?;
                match retry_tx.try_send(command) {
                    Ok(()) => Ok(()),
                    Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                        Err(ActorDispatchError::SessionBusy(session_id.to_string()))
                    }
                    Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                        Err(ActorDispatchError::Internal {
                            session_id: session_id.to_string(),
                            reason: "session command channel is closed".to_string(),
                        })
                    }
                }
            }
        }
    }

    async fn ensure_session_sender(
        &self,
        session_id: &str,
        app_state: Arc<AppState>,
    ) -> Result<mpsc::Sender<SessionCommand>, ActorDispatchError> {
        let mut sessions = self.sessions.lock().await;

        if let Some(handle) = sessions.get_mut(session_id) {
            handle.last_active = Instant::now();
            return Ok(handle.tx.clone());
        }

        if sessions.len() >= self.config.max_sessions {
            return Err(ActorDispatchError::TooManySessions {
                max_sessions: self.config.max_sessions,
            });
        }

        let (tx, rx) = mpsc::channel(self.config.session_channel_capacity);
        let actor = SessionActor::new(
            session_id.to_string(),
            rx,
            app_state,
            self.events_tx.clone(), // Could also be a per-session broadcast
        );

        tokio::spawn(async move {
            actor.run().await;
        });

        sessions.insert(
            session_id.to_string(),
            SessionHandle {
                tx: tx.clone(),
                last_active: Instant::now(),
            },
        );

        Ok(tx)
    }

    pub async fn reap_expired_sessions(&self) -> usize {
        let now = Instant::now();
        let ttl = self.config.session_ttl;
        let mut sessions = self.sessions.lock().await;

        let expired: Vec<String> = sessions
            .iter()
            .filter_map(|(session_id, handle)| {
                if now.duration_since(handle.last_active) >= ttl {
                    Some(session_id.clone())
                } else {
                    None
                }
            })
            .collect();

        for session_id in &expired {
            sessions.remove(session_id);
        }

        expired.len()
    }

    pub async fn active_session_count(&self) -> usize {
        self.sessions.lock().await.len()
    }

    /// Dispatches a query and waits for a oneshot response.
    pub async fn dispatch_query(&self, query: SessionQuery) -> anyhow::Result<()> {
        match query {
            SessionQuery::GetStatus {
                session_id,
                reply_to,
            } => {
                let _ = self.reap_expired_sessions().await;
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
        if self.sessions.lock().await.remove(session_id).is_some() {
            tracing::debug!("ActorManager: Removed session {}", session_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use tokio::sync::oneshot;

    async fn init_state_or_skip() -> Option<Arc<AppState>> {
        match crate::state::AppState::initialize().await {
            Ok(state) => Some(state),
            Err(e) => {
                eprintln!("Skipping actor test due to AppState init failure: {:?}", e);
                None
            }
        }
    }

    #[tokio::test]
    async fn test_dispatch_query() {
        let manager = ActorManager::new();
        {
            let (tx, _rx) = mpsc::channel(1);
            manager.sessions.lock().await.insert(
                "test_session".to_string(),
                SessionHandle {
                    tx,
                    last_active: Instant::now(),
                },
            );
        }

        let (reply_tx, reply_rx) = oneshot::channel();
        manager
            .dispatch_query(SessionQuery::GetStatus {
                session_id: "test_session".to_string(),
                reply_to: reply_tx,
            })
            .await
            .unwrap();

        let status = reply_rx.await.unwrap();
        assert_eq!(status, "active");

        let (reply_tx2, reply_rx2) = oneshot::channel();
        manager
            .dispatch_query(SessionQuery::GetStatus {
                session_id: "unknown_session".to_string(),
                reply_to: reply_tx2,
            })
            .await
            .unwrap();

        let status2 = reply_rx2.await.unwrap();
        assert_eq!(status2, "inactive");
    }

    #[tokio::test]
    async fn test_dispatch_multiple_sessions() {
        let Some(app_state) = init_state_or_skip().await else {
            return;
        };

        let manager = &app_state.actor_manager;
        for session_id in ["session_a", "session_b", "session_c"] {
            manager
                .dispatch(
                    session_id,
                    app_state.clone(),
                    SessionCommand::StopGeneration {
                        session_id: session_id.to_string(),
                    },
                )
                .await
                .unwrap();
        }

        assert!(
            manager.active_session_count().await >= 3,
            "Expected three or more active sessions"
        );
    }

    #[tokio::test]
    async fn test_dispatch_returns_busy_when_queue_is_full() {
        let Some(app_state) = init_state_or_skip().await else {
            return;
        };

        let manager = ActorManager::new_with_config(ActorManagerConfig {
            session_channel_capacity: 64,
            max_sessions: 32,
            session_ttl: Duration::from_secs(60),
            gc_interval: Duration::from_secs(60),
        });

        let (tx, _rx_hold) = mpsc::channel(64);
        manager.sessions.lock().await.insert(
            "stress_session".to_string(),
            SessionHandle {
                tx,
                last_active: Instant::now(),
            },
        );

        for idx in 0..64 {
            manager
                .dispatch(
                    "stress_session",
                    app_state.clone(),
                    SessionCommand::StopGeneration {
                        session_id: format!("stress_{idx}"),
                    },
                )
                .await
                .unwrap();
        }

        let err = manager
            .dispatch(
                "stress_session",
                app_state,
                SessionCommand::StopGeneration {
                    session_id: "stress_overflow".to_string(),
                },
            )
            .await
            .expect_err("65th command must fail-fast when queue is full");

        assert!(matches!(err, ActorDispatchError::SessionBusy(ref id) if id == "stress_session"));
    }

    #[tokio::test]
    async fn test_dispatch_rejects_when_max_sessions_reached() {
        let Some(app_state) = init_state_or_skip().await else {
            return;
        };

        let manager = ActorManager::new_with_config(ActorManagerConfig {
            session_channel_capacity: 64,
            max_sessions: 1,
            session_ttl: Duration::from_secs(60),
            gc_interval: Duration::from_secs(60),
        });

        manager
            .dispatch(
                "first",
                app_state.clone(),
                SessionCommand::StopGeneration {
                    session_id: "first".to_string(),
                },
            )
            .await
            .unwrap();

        let err = manager
            .dispatch(
                "second",
                app_state,
                SessionCommand::StopGeneration {
                    session_id: "second".to_string(),
                },
            )
            .await
            .expect_err("second session should be rejected when limit is 1");

        assert!(matches!(
            err,
            ActorDispatchError::TooManySessions { max_sessions: 1 }
        ));
    }

    #[tokio::test]
    async fn test_reap_expired_sessions() {
        let manager = ActorManager::new_with_config(ActorManagerConfig {
            session_channel_capacity: 64,
            max_sessions: 32,
            session_ttl: Duration::from_millis(50),
            gc_interval: Duration::from_millis(50),
        });

        let (tx_active, _rx_active) = mpsc::channel(1);
        let (tx_expired, _rx_expired) = mpsc::channel(1);
        manager.sessions.lock().await.insert(
            "active".to_string(),
            SessionHandle {
                tx: tx_active,
                last_active: Instant::now(),
            },
        );
        manager.sessions.lock().await.insert(
            "expired".to_string(),
            SessionHandle {
                tx: tx_expired,
                last_active: Instant::now() - Duration::from_millis(120),
            },
        );

        let removed = manager.reap_expired_sessions().await;
        assert_eq!(removed, 1);
        assert_eq!(manager.active_session_count().await, 1);
    }

    #[tokio::test]
    async fn test_gc_loop_evicts_expired_sessions() {
        let manager = Arc::new(ActorManager::new_with_config(ActorManagerConfig {
            session_channel_capacity: 64,
            max_sessions: 32,
            session_ttl: Duration::from_millis(30),
            gc_interval: Duration::from_millis(10),
        }));

        let (tx, _rx) = mpsc::channel(1);
        manager.sessions.lock().await.insert(
            "stale".to_string(),
            SessionHandle {
                tx,
                last_active: Instant::now() - Duration::from_millis(120),
            },
        );

        manager.clone().start_gc();
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(manager.active_session_count().await, 0);
    }

    #[tokio::test]
    async fn test_actor_integration() {
        let Some(app_state) = init_state_or_skip().await else {
            return;
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

        manager
            .dispatch(&session_id, app_state.clone(), command)
            .await
            .unwrap();

        let mut got_status = false;
        #[allow(unused_assignments)]
        let mut got_token_or_done = false;
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
    }
}
