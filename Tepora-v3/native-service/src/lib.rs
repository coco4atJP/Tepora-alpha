//! Genuine HTTP host for an explicitly developmental offline workspace slice.
//! The backend boundary contains domain operations, never raw HTTP or a proxy.
use serde_json::Value;
use std::fmt;
use tokio::sync::mpsc;

pub mod http;
pub mod workspace;
pub const VERSION: &str = "3.0.0-beta.11";
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
    pub blocked: bool,
}
impl ApiError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            blocked: false,
        }
    }
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(503, message)
    }
}
impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for ApiError {}

#[derive(Debug, Clone)]
pub enum Operation {
    Bootstrap,
    Agent,
    Dialogue,
    Sessions,
    Session {
        id: String,
        before: Option<f64>,
        limit: f64,
    },
    MemoryCreate {
        body: Value,
    },
    MemoryPatch {
        id: String,
        body: Value,
    },
    MemoryDelete {
        id: String,
    },
    Artifacts,
    ArtifactEdit {
        id: String,
        body: Value,
    },
    ArtifactRevisions {
        id: String,
        version: Option<u64>,
    },
    RenderArtifact {
        id: String,
        version: Option<u64>,
    },
    Export,
    Import {
        body: Value,
    },
    Presence {
        body: Value,
    },
    Doctor,
}
#[derive(Debug, Clone)]
pub enum Reply {
    Json(Value),
    Render {
        kind: String,
        content: String,
        interactive: bool,
    },
}
#[derive(Debug, Clone, Copy)]
pub struct EventRequest {
    pub since: u64,
    pub reconnect: bool,
}
#[derive(Debug, Clone)]
pub struct ServiceEvent {
    pub seq: Option<u64>,
    pub event_type: String,
    pub data: Value,
    pub at: Option<String>,
}
impl ServiceEvent {
    pub fn value(&self) -> Value {
        let mut v = serde_json::json!({"seq":self.seq,"type":self.event_type,"data":self.data});
        if let Some(at) = &self.at {
            v["at"] = Value::String(at.clone());
        }
        v
    }
}
pub struct EventSubscription {
    pub id: u64,
    pub initial: Vec<ServiceEvent>,
    pub receiver: mpsc::Receiver<ServiceEvent>,
}
/// Each implementation owns exactly one state authority. subscribe must choose
/// replay/snapshot AND register its bounded live channel atomically with writes.
/// Full live queues must be disconnected/unregistered instead of growing.
pub trait Backend: Send + Sync + 'static {
    fn execute(&self, operation: Operation) -> Result<Reply, ApiError>;
    fn subscribe(&self, request: EventRequest) -> Result<EventSubscription, ApiError>;
    fn unsubscribe(&self, id: u64);
    fn stop(&self) -> Result<(), ApiError>;
    fn shutdown(&self) -> Result<(), ApiError>;
}
