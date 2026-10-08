//! Mechanical FIFO host of the two native reducers. No duplicate step loop,
//! scheduling policy, database, or async mutable session snapshot lives here.
use super::*;
mod scheduling;
use futures_util::FutureExt;
use std::{
    collections::{HashMap, VecDeque},
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread::{self, ThreadId},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tepora_core::{execution::ExecutionEngine, runtime::RuntimeEngine};
use tokio::{runtime::Handle, sync::oneshot};

const MAX_REQUESTS: usize = 1024;
const MAX_STREAM_EVENTS: usize = 4096;
const MAX_PREPARATIONS: usize = 16;
static NEXT_SERVICE: AtomicU64 = AtomicU64::new(1);
type Answer = Result<Value, ApiError>;
type EffectAnswer = Result<EffectResult, EffectError>;

pub struct AgentHandle {
    shared: Arc<Shared>,
}
struct Shared {
    tx: mpsc::Sender<Message>,
    closing: AtomicBool,
    requests: AtomicUsize,
    streams: AtomicUsize,
    handles: AtomicUsize,
    thread: Mutex<Option<ThreadId>>,
    done: Arc<Completion>,
}
struct Completion {
    result: Mutex<Option<Result<(), ApiError>>>,
    changed: Condvar,
}
/// A close receipt resolves only after real futures, ordered tool receipts and
/// host resource cleanup finish. Waiting never consumes the Tokio blocking pool
/// on behalf of the coordinator itself.
#[derive(Clone)]
pub struct CloseTicket {
    done: Arc<Completion>,
}
impl CloseTicket {
    pub fn wait(&self) -> Result<(), ApiError> {
        let mut result = self.done.result.lock().unwrap_or_else(|p| p.into_inner());
        while result.is_none() {
            result = self
                .done
                .changed
                .wait(result)
                .unwrap_or_else(|p| p.into_inner());
        }
        result.clone().unwrap()
    }
    pub fn is_complete(&self) -> bool {
        self.done
            .result
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some()
    }
}

enum ResponseSender {
    Ignore,
    Sync(mpsc::Sender<Answer>),
    Async(oneshot::Sender<Answer>),
}
impl ResponseSender {
    fn send(self, value: Answer) {
        match self {
            Self::Ignore => {},
            Self::Sync(tx) => {
                let _ = tx.send(value);
            }
            Self::Async(tx) => {
                let _ = tx.send(value);
            }
        }
    }
}
enum RequestBody {
    Agent(AgentRequest),
    Scoped(Value),
}
enum Message {
    SchedulerTimer { service_id: u64, kind: SchedulerKind, generation: u64 },
    Request {
        request: RequestBody,
        scope: Option<EffectScope>,
        reply: ResponseSender,
    },
    Runtime(Value),
    Complete(EffectScope, EffectAnswer),
    Stream(EffectScope, Value),
    State(String, mpsc::Sender<Value>),
    Close,
}

impl Clone for AgentHandle {
    fn clone(&self) -> Self {
        self.shared.handles.fetch_add(1, Ordering::Relaxed);
        Self {
            shared: self.shared.clone(),
        }
    }
}
impl Drop for AgentHandle {
    fn drop(&mut self) {
        if self.shared.handles.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.begin_close();
        }
    }
}
impl AgentHandle {
    /// Synchronous admission only; model/tool completion is never awaited.
    pub fn request(&self, request: AgentRequest) -> Answer {
        self.not_reentrant()?;
        self.reserve_request()?;
        let (tx, rx) = mpsc::channel();
        if self
            .shared
            .tx
            .send(Message::Request {
                request: RequestBody::Agent(request),
                scope: None,
                reply: ResponseSender::Sync(tx),
            })
            .is_err()
        {
            self.shared.requests.fetch_sub(1, Ordering::AcqRel);
            return Err(unavailable());
        }
        rx.recv().unwrap_or_else(|_| Err(unavailable()))
    }
    pub fn stop_all(&self, reason: impl Into<String>) -> Result<(), ApiError> {
        self.request(AgentRequest::StopAll {
            reason: reason.into(),
        })
        .map(|_| ())
    }
    pub fn begin_close(&self) -> CloseTicket {
        if !self.shared.closing.swap(true, Ordering::AcqRel) {
            if self.shared.tx.send(Message::Close).is_err() {
                finish_close(&self.shared.done, Err(unavailable()));
            }
        }
        CloseTicket {
            done: self.shared.done.clone(),
        }
    }
    pub fn state(&self, id: &str) -> Result<Value, ApiError> {
        self.not_reentrant()?;
        let (tx, rx) = mpsc::channel();
        self.shared
            .tx
            .send(Message::State(id.into(), tx))
            .map_err(|_| unavailable())?;
        rx.recv().map_err(|_| unavailable())
    }
    fn not_reentrant(&self) -> Result<(), ApiError> {
        if self
            .shared
            .thread
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            == Some(&thread::current().id())
        {
            Err(ApiError::new(
                409,
                "Synchronous reentrant agent request; return an event or use EventSink",
            ))
        } else {
            Ok(())
        }
    }
    fn reserve_request(&self) -> Result<(), ApiError> {
        reserve_request(&self.shared)
    }
}

/// Every callback carries the complete immutable parent operation identity.
/// A callback accepted into the mailbox can still be discarded after Stop.
#[derive(Clone)]
pub struct EventSink {
    shared: Arc<Shared>,
    scope: EffectScope,
}
impl EventSink {
    pub fn publish(&self, event: Value) -> Result<(), ApiError> {
        if self.shared.closing.load(Ordering::Acquire) {
            return Err(unavailable());
        }
        if self.shared.streams.fetch_add(1, Ordering::AcqRel) >= MAX_STREAM_EVENTS {
            self.shared.streams.fetch_sub(1, Ordering::AcqRel);
            return Err(ApiError::new(
                429,
                "Native agent stream callback queue is full",
            ));
        }
        if self
            .shared
            .tx
            .send(Message::Stream(self.scope.clone(), event))
            .is_err()
        {
            self.shared.streams.fetch_sub(1, Ordering::AcqRel);
            return Err(unavailable());
        }
        Ok(())
    }
    pub async fn request(&self, request: AgentRequest) -> Answer {
        self.call_inner(RequestBody::Agent(request)).await
    }
    pub async fn call(&self, request: Value) -> Answer {
        self.call_inner(RequestBody::Scoped(request)).await
    }
    async fn call_inner(&self, request: RequestBody) -> Answer {
        reserve_request(&self.shared)?;
        let (tx, rx) = oneshot::channel();
        if self
            .shared
            .tx
            .send(Message::Request {
                request,
                scope: Some(self.scope.clone()),
                reply: ResponseSender::Async(tx),
            })
            .is_err()
        {
            self.shared.requests.fetch_sub(1, Ordering::AcqRel);
            return Err(unavailable());
        }
        rx.await.unwrap_or_else(|_| Err(unavailable()))
    }
}

pub struct AgentCoordinator;
impl AgentCoordinator {
    pub fn start(host: Arc<dyn AgentHost>, executor: Handle) -> Result<AgentHandle, ApiError> {
        let (tx, rx) = mpsc::channel();
        let done = Arc::new(Completion {
            result: Mutex::new(None),
            changed: Condvar::new(),
        });
        let shared = Arc::new(Shared {
            tx,
            closing: AtomicBool::new(false),
            requests: AtomicUsize::new(0),
            streams: AtomicUsize::new(0),
            handles: AtomicUsize::new(1),
            thread: Mutex::new(None),
            done,
        });
        let actor_shared = shared.clone();
        thread::Builder::new()
            .name("tepora-agent-coordinator".into())
            .spawn(move || {
                // Permit host constructors to create Tokio futures/timers here.
                // This remains a dedicated owner, not a blocking-pool worker.
                let entered = executor.clone();
                let _runtime_context = entered.enter();
                *actor_shared
                    .thread
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = Some(thread::current().id());
                let mut actor = Coordinator::new(host, executor, actor_shared.clone());
                actor.run(rx);
            })
            .map_err(|e| {
                ApiError::new(500, format!("Cannot start native agent coordinator: {e}"))
            })?;
        Ok(AgentHandle { shared })
    }
}
struct Lease {
    epoch: u64,
    cancellation: RequestCancellation,
}
struct Pending {
    context: EffectContext,
    command: Value,
    dispatched: bool,
    started: Instant,
}
struct PendingAdmission {
    request: AgentRequest,
    key: Option<String>,
    replies: Vec<ResponseSender>,
}
struct Step {
    parent: EffectScope,
    generation: u64,
    terminal: Option<EffectAnswer>,
    model_started: Option<Instant>,
    tool_started: HashMap<u64, Instant>,
}
struct Timer {
    cancellation: RequestCancellation,
}
struct Coordinator {
    recurring: HashMap<SchedulerKind, super::scheduler::timer::RecurringTimer>,
    next_recurring: u64,
    host: Arc<dyn AgentHost>,
    executor: Handle,
    shared: Arc<Shared>,
    service_id: u64,
    runtime: RuntimeEngine,
    execution: ExecutionEngine,
    leases: HashMap<String, Lease>,
    pending: HashMap<EffectScope, Pending>,
    steps: HashMap<String, Step>,
    deferred: HashMap<EffectScope, EffectAnswer>,
    admissions: HashMap<EffectScope, PendingAdmission>,
    admission_keys: HashMap<String, EffectScope>,
    next_admission: u64,
    parked: Vec<EffectScope>,
    timers: HashMap<String, Timer>,
    events: VecDeque<Value>,
    commands: VecDeque<EffectScope>,
    last_facts: Value,
    closing: bool,
    resources_ready: bool,
    fatal: Option<ApiError>,
}
impl Coordinator {
    fn new(host: Arc<dyn AgentHost>, executor: Handle, shared: Arc<Shared>) -> Self {
        Self {
            host,
            recurring: HashMap::new(),
            next_recurring: 0,
            executor,
            shared,
            service_id: NEXT_SERVICE.fetch_add(1, Ordering::Relaxed),
            runtime: RuntimeEngine::new(),
            execution: ExecutionEngine::new(),
            leases: HashMap::new(),
            pending: HashMap::new(),
            steps: HashMap::new(),
            deferred: HashMap::new(),
            admissions: HashMap::new(),
            admission_keys: HashMap::new(),
            next_admission: 0,
            parked: Vec::new(),
            timers: HashMap::new(),
            events: VecDeque::new(),
            commands: VecDeque::new(),
            last_facts: json!({"sessions":[]}),
            closing: false,
            resources_ready: false,
            fatal: None,
        }
    }
    fn run(&mut self, rx: mpsc::Receiver<Message>) {
        loop {
            // Synchronous storage listeners are represented as returned events:
            // finish their FIFO before starting any newly emitted effect.
            if let Some(event) = self.events.pop_front() {
                if let Err(error) = self.dispatch(event) {
                    self.fail(error);
                }
                continue;
            }
            if self.ready_to_close() {
                let result = guarded_api(|| self.host.close())
                    .and_then(|_| self.fatal.clone().map_or(Ok(()), Err));
                finish_close(&self.shared.done, result);
                break;
            }
            match rx.try_recv() {
                Ok(message) => {
                    self.message(message);
                    continue;
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.begin_close();
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
            if let Some(scope) = self.commands.pop_front() {
                self.start(scope);
                continue;
            }
            match rx.recv() {
                Ok(message) => self.message(message),
                Err(_) => {
                    self.begin_close();
                    if self.pending.is_empty() {
                        break;
                    }
                }
            }
        }
    }
    fn message(&mut self, message: Message) {
        match message {
            Message::SchedulerTimer { service_id, kind, generation } => self.scheduler_tick(service_id, kind, generation),
            Message::Request {
                request,
                scope,
                reply,
            } => {
                if !self.closing && scope.is_none() {
                    if let RequestBody::Agent(
                        request @ (AgentRequest::Input { .. } | AgentRequest::DeleteSession { .. } | AgentRequest::SchedulerTick { .. }),
                    ) = &request
                    {
                        self.admit_request(request.clone(), reply);
                        return;
                    }
                }
                self.shared.requests.fetch_sub(1, Ordering::AcqRel);
                let result = if self.closing
                    || scope.as_ref().is_some_and(|s| {
                        s.namespace == EffectNamespace::Admission || !self.current(s, false)
                    }) {
                    Err(ApiError::new(409, "Agent operation is no longer active"))
                } else {
                    self.request(request, scope.as_ref())
                };
                reply.send(result);
            }
            Message::Runtime(event) => self.events.push_back(event),
            Message::Complete(scope, result) => self.complete(scope, result),
            Message::Stream(scope, event) => {
                self.shared.streams.fetch_sub(1, Ordering::AcqRel);
                if scope.namespace != EffectNamespace::Admission && self.current(&scope, false) {
                    if let Err(error) = guarded_api(|| self.host.stream(&scope, event)) {
                        // Do not synthesize completion while an external side
                        // effect is still running. Cancel, retain, and drain it.
                        self.fail(error);
                    }
                }
            }
            Message::State(id, reply) => {
                let value = json!({"runtime":self.runtime.state(&id),"execution":self.execution.state(&id),"pending":self.pending.keys().filter(|s|s.session_id==id).count(),"closing":self.closing});
                let _ = reply.send(value);
            }
            Message::Close => self.begin_close(),
        }
    }
    fn admit_request(&mut self, request: AgentRequest, reply: ResponseSender) {
        let planned = guarded_api(|| {
            let key = self.host.request_key(&request)?;
            if key
                .as_ref()
                .is_some_and(|key| self.admission_keys.contains_key(key))
            {
                return Ok((key, None));
            }
            let plan = self.host.plan_request(&request)?;
            if let AgentRequest::DeleteSession { id } = &request {
                if self.leases.contains_key(id)
                    || self.pending.keys().any(|scope| scope.session_id == *id)
                {
                    return Err(ApiError::new(409, "止めてから削除してください。"));
                }
            }
            Ok((key, Some(plan)))
        });
        match planned {
            Ok((Some(key), None)) => {
                let scope = &self.admission_keys[&key];
                self.admissions.get_mut(scope).unwrap().replies.push(reply);
            }
            Ok((_, Some(RequestPlan::Ready(admission)))) => {
                self.events.extend(admission.events);
                self.shared.requests.fetch_sub(1, Ordering::AcqRel);
                reply.send(Ok(admission.value));
            }
            Ok((
                key,
                Some(RequestPlan::Prepare {
                    session_id,
                    command,
                }),
            )) if self.admissions.len() < MAX_PREPARATIONS => {
                self.next_admission += 1;
                let scope = EffectScope {
                    service_id: self.service_id,
                    session_id,
                    run_epoch: 0,
                    generation: None,
                    namespace: EffectNamespace::Admission,
                    operation_id: format!("admission:{}", self.next_admission),
                };
                if let Some(key) = &key {
                    self.admission_keys.insert(key.clone(), scope.clone());
                }
                if matches!(&request, AgentRequest::DeleteSession { .. }) {
                    self.cancel_timer(&scope.session_id);
                }
                self.admissions.insert(
                    scope.clone(),
                    PendingAdmission {
                        request,
                        key,
                        replies: vec![reply],
                    },
                );
                self.queue(scope, command);
            }
            Ok(_) => {
                self.shared.requests.fetch_sub(1, Ordering::AcqRel);
                reply.send(Err(ApiError::new(
                    429,
                    "Native attachment preparation queue is full",
                )));
            }
            Err(error) => {
                self.background_error(&request, &error);
                self.shared.requests.fetch_sub(1, Ordering::AcqRel);
                reply.send(Err(error));
            }
        }
    }
    fn cancel_admissions(&self, session: Option<&str>) {
        for scope in self.admissions.keys() {
            if session.is_none_or(|id| scope.session_id == id) {
                if let Some(pending) = self.pending.get(scope) {
                    pending.context.cancellation.cancel();
                }
            }
        }
    }
    fn request(&mut self, request: RequestBody, scope: Option<&EffectScope>) -> Answer {
        match request {
            RequestBody::Scoped(value) => {
                let scope = scope
                    .ok_or_else(|| ApiError::bad_request("Scoped request requires an effect"))?;
                if value["op"] == "runtime.send"
                    && value["id"].as_str().is_some_and(|id| self.deleting(id))
                {
                    return Err(ApiError::new(409, "Session deletion is in progress"));
                }
                let admission = guarded_api(|| self.host.scoped_request(scope, value))?;
                self.events.extend(admission.events);
                Ok(admission.value)
            }
            RequestBody::Agent(request) => match request {
                AgentRequest::Initialize => {
                    self.dispatch(json!({"type":"initialize"}))?;
                    self.refresh_schedulers(true)?;
                    Ok(Value::Null)
                }
                AgentRequest::Stop {
                    id,
                    reason,
                    rearm_main,
                } => {
                    self.cancel_admissions(Some(&id));
                    self.dispatch(json!({"type":"stop","sessionId":id,"reason":reason}))?;
                    if rearm_main {
                        self.dispatch(json!({"type":"resume","sessionId":id,"mode":"rearm"}))?;
                    }
                    guarded_api(|| self.host.session(&id))
                }
                AgentRequest::StopAll { reason } => {
                    self.cancel_admissions(None);
                    let facts = self.facts()?;
                    let ids = facts["sessions"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|o| o["session"]["id"].as_str())
                        .map(str::to_owned)
                        .collect::<Vec<_>>();
                    for id in ids {
                        self.dispatch(json!({"type":"stop","sessionId":id,"reason":reason}))?;
                    }
                    Ok(Value::Null)
                }
                AgentRequest::Resume { id } => {
                    if self.deleting(&id) {
                        return Err(ApiError::new(409, "Session deletion is in progress"));
                    }
                    self.dispatch(json!({"type":"resume","sessionId":id}))?;
                    guarded_api(|| self.host.session(&id))
                }
                AgentRequest::Send { ref id, .. } if self.deleting(id) => {
                    Err(ApiError::new(409, "Session deletion is in progress"))
                }
                AgentRequest::SetupContext => {
                    guarded_api(|| self.host.setup_context(!self.leases.is_empty()))
                }
                AgentRequest::ActivateSetup { commit } => {
                    if !self.leases.is_empty() {
                        return Err(ApiError::new(
                            409,
                            "Wait for the agent to finish or stop it before selecting a model",
                        ));
                    }
                    if commit.cancellation.is_cancelled() {
                        return Err(ApiError::new(409, "Setup selection was cancelled"));
                    }
                    guarded_api(|| self.host.activate_setup(&commit))?;
                    Ok(Value::Null)
                }
                other => {
                    let admission = guarded_api(|| self.host.request(&other))?;
                    self.events.extend(admission.events);
                    if matches!(other, AgentRequest::Configure { .. }) { self.refresh_schedulers(false)?; }
                    Ok(admission.value)
                }
            },
        }
    }
    fn facts(&mut self) -> Result<Value, ApiError> {
        let mut facts = guarded_api(|| self.host.facts())?;
        if let Some(observations) = facts["sessions"].as_array_mut() {
            observations.retain(|row| {
                !row["session"]["id"]
                    .as_str()
                    .is_some_and(|id| self.deleting(id))
            });
        }
        self.last_facts = facts.clone();
        Ok(facts)
    }
    fn dispatch(&mut self, event: Value) -> Result<(), ApiError> {
        if event["sessionId"]
            .as_str()
            .is_some_and(|id| self.deleting(id))
            && matches!(
                event["type"].as_str(),
                Some("wake" | "resume" | "later" | "timerFired" | "auxiliary")
            )
        {
            return Ok(());
        }
        let facts = match self.facts() {
            Ok(facts) => facts,
            Err(error) if self.closing => {
                self.fatal.get_or_insert(error);
                self.last_facts.clone()
            }
            Err(error) => return Err(error),
        };
        let response = self.runtime.dispatch(event, facts).map_err(engine_error)?;
        self.runtime_response(response)
    }
    fn deleting(&self, id: &str) -> bool {
        self.admissions.values().any(|pending|matches!(&pending.request,AgentRequest::DeleteSession{id:target} if target==id))
    }
    fn runtime_response(&mut self, response: Value) -> Result<(), ApiError> {
        let actions = response["actions"].as_array().cloned().unwrap_or_default();
        let mut stops = Vec::new();
        // Establish/cancel local ownership before exposing this batch to state.
        // The engine already made every admission and invalidation decision.
        for action in &actions {
            let id = string(action, "sessionId");
            let epoch = action["runEpoch"].as_u64().unwrap_or(0);
            match action["kind"].as_str().unwrap_or("") {
                "createRun" => {
                    self.leases.insert(
                        id,
                        Lease {
                            epoch,
                            cancellation: RequestCancellation::new(),
                        },
                    );
                }
                "abortRun" => {
                    self.cancel_auxiliary(&id, epoch);
                    if let Some(lease) = self.leases.get(&id).filter(|l| l.epoch == epoch) {
                        lease.cancellation.cancel();
                        if let Some(step) = self.steps.get(&id) {
                            stops.push((id, step.generation, string(action, "reason")));
                        }
                    }
                }
                "stopResources" => self.cancel_admissions(Some(&id)),
                "releaseRun" => {
                    self.cancel_auxiliary(&id, epoch);
                    if self.leases.get(&id).is_some_and(|l| l.epoch == epoch) {
                        self.leases.remove(&id);
                    }
                }
                "armTimer" => self.arm_timer(action),
                "cancelTimer" => self.cancel_timer(&id),
                "shutdownSchedulers" => {
                    for pending in self.pending.values() {
                        pending.context.cancellation.cancel();
                    }
                    for lease in self.leases.values() {
                        lease.cancellation.cancel();
                    }
                }
                "closeResources" => self.resources_ready = true,
                _ => {}
            }
        }
        let applied = guarded_api(|| self.host.apply_runtime_actions(&actions));
        if let Ok(events) = &applied {
            self.events.extend(events.clone());
        }
        // No effect can run until the batch (and any reentrant events) ends.
        for command in response["commands"].as_array().into_iter().flatten() {
            let scope = EffectScope {
                service_id: self.service_id,
                session_id: string(command, "sessionId"),
                run_epoch: command["runEpoch"].as_u64().unwrap_or(0),
                generation: None,
                namespace: EffectNamespace::Runtime,
                operation_id: string(command, "operationId"),
            };
            self.queue(scope, command.clone());
        }
        for (id, generation, reason) in stops {
            match self
                .execution
                .stop(json!({"sessionId":id,"generation":generation,"reason":reason}))
            {
                Ok(response) => self.execution_response(response),
                Err(error) => self.finish_step_error(&id, EffectError::new(error)),
            }
        }
        applied.map(|_| ())
    }
    fn arm_timer(&mut self, action: &Value) {
        let id = string(action, "sessionId");
        self.cancel_timer(&id);
        let token = action["timerToken"].as_u64().unwrap_or(0);
        let now = self.last_facts["nowMs"].as_f64().unwrap_or_else(now_ms);
        let delay = (action["deadlineMs"].as_f64().unwrap_or(now) - now).max(0.0);
        let cancellation = RequestCancellation::new();
        self.timers.insert(
            id.clone(),
            Timer {
                cancellation: cancellation.clone(),
            },
        );
        let tx = self.shared.tx.clone();
        self.executor.spawn(async move {
            tokio::select! {
                _ = cancellation.cancelled() => {},
                _ = tokio::time::sleep(Duration::from_millis(delay.min(u64::MAX as f64) as u64)) => {
                    let _ = tx.send(Message::Runtime(json!({"type":"timerFired","sessionId":id,"timerToken":token})));
                }
            }
        });
    }
    fn cancel_timer(&mut self, id: &str) {
        if let Some(timer) = self.timers.remove(id) {
            timer.cancellation.cancel();
        }
    }
    fn queue(&mut self, scope: EffectScope, command: Value) {
        let mut cancellation = self
            .leases
            .get(&scope.session_id)
            .filter(|l| l.epoch == scope.run_epoch)
            .map(|l| l.cancellation.clone())
            .unwrap_or_else(|| {
                let c = RequestCancellation::new();
                c.cancel();
                c
            });
        if scope.namespace == EffectNamespace::Admission
            || scope.namespace == EffectNamespace::Auxiliary && !cancellation.is_cancelled()
        {
            cancellation = RequestCancellation::new();
        }
        let context = EffectContext {
            events: EventSink {
                shared: self.shared.clone(),
                scope: scope.clone(),
            },
            scope: scope.clone(),
            cancellation,
        };
        self.pending.insert(
            scope.clone(),
            Pending {
                context,
                command,
                dispatched: false,
                started: Instant::now(),
            },
        );
        self.commands.push_back(scope);
    }
    fn current(&self, scope: &EffectScope, drain: bool) -> bool {
        if scope.service_id != self.service_id || !self.pending.contains_key(scope) {
            return false;
        }
        if scope.namespace == EffectNamespace::Admission {
            return self.admissions.contains_key(scope)
                && !self.closing
                && !self.pending[scope].context.cancellation.is_cancelled();
        }
        let Some(lease) = self
            .leases
            .get(&scope.session_id)
            .filter(|l| l.epoch == scope.run_epoch)
        else {
            return false;
        };
        if let Some(generation) = scope.generation {
            if !self
                .steps
                .get(&scope.session_id)
                .is_some_and(|s| s.generation == generation)
            {
                return false;
            }
        }
        if drain {
            return true;
        }
        !self.closing
            && !self.pending[scope].context.cancellation.is_cancelled()
            && !lease.cancellation.is_cancelled()
            && self.runtime.state(&scope.session_id)["epoch"].as_u64() == Some(scope.run_epoch)
    }
    fn start(&mut self, scope: EffectScope) {
        let Some(pending) = self.pending.get(&scope) else {
            return;
        };
        let command = pending.command.clone();
        let context = pending.context.clone();
        let drain = drain_command(&command);
        if !self.current(&scope, drain) || self.fatal.is_some() && !drain {
            self.complete(
                scope,
                Err(EffectError::cancelled(command["kind"] == "executeTool")),
            );
            return;
        }
        if scope.namespace != EffectNamespace::Admission
            && self.pending.keys().any(|old| {
                old.namespace == EffectNamespace::Auxiliary
                    && old.session_id == scope.session_id
                    && old.run_epoch != scope.run_epoch
            })
        {
            self.parked.push(scope);
            return;
        }
        if scope.namespace == EffectNamespace::Runtime && command["kind"] == "step" {
            self.pending.get_mut(&scope).unwrap().dispatched = true;
            match guarded_api(|| self.host.session(&scope.session_id)) {
                Ok(session) => match self.execution.begin(session, json!({})) {
                    Ok(response) => {
                        let generation = response["generation"].as_u64().unwrap();
                        self.steps.insert(
                            scope.session_id.clone(),
                            Step {
                                parent: scope,
                                generation,
                                terminal: None,
                                model_started: None,
                                tool_started: HashMap::new(),
                            },
                        );
                        self.execution_response(response);
                    }
                    Err(error) => self.complete(scope, Err(EffectError::new(error))),
                },
                Err(error) => self.complete(scope, Err(error.into())),
            }
            return;
        }
        self.pending.get_mut(&scope).unwrap().dispatched = true;
        if scope.namespace == EffectNamespace::Execution && command["kind"] == "beforeRequest" {
            if let Some(step) = self.steps.get_mut(&scope.session_id) {
                step.model_started = Some(Instant::now());
            }
        }
        if scope.namespace == EffectNamespace::Execution && command["kind"] == "prepareTool" {
            if let (Some(step), Some(index)) = (
                self.steps.get_mut(&scope.session_id),
                command["index"].as_u64(),
            ) {
                step.tool_started.entry(index).or_insert_with(Instant::now);
            }
        }
        let task = if scope.namespace == EffectNamespace::Runtime && command["kind"] == "yield" {
            Ok(EffectTask::Async(Box::pin(async {
                tokio::task::yield_now().await;
                Ok(EffectResult::new(Value::Null))
            })))
        } else {
            guarded_effect(|| self.host.start_effect(&context, &command))
        };
        match task {
            Ok(EffectTask::Ready(result)) => self.complete(scope, Ok(result)),
            Ok(EffectTask::ReadyWithAuxiliary(result, commands)) => {
                if scope.namespace != EffectNamespace::Runtime || commands.len() > 16 {
                    self.complete(
                        scope,
                        Err(EffectError::new("Invalid auxiliary effect batch")),
                    );
                    return;
                }
                for (index, command) in commands.into_iter().enumerate() {
                    let child = EffectScope {
                        namespace: EffectNamespace::Auxiliary,
                        generation: None,
                        operation_id: format!("{}:aux:{index}", scope.operation_id),
                        ..scope.clone()
                    };
                    self.queue(child, command);
                }
                self.complete(scope, Ok(result));
            }
            Err(error) => self.complete(scope, Err(error)),
            Ok(EffectTask::Async(future)) => {
                // The guard is constructed before spawn, so a runtime which
                // drops an unpolled task still returns one rejected receipt.
                let guard = CompletionGuard {
                    tx: self.shared.tx.clone(),
                    scope: Some(scope),
                    cancellation: context.cancellation.clone(),
                };
                self.executor.spawn(async move {
                    let result = AssertUnwindSafe(future)
                        .catch_unwind()
                        .await
                        .unwrap_or_else(|_| Err(EffectError::new("Native host effect panicked")));
                    guard.complete(result);
                });
            }
        }
    }
    fn cancel_auxiliary(&self, id: &str, epoch: u64) {
        for (scope, pending) in &self.pending {
            if scope.namespace == EffectNamespace::Auxiliary
                && scope.session_id == id
                && scope.run_epoch == epoch
            {
                pending.context.cancellation.cancel();
            }
        }
    }
    fn has_auxiliary(&self, scope: &EffectScope) -> bool {
        self.pending.keys().any(|s| {
            s.namespace == EffectNamespace::Auxiliary
                && s.session_id == scope.session_id
                && s.run_epoch == scope.run_epoch
        })
    }
    fn complete(&mut self, scope: EffectScope, result: EffectAnswer) {
        let Some(pending) = self.pending.get(&scope) else {
            return;
        };
        let command = pending.command.clone();
        let context = pending.context.clone();
        if scope.namespace == EffectNamespace::Admission {
            let admission = self
                .admissions
                .remove(&scope)
                .expect("owned admission reply");
            let result = if self.closing || context.cancellation.is_cancelled() {
                Err(ApiError::new(
                    if self.closing { 503 } else { 409 },
                    "Input preparation was cancelled before acceptance",
                ))
            } else {
                result
                    .map_err(|error| {
                        ApiError::new(
                            error.error["status"].as_u64().unwrap_or(500) as u16,
                            error.error["message"]
                                .as_str()
                                .unwrap_or("Input preparation failed"),
                        )
                    })
                    .and_then(|result| {
                        guarded_api(|| {
                            self.host
                                .complete_request(&context, &admission.request, result)
                        })
                    })
                    .map(|accepted| {
                        self.events.extend(accepted.events);
                        accepted.value
                    })
            };
            self.pending.remove(&scope);
            if !context.cancellation.is_cancelled() {
                if let Err(error) = &result { self.background_error(&admission.request, error); }
            }
            if let Some(key) = admission.key {
                self.admission_keys.remove(&key);
            }
            self.shared
                .requests
                .fetch_sub(admission.replies.len(), Ordering::AcqRel);
            for reply in admission.replies {
                reply.send(result.clone());
            }
            return;
        }
        if scope.namespace == EffectNamespace::Auxiliary {
            if self.current(&scope, false) {
                if let Err(error) =
                    guarded_api(|| self.host.complete_auxiliary(&context, &command, result))
                {
                    self.fail(error);
                }
            }
            self.pending.remove(&scope);
            self.commands.extend(std::mem::take(&mut self.parked));
            let ready = self
                .deferred
                .keys()
                .filter(|s| !self.has_auxiliary(s))
                .cloned()
                .collect::<Vec<_>>();
            for parent in ready {
                if let Some(result) = self.deferred.remove(&parent) {
                    self.complete(parent, result);
                }
            }
            return;
        }
        if scope.namespace == EffectNamespace::Runtime
            && self.has_auxiliary(&scope)
            && (context.cancellation.is_cancelled()
                || self.closing
                || result.is_err()
                || command["kind"] == "step"
                    && result
                        .as_ref()
                        .ok()
                        .is_some_and(|r| r.value["wait"].as_f64().unwrap_or(0.0) != 0.0))
        {
            self.cancel_auxiliary(&scope.session_id, scope.run_epoch);
            self.deferred.insert(scope, result);
            return;
        }
        let elapsed = if !pending.dispatched {
            0.0
        } else if scope.namespace == EffectNamespace::Execution && command["kind"] == "invoke" {
            self.steps
                .get(&scope.session_id)
                .and_then(|s| s.model_started)
                .unwrap_or(pending.started)
                .elapsed()
                .as_secs_f64()
                * 1000.0
        } else {
            pending.started.elapsed().as_secs_f64() * 1000.0
        };
        let may_commit = self.current(&scope, drain_command(&command));
        let result = match result {
            Ok(result)
                if may_commit
                    && !(scope.namespace == EffectNamespace::Runtime
                        && matches!(command["kind"].as_str(), Some("step" | "yield"))) =>
            {
                guarded_effect(|| self.host.complete_effect(&context, &command, result))
            }
            other => other,
        };
        let pending = self.pending.remove(&scope).unwrap();
        let cancelled = pending.context.cancellation.is_cancelled();
        let mut event = json!({"sessionId":scope.session_id,"operationId":scope.operation_id,"aborted":cancelled});
        let mut facts = json!({"elapsedMs":elapsed});
        if let Some(started) = command["index"].as_u64().and_then(|index| {
            self.steps
                .get(&scope.session_id)
                .and_then(|s| s.tool_started.get(&index))
        }) {
            facts["toolMs"] = json!(started.elapsed().as_secs_f64() * 1000.0);
        }
        match result {
            Ok(result) => {
                event["type"] = json!("resolved");
                event["value"] = result.value;
                if may_commit {
                    self.events.extend(result.events);
                }
                if let Some(object) = result.facts.as_object() {
                    for (k, v) in object {
                        facts[k] = v.clone();
                    }
                }
            }
            Err(error) => {
                event["type"] = json!("rejected");
                event["error"] = error.error;
                if !pending.dispatched && command["kind"] == "executeTool" {
                    event["error"]["notExecuted"] = json!(true);
                }
                event["aborted"] = json!(cancelled || error.aborted);
            }
        }
        match scope.namespace {
            EffectNamespace::Runtime => {
                event["runEpoch"] = json!(scope.run_epoch);
                self.events.push_back(event);
            }
            EffectNamespace::Auxiliary | EffectNamespace::Admission => {
                unreachable!("handled above")
            }
            EffectNamespace::Execution => {
                event["generation"] = json!(scope.generation);
                match self.execution.advance(event, facts) {
                    Ok(response) => self.execution_response(response),
                    Err(error) => {
                        self.finish_step_error(&scope.session_id, EffectError::new(error))
                    }
                }
                self.try_finish_step(&scope.session_id);
            }
        }
    }
    fn execution_response(&mut self, response: Value) {
        let id = string(&response, "sessionId");
        let Some(step) = self.steps.get_mut(&id) else {
            return;
        };
        if response["generation"].as_u64() != Some(step.generation) {
            return;
        }
        if response["status"] == "finished" {
            let outcome = response["outcome"].clone();
            step.terminal = Some(if let Some(error) = outcome.get("error") {
                Err(EffectError {
                    error: error.clone(),
                    aborted: outcome["aborted"] == true,
                })
            } else {
                Ok(EffectResult::new(outcome))
            });
        }
        let epoch = step.parent.run_epoch;
        let generation = step.generation;
        for command in response["commands"].as_array().into_iter().flatten() {
            let scope = EffectScope {
                service_id: self.service_id,
                session_id: id.clone(),
                run_epoch: epoch,
                generation: Some(generation),
                namespace: EffectNamespace::Execution,
                operation_id: string(command, "operationId"),
            };
            self.queue(scope, command.clone());
        }
        self.try_finish_step(&id);
    }
    fn finish_step_error(&mut self, id: &str, error: EffectError) {
        if let Some(step) = self.steps.get_mut(id) {
            step.terminal = Some(Err(error));
            if let Some(lease) = self.leases.get(id) {
                lease.cancellation.cancel();
            }
            let _=self.execution.stop(json!({"sessionId":id,"generation":step.generation,"reason":"Native execution host failed"}));
        }
        self.try_finish_step(id);
    }
    fn try_finish_step(&mut self, id: &str) {
        let Some(step) = self.steps.get(id) else {
            return;
        };
        if step.terminal.is_none()
            || self
                .pending
                .keys()
                .any(|s| s.session_id == id && s.generation == Some(step.generation))
        {
            return;
        }
        let step = self.steps.remove(id).unwrap();
        // Only now may RuntimeEngine release the lease or admit Resume.
        self.complete(step.parent, step.terminal.unwrap());
    }
    fn begin_close(&mut self) {
        self.recurring.clear();
        if self.closing {
            return;
        }
        self.closing = true;
        self.cancel_admissions(None);
        self.shared.closing.store(true, Ordering::Release);
        if let Err(error) = self.dispatch(json!({"type":"close"})) {
            self.fail(error);
        }
    }
    fn ready_to_close(&self) -> bool {
        self.closing
            && self.resources_ready
            && self.pending.is_empty()
            && self.steps.is_empty()
            && self.leases.is_empty()
            && self.events.is_empty()
    }
    fn fail(&mut self, error: ApiError) {
        self.fatal.get_or_insert(error);
        if !self.closing {
            self.begin_close();
        }
    }
}
struct CompletionGuard {
    tx: mpsc::Sender<Message>,
    scope: Option<EffectScope>,
    cancellation: RequestCancellation,
}
impl CompletionGuard {
    fn complete(mut self, result: EffectAnswer) {
        if let Some(scope) = self.scope.take() {
            let _ = self.tx.send(Message::Complete(scope, result));
        }
    }
}
impl Drop for CompletionGuard {
    fn drop(&mut self) {
        if let Some(scope) = self.scope.take() {
            // Invalidate already-enqueued callbacks before reporting task loss.
            self.cancellation.cancel();
            let _ = self.tx.send(Message::Complete(
                scope,
                Err(EffectError::new(
                    "Native host task terminated before returning its outcome",
                )),
            ));
        }
    }
}
fn drain_command(command: &Value) -> bool {
    matches!(command["kind"].as_str(), Some("afterTool" | "recordTools"))
}
fn reserve_request(shared: &Shared) -> Result<(), ApiError> {
    if shared.closing.load(Ordering::Acquire) {
        return Err(unavailable());
    }
    if shared.requests.fetch_add(1, Ordering::AcqRel) >= MAX_REQUESTS {
        shared.requests.fetch_sub(1, Ordering::AcqRel);
        return Err(ApiError::new(429, "Native agent admission queue is full"));
    }
    Ok(())
}
fn unavailable() -> ApiError {
    ApiError::unavailable("Native agent coordinator is closed")
}
fn engine_error(error: String) -> ApiError {
    let status = error
        .strip_prefix('[')
        .and_then(|s| s.split(']').next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(500);
    ApiError::new(status, error)
}
fn string(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or("").into()
}
fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
}
fn guarded_api<T>(f: impl FnOnce() -> Result<T, ApiError>) -> Result<T, ApiError> {
    catch_unwind(AssertUnwindSafe(f))
        .unwrap_or_else(|_| Err(ApiError::new(500, "Native state host panicked")))
}
fn guarded_effect<T>(f: impl FnOnce() -> Result<T, EffectError>) -> Result<T, EffectError> {
    catch_unwind(AssertUnwindSafe(f))
        .unwrap_or_else(|_| Err(EffectError::new("Native host effect panicked")))
}
fn finish_close(done: &Completion, result: Result<(), ApiError>) {
    let mut stored = done.result.lock().unwrap_or_else(|p| p.into_inner());
    if stored.is_none() {
        *stored = Some(result);
        done.changed.notify_all();
    }
}

#[cfg(test)]
mod tests;
