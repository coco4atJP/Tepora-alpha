//! Actor-facing web lifecycle bridge. Configuration and selected credentials are
//! read atomically from Workspace; no effect owns another database connection.
//! Every network hop is checked against the captured binding. Rotation revokes
//! actual request tokens before acknowledgement, including requests paused in
//! DNS. WebTools keeps the ordinary shared page cache across unchanged turns.
use super::{
    decisions::Decisions,
    web::{BrowserRenderer, SecretSnapshot, WebAuthority, WebConfig, WebTools},
    EffectContext, EffectError, EffectResult, EffectTask,
};
use crate::{
    network::{NativeNetwork, RequestCancellation},
    workspace::WorkspaceAccess,
    ApiError,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};

/// Internal-codec snapshot, deliberately without Debug/Serialize. Only the
/// configured Brave credential is selected; unrelated saved keys stay private.
#[derive(Clone, PartialEq, Eq)]
pub struct WebSnapshot {
    pub config: WebConfig,
    brave_key: String,
}
impl WebSnapshot {
    pub fn new(config: WebConfig, brave_key: String) -> Self {
        Self { config, brave_key }
    }
}
pub trait WebState: Send + Sync {
    /// Settings and selected saved/environment key must come from one current
    /// state snapshot. The implementation releases its lock before returning.
    fn web_snapshot(&self) -> Result<WebSnapshot, ApiError>;
}
struct Binding {
    snapshot: WebSnapshot,
    tools: Arc<WebTools>,
    revision: u64,
}
struct Active {
    session: String,
    cancellation: RequestCancellation,
}
#[derive(Default)]
struct Memory {
    closed: bool,
    revision: u64,
    next: u64,
    binding: Option<Binding>,
    active: HashMap<u64, Active>,
}
struct Inner {
    source: Arc<dyn WebState>,
    network: NativeNetwork,
    decisions: Option<Arc<Decisions>>,
    browser: Option<Arc<dyn BrowserRenderer>>,
    memory: Mutex<Memory>,
}
#[derive(Clone)]
pub struct WebHost {
    inner: Arc<Inner>,
}
impl WebHost {
    pub fn new(
        state: WorkspaceAccess,
        network: NativeNetwork,
        decisions: Option<Arc<Decisions>>,
        browser: Option<Arc<dyn BrowserRenderer>>,
    ) -> Self {
        Self::with_state(Arc::new(state), network, decisions, browser)
    }
    pub fn with_state(
        source: Arc<dyn WebState>,
        network: NativeNetwork,
        decisions: Option<Arc<Decisions>>,
        browser: Option<Arc<dyn BrowserRenderer>>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                source,
                network,
                decisions,
                browser,
                memory: Mutex::default(),
            }),
        }
    }
    /// Call after a successful settings/key commit, before acknowledging it.
    /// The guard also compares actual state, so a queued stale effect cannot
    /// dispatch even if the caller has not reached this notification yet.
    pub fn invalidate(&self) {
        let mut m = lock(&self.inner.memory);
        revoke(&mut m);
    }
    pub fn cancel_session(&self, id: &str) {
        let m = lock(&self.inner.memory);
        for op in m.active.values().filter(|op| op.session == id) {
            op.cancellation.cancel();
        }
    }
    pub fn cancel_all(&self) {
        let m = lock(&self.inner.memory);
        for op in m.active.values() {
            op.cancellation.cancel();
        }
    }
    pub fn close(&self) {
        let mut m = lock(&self.inner.memory);
        m.closed = true;
        revoke(&mut m);
    }
    pub fn active_count(&self) -> usize {
        lock(&self.inner.memory).active.len()
    }
    pub fn start(
        &self,
        context: &EffectContext,
        name: &str,
        args: Value,
    ) -> Result<EffectTask, EffectError> {
        self.start_for(
            &context.scope.session_id,
            context.cancellation.clone(),
            name,
            args,
        )
    }
    fn start_for(
        &self,
        session: &str,
        caller: RequestCancellation,
        name: &str,
        args: Value,
    ) -> Result<EffectTask, EffectError> {
        if caller.is_cancelled() {
            return Err(EffectError::cancelled(true));
        }
        if !matches!(name, "web_search" | "web_fetch") {
            return Err(EffectError::new("Native web tool is not implemented"));
        }
        let snapshot = self.inner.source.web_snapshot()?;
        let (tools, lease) = {
            let mut m = lock(&self.inner.memory);
            if m.closed {
                return Err(ApiError::unavailable("Web tools are closed").into());
            }
            if m.binding.as_ref().is_none_or(|b| b.snapshot != snapshot) {
                revoke(&mut m);
                let revision = m.revision;
                let authority = Arc::new(Authority {
                    inner: Arc::downgrade(&self.inner),
                    expected: snapshot.clone(),
                    revision,
                });
                let tools = Arc::new(
                    WebTools::new(
                        self.inner.network.clone(),
                        snapshot.config.clone(),
                        SecretSnapshot::new(snapshot.brave_key.clone()),
                        self.inner.browser.clone(),
                        self.inner.decisions.clone(),
                        17,
                    )
                    .with_authority(authority),
                );
                m.binding = Some(Binding {
                    snapshot,
                    tools,
                    revision,
                });
            }
            let binding = m.binding.as_ref().unwrap();
            let tools = binding.tools.clone();
            let revision = binding.revision;
            m.next = m.next.wrapping_add(1);
            let id = m.next;
            let cancellation = RequestCancellation::new();
            m.active.insert(
                id,
                Active {
                    session: session.into(),
                    cancellation: cancellation.clone(),
                },
            );
            (
                tools,
                Lease {
                    inner: self.inner.clone(),
                    id,
                    revision,
                    cancellation,
                },
            )
        };
        let name = name.to_owned();
        Ok(EffectTask::Async(Box::pin(async move {
            if caller.is_cancelled() {
                return Err(EffectError::cancelled(true));
            }
            if lease.cancellation.is_cancelled() {
                return Err(lease.cancel_error(true));
            }
            tools.check_authority().map_err(|mut e| {
                e.error["notExecuted"] = json!(true);
                e
            })?;
            let result = tokio::select! {
                biased;
                _=caller.cancelled()=>{lease.cancellation.cancel();return Err(EffectError::cancelled(false));},
                _=lease.cancellation.cancelled()=>return Err(lease.cancel_error(false)),
                result=tools.execute(&name,&args,&lease.cancellation)=>result,
            };
            if caller.is_cancelled() {
                return Err(EffectError::cancelled(false));
            }
            if lease.cancellation.is_cancelled() || !lease.current() {
                return Err(lease.cancel_error(false));
            }
            // This includes cached results and synchronous extraction that
            // finished while an owner changed the binding on another thread.
            tools.check_authority()?;
            result.map(|result| EffectResult::new(json!({"result":result})))
        })))
    }
}
fn revoke(m: &mut Memory) {
    m.revision = m.revision.wrapping_add(1);
    m.binding = None;
    for op in m.active.values() {
        op.cancellation.cancel();
    }
}
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}
struct Lease {
    inner: Arc<Inner>,
    id: u64,
    revision: u64,
    cancellation: RequestCancellation,
}
impl Lease {
    fn current(&self) -> bool {
        let m = lock(&self.inner.memory);
        !m.closed && m.revision == self.revision
    }
    fn cancel_error(&self, not_executed: bool) -> EffectError {
        if self.current() {
            EffectError::cancelled(not_executed)
        } else {
            changed(not_executed)
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.cancellation.cancel();
        lock(&self.inner.memory).active.remove(&self.id);
    }
}
struct Authority {
    inner: Weak<Inner>,
    expected: WebSnapshot,
    revision: u64,
}
impl WebAuthority for Authority {
    fn check(&self) -> Result<(), EffectError> {
        let inner = self.inner.upgrade().ok_or_else(|| changed(false))?;
        {
            let m = lock(&inner.memory);
            if m.closed || m.revision != self.revision {
                return Err(changed(false));
            }
        }
        let current = inner.source.web_snapshot()?;
        if current != self.expected {
            let mut m = lock(&inner.memory);
            if m.revision == self.revision {
                revoke(&mut m);
            }
            return Err(changed(false));
        }
        let m = lock(&inner.memory);
        if m.closed || m.revision != self.revision {
            return Err(changed(false));
        }
        Ok(())
    }
}
fn changed(not_executed: bool) -> EffectError {
    EffectError {
        error: json!({"message":"Web settings or credentials changed; retry the tool with the current configuration","status":409,"blocked":true,"notExecuted":not_executed}),
        aborted: false,
    }
}

#[cfg(test)]
mod tests;
