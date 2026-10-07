//! Frozen-JS parity and native-only capability lifecycle tests. Every socket is
//! replaced at NativeNetwork's public Resolver/Transport seam; no model runs.
use super::*;
use crate::network::{
    Admitted, ByteStream, NetworkFuture, NetworkMode, NetworkPolicy, Resolver, Transport,
    TransportResponse,
};
use futures_util::{stream, Stream};
use std::{
    collections::VecDeque,
    pin::Pin,
    sync::atomic::{AtomicBool, Ordering},
    task::{Context, Poll},
};
use tokio::sync::mpsc;

#[derive(Default)]
struct Stored {
    registry: Option<Value>,
    events: Vec<Value>,
    fail_next: Option<u16>,
    commits: usize,
}
#[derive(Default)]
struct TestState(
    Mutex<Stored>,
    Mutex<Option<Arc<std::sync::Barrier>>>,
    Mutex<Option<Arc<CommitPause>>>,
);
struct CommitPause {
    entered: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    released: Mutex<bool>,
    wake: std::sync::Condvar,
}
impl CommitPause {
    fn wait(&self) {
        if let Some(sender) = lock(&self.entered).take() {
            let _ = sender.send(());
        }
        let mut released = lock(&self.released);
        while !*released {
            released = self.wake.wait(released).unwrap_or_else(|e| e.into_inner());
        }
    }
    fn release(&self) {
        *lock(&self.released) = true;
        self.wake.notify_all();
    }
}
struct ReleasePause(Arc<CommitPause>);
impl Drop for ReleasePause {
    fn drop(&mut self) {
        self.0.release();
    }
}

impl CapabilityState for TestState {
    fn value(&self, key: &str) -> Result<Option<Value>, ApiError> {
        assert_eq!(key, "capabilities");
        Ok(lock(&self.0).registry.clone())
    }
    fn commit_registry(
        &self,
        expected_revision: u64,
        next: Value,
        public_snapshot: Value,
    ) -> Result<(), ApiError> {
        let barrier = lock(&self.1).clone();
        if let Some(barrier) = barrier {
            // Only concurrent-CAS fixtures install this synchronization point.
            barrier.wait();
        }
        let mut state = lock(&self.0);
        state.commits += 1;
        if let Some(status) = state.fail_next.take() {
            return Err(ApiError::new(status, "Injected atomic registry failure"));
        }
        let current = state
            .registry
            .as_ref()
            .and_then(|v| v["revision"].as_u64())
            .unwrap_or(0);
        if current != expected_revision {
            return Err(ApiError::new(
                409,
                "Capability settings changed. Reload before saving.",
            ));
        }
        // This fixture models the required single transactional Workspace seam.
        // Neither persistent data nor events are touched until every check passes.
        state.registry = Some(next);
        state.events.push(public_snapshot);
        drop(state);
        if let Some(pause) = lock(&self.2).clone() {
            pause.wait();
        }
        Ok(())
    }
}
impl TestState {
    fn fail_next(&self, status: u16) {
        lock(&self.0).fail_next = Some(status);
    }
    fn persisted(&self) -> Option<Value> {
        lock(&self.0).registry.clone()
    }
    fn events(&self) -> Vec<Value> {
        lock(&self.0).events.clone()
    }
}

#[derive(Default)]
struct TestResolver(Mutex<Vec<String>>);
impl Resolver for TestResolver {
    fn lookup<'a>(&'a self, host: &'a str) -> NetworkFuture<'a, Vec<String>> {
        lock(&self.0).push(host.to_owned());
        Box::pin(async { Ok(vec!["8.8.8.8".into()]) })
    }
}
#[derive(Clone)]
struct Recorded {
    admitted: Admitted,
    request: NetworkRequest,
    cancellation: RequestCancellation,
}
#[derive(Default)]
struct TestTransport {
    requests: Mutex<Vec<Recorded>>,
    responses: Mutex<VecDeque<Result<TransportResponse, NetworkError>>>,
}
impl Transport for TestTransport {
    fn request<'a>(
        &'a self,
        admitted: Admitted,
        request: NetworkRequest,
        cancellation: RequestCancellation,
    ) -> NetworkFuture<'a, TransportResponse> {
        lock(&self.requests).push(Recorded {
            admitted,
            request,
            cancellation,
        });
        let response = lock(&self.responses)
            .pop_front()
            .expect("unexpected native transport dispatch");
        Box::pin(async move { response })
    }
}
impl TestTransport {
    fn push(&self, response: TransportResponse) {
        lock(&self.responses).push_back(Ok(response));
    }
    fn fail(&self, message: &str) {
        lock(&self.responses).push_back(Err(NetworkError::transport(message)));
    }
    fn count(&self) -> usize {
        lock(&self.requests).len()
    }
    fn records(&self) -> Vec<Recorded> {
        lock(&self.requests).clone()
    }
}
struct DropTrackedBody {
    stream: ByteStream,
    dropped: Arc<AtomicBool>,
}
impl Stream for DropTrackedBody {
    type Item = Result<Bytes, NetworkError>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.stream.as_mut().poll_next(cx)
    }
}
impl Drop for DropTrackedBody {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
    }
}
fn held_response(
    status: u16,
) -> (
    TransportResponse,
    mpsc::UnboundedSender<Result<Bytes, NetworkError>>,
    Arc<AtomicBool>,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    let dropped = Arc::new(AtomicBool::new(false));
    let stream = stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    });
    let body = DropTrackedBody {
        stream: Box::pin(stream),
        dropped: dropped.clone(),
    };
    (
        TransportResponse {
            status,
            headers: HeaderMap::new(),
            body: Some(Box::pin(body)),
        },
        tx,
        dropped,
    )
}
fn bytes_response(status: u16, bytes: impl Into<Bytes>) -> TransportResponse {
    let bytes = bytes.into();
    TransportResponse {
        status,
        headers: HeaderMap::new(),
        body: Some(Box::pin(stream::once(async move { Ok(bytes) }))),
    }
}
fn json_response(data: &Value) -> TransportResponse {
    let mut response = bytes_response(200, json_codec::stringify_js(data).unwrap());
    response.headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json"),
    );
    response
}
struct Harness {
    capabilities: Capabilities,
    state: Arc<TestState>,
    network: NativeNetwork,
    transport: Arc<TestTransport>,
    resolver: Arc<TestResolver>,
    gate: ResourceGate,
}
impl Harness {
    fn new() -> Self {
        Self::environment(Arc::new(|_| None))
    }
    fn environment(environment: Environment) -> Self {
        let state = Arc::new(TestState::default());
        let transport = Arc::new(TestTransport::default());
        let resolver = Arc::new(TestResolver::default());
        let network = NativeNetwork::with_components(
            NetworkPolicy::default(),
            resolver.clone(),
            transport.clone(),
        );
        let gate = ResourceGate::default();
        let capabilities =
            Capabilities::with_options(state.clone(), network.clone(), gate.clone(), environment);
        Self {
            capabilities,
            state,
            network,
            transport,
            resolver,
            gate,
        }
    }
    fn install(&self, raw: Value) -> Value {
        let checked = validate_capability(&raw).unwrap();
        let input = registry(raw);
        let revision = self.capabilities.get().unwrap()["revision"]
            .as_u64()
            .unwrap();
        self.capabilities.save(&input, revision).unwrap();
        self.capabilities.pin(s(&checked, "role")).unwrap()
    }
    fn clean(&self) {
        assert_eq!(self.capabilities.active_count(), 0);
        assert_eq!(self.network.active_count(), 0);
        assert!(self
            .capabilities
            .resources()
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["active"] == 0 && v["queued"] == 0));
    }
}
fn raw(protocol: &str) -> Value {
    json!({"id":"local","protocol":protocol,"baseUrl":"http://127.0.0.1:8123/v1","model":"model","domain":"device","resource":"shared"})
}
fn registry(raw: Value) -> Value {
    let profile = validate_capability(&raw).unwrap();
    let mut routes = Map::new();
    if profile["enabled"] == true {
        routes.insert(s(&profile, "role").to_owned(), profile["id"].clone());
    }
    json!({"profiles":[raw],"routes":routes})
}
fn fixtures() -> Value {
    // serde_json alone rejects lone UTF-16 surrogates. This is the real codec.
    json_codec::parse(include_str!("fixtures/validation.json")).unwrap()
}
fn assert_case(actual: Result<Value, CapabilityError>, fixture: &Value, context: &str) {
    if let Some(expected) = fixture.get("value") {
        let actual = actual.unwrap_or_else(|e| panic!("{context}: unexpected error {e:?}"));
        assert_eq!(
            json_codec::stringify_js(&actual).unwrap(),
            json_codec::stringify_js(expected).unwrap(),
            "{context}: exact JS wire value"
        );
    } else {
        let error = actual
            .err()
            .unwrap_or_else(|| panic!("{context}: expected error"));
        assert_eq!(
            json!(error.status),
            fixture["error"]["status"],
            "{context}: status"
        );
        assert_eq!(
            json!(error.message),
            fixture["error"]["message"],
            "{context}: message"
        );
    }
}
async fn eventually(mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !predicate() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("lifecycle condition did not become true");
}
fn spawn_request(
    capabilities: &Capabilities,
    profile: &Value,
    cancel: &RequestCancellation,
) -> tokio::task::JoinHandle<Result<BufferedResponse, CapabilityError>> {
    let capabilities = capabilities.clone();
    let profile = profile.clone();
    let cancel = cancel.clone();
    tokio::spawn(async move {
        capabilities
            .request(
                &profile,
                "/embeddings",
                CapabilityRequest {
                    json: Some(json!({"input":["a"]})),
                    ..Default::default()
                },
                &cancel,
            )
            .await
    })
}
async fn joined(
    task: tokio::task::JoinHandle<Result<BufferedResponse, CapabilityError>>,
) -> Result<BufferedResponse, CapabilityError> {
    tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .expect("request hung")
        .expect("request panicked")
}
fn is_resource(capabilities: &Capabilities, active: u64, queued: u64) -> bool {
    capabilities
        .resources()
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["resource"] == "cap:shared" && v["active"] == active && v["queued"] == queued)
}

#[test]
fn frozen_js_profile_values_errors_order_and_identity_hashes_match() {
    let fixture = fixtures();
    let cases = fixture["profiles"].as_array().unwrap();
    assert_eq!(cases.len(), 59);
    for (i, case) in cases.iter().enumerate() {
        let result = validate_capability(&case["input"]);
        if let Ok(profile) = &result {
            let mut unhashed = profile.clone();
            let identity = unhashed
                .as_object_mut()
                .unwrap()
                .shift_remove("identity")
                .unwrap();
            assert_eq!(
                identity,
                json!(format!(
                    "{:x}",
                    Sha256::digest(json_codec::stringify_js(&unhashed).unwrap().as_bytes())
                )),
                "profile {i}: identity hash"
            );
            assert!(profile.get("keyPresent").is_none());
        }
        assert_case(result, case, &format!("profile {i}"));
    }
}
#[test]
fn frozen_js_registry_save_values_errors_and_events_match() {
    let fixture = fixtures();
    let cases = fixture["registries"].as_array().unwrap();
    assert_eq!(cases.len(), 17);
    for (i, case) in cases.iter().enumerate() {
        let h = Harness::new();
        let result = h.capabilities.save(&case["input"], 0);
        if let Ok(public) = &result {
            assert_eq!(h.state.events(), vec![public.clone()]);
            for p in h.state.persisted().unwrap()["profiles"].as_array().unwrap() {
                assert!(
                    p.get("keyPresent").is_none(),
                    "key presence is not persisted"
                );
            }
        } else {
            assert!(h.state.persisted().is_none());
            assert!(h.state.events().is_empty());
        }
        assert_case(result, case, &format!("registry {i}"));
    }
}
#[test]
fn frozen_js_embedding_validation_matches_including_errors() {
    let fixture = fixtures();
    let cases = fixture["embeddingCases"].as_array().unwrap();
    assert_eq!(cases.len(), 16);
    for (i, case) in cases.iter().enumerate() {
        assert_case(
            validate_embeddings(&case["profile"], &case["inputs"], &case["data"]),
            case,
            &format!("embedding {i}"),
        );
    }
}
#[test]
fn default_registry_pin_snapshot_and_stale_revision_are_safe() {
    let h = Harness::new();
    assert_eq!(
        h.capabilities.get().unwrap(),
        json!({"schema":1,"revision":0,"profiles":[],"routes":{}})
    );
    assert_eq!(h.capabilities.pin("decision").err().unwrap().status, 409);
    let p = h.install(raw("openai-embeddings"));
    let mut detached = h.capabilities.pin("embedding").unwrap();
    detached["model"] = json!("mutated copy");
    assert_eq!(h.capabilities.pin("embedding").unwrap(), p);
    let before = h.state.persisted();
    let events = h.state.events();
    let commits = lock(&h.state.0).commits;
    let e = h
        .capabilities
        .save(&json!({"bad":"invalid but revision wins"}), 0)
        .err()
        .unwrap();
    assert_eq!(
        (e.status, e.message.as_str()),
        (409, "Capability settings changed. Reload before saving.")
    );
    assert_eq!(lock(&h.state.0).commits, commits);
    assert_eq!(h.state.persisted(), before);
    assert_eq!(h.state.events(), events);
}
#[test]
fn explicit_keys_are_memory_only_and_cas_identity_checked() {
    let h = Harness::new();
    let p = h.install(raw("openai-embeddings"));
    let persisted = h.state.persisted();
    let events = h.state.events();
    assert_eq!(
        h.capabilities
            .set_key("local", &json!("memory-only-secret"), &p["identity"])
            .unwrap(),
        json!({"id":"local","keyPresent":true})
    );
    assert!(h.capabilities.key_present(&p).unwrap());
    assert_eq!(
        h.capabilities.snapshot().unwrap()["profiles"][0]["keyPresent"],
        true
    );
    assert_eq!(h.state.persisted(), persisted);
    assert_eq!(h.state.events(), events);
    assert!(
        !json_codec::stringify_js(&h.capabilities.snapshot().unwrap())
            .unwrap()
            .contains("memory-only-secret")
    );
    assert_eq!(
        h.capabilities
            .set_key("local", &json!("replacement"), &json!("stale"))
            .err()
            .unwrap()
            .status,
        409
    );
    assert_eq!(
        h.capabilities
            .set_key("missing", &json!("replacement"), &p["identity"])
            .err()
            .unwrap()
            .status,
        409
    );
    for key in [
        json!(null),
        json!(2),
        json!("x".repeat(4001)),
        json!("🦊".repeat(2001)),
    ] {
        assert_eq!(
            h.capabilities
                .set_key("local", &key, &p["identity"])
                .err()
                .unwrap()
                .status,
            400
        );
    }
    let reloaded = Capabilities::with_options(
        h.state.clone(),
        h.network.clone(),
        ResourceGate::default(),
        Arc::new(|_| None),
    );
    assert!(!reloaded.key_present(&p).unwrap());
    h.capabilities
        .set_key("local", &json!(""), &p["identity"])
        .unwrap();
    assert!(!h.capabilities.key_present(&p).unwrap());
}
#[test]
fn keys_survive_name_model_resource_changes_but_not_endpoint_changes() {
    for field in [
        "name",
        "model",
        "resource",
        "baseUrl",
        "protocol",
        "pinnedAddress",
        "removed",
    ] {
        let h = Harness::new();
        let mut input = raw("openai-embeddings");
        if field == "pinnedAddress" {
            input["domain"] = json!("lan");
            input["baseUrl"] = json!("http://models.test:8123/v1");
            input["allowPlainHttp"] = json!(true);
            input["pinnedAddress"] = json!("192.168.1.2");
        }
        let old = h.install(input.clone());
        h.capabilities
            .set_key("local", &json!("secret"), &old["identity"])
            .unwrap();
        let next = if field == "removed" {
            json!({"profiles":[],"routes":{}})
        } else {
            input[field] = json!(match field {
                "baseUrl" => "http://127.0.0.1:8124/v1",
                "protocol" => "ollama-embed",
                "pinnedAddress" => "192.168.1.3",
                _ => "changed",
            });
            registry(input)
        };
        let saved = h.capabilities.save(&next, 1).unwrap();
        assert!(
            !h.capabilities.current(&old).unwrap(),
            "{field}: old identity must be revoked"
        );
        if field != "removed" {
            let p = h.capabilities.pin("embedding").unwrap();
            let retained = matches!(field, "name" | "model" | "resource");
            assert_eq!(h.capabilities.key_present(&p).unwrap(), retained, "{field}");
            assert_eq!(saved["profiles"][0]["keyPresent"], retained, "{field}");
        } else {
            let p = h.install(raw("openai-embeddings"));
            assert!(!h.capabilities.key_present(&p).unwrap());
        }
    }
}
#[tokio::test]
async fn environment_fallback_and_explicit_override_never_persist_keys() {
    let looked_up = Arc::new(Mutex::new(Vec::<String>::new()));
    let calls = looked_up.clone();
    let h = Harness::environment(Arc::new(move |name| {
        lock(&calls).push(name.into());
        (name == "TEPORA_CAP_TEST").then(|| "environment-secret".into())
    }));
    let mut input = raw("openai-embeddings");
    input["apiKeyEnv"] = json!("TEPORA_CAP_TEST");
    let p = h.install(input);
    for key in [None, Some("explicit-secret"), Some("")] {
        if let Some(key) = key {
            h.capabilities
                .set_key("local", &json!(key), &p["identity"])
                .unwrap();
        }
        h.transport.push(json_response(&json!({"ok":true})));
        h.capabilities
            .request(
                &p,
                "/embeddings",
                CapabilityRequest::default(),
                &RequestCancellation::new(),
            )
            .await
            .unwrap();
    }
    let requests = h.transport.records();
    assert_eq!(
        requests[0].request.headers[header::AUTHORIZATION],
        "Bearer environment-secret"
    );
    assert_eq!(
        requests[1].request.headers[header::AUTHORIZATION],
        "Bearer explicit-secret"
    );
    assert_eq!(
        requests[2].request.headers[header::AUTHORIZATION],
        "Bearer environment-secret"
    );
    assert!(lock(&looked_up).iter().all(|s| s == "TEPORA_CAP_TEST"));
    let persisted = json_codec::stringify_js(&h.state.persisted().unwrap()).unwrap();
    assert!(!persisted.contains("environment-secret") && !persisted.contains("explicit-secret"));
    assert!(h
        .state
        .events()
        .iter()
        .all(|event| !json_codec::stringify_js(event).unwrap().contains("-secret")));
    h.clean();
}
#[tokio::test]
async fn failed_atomic_commit_keeps_registry_and_events_but_revokes_sensitive_memory_first() {
    for status in [409, 503] {
        let h = Harness::new();
        let p = h.install(raw("openai-embeddings"));
        h.capabilities
            .set_key("local", &json!("kept-secret"), &p["identity"])
            .unwrap();
        let (response, _tx, dropped) = held_response(200);
        h.transport.push(response);
        let task = spawn_request(&h.capabilities, &p, &RequestCancellation::new());
        eventually(|| h.transport.count() == 1).await;
        let before = h.state.persisted();
        let events = h.state.events();
        let mut changed = raw("openai-embeddings");
        changed["baseUrl"] = json!("http://127.0.0.1:9999/v1");
        h.state.fail_next(status);
        assert_eq!(
            h.capabilities
                .save(&registry(changed), 1)
                .err()
                .unwrap()
                .status,
            status
        );
        assert_eq!(h.state.persisted(), before);
        assert_eq!(h.state.events(), events);
        assert!(h.capabilities.current(&p).unwrap());
        // Source order invalidates credentials and operations before persistence.
        // A failed transaction leaves durable registry/events unchanged, while
        // sensitive memory must never be resurrected after that invalidation.
        assert!(!h.capabilities.key_present(&p).unwrap());
        let error = joined(task).await.err().unwrap();
        assert_eq!(
            (error.status, error.message.as_str()),
            (403, "Capability endpoint changed")
        );
        assert!(error.blocked);
        assert!(h.transport.records()[0].cancellation.is_cancelled());
        assert!(dropped.load(Ordering::SeqCst));
        h.clean();
    }
}
#[tokio::test]
async fn native_request_exact_js_json_headers_methods_and_scoped_destination() {
    let h = Harness::new();
    let p = h.install(raw("openai-embeddings"));
    h.capabilities
        .set_key("local", &json!("secret"), &p["identity"])
        .unwrap();
    let payload = json_codec::parse(r#"{"z":-0,"10":"ten","2":"two","surrogate":"\ud800","marker":"\ue000","large":1e21,"tiny":1e-7}"#).unwrap();
    h.transport.push(json_response(&json!({"ok":true})));
    let r = h
        .capabilities
        .request(
            &p,
            "/Test_2/sub-route",
            CapabilityRequest {
                method: Method::PUT,
                json: Some(payload.clone()),
                body: CapabilityBody::Text("ignored".into()),
                max_bytes: 1000,
                egress_guard: None,
            },
            &RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(r.status, 200);
    assert_eq!(r.json().unwrap(), json!({"ok":true}));
    assert_eq!(r.headers[header::CONTENT_TYPE], "application/json");
    let record = &h.transport.records()[0];
    assert_eq!(
        record.admitted.url.as_str(),
        "http://127.0.0.1:8123/v1/Test_2/sub-route"
    );
    assert_eq!(record.admitted.profile_id.as_deref(), Some("cap:local"));
    assert_eq!(record.admitted.address.to_string(), "127.0.0.1");
    assert_eq!(record.admitted.domain, Domain::Device);
    assert_eq!(record.admitted.purpose, Purpose::Model);
    assert_eq!(record.request.method, Method::PUT);
    assert_eq!(record.request.headers.len(), 2);
    assert_eq!(
        record.request.headers[header::AUTHORIZATION],
        "Bearer secret"
    );
    assert_eq!(
        record.request.headers[header::CONTENT_TYPE],
        "application/json"
    );
    assert_eq!(
        record.request.body.as_ref(),
        json_codec::stringify_js(&payload).unwrap().as_bytes()
    );
    assert!(
        record.cancellation.is_cancelled(),
        "fully consumed response releases native operation"
    );
    assert!(
        lock(&h.resolver.0).is_empty(),
        "literal loopback must not need DNS"
    );
    h.clean();
}
#[tokio::test]
async fn bodies_preserve_bytes_replace_lone_surrogates_and_encode_media_content_type() {
    let h = Harness::new();
    let p = h.install(raw("openai-image-edit"));
    let encoded = json_codec::parse(r#""a\ud800b""#)
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    let bodies = [
        CapabilityBody::Empty,
        CapabilityBody::Bytes(Bytes::from_static(&[0, 255, 1])),
        CapabilityBody::Text(encoded),
        CapabilityBody::EncodedMedia {
            bytes: Bytes::from_static(b"multipart payload"),
            content_type: "multipart/form-data; boundary=test".into(),
        },
    ];
    for body in bodies {
        h.transport.push(bytes_response(201, "done"));
        h.capabilities
            .request(
                &p,
                "/images/edits",
                CapabilityRequest {
                    body,
                    ..Default::default()
                },
                &RequestCancellation::new(),
            )
            .await
            .unwrap();
    }
    let records = h.transport.records();
    assert_eq!(records[0].request.body, Bytes::new());
    assert_eq!(records[1].request.body.as_ref(), &[0, 255, 1]);
    assert_eq!(records[2].request.body.as_ref(), "a\u{fffd}b".as_bytes());
    assert_eq!(records[3].request.body, "multipart payload");
    assert_eq!(
        records[3].request.headers[header::CONTENT_TYPE],
        "multipart/form-data; boundary=test"
    );
    for record in &records[..3] {
        assert!(record.request.headers.is_empty());
    }
    h.clean();
}
#[test]
fn buffered_json_matches_fetch_bom_replacement_and_invalid_json_error() {
    let response = BufferedResponse {
        status: 200,
        headers: HeaderMap::new(),
        bytes: Bytes::from_static(b"\xef\xbb\xbf{\"text\":\"\xff\"}"),
    };
    assert_eq!(response.json().unwrap(), json!({"text":"\u{fffd}"}));
    for bytes in [b"".as_slice(), b"{", b"NaN"] {
        let response = BufferedResponse {
            status: 200,
            headers: HeaderMap::new(),
            bytes: Bytes::copy_from_slice(bytes),
        };
        let error = response.json().err().unwrap();
        assert_eq!(
            (error.status, error.message.as_str()),
            (502, "Invalid capability JSON")
        );
    }
}
#[tokio::test]
async fn invalid_routes_keys_media_and_pre_cancel_fail_without_dispatch() {
    let h = Harness::new();
    let p = h.install(raw("openai-images"));
    for route in [
        "",
        "/",
        "embeddings",
        "/../admin",
        "/foo?token=x",
        "/foo#bar",
        "/%2e%2e/admin",
        "https://evil.example/path",
        "/日本語",
        "/images\n",
        "/images\r",
        "/images\r\n",
        "/images\u{2028}",
        "/images\u{2029}",
    ] {
        let error = h
            .capabilities
            .request(
                &p,
                route,
                CapabilityRequest::default(),
                &RequestCancellation::new(),
            )
            .await
            .err()
            .unwrap();
        assert_eq!(
            (error.status, error.message.as_str()),
            (400, "Invalid modality route"),
            "{route}"
        );
    }
    let cancel = RequestCancellation::new();
    cancel.cancel();
    let error = h
        .capabilities
        .request(&p, "/images", CapabilityRequest::default(), &cancel)
        .await
        .err()
        .unwrap();
    assert_eq!(error.status, 499);
    assert!(error.cancelled);
    h.capabilities
        .set_key("local", &json!("key\r\nx-private: leaked"), &p["identity"])
        .unwrap();
    assert_eq!(
        h.capabilities
            .request(
                &p,
                "/images",
                CapabilityRequest::default(),
                &RequestCancellation::new()
            )
            .await
            .err()
            .unwrap()
            .message,
        "Invalid authorization header"
    );
    h.capabilities
        .set_key("local", &json!(""), &p["identity"])
        .unwrap();
    for (body, status) in [
        (
            CapabilityBody::EncodedMedia {
                bytes: Bytes::from(vec![0; 16 * 1024 * 1024 + 1]),
                content_type: "image/png".into(),
            },
            403,
        ),
        (
            CapabilityBody::EncodedMedia {
                bytes: Bytes::new(),
                content_type: "image/png\r\nx-private: leaked".into(),
            },
            400,
        ),
    ] {
        assert_eq!(
            h.capabilities
                .request(
                    &p,
                    "/images",
                    CapabilityRequest {
                        body,
                        ..Default::default()
                    },
                    &RequestCancellation::new()
                )
                .await
                .err()
                .unwrap()
                .status,
            status
        );
    }
    assert_eq!(h.transport.count(), 0);
    h.clean();
}
#[tokio::test]
async fn upstream_status_cancels_body_and_preserves_rejection_metadata() {
    for status in [400, 401, 403, 429, 500, 503] {
        let h = Harness::new();
        let p = h.install(raw("openai-embeddings"));
        let (response, _tx, dropped) = held_response(status);
        h.transport.push(response);
        let error = h
            .capabilities
            .request(
                &p,
                "/embeddings",
                CapabilityRequest::default(),
                &RequestCancellation::new(),
            )
            .await
            .err()
            .unwrap();
        assert_eq!(error.status, 502);
        assert_eq!(error.upstream_status, Some(status));
        assert_eq!(error.known_rejected, Some(status < 500));
        assert_eq!(error.message, format!("能力接続 HTTP {status}"));
        assert_eq!(error.value()["knownRejected"], status < 500);
        assert!(dropped.load(Ordering::SeqCst));
        assert!(h.transport.records()[0].cancellation.is_cancelled());
        h.clean();
    }
}
#[tokio::test]
async fn gate_and_native_operation_are_held_through_complete_response_body() {
    let h = Harness::new();
    let p = h.install(raw("openai-embeddings"));
    let (response, tx, dropped) = held_response(200);
    h.transport.push(response);
    h.transport.push(bytes_response(200, "second"));
    let first = spawn_request(&h.capabilities, &p, &RequestCancellation::new());
    eventually(|| h.transport.count() == 1).await;
    let second = spawn_request(&h.capabilities, &p, &RequestCancellation::new());
    eventually(|| is_resource(&h.capabilities, 1, 1)).await;
    assert_eq!(h.network.active_count(), 1);
    assert_eq!(h.capabilities.active_count(), 2);
    assert_eq!(
        h.transport.count(),
        1,
        "headers must not release resource lease"
    );
    tx.send(Ok(Bytes::from_static(b"first-"))).unwrap();
    tokio::task::yield_now().await;
    assert_eq!(
        h.transport.count(),
        1,
        "a partial body must not release resource lease"
    );
    assert!(!first.is_finished());
    tx.send(Ok(Bytes::from_static(b"complete"))).unwrap();
    drop(tx);
    assert_eq!(joined(first).await.unwrap().bytes, "first-complete");
    assert_eq!(joined(second).await.unwrap().bytes, "second");
    assert!(dropped.load(Ordering::SeqCst));
    assert_eq!(h.transport.count(), 2);
    h.clean();
}
#[tokio::test]
async fn registry_revocation_cancels_active_and_queued_without_stale_dispatch() {
    for change in ["name", "disabled", "removed"] {
        let h = Harness::new();
        let p = h.install(raw("openai-embeddings"));
        let (response, _tx, dropped) = held_response(200);
        h.transport.push(response);
        let first = spawn_request(&h.capabilities, &p, &RequestCancellation::new());
        eventually(|| h.transport.count() == 1).await;
        let queued = spawn_request(&h.capabilities, &p, &RequestCancellation::new());
        eventually(|| is_resource(&h.capabilities, 1, 1)).await;
        let input = if change == "removed" {
            json!({"profiles":[],"routes":{}})
        } else {
            let mut p = raw("openai-embeddings");
            if change == "disabled" {
                p["enabled"] = json!(false);
            } else {
                p["name"] = json!("renamed");
            }
            registry(p)
        };
        h.capabilities.save(&input, 1).unwrap();
        for task in [first, queued] {
            let error = joined(task).await.err().unwrap();
            assert_eq!(
                (error.status, error.message.as_str()),
                (403, "Capability endpoint changed"),
                "{change}"
            );
            assert!(error.blocked);
        }
        assert_eq!(
            h.transport.count(),
            1,
            "{change}: stale queued request dispatched"
        );
        assert!(dropped.load(Ordering::SeqCst));
        assert!(h.transport.records()[0].cancellation.is_cancelled());
        assert_eq!(
            h.capabilities
                .request(
                    &p,
                    "/embeddings",
                    CapabilityRequest::default(),
                    &RequestCancellation::new()
                )
                .await
                .err()
                .unwrap()
                .status,
            409
        );
        h.clean();
    }
}
#[tokio::test]
async fn identical_registry_save_keeps_active_inference_alive() {
    let h = Harness::new();
    let input = raw("openai-embeddings");
    let p = h.install(input.clone());
    let (response, tx, _) = held_response(200);
    h.transport.push(response);
    let task = spawn_request(&h.capabilities, &p, &RequestCancellation::new());
    eventually(|| h.transport.count() == 1).await;
    h.capabilities.save(&registry(input), 1).unwrap();
    assert!(h.capabilities.current(&p).unwrap());
    assert!(!h.transport.records()[0].cancellation.is_cancelled());
    tx.send(Ok(Bytes::from_static(b"alive"))).unwrap();
    drop(tx);
    assert_eq!(joined(task).await.unwrap().bytes, "alive");
    h.clean();
}
#[tokio::test]
async fn caller_cancellation_removes_queued_waiter_and_aborts_active_body() {
    let h = Harness::new();
    let p = h.install(raw("openai-embeddings"));
    let (response, _tx, dropped) = held_response(200);
    h.transport.push(response);
    let active_cancel = RequestCancellation::new();
    let active = spawn_request(&h.capabilities, &p, &active_cancel);
    eventually(|| h.transport.count() == 1).await;
    let queued_cancel = RequestCancellation::new();
    let queued = spawn_request(&h.capabilities, &p, &queued_cancel);
    eventually(|| is_resource(&h.capabilities, 1, 1)).await;
    queued_cancel.cancel();
    let error = joined(queued).await.err().unwrap();
    assert_eq!(error.status, 499);
    assert!(error.cancelled);
    assert_eq!(h.transport.count(), 1);
    assert!(is_resource(&h.capabilities, 1, 0));
    assert!(!h.transport.records()[0].cancellation.is_cancelled());
    active_cancel.cancel();
    let error = joined(active).await.err().unwrap();
    assert_eq!(error.status, 499);
    assert!(error.cancelled);
    assert!(dropped.load(Ordering::SeqCst));
    h.clean();
}
#[tokio::test]
async fn close_cancels_active_and_queued_and_erases_explicit_key() {
    let h = Harness::new();
    let p = h.install(raw("openai-embeddings"));
    h.capabilities
        .set_key("local", &json!("secret"), &p["identity"])
        .unwrap();
    let (response, _tx, dropped) = held_response(200);
    h.transport.push(response);
    let first = spawn_request(&h.capabilities, &p, &RequestCancellation::new());
    eventually(|| h.transport.count() == 1).await;
    let second = spawn_request(&h.capabilities, &p, &RequestCancellation::new());
    eventually(|| is_resource(&h.capabilities, 1, 1)).await;
    h.capabilities.close();
    h.capabilities.close();
    for task in [first, second] {
        let error = joined(task).await.err().unwrap();
        assert_eq!(
            (error.status, error.message.as_str()),
            (403, "Service closed")
        );
        assert!(error.blocked);
    }
    assert!(!h.capabilities.current(&p).unwrap());
    assert!(!h.capabilities.key_present(&p).unwrap());
    assert_eq!(
        h.capabilities.snapshot().unwrap()["profiles"][0]["keyPresent"],
        false
    );
    assert!(dropped.load(Ordering::SeqCst));
    assert_eq!(h.transport.count(), 1);
    h.clean();
}
#[tokio::test]
async fn dropping_request_future_releases_gate_network_and_body() {
    let h = Harness::new();
    let p = h.install(raw("openai-embeddings"));
    let (response, _tx, dropped) = held_response(200);
    h.transport.push(response);
    let task = spawn_request(&h.capabilities, &p, &RequestCancellation::new());
    eventually(|| h.transport.count() == 1).await;
    task.abort();
    assert!(task.await.err().unwrap().is_cancelled());
    assert!(dropped.load(Ordering::SeqCst));
    assert!(h.transport.records()[0].cancellation.is_cancelled());
    h.clean();
}
#[tokio::test]
async fn body_budget_body_errors_transport_errors_and_redirects_release_everything() {
    for kind in ["budget", "body", "transport", "redirect", "no-body"] {
        let h = Harness::new();
        let p = h.install(raw("openai-embeddings"));
        match kind {
            "budget" => h.transport.push(bytes_response(200, "12345")),
            "body" => h.transport.push(TransportResponse {
                status: 200,
                headers: HeaderMap::new(),
                body: Some(Box::pin(stream::once(async {
                    Err(NetworkError::transport("body failed"))
                }))),
            }),
            "transport" => h.transport.fail("fixture transport failed"),
            "redirect" => {
                let mut r = bytes_response(302, "redirect");
                r.headers.insert(
                    header::LOCATION,
                    header::HeaderValue::from_static("https://evil.example/"),
                );
                h.transport.push(r);
            }
            "no-body" => h.transport.push(TransportResponse {
                status: 204,
                headers: HeaderMap::new(),
                body: None,
            }),
            _ => unreachable!(),
        }
        let result = h
            .capabilities
            .request(
                &p,
                "/embeddings",
                CapabilityRequest {
                    max_bytes: 4,
                    ..Default::default()
                },
                &RequestCancellation::new(),
            )
            .await;
        if kind == "no-body" {
            assert!(result.unwrap().bytes.is_empty());
        } else {
            let error = result.err().unwrap();
            assert_eq!(
                error.status,
                if kind == "redirect" { 403 } else { 502 },
                "{kind}"
            );
            assert_eq!(error.upstream_status, None);
        }
        assert_eq!(h.transport.count(), 1);
        h.clean();
    }
}
#[tokio::test]
async fn capability_resource_prefix_does_not_occupy_chat_group() {
    let h = Harness::new();
    let p = h.install(raw("openai-embeddings"));
    let chat = h
        .gate
        .acquire("shared", 1, 0., 0, &RequestCancellation::new())
        .await
        .unwrap();
    h.transport.push(bytes_response(200, "ok"));
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        h.capabilities.request(
            &p,
            "/embeddings",
            CapabilityRequest::default(),
            &RequestCancellation::new(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result.bytes, "ok");
    drop(chat);
    h.clean();
}
#[tokio::test]
async fn downloads_enforce_exact_origin_and_never_forward_credentials_or_private_headers() {
    let h = Harness::new();
    let mut input = raw("openai-images");
    input["assetOrigins"] = json!(["https://files.example.org"]);
    let p = h.install(input);
    h.capabilities
        .set_key("local", &json!("must-not-leak"), &p["identity"])
        .unwrap();
    for url in [
        "http://127.0.0.1:8123/generated/image.png?token=signed",
        "https://files.example.org/generated/image.png?token=signed",
    ] {
        let mut response = bytes_response(200, Bytes::from_static(&[1, 2, 255]));
        response.headers.insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("image/png"),
        );
        h.transport.push(response);
        let download = h
            .capabilities
            .download(&p, url, &RequestCancellation::new())
            .await
            .unwrap();
        assert_eq!(download.bytes.as_ref(), &[1, 2, 255]);
        assert_eq!(download.content_type.as_deref(), Some("image/png"));
    }
    let records = h.transport.records();
    for record in &records {
        assert_eq!(record.request.method, Method::GET);
        assert!(
            record.request.headers.is_empty(),
            "no Authorization or private header on any asset origin"
        );
        assert!(record.request.body.is_empty());
        assert_eq!(record.admitted.profile_id.as_deref(), Some("cap:local"));
        assert_eq!(record.admitted.purpose, Purpose::Model);
        assert_eq!(record.admitted.url.query(), Some("token=signed"));
    }
    assert_eq!(records[0].admitted.domain, Domain::Device);
    assert_eq!(records[1].admitted.domain, Domain::Cloud);
    assert_eq!(records[1].admitted.address.to_string(), "8.8.8.8");
    assert_eq!(*lock(&h.resolver.0), vec!["files.example.org"]);
    for url in [
        "https://files.example.org.evil.test/image.png",
        "https://files.example.org:444/image.png",
        "http://files.example.org/image.png",
        "http://127.0.0.1:8124/image.png",
        "https://evil.example/image.png",
    ] {
        let error = h
            .capabilities
            .download(&p, url, &RequestCancellation::new())
            .await
            .err()
            .unwrap();
        assert_eq!(error.status, 403, "{url}");
    }
    assert_eq!(h.transport.count(), 2);
    h.clean();
}
#[tokio::test]
async fn active_asset_download_is_revoked_and_cloud_policy_is_enforced() {
    let h = Harness::new();
    let mut input = raw("openai-images");
    input["assetOrigins"] = json!(["https://files.example.org"]);
    let p = h.install(input);
    let (response, _tx, dropped) = held_response(200);
    h.transport.push(response);
    let c = h.capabilities.clone();
    let profile = p.clone();
    let task = tokio::spawn(async move {
        c.download(
            &profile,
            "https://files.example.org/image.png",
            &RequestCancellation::new(),
        )
        .await
    });
    eventually(|| h.transport.count() == 1).await;
    h.capabilities
        .save(&json!({"profiles":[],"routes":{}}), 1)
        .unwrap();
    let error = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .err()
        .unwrap();
    assert_eq!(error.status, 403);
    assert!(error.blocked);
    assert_eq!(error.message, "Capability endpoint changed");
    assert!(dropped.load(Ordering::SeqCst));
    h.clean();

    let mut input = raw("openai-images");
    input["assetOrigins"] = json!(["https://files.example.org"]);
    let p = h.install(input);
    h.network.update_policy(NetworkPolicy {
        mode: NetworkMode::Offline,
        revision: 1,
        internet_tools: false,
    });
    let error = h
        .capabilities
        .download(
            &p,
            "https://files.example.org/image.png",
            &RequestCancellation::new(),
        )
        .await
        .err()
        .unwrap();
    assert_eq!(error.status, 403);
    assert!(error.blocked);
    assert_eq!(h.transport.count(), 1);
    h.clean();
}
#[tokio::test]
async fn asset_status_failure_drops_body_and_omitted_content_type_stays_none() {
    let h = Harness::new();
    let p = h.install(raw("openai-images"));
    let (response, _tx, dropped) = held_response(404);
    h.transport.push(response);
    let error = h
        .capabilities
        .download(
            &p,
            "http://127.0.0.1:8123/file",
            &RequestCancellation::new(),
        )
        .await
        .err()
        .unwrap();
    assert_eq!(
        (error.status, error.message.as_str()),
        (502, "Generated media download failed")
    );
    assert!(dropped.load(Ordering::SeqCst));
    h.transport.push(bytes_response(200, "asset"));
    assert_eq!(
        h.capabilities
            .download(
                &p,
                "http://127.0.0.1:8123/file",
                &RequestCancellation::new()
            )
            .await
            .unwrap()
            .content_type,
        None
    );
    h.clean();
}
#[tokio::test]
async fn embedding_adapters_send_correct_payload_and_reorder_native_response() {
    for protocol in ["openai-embeddings", "ollama-embed"] {
        let h = Harness::new();
        let mut input = raw(protocol);
        input["dimensions"] = json!(2);
        let p = h.install(input);
        h.transport.push(json_response(&json!({"data":[{"index":1,"embedding":[3,4]},{"index":0,"embedding":[1,2]}],"embeddings":[[1,2],[3,4]]})));
        let inputs = json!(["hello", "world"]);
        let result = h
            .capabilities
            .embed(&inputs, None, &RequestCancellation::new())
            .await
            .unwrap();
        assert_eq!(
            result,
            json!({"vectors":[[1,2],[3,4]],"dimensions":2,"model":"model","identity":p["identity"]})
        );
        let records = h.transport.records();
        let record = &records[0];
        let expected = if protocol == "openai-embeddings" {
            json!({"model":"model","input":inputs,"encoding_format":"float","dimensions":2})
        } else {
            json!({"model":"model","input":inputs})
        };
        assert_eq!(
            record.request.body.as_ref(),
            json_codec::stringify_js(&expected).unwrap().as_bytes()
        );
        assert_eq!(
            record.admitted.url.path(),
            if protocol == "openai-embeddings" {
                "/v1/embeddings"
            } else {
                "/v1/embed"
            }
        );
        h.clean();
    }
}
#[tokio::test]
async fn embedding_input_utf16_budget_and_wrong_role_fail_before_dispatch() {
    let h = Harness::new();
    let p = h.install(raw("openai-embeddings"));
    for input in [
        json!([]),
        json!([""]),
        json!([42]),
        json!("text"),
        json!(["x".repeat(12001)]),
        json!(["🦊".repeat(6001)]),
        json!(vec!["x"; 33]),
    ] {
        let error = h
            .capabilities
            .embed(&input, Some(&p), &RequestCancellation::new())
            .await
            .err()
            .unwrap();
        assert_eq!(
            (error.status, error.message.as_str()),
            (400, "Embedding input budget exceeded")
        );
    }
    let wrong = h.install(raw("openai-speech"));
    assert_eq!(
        h.capabilities
            .embed(&json!(["x"]), Some(&wrong), &RequestCancellation::new())
            .await
            .err()
            .unwrap()
            .message,
        "Not an embedding endpoint"
    );
    assert_eq!(h.transport.count(), 0);
    h.clean();
}
#[tokio::test]
async fn system_one_adapter_uses_native_route_and_genuine_typed_answer_validation() {
    let h = Harness::new();
    let p = h.install(raw("system-one"));
    let state = json!({"request":"classify","evidence":["quoted data"]});
    let questions = json!({
        "intent":{"type":"choice","instructions":"choose","criteria":{"research":"Research","chat":"Chat"}},
        "safe":{"type":"noul","instructions":"score"},
        "level":{"type":"score","criteria":["low","medium","high"]}
    });
    let answer = json!({"model":"served-model","answers":{
        "intent":{"type":"choice","choice":"research","probabilities":{"research":0.75,"chat":0.25},"confidence":0.9},
        "safe":{"type":"noul","noul":0.8},
        "level":{"type":"score","score":1.5},
        "unrequested":{"type":"noul","noul":1}
    }});
    h.transport.push(json_response(&answer));
    let result = h
        .capabilities
        .decide(&state, &questions, None, &RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(result["model"], "served-model");
    assert_eq!(result["advisory"], true);
    assert_eq!(result["calibration"], "not-validated-for-Tepora");
    assert_eq!(result["answers"].as_object().unwrap().len(), 3);
    assert!(result["answers"].get("unrequested").is_none());
    let record = &h.transport.records()[0];
    assert_eq!(record.admitted.url.path(), "/v1/systemone");
    assert_eq!(record.request.method, Method::POST);
    assert_eq!(
        record.request.body.as_ref(),
        decision_payload("model", &state, &questions)
            .unwrap()
            .as_bytes()
    );
    assert!(!String::from_utf8_lossy(&record.request.body).contains("messages"));

    let mut invalids = Vec::new();
    invalids.push(json!({"choices":[{"message":{"content":"yes"}}]}));
    let mut v = answer.clone();
    v["answers"]["intent"]["choice"] = json!("outsider");
    invalids.push(v);
    let mut v = answer.clone();
    v["answers"]["intent"]["probabilities"] = json!({"research":0.1,"chat":0.1});
    invalids.push(v);
    let mut v = answer.clone();
    v["answers"]["safe"]["noul"] = json!("0.8");
    invalids.push(v);
    let mut v = answer.clone();
    v["answers"]["level"]["score"] = json!(3);
    invalids.push(v);
    let mut v = answer.clone();
    v["answers"]["safe"]["type"] = json!("score");
    invalids.push(v);
    let mut v = answer.clone();
    v["answers"]["safe"]["confidence"] = json!(1.1);
    invalids.push(v);
    for body in invalids {
        let expected = validate_answers("model", &questions, &body).err().unwrap();
        h.transport.push(json_response(&body));
        let error = h
            .capabilities
            .decide(&state, &questions, Some(&p), &RequestCancellation::new())
            .await
            .err()
            .unwrap();
        assert_eq!(error.status, 502);
        assert_eq!(error.message, expected.message);
    }
    let count = h.transport.count();
    assert_eq!(
        h.capabilities
            .decide(&state, &json!({}), Some(&p), &RequestCancellation::new())
            .await
            .err()
            .unwrap()
            .status,
        400
    );
    let wrong = h.install(raw("openai-embeddings"));
    assert_eq!(
        h.capabilities
            .decide(
                &state,
                &questions,
                Some(&wrong),
                &RequestCancellation::new()
            )
            .await
            .err()
            .unwrap()
            .message,
        "Not a decision endpoint"
    );
    assert_eq!(h.transport.count(), count);
    h.clean();
}

#[test]
fn atomic_state_cas_serializes_independent_registry_owners() {
    let h = Harness::new();
    h.install(raw("openai-embeddings"));
    let other = Capabilities::with_options(
        h.state.clone(),
        h.network.clone(),
        ResourceGate::default(),
        Arc::new(|_| None),
    );
    *lock(&h.state.1) = Some(Arc::new(std::sync::Barrier::new(2)));
    let first = h.capabilities.clone();
    let a = std::thread::spawn(move || {
        let mut input = raw("openai-embeddings");
        input["name"] = json!("owner-a");
        first.save(&registry(input), 1)
    });
    let b = std::thread::spawn(move || {
        let mut input = raw("openai-embeddings");
        input["name"] = json!("owner-b");
        other.save(&registry(input), 1)
    });
    let results = [a.join().unwrap(), b.join().unwrap()];
    *lock(&h.state.1) = None;
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter_map(|r| r.as_ref().err())
            .next()
            .unwrap()
            .status,
        409
    );
    let committed = results.into_iter().find_map(Result::ok).unwrap();
    assert_eq!(h.state.persisted().unwrap()["revision"], 2);
    assert_eq!(h.capabilities.snapshot().unwrap(), committed);
    assert_eq!(
        h.state.events().len(),
        2,
        "exactly one event for the winning CAS"
    );
    assert_eq!(h.state.events()[1], committed);
}

#[tokio::test]
async fn response_total_timeout_cancels_body_and_releases_native_tracking() {
    let h = Harness::new();
    let mut input = raw("openai-embeddings");
    input["timeoutMs"] = json!(1000);
    let p = h.install(input);
    let (response, _tx, dropped) = held_response(200);
    h.transport.push(response);
    let task = spawn_request(&h.capabilities, &p, &RequestCancellation::new());
    let error = joined(task).await.err().unwrap();
    assert_eq!(error.status, 504);
    assert_eq!(error.message, "Request total deadline exceeded");
    assert!(dropped.load(Ordering::SeqCst));
    assert!(h.transport.records()[0].cancellation.is_cancelled());
    h.clean();
}

#[tokio::test]
async fn revoking_native_network_policy_aborts_active_cloud_capability_body() {
    let h = Harness::new();
    let mut input = raw("openai-embeddings");
    input["baseUrl"] = json!("https://api.example.org/v1");
    input["domain"] = json!("cloud");
    let p = h.install(input);
    let (response, _tx, dropped) = held_response(200);
    h.transport.push(response);
    let task = spawn_request(&h.capabilities, &p, &RequestCancellation::new());
    eventually(|| h.transport.count() == 1).await;
    assert_eq!(
        h.transport.records()[0].admitted.address.to_string(),
        "8.8.8.8"
    );
    h.network.update_policy(NetworkPolicy {
        mode: NetworkMode::Offline,
        revision: 1,
        internet_tools: false,
    });
    let error = joined(task).await.err().unwrap();
    assert_eq!(error.status, 403);
    assert!(error.blocked);
    assert!(dropped.load(Ordering::SeqCst));
    h.clean();
}

#[tokio::test]
async fn null_input_normalizes_like_source_but_malformed_saved_concurrency_cannot_dispatch() {
    let h = Harness::new();
    let mut input = raw("openai-embeddings");
    input["maxParallel"] = Value::Null;
    let expected = validate_capability(&input).unwrap();
    let p = h.install(input.clone());
    assert_eq!(
        p["maxParallel"], 1,
        "source ?? default normalizes submitted null"
    );
    assert_eq!(p["identity"], expected["identity"]);
    // Simulate malformed legacy/direct saved state, not a valid configuration
    // accepted by the public validator. No model-supplied profile is authority.
    {
        let mut stored = lock(&h.state.0);
        stored.registry.as_mut().unwrap()["profiles"][0]["maxParallel"] = Value::Null;
    }
    let malformed = h.capabilities.pin("embedding").unwrap();
    let error = h
        .capabilities
        .request(
            &malformed,
            "/embeddings",
            CapabilityRequest::default(),
            &RequestCancellation::new(),
        )
        .await
        .err()
        .unwrap();
    assert_eq!(error.status, 409);
    assert!(error
        .message
        .contains("maxParallel must be a positive integer"));
    assert_eq!(h.transport.count(), 0);
    assert_eq!(h.capabilities.active_count(), 0);
    assert_eq!(h.capabilities.resources(), json!([]));
    let current = h.install(input);
    assert_eq!(current["maxParallel"], 1);
    h.transport
        .push(bytes_response(200, Bytes::from_static(b"done")));
    assert_eq!(
        h.capabilities
            .request(
                &current,
                "/embeddings",
                CapabilityRequest::default(),
                &RequestCancellation::new()
            )
            .await
            .unwrap()
            .bytes,
        Bytes::from_static(b"done")
    );
    h.clean();
}

#[test]
fn documented_source_coerced_ids_keep_the_stricter_native_string_boundary() {
    let cases =
        json_codec::parse(include_str!("fixtures/known-validation-differences.json")).unwrap();
    for case in arr(&cases["cases"]) {
        assert!(case["source"]["identity"].as_str().is_some());
        let error = validate_capability(&case["input"])
            .err()
            .expect("malformed non-string id remains rejected");
        assert_eq!(error.status, 400);
        assert_eq!(error.message, "Use a short alphanumeric provider ID");
    }
}

#[derive(Default)]
struct AdapterClock {
    now: Arc<std::sync::atomic::AtomicI64>,
    sleeps: Arc<Mutex<Vec<u64>>>,
}
impl crate::agent::decisions::DecisionClock for AdapterClock {
    fn now_ms(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn sleep(&self, duration: Duration) -> crate::agent::decisions::SleepFuture {
        let now = self.now.clone();
        let sleeps = self.sleeps.clone();
        Box::pin(async move {
            let ms = duration.as_millis() as u64;
            lock(&sleeps).push(ms);
            now.fetch_add(ms as i64, Ordering::SeqCst);
            tokio::task::yield_now().await;
        })
    }
}
fn injected_decisions(h: &Harness) -> crate::agent::decisions::Decisions {
    crate::agent::decisions::Decisions::with_backend(Arc::new(CapabilityDecisionBackend::new(
        h.capabilities.clone(),
    )))
}
fn score_response(score: f64) -> TransportResponse {
    json_response(&json!({"answers":{"q":{"type":"noul","noul":score}}}))
}
fn spawn_yes(
    decisions: &crate::agent::decisions::Decisions,
    cancel: &RequestCancellation,
) -> tokio::task::JoinHandle<Result<Option<f64>, DecisionError>> {
    let decisions = decisions.clone();
    let cancel = cancel.clone();
    tokio::spawn(async move {
        decisions
            .yes(&json!({"task":"check"}), "Is the task done?", &cancel)
            .await
    })
}

#[tokio::test]
async fn injected_decisions_resolve_one_capability_owner_and_current_memory_key_each_call() {
    let h = Harness::new();
    let decisions = injected_decisions(&h);
    assert!(!decisions.available());
    assert_eq!(
        decisions
            .yes(&json!("none"), "q", &RequestCancellation::new())
            .await
            .unwrap(),
        None
    );
    let p = h.install(raw("system-one"));
    assert!(decisions.available());
    assert_eq!(
        decisions
            .configure(&h.capabilities.get().unwrap(), Some("must-not-store-copy"))
            .err()
            .unwrap()
            .status,
        409
    );
    for (key, score) in [("first-memory-key", 0.25), ("second-memory-key", 0.75)] {
        h.capabilities
            .set_key("local", &json!(key), &p["identity"])
            .unwrap();
        h.transport.push(score_response(score));
        assert_eq!(
            decisions
                .yes(
                    &json!({"task":"verified"}),
                    "Is it complete?",
                    &RequestCancellation::new()
                )
                .await
                .unwrap(),
            Some(score)
        );
        let records = h.transport.records();
        let req = &records.last().unwrap().request;
        assert_eq!(
            req.headers[header::AUTHORIZATION].to_str().unwrap(),
            format!("Bearer {key}")
        );
        let payload = json_codec::parse(std::str::from_utf8(&req.body).unwrap()).unwrap();
        assert!(payload["state"].is_string());
        assert_eq!(payload["model"], "model");
        assert!(payload.get("messages").is_none());
    }
    assert_eq!(
        h.state.events().len(),
        1,
        "decision consumer never stores another registry or key"
    );
    let persisted = json_codec::stringify_js(&h.state.persisted().unwrap()).unwrap();
    assert!(!persisted.contains("memory-key"));
    assert!(!persisted.contains("must-not-store-copy"));
    assert_eq!(decisions.health()["failures"], 0);
    h.clean();
}

#[tokio::test]
async fn injected_relevance_uses_shared_typed_system_one_transport_and_lexical_fallback() {
    let h = Harness::new();
    let decisions = injected_decisions(&h);
    let sections = vec!["apple banana".into(), "coffee".into()];
    assert_eq!(
        decisions
            .relevance("apple", &sections, &RequestCancellation::new())
            .await
            .unwrap()
            .method,
        "lexical"
    );
    assert_eq!(h.transport.count(), 0);
    h.install(raw("system-one"));
    h.transport.push(json_response(
        &json!({"answers":{"s1":{"type":"noul","noul":0.2},"s2":{"type":"noul","noul":0.9}}}),
    ));
    let result = decisions
        .relevance("apple", &sections, &RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(result.method, "decision");
    assert_eq!(result.scores, vec![0.2, 0.9]);
    let record = &h.transport.records()[0];
    assert_eq!(record.admitted.profile_id.as_deref(), Some("cap:local"));
    assert_eq!(record.admitted.url.path(), "/v1/systemone");
    let body = json_codec::parse(std::str::from_utf8(&record.request.body).unwrap()).unwrap();
    assert!(body["state"].as_str().unwrap().contains("[Section 1]"));
    assert_eq!(body["questions"]["s1"]["type"], "noul");
    h.clean();
}

#[tokio::test]
async fn injected_registry_revocation_is_typed_invalidation_without_circuit_penalty() {
    let h = Harness::new();
    h.install(raw("system-one"));
    let decisions = injected_decisions(&h);
    let (response, _tx, dropped) = held_response(200);
    h.transport.push(response);
    let request = spawn_yes(&decisions, &RequestCancellation::new());
    eventually(|| h.transport.count() == 1).await;
    let mut replacement = raw("system-one");
    replacement["model"] = json!("replacement-model");
    h.install(replacement);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), request)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        None
    );
    assert!(dropped.load(Ordering::SeqCst));
    assert_eq!(decisions.health()["failures"], 0);
    assert_eq!(decisions.health()["pausedUntil"], 0);
    assert!(decisions.available());
    h.transport.push(score_response(0.8));
    assert_eq!(
        decisions
            .yes(&json!("new task"), "q", &RequestCancellation::new())
            .await
            .unwrap(),
        Some(0.8)
    );
    let records = h.transport.records();
    let body = json_codec::parse(std::str::from_utf8(&records[1].request.body).unwrap()).unwrap();
    assert_eq!(body["model"], "replacement-model");
    h.clean();
}

#[tokio::test]
async fn injected_stale_capability_cas_does_not_revoke_valid_inflight_answer() {
    let h = Harness::new();
    h.install(raw("system-one"));
    let decisions = injected_decisions(&h);
    let (response, tx, _) = held_response(200);
    h.transport.push(response);
    let request = spawn_yes(&decisions, &RequestCancellation::new());
    eventually(|| h.transport.count() == 1).await;
    let mut proposed = raw("system-one");
    proposed["model"] = json!("must-not-apply");
    assert_eq!(
        h.capabilities
            .save(&registry(proposed), 0)
            .err()
            .unwrap()
            .status,
        409
    );
    tx.send(Ok(Bytes::from_static(
        br#"{"answers":{"q":{"type":"noul","noul":0.6}}}"#,
    )))
    .unwrap();
    drop(tx);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), request)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        Some(0.6)
    );
    assert_eq!(decisions.health()["failures"], 0);
    assert_eq!(h.state.events().len(), 1);
    h.clean();
}

#[tokio::test]
async fn injected_owner_close_and_caller_cancel_remain_distinct_health_neutral_outcomes() {
    for close in [false, true] {
        let h = Harness::new();
        h.install(raw("system-one"));
        let decisions = injected_decisions(&h);
        let token = RequestCancellation::new();
        let (response, _tx, dropped) = held_response(200);
        h.transport.push(response);
        let request = spawn_yes(&decisions, &token);
        eventually(|| h.transport.count() == 1).await;
        if close {
            h.capabilities.close()
        } else {
            token.cancel()
        }
        let result = tokio::time::timeout(Duration::from_secs(3), request)
            .await
            .unwrap()
            .unwrap();
        if close {
            assert_eq!(result.unwrap(), None);
            assert!(!decisions.available());
        } else {
            let error = result.err().unwrap();
            assert!(error.cancelled);
            assert!(!error.invalidated);
        }
        assert_eq!(decisions.health()["failures"], 0);
        assert!(dropped.load(Ordering::SeqCst));
        h.clean();
    }
}

#[tokio::test]
async fn injected_consumer_close_cancels_its_requests_but_does_not_close_shared_capability_owner() {
    let h = Harness::new();
    let p = h.install(raw("system-one"));
    h.capabilities
        .set_key("local", &json!("still-owned"), &p["identity"])
        .unwrap();
    let decisions = injected_decisions(&h);
    let (response, _tx, dropped) = held_response(200);
    h.transport.push(response);
    let task = spawn_yes(&decisions, &RequestCancellation::new());
    eventually(|| h.transport.count() == 1).await;
    decisions.close();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        None
    );
    assert!(dropped.load(Ordering::SeqCst));
    assert!(h.capabilities.current(&p).unwrap());
    assert!(h.capabilities.key_present(&p).unwrap());
    let another = injected_decisions(&h);
    h.transport.push(score_response(0.4));
    assert_eq!(
        another
            .yes(&json!("new consumer"), "q", &RequestCancellation::new())
            .await
            .unwrap(),
        Some(0.4)
    );
    assert_eq!(
        h.transport.records()[1].request.headers[header::AUTHORIZATION],
        "Bearer still-owned"
    );
    h.clean();
}

#[tokio::test]
async fn injected_capability_upstream_429_preserves_backoff_and_real_provider_failures_drive_circuit(
) {
    let h = Harness::new();
    h.install(raw("system-one"));
    let clock = Arc::new(AdapterClock::default());
    let decisions = crate::agent::decisions::Decisions::with_backend_and_clock(
        Arc::new(CapabilityDecisionBackend::new(h.capabilities.clone())),
        clock.clone(),
    );
    for _ in 0..3 {
        h.transport
            .push(bytes_response(429, Bytes::from_static(b"rate-limited")))
    }
    h.transport.push(score_response(0.7));
    assert_eq!(
        decisions
            .yes(&json!("retry"), "q", &RequestCancellation::new())
            .await
            .unwrap(),
        Some(0.7)
    );
    assert_eq!(*lock(&clock.sleeps), vec![1000, 2000, 4000]);
    assert_eq!(h.transport.count(), 4);
    assert_eq!(decisions.health()["failures"], 0);
    for _ in 0..3 {
        h.transport
            .push(bytes_response(401, Bytes::from_static(b"bad credential")));
        assert_eq!(
            decisions
                .yes(&json!("fail"), "q", &RequestCancellation::new())
                .await
                .unwrap(),
            None
        );
    }
    assert_eq!(decisions.health()["failures"], 3);
    assert!(!decisions.available());
    let count = h.transport.count();
    assert_eq!(
        decisions
            .yes(&json!("paused"), "q", &RequestCancellation::new())
            .await
            .unwrap(),
        None
    );
    assert_eq!(h.transport.count(), count);
    let resume = decisions.health()["pausedUntil"].as_i64().unwrap();
    clock.now.store(resume, Ordering::SeqCst);
    h.transport.push(score_response(0.5));
    assert_eq!(
        decisions
            .yes(&json!("resumed"), "q", &RequestCancellation::new())
            .await
            .unwrap(),
        Some(0.5)
    );
    assert_eq!(decisions.health()["failures"], 0);
    h.clean();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn registry_publication_race_cannot_dispatch_old_key_to_new_endpoint() {
    let h = Harness::new();
    let old = h.install(raw("system-one"));
    h.capabilities
        .set_key("local", &json!("old-endpoint-only"), &old["identity"])
        .unwrap();
    let (sender, entered) = std::sync::mpsc::channel();
    let pause = Arc::new(CommitPause {
        entered: Mutex::new(Some(sender)),
        released: Mutex::new(false),
        wake: std::sync::Condvar::new(),
    });
    let release_on_exit = ReleasePause(pause.clone());
    *lock(&h.state.2) = Some(pause.clone());
    let caps = h.capabilities.clone();
    let mut replacement = raw("system-one");
    replacement["baseUrl"] = json!("http://127.0.0.1:8123/replacement");
    let save = std::thread::spawn(move || caps.save(&registry(replacement), 1));
    entered
        .recv_timeout(Duration::from_secs(3))
        .expect("save reached durable publication pause");
    let current = h.capabilities.pin("decision").unwrap();
    assert_eq!(current["baseUrl"], "http://127.0.0.1:8123/replacement");
    assert!(
        !h.capabilities.key_present(&current).unwrap(),
        "old override was pruned before publication"
    );
    h.transport
        .push(bytes_response(200, Bytes::from_static(b"new-endpoint")));
    let request = spawn_request(&h.capabilities, &current, &RequestCancellation::new());
    tokio::time::sleep(Duration::from_millis(25)).await;
    let before_release = h.transport.count();
    pause.release();
    drop(release_on_exit);
    assert!(save.join().unwrap().is_ok());
    let response = joined(request).await.unwrap();
    assert_eq!(
        before_release, 0,
        "new admission shares the save configuration lock"
    );
    assert_eq!(response.bytes, Bytes::from_static(b"new-endpoint"));
    let record = &h.transport.records()[0];
    assert_eq!(record.admitted.url.path(), "/replacement/embeddings");
    assert!(record.request.headers.get(header::AUTHORIZATION).is_none());
    h.clean();
}

#[tokio::test]
async fn memory_key_scope_binding_defends_against_unexpected_out_of_owner_registry_change() {
    let h = Harness::new();
    let old = h.install(raw("system-one"));
    h.capabilities
        .set_key("local", &json!("old-endpoint-only"), &old["identity"])
        .unwrap();
    let mut replacement = raw("system-one");
    replacement["baseUrl"] = json!("http://127.0.0.1:8123/external-replacement");
    let checked = validate_capability(&replacement).unwrap();
    // Production uses one owner; this simulates accidental direct state edits.
    {
        let mut stored = lock(&h.state.0);
        stored.registry = Some(
            json!({"schema":1,"revision":2,"profiles":[checked],"routes":{"decision":"local"}}),
        );
    }
    let current = h.capabilities.pin("decision").unwrap();
    assert!(!h.capabilities.key_present(&current).unwrap());
    h.transport
        .push(bytes_response(200, Bytes::from_static(b"safe")));
    h.capabilities
        .request(
            &current,
            "/systemone",
            CapabilityRequest::default(),
            &RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(h.transport.records()[0]
        .request
        .headers
        .get(header::AUTHORIZATION)
        .is_none());
    h.clean();
}

#[tokio::test]
async fn injected_decision_total_deadline_includes_shared_resource_queue() {
    let h = Harness::new();
    let mut decision = raw("system-one");
    decision["timeoutMs"] = json!(1000);
    let mut blocker_profile = raw("openai-embeddings");
    blocker_profile["id"] = json!("blocker");
    blocker_profile["timeoutMs"] = json!(60000);
    h.capabilities.save(&json!({"profiles":[decision,blocker_profile],"routes":{"decision":"local","embedding":"blocker"}}),0).unwrap();
    let blocker_profile = h.capabilities.pin("embedding").unwrap();
    let decisions = injected_decisions(&h);
    let (response, tx, _) = held_response(200);
    h.transport.push(response);
    let blocker = spawn_request(
        &h.capabilities,
        &blocker_profile,
        &RequestCancellation::new(),
    );
    eventually(|| h.transport.count() == 1).await;
    let waiting = spawn_yes(&decisions, &RequestCancellation::new());
    eventually(|| is_resource(&h.capabilities, 1, 1)).await;
    // A different modality holds the shared resource under its own longer
    // network timeout. DecisionClient's shorter deadline includes queue time.
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), waiting)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        None
    );
    assert_eq!(decisions.health()["failures"], 1);
    assert_eq!(
        h.transport.count(),
        1,
        "expired queued decision never dispatches"
    );
    assert!(is_resource(&h.capabilities, 1, 0));
    tx.send(Ok(Bytes::from_static(b"done"))).unwrap();
    drop(tx);
    joined(blocker).await.unwrap();
    h.clean();
}

#[test]
fn snapshot_decoration_reads_only_ephemeral_memory_and_scopes_keys_to_saved_endpoint() {
    struct NoStateRead;
    impl CapabilityState for NoStateRead {
        fn value(&self, _: &str) -> Result<Option<Value>, ApiError> {
            panic!("snapshot decoration must not reenter Workspace")
        }
        fn commit_registry(&self, _: u64, _: Value, _: Value) -> Result<(), ApiError> {
            panic!("snapshot decoration must not persist")
        }
    }
    let h = Harness::new();
    let profile = validate_capability(&raw("system-one")).unwrap();
    let capabilities = Capabilities::with_options(
        Arc::new(NoStateRead),
        h.network.clone(),
        ResourceGate::default(),
        Arc::new(|_| None),
    );
    lock(&capabilities.inner.memory)
        .keys
        .insert("local".into(), EphemeralKey::new("memory-only", &profile));
    let registry =
        json!({"schema":1,"revision":1,"profiles":[profile],"routes":{"decision":"local"}});
    let mut snapshot = registry.clone();
    capabilities.decorate_snapshot(&mut snapshot);
    assert_eq!(snapshot["profiles"][0]["keyPresent"], true);
    assert!(!json_codec::stringify_js(&snapshot)
        .unwrap()
        .contains("memory-only"));
    snapshot["profiles"][0]["baseUrl"] = json!("http://127.0.0.1:8124/other");
    capabilities.decorate_snapshot(&mut snapshot);
    assert_eq!(snapshot["profiles"][0]["keyPresent"], false);
    capabilities.close();
    snapshot = registry;
    capabilities.decorate_snapshot(&mut snapshot);
    assert_eq!(snapshot["profiles"][0]["keyPresent"], false);
    h.clean();
}

#[test]
fn malformed_saved_registry_returns_a_typed_snapshot_error_without_panicking() {
    let h = Harness::new();
    for malformed in [
        json!("invalid legacy value"),
        json!({"profiles":null}),
        json!({"profiles":[null]}),
        json!({"profiles":["not an endpoint"]}),
    ] {
        lock(&h.state.0).registry = Some(malformed);
        assert_eq!(h.capabilities.snapshot().unwrap_err().status, 500);
    }
    lock(&h.state.0).registry = None;
    assert_eq!(h.capabilities.snapshot().unwrap()["revision"], 0);
    h.clean();
}
