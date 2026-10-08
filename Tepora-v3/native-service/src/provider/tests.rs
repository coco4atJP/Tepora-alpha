use super::*;
use crate::network::{
    Admitted, ByteStream, NetworkFuture, NetworkPolicy, Resolver, Transport, TransportResponse,
};
use hyper::HeaderMap;
use std::collections::VecDeque;

#[derive(Default)]
struct MemoryState {
    values: Mutex<HashMap<String, Value>>,
    docs: Mutex<HashMap<(String, String), Value>>,
    events: Mutex<Vec<(String, Value)>>,
    receipts: Mutex<Vec<Value>>,
    check_runtime_locks: Mutex<Option<std::sync::Weak<Inner>>>,
}
impl MemoryState {
    fn check_locks(&self) {
        if let Some(inner) = lock(&self.check_runtime_locks)
            .as_ref()
            .and_then(|v| v.upgrade())
        {
            assert!(
                inner.health.try_lock().is_ok(),
                "ProviderState called under health lock"
            );
            assert!(
                inner.limits.try_lock().is_ok(),
                "ProviderState called under limits lock"
            );
        }
    }
}
impl ProviderState for MemoryState {
    fn record_model_call(&self, receipt: Value) -> Result<(), ApiError> { self.check_locks(); lock(&self.receipts).push(receipt); Ok(()) }
    fn value(&self, k: &str) -> Result<Option<Value>, ApiError> {
        self.check_locks();
        Ok(lock(&self.values).get(k).cloned())
    }
    fn set_value(&self, k: &str, v: Value) -> Result<(), ApiError> {
        self.check_locks();
        lock(&self.values).insert(k.into(), v);
        Ok(())
    }
    fn get(&self, c: &str, id: &str) -> Result<Option<Value>, ApiError> {
        self.check_locks();
        Ok(lock(&self.docs).get(&(c.into(), id.into())).cloned())
    }
    fn put(&self, c: &str, v: Value) -> Result<(), ApiError> {
        self.check_locks();
        lock(&self.docs).insert((c.into(), s(&v, "id").into()), v);
        Ok(())
    }
    fn emit(&self, e: &str, v: Value) -> Result<(), ApiError> {
        self.check_locks();
        lock(&self.events).push((e.into(), v));
        Ok(())
    }
}

#[test]
fn public_snapshot_filters_replaced_profile_health_without_reverse_state_locking() {
    let (runtime, state, _, profiles) = setup(vec![raw("a", "chat-completions")], vec![], false);
    *lock(&state.check_runtime_locks) = Some(Arc::downgrade(&runtime.inner));
    let p = &profiles[0];
    runtime.learn_limit(p, 4096).unwrap();
    runtime
        .mark_down(p, 1000, &ProviderFailure::new("rate", "fixture"), Some(2))
        .unwrap();
    let snapshot = runtime.public_snapshot().unwrap();
    assert_eq!(snapshot["profiles"][0]["health"]["failures"], 2);
    assert_eq!(snapshot["profiles"][0]["limits"]["context"], 4096);
    let mut replacement = raw("a", "chat-completions");
    replacement["model"] = json!("replacement");
    let snapshot = runtime
        .save(
            &json!({"profiles":[replacement],"routes":{"main":{"primary":"a"}}}),
            1,
        )
        .unwrap();
    assert_ne!(snapshot["profiles"][0]["identity"], p["identity"]);
    assert!(snapshot["profiles"][0]["health"].is_null());
    assert!(snapshot["profiles"][0]["limits"].is_null());
    runtime.set_key("a", "").unwrap();
}

struct NoSnapshotState;
impl ProviderState for NoSnapshotState {
    fn value(&self, _: &str) -> Result<Option<Value>, ApiError> {
        panic!("decorator must not read State")
    }
    fn set_value(&self, _: &str, _: Value) -> Result<(), ApiError> {
        panic!("decorator must not write State")
    }
    fn get(&self, _: &str, _: &str) -> Result<Option<Value>, ApiError> {
        panic!("decorator must not read documents")
    }
    fn put(&self, _: &str, _: Value) -> Result<(), ApiError> {
        panic!("decorator must not write documents")
    }
    fn emit(&self, _: &str, _: Value) -> Result<(), ApiError> {
        panic!("decorator must not emit")
    }
}

#[tokio::test]
async fn runtime_snapshot_decoration_never_enters_state_or_config_and_keeps_identity_scopes() {
    let network = NativeNetwork::with_components(
        NetworkPolicy::default(),
        Arc::new(NoDns),
        Arc::new(FakeTransport::default()),
    );
    let runtime =
        ProviderRuntime::with_options(Arc::new(NoSnapshotState), network, false, Arc::new(now_ms));
    lock(&runtime.inner.health).insert(
        "current".into(),
        json!({"identity":"current-identity","failures":3}),
    );
    lock(&runtime.inner.health).insert(
        "replaced".into(),
        json!({"identity":"old-identity","failures":9}),
    );
    lock(&runtime.inner.limits).insert(
        "current-identity".into(),
        json!({"context":4096,"learned":true}),
    );
    lock(&runtime.inner.limits).insert("old-identity".into(), json!({"context":64}));
    let cancel = RequestCancellation::new();
    let lease = runtime
        .inner
        .gate
        .acquire("fixture", 1, 10., 0, &cancel)
        .await
        .unwrap();
    let gate = runtime.inner.gate.clone();
    let queued_cancel = cancel.clone();
    let queued =
        tokio::spawn(async move { gate.acquire("fixture", 1, 1., 0, &queued_cancel).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while runtime.inner.gate.snapshot()[0]["queued"] != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let captured = json!({"revision":7,"profiles":[
        {"id":"current","identity":"current-identity","keyPresent":true,"health":null,"limits":{"context":8192},"probe":{"ok":true}},
        {"id":"replaced","identity":"new-identity","keyPresent":false,"health":null,"limits":{"context":16384},"probe":null}
    ],"routes":{"main":{"primary":"current"}},"resources":[]});
    // Holding config simulates a config writer waiting for Workspace State.
    // A decorator which acquires config would form the reverse edge/deadlock.
    let config = lock(&runtime.inner.config);
    let worker = runtime.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        let mut snapshot = captured;
        worker.decorate_snapshot(&mut snapshot);
        tx.send(snapshot).unwrap();
    });
    let result = rx.recv_timeout(Duration::from_secs(2));
    drop(config);
    thread.join().unwrap();
    let snapshot = result.expect("runtime decoration must complete while config is locked");
    assert_eq!(snapshot["revision"], 7);
    assert_eq!(snapshot["profiles"][0]["health"]["failures"], 3);
    assert_eq!(snapshot["profiles"][0]["limits"]["context"], 4096);
    assert_eq!(snapshot["profiles"][0]["keyPresent"], true);
    assert_eq!(snapshot["profiles"][0]["probe"], json!({"ok":true}));
    assert!(snapshot["profiles"][1]["health"].is_null());
    assert_eq!(snapshot["profiles"][1]["limits"]["context"], 16384);
    assert_eq!(
        snapshot["resources"],
        json!([{"resource":"fixture","active":1,"queued":1,"limit":1}])
    );
    cancel.cancel();
    assert!(queued.await.unwrap().is_err());
    drop(lease);
}
struct NoDns;
impl Resolver for NoDns {
    fn lookup<'a>(&'a self, _: &'a str) -> NetworkFuture<'a, Vec<String>> {
        Box::pin(async { panic!("local fixtures must not resolve DNS") })
    }
}
struct Reply {
    status: u16,
    content_type: &'static str,
    chunks: Vec<Vec<u8>>,
    delay: Duration,
    headers: HeaderMap,
    error: Option<NetworkError>,
}
impl Reply {
    fn json(value: Value) -> Self {
        Self {
            status: 200,
            content_type: "application/json",
            chunks: vec![json_codec::stringify_js(&value).unwrap().into_bytes()],
            delay: Duration::ZERO,
            headers: HeaderMap::new(),
            error: None,
        }
    }
    fn text(status: u16, value: &str) -> Self {
        Self {
            status,
            content_type: "application/json",
            chunks: vec![value.as_bytes().to_vec()],
            delay: Duration::ZERO,
            headers: HeaderMap::new(),
            error: None,
        }
    }
    fn sse(text: &str) -> Self {
        Self {
            status: 200,
            content_type: "text/event-stream",
            chunks: text.as_bytes().chunks(1).map(|v| v.to_vec()).collect(),
            delay: Duration::ZERO,
            headers: HeaderMap::new(),
            error: None,
        }
    }
}
#[derive(Default)]
struct FakeTransport {
    replies: Mutex<VecDeque<Reply>>,
    requests: Mutex<Vec<(String, NetworkRequest)>>,
}
impl Transport for FakeTransport {
    fn request<'a>(
        &'a self,
        a: Admitted,
        r: NetworkRequest,
        c: RequestCancellation,
    ) -> NetworkFuture<'a, TransportResponse> {
        Box::pin(async move {
            lock(&self.requests).push((a.url.to_string(), r));
            let reply = lock(&self.replies)
                .pop_front()
                .expect("Unexpected provider request");
            if let Some(error) = reply.error {
                return Err(error);
            }
            if !reply.delay.is_zero() {
                tokio::select! {e=c.cancelled()=>return Err(e),_=tokio::time::sleep(reply.delay)=>{}}
            }
            let mut headers = reply.headers;
            headers.insert(
                "content-type",
                hyper::header::HeaderValue::from_static(reply.content_type),
            );
            let body: ByteStream = Box::pin(futures_util::stream::iter(
                reply.chunks.into_iter().map(|v| Ok(v.into())),
            ));
            Ok(TransportResponse {
                status: reply.status,
                headers,
                body: Some(body),
            })
        })
    }
}
fn raw(id: &str, protocol: &str) -> Value {
    json!({"id":id,"protocol":protocol,"baseUrl":"http://127.0.0.1:12345/v1","model":"model","domain":"device"})
}
fn setup(
    raw_profiles: Vec<Value>,
    replies: Vec<Reply>,
    detect: bool,
) -> (
    ProviderRuntime,
    Arc<MemoryState>,
    Arc<FakeTransport>,
    Vec<Value>,
) {
    let state = Arc::new(MemoryState::default());
    let transport = Arc::new(FakeTransport::default());
    lock(&transport.replies).extend(replies);
    let network = NativeNetwork::with_components(
        NetworkPolicy::default(),
        Arc::new(NoDns),
        transport.clone(),
    );
    let runtime = ProviderRuntime::with_options(state.clone(), network, detect, Arc::new(now_ms));
    let ids: Vec<_> = raw_profiles.iter().map(|p| p["id"].clone()).collect();
    runtime.save(&json!({"profiles":raw_profiles,"routes":{"main":{"primary":ids[0],"fallbacks":&ids[1..]}}}),0).unwrap();
    let profiles = runtime.chain("main").unwrap();
    (runtime, state, transport, profiles)
}
fn sink() -> EventSink {
    Arc::new(|_| {})
}
fn chat_answer(text: &str) -> Reply {
    Reply::json(
        json!({"choices":[{"message":{"content":text},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}),
    )
}
fn request(profiles: Vec<Value>) -> InvokeRequest {
    InvokeRequest {
        chain: profiles,
        messages: vec![json!({"role":"user","content":"hello"})],
        options: json!({}),
    }
}

#[test]
fn profile_identity_matches_frozen_javascript_order_and_utf16() {
    let p=validate_profile(&json!({"id":"local","protocol":"chat-completions","baseUrl":"http://LOCALHOST:80/v1/","model":"model","domain":"device"})).unwrap();
    assert_eq!(
        p["identity"],
        "71aff78fc8515a7b5ba1b877d0362094431ce6d2d38e5a21359ca546f292bcdb"
    );
    let raw=json_codec::parse(r#"{"id":"wide","name":"  日本語 \ud800  ","protocol":"responses","baseUrl":"https://example.com/v1/","model":" o4-mini ","domain":"cloud","sampling":{"seed":3,"temperature":0.7,"top_p":1},"reasoningEffort":"high"}"#).unwrap();
    assert_eq!(
        validate_profile(&raw).unwrap()["identity"],
        "88da133d95b32186a18ce9f5bdef65d2d5e4a7487f2cbb9ef3274a542f9f1e4c"
    );
}

#[test]
fn frozen_profile_oracle_covers_protocols_addresses_sampling_order_and_surrogates() {
    let fixture = json_codec::parse(include_str!("fixtures/profiles.json")).unwrap();
    for case in array(&fixture["cases"]) {
        let actual = validate_profile(&case["raw"]).unwrap();
        assert_eq!(
            json_codec::stringify_js(&actual).unwrap(),
            json_codec::stringify_js(&case["expected"]).unwrap(),
            "raw: {}",
            json_codec::stringify_js(&case["raw"]).unwrap()
        );
    }
}
#[test]
fn validation_and_first_configured_role_fallback() {
    let a = raw("a", "chat-completions");
    let b = raw("b", "responses");
    let c = validate_registry(
        &json!({"profiles":[a,b],"routes":{"main":{"primary":"a"},"work":{"primary":"b"}}}),
    )
    .unwrap();
    assert_eq!(
        role_chain("compaction", &c)
            .iter()
            .map(|p| s(p, "id"))
            .collect::<Vec<_>>(),
        vec!["b"]
    );
    assert_eq!(role_chain("chat", &c)[0]["id"], "a");
    assert!(role_chain("escalation", &c).is_empty());
    let mut p = raw("a", "chat-completions");
    p["domain"] = json!("cloud");
    assert!(validate_profile(&p).is_err());
    p["domain"] = json!("device");
    p["sampling"] = json!({"unknown":1});
    assert!(validate_profile(&p).is_err());
    assert!(validate_registry(&json!({"profiles":[raw("a","responses")],"routes":{"main":{"primary":"a","fallbacks":["a"]}}})).is_err());
}
#[test]
fn headers_hash_session_and_distinguish_protocol_credentials() {
    for (protocol, key_header) in [
        ("chat-completions", "authorization"),
        ("responses", "authorization"),
        ("anthropic", "x-api-key"),
        ("gemini", "x-goog-api-key"),
    ] {
        let mut p = validate_profile(&raw("a", protocol)).unwrap();
        p["sessionHeader"] = json!("x-session");
        let headers = request_headers(&p, "secret", Some(&json!("session"))).unwrap();
        assert_eq!(headers["user-agent"], USER_AGENT);
        assert_eq!(
            headers["x-session"],
            "tepora-3f3af1ecebbd1410ab417ec0d27bbfcb"
        );
        assert_eq!(
            headers[key_header],
            if key_header == "authorization" {
                "Bearer secret"
            } else {
                "secret"
            }
        );
    }
    let mut p = raw("a", "gemini");
    p["model"] = json!("models/gemini/name");
    assert_eq!(
        request_path(&p),
        "models/gemini%2Fname:streamGenerateContent?alt=sse"
    );
}
#[test]
fn status_classification_optional_healing_and_retry_after() {
    let mut headers = HeaderMap::new();
    headers.insert("retry-after-ms", "2500".parse().unwrap());
    assert_eq!(retry_after(&headers, 0), Some(2500));
    headers.clear();
    headers.insert(
        "retry-after",
        "Wed, 21 Oct 2015 07:28:00 GMT".parse().unwrap(),
    );
    let date = chrono::DateTime::parse_from_rfc2822("Wed, 21 Oct 2015 07:28:00 GMT")
        .unwrap()
        .timestamp_millis();
    assert_eq!(retry_after(&headers, date - 7000), Some(7000));
    for (status, body, kind) in [
        (401, "bad", "auth"),
        (403, "bad", "auth"),
        (429, "limited", "rate"),
        (400, "maximum context length is 4096", "overflow"),
        (413, "context window 8192", "overflow"),
        (408, "slow", "transient"),
        (409, "busy", "transient"),
        (500, "failed", "transient"),
        (422, "unsupported stream_options", "bad-request"),
    ] {
        let e = classify_response(status, &HeaderMap::new(), body, &["stream_options"], 0);
        assert_eq!(e.kind, kind);
        if status == 400 {
            assert_eq!(e.limit, Some(4096));
        }
        if status == 422 {
            assert_eq!(e.param.as_deref(), Some("stream_options"));
        }
    }
}
#[test]
fn incremental_framing_handles_utf8_crlf_multiline_final_and_bounds() {
    let mut decoder = wire::FrameDecoder::new(wire::Framing::Sse);
    let input = "\u{feff}data: {\"x\":\r\ndata: \"日本😀\"}\r\n\r\ndata: tail";
    let mut result = vec![];
    for byte in input.bytes() {
        result.extend(decoder.push(&[byte], false).unwrap());
    }
    result.extend(decoder.push(&[], true).unwrap());
    assert_eq!(result, vec!["{\"x\":\n\"日本😀\"}", "tail"]);
    let mut utf8 = wire::Utf8Decoder::default();
    assert_eq!(utf8.push(&[0xe3, 0x81], false), "");
    assert_eq!(utf8.push(&[0x82, 0xff, 0xe3], true), "あ��");
    assert!(wire::FrameDecoder::new(wire::Framing::Sse)
        .push("x".repeat(4_000_000).as_bytes(), false)
        .is_err());
    assert!(wire::FrameDecoder::new(wire::Framing::Ndjson)
        .push(format!("{}\n", "x".repeat(4_000_000)).as_bytes(), false)
        .is_err());
    assert_eq!(
        wire::FrameDecoder::new(wire::Framing::Sse)
            .push("data: \u{feff}ok\n\n".as_bytes(), true)
            .unwrap(),
        vec!["ok"]
    );
    assert_eq!(
        wire::FrameDecoder::new(wire::Framing::Ndjson)
            .push(" \u{feff}{}\u{feff} \n".as_bytes(), true)
            .unwrap(),
        vec!["{}"]
    );
    assert_eq!(
        wire::FrameDecoder::new(wire::Framing::Ndjson)
            .push("\u{85}{}\n".as_bytes(), true)
            .unwrap(),
        vec!["\u{85}{}"]
    );
}

#[tokio::test]
async fn zero_request_output_cap_uses_profile_default_like_javascript_or() {
    let (runtime, _, transport, profiles) = setup(
        vec![raw("a", "chat-completions")],
        vec![chat_answer("ok")],
        false,
    );
    let mut r = request(profiles);
    r.options = json!({"maxTokens":0});
    let answer = runtime
        .invoke(r, &RequestCancellation::new(), sink())
        .await
        .unwrap();
    assert_eq!(answer["route"]["maxTokens"], 8192);
    let requests = lock(&transport.requests);
    let body: Value = serde_json::from_slice(&requests[0].1.body).unwrap();
    assert_eq!(body["max_tokens"], 8192);
}
#[tokio::test]
async fn all_four_wire_protocols_use_real_native_encoder_decoder_and_streaming() {
    let cases=vec![
        ("chat-completions",Reply::sse("data: malformed\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"日本😀\"},\"finish_reason\":\"stop\"}]}\r\n\r\ndata: [DONE]\n\n"),"/v1/chat/completions"),
        ("responses",Reply::sse("data: {\"type\":\"response.output_text.delta\",\"delta\":\"日本😀\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"日本😀\"}]}]}}\n\n"),"/v1/responses"),
        ("anthropic",Reply::sse("data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"日本😀\"}}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n"),"/v1/messages"),
        ("gemini",Reply::sse("data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"日本😀\"}]},\"finishReason\":\"STOP\"}]}"),"/v1/models/model:streamGenerateContent?alt=sse"),
    ];
    for (protocol, reply, path) in cases {
        let (runtime, _, transport, profiles) = setup(vec![raw("a", protocol)], vec![reply], false);
        runtime.set_key("a", "fixture-secret").unwrap();
        let events = Arc::new(Mutex::new(vec![]));
        let out = events.clone();
        let answer = runtime
            .invoke(
                request(profiles),
                &RequestCancellation::new(),
                Arc::new(move |e| lock(&out).push(e)),
            )
            .await
            .unwrap();
        assert_eq!(answer["content"], "日本😀", "{protocol}");
        assert!(lock(&events).iter().any(|e| e.kind == "text"));
        let requests = lock(&transport.requests);
        assert!(requests[0].0.ends_with(path));
        let body = json_codec::parse(std::str::from_utf8(&requests[0].1.body).unwrap()).unwrap();
        assert!(body.is_object());
        assert_eq!(runtime.active_count(), 0);
    }
}
#[tokio::test]
async fn ollama_discovery_selects_native_endpoint_and_context() {
    let replies=vec![Reply::text(404,"missing"),Reply::json(json!({"version":"0.9"})),Reply::json(json!({"model_info":{"general.context_length":65536}})),Reply::text(200,"{\"message\":{\"content\":\"ok\"},\"done\":true,\"done_reason\":\"stop\",\"prompt_eval_count\":2,\"eval_count\":1}\n")];
    let (runtime, state, transport, profiles) =
        setup(vec![raw("a", "chat-completions")], replies, true);
    let answer = runtime
        .invoke(
            request(profiles.clone()),
            &RequestCancellation::new(),
            sink(),
        )
        .await
        .unwrap();
    assert_eq!(answer["content"], "ok");
    assert_eq!(answer["route"]["server"], "ollama");
    let requests = lock(&transport.requests);
    assert!(requests[3].0.ends_with("/api/chat"));
    let body: Value = serde_json::from_slice(&requests[3].1.body).unwrap();
    assert_eq!(body["options"]["num_ctx"], 32768);
    assert_eq!(
        state
            .value(&format!("provider-limits:{}", s(&profiles[0], "identity")))
            .unwrap()
            .unwrap()["modelMax"],
        65536
    );
}
#[tokio::test]
async fn cancelled_discovery_does_not_persist_defaults_or_poison_next_caller() {
    let mut delayed = Reply::json(json!({"n_ctx":4096}));
    delayed.delay = Duration::from_secs(60);
    let (runtime, state, transport, profiles) = setup(
        vec![raw("a", "chat-completions")],
        vec![delayed, Reply::json(json!({"n_ctx":8192,"total_slots":2}))],
        true,
    );
    let cancel = RequestCancellation::new();
    let r = runtime.clone();
    let p = profiles[0].clone();
    let c = cancel.clone();
    let task = tokio::spawn(async move { r.limits(&p, &c).await });
    while lock(&transport.requests).is_empty() {
        tokio::task::yield_now().await;
    }
    cancel.cancel();
    assert!(task.await.unwrap().unwrap_err().cancelled);
    assert!(state
        .value(&format!("provider-limits:{}", s(&profiles[0], "identity")))
        .unwrap()
        .is_none());
    let result = runtime
        .limits(&profiles[0], &RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(result["context"], 8192);
}
#[tokio::test]
async fn learned_context_survives_refresh_and_configured_context_wins_discovery() {
    let mut p = raw("a", "chat-completions");
    p["contextTokens"] = json!(16384.0);
    let (runtime, state, _, profiles) =
        setup(vec![p], vec![Reply::json(json!({"n_ctx":65536.0}))], true);
    let limits = runtime
        .limits(&profiles[0], &RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(limits["context"], 16384);
    assert_eq!(limits["source"], "configured");
    runtime.learn_limit(&profiles[0], 8000).unwrap();
    assert_eq!(
        runtime.known_limits(&profiles[0]).unwrap().unwrap()["context"],
        8000
    );
    let key = format!("provider-limits:{}", s(&profiles[0], "identity"));
    assert_eq!(state.value(&key).unwrap().unwrap()["learned"], true);
}
#[tokio::test]
async fn optional_parameter_heals_without_spending_ordinary_attempt() {
    let (runtime, _, transport, profiles) = setup(
        vec![raw("a", "chat-completions")],
        vec![
            Reply::text(400, "Unsupported stream_options"),
            chat_answer("ok"),
        ],
        false,
    );
    let answer = runtime
        .invoke(
            request(profiles.clone()),
            &RequestCancellation::new(),
            sink(),
        )
        .await
        .unwrap();
    assert_eq!(answer["content"], "ok");
    let requests = lock(&transport.requests);
    assert_eq!(requests.len(), 2);
    let first: Value = serde_json::from_slice(&requests[0].1.body).unwrap();
    let second: Value = serde_json::from_slice(&requests[1].1.body).unwrap();
    assert!(first.get("stream_options").is_some());
    assert!(second.get("stream_options").is_none());
    assert_eq!(
        runtime.compat(&profiles[0]).unwrap()["drop"],
        json!(["stream_options"])
    );
}
#[tokio::test]
async fn rate_and_auth_skip_retries_but_use_fallback_and_overflow_returns_immediately() {
    for status in [429, 401] {
        let (runtime, _, transport, profiles) = setup(
            vec![raw("a", "chat-completions"), raw("b", "responses")],
            vec![
                Reply::text(status, "failure"),
                Reply::json(
                    json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"fallback"}]}]}),
                ),
            ],
            false,
        );
        let answer = runtime
            .invoke(request(profiles), &RequestCancellation::new(), sink())
            .await
            .unwrap();
        assert_eq!(answer["route"]["profileId"], "b");
        assert_eq!(lock(&transport.requests).len(), 2);
    }
    let (runtime, _, transport, profiles) = setup(
        vec![raw("a", "chat-completions"), raw("b", "responses")],
        vec![Reply::text(400, "maximum context length is 4096")],
        false,
    );
    let error = runtime
        .invoke(
            request(profiles.clone()),
            &RequestCancellation::new(),
            sink(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind, "overflow");
    assert_eq!(
        runtime.known_limits(&profiles[0]).unwrap().unwrap()["context"],
        4096
    );
    assert_eq!(lock(&transport.requests).len(), 1);
}
#[tokio::test]
async fn profile_replacement_revokes_waiters_and_never_sends_replacement_key_to_old_endpoint() {
    let (runtime, _, transport, profiles) =
        setup(vec![raw("a", "chat-completions")], vec![], false);
    runtime.set_key("a", "old-secret").unwrap();
    let held = runtime
        .inner
        .gate
        .acquire("a", 1, 0., 0, &RequestCancellation::new())
        .await
        .unwrap();
    let r = runtime.clone();
    let p = profiles.clone();
    let task = tokio::spawn(async move {
        r.invoke(request(p), &RequestCancellation::new(), sink())
            .await
    });
    while runtime
        .inner
        .gate
        .snapshot()
        .as_array()
        .unwrap()
        .iter()
        .all(|g| g["queued"] == 0)
    {
        tokio::task::yield_now().await;
    }
    let mut new = raw("a", "chat-completions");
    new["baseUrl"] = json!("http://127.0.0.1:54321/v1");
    runtime
        .save(
            &json!({"profiles":[new],"routes":{"main":{"primary":"a"}}}),
            1,
        )
        .unwrap();
    runtime.set_key("a", "replacement-secret").unwrap();
    drop(held);
    assert!(task.await.unwrap().is_err());
    assert!(lock(&transport.requests).is_empty());
    assert_eq!(runtime.key_for(&profiles[0]).unwrap(), "");
    assert_eq!(runtime.active_count(), 0);
}
#[tokio::test]
async fn gate_reserves_main_lane_cleans_cancelled_waiters_and_releases_idempotently() {
    let gate = ResourceGate::default();
    let cancel = RequestCancellation::new();
    let mut worker = gate.acquire("gpu", 2, 0., 1, &cancel).await.unwrap();
    let waiting_cancel = RequestCancellation::new();
    let g = gate.clone();
    let c = waiting_cancel.clone();
    let waiting = tokio::spawn(async move { g.acquire("gpu", 2, 0., 1, &c).await });
    tokio::task::yield_now().await;
    let urgent = gate.acquire("gpu", 2, 10., 1, &cancel).await.unwrap();
    assert_eq!(gate.snapshot()[0]["active"], 2);
    waiting_cancel.cancel();
    assert!(waiting.await.unwrap().is_err());
    worker.release();
    worker.release();
    assert_eq!(gate.snapshot()[0]["active"], 1);
    drop(urgent);
    assert_eq!(gate.snapshot()[0]["active"], 0);
    assert_eq!(gate.snapshot()[0]["queued"], 0);
}
#[test]
fn slot_affinity_avoids_last_character_slot_for_new_workers() {
    let pool = SlotPool::default();
    let main = pool.acquire("gpu", 3, "main", true).unwrap();
    assert_eq!(main.slot, 0);
    drop(main);
    let worker = pool.acquire("gpu", 3, "worker", false).unwrap();
    assert_eq!(worker.slot, 1);
    drop(worker);
    let same = pool.acquire("gpu", 3, "worker", false).unwrap();
    assert_eq!(same.slot, 1);
    let main = pool.acquire("gpu", 3, "main", true).unwrap();
    assert_eq!(main.slot, 0);
}
#[tokio::test]
async fn malformed_ollama_and_truncated_responses_fail_and_secrets_are_redacted() {
    let (runtime, _, _, profiles) = setup(
        vec![raw("a", "responses")],
        vec![Reply::sse(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n",
        )],
        false,
    );
    let p = &profiles[0];
    let scope = NetworkScope {
        profile: Some(NetworkProfile::from_value(p).unwrap()),
        ..Default::default()
    };
    let e = protocol_chat(
        &runtime.inner.network,
        p,
        "secret",
        &[],
        &json!({}),
        scope,
        &RequestCancellation::new(),
        &sink(),
    )
    .await
    .unwrap_err();
    assert_eq!(e.kind, "transient");
    assert!(e.message.contains("before completion"));
    let (runtime, _, _, profiles) = setup(
        vec![raw("a", "chat-completions")],
        vec![Reply::text(400, "secret rejected custom")],
        false,
    );
    runtime.set_key("a", "secret").unwrap();
    let e = runtime
        .invoke(request(profiles), &RequestCancellation::new(), sink())
        .await
        .unwrap_err();
    assert!(!e.message.contains("secret"));
    assert!(!e.body.contains("secret"));
    assert!(!format!("{e:?}").contains("secret"));
}
#[test]
fn key_revocation_revision_cas_vision_and_catalog_price() {
    let (runtime, state, _, profiles) = setup(vec![raw("a", "chat-completions")], vec![], false);
    runtime.set_key("a", "secret").unwrap();
    assert_eq!(
        runtime.public_snapshot().unwrap()["profiles"][0]["keyPresent"],
        true
    );
    assert!(
        !json_codec::stringify_js(&runtime.public_snapshot().unwrap())
            .unwrap()
            .contains("secret")
    );
    assert!(runtime
        .save(&json!({"profiles":[],"routes":{}}), 0)
        .is_err());
    runtime.learn_no_vision(&profiles[0]).unwrap();
    assert!(!runtime.vision_allowed(&profiles[0]).unwrap());
    state.put("catalog",json!({"id":"models.dev","entries":[{"modelId":"vendor/model","cost":{"input":1,"output":2}}]})).unwrap();
    assert_eq!(
        runtime
            .price(&json!({"domain":"cloud","model":"model"}))
            .unwrap()
            .unwrap()["input"],
        1
    );
    assert!(runtime
        .price(&json!({"domain":"device","model":"model"}))
        .unwrap()
        .is_none());
    let mut changed = raw("a", "responses");
    changed["baseUrl"] = json!("http://127.0.0.1:12345/v2");
    runtime
        .save(
            &json!({"profiles":[changed],"routes":{"main":{"primary":"a"}}}),
            1,
        )
        .unwrap();
    assert_eq!(
        runtime.public_snapshot().unwrap()["profiles"][0]["keyPresent"],
        false
    );
}

#[tokio::test]
async fn idle_learning_retries_without_ordinary_backoff_and_persists_timeouts() {
    let mut timeout = Reply::text(200, "");
    timeout.error = Some(NetworkError {
        status: 504,
        blocked: false,
        timeout: true,
        idle: true,
        cancelled: false,
        message: "Silent server".into(),
    });
    let (runtime, state, transport, profiles) = setup(
        vec![raw("a", "chat-completions")],
        vec![timeout, chat_answer("recovered")],
        false,
    );
    let answer = runtime
        .invoke(
            request(profiles.clone()),
            &RequestCancellation::new(),
            sink(),
        )
        .await
        .unwrap();
    assert_eq!(answer["content"], "recovered");
    assert_eq!(lock(&transport.requests).len(), 2);
    let learned = state
        .value(&format!(
            "provider-timeouts:{}",
            s(&profiles[0], "identity")
        ))
        .unwrap()
        .unwrap();
    assert_eq!(learned["idleTimeoutMs"], 240000);
    assert_eq!(learned["firstByteTimeoutMs"], 600000);
    assert!(lock(&state.events)
        .iter()
        .any(|(kind, _)| kind == "route.timeout"));
}

#[tokio::test]
async fn cancelling_retry_sleep_releases_resource_without_another_dispatch() {
    let (runtime, _, transport, profiles) = setup(
        vec![raw("a", "chat-completions")],
        vec![Reply::text(500, "server error")],
        false,
    );
    let r = runtime.clone();
    let cancel = RequestCancellation::new();
    let c = cancel.clone();
    let task = tokio::spawn(async move { r.invoke(request(profiles), &c, sink()).await });
    while lock(&transport.requests).is_empty() {
        tokio::task::yield_now().await;
    }
    // The transport returned an HTTP error synchronously. Admission remains held
    // while the retry delay is pending, matching the existing source contract.
    tokio::task::yield_now().await;
    assert_eq!(runtime.inner.gate.snapshot()[0]["active"], 1);
    cancel.cancel();
    assert!(task.await.unwrap().unwrap_err().cancelled);
    assert_eq!(runtime.inner.gate.snapshot()[0]["active"], 0);
    assert_eq!(lock(&transport.requests).len(), 1);
    assert_eq!(runtime.active_count(), 0);
}

#[tokio::test]
async fn truncated_ollama_json_is_rejected_and_full_json_preserves_utf16() {
    let (runtime, _, _, profiles) = setup(
        vec![raw("a", "chat-completions")],
        vec![Reply::text(200, "{bad json}\n")],
        false,
    );
    let mut profile = profiles[0].clone();
    profile["server"] = json!("ollama");
    let scope = NetworkScope {
        profile: Some(NetworkProfile::from_value(&profile).unwrap()),
        ..Default::default()
    };
    let error = protocol_chat(
        &runtime.inner.network,
        &profile,
        "",
        &[],
        &json!({}),
        scope,
        &RequestCancellation::new(),
        &sink(),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("Invalid Ollama NDJSON"));
    let body = json_codec::parse(
        r#"{"choices":[{"message":{"content":"x\ud800\ue000😀"},"finish_reason":"stop"}]}"#,
    )
    .unwrap();
    let (runtime, _, _, profiles) = setup(
        vec![raw("a", "chat-completions")],
        vec![Reply::json(body)],
        false,
    );
    let answer = runtime
        .invoke(request(profiles), &RequestCancellation::new(), sink())
        .await
        .unwrap();
    assert_eq!(
        json_codec::utf16_units(s(&answer, "content")),
        vec![120, 0xd800, 0xe000, 0xd83d, 0xde00]
    );
}

struct ProbeTransport {
    calls: Mutex<usize>,
}
impl Transport for ProbeTransport {
    fn request<'a>(
        &'a self,
        _: Admitted,
        request: NetworkRequest,
        _: RequestCancellation,
    ) -> NetworkFuture<'a, TransportResponse> {
        Box::pin(async move {
            let body = json_codec::parse(std::str::from_utf8(&request.body).unwrap()).unwrap();
            let mut count = lock(&self.calls);
            *count += 1;
            let response = if *count == 1 {
                let challenge = s(&body["messages"][1], "content")
                    .strip_prefix("Challenge: ")
                    .unwrap();
                json!({"choices":[{"message":{"content":"","tool_calls":[{"id":"probe_1","type":"function","function":{"name":"tepora_probe","arguments":json_codec::stringify_js(&json!({"challenge":challenge})).unwrap()}}]},"finish_reason":"tool_calls"}]})
            } else {
                let tool = body["messages"].as_array().unwrap().last().unwrap();
                let value = json_codec::parse_js_text(s(tool, "content")).unwrap();
                json!({"choices":[{"message":{"content":value["receipt"]},"finish_reason":"stop"}]})
            };
            let mut headers = HeaderMap::new();
            headers.insert("content-type", "application/json".parse().unwrap());
            Ok(TransportResponse {
                status: 200,
                headers,
                body: Some(Box::pin(futures_util::stream::iter(vec![Ok(
                    json_codec::stringify_js(&response).unwrap().into(),
                )]))),
            })
        })
    }
}

#[tokio::test]
async fn safe_probe_performs_two_actual_calls_and_persists_only_verified_receipt() {
    let state = Arc::new(MemoryState::default());
    let transport = Arc::new(ProbeTransport {
        calls: Mutex::new(0),
    });
    let network = NativeNetwork::with_components(
        NetworkPolicy::default(),
        Arc::new(NoDns),
        transport.clone(),
    );
    let runtime = ProviderRuntime::with_options(state.clone(), network, false, Arc::new(now_ms));
    runtime
        .save(
            &json!({"profiles":[raw("a","chat-completions")],"routes":{"main":{"primary":"a"}}}),
            0,
        )
        .unwrap();
    let result = runtime
        .probe("a", &RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(*lock(&transport.calls), 2);
    let saved = state
        .get("provider-probe", s(&result, "id"))
        .unwrap()
        .unwrap();
    assert_eq!(saved, result);
}

#[tokio::test]
async fn service_stop_cancels_probe_without_closing_future_admission() {
    let mut delayed = chat_answer("pending");
    delayed.delay = Duration::from_secs(60);
    let (runtime, state, transport, profiles) = setup(
        vec![raw("a", "chat-completions")],
        vec![delayed, chat_answer("new turn")],
        false,
    );
    let r = runtime.clone();
    let task = tokio::spawn(async move { r.probe("a", &RequestCancellation::new()).await });
    while lock(&transport.requests).is_empty() {
        tokio::task::yield_now().await;
    }
    runtime.cancel_all();
    assert!(task.await.unwrap().unwrap_err().cancelled);
    assert!(state
        .get("provider-probe", s(&profiles[0], "identity"))
        .unwrap()
        .is_none());
    assert_eq!(runtime.active_count(), 0);
    let result = runtime
        .invoke(request(profiles), &RequestCancellation::new(), sink())
        .await
        .unwrap();
    assert_eq!(result["content"], "new turn");
    assert_eq!(runtime.inner.gate.snapshot()[0]["active"], 0);
}

#[tokio::test]
async fn accounting_receipts_capture_retries_missing_usage_and_session_without_stream_writes() {
    let (runtime, state, transport, profiles) = setup(vec![raw("a","chat-completions")], vec![Reply::text(500,"private upstream failure"), chat_answer("private answer")], false);
    let mut request = request(profiles);
    request.options = json!({"accountingSessionId":"session-a","accountingPurpose":"summary"});
    runtime.invoke(request, &RequestCancellation::new(), sink()).await.unwrap();
    let receipts = lock(&state.receipts);
    assert_eq!(receipts.len(),2); assert_eq!(lock(&transport.requests).len(),2);
    assert_eq!(receipts[0]["outcome"],"error"); assert_eq!(receipts[0]["usageStatus"]["status"],"missing");
    assert_eq!(receipts[1]["outcome"],"completed"); assert_eq!(receipts[1]["usageStatus"]["status"],"complete");
    assert_eq!(receipts[1]["retry"],true); assert_eq!(receipts[1]["attempt"],2);
    assert_eq!(receipts[1]["purpose"],"summary"); assert_eq!(receipts[1]["sessionId"],"session-a");
    assert_eq!(receipts[1]["usage"]["input"],3.); assert!(receipts[1]["cost"].is_null());
    assert!(!format!("{receipts:?}").contains("private"));
}
#[tokio::test]
async fn accounting_receipts_capture_cancelled_dispatch_and_skip_precancelled_call() {
    let mut reply=chat_answer("unused"); reply.delay=Duration::from_secs(30);
    let (runtime,state,transport,profiles)=setup(vec![raw("a","chat-completions")],vec![reply],false);
    let cancel=RequestCancellation::new(); cancel.cancel();
    assert!(runtime.invoke(request(profiles.clone()),&cancel,sink()).await.is_err());
    assert!(lock(&state.receipts).is_empty());
    let cancel=RequestCancellation::new(); let token=cancel.clone(); let r=runtime.clone();
    let task=tokio::spawn(async move {r.invoke(request(profiles),&token,sink()).await});
    while lock(&transport.requests).is_empty() {tokio::task::yield_now().await;}
    cancel.cancel(); assert!(task.await.unwrap().unwrap_err().cancelled);
    let receipts=lock(&state.receipts); assert_eq!(receipts.len(),1);
    assert_eq!(receipts[0]["outcome"],"cancelled"); assert!(receipts[0]["cost"].is_null());
    assert_eq!(receipts[0]["usageStatus"]["status"],"missing");
}
#[tokio::test]
async fn accounting_receipts_preserve_partial_stream_usage_after_failure() {
    let (runtime,state,_,profiles)=setup(vec![raw("a","responses")],vec![Reply::sse("data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"private failure\"},\"usage\":{\"input_tokens\":7,\"output_tokens\":2}}}\n\n")],false);
    let p=&profiles[0]; let owner=state.clone();
    let receipt=crate::model_usage::Dispatch::new(p,&json!("s"),"normal",1,None,Arc::new(move|v|owner.record_model_call(v)));
    let result=wire::protocol_chat_accounted(&runtime.inner.network,p,"",&[],&json!({}),NetworkScope{profile:Some(NetworkProfile::from_value(p).unwrap()),..Default::default()},&RequestCancellation::new(),&sink(),Some(receipt)).await;
    assert!(result.is_err());
    let receipts=lock(&state.receipts); assert_eq!(receipts.len(),1);
    assert_eq!(receipts[0]["usage"]["input"],7.);
    assert_eq!(receipts[0]["usageStatus"]["status"],"partial");
    assert_eq!(receipts[0]["outcome"],"error"); assert!(receipts[0]["cost"].is_null());
    assert!(!receipts[0].to_string().contains("private failure"));
}
#[tokio::test]
async fn accounting_receipts_exclude_requests_rejected_before_transport() {
    let (runtime,state,transport,profiles)=setup(vec![raw("a","chat-completions")],vec![],false);
    let p=&profiles[0]; let owner=state.clone();
    let receipt=crate::model_usage::Dispatch::new(p,&json!("s"),"normal",1,None,Arc::new(move|v|owner.record_model_call(v)));
    let result=wire::protocol_chat_accounted(&runtime.inner.network,p,"",&[],&json!({}),NetworkScope{profile:Some(NetworkProfile::from_value(p).unwrap()),max_request_bytes:Some(1),..Default::default()},&RequestCancellation::new(),&sink(),Some(receipt)).await;
    assert!(result.is_err()); assert!(lock(&transport.requests).is_empty()); assert!(lock(&state.receipts).is_empty());
}
#[tokio::test]
async fn accounting_receipts_distinguish_missing_usage_from_reported_zero() {
    for usage in [Value::Null,json!({"prompt_tokens":0,"completion_tokens":0})] {
        let (runtime,state,_,profiles)=setup(vec![raw("a","chat-completions")],vec![Reply::json(json!({"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":usage}))],false);
        runtime.invoke(request(profiles),&RequestCancellation::new(),sink()).await.unwrap();
        let receipts=lock(&state.receipts); assert_eq!(receipts.len(),1);
        assert_eq!(receipts[0]["usageStatus"]["status"],if usage.is_null(){"missing"}else{"complete"});
        assert!(receipts[0]["cost"].is_null());
    }
}
#[test]
fn accounting_price_lookup_rejects_conflicting_catalog_entries() {
    let (runtime,state,_,_)=setup(vec![raw("a","chat-completions")],vec![],false);
    state.put("catalog",json!({"id":"models.dev","entries":[{"modelId":"same","cost":{"input":1,"output":2}},{"modelId":"same","cost":{"input":3,"output":4}}]})).unwrap();
    assert!(runtime.price(&json!({"domain":"cloud","model":"same"})).unwrap().is_none());
    assert!(runtime.price(&json!({"domain":"cloud","model":"missing"})).unwrap().is_none());
}
