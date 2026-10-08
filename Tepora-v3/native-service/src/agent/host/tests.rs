//! Real Workspace + native engines + provider protocol + host integration.
//! Only the socket transport is scripted; no external model or Node is used.
#[cfg(unix)]
mod process_tests;
mod attachment_tests;
mod decision_tests;
mod deletion_tests;
mod scheduling_tests;
mod semantic_tests;
mod web_tests;
use super::*;
use crate::{
    agent::{AgentCoordinator, AgentHandle},
    network::{
        Admitted, ByteStream, NetworkFuture, NetworkPolicy, NetworkRequest, RequestCancellation,
        Resolver, Transport, TransportResponse,
    },
    workspace::Workspace,
    Backend, EventRequest,
};
use bytes::Bytes;
use hyper::{header::HeaderValue, HeaderMap};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Condvar,
    },
    thread,
    time::{Duration, Instant},
};

enum Response {
    Json(Value),
    Sse(Vec<String>),
    Block,
    Wait(Arc<tokio::sync::Semaphore>, Box<Response>),
}
type Model = dyn Fn(&str, usize, &Value) -> Response + Send + Sync;
struct ScriptedTransport {
    model: Arc<Model>,
    requests: Mutex<Vec<Value>>,
    counts: Mutex<HashMap<String, usize>>,
    changed: Condvar,
    live: Arc<AtomicUsize>,
    web_requests: Mutex<Vec<String>>,
    web_block: std::sync::atomic::AtomicBool,
}
impl ScriptedTransport {
    fn new(model: impl Fn(&str, usize, &Value) -> Response + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            model: Arc::new(model),
            requests: Mutex::new(vec![]),
            counts: Mutex::new(HashMap::new()),
            changed: Condvar::new(),
            live: Arc::new(AtomicUsize::new(0)),
            web_requests: Mutex::default(),
            web_block: std::sync::atomic::AtomicBool::new(false),
        })
    }
    fn wait_requests(&self, count: usize) {
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut requests = self.requests.lock().unwrap();
        while requests.len() < count {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(
                !remaining.is_zero(),
                "Provider never reached request {count}; actual={requests:?}"
            );
            requests = self.changed.wait_timeout(requests, remaining).unwrap().0;
        }
    }
}
struct LiveRequest(Arc<AtomicUsize>);
impl Drop for LiveRequest {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
struct NoDns;
impl Resolver for NoDns {
    fn lookup<'a>(&'a self, host: &'a str) -> NetworkFuture<'a, Vec<String>> {
        Box::pin(async move { panic!("The native integration fixture attempted DNS for {host}") })
    }
}
impl Transport for ScriptedTransport {
    fn request<'a>(
        &'a self,
        admitted: Admitted,
        request: NetworkRequest,
        _cancel: RequestCancellation,
    ) -> NetworkFuture<'a, TransportResponse> {
        Box::pin(async move {
            assert!(
                admitted.address.is_loopback(),
                "Fixture admitted a non-loopback address"
            );
            // This sole web endpoint is a synthetic transport response, never
            // a real socket or a permissive fallback for unexpected requests.
            if admitted.url.as_str() == web_tests::FIXTURE_URL {
                assert_eq!(admitted.purpose, crate::network::Purpose::WebTool);
                assert_eq!(request.method, hyper::Method::GET);
                self.web_requests
                    .lock()
                    .unwrap()
                    .push(admitted.url.to_string());
                self.changed.notify_all();
                if self.web_block.load(Ordering::SeqCst) {
                    return std::future::pending().await;
                }
                let mut headers = HeaderMap::new();
                headers.insert("content-type", HeaderValue::from_static("text/plain"));
                return Ok(TransportResponse {
                    status: 200,
                    headers,
                    body: Some(Box::pin(futures_util::stream::iter(vec![Ok(
                        Bytes::from_static(web_tests::FIXTURE_TEXT.as_bytes()),
                    )]))),
                });
            }
            assert!(
                admitted.url.path().ends_with("/chat/completions")
                    || admitted.url.path().ends_with("/systemone")
                    || admitted.url.path().ends_with("/embeddings"),
                "No limits discovery is permitted in this fixture: {}",
                admitted.url
            );
            let wire = json_codec::parse(std::str::from_utf8(&request.body).unwrap()).unwrap();
            let model = wire["model"].as_str().unwrap().to_owned();
            let index = {
                let mut counts = self.counts.lock().unwrap();
                let count = counts.entry(model.clone()).or_default();
                let index = *count;
                *count += 1;
                index
            };
            self.requests.lock().unwrap().push(wire.clone());
            self.changed.notify_all();
            self.live.fetch_add(1, Ordering::SeqCst);
            let _live = LiveRequest(self.live.clone());
            let mut response = (self.model)(&model, index, &wire);
            let response = loop {
                match response {
                    Response::Wait(gate, next) => {
                        gate.acquire().await.unwrap().forget();
                        response = *next;
                    }
                    other => break other,
                }
            };
            let (kind, chunks) = match response {
                Response::Json(value) => (
                    "application/json",
                    vec![json_codec::stringify_js(&value).unwrap().into_bytes()],
                ),
                Response::Sse(chunks) => (
                    "text/event-stream",
                    chunks.into_iter().map(String::into_bytes).collect(),
                ),
                Response::Block => return std::future::pending().await,
                Response::Wait(_, _) => unreachable!(),
            };
            let mut headers = HeaderMap::new();
            headers.insert("content-type", HeaderValue::from_static(kind));
            let body: ByteStream = Box::pin(futures_util::stream::iter(
                chunks.into_iter().map(|chunk| Ok(Bytes::from(chunk))),
            ));
            Ok(TransportResponse {
                status: 200,
                headers,
                body: Some(body),
            })
        })
    }
}
fn answer(text: &str) -> Response {
    Response::Json(
        json!({"choices":[{"message":{"role":"assistant","content":text},"finish_reason":"stop"}],"usage":{"prompt_tokens":123,"completion_tokens":7}}),
    )
}
fn calls(calls: Vec<Value>) -> Response {
    Response::Json(
        json!({"choices":[{"message":{"role":"assistant","content":"","tool_calls":calls},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":123,"completion_tokens":11}}),
    )
}
fn call(id: &str, name: &str, args: Value) -> Value {
    json!({"id":id,"type":"function","function":{"name":name,"arguments":json_codec::stringify_js(&args).unwrap()}})
}
fn sse_answer(chunks: &[&str]) -> Response {
    let mut events = chunks
        .iter()
        .map(|text| {
            format!(
                "data: {}\n\n",
                json!({"choices":[{"delta":{"content":text},"finish_reason":null}]})
            )
        })
        .collect::<Vec<_>>();
    events.push(format!("data: {}\n\n",json!({"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":123,"completion_tokens":7}})));
    events.push("data: [DONE]\n\n".into());
    Response::Sse(events)
}

struct Fixture {
    dir: PathBuf,
    workspace: Workspace,
    host: Arc<NativeAgentHost>,
    handle: AgentHandle,
    transport: Arc<ScriptedTransport>,
    runtime: Option<tokio::runtime::Runtime>,
    closed: bool,
    keep: bool,
    fifo: Option<PathBuf>,
    capabilities: Option<crate::capabilities::Capabilities>,
    semantic: Option<Arc<crate::semantic::SemanticMemory>>,
}
impl Fixture {
    fn new(model: impl Fn(&str, usize, &Value) -> Response + Send + Sync + 'static) -> Self {
        let dir = std::env::temp_dir().join(format!("tepora-real-agent-{}", uuid::Uuid::new_v4()));
        Self::open(dir, ScriptedTransport::new(model))
    }
    fn new_decisions(
        model: impl Fn(&str, usize, &Value) -> Response + Send + Sync + 'static,
    ) -> Self {
        let dir =
            std::env::temp_dir().join(format!("tepora-decision-agent-{}", uuid::Uuid::new_v4()));
        Self::open_configured(dir, ScriptedTransport::new(model), true)
    }
    fn open(dir: PathBuf, transport: Arc<ScriptedTransport>) -> Self {
        Self::open_with_blocking(dir, transport, 4)
    }
    fn open_with_blocking(
        dir: PathBuf,
        transport: Arc<ScriptedTransport>,
        blocking_threads: usize,
    ) -> Self {
        Self::open_configured_with_blocking(dir, transport, false, blocking_threads)
    }
    fn open_configured(dir: PathBuf, transport: Arc<ScriptedTransport>, decision: bool) -> Self {
        Self::open_configured_with_blocking(dir, transport, decision, 4)
    }
    fn new_semantic(
        model: impl Fn(&str, usize, &Value) -> Response + Send + Sync + 'static,
    ) -> Self {
        let dir =
            std::env::temp_dir().join(format!("tepora-semantic-agent-{}", uuid::Uuid::new_v4()));
        Self::open_services(dir, ScriptedTransport::new(model), false, true, 4)
    }
    fn open_configured_with_blocking(
        dir: PathBuf,
        transport: Arc<ScriptedTransport>,
        decision: bool,
        blocking_threads: usize,
    ) -> Self {
        Self::open_services(dir, transport, decision, false, blocking_threads)
    }
    fn open_services(
        dir: PathBuf,
        transport: Arc<ScriptedTransport>,
        decision: bool,
        embedding: bool,
        blocking_threads: usize,
    ) -> Self {
        let workspace = Workspace::open(&dir).unwrap();
        let state = workspace.access();
        let network = NativeNetwork::with_components(
            NetworkPolicy::default(),
            Arc::new(NoDns),
            transport.clone(),
        );
        let provider = ProviderRuntime::with_options(
            Arc::new(state.clone()),
            network.clone(),
            false,
            Arc::new(|| chrono::Utc::now().timestamp_millis()),
        );
        if !provider.configured().unwrap() {
            provider.save(&json!({"profiles":[{"id":"main-fixture","protocol":"chat-completions","baseUrl":"http://127.0.0.1:17777/v1","model":"main","domain":"device","contextTokens":65536,"maxTokens":2048,"maxParallel":4},{"id":"work-fixture","protocol":"chat-completions","baseUrl":"http://127.0.0.1:17777/v1","model":"worker","domain":"device","contextTokens":65536,"maxTokens":2048,"maxParallel":4}],"routes":{"main":{"primary":"main-fixture"},"work":{"primary":"work-fixture"}}}),0).unwrap();
        }
        let capabilities = (decision || embedding).then(|| {
            crate::capabilities::Capabilities::new(Arc::new(state.clone()), network.clone())
        });
        let semantic = capabilities.as_ref().filter(|_| embedding).map(|cap| {
            Arc::new(crate::semantic::SemanticMemory::new(
                Arc::new(state.clone()),
                cap.clone(),
            ))
        });
        let host = Arc::new(if let Some(cap) = &capabilities {
            let decisions = Arc::new(super::super::decisions::Decisions::with_backend(Arc::new(
                crate::capabilities::CapabilityDecisionBackend::new(cap.clone()),
            )));
            if let Some(semantic) = &semantic {
                NativeAgentHost::new_with_semantic(
                    state,
                    provider,
                    network,
                    decisions,
                    semantic.clone(),
                )
                .unwrap()
            } else {
                NativeAgentHost::new_with_decisions(state, provider, network, decisions).unwrap()
            }
        } else {
            NativeAgentHost::new(state, provider, network).unwrap()
        });
        host.preflight().unwrap();
        if let Some(cap) = &capabilities {
            let (id, protocol, model, role) = if embedding {
                (
                    "embedding-fixture",
                    "openai-embeddings",
                    "embedding",
                    "embedding",
                )
            } else {
                ("decision-fixture", "system-one", "decision", "decision")
            };
            let mut routes=serde_json::Map::new();routes.insert(role.into(),json!(id));
            cap.save(&json!({"profiles":[{"id":id,"protocol":protocol,"baseUrl":"http://127.0.0.1:17777/v1","model":model,"domain":"device","resource":id}],"routes":routes}),0).unwrap();
        }
        host.preflight().unwrap();
        host.recover().unwrap();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .max_blocking_threads(blocking_threads)
            .enable_all()
            .build()
            .unwrap();
        let handle = AgentCoordinator::start(host.clone(), runtime.handle().clone()).unwrap();
        Self {
            dir,
            workspace,
            host,
            handle,
            transport,
            runtime: Some(runtime),
            closed: false,
            keep: false,
            fifo: None,
            capabilities,
            semantic,
        }
    }
    fn state(&self, op: &str, args: Value) -> Value {
        self.workspace.access().agent_state(op, args).unwrap()
    }
    fn main(&self) -> Value {
        self.state("session.list", json!({"kind":"main"}))[0].clone()
    }
    fn input(&self, text: &str) -> Value {
        self.handle
            .request(AgentRequest::Input {
                body: json!({"text":text}),
            })
            .unwrap()
    }
    fn entries(&self, id: &str) -> Vec<Value> {
        array(&self.state("session.entries", json!({"id":id})))
    }
    fn wait(&self, label: &str, predicate: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !predicate() {
            assert!(
                Instant::now() < deadline,
                "{label} did not settle; sessions={} requests={:?}",
                self.state("session.list", json!({})),
                self.transport.requests.lock().unwrap()
            );
            thread::sleep(Duration::from_millis(5));
        }
    }
    fn idle(&self, id: &str) {
        self.wait("session idle", || {
            self.handle
                .state(id)
                .is_ok_and(|v| v["runtime"]["active"] == false && v["pending"] == 0)
        });
    }
    fn close(&mut self) {
        if self.closed {
            return;
        }
        let close = self.handle.begin_close();
        self.wait("coordinator close", || close.is_complete());
        close.wait().unwrap();
        if let Some(semantic) = &self.semantic {
            self.runtime
                .as_ref()
                .unwrap()
                .block_on(semantic.close_and_drain());
        }
        assert_eq!(self.host.provider.active_count(), 0);
        assert_eq!(self.host.network.active_count(), 0);
        self.workspace.shutdown().unwrap();
        self.closed = true;
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // A failing FIFO assertion must still release the real blocking read.
        #[cfg(unix)]
        let _emergency = self.fifo.as_ref().and_then(|path| {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(path)
                .ok()?;
            let _ = file.write_all(&[0]);
            Some(file)
        });
        if !self.closed {
            let close = self.handle.begin_close();
            let deadline = Instant::now() + Duration::from_secs(5);
            while !close.is_complete() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(5));
            }
            if close.is_complete() {
                let _ = close.wait();
                let _ = self.workspace.shutdown();
            }
        }
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_timeout(Duration::from_secs(2));
        }
        if !self.keep {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
}

#[test]
fn real_text_stream_tools_budget_account_and_restart_persistence() {
    let mut f = Fixture::new(|model, _, _| {
        assert_eq!(model, "main");
        sse_answer(&["Hello ", "native 🌱"])
    });
    let main = f.main();
    let id = main["id"].as_str().unwrap().to_owned();
    let mut events = f
        .workspace
        .subscribe(EventRequest {
            since: 0,
            reconnect: false,
        })
        .unwrap();
    let receipt = f.input("Say hello");
    assert_eq!(receipt["accepted"], true);
    assert_eq!(receipt["sessionId"], id);
    f.transport.wait_requests(1);
    f.idle(&id);
    let entries = f.entries(&id);
    let assistant = entries
        .iter()
        .find(|e| e["type"] == "assistant")
        .expect("No assistant transcript committed");
    assert_eq!(assistant["content"], "Hello native 🌱");
    let request = f.transport.requests.lock().unwrap()[0].clone();
    assert_eq!(request["model"], "main");
    assert_eq!(request["messages"][0]["role"], "system");
    assert!(request["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("Native availability"));
    let definitions = request["tools"]
        .as_array()
        .expect("Provider received no tools array");
    assert!(
        !definitions.is_empty(),
        "A null initial budget toolDefs must use session tool definitions"
    );
    assert!(definitions
        .iter()
        .any(|d| d["function"]["name"] == "sessions_spawn"));
    assert!(!definitions.iter().any(|d| d["function"]["name"] == "exec"));
    let session = f.state("session.get", json!({"id":id}));
    assert_eq!(session["stats"]["steps"], 1.0);
    assert!(session["stats"]["input"].as_f64().unwrap() > 0.0);
    let mut saw_reply = false;
    let mut saw_done = false;
    while let Ok(event) = events.receiver.try_recv() {
        if event.event_type == "agent.reply" {
            saw_reply = true;
        }
        if event.event_type == "agent.delta" && event.data["done"] == true {
            assert_eq!(event.data["text"], "Hello native 🌱");
            saw_done = true;
        }
    }
    assert!(
        saw_reply && saw_done,
        "Expected real stream completion and reply events"
    );
    f.close();
    let reopened = Workspace::open(&f.dir).unwrap();
    let persisted = reopened
        .access()
        .agent_state("session.entries", json!({"id":id}))
        .unwrap();
    assert!(persisted
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["type"] == "assistant" && e["content"] == "Hello native 🌱"));
    reopened.shutdown().unwrap();
}

#[test]
fn silent_main_reply_never_exposes_partial_no_reply() {
    let mut f = Fixture::new(|_, _, _| sse_answer(&["NO_", "RE", "PLY"]));
    let id = f.main()["id"].as_str().unwrap().to_owned();
    let mut subscription = f
        .workspace
        .subscribe(EventRequest {
            since: 0,
            reconnect: false,
        })
        .unwrap();
    f.input("Stay silent if nothing needs attention");
    f.transport.wait_requests(1);
    f.idle(&id);
    let mut replies = 0;
    while let Ok(event) = subscription.receiver.try_recv() {
        if event.event_type == "agent.delta" {
            assert_eq!(event.data["text"], "");
        }
        if event.event_type == "agent.reply" {
            assert_eq!(event.data["text"], "");
            assert_eq!(event.data["silent"], true);
            replies += 1;
        }
    }
    assert_eq!(replies, 1);
    f.close();
}

#[test]
fn main_spawn_worker_file_tools_artifact_and_parent_report_are_real() {
    let mut f = Fixture::new(|model, index, wire| {
        if model == "main" {
            if index == 0 {
                return calls(vec![call(
                    "spawn-1",
                    "sessions_spawn",
                    json!({"task":"Write result.md, read it, edit before to after, read back, and publish a Markdown artifact. Verify the actual bytes.","title":"File worker"}),
                )]);
            }
            let text = json_codec::stringify_js(&wire["messages"]).unwrap();
            return answer(if text.contains("WORKER_DONE") {
                "PARENT_CONFIRMED: the file and artifact are complete"
            } else {
                "The worker is running"
            });
        }
        assert_eq!(model, "worker");
        if index == 0 {
            return calls(vec![
                call(
                    "write-1",
                    "write",
                    json!({"path":"result.md","content":"before\n"}),
                ),
                call("read-1", "read", json!({"path":"result.md"})),
                call(
                    "edit-1",
                    "edit",
                    json!({"path":"result.md","old_string":"before","new_string":"after"}),
                ),
                call("read-2", "read", json!({"path":"result.md"})),
                call(
                    "artifact-1",
                    "artifact",
                    json!({"action":"publish","title":"Verified result","kind":"markdown","content":"after\n"}),
                ),
                call(
                    "todo-1",
                    "todo",
                    json!({"items":[{"text":"Write, edit, read back and publish result.md","status":"done"}]}),
                ),
                call(
                    "reflect-1",
                    "reflect",
                    json!({"understanding":"Write a verified file and publish it","verified":["Read back result.md after editing"],"confidence":1,"next":"Report the verified result"}),
                ),
            ]);
        }
        answer(
            "WORKER_DONE: Saved result.md with after and published the verified Markdown artifact",
        )
    });
    let main_id = f.main()["id"].as_str().unwrap().to_owned();
    f.input("Please delegate creation of result.md and publish its artifact");
    f.wait("worker and parent completion", || {
        f.entries(&main_id).iter().any(|e| {
            e["type"] == "assistant"
                && e["content"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("PARENT_CONFIRMED"))
        })
    });
    f.idle(&main_id);
    let workers = f.state("session.list", json!({"kind":"worker"}));
    assert_eq!(workers.as_array().unwrap().len(), 1);
    let worker = &workers[0];
    let id = worker["id"].as_str().unwrap();
    f.idle(id);
    assert_eq!(worker["parentId"], main_id);
    assert_eq!(worker["status"], "done");
    assert_eq!(
        fs::read_to_string(
            Path::new(&json_codec::sql_text(worker["cwd"].as_str().unwrap())).join("result.md")
        )
        .unwrap(),
        "after\n"
    );
    let entries = f.entries(id);
    let receipts = entries
        .iter()
        .filter(|e| e["type"] == "tool")
        .collect::<Vec<_>>();
    assert_eq!(
        receipts
            .iter()
            .map(|e| e["callId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "write-1",
            "read-1",
            "edit-1",
            "read-2",
            "artifact-1",
            "todo-1",
            "reflect-1"
        ]
    );
    assert!(
        receipts.iter().all(|e| e["error"] == false),
        "Unexpected tool rejection: {receipts:?}"
    );
    assert!(receipts[3]["content"].as_str().unwrap().contains("after"));
    let artifacts = f.state("document.list", json!({"kind":"artifact"}));
    assert_eq!(artifacts.as_array().unwrap().len(), 1);
    assert_eq!(artifacts[0]["content"], "after\n");
    assert_eq!(artifacts[0]["version"], 1);
    assert_eq!(
        f.state("session.get", json!({"id":id}))["todo"][0]["status"],
        "done"
    );
    let reports = f
        .entries(&main_id)
        .into_iter()
        .filter(|e| e["type"] == "input" && e["kind"] == "report" && e["sessionId"] == id)
        .collect::<Vec<_>>();
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0]["from"], format!("child:{id}"));
    assert!(reports[0]["header"].as_str().unwrap().contains("finished"));
    assert!(
        entries
            .iter()
            .any(|e| e["type"] == "event" && e["event"] == "completion-check"),
        "Default auto verification should perform its real self-check"
    );
    f.close();
}

#[test]
fn stop_during_provider_wait_rearms_main_without_replaying_old_input() {
    let mut f = Fixture::new(|_, index, _| {
        if index == 0 {
            Response::Block
        } else {
            answer("NEW_GENERATION")
        }
    });
    let id = f.main()["id"].as_str().unwrap().to_owned();
    f.input("old input");
    f.transport.wait_requests(1);
    let old_epoch = f.handle.state(&id).unwrap()["runtime"]["runEpoch"].clone();
    f.handle
        .request(AgentRequest::Stop {
            id: id.clone(),
            reason: "stop while provider waits".into(),
            rearm_main: true,
        })
        .unwrap();
    f.idle(&id);
    assert_eq!(f.host.provider.active_count(), 0);
    assert_eq!(f.host.network.active_count(), 0);
    assert_eq!(f.transport.live.load(Ordering::SeqCst), 0);
    assert!(!f.entries(&id).iter().any(|e| e["type"] == "assistant"));
    thread::sleep(Duration::from_millis(30));
    assert_eq!(
        f.transport.requests.lock().unwrap().len(),
        1,
        "Main rearm replayed canceled input"
    );
    f.input("new input");
    f.transport.wait_requests(2);
    f.idle(&id);
    assert!(f.handle.state(&id).unwrap()["runtime"]["epoch"] != old_epoch);
    assert_eq!(
        f.entries(&id)
            .iter()
            .filter(|e| e["type"] == "assistant" && e["content"] == "NEW_GENERATION")
            .count(),
        1
    );
    f.close();
}

#[test]
fn approval_allow_executes_exact_snapshot_and_stop_withdraws_without_write() {
    for allow in [true, false] {
        let mut f = Fixture::new(|_, index, _| {
            if index == 0 {
                calls(vec![call(
                    "write-approval",
                    "tools_call",
                    json!({"name":"write","arguments":{"path":"approved.txt","content":"approved bytes"}}),
                )])
            } else {
                answer("approval finished")
            }
        });
        let id = f.main()["id"].as_str().unwrap().to_owned();
        let file = PathBuf::from(json_codec::sql_text(f.main()["cwd"].as_str().unwrap()))
            .join("approved.txt");
        f.handle
            .request(AgentRequest::Configure {
                patch: json!({"policy":{"rules":[{"tool":"write","action":"ask"}]}}),
            })
            .unwrap();
        f.input("Write approved.txt after my approval");
        f.wait("pending approval", || {
            f.state("document.list", json!({"kind":"approval"}))
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a["status"] == "pending")
        });
        let approval = f.state("document.list", json!({"kind":"approval"}))[0].clone();
        let aid = approval["id"].as_str().unwrap().to_owned();
        assert_eq!(approval["tool"], "write");
        assert_eq!(
            approval["args"],
            json!({"path":"approved.txt","content":"approved bytes"})
        );
        assert!(!file.exists());
        if allow {
            f.handle
                .request(AgentRequest::DecideApproval {
                    id: aid.clone(),
                    allow: true,
                })
                .unwrap();
            f.idle(&id);
            assert_eq!(fs::read_to_string(&file).unwrap(), "approved bytes");
            let receipts = f
                .entries(&id)
                .into_iter()
                .filter(|e| e["type"] == "tool")
                .collect::<Vec<_>>();
            assert_eq!(receipts.len(), 1);
            assert_eq!(receipts[0]["error"], false);
            assert_eq!(
                f.handle
                    .request(AgentRequest::DecideApproval {
                        id: aid,
                        allow: true
                    })
                    .unwrap_err()
                    .status,
                409
            );
        } else {
            f.handle
                .request(AgentRequest::Stop {
                    id: id.clone(),
                    reason: "cancel approval".into(),
                    rearm_main: false,
                })
                .unwrap();
            f.idle(&id);
            assert_eq!(
                f.state("document.get", json!({"kind":"approval","id":aid}))["status"],
                "withdrawn"
            );
            assert!(!file.exists());
            assert_eq!(
                f.handle
                    .request(AgentRequest::DecideApproval {
                        id: aid,
                        allow: true
                    })
                    .unwrap_err()
                    .status,
                409
            );
            let receipt = f
                .entries(&id)
                .into_iter()
                .find(|e| e["type"] == "tool")
                .unwrap();
            assert_eq!(receipt["notExecuted"], true);
            assert_eq!(
                f.state("session.get", json!({"id":id}))["note"],
                "cancel approval"
            );
        }
        f.close();
    }
}

#[test]
fn close_cancels_pending_approval_and_drains_its_receipt() {
    let mut f = Fixture::new(|_, _, _| {
        calls(vec![call(
            "ask-close",
            "tools_call",
            json!({"name":"write","arguments":{"path":"never.txt","content":"no"}}),
        )])
    });
    let id = f.main()["id"].as_str().unwrap().to_owned();
    f.handle
        .request(AgentRequest::Configure {
            patch: json!({"policy":{"rules":[{"tool":"write","action":"ask"}]}}),
        })
        .unwrap();
    f.input("Wait for approval");
    f.wait("pending close approval", || {
        !f.state("document.list", json!({"kind":"approval"}))
            .as_array()
            .unwrap()
            .is_empty()
    });
    let close = f.handle.begin_close();
    f.wait("approval close drain", || close.is_complete());
    close.wait().unwrap();
    let approvals = f.state("document.list", json!({"kind":"approval"}));
    assert!(approvals
        .as_array()
        .unwrap()
        .iter()
        .all(|a| a["status"] == "withdrawn"));
    assert_eq!(
        f.entries(&id)
            .iter()
            .filter(|e| e["type"] == "tool" && e["notExecuted"] == true)
            .count(),
        1
    );
    f.close();
}

#[cfg(unix)]
#[test]
fn close_retains_sqlite_owner_until_real_blocked_file_receipt_drains() {
    use std::io::Write;
    use std::os::{fd::FromRawFd, unix::ffi::OsStrExt};
    let mut f = Fixture::new(|_, _, _| {
        calls(vec![
            call(
                "held-read",
                "tools_call",
                json!({"name":"read","arguments":{"path":"held.pipe"}}),
            ),
            call(
                "never-write",
                "tools_call",
                json!({"name":"write","arguments":{"path":"never.txt","content":"no"}}),
            ),
        ])
    });
    let main = f.main();
    let id = main["id"].as_str().unwrap().to_owned();
    let work = PathBuf::from(json_codec::sql_text(main["cwd"].as_str().unwrap()));
    let pipe = work.join("held.pipe");
    let path = std::ffi::CString::new(pipe.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    f.fifo = Some(pipe.clone());
    f.input("Read held.pipe");
    f.transport.wait_requests(1);
    let deadline = Instant::now() + Duration::from_secs(8);
    let writer = loop {
        let fd = unsafe { libc::open(path.as_ptr(), libc::O_WRONLY | libc::O_NONBLOCK) };
        if fd >= 0 {
            break fd;
        }
        assert!(
            Instant::now() < deadline,
            "Real read syscall never opened FIFO; entries={:?}",
            f.entries(&id)
        );
        thread::sleep(Duration::from_millis(5));
    };
    let mut writer = unsafe { fs::File::from_raw_fd(writer) };
    let close = f.handle.begin_close();
    thread::sleep(Duration::from_millis(30));
    assert!(
        !close.is_complete(),
        "Close completed while a dispatched read syscall was still blocked"
    );
    assert!(
        matches!(Workspace::open(&f.dir), Err(ApiError { status: 409, .. })),
        "SQLite ownership was released before file drain"
    );
    writer.write_all(&[0]).unwrap();
    drop(writer);
    f.wait("actual file receipt drain", || close.is_complete());
    close.wait().unwrap();
    let receipts = f
        .entries(&id)
        .into_iter()
        .filter(|e| e["type"] == "tool")
        .collect::<Vec<_>>();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0]["callId"], "held-read");
    assert_eq!(receipts[0]["error"], false);
    assert_eq!(receipts[0]["interrupted"], true);
    assert_ne!(receipts[0]["notExecuted"], true);
    assert_eq!(receipts[1]["notExecuted"], true);
    assert!(!work.join("never.txt").exists());
    f.fifo = None;
    f.close();
}

#[test]
fn persisted_missing_tool_receipt_recovers_once_and_never_replays_write() {
    let mut original = Fixture::new(|_, _, _| panic!("Recovery seed must not invoke a model"));
    let id = original.main()["id"].as_str().unwrap().to_owned();
    original.state(
        "session.append",
        json!({"id":id,"type":"input","body":{"text":"Create unknown.txt","from":"user"}}),
    );
    original.state("session.append",json!({"id":id,"type":"assistant","body":{"content":"","toolCalls":[{"id":"uncertain-call","name":"write","arguments":"{\"path\":\"unknown.txt\",\"content\":\"must not replay\"}"}]}}));
    original.state(
        "session.update",
        json!({"id":id,"patch":{"status":"running"}}),
    );
    let dir = original.dir.clone();
    let work = PathBuf::from(json_codec::sql_text(
        original.main()["cwd"].as_str().unwrap(),
    ));
    original.keep = true;
    original.close();
    let transport = ScriptedTransport::new(|_, _, wire| {
        let text = json_codec::stringify_js(&wire["messages"]).unwrap();
        assert!(
            text.contains("restart") || text.contains("interrupted"),
            "Recovered uncertainty was not provided to the model: {wire}"
        );
        answer("UNKNOWN_OUTCOME: I will verify before retrying")
    });
    let mut restarted = Fixture::open(dir, transport);
    restarted.host.recover().unwrap();
    restarted.handle.request(AgentRequest::Initialize).unwrap();
    restarted.transport.wait_requests(1);
    restarted.idle(&id);
    let entries = restarted.entries(&id);
    let uncertain = entries
        .iter()
        .filter(|e| e["type"] == "tool" && e["callId"] == "uncertain-call")
        .collect::<Vec<_>>();
    assert_eq!(uncertain.len(), 1);
    assert_eq!(uncertain[0]["error"], true);
    assert!(uncertain[0]["content"]
        .as_str()
        .unwrap()
        .contains("restart"));
    assert!(!work.join("unknown.txt").exists());
    restarted.close();
}

#[test]
fn unsupported_saved_authority_is_not_silently_ignored_or_resumed() {
    let f = Fixture::new(|_, _, _| answer("unused"));
    f.state("kv.set",json!({"key":"capabilities","value":{"schema":1,"revision":0,"profiles":[],"routes":{"decision":"system-one-device"}}}));
    assert_eq!(f.host.preflight().unwrap_err().status, 503);
    f.state(
        "kv.set",
        json!({"key":"capabilities","value":{"schema":1,"revision":0,"profiles":[],"routes":{}}}),
    );
    f.state(
        "kv.set",
        json!({"key":"agent-settings","value":{"heartbeat":{"enabled":1}}}),
    );
    f.host.preflight().unwrap();
    f.state("kv.set", json!({"key":"agent-settings","value":{}}));
    let schedule =
        json!({"id":"future-fixture","at":"2099-01-01T00:00:00Z","task":"fixture future task"});
    f.state("document.put", json!({"kind":"schedule","doc":schedule}));
    f.host.preflight().unwrap();
    assert_eq!(
        f.state(
            "document.get",
            json!({"kind":"schedule","id":"future-fixture"})
        ),
        schedule
    );
    f.state(
        "document.remove",
        json!({"kind":"schedule","id":"future-fixture"}),
    );
    let main = f.main();
    let session=f.state("session.update",json!({"id":main["id"],"patch":{"status":"stopped","system":"Cached legacy prefix","tools":["exec","read"]}}));
    let preserved = f.host.prompt(session.clone(), false).unwrap();
    assert_eq!(preserved["system"], session["system"]);
    assert_eq!(preserved["tools"], json!(["exec", "read"]));
    let session = f.state(
        "session.update",
        json!({"id":main["id"],"patch":{"tools":["computer","read"]}}),
    );
    assert!(f.host.prompt(session.clone(), false).is_err());
    assert_eq!(
        f.state("session.get", json!({"id":main["id"]}))["system"],
        session["system"]
    );
    assert_eq!(f.transport.requests.lock().unwrap().len(), 0);
}
