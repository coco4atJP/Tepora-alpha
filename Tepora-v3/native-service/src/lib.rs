//! Genuine HTTP host for an explicitly developmental offline workspace slice.
//! The backend boundary contains domain operations, never raw HTTP or a proxy.
use serde_json::Value;
use std::fmt;
use tokio::sync::mpsc;

pub mod agent;
pub mod capabilities;
pub mod http;
pub mod network;
pub mod provider;
pub mod model_catalog;
pub mod runtime_discovery;
pub mod setup;
pub mod sandbox;
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
    Display { action: workspace::VisualAction, body: Value },
    Avatar { action: workspace::VisualAction, body: Value },
    ModelCatalogSearch { query:String },
    ModelCatalogImport { body:Value },
    ModelCatalogRefresh,
    Setup,
    SetupScan,
    SetupDismiss,
    SetupSelect { body:Value },
    SetupInstall { body:Value },
    SetupStop,
    SetupInstallHelp,
    RuntimeDiscover,
    DialoguePersonas,
    DialoguePersonasSave { body: Value },
    SettingsPatch { body: Value },
    SearchKey { body: Value },
    InputsStage {
        body: Value,
    },
    InputDelete {
        id: String,
    },
    SessionAccept {
        id: String,
    },
    SessionFiles {
        id: String,
    },
    SessionDownload {
        id: String,
        path: String,
    },
    AgentInput {
        body: Value,
    },
    AgentSpawn {
        body: Value,
    },
    SessionMessage {
        id: String,
        body: Value,
    },
    SessionStop {
        id: String,
    },
    SessionResume {
        id: String,
    },
    AgentSettings,
    AgentSettingsPatch {
        body: Value,
    },
    Approvals,
    ApprovalsDecide {
        body: Value,
    },
    ApprovalDecide {
        id: String,
        body: Value,
    },
    Capabilities,
    CapabilitiesSave {
        body: Value,
    },
    CapabilityKey {
        id: String,
        body: Value,
    },
    Providers,
    ProvidersSave {
        body: Value,
    },
    ProviderKey {
        id: String,
        body: Value,
    },
    ProviderProbe {
        id: String,
    },
    Network,
    NetworkPatch {
        body: Value,
    },
    StopAll,
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
    Download {
        bytes: Vec<u8>,
        disposition: String,
    },
    Json(Value),
    Render {
        kind: String,
        /// Core-internal JSON codec text; decode exactly once at the HTTP UTF-8 boundary.
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
    /// Source setup/install rejects restricted mode before consuming its body.
    fn setup_install_permitted(&self)->Result<(),ApiError> {Ok(())}
    /// Setup/catalog network waits run directly on the async request path.
    /// Implementations must return owned state and never retain State guards.
    fn execute_setup(&self,operation:Operation,cancellation:network::RequestCancellation)->std::pin::Pin<Box<dyn std::future::Future<Output=Result<Reply,ApiError>>+Send+'static>> {
        let result=if let Some(error)=cancellation.error(){Err(error.into())}else{self.execute(operation)};
        Box::pin(async move {result})
    }
    fn subscribe(&self, request: EventRequest) -> Result<EventSubscription, ApiError>;
    fn unsubscribe(&self, id: u64);
    fn stop(&self) -> Result<(), ApiError>;
    /// Snapshot the current probe batch before waiting for bounded admission.
    /// Native Stop rotates and cancels the old batch, including queued requests.
    fn probe_cancellation(&self) -> network::RequestCancellation {
        network::RequestCancellation::new()
    }
    fn execute_probe(
        &self,
        id: String,
        cancellation: network::RequestCancellation,
    ) -> Result<Reply, ApiError> {
        if let Some(error) = cancellation.error() {
            return Err(error.into());
        }
        self.execute(Operation::ProviderProbe { id })
    }
    /// Stop accepting effects and cancel interruptible work before HTTP drains.
    /// Keep the durable owner open until shutdown() has drained real receipts.
    fn begin_shutdown(&self) -> Result<(), ApiError> {
        Ok(())
    }
    fn shutdown(&self) -> Result<(), ApiError>;
}
