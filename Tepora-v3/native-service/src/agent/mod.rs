//! Single-owner native runtime host. Values here use the core's JSON codec.
//! Effects never own a database connection or a mutable runtime engine.
pub mod approvals;
pub mod context;
pub mod coordinator;
pub mod decisions;
pub mod files;
pub mod host;
pub mod host_decisions;
pub(crate) mod input_attachments;
pub mod host_runtime;
pub mod metacognition;
pub mod policy;
pub mod process_host;
pub mod processes;
pub mod receipts;
pub mod scheduler;
pub mod tools;
pub mod web;
pub mod web_host;
pub use coordinator::{AgentCoordinator, AgentHandle, CloseTicket, EventSink};

use crate::{network::RequestCancellation, ApiError};
use serde_json::{json, Value};
use std::{future::Future, pin::Pin};

#[derive(Clone, Debug)]
pub enum AgentRequest {
    Initialize,
    Input {
        body: Value,
    },
    Spawn {
        body: Value,
    },
    Send {
        id: String,
        body: Value,
    },
    Stop {
        id: String,
        reason: String,
        rearm_main: bool,
    },
    StopAll {
        reason: String,
    },
    Resume {
        id: String,
    },
    DeleteSession {
        id: String,
    },
    SetupContext,
    ActivateSetup {
        commit: crate::setup::SelectionCommit,
    },
    DecideApproval {
        id: String,
        allow: bool,
    },
    DecideApprovals {
        ids: Vec<String>,
        allow: bool,
    },
    Configure {
        patch: Value,
    },
    RefreshPrompts,
}

#[derive(Clone, Debug)]
pub struct Admission {
    pub value: Value,
    /// Runtime notifications caused by the synchronous state mutation. They run
    /// after its entire action batch, never recursively inside a reducer.
    pub events: Vec<Value>,
}
impl Admission {
    pub fn new(value: Value) -> Self {
        Self {
            value,
            events: vec![],
        }
    }
}

/// A direct user request may need owned filesystem work before acceptance.
/// Prepared commands and their result never come from caller-supplied grants.
pub enum RequestPlan {
    Ready(Admission),
    Prepare { session_id: String, command: Value },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EffectNamespace {
    Runtime,
    Execution,
    /// Run-owned host work that never advances either reducer.
    Auxiliary,
    /// Pre-run request preparation; no reducer lease or reducer completion.
    Admission,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct EffectScope {
    pub service_id: u64,
    pub session_id: String,
    pub run_epoch: u64,
    pub generation: Option<u64>,
    pub namespace: EffectNamespace,
    pub operation_id: String,
}
#[derive(Clone)]
pub struct EffectContext {
    pub scope: EffectScope,
    pub cancellation: RequestCancellation,
    pub events: EventSink,
}

#[derive(Clone, Debug)]
pub struct EffectResult {
    pub value: Value,
    pub facts: Value,
    pub events: Vec<Value>,
}
impl EffectResult {
    pub fn new(value: Value) -> Self {
        Self {
            value,
            facts: json!({}),
            events: vec![],
        }
    }
}
#[derive(Clone, Debug)]
pub struct EffectError {
    /// The engine's lossless error schema, including kind/retryAfterMs/limit.
    /// Keep secrets and upstream bodies out of this public-safe value.
    pub error: Value,
    pub aborted: bool,
}
impl EffectError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            error: json!({"message":message.into()}),
            aborted: false,
        }
    }
    pub fn cancelled(not_executed: bool) -> Self {
        Self {
            error: json!({"name":"AbortError","message":"The session was stopped","notExecuted":not_executed}),
            aborted: true,
        }
    }
}
impl From<ApiError> for EffectError {
    fn from(e: ApiError) -> Self {
        Self {
            error: json!({"message":e.message,"status":e.status,"blocked":e.blocked}),
            aborted: false,
        }
    }
}
pub type EffectFuture =
    Pin<Box<dyn Future<Output = Result<EffectResult, EffectError>> + Send + 'static>>;
pub enum EffectTask {
    Ready(EffectResult),
    /// Trusted host commands registered before the parent ready result is applied.
    ReadyWithAuxiliary(EffectResult, Vec<Value>),
    Async(EffectFuture),
}
impl EffectTask {
    pub fn ready(value: Value) -> Self {
        Self::Ready(EffectResult::new(value))
    }
}

/// Every method is called on the dedicated coordinator thread, in FIFO order.
/// Implementations may hold Workspace's state lock only for synchronous work.
/// Async futures must capture owned snapshots and return proposed results;
/// persistence belongs in complete_effect or a scope-guarded EventSink request.
///
/// Unsupported configured hooks, routes or effects must return an explicit
/// error. An identity hook result is valid only when no hook applies.
pub trait AgentHost: Send + Sync + 'static {
    fn facts(&self) -> Result<Value, ApiError>;
    fn request(&self, request: &AgentRequest) -> Result<Admission, ApiError>;
    fn setup_context(&self, _busy: bool) -> Result<Value, ApiError> {
        Err(ApiError::unavailable("Native setup is not integrated"))
    }
    fn activate_setup(&self, _commit: &crate::setup::SelectionCommit) -> Result<(), ApiError> {
        Err(ApiError::unavailable("Native setup is not integrated"))
    }
    /// Validate dedup identity before resolving attachments or starting IO.
    fn request_key(&self, _request: &AgentRequest) -> Result<Option<String>, ApiError> {
        Ok(None)
    }
    fn plan_request(&self, request: &AgentRequest) -> Result<RequestPlan, ApiError> {
        self.request(request).map(RequestPlan::Ready)
    }
    fn complete_request(
        &self,
        _context: &EffectContext,
        _request: &AgentRequest,
        _result: EffectResult,
    ) -> Result<Admission, ApiError> {
        Err(ApiError::new(
            500,
            "Native request preparation is not implemented",
        ))
    }
    fn session(&self, id: &str) -> Result<Value, ApiError>;
    /// The coordinator supplies the whole ordered batch, including lifecycle
    /// actions. The host handles only its state/resource side of those actions.
    /// The host must not close Workspace/SQLite on closeResources; close() runs
    /// after all actual effects and receipt writes have drained.
    fn apply_runtime_actions(&self, actions: &[Value]) -> Result<Vec<Value>, ApiError>;
    fn start_effect(
        &self,
        context: &EffectContext,
        command: &Value,
    ) -> Result<EffectTask, EffectError>;
    /// Called only while the operation is still current. afterTool and
    /// recordTools remain valid during cancellation drain; afterTool must skip
    /// hooks then and preserve the actual dispatched tool outcome.
    fn complete_effect(
        &self,
        _context: &EffectContext,
        _command: &Value,
        result: EffectResult,
    ) -> Result<EffectResult, EffectError> {
        Ok(result)
    }
    fn complete_auxiliary(
        &self,
        _context: &EffectContext,
        _command: &Value,
        _result: Result<EffectResult, EffectError>,
    ) -> Result<(), ApiError> {
        Ok(())
    }
    /// Stream, route, progress and provider-cache callbacks are validated here
    /// immediately before the host can change state. Never persist in a future.
    /// Tool-specific state request made from an async effect. The actor checks
    /// its parent operation immediately before admission and queues any wakes.
    fn scoped_request(&self, _scope: &EffectScope, _request: Value) -> Result<Admission, ApiError> {
        Err(ApiError::unavailable(
            "Native scoped state request is not implemented",
        ))
    }
    fn stream(&self, scope: &EffectScope, event: Value) -> Result<(), ApiError>;
    /// Close provider/approval resources after drain. Workspace closes later.
    fn close(&self) -> Result<(), ApiError>;
}
