use super::*;
use crate::network::{
    Admitted, NetworkFuture, NetworkMode, NetworkPolicy, NetworkRequest, Resolver, Transport,
    TransportResponse,
};
use bytes::Bytes;
use hyper::{header, HeaderMap};
use std::collections::VecDeque;
use tokio::sync::Notify;

struct State(Mutex<WebSnapshot>);
impl State {
    fn new() -> Arc<Self> {
        Arc::new(Self(Mutex::new(WebSnapshot::new(
            WebConfig::default(),
            String::new(),
        ))))
    }
    fn replace(&self, config: WebConfig, key: &str) {
        *lock(&self.0) = WebSnapshot::new(config, key.into());
    }
}
impl WebState for State {
    fn web_snapshot(&self) -> Result<WebSnapshot, ApiError> {
        Ok(lock(&self.0).clone())
    }
}
struct Dns {
    paused: bool,
    entered: Notify,
    release: Notify,
}
impl Dns {
    fn new(paused: bool) -> Arc<Self> {
        Arc::new(Self {
            paused,
            entered: Notify::new(),
            release: Notify::new(),
        })
    }
}
impl Resolver for Dns {
    fn lookup<'a>(&'a self, _: &'a str) -> NetworkFuture<'a, Vec<String>> {
        Box::pin(async move {
            if self.paused {
                self.entered.notify_one();
                self.release.notified().await;
            }
            Ok(vec!["93.184.216.34".into()])
        })
    }
}
struct Reply {
    status: u16,
    headers: HeaderMap,
    body: Bytes,
    change: Option<(Arc<State>, WebConfig)>,
}
impl Reply {
    fn text(text: &'static str) -> Self {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("text/plain"),
        );
        Self {
            status: 200,
            headers,
            body: Bytes::from_static(text.as_bytes()),
            change: None,
        }
    }
    fn search() -> Self {
        let mut r = Self::text(
            r#"{"web":{"results":[{"title":"fixture","url":"https://result.test/","description":"source"}]},"results":[{"title":"fixture","url":"https://result.test/","content":"source"}]}"#,
        );
        r.headers.insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("application/json"),
        );
        r
    }
}
struct Stub {
    replies: Mutex<VecDeque<Reply>>,
    calls: Mutex<Vec<(Admitted, NetworkRequest)>>,
}
impl Transport for Stub {
    fn request<'a>(
        &'a self,
        admitted: Admitted,
        request: NetworkRequest,
        _: RequestCancellation,
    ) -> NetworkFuture<'a, TransportResponse> {
        Box::pin(async move {
            lock(&self.calls).push((admitted, request));
            let r = lock(&self.replies)
                .pop_front()
                .expect("Only synthetic fixture responses are permitted");
            if let Some((state, config)) = r.change {
                state.replace(config, "fixture-new-key");
            }
            Ok(TransportResponse {
                status: r.status,
                headers: r.headers,
                body: Some(Box::pin(futures_util::stream::iter(vec![Ok(r.body)]))),
            })
        })
    }
}
fn fixture(
    state: Arc<State>,
    dns: Arc<Dns>,
    replies: Vec<Reply>,
) -> (WebHost, NativeNetwork, Arc<Stub>) {
    let transport = Arc::new(Stub {
        replies: Mutex::new(replies.into()),
        calls: Mutex::default(),
    });
    let network = NativeNetwork::with_components(NetworkPolicy::default(), dns, transport.clone());
    (
        WebHost::with_state(state, network.clone(), None, None),
        network,
        transport,
    )
}
async fn settle(task: EffectTask) -> Result<EffectResult, EffectError> {
    match task {
        EffectTask::Ready(v) => Ok(v),
        EffectTask::ReadyWithAuxiliary(_, _) => panic!("WebHost cannot schedule auxiliary effects"),
        EffectTask::Async(f) => f.await,
    }
}
fn start(host: &WebHost, session: &str, name: &str, args: Value) -> EffectTask {
    host.start_for(session, RequestCancellation::new(), name, args)
        .unwrap()
}
fn page() -> Value {
    json!({"url":"https://fixture.test/article","max_tokens":1200})
}
fn search() -> Value {
    json!({"query":"fixture only"})
}

#[tokio::test]
async fn shared_page_cache_survives_turns_and_offline_reads_but_not_disabled_tools() {
    let (host, net, transport) = fixture(
        State::new(),
        Dns::new(false),
        vec![Reply::text("fixture page")],
    );
    let first = settle(start(&host, "a", "web_fetch", page()))
        .await
        .unwrap();
    net.update_policy(NetworkPolicy {
        revision: 1,
        mode: NetworkMode::Offline,
        internet_tools: true,
    });
    let second = settle(start(&host, "b", "web_fetch", page()))
        .await
        .unwrap();
    assert_eq!(first.value, second.value);
    assert_eq!(lock(&transport.calls).len(), 1);
    net.update_policy(NetworkPolicy {
        revision: 2,
        mode: NetworkMode::Offline,
        internet_tools: false,
    });
    let denied = settle(start(&host, "b", "web_fetch", page()))
        .await
        .unwrap_err();
    assert_eq!(denied.error["status"], 403);
    assert_eq!(
        denied.error["message"],
        "インターネットを使う道具が許可されていません。"
    );
    assert_eq!(lock(&transport.calls).len(), 1);
    assert_eq!(host.active_count(), 0);
}

#[tokio::test]
async fn queued_old_binding_cannot_dispatch_after_atomic_settings_and_key_change() {
    let state = State::new();
    state.replace(
        WebConfig {
            provider: "brave".into(),
            ..Default::default()
        },
        "fixture-old-key",
    );
    let (host, _, transport) = fixture(state.clone(), Dns::new(false), vec![Reply::search()]);
    let old = start(&host, "a", "web_search", search());
    state.replace(
        WebConfig {
            provider: "searxng".into(),
            searxng_url: "https://new-fixture.test/".into(),
            ..Default::default()
        },
        "fixture-new-key",
    );
    // No notification: the per-admission state guard alone must reject this.
    let error = settle(old).await.unwrap_err();
    assert_eq!(error.error["status"], 409);
    assert_eq!(error.error["notExecuted"], true);
    assert!(lock(&transport.calls).is_empty());
    settle(start(&host, "a", "web_search", search()))
        .await
        .unwrap();
    let calls = lock(&transport.calls);
    assert_eq!(calls.len(), 1);
    assert!(calls[0]
        .0
        .url
        .as_str()
        .starts_with("https://new-fixture.test/"));
    assert!(!calls[0].1.headers.contains_key("x-subscription-token"));
    assert_eq!(host.active_count(), 0);
}

#[tokio::test]
async fn acknowledged_key_rotation_cancels_paused_dns_before_transport() {
    let state = State::new();
    state.replace(
        WebConfig {
            provider: "brave".into(),
            ..Default::default()
        },
        "fixture-old-key",
    );
    let dns = Dns::new(true);
    let (host, net, transport) = fixture(state.clone(), dns.clone(), vec![]);
    let task = start(&host, "a", "web_search", search());
    let pending = tokio::spawn(settle(task));
    tokio::time::timeout(std::time::Duration::from_secs(2), dns.entered.notified())
        .await
        .unwrap();
    state.replace(
        WebConfig {
            provider: "brave".into(),
            ..Default::default()
        },
        "fixture-new-key",
    );
    host.invalidate();
    dns.release.notify_one();
    let error = pending.await.unwrap().unwrap_err();
    assert_eq!(error.error["status"], 409);
    assert!(lock(&transport.calls).is_empty());
    assert_eq!(host.active_count(), 0);
    assert_eq!(net.active_count(), 0);
}

#[tokio::test]
async fn snapshot_change_during_dns_blocks_dispatch_without_invalidation_notification() {
    let state = State::new();
    state.replace(
        WebConfig {
            provider: "brave".into(),
            ..Default::default()
        },
        "fixture-old-key",
    );
    let dns = Dns::new(true);
    let (host, network, transport) = fixture(state.clone(), dns.clone(), vec![]);
    let pending = tokio::spawn(settle(start(&host, "a", "web_search", search())));
    tokio::time::timeout(std::time::Duration::from_secs(2), dns.entered.notified())
        .await
        .unwrap();
    state.replace(
        WebConfig {
            provider: "brave".into(),
            ..Default::default()
        },
        "fixture-new-key",
    );
    // Deliberately omit invalidate: a committed snapshot may change before its
    // owner reaches the explicit notification. The dispatch guard must close
    // that window rather than transmitting the captured credential.
    dns.release.notify_one();
    let error = tokio::time::timeout(std::time::Duration::from_secs(2), pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.error["status"], 409);
    assert!(lock(&transport.calls).is_empty());
    assert_eq!(host.active_count(), 0);
    assert_eq!(network.active_count(), 0);
}

#[tokio::test]
async fn current_guard_runs_again_before_every_redirect_hop() {
    let state = State::new();
    state.replace(
        WebConfig {
            provider: "brave".into(),
            ..Default::default()
        },
        "fixture-old-key",
    );
    let mut redirect = Reply::text("");
    redirect.status = 302;
    redirect.headers.insert(
        header::LOCATION,
        header::HeaderValue::from_static("https://next-fixture.test/search"),
    );
    redirect.change = Some((
        state.clone(),
        WebConfig {
            provider: "searxng".into(),
            searxng_url: "https://new-fixture.test/".into(),
            ..Default::default()
        },
    ));
    let (host, net, transport) = fixture(state, Dns::new(false), vec![redirect]);
    let error = settle(start(&host, "a", "web_search", search()))
        .await
        .unwrap_err();
    assert_eq!(error.error["status"], 409);
    assert_eq!(lock(&transport.calls).len(), 1);
    assert_eq!(host.active_count(), 0);
    assert_eq!(net.active_count(), 0);
}

#[tokio::test]
async fn stop_session_isolated_from_other_session_and_shared_binding() {
    let (host, _, transport) = fixture(
        State::new(),
        Dns::new(false),
        vec![Reply::text("fixture page")],
    );
    let a = start(&host, "a", "web_fetch", page());
    let b = start(&host, "b", "web_fetch", page());
    host.cancel_session("a");
    let error = settle(a).await.unwrap_err();
    assert!(error.aborted);
    assert_eq!(error.error["notExecuted"], true);
    settle(b).await.unwrap();
    assert_eq!(lock(&transport.calls).len(), 1);
    assert_eq!(host.active_count(), 0);
}

#[tokio::test]
async fn cancellation_close_and_dropped_futures_release_all_leases() {
    let (host, _, transport) = fixture(State::new(), Dns::new(false), vec![]);
    let cancelled = RequestCancellation::new();
    cancelled.cancel();
    assert!(
        host.start_for("a", cancelled, "web_fetch", page())
            .err()
            .unwrap()
            .aborted
    );
    let task = start(&host, "a", "web_fetch", page());
    assert_eq!(host.active_count(), 1);
    drop(task);
    assert_eq!(host.active_count(), 0);
    let task = start(&host, "a", "web_fetch", page());
    host.close();
    assert_eq!(settle(task).await.unwrap_err().error["status"], 409);
    assert_eq!(
        host.start_for("a", RequestCancellation::new(), "web_fetch", page())
            .err()
            .unwrap()
            .error["status"],
        503
    );
    assert!(lock(&transport.calls).is_empty());
    assert_eq!(host.active_count(), 0);
}

#[tokio::test]
async fn explicit_invalidation_replaces_cache_and_uses_rotated_key_snapshot() {
    let state = State::new();
    state.replace(
        WebConfig {
            provider: "brave".into(),
            ..Default::default()
        },
        "fixture-old-key",
    );
    let (host, _, transport) = fixture(
        state.clone(),
        Dns::new(false),
        vec![Reply::search(), Reply::search()],
    );
    settle(start(&host, "a", "web_search", search()))
        .await
        .unwrap();
    state.replace(
        WebConfig {
            provider: "brave".into(),
            ..Default::default()
        },
        "fixture-new-key",
    );
    host.invalidate();
    settle(start(&host, "b", "web_search", search()))
        .await
        .unwrap();
    let calls = lock(&transport.calls);
    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[0].1.headers["x-subscription-token"],
        "fixture-old-key"
    );
    assert_eq!(
        calls[1].1.headers["x-subscription-token"],
        "fixture-new-key"
    );
    assert_eq!(host.active_count(), 0);
}

/// DNS remains deterministic, while the production transport must connect to
/// the exact admitted loopback address and preserve the original HTTP Host.
struct LoopbackDns {
    allowed: Vec<&'static str>,
    addresses: Vec<String>,
    calls: Mutex<Vec<String>>,
}
impl Resolver for LoopbackDns {
    fn lookup<'a>(&'a self, host: &'a str) -> NetworkFuture<'a, Vec<String>> {
        Box::pin(async move {
            assert!(
                self.allowed.contains(&host),
                "Unexpected DNS lookup: {host}"
            );
            lock(&self.calls).push(host.to_owned());
            Ok(self.addresses.clone())
        })
    }
}
async fn serve_checked_page(
    listener: tokio::net::TcpListener,
    status: u16,
    headers: String,
    body: &'static str,
) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    tokio::time::timeout(std::time::Duration::from_secs(5), async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut part = [0u8; 1024];
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = socket.read(&mut part).await.unwrap();
            assert!(n > 0, "Request closed before headers were complete");
            request.extend_from_slice(&part[..n]);
            assert!(request.len() <= 16 * 1024, "Unbounded fixture request");
        }
        let response = format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
        String::from_utf8(request).unwrap()
    })
    .await
    .expect("Checked loopback fixture timed out")
}

#[tokio::test]
async fn checked_http_dns_redirect_extraction_and_cache_use_real_loopback_sockets() {
    use crate::network::CheckedTransport;
    use tokio::net::TcpListener;
    let first = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let first_port = first.local_addr().unwrap().port();
    let second_port = second.local_addr().unwrap().port();
    let url = format!("http://checked-first.test:{first_port}/start");
    let final_url = format!("http://checked-second.test:{second_port}/article");
    let dns = Arc::new(LoopbackDns {
        allowed: vec!["checked-first.test", "checked-second.test"],
        addresses: vec!["127.0.0.1".into()],
        calls: Mutex::default(),
    });
    // WebTool permits device destinations with internet tools enabled. No
    // public-web exception, production policy bypass, or live DNS is used.
    let network = NativeNetwork::with_components(
        NetworkPolicy::default(),
        dns.clone(),
        Arc::new(CheckedTransport::default()),
    );
    let host = WebHost::with_state(State::new(), network.clone(), None, None);
    let redirect = tokio::spawn(serve_checked_page(
        first,
        302,
        format!("Location: {final_url}\r\n"),
        "",
    ));
    let page = tokio::spawn(serve_checked_page(
        second,
        200,
        "Content-Type: text/html; charset=utf-8\r\n".into(),
        "<html><head><title>Checked fixture</title></head><body><article><h1>Loopback evidence</h1><p>Checked DNS and HTTP reached this page.</p><script>fixture_script_must_not_appear()</script></article></body></html>",
    ));
    let args = json!({"url":url,"max_tokens":1200});
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        settle(start(&host, "first-session", "web_fetch", args.clone())),
    )
    .await
    .unwrap()
    .unwrap();
    let text = result.value["result"]["text"].as_str().unwrap();
    assert!(text.contains("Checked DNS and HTTP reached this page."));
    assert!(!text.contains("fixture_script_must_not_appear"));
    assert_eq!(result.value["result"]["data"]["url"], final_url);
    let first_request = redirect.await.unwrap().to_ascii_lowercase();
    let second_request = page.await.unwrap().to_ascii_lowercase();
    assert!(first_request.starts_with("get /start http/1.1\r\n"));
    assert!(second_request.starts_with("get /article http/1.1\r\n"));
    assert!(first_request.contains(&format!("host: checked-first.test:{first_port}\r\n")));
    assert!(second_request.contains(&format!("host: checked-second.test:{second_port}\r\n")));
    assert_eq!(
        *lock(&dns.calls),
        vec!["checked-first.test", "checked-second.test"]
    );
    assert_eq!(host.active_count(), 0);
    assert_eq!(network.active_count(), 0);
    network.update_policy(NetworkPolicy {
        revision: 1,
        mode: NetworkMode::Offline,
        internet_tools: true,
    });
    let cached = settle(start(&host, "second-session", "web_fetch", args))
        .await
        .unwrap();
    assert_eq!(cached.value, result.value);
    assert_eq!(
        lock(&dns.calls).len(),
        2,
        "Cached page must not resolve again"
    );
    assert_eq!(host.active_count(), 0);
    assert_eq!(network.active_count(), 0);
    host.close();
    network.close();
}

#[tokio::test]
async fn checked_http_rejects_mixed_reserved_dns_before_any_loopback_connection() {
    use crate::network::CheckedTransport;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let dns = Arc::new(LoopbackDns {
        allowed: vec!["checked-blocked.test"],
        addresses: vec!["127.0.0.1".into(), "169.254.169.254".into()],
        calls: Mutex::default(),
    });
    let network = NativeNetwork::with_components(
        NetworkPolicy::default(),
        dns.clone(),
        Arc::new(CheckedTransport::default()),
    );
    let host = WebHost::with_state(State::new(), network.clone(), None, None);
    let error = settle(start(
        &host,
        "blocked-session",
        "web_fetch",
        json!({"url":format!("http://checked-blocked.test:{port}/article")}),
    ))
    .await
    .unwrap_err();
    assert_eq!(error.error["status"], 403);
    assert_eq!(*lock(&dns.calls), vec!["checked-blocked.test"]);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), listener.accept())
            .await
            .is_err(),
        "No socket may open when any DNS answer is reserved"
    );
    assert_eq!(host.active_count(), 0);
    assert_eq!(network.active_count(), 0);
    host.close();
    network.close();
}
