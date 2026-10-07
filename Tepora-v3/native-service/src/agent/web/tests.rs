use super::*;
use crate::network::{
    Admitted, NetworkFuture, NetworkMode, NetworkPolicy, Resolver, Transport, TransportResponse,
};
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
fn canonical(v: &Value) -> Value {
    json_codec::parse(&stringify_js(v).unwrap()).unwrap()
}
fn document(v: &Value) -> WebDocument {
    WebDocument {
        url: v["url"].as_str().unwrap().into(),
        title: v["title"].as_str().unwrap().into(),
        content_type: v["type"].as_str().unwrap().into(),
        text: v["text"].as_str().unwrap().into(),
        at: v["at"].as_i64().unwrap(),
    }
}
#[test]
fn frozen_parts_focus_and_charset_source_cases() {
    let cases = json_codec::parse(include_str!("fixtures/source.json")).unwrap();
    for c in cases["pages"].as_array().unwrap() {
        assert_eq!(
            canonical(
                &page_part(
                    &document(&c["doc"]),
                    c["offset"].as_f64().unwrap(),
                    c["budget"].as_f64().unwrap(),
                    16
                )
                .unwrap()
            ),
            c["expected"]
        );
    }
    for c in cases["focuses"].as_array().unwrap() {
        let sections = c["sections"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().into())
            .collect::<Vec<_>>();
        let scores = c["scores"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            canonical(
                &focus_sections(
                    &sections,
                    &scores,
                    c["method"].as_str().unwrap(),
                    c["maxTokens"].as_f64().unwrap(),
                    16
                )
                .unwrap()
            ),
            c["expected"]
        );
    }
    // Windows-1252 differences from regressed Node22 are deliberately tested
    // against current Node separately once the documented correction is enabled.
    for c in cases["decodes"].as_array().unwrap() {
        let bytes = c["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect::<Vec<_>>();
        let typ = c["type"].as_str().unwrap();
        let expected = c["expected"].as_str().unwrap();
        if c["canonical"] == "windows-1252" {
            continue;
        }
        assert_eq!(decode_text(&bytes, typ), expected, "{typ}");
    }
}
struct StaticResolver;
impl Resolver for StaticResolver {
    fn lookup<'a>(&'a self, _: &'a str) -> NetworkFuture<'a, Vec<String>> {
        Box::pin(async { Ok(vec!["93.184.216.34".into()]) })
    }
}
#[derive(Clone)]
struct Spec {
    status: u16,
    headers: HeaderMap,
    body: Bytes,
}
impl Spec {
    fn text(status: u16, typ: &str, body: impl Into<Bytes>) -> Self {
        let mut headers = HeaderMap::new();
        if !typ.is_empty() {
            headers.insert(
                header::CONTENT_TYPE,
                header::HeaderValue::from_str(typ).unwrap(),
            );
        }
        Self {
            status,
            headers,
            body: body.into(),
        }
    }
    fn redirect(url: &str) -> Self {
        let mut s = Self::text(302, "", "");
        s.headers.insert(
            header::LOCATION,
            header::HeaderValue::from_str(url).unwrap(),
        );
        s
    }
}
struct Stub {
    queue: Mutex<VecDeque<Spec>>,
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
            self.calls.lock().unwrap().push((admitted, request));
            let response = self
                .queue
                .lock()
                .unwrap()
                .pop_front()
                .expect("No actual web access is allowed in these fixtures");
            Ok(TransportResponse {
                status: response.status,
                headers: response.headers,
                body: Some(Box::pin(futures_util::stream::iter(vec![
                    Ok(response.body),
                ]))),
            })
        })
    }
}
fn fixture(specs: Vec<Spec>) -> (NativeNetwork, Arc<Stub>) {
    let stub = Arc::new(Stub {
        queue: Mutex::new(specs.into()),
        calls: Mutex::new(vec![]),
    });
    (
        NativeNetwork::with_components(
            NetworkPolicy::default(),
            Arc::new(StaticResolver),
            stub.clone(),
        ),
        stub,
    )
}
fn tools(network: NativeNetwork, config: WebConfig, keys: SecretSnapshot) -> WebTools {
    WebTools::new(network, config, keys, None, None, 16)
}
struct Clock(AtomicI64);
impl WebClock for Clock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}
#[tokio::test]
async fn brave_searxng_ddg_shapes_fallback_query_encoding_and_headers() {
    let (net, stub) = fixture(vec![
        Spec::text(503, "text/plain", "down"),
        Spec::text(
            200,
            "application/json",
            r#"{"results":[{"title":"Searx","url":"https://result.test/","content":"snippet","publishedDate":"today"}]}"#,
        ),
    ]);
    let web = tools(
        net,
        WebConfig {
            searxng_url: "http://127.0.0.1:9999/".into(),
            ..WebConfig::default()
        },
        SecretSnapshot::new("fixture-not-a-real-key"),
    );
    let out = web
        .execute(
            "web_search",
            &json!({"query":"日本語 a&b","count":1}),
            &RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(out["data"], json!({"provider":"searxng","count":1}));
    assert!(out["text"]
        .as_str()
        .unwrap()
        .contains("brave: Brave Search HTTP 503"));
    let calls = stub.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert!(calls[0]
        .0
        .url
        .as_str()
        .contains("q=%E6%97%A5%E6%9C%AC%E8%AA%9E%20a%26b&count=1"));
    assert_eq!(
        calls[0].1.headers["x-subscription-token"],
        "fixture-not-a-real-key"
    );
    assert!(calls[0].1.headers["x-subscription-token"].is_sensitive());
    assert!(calls.iter().all(|c| c.0.purpose == Purpose::WebTool));
    drop(calls);
    let (net, stub) = fixture(vec![Spec::text(
        200,
        "application/json",
        r#"{"web":{"results":[{"title":"B","url":"https://b.test/","description":"<b>exact</b> &amp;","age":"1 day"}]}}"#,
    )]);
    let out = tools(
        net,
        WebConfig::default(),
        SecretSnapshot::new("fixture-key"),
    )
    .search("a", 8, &RequestCancellation::new())
    .await
    .unwrap();
    assert_eq!(
        out.results[0],
        json!({"title":"B","url":"https://b.test/","snippet":"exact &amp;","age":"1 day"})
    );
    assert_eq!(stub.calls.lock().unwrap().len(), 1);
    let html = r#"<div class="result"><a class="result__a" href="//result.test/x">One</a><div class="result__snippet">Exact</div></div>"#;
    let (net, stub) = fixture(vec![Spec::text(200, "text/html", html)]);
    let out = tools(net, WebConfig::default(), SecretSnapshot::default())
        .search("a b", 8, &RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(out.provider, "duckduckgo");
    let calls = stub.calls.lock().unwrap();
    assert_eq!(calls[0].1.method, Method::POST);
    assert_eq!(calls[0].1.body.as_ref(), b"q=a%20b&kl=jp-jp");
}
#[tokio::test]
async fn empty_last_provider_without_browser_is_real_empty_success() {
    let (net, stub) = fixture(vec![Spec::text(200, "text/html", "No results")]);
    let out = tools(net, WebConfig::default(), SecretSnapshot::default())
        .execute(
            "web_search",
            &json!({"query":"none"}),
            &RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        out,
        json!({"text":"No results (duckduckgo).","data":{"provider":"duckduckgo","count":0}})
    );
    assert_eq!(stub.calls.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn redirects_recheck_purpose_strip_credentials_and_bound_hops_and_body() {
    let (net, stub) = fixture(vec![
        Spec::redirect("http://127.0.0.1:9999/next"),
        Spec::text(200, "text/plain", "done"),
    ]);
    let mut options = FetchOptions::default();
    options.method = Method::POST;
    options.body = Bytes::from_static(b"posted");
    for k in [
        "authorization",
        "cookie",
        "x-subscription-token",
        "x-api-key",
    ] {
        options.headers.insert(
            header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
            header::HeaderValue::from_static("fixture-dummy"),
        );
    }
    let (r, url) = fetch_following(
        &net,
        "http://127.0.0.1:8888/start",
        options,
        &RequestCancellation::new(),
    )
    .await
    .unwrap();
    assert_eq!(url, "http://127.0.0.1:9999/next");
    assert_eq!(r.bytes().await.unwrap().as_ref(), b"done");
    let calls = stub.calls.lock().unwrap();
    assert_eq!(calls[1].1.method, Method::GET);
    assert!(calls[1].1.body.is_empty());
    assert!(!calls[1].1.headers.contains_key("authorization"));
    assert!(!calls[1].1.headers.contains_key("x-subscription-token"));
    assert!(calls.iter().all(|c| c.0.purpose == Purpose::WebTool));
    drop(calls);
    assert_eq!(net.active_count(), 0);
    let (net, stub) = fixture(vec![Spec::redirect("http://169.254.169.254/metadata")]);
    let e = fetch_following(
        &net,
        "http://127.0.0.1/start",
        FetchOptions::default(),
        &RequestCancellation::new(),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(e.error["blocked"], true);
    assert_eq!(stub.calls.lock().unwrap().len(), 1);
    let (net, stub) = fixture((0..6).map(|_| Spec::redirect("/again")).collect());
    let e = fetch_following(
        &net,
        "http://127.0.0.1/start",
        FetchOptions::default(),
        &RequestCancellation::new(),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(e.error["message"], "Too many redirects");
    assert_eq!(stub.calls.lock().unwrap().len(), 6);
    let (net, _) = fixture(vec![Spec::text(200, "text/plain", "1234")]);
    let (r, _) = fetch_following(
        &net,
        "http://127.0.0.1/",
        FetchOptions {
            max_bytes: 3,
            ..FetchOptions::default()
        },
        &RequestCancellation::new(),
    )
    .await
    .unwrap();
    assert!(r.bytes().await.is_err());
}
#[tokio::test]
async fn page_cache_ttl_offline_reads_and_explicit_tool_denial() {
    let (net, stub) = fixture(vec![
        Spec::text(
            200,
            "text/html",
            "<title>T</title><meta name='description' content='desc'><p>body</p>",
        ),
        Spec::text(200, "text/plain", "new"),
    ]);
    let clock = Arc::new(Clock(AtomicI64::new(0)));
    let web = tools(net.clone(), WebConfig::default(), SecretSnapshot::default())
        .with_clock(clock.clone());
    let doc = web
        .page("https://page.test/", false, &RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(doc.text, "> desc\n\nT\n\nbody");
    assert_eq!(doc.title, "T");
    net.update_policy(NetworkPolicy {
        revision: 1,
        mode: NetworkMode::Offline,
        internet_tools: true,
    });
    clock.0.store(599999, Ordering::SeqCst);
    assert_eq!(
        web.page("https://page.test/", false, &RequestCancellation::new())
            .await
            .unwrap()
            .text,
        doc.text
    );
    assert_eq!(stub.calls.lock().unwrap().len(), 1);
    net.update_policy(NetworkPolicy {
        revision: 2,
        mode: NetworkMode::Offline,
        internet_tools: false,
    });
    assert!(web
        .page("https://page.test/", false, &RequestCancellation::new())
        .await
        .is_err());
    assert_eq!(stub.calls.lock().unwrap().len(), 1);
    net.update_policy(NetworkPolicy {
        revision: 3,
        mode: NetworkMode::Online,
        internet_tools: true,
    });
    clock.0.store(600000, Ordering::SeqCst);
    assert_eq!(
        web.page("https://page.test/", false, &RequestCancellation::new())
            .await
            .unwrap()
            .text,
        "new"
    );
    assert_eq!(stub.calls.lock().unwrap().len(), 2);
}
struct CancellingClock {
    cancel: RequestCancellation,
}
impl WebClock for CancellingClock {
    fn now_ms(&self) -> i64 {
        self.cancel.cancel();
        1
    }
}
#[tokio::test]
async fn cancellation_prevents_late_cache_publication() {
    let (net, stub) = fixture(vec![
        Spec::text(200, "text/plain", "one"),
        Spec::text(200, "text/plain", "two"),
    ]);
    let cancel = RequestCancellation::new();
    let web = tools(net, WebConfig::default(), SecretSnapshot::default()).with_clock(Arc::new(
        CancellingClock {
            cancel: cancel.clone(),
        },
    ));
    assert!(
        web.page("https://page.test/", false, &cancel)
            .await
            .unwrap_err()
            .aborted
    );
    assert!(web.cache.lock().unwrap().pages.is_empty());
    assert_eq!(
        web.page("https://page.test/", false, &RequestCancellation::new())
            .await
            .unwrap()
            .text,
        "two"
    );
    assert_eq!(stub.calls.lock().unwrap().len(), 2);
}
#[tokio::test]
async fn cache_is_sixty_four_fifo_entries_not_lru() {
    let (net, stub) = fixture(
        (0..66)
            .map(|i| Spec::text(200, "text/plain", format!("v{i}")))
            .collect(),
    );
    let web = tools(net, WebConfig::default(), SecretSnapshot::default());
    for i in 0..65 {
        web.page(
            &format!("https://page.test/{i}"),
            false,
            &RequestCancellation::new(),
        )
        .await
        .unwrap();
    }
    assert_eq!(web.cache.lock().unwrap().pages.len(), 64);
    assert_eq!(
        web.page("https://page.test/1", false, &RequestCancellation::new())
            .await
            .unwrap()
            .text,
        "v1"
    );
    assert_eq!(stub.calls.lock().unwrap().len(), 65);
    assert_eq!(
        web.page("https://page.test/0", false, &RequestCancellation::new())
            .await
            .unwrap()
            .text,
        "v65"
    );
}
struct Browser {
    calls: AtomicUsize,
}
impl BrowserRenderer for Browser {
    fn render<'a>(&'a self, r: BrowserRenderRequest) -> BrowserFuture<'a> {
        Box::pin(async move {
            check_cancel(&r.cancellation)?;
            assert_eq!(r.purpose, Purpose::WebTool);
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(RenderedPage {
                html: "<p>rendered</p>".into(),
                url: r.url,
            })
        })
    }
}
#[tokio::test]
async fn browser_is_explicit_and_never_bypasses_policy_denial() {
    let (net, _) = fixture(vec![]);
    let web = tools(net.clone(), WebConfig::default(), SecretSnapshot::default());
    assert_eq!(
        web.page("https://x.test/", true, &RequestCancellation::new())
            .await
            .unwrap_err()
            .error["status"],
        409
    );
    let browser = Arc::new(Browser {
        calls: AtomicUsize::new(0),
    });
    let web = WebTools::new(
        net.clone(),
        WebConfig {
            provider: "searxng".into(),
            searxng_url: "http://169.254.169.254/".into(),
            ..WebConfig::default()
        },
        SecretSnapshot::default(),
        Some(browser.clone()),
        None,
        16,
    );
    assert!(web
        .search("a", 8, &RequestCancellation::new())
        .await
        .is_err());
    assert_eq!(browser.calls.load(Ordering::SeqCst), 0);
    net.update_policy(NetworkPolicy {
        revision: 1,
        mode: NetworkMode::Offline,
        internet_tools: true,
    });
    assert!(web
        .page("https://x.test/", true, &RequestCancellation::new())
        .await
        .is_err());
    assert_eq!(browser.calls.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn rejects_pdf_binary_and_status_without_fabricating_page_text() {
    for (status, typ, expected) in [
        (200, "application/pdf", 415),
        (200, "image/png", 415),
        (503, "text/plain", 502),
    ] {
        let (net, _) = fixture(vec![Spec::text(status, typ, "data")]);
        assert_eq!(
            tools(net, WebConfig::default(), SecretSnapshot::default())
                .page("http://127.0.0.1/", false, &RequestCancellation::new())
                .await
                .unwrap_err()
                .error["status"],
            expected
        );
    }
}
async fn serve_once(
    listener: TcpListener,
    status: u16,
    extra: String,
    body: &'static str,
) -> String {
    let (mut socket, _) = listener.accept().await.unwrap();
    let mut buffer = Vec::new();
    let mut part = [0u8; 1024];
    while !buffer.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = socket.read(&mut part).await.unwrap();
        assert!(n > 0);
        buffer.extend_from_slice(&part[..n]);
    }
    let out = format!(
        "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",
        body.len()
    );
    socket.write_all(out.as_bytes()).await.unwrap();
    String::from_utf8_lossy(&buffer).into_owned()
}
#[tokio::test]
async fn actual_loopback_redirect_never_forwards_dummy_credentials() {
    let first = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", first.local_addr().unwrap());
    let next = format!("http://{}/final", second.local_addr().unwrap());
    let a = tokio::spawn(serve_once(first, 302, format!("Location: {next}\r\n"), ""));
    let b = tokio::spawn(serve_once(
        second,
        200,
        "Content-Type: text/plain\r\n".into(),
        "local response",
    ));
    let net = NativeNetwork::new(NetworkPolicy::default());
    let mut options = FetchOptions::default();
    options.headers.insert(
        header::AUTHORIZATION,
        header::HeaderValue::from_static("Bearer fixture-only"),
    );
    options.headers.insert(
        "x-subscription-token",
        header::HeaderValue::from_static("fixture-only"),
    );
    options.headers.insert(
        header::COOKIE,
        header::HeaderValue::from_static("fixture=only"),
    );
    let (response, final_url) = fetch_following(&net, &url, options, &RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(final_url, next);
    assert_eq!(response.text().await.unwrap(), "local response");
    let first = a.await.unwrap().to_ascii_lowercase();
    let second = b.await.unwrap().to_ascii_lowercase();
    assert!(first.contains("authorization:"));
    assert!(!second.contains("authorization:"));
    assert!(!second.contains("x-subscription-token:"));
    assert!(!second.contains("cookie:"));
    assert_eq!(net.active_count(), 0);
}

#[test]
fn current_node_charset_vectors_and_documented_windows1252_correction() {
    let current = json_codec::parse(include_str!("fixtures/decodes-current.json")).unwrap();
    for c in current["decodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["canonical"] == "windows-1252")
    {
        let bytes = c["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect::<Vec<_>>();
        assert_eq!(
            decode_text(&bytes, c["type"].as_str().unwrap()),
            c["expected"].as_str().unwrap(),
            "{}",
            c["type"]
        );
    }
    let baseline = json_codec::parse(include_str!("fixtures/source.json")).unwrap();
    let old = baseline["decodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["type"] == "text/plain; charset=windows-1252")
        .unwrap();
    let new = current["decodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["type"] == "text/plain; charset=windows-1252")
        .unwrap();
    assert_ne!(old["expected"], new["expected"]);
    assert_eq!(new["expected"], "€‘’é");
}

#[tokio::test]
async fn extraction_limit_is_explicit_413_and_never_cached() {
    let html = format!(
        "{}x{}",
        "<blockquote>".repeat(257),
        "</blockquote>".repeat(257)
    );
    let (net, _) = fixture(vec![Spec::text(200, "text/html", html)]);
    let web = tools(net, WebConfig::default(), SecretSnapshot::default());
    let e = web
        .page("http://127.0.0.1/", false, &RequestCancellation::new())
        .await
        .unwrap_err();
    assert_eq!(e.error["status"], 413);
    assert!(web.cache.lock().unwrap().pages.is_empty());
}

struct RevokingClock {
    network: NativeNetwork,
}
impl WebClock for RevokingClock {
    fn now_ms(&self) -> i64 {
        self.network.update_policy(NetworkPolicy {
            revision: 1,
            mode: NetworkMode::Offline,
            internet_tools: true,
        });
        1
    }
}
#[tokio::test]
async fn policy_revision_after_download_prevents_cache_publication() {
    let (net, stub) = fixture(vec![Spec::text(200, "text/plain", "late bytes")]);
    let web = tools(net.clone(), WebConfig::default(), SecretSnapshot::default())
        .with_clock(Arc::new(RevokingClock { network: net }));
    let e = web
        .page("https://page.test/", false, &RequestCancellation::new())
        .await
        .unwrap_err();
    assert_eq!(e.error["status"], 409);
    assert!(web.cache.lock().unwrap().pages.is_empty());
    assert_eq!(stub.calls.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn same_origin_redirect_keeps_credentials_but_307_still_becomes_get() {
    let mut redirect = Spec::redirect("/next");
    redirect.status = 307;
    let (net, stub) = fixture(vec![redirect, Spec::text(200, "text/plain", "okay")]);
    let mut options = FetchOptions::default();
    options.method = Method::POST;
    options.body = Bytes::from_static(b"form");
    options.headers.insert(
        header::AUTHORIZATION,
        header::HeaderValue::from_static("Bearer fixture-only"),
    );
    let (r, _) = fetch_following(
        &net,
        "http://127.0.0.1/start",
        options,
        &RequestCancellation::new(),
    )
    .await
    .unwrap();
    r.bytes().await.unwrap();
    let calls = stub.calls.lock().unwrap();
    assert_eq!(
        calls[1].1.headers[header::AUTHORIZATION],
        "Bearer fixture-only"
    );
    assert_eq!(calls[1].1.method, Method::GET);
    assert!(calls[1].1.body.is_empty());
}

#[tokio::test]
async fn provider_false_results_are_empty_but_null_document_or_item_fails() {
    for (body, okay) in [
        (r#"{"results":false}"#, true),
        (r#"{"results":0}"#, true),
        (r#"{"results":""}"#, true),
        ("null", false),
        (r#"{"results":[null]}"#, false),
    ] {
        let (net, _) = fixture(vec![Spec::text(200, "application/json", body)]);
        let web = tools(
            net,
            WebConfig {
                provider: "searxng".into(),
                searxng_url: "http://127.0.0.1/".into(),
                ..WebConfig::default()
            },
            SecretSnapshot::default(),
        );
        let result = web
            .search_with("searxng", "query", 8, &RequestCancellation::new())
            .await;
        if okay {
            assert!(result.unwrap().results.is_empty());
        } else {
            assert!(result.is_err());
        }
    }
}
