//! Real pi-ai SDK worker (Node child process) against fake transports only.
use super::*;
use crate::{
    network::{Admitted, ByteStream, NetworkFuture, NetworkPolicy, Resolver, Transport, TransportResponse},
    provider::{InvokeRequest, ProviderRuntime, ProviderState},
};
use hyper::HeaderMap;
use std::collections::VecDeque;

const CHAT: &str = include_str!("../../../tests/fixtures/pi-ai-chat.json");
fn fixture() -> Value {
    json_codec::parse(CHAT).unwrap()
}

#[derive(Default)]
struct Memory {
    values: Mutex<HashMap<String, Value>>,
    docs: Mutex<HashMap<(String, String), Value>>,
    receipts: Mutex<Vec<Value>>,
}
impl ProviderState for Memory {
    fn value(&self, k: &str) -> Result<Option<Value>, ApiError> {
        Ok(lock(&self.values).get(k).cloned())
    }
    fn set_value(&self, k: &str, v: Value) -> Result<(), ApiError> {
        lock(&self.values).insert(k.into(), v);
        Ok(())
    }
    fn record_model_call(&self, receipt: Value) -> Result<(), ApiError> {
        lock(&self.receipts).push(receipt);
        Ok(())
    }
    fn get(&self, c: &str, id: &str) -> Result<Option<Value>, ApiError> {
        Ok(lock(&self.docs).get(&(c.into(), id.into())).cloned())
    }
    fn put(&self, c: &str, v: Value) -> Result<(), ApiError> {
        lock(&self.docs).insert((c.into(), s(&v, "id").into()), v);
        Ok(())
    }
    fn emit(&self, _: &str, _: Value) -> Result<(), ApiError> {
        Ok(())
    }
}

struct PublicDns;
impl Resolver for PublicDns {
    fn lookup<'a>(&'a self, _: &'a str) -> NetworkFuture<'a, Vec<String>> {
        Box::pin(async { Ok(vec!["93.184.216.34".into()]) })
    }
}
enum Reply {
    Sse(Vec<Value>),
    Hang,
}
#[derive(Default)]
struct Fake {
    replies: Mutex<VecDeque<Reply>>,
    seen: Mutex<Vec<(String, HeaderMap, Vec<u8>)>>,
    entered: tokio::sync::Notify,
}
impl Transport for Fake {
    fn request<'a>(&'a self, a: Admitted, r: NetworkRequest, c: RequestCancellation) -> NetworkFuture<'a, TransportResponse> {
        Box::pin(async move {
            lock(&self.seen).push((a.url.to_string(), r.headers.clone(), r.body.to_vec()));
            let reply = lock(&self.replies).pop_front().expect("unexpected pi-ai request");
            let events = match reply {
                Reply::Sse(events) => events,
                Reply::Hang => {
                    self.entered.notify_one();
                    return Err(c.cancelled().await);
                }
            };
            let text: String = events
                .iter()
                .map(|e| format!("data: {}\n\n", e.as_str().map(str::to_owned).unwrap_or_else(|| json_codec::stringify_js(e).unwrap())))
                .collect();
            let mut headers = HeaderMap::new();
            headers.insert("content-type", "text/event-stream".parse().unwrap());
            let body: ByteStream = Box::pin(futures_util::stream::iter([Ok(bytes::Bytes::from(text))]));
            Ok(TransportResponse { status: 200, headers, body: Some(body) })
        })
    }
}

struct Harness {
    runtime: tokio::runtime::Runtime,
    dir: PathBuf,
    network: NativeNetwork,
    fake: Arc<Fake>,
    state: Arc<Memory>,
    registry: ProviderRuntime,
    pi: PiService,
    events: Arc<Mutex<Vec<Value>>>,
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.registry.close();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
fn harness(replies: Vec<Reply>) -> Harness {
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let dir = std::env::temp_dir().join(format!("tepora-pi-{}", uuid::Uuid::new_v4()));
    let fake = Arc::new(Fake::default());
    lock(&fake.replies).extend(replies);
    let network = NativeNetwork::with_components(NetworkPolicy::default(), Arc::new(PublicDns), fake.clone());
    let state = Arc::new(Memory::default());
    let registry = ProviderRuntime::with_options(state.clone(), network.clone(), false, Arc::new(|| 0));
    let events = Arc::new(Mutex::new(vec![]));
    let sent = events.clone();
    let pi = PiService::new(dir.join("credentials").join("pi-ai.json"), network.clone(), Arc::new(move |v| lock(&sent).push(v)), runtime.handle().clone());
    registry.attach_pi(pi.clone());
    Harness { runtime, dir, network, fake, state, registry, pi, events }
}
fn profile(extra: Value) -> Value {
    let f = fixture();
    let mut p = json!({"id":"pi-groq","name":"Groq through Pi","engine":"pi-ai","piProvider":f["provider"],"protocol":f["protocol"],
        "baseUrl":"https://api.groq.com/openai/v1","model":f["model"],"domain":"cloud","maxTokens":512});
    for (k, v) in extra.as_object().unwrap() {
        p[k] = v.clone();
    }
    p
}
fn invoke(h: &Harness, cancel: &RequestCancellation, deltas: Arc<Mutex<String>>) -> Result<Value, ProviderFailure> {
    let chain = h.registry.chain("main").unwrap();
    let sink: EventSink = Arc::new(move |e: ProviderEvent| {
        if e.kind == "text" {
            lock(&deltas).push_str(e.value.as_str().unwrap());
        }
    });
    h.runtime.block_on(h.registry.invoke(InvokeRequest { chain, messages: vec![json!({"role":"user","content":"Hello"})], options: json!({}) }, cancel, sink))
}
fn until(what: &str, mut ok: impl FnMut() -> bool) {
    let end = std::time::Instant::now() + Duration::from_secs(20);
    while !ok() {
        assert!(std::time::Instant::now() < end, "deadline: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn catalog_comes_from_the_pinned_sdk_worker() {
    let h = harness(vec![]);
    let providers = h.pi.providers().unwrap();
    assert_eq!(providers["version"], "1.5.2");
    let list = providers["providers"].as_array().unwrap();
    assert_eq!(list.len(), 43);
    assert_eq!(list.iter().filter(|p| p["oauth"].is_object()).count(), 9);
    let model = h.pi.model("groq", "llama-3.3-70b-versatile", None).unwrap().unwrap();
    assert_eq!(protocol_for(s(&model, "api")), "chat-completions");
    assert_eq!(h.pi.snapshot()["supported"], true);
}

#[test]
fn shared_fixture_streams_through_registry_key_checked_transport_and_accounting() {
    let f = fixture();
    let h = harness(vec![Reply::Sse(f["events"].as_array().unwrap().clone())]);
    let saved = h.registry.save(&json!({"profiles":[profile(json!({}))],"routes":{"main":{"primary":"pi-groq"}}}), 0).unwrap();
    assert_eq!(saved["profiles"][0]["engine"], "pi-ai");
    h.registry.set_key("pi-groq", s(&f, "key")).unwrap();
    let deltas = Arc::new(Mutex::new(String::new()));
    let answer = invoke(&h, &RequestCancellation::new(), deltas.clone()).unwrap_or_else(|e| panic!("{}", e.message));
    assert_eq!(answer["content"], f["expected"]["content"]);
    assert_eq!(*lock(&deltas), s(&f["expected"], "content"));
    assert_eq!(answer["_native"]["engine"], "pi-ai");
    assert_eq!(answer["usage"]["input"], f["expected"]["inputTokens"]);
    assert_eq!(answer["usageStatus"]["status"], f["expected"]["usageStatus"]);
    let seen = lock(&h.fake.seen);
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].0, "https://api.groq.com/openai/v1/chat/completions");
    assert_eq!(seen[0].1["authorization"], s(&f["expected"], "authorization"));
    let receipts = lock(&h.state.receipts);
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0]["outcome"], "completed");
    assert_eq!(h.pi.active_jobs(), 0);
}

#[test]
fn api_key_login_persists_a_private_vault_and_powers_inference() {
    let h = harness(vec![Reply::Sse(fixture()["events"].as_array().unwrap().clone())]);
    h.pi.begin(&json!({"provider":"groq","type":"api_key","consent":true})).unwrap();
    until("prompt", || !h.pi.snapshot()["pending"]["prompt"].is_null());
    let p = h.pi.snapshot()["pending"].clone();
    assert_eq!(p["prompt"]["type"], "secret");
    assert!(h.pi.begin(&json!({"provider":"groq","type":"api_key","consent":true})).is_err());
    h.pi.respond(&json!({"id":p["id"],"promptId":p["prompt"]["id"],"value":"synthetic-key-vault"})).unwrap();
    until("connected", || h.pi.snapshot()["pending"]["status"] == "connected");
    let account = h.pi.snapshot()["accounts"][0].clone();
    assert_eq!(account["connected"], true);
    assert!(!lock(&h.events).is_empty());
    let file = h.dir.join("credentials").join("pi-ai.json");
    assert!(std::fs::read_to_string(&file).unwrap().contains("synthetic-key-vault"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let raw = profile(json!({"authMode":"pi-key","accountId":account["id"]}));
    let saved = h.registry.save(&json!({"profiles":[raw],"routes":{"main":{"primary":"pi-groq"}}}), 0).unwrap();
    assert_eq!(saved["profiles"][0]["keyPresent"], true);
    assert_eq!(saved["profiles"][0]["authStatus"]["connected"], true);
    assert!(h.registry.set_key("pi-groq", "wrong").is_err());
    assert!(!json_codec::stringify_js(&saved).unwrap().contains("synthetic-key"));
    let answer = invoke(&h, &RequestCancellation::new(), Arc::new(Mutex::new(String::new()))).unwrap_or_else(|e| panic!("{}", e.message));
    assert_eq!(answer["content"], "Hello Pi");
    assert_eq!(lock(&h.fake.seen)[0].1["authorization"], "Bearer synthetic-key-vault");
    // Same file, new host: accounts survive a restart (and a Node/Rust host switch).
    let reopened = PiService::new(file, h.network.clone(), Arc::new(|_| {}), h.runtime.handle().clone());
    assert_eq!(reopened.status(s(&account, "id"))["connected"], true);
    h.pi.disconnect(s(&account, "id")).unwrap();
    assert_eq!(h.pi.status(s(&account, "id"))["connected"], false);
}

#[test]
fn cancelled_login_ends_the_worker_and_frees_the_slot() {
    let h = harness(vec![]);
    h.pi.begin(&json!({"provider":"groq","type":"api_key","consent":true})).unwrap();
    until("prompt", || !h.pi.snapshot()["pending"]["prompt"].is_null());
    h.pi.cancel(None);
    until("cancelled", || h.pi.snapshot()["pending"]["status"] == "cancelled");
    until("worker gone", || h.pi.active_jobs() == 0);
    h.pi.begin(&json!({"provider":"groq","type":"api_key","consent":true})).unwrap();
    h.pi.cancel(None);
    until("cancelled again", || h.pi.snapshot()["pending"]["status"] == "cancelled");
}

#[test]
fn stop_all_and_offline_cancel_an_in_flight_sdk_stream() {
    for offline in [false, true] {
        let h = harness(vec![Reply::Hang]);
        h.registry.save(&json!({"profiles":[profile(json!({}))],"routes":{"main":{"primary":"pi-groq"}}}), 0).unwrap();
        h.registry.set_key("pi-groq", "synthetic").unwrap();
        let (registry, network, pi, fake) = (h.registry.clone(), h.network.clone(), h.pi.clone(), h.fake.clone());
        h.runtime.spawn(async move {
            fake.entered.notified().await;
            if offline {
                network.update_policy(NetworkPolicy::from_value(&json!({"schema":1,"revision":1,"mode":"offline","internetTools":true})).unwrap());
                pi.network_changed();
            } else {
                registry.cancel_all();
            }
        });
        let error = invoke(&h, &RequestCancellation::new(), Arc::new(Mutex::new(String::new()))).err().expect("must stop");
        assert!(if offline { error.kind == "unavailable" && error.message.contains("通信モード") } else { error.cancelled }, "{offline} {} {}", error.kind, error.message);
        until("worker gone", || h.pi.active_jobs() == 0);
    }
}

#[test]
fn worker_egress_is_limited_to_the_profile_and_provider_auth_origins() {
    let h = harness(vec![]);
    let catalog = h.pi.catalog().unwrap();
    let data = json!({"provider":"groq","profile":profile(json!({}))});
    assert!(h.pi.scope("https://api.groq.com/openai/v1/chat/completions", &data, &catalog).unwrap().1);
    assert!(h.pi.scope("https://evil.example/v1", &data, &catalog).unwrap_err().blocked);
    let login = json!({"provider":"openai-codex"});
    assert!(!h.pi.scope("https://auth.openai.com/oauth/token", &login, &catalog).unwrap().1);
    assert!(h.pi.scope("http://auth.openai.com/oauth/token", &login, &catalog).is_err());
    h.network.update_policy(NetworkPolicy::from_value(&json!({"schema":1,"revision":1,"mode":"offline","internetTools":true})).unwrap());
    assert_eq!(h.pi.begin(&json!({"provider":"xai","consent":true})).unwrap_err().status, 403);
}
