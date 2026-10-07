//! Rust-owned exec/process lifecycle. Background jobs persist across model turns;
//! real child exit and stream EOF, not cancellation intent, complete a drain.
mod output;
use super::EffectError;
use crate::{
    network::RequestCancellation,
    sandbox::{self, Platform, SandboxConfig, SpawnFacts, SpawnPlan},
    ApiError,
};
use output::{fixed_one, Output, Utf8Decoder};
pub use output::{terminal_text, HEAD, TAIL};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    path::PathBuf,
    process::{ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Condvar, Mutex, MutexGuard,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tepora_core::json_codec::{self, encode_text, sql_text};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, Notify, OnceCell},
};

pub struct ManagerOptions {
    pub facts: SpawnFacts,
    /// None means inherit the current environment at each start. Tests use an
    /// owned controlled environment; never include it in a public snapshot.
    pub environment: Option<Vec<(OsString, OsString)>>,
    /// Some avoids executing a login shell (e.g. deterministic fixtures).
    pub login_path: Option<OsString>,
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}
impl Default for ManagerOptions {
    fn default() -> Self {
        Self {
            facts: SpawnFacts::capture(),
            environment: None,
            login_path: None,
            clock: Arc::new(now_ms),
        }
    }
}
pub struct StartRequest {
    /// Lossless internal-codec strings, converted once when passed to the OS.
    pub command: String,
    pub session_id: String,
    pub cwd: PathBuf,
    pub cwd_text: Option<String>,
    pub policy: SandboxConfig,
    pub env: Vec<(OsString, OsString)>,
    pub stdin: Option<String>,
    pub keep_stdin: bool,
    pub timeout: Option<Duration>,
}
impl StartRequest {
    pub fn new(
        command: impl Into<String>,
        session: impl Into<String>,
        cwd: impl Into<PathBuf>,
    ) -> Self {
        Self {
            command: command.into(),
            session_id: session.into(),
            cwd: cwd.into(),
            cwd_text: None,
            policy: SandboxConfig::default(),
            env: vec![],
            stdin: None,
            keep_stdin: false,
            timeout: None,
        }
    }
}
#[derive(Clone)]
pub struct ProcessContext {
    pub session_id: String,
    pub cwd: PathBuf,
    pub cwd_text: Option<String>,
    pub sandbox: SandboxConfig,
    pub cancellation: RequestCancellation,
}
#[derive(Clone, Debug)]
pub struct ProcessSnapshot {
    pub id: String,
    pub session_id: String,
    pub command: String,
    pub cwd: String,
    pub sandbox: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub status: String,
    pub output_chars: u64,
    pub cursor: u64,
    pub pid: Option<u32>,
    pub container_name: Option<String>,
    pub output_truncated: bool,
    pub cleanup_uncertain: bool,
}
impl ProcessSnapshot {
    pub fn value(&self, now: i64) -> Value {
        let mut value = json!({"id":self.id,"command":self.command,"status":self.status,"exitCode":self.exit_code,"cwd":self.cwd,"sandbox":self.sandbox,"runningForMs":self.ended_at.unwrap_or(now)-self.started_at,"outputChars":self.output_chars});
        if self.output_truncated {
            value["outputTruncated"] = json!(true);
        }
        if self.cleanup_uncertain {
            value["cleanupUncertain"] = json!(true);
        }
        value
    }
}
struct ItemState {
    ended_at: Option<i64>,
    exit_code: Option<i32>,
    signal: Option<String>,
    status: &'static str,
    killed: bool,
    output_truncated: bool,
    cleanup_uncertain: bool,
    output: Output,
}
struct Input {
    bytes: Vec<u8>,
    close: bool,
}
struct Item {
    id: String,
    session_id: String,
    command: String,
    cwd: String,
    plan: SpawnPlan,
    pid: Option<u32>,
    started_at: i64,
    state: Mutex<ItemState>,
    changed: Notify,
    input: Mutex<Option<mpsc::UnboundedSender<Input>>>,
    kill: RequestCancellation,
    child_reaped: AtomicBool,
    kill_started: Mutex<Option<Instant>>,
}
impl Item {
    fn snapshot(&self) -> ProcessSnapshot {
        let state = lock(&self.state);
        ProcessSnapshot {
            id: self.id.clone(),
            session_id: self.session_id.clone(),
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            sandbox: self.plan.sandbox.clone(),
            started_at: self.started_at,
            ended_at: state.ended_at,
            exit_code: state.exit_code,
            signal: state.signal.clone(),
            status: state.status.into(),
            output_chars: state.output.total,
            cursor: state.output.cursor,
            pid: self.pid,
            container_name: self.plan.container.clone(),
            output_truncated: state.output_truncated,
            cleanup_uncertain: state.cleanup_uncertain,
        }
    }
    fn take(&self, text: &str) {
        if lock(&self.state).output.take(text) {
            self.changed.notify_waiters();
        }
    }
    fn running(&self) -> bool {
        lock(&self.state).status == "running"
    }
    fn request_kill(&self) {
        let mut state = lock(&self.state);
        if state.status != "running" {
            return;
        }
        state.killed = true;
        drop(state);
        lock(&self.kill_started).get_or_insert_with(Instant::now);
        self.kill.cancel();
    }
}
#[derive(Clone)]
pub struct ProcessHandle {
    item: Arc<Item>,
}
impl std::fmt::Debug for ProcessHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.snapshot().fmt(f)
    }
}
impl ProcessHandle {
    pub fn id(&self) -> &str {
        &self.item.id
    }
    pub fn snapshot(&self) -> ProcessSnapshot {
        self.item.snapshot()
    }
    pub fn output(&self, from: u64) -> String {
        lock(&self.item.state).output.read(from)
    }
}
struct Starting {
    session_id: String,
    cancellation: RequestCancellation,
}
#[derive(Default)]
struct ManagerState {
    items: HashMap<String, Arc<Item>>,
    order: Vec<String>,
    starting: HashMap<String, Starting>,
    closed: bool,
    errors: HashMap<String, String>,
}
struct Inner {
    state: Mutex<ManagerState>,
    changed: Condvar,
    async_changed: Notify,
    options: ManagerOptions,
    login_path: OnceCell<OsString>,
    owners: AtomicUsize,
}
pub struct ProcessManager {
    inner: Arc<Inner>,
}
impl Clone for ProcessManager {
    fn clone(&self) -> Self {
        self.inner.owners.fetch_add(1, Ordering::Relaxed);
        Self {
            inner: self.inner.clone(),
        }
    }
}
impl Drop for ProcessManager {
    fn drop(&mut self) {
        if self.inner.owners.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.begin_close();
        }
    }
}
impl Default for ProcessManager {
    fn default() -> Self {
        Self::new()
    }
}
struct StartPermit {
    inner: Arc<Inner>,
    id: String,
    cancellation: RequestCancellation,
}
impl Drop for StartPermit {
    fn drop(&mut self) {
        let mut state = lock(&self.inner.state);
        state.starting.remove(&self.id);
        self.inner.changed.notify_all();
        self.inner.async_changed.notify_waiters();
    }
}
/// This ticket may be awaited asynchronously or synchronously on the dedicated
/// coordinator owner after all receipt commits; it never holds Workspace's lock.
#[derive(Clone)]
pub struct DrainTicket {
    inner: Arc<Inner>,
    ids: Option<HashSet<String>>,
}
impl DrainTicket {
    fn includes(&self, id: &str) -> bool {
        self.ids.as_ref().is_none_or(|ids| ids.contains(id))
    }
    fn drained(&self, state: &ManagerState) -> bool {
        !state.starting.keys().any(|id| self.includes(id))
            && state
                .items
                .iter()
                .filter(|(id, _)| self.includes(id))
                .all(|(_, item)| !item.running())
    }
    fn result(&self, state: &ManagerState) -> Result<(), ApiError> {
        state
            .errors
            .iter()
            .find(|(id, _)| self.includes(id))
            .map_or(Ok(()), |(_, message)| {
                Err(ApiError::new(500, message.clone()))
            })
    }
    pub fn is_complete(&self) -> bool {
        self.drained(&lock(&self.inner.state))
    }
    pub fn completion_result(&self) -> Option<Result<(), ApiError>> {
        let state = lock(&self.inner.state);
        self.drained(&state).then(|| self.result(&state))
    }
    pub fn wait(&self) -> Result<(), ApiError> {
        let mut state = lock(&self.inner.state);
        while !self.drained(&state) {
            state = self
                .inner
                .changed
                .wait(state)
                .unwrap_or_else(|e| e.into_inner());
        }
        self.result(&state)
    }
    pub async fn wait_async(&self) -> Result<(), ApiError> {
        loop {
            let changed = self.inner.async_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let state = lock(&self.inner.state);
                if self.drained(&state) {
                    return self.result(&state);
                }
            }
            changed.await;
        }
    }
}
impl ProcessManager {
    pub fn new() -> Self {
        Self::with_options(ManagerOptions::default())
    }
    pub fn with_options(options: ManagerOptions) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(ManagerState::default()),
                changed: Condvar::new(),
                async_changed: Notify::new(),
                options,
                login_path: OnceCell::new(),
                owners: AtomicUsize::new(1),
            }),
        }
    }
    pub fn facts(&self) -> &SpawnFacts {
        &self.inner.options.facts
    }
    fn reserve(&self, session: &str) -> Result<StartPermit, EffectError> {
        let mut state = lock(&self.inner.state);
        if state.closed {
            return Err(before_dispatch(503, "Process manager is closed"));
        }
        let id = loop {
            let id = format!("p{}", &uuid::Uuid::new_v4().to_string()[..8]);
            if !state.items.contains_key(&id) && !state.starting.contains_key(&id) {
                break id;
            }
        };
        let cancellation = RequestCancellation::new();
        state.starting.insert(
            id.clone(),
            Starting {
                session_id: session.into(),
                cancellation: cancellation.clone(),
            },
        );
        Ok(StartPermit {
            inner: self.inner.clone(),
            id,
            cancellation,
        })
    }
    pub async fn start(
        &self,
        request: StartRequest,
        cancellation: &RequestCancellation,
    ) -> Result<ProcessHandle, EffectError> {
        let permit = self.reserve(&request.session_id)?;
        check_cancel(cancellation, &permit.cancellation)?;
        tokio::fs::create_dir_all(&request.cwd)
            .await
            .map_err(|e| before_dispatch(500, format!("Cannot create working directory: {e}")))?;
        check_cancel(cancellation, &permit.cancellation)?;
        let environment = self
            .inner
            .options
            .environment
            .clone()
            .unwrap_or_else(|| std::env::vars_os().collect());
        let inherited_path = environment
            .iter()
            .find(|(k, _)| k == "PATH")
            .map(|(_, v)| v.clone())
            .unwrap_or_default();
        let path = if let Some(path) = &self.inner.options.login_path {
            path.clone()
        } else {
            self.inner
                .login_path
                .get_or_init(|| {
                    login_shell_path(&self.inner.options.facts, &environment, inherited_path)
                })
                .await
                .clone()
        };
        check_cancel(cancellation, &permit.cancellation)?;
        let container_name = format!("tepora-{}", permit.id);
        let mut plan = sandbox::wrap_command(
            &request.command,
            &request.cwd,
            &request.policy,
            if request.policy.mode == sandbox::SandboxMode::Container {
                Some(&container_name)
            } else {
                None
            },
            &self.inner.options.facts,
        )
        .map_err(|e| before_dispatch(e.status, e.message))?;
        // Deliberate cleanup correction: every container, including a fallback
        // from workspace/readonly, receives a stable identity for engine kill.
        if plan.is_container() && plan.container.is_none() {
            plan = sandbox::wrap_command(
                &request.command,
                &request.cwd,
                &request.policy,
                Some(&container_name),
                &self.inner.options.facts,
            )
            .map_err(|e| before_dispatch(e.status, e.message))?;
        }
        let mut command = Command::new(&plan.file);
        command
            .args(&plan.args)
            .current_dir(&plan.cwd)
            .env_clear()
            .envs(environment)
            .env("PATH", path)
            .envs(request.env.iter().cloned())
            .env("TEPORA_SESSION", sql_text(&request.session_id))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        detached(&mut command);
        check_cancel(cancellation, &permit.cancellation)?;
        let started = (self.inner.options.clock)();
        let child = command.spawn();
        let (input_tx, input_rx) = mpsc::unbounded_channel();
        let item = Arc::new(Item {
            id: permit.id.clone(),
            session_id: request.session_id,
            command: request.command,
            cwd: request
                .cwd_text
                .unwrap_or_else(|| sandbox::encode_path(&request.cwd)),
            plan,
            pid: child.as_ref().ok().and_then(Child::id),
            started_at: started,
            state: Mutex::new(ItemState {
                ended_at: None,
                exit_code: None,
                signal: None,
                status: "running",
                killed: false,
                output_truncated: false,
                cleanup_uncertain: false,
                output: Output::default(),
            }),
            changed: Notify::new(),
            input: Mutex::new(Some(input_tx)),
            kill: RequestCancellation::new(),
            child_reaped: AtomicBool::new(false),
            kill_started: Mutex::new(None),
        });
        let closing = {
            let mut state = lock(&self.inner.state);
            state.order.push(item.id.clone());
            state.items.insert(item.id.clone(), item.clone());
            state.closed
        };
        if closing || cancellation.is_cancelled() || permit.cancellation.is_cancelled() {
            item.request_kill();
        }
        match child {
            Ok(child) => {
                let inner = self.inner.clone();
                let supervisor_item = item.clone();
                let guard = SupervisorGuard {
                    inner: inner.clone(),
                    item: supervisor_item.clone(),
                    finished: false,
                };
                let timeout = request.timeout;
                tokio::spawn(async move {
                    supervise(inner, supervisor_item, child, input_rx, timeout, guard).await;
                });
                if let Some(stdin) = request.stdin {
                    send_input(&item, &stdin, !request.keep_stdin);
                }
            }
            Err(error) => {
                item.take(&format!("\n[failed to start: {error}]\n"));
                lock(&item.input).take();
                finish(&self.inner, &item, Some(127), None);
            }
        }
        drop(permit);
        Ok(ProcessHandle { item })
    }
    pub fn get(&self, id: &str, session: Option<&str>) -> Result<ProcessHandle, ApiError> {
        let state = lock(&self.inner.state);
        let item = state
            .items
            .get(id)
            .filter(|p| session.is_none_or(|s| s.is_empty() || p.session_id == s))
            .ok_or_else(|| ApiError::new(404, format!("プロセス {id} が見つかりません。")))?;
        Ok(ProcessHandle { item: item.clone() })
    }
    pub fn list(&self, session: Option<&str>) -> Vec<Value> {
        let state = lock(&self.inner.state);
        let now = (self.inner.options.clock)();
        state
            .order
            .iter()
            .filter_map(|id| state.items.get(id))
            .filter(|p| session.is_none_or(|s| s.is_empty() || p.session_id == s))
            .map(|p| p.snapshot().value(now))
            .collect()
    }
    pub fn kill(&self, handle: &ProcessHandle) {
        handle.item.request_kill();
    }
    pub fn cancel_session(&self, session: &str) -> DrainTicket {
        let state = lock(&self.inner.state);
        for item in state.items.values().filter(|p| p.session_id == session) {
            item.request_kill();
        }
        for start in state.starting.values().filter(|p| p.session_id == session) {
            start.cancellation.cancel();
        }
        DrainTicket {
            inner: self.inner.clone(),
            ids: Some(
                state
                    .starting
                    .iter()
                    .filter(|(_, start)| start.session_id == session)
                    .map(|(id, _)| id.clone())
                    .chain(
                        state
                            .items
                            .iter()
                            .filter(|(_, item)| item.session_id == session)
                            .map(|(id, _)| id.clone()),
                    )
                    .collect(),
            ),
        }
    }
    pub fn begin_close(&self) -> DrainTicket {
        let mut state = lock(&self.inner.state);
        state.closed = true;
        for starting in state.starting.values() {
            starting.cancellation.cancel();
        }
        for item in state.items.values() {
            item.request_kill();
        }
        self.inner.changed.notify_all();
        self.inner.async_changed.notify_waiters();
        DrainTicket {
            inner: self.inner.clone(),
            ids: None,
        }
    }
    pub async fn wait(
        &self,
        handle: &ProcessHandle,
        ms: u64,
        cancellation: Option<&RequestCancellation>,
        output: bool,
    ) -> bool {
        let seen = {
            let state = lock(&handle.item.state);
            if state.status != "running" {
                return true;
            }
            state.output.total
        };
        let deadline = tokio::time::Instant::now() + Duration::from_millis(ms);
        loop {
            let changed = handle.item.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let state = lock(&handle.item.state);
                if state.status != "running" || output && state.output.total > seen {
                    return state.status != "running";
                }
            }
            tokio::select! {biased;_=maybe_cancel(cancellation)=>return !handle.item.running(),_=tokio::time::sleep_until(deadline)=>return !handle.item.running(),_=changed=>{}}
        }
    }
    pub async fn drain_process(&self, handle: &ProcessHandle) {
        loop {
            let changed = handle.item.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if !handle.item.running() {
                return;
            }
            changed.await;
        }
    }
    pub async fn execute_exec(
        &self,
        args: Value,
        context: ProcessContext,
    ) -> Result<Value, EffectError> {
        validate_args("exec", &args, &self.inner.options.facts.shell)?;
        if context.cancellation.is_cancelled() {
            return Err(EffectError::cancelled(true));
        }
        let original = args["command"]
            .as_str()
            .ok_or_else(|| before_dispatch(400, "command must be a string"))?;
        let tty = args["tty"] == true;
        let command = if tty {
            sandbox::with_tty(original, &self.inner.options.facts.platform)
                .map_err(|e| before_dispatch(e.status, e.message))?
        } else {
            original.into()
        };
        let (cwd, cwd_text) = if let Some(cwd) = args["cwd"].as_str().filter(|s| !s.is_empty()) {
            let base = context
                .cwd_text
                .clone()
                .unwrap_or_else(|| sandbox::encode_path(&context.cwd));
            let logical = sandbox::absolute(&PathBuf::from(base).join(cwd))
                .to_string_lossy()
                .into_owned();
            (PathBuf::from(sql_text(&logical)), Some(logical))
        } else {
            (context.cwd.clone(), context.cwd_text)
        };
        let mut request = StartRequest::new(command, &context.session_id, &cwd);
        request.cwd_text = cwd_text;
        request.policy = context.sandbox;
        request.stdin = args["stdin"].as_str().map(str::to_owned);
        request.keep_stdin = tty;
        request.timeout = Some(Duration::from_secs(unsigned(&args["timeout"], 3600)));
        let handle = self.start(request, &context.cancellation).await?;
        let wait_ms = if args["background"] == true {
            300
        } else {
            unsigned(&args["yield"], 20).saturating_mul(1000)
        };
        let finished = self
            .wait(&handle, wait_ms, Some(&context.cancellation), false)
            .await;
        if context.cancellation.is_cancelled() {
            self.kill(&handle);
            self.drain_process(&handle).await;
        }
        let raw = {
            let mut state = lock(&handle.item.state);
            let raw = state.output.read(0);
            if !finished && state.status == "running" {
                state.output.cursor = state.output.total;
            }
            raw
        };
        let snapshot = handle.snapshot();
        if snapshot.cleanup_uncertain {
            return Err(uncertain_effect(&snapshot));
        }
        Ok(
            json!({"text":report(&snapshot,&raw,Some(wait_ms)),"data":{"processId":if snapshot.status=="running"{Some(snapshot.id.clone())}else{None},"exitCode":snapshot.exit_code}}),
        )
    }
    pub async fn execute_process(
        &self,
        args: Value,
        context: ProcessContext,
    ) -> Result<Value, EffectError> {
        validate_args("process", &args, &self.inner.options.facts.shell)?;
        if context.cancellation.is_cancelled() {
            return Err(EffectError::cancelled(true));
        }
        let action = args["action"]
            .as_str()
            .ok_or_else(|| before_dispatch(400, "action must be a string"))?;
        if action == "list" {
            return Ok(json!({"text":pretty_one(&json!(self.list(Some(&context.session_id))))?}));
        }
        let id = args["id"].as_str().unwrap_or("");
        let handle = self.get(id, Some(&context.session_id))?;
        if action == "kill" {
            self.kill(&handle);
            self.wait(&handle, 4000, Some(&context.cancellation), false)
                .await;
            let snapshot = handle.snapshot();
            let raw = handle.output(snapshot.cursor);
            return Ok(json!({"text":report(&snapshot,&raw,None)}));
        }
        if action == "write" {
            if !handle.item.running() {
                return Err(ApiError::new(409, "The process has already exited.").into());
            }
            send_input(
                &handle.item,
                args["input"].as_str().unwrap_or(""),
                args["close"] == true,
            );
            self.wait(&handle, 500, Some(&context.cancellation), false)
                .await;
        }
        if action == "log" {
            let snapshot = handle.snapshot();
            return Ok(
                json!({"text":report(&snapshot,&handle.output(unsigned(&args["offset"],0)),None)}),
            );
        }
        if action == "poll" && {
            let state = lock(&handle.item.state);
            state.status == "running" && state.output.total == state.output.cursor
        } {
            self.wait(
                &handle,
                unsigned(&args["wait"], 5).saturating_mul(1000),
                Some(&context.cancellation),
                true,
            )
            .await;
            self.wait(&handle, 300, Some(&context.cancellation), false)
                .await;
        }
        let raw = lock(&handle.item.state).output.poll();
        let snapshot = handle.snapshot();
        let waited = (self.inner.options.clock)()
            .saturating_sub(snapshot.started_at)
            .max(0) as u64;
        Ok(json!({"text":report(&snapshot,&raw,Some(waited))}))
    }
}
fn send_input(item: &Item, text: &str, close: bool) {
    if let Some(sender) = lock(&item.input).as_ref() {
        let _ = sender.send(Input {
            bytes: sql_text(text).into_bytes(),
            close,
        });
    }
}
async fn write_inputs(
    mut stdin: ChildStdin,
    mut input: mpsc::UnboundedReceiver<Input>,
    capture: RequestCancellation,
) {
    loop {
        let request =
            tokio::select! {biased;_=capture.cancelled()=>return,value=input.recv()=>value};
        let Some(request) = request else {
            return;
        };
        tokio::select! {biased;_=capture.cancelled()=>return,_=stdin.write_all(&request.bytes)=>{}}
        if request.close {
            tokio::select! {biased;_=capture.cancelled()=>{},_=stdin.shutdown()=>{}}
            return;
        }
    }
}
async fn read_output<R: AsyncRead + Unpin>(
    mut stream: R,
    item: Arc<Item>,
    capture: RequestCancellation,
) -> Result<(), std::io::Error> {
    let mut decoder = Utf8Decoder::default();
    let mut buffer = [0u8; 8192];
    let result = loop {
        let result = tokio::select! {biased;_=capture.cancelled()=>break Ok(()),result=stream.read(&mut buffer)=>result};
        match result {
            Ok(0) => break Ok(()),
            Ok(n) => item.take(&decoder.push(&buffer[..n])),
            Err(error) => break Err(error),
        }
    };
    item.take(&decoder.finish());
    result
}
fn mark_uncertain(inner: &Inner, item: &Item, reason: &str) {
    let mut state = lock(&item.state);
    let first = !state.cleanup_uncertain;
    state.output_truncated = true;
    state.cleanup_uncertain = true;
    drop(state);
    if first {
        item.take(&format!(
            "\n[output capture truncated; descendant outcome unknown: {reason}]\n"
        ));
    }
    lock(&inner.state).errors.insert(
        item.id.clone(),
        format!("Process {} cleanup is uncertain: {reason}", item.id),
    );
}
fn uncertain_effect(snapshot: &ProcessSnapshot) -> EffectError {
    let mut error=EffectError::new(format!("Process {} owned child exited, but inherited pipes did not drain after cancellation. Output was truncated; an escaped descendant may still be running.",snapshot.id));
    error.error["outcomeUnknown"] = json!(true);
    error.error["outputTruncated"] = json!(true);
    error.error["processId"] = json!(snapshot.id);
    error.error["notExecuted"] = json!(false);
    error
}
/// Keep a Linux child unreaped until pipe cleanup is complete. Its PID cannot be
/// reused in the meantime, so negative-PID group termination never targets a new
/// unrelated process group. Other platforms use the owned Child handle and stop
/// issuing PID-based kills after it has been reaped.
#[cfg(target_os = "linux")]
fn peek_owned_exit(pid: u32) -> std::io::Result<bool> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result == 0 {
        return Ok(unsafe { info.si_pid() } == pid as i32);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::EINTR) {
        Ok(false)
    } else {
        Err(error)
    }
}
async fn owned_exit_without_reaping(
    _child: &mut Child,
    item: &Item,
) -> std::io::Result<Option<ExitStatus>> {
    #[cfg(target_os = "linux")]
    {
        let pid = item
            .pid
            .ok_or_else(|| std::io::Error::other("Missing owned child PID"))?;
        loop {
            match peek_owned_exit(pid) {
                Ok(true) => return Ok(None),
                Ok(false) => {}
                Err(error) => {
                    item.child_reaped.store(true, Ordering::Release);
                    return Err(error);
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let result = _child.wait().await;
        item.child_reaped.store(true, Ordering::Release);
        result.map(Some)
    }
}

fn finish(inner: &Inner, item: &Item, exit_code: Option<i32>, signal: Option<String>) {
    let mut state = lock(&item.state);
    if state.status != "running" {
        return;
    }
    state.ended_at = Some((inner.options.clock)());
    state.exit_code = exit_code;
    state.signal = signal;
    state.status = if state.cleanup_uncertain {
        "unknown"
    } else if state.killed {
        "killed"
    } else {
        "exited"
    };
    drop(state);
    item.changed.notify_waiters();
    let _guard = lock(&inner.state);
    inner.changed.notify_all();
    inner.async_changed.notify_waiters();
}
async fn supervise(
    inner: Arc<Inner>,
    item: Arc<Item>,
    mut child: Child,
    input: mpsc::UnboundedReceiver<Input>,
    timeout: Option<Duration>,
    mut guard: SupervisorGuard,
) {
    let capture = RequestCancellation::new();
    let out = child
        .stdout
        .take()
        .map(|stream| tokio::spawn(read_output(stream, item.clone(), capture.clone())));
    let err = child
        .stderr
        .take()
        .map(|stream| tokio::spawn(read_output(stream, item.clone(), capture.clone())));
    let stdin = child
        .stdin
        .take()
        .map(|stream| tokio::spawn(write_inputs(stream, input, capture.clone())));
    let drained = AtomicBool::new(false);
    let drain_changed = Notify::new();
    let life = async {
        let observed = owned_exit_without_reaping(&mut child, &item).await;
        let observed_at = Instant::now();
        if observed.is_err() {
            mark_uncertain(&inner, &item, "Owned child exit could not be confirmed");
            capture.cancel();
        }
        lock(&item.input).take();
        let pipes = async {
            if let Some(task) = stdin {
                if task.await.is_err() {
                    mark_uncertain(&inner, &item, "Process stdin task terminated unexpectedly");
                }
            }
            if let Some(task) = out {
                if !matches!(task.await, Ok(Ok(()))) {
                    mark_uncertain(&inner, &item, "Process stdout could not be drained");
                }
            }
            if let Some(task) = err {
                if !matches!(task.await, Ok(Ok(()))) {
                    mark_uncertain(&inner, &item, "Process stderr could not be drained");
                }
            }
        };
        tokio::pin!(pipes);
        tokio::select! {
            _=&mut pipes=>{},
            _=async {
                item.kill.cancelled().await;
                let requested=lock(&item.kill_started).unwrap_or_else(Instant::now);
                // Keep the source's TERM→KILL escalation before bounding pipes.
                let deadline=(requested+Duration::from_secs(4)).max(observed_at+Duration::from_secs(1));
                tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
            }=>{
                mark_uncertain(&inner,&item,"Inherited pipes remained open after the owned child exited");capture.cancel();pipes.await;
            }
        }
        let exit = match observed {
            Ok(Some(status)) => Ok(status),
            Ok(None) => child.wait().await,
            Err(error) => Err(error),
        };
        item.child_reaped.store(true, Ordering::Release);
        drained.store(true, Ordering::Release);
        drain_changed.notify_waiters();
        exit
    };
    tokio::pin!(life);
    let requested = async {
        tokio::select! {biased;_=item.kill.cancelled()=>{},_=optional_timeout(timeout)=>item.request_kill(),}
    };
    let result = tokio::select! {
        biased;
        _=requested=>{
            kill_tree(&inner.options.facts.platform,&item,false).await;
            let cleanup=async {
                let container=kill_container(&item.plan);
                let escalation=async {
                    let changed=drain_changed.notified();tokio::pin!(changed);changed.as_mut().enable();
                    if !drained.load(Ordering::Acquire){tokio::select!{_=changed=>{},_=tokio::time::sleep(Duration::from_secs(3))=>{if !drained.load(Ordering::Acquire){kill_tree(&inner.options.facts.platform,&item,true).await;}}}}
                };
                tokio::join!(container,escalation);
            };
            let(result,_)=tokio::join!(life,cleanup);result
        },
        result=&mut life=>result,
    };
    match result {
        Ok(status) => {
            let (code, signal) = exit_status(status);
            finish(&inner, &item, code, signal);
        }
        Err(error) => {
            item.take(&format!("\n[failed to wait: {error}]\n"));
            finish(&inner, &item, Some(127), None);
        }
    }
    guard.finished = true;
}
struct SupervisorGuard {
    inner: Arc<Inner>,
    item: Arc<Item>,
    finished: bool,
}
impl Drop for SupervisorGuard {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        #[cfg(unix)]
        if let Some(pid) = self
            .item
            .pid
            .filter(|_| !self.item.child_reaped.load(Ordering::Acquire))
        {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
                libc::kill(pid as i32, libc::SIGKILL);
            }
        }
        lock(&self.item.state).killed = true;
        mark_uncertain(
            &self.inner,
            &self.item,
            "Process supervisor terminated before confirming complete cleanup",
        );
        finish(&self.inner, &self.item, None, None);
    }
}
async fn kill_tree(platform: &Platform, item: &Item, force: bool) {
    if item.child_reaped.load(Ordering::Acquire) {
        return;
    }
    let Some(pid) = item.pid else {
        return;
    };
    if *platform == Platform::Windows {
        let mut command = Command::new("taskkill");
        command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        if let Ok(mut child) = command.spawn() {
            let _ = tokio::time::timeout(Duration::from_secs(4), child.wait()).await;
        }
        return;
    }
    #[cfg(unix)]
    unsafe {
        let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
        if libc::kill(-(pid as i32), signal) != 0 {
            libc::kill(pid as i32, signal);
        }
    }
    #[cfg(not(unix))]
    let _ = (pid, force);
}
async fn kill_container(plan: &SpawnPlan) {
    if let Some(name) = &plan.container {
        let mut command = Command::new(&plan.file);
        command
            .args(["kill", name])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        if let Ok(mut child) = command.spawn() {
            let _ = tokio::time::timeout(Duration::from_secs(4), child.wait()).await;
        }
    }
}
fn detached(command: &mut Command) {
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
}
fn exit_status(status: ExitStatus) -> (Option<i32>, Option<String>) {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        let signal = status.signal().map(|s| match s {
            libc::SIGTERM => "SIGTERM".into(),
            libc::SIGKILL => "SIGKILL".into(),
            libc::SIGINT => "SIGINT".into(),
            libc::SIGHUP => "SIGHUP".into(),
            libc::SIGQUIT => "SIGQUIT".into(),
            libc::SIGPIPE => "SIGPIPE".into(),
            libc::SIGSEGV => "SIGSEGV".into(),
            libc::SIGABRT => "SIGABRT".into(),
            libc::SIGALRM => "SIGALRM".into(),
            libc::SIGBUS => "SIGBUS".into(),
            libc::SIGFPE => "SIGFPE".into(),
            libc::SIGILL => "SIGILL".into(),
            libc::SIGTRAP => "SIGTRAP".into(),
            libc::SIGUSR1 => "SIGUSR1".into(),
            libc::SIGUSR2 => "SIGUSR2".into(),
            libc::SIGCHLD => "SIGCHLD".into(),
            libc::SIGCONT => "SIGCONT".into(),
            libc::SIGSTOP => "SIGSTOP".into(),
            libc::SIGTSTP => "SIGTSTP".into(),
            libc::SIGTTIN => "SIGTTIN".into(),
            libc::SIGTTOU => "SIGTTOU".into(),
            libc::SIGURG => "SIGURG".into(),
            libc::SIGXCPU => "SIGXCPU".into(),
            libc::SIGXFSZ => "SIGXFSZ".into(),
            libc::SIGVTALRM => "SIGVTALRM".into(),
            libc::SIGPROF => "SIGPROF".into(),
            libc::SIGWINCH => "SIGWINCH".into(),
            libc::SIGIO => "SIGIO".into(),
            libc::SIGSYS => "SIGSYS".into(),
            _ => format!("SIG{s}"),
        });
        (status.code(), signal)
    }
    #[cfg(not(unix))]
    {
        (status.code(), None)
    }
}
async fn optional_timeout(timeout: Option<Duration>) {
    match timeout {
        Some(duration) => tokio::time::sleep(duration).await,
        None => std::future::pending().await,
    }
}
async fn maybe_cancel(cancel: Option<&RequestCancellation>) {
    match cancel {
        Some(cancel) => {
            cancel.cancelled().await;
        }
        None => std::future::pending().await,
    }
}
fn check_cancel(a: &RequestCancellation, b: &RequestCancellation) -> Result<(), EffectError> {
    if a.is_cancelled() || b.is_cancelled() {
        Err(EffectError::cancelled(true))
    } else {
        Ok(())
    }
}
fn before_dispatch(status: u16, message: impl Into<String>) -> EffectError {
    let message = message.into();
    let mut error = EffectError::from(ApiError::new(status, encode_text(&message)));
    error.error["notExecuted"] = json!(true);
    error
}
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}
fn unsigned(value: &Value, default: u64) -> u64 {
    value
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| n.min(u64::MAX as f64) as u64)
        .unwrap_or(default)
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
fn report(snapshot: &ProcessSnapshot, raw: &str, waited_ms: Option<u64>) -> String {
    let text = terminal_text(raw);
    let head = if snapshot.status == "running" {
        format!(
            "still running as process {} after {} s (use process poll/kill)",
            snapshot.id,
            waited_ms
                .map(|ms| ((ms as f64 / 1000.0) + 0.5).floor().to_string())
                .unwrap_or_else(|| "NaN".into())
        )
    } else {
        format!(
            "exit {}{}{} · {} s",
            snapshot
                .exit_code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "?".into()),
            snapshot
                .signal
                .as_ref()
                .map(|s| format!(" ({s})"))
                .unwrap_or_default(),
            if snapshot.status == "killed" {
                " (killed)"
            } else {
                ""
            },
            fixed_one(
                (snapshot.ended_at.unwrap_or(snapshot.started_at) - snapshot.started_at) as f64
                    / 1000.0
            )
        )
    };
    format!(
        "{head}{}\n{}",
        if snapshot.sandbox != "off" {
            format!(" · sandbox {}", snapshot.sandbox)
        } else {
            String::new()
        },
        if text.is_empty() {
            "(no output)"
        } else {
            &text
        }
    )
}
async fn login_shell_path(
    facts: &SpawnFacts,
    environment: &[(OsString, OsString)],
    inherited: OsString,
) -> OsString {
    if facts.platform == Platform::Windows {
        return inherited;
    }
    let mut command = Command::new(&facts.shell.file);
    command
        .args(["-l", "-c", "printf \"__P__%s__P__\" \"$PATH\""])
        .env_clear()
        .envs(environment.iter().cloned())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let Ok(mut child) = command.spawn() else {
        return inherited;
    };
    let Some(mut stdout) = child.stdout.take() else {
        return inherited;
    };
    let read = async {
        let mut bytes = Vec::new();
        (&mut stdout)
            .take(1_048_577)
            .read_to_end(&mut bytes)
            .await
            .ok()?;
        if bytes.len() > 1_048_576 {
            return None;
        }
        let status = child.wait().await.ok()?;
        status.success().then_some(bytes)
    };
    let result = tokio::time::timeout(Duration::from_secs(5), read).await;
    let Ok(Some(bytes)) = result else {
        let _ = child.kill().await;
        let _ = child.wait().await;
        return inherited;
    };
    let output = String::from_utf8_lossy(&bytes);
    let Some(start) = output.find("__P__") else {
        return inherited;
    };
    let Some(end) = output[start + 5..].find("__P__") else {
        return inherited;
    };
    let value = &output[start + 5..start + 5 + end];
    if value.is_empty() || value.contains('\n') {
        return inherited;
    }
    let inherited = inherited.to_string_lossy();
    let mut paths = vec![];
    for path in value
        .split(':')
        .chain(inherited.split(':'))
        .filter(|p| !p.is_empty())
    {
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths.join(":").into()
}
fn pretty_one(value: &Value) -> Result<String, EffectError> {
    let payload = json_codec::stringify_js(&json!({"result":value}))
        .map_err(|e| EffectError::new(e.to_string()))?;
    let text = tepora_core::harness::call_json("format.toText", &payload)
        .map_err(|e| EffectError::new(e.to_string()))?;
    json_codec::parse(&text)
        .map_err(|e| EffectError::new(e.to_string()))?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| EffectError::new("Process list formatter returned an invalid value"))
}

/// Frozen descriptors retain the original schemas, summaries, custom receipt
/// stub and ephemeral identity. Parent registration must keep TOOLSETS ordering.
pub fn catalog(shell: &sandbox::Shell) -> Vec<Value> {
    let mut definitions = json_codec::parse(include_str!("processes/catalog.json"))
        .expect("Frozen process catalog is valid")
        .as_array()
        .unwrap()
        .clone();
    definitions[0]["parameters"]["properties"]["command"]["description"] =
        json!(format!("Shell command line ({}).", shell.name));
    definitions
}
pub fn summarize(name: &str, args: &Value) -> Result<String, EffectError> {
    if name != "exec" {
        return Ok(name.into());
    }
    let command = if tepora_core::js_value::truthy(&args["command"]) {
        tepora_core::js_value::js_string(args.get("command"))
    } else {
        String::new()
    };
    let quoted = json_codec::stringify_js(&json!(output::slice_internal(&command, 80)))
        .map_err(|e| EffectError::new(e.to_string()))?;
    Ok(format!("exec {}", encode_text(&quoted)))
}
pub fn exec_stub(args: &Value, result: &Value) -> Result<String, EffectError> {
    let command = if tepora_core::js_value::truthy(&args["command"]) {
        tepora_core::js_value::js_string(args.get("command"))
    } else {
        String::new()
    };
    let quoted = json_codec::stringify_js(&json!(output::slice_internal(&command, 70)))
        .map_err(|e| EffectError::new(e.to_string()))?;
    let end = if tepora_core::js_value::truthy(&result["data"]["processId"]) {
        format!(
            "running {}",
            tepora_core::js_value::js_string(result["data"].get("processId"))
        )
    } else {
        format!(
            "exit {}",
            result["data"]
                .get("exitCode")
                .filter(|v| !v.is_null())
                .map(|v| tepora_core::js_value::js_string(Some(v)))
                .unwrap_or_else(|| "?".into())
        )
    };
    Ok(format!("exec {} → {end}", encode_text(&quoted)))
}
pub fn ephemeral_key(args: &Value) -> String {
    format!(
        "process:{}",
        if tepora_core::js_value::truthy(&args["id"]) {
            tepora_core::js_value::js_string(args.get("id"))
        } else {
            "list".into()
        }
    )
}
/// Canonical args are retained verbatim by the parent approval host. This helper
/// produces no permission; it lets that host bind its checked snapshot exactly.
pub fn approval_metadata(
    name: &str,
    args: &Value,
    definition_key: &str,
) -> Result<Value, EffectError> {
    if !matches!(name, "exec" | "process") {
        return Err(before_dispatch(400, "Unknown process tool"));
    }
    Ok(
        json!({"name":name,"args":args,"definitionKey":definition_key,"argsJSON":encode_text(&json_codec::stringify_js(args).map_err(|e|EffectError::new(e.to_string()))?)}),
    )
}
fn validate_args(name: &str, args: &Value, shell: &sandbox::Shell) -> Result<(), EffectError> {
    let definition = catalog(shell)
        .into_iter()
        .find(|d| d["name"] == name)
        .ok_or_else(|| before_dispatch(400, "Unknown process tool"))?;
    let payload = json_codec::stringify_js(&json!({"schema":definition["parameters"],"args":args}))
        .map_err(|e| EffectError::new(e.to_string()))?;
    let invalid = tepora_core::harness::call_json("format.checkArgs", &payload)
        .map_err(|e| EffectError::new(e.to_string()))?;
    let invalid = json_codec::parse(&invalid).map_err(|e| EffectError::new(e.to_string()))?;
    if invalid.is_null() {
        Ok(())
    } else {
        Err(before_dispatch(
            400,
            format!(
                "Invalid arguments for {name}: {}",
                sql_text(invalid.as_str().unwrap_or("Invalid arguments"))
            ),
        ))
    }
}

#[cfg(test)]
mod tests;
