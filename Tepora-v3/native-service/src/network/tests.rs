use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{oneshot, Notify},
};

fn purpose(s: &str) -> Purpose {
    match s {
        "model" => Purpose::Model,
        "vision" => Purpose::Vision,
        "worker" => Purpose::Worker,
        "web" => Purpose::Web,
        "public-web" => Purpose::PublicWeb,
        "web-tool" => Purpose::WebTool,
        "feed" => Purpose::Feed,
        "download" => Purpose::Download,
        _ => panic!("Unknown purpose"),
    }
}
#[test]
fn source_differential_ip_permissions_paths_and_whatwg_urls() {
    let fixture: Value = serde_json::from_str(include_str!("source-fixtures.json")).unwrap();
    for entry in fixture["ip"].as_array().unwrap() {
        assert_eq!(
            ip_domain(entry["ip"].as_str().unwrap()).as_str(),
            entry["domain"].as_str().unwrap(),
            "{entry}"
        );
    }
    for entry in fixture["permissions"].as_array().unwrap() {
        let p=NetworkPolicy::from_value(&serde_json::json!({"revision":0,"mode":entry["mode"],"internetTools":entry["internetTools"]})).unwrap();
        assert_eq!(
            p.permitted(
                Domain::parse(entry["domain"].as_str().unwrap()).unwrap(),
                purpose(entry["purpose"].as_str().unwrap())
            ),
            entry["allowed"].as_bool().unwrap(),
            "{entry}"
        );
    }
    for entry in fixture["paths"].as_array().unwrap() {
        assert_eq!(
            inside_endpoint(
                entry["target"].as_str().unwrap(),
                entry["base"].as_str().unwrap()
            ),
            entry["allowed"].as_bool().unwrap(),
            "{entry}"
        );
    }
    for entry in fixture["urls"].as_array().unwrap() {
        assert_eq!(
            normal_url(
                entry["value"].as_str().unwrap(),
                entry["query"].as_bool().unwrap()
            )
            .ok()
            .map(|v| v.to_string()),
            entry["url"].as_str().map(str::to_owned),
            "{entry}"
        );
    }
}
#[test]
fn defaults_and_invalid_policy_fail_closed() {
    let p = NetworkPolicy::default();
    assert_eq!(p.mode, NetworkMode::Online);
    assert!(p.internet_tools);
    assert_eq!(NetworkPolicy::from_value(&p.value()).unwrap(), p);
    for v in [
        serde_json::json!({"mode":"bad","revision":0,"internetTools":true}),
        serde_json::json!({"mode":"online","revision":0,"internetTools":"yes"}),
    ] {
        assert!(NetworkPolicy::from_value(&v).is_err());
    }
    assert!(!p.permitted(Domain::Reserved, Purpose::Model));
    assert!(!p.permitted(Domain::Name, Purpose::Model));
}
struct Dns {
    answers: Vec<String>,
    calls: AtomicUsize,
}
impl Dns {
    fn new(values: &[&str]) -> Arc<Self> {
        Arc::new(Self {
            answers: values.iter().map(|v| v.to_string()).collect(),
            calls: AtomicUsize::new(0),
        })
    }
}
impl Resolver for Dns {
    fn lookup<'a>(&'a self, _: &'a str) -> NetworkFuture<'a, Vec<String>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.answers.clone())
        })
    }
}
struct FakeTransport {
    seen: Mutex<Vec<(Admitted, RequestCancellation)>>,
    status: u16,
    chunks: Vec<Bytes>,
    delay: Duration,
    pending: bool,
}
impl FakeTransport {
    fn plain(chunks: Vec<Bytes>) -> Arc<Self> {
        Arc::new(Self {
            seen: Mutex::new(vec![]),
            status: 200,
            chunks,
            delay: Duration::ZERO,
            pending: false,
        })
    }
}
impl Transport for FakeTransport {
    fn request<'a>(
        &'a self,
        a: Admitted,
        _: NetworkRequest,
        c: RequestCancellation,
    ) -> NetworkFuture<'a, TransportResponse> {
        Box::pin(async move {
            self.seen.lock().unwrap().push((a, c));
            let delay = self.delay;
            let chunks = self.chunks.clone();
            let pending = self.pending;
            Ok(TransportResponse {
                status: self.status,
                headers: HeaderMap::new(),
                body: Some(Box::pin(
                    async_stream::try_stream! {for chunk in chunks{if !delay.is_zero(){tokio::time::sleep(delay).await;}yield chunk;}if pending{std::future::pending::<()>().await;}},
                )),
            })
        })
    }
}
fn setup(answers: &[&str]) -> (NativeNetwork, Arc<Dns>, Arc<FakeTransport>) {
    let dns = Dns::new(answers);
    let transport = FakeTransport::plain(vec![Bytes::from_static(b"fixture")]);
    let network =
        NativeNetwork::with_components(NetworkPolicy::default(), dns.clone(), transport.clone());
    (network, dns, transport)
}
fn cloud_scope() -> NetworkScope {
    NetworkScope {
        profile: Some(NetworkProfile {
            id: "cloud".into(),
            base_url: "https://models.example/v1".into(),
            domain: Domain::Cloud,
            enabled: true,
            pinned_address: None,
            allow_plain_http: false,
        }),
        ..Default::default()
    }
}
fn offline() -> NetworkPolicy {
    NetworkPolicy {
        revision: 1,
        mode: NetworkMode::Offline,
        internet_tools: true,
    }
}
async fn blocked(result: Result<NetworkResponse, NetworkError>) -> NetworkError {
    match result {
        Err(e) => {
            assert!(e.blocked, "{e}");
            e
        }
        Ok(_) => panic!("Unexpectedly allowed"),
    }
}
#[tokio::test]
async fn offline_blocks_cloud_before_dns_and_localhost_never_resolves() {
    let (network, dns, t) = setup(&["8.8.8.8"]);
    network.update_policy(offline());
    blocked(
        network
            .request(
                "https://models.example/v1",
                NetworkRequest::default(),
                cloud_scope(),
            )
            .await,
    )
    .await;
    assert_eq!(dns.calls.load(Ordering::SeqCst), 0);
    assert!(t.seen.lock().unwrap().is_empty());
    assert_eq!(
        network
            .request(
                "http://localhost:1234/v1",
                NetworkRequest::default(),
                NetworkScope::default()
            )
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "fixture"
    );
    assert_eq!(dns.calls.load(Ordering::SeqCst), 0);
    assert_eq!(t.seen.lock().unwrap()[0].0.address.to_string(), "127.0.0.1");
    assert_eq!(network.active_count(), 0);
}
#[tokio::test]
async fn lan_pin_scope_and_plaintext_are_enforced_without_dns() {
    let (network, dns, t) = setup(&["8.8.8.8"]);
    network.update_policy(NetworkPolicy {
        mode: NetworkMode::TrustedLan,
        ..NetworkPolicy::default()
    });
    let profile = NetworkProfile {
        id: "lan".into(),
        base_url: "http://gpu.lan:8000/v1".into(),
        domain: Domain::Lan,
        enabled: true,
        pinned_address: Some("192.168.1.50".into()),
        allow_plain_http: true,
    };
    let scope = NetworkScope {
        profile: Some(profile.clone()),
        ..Default::default()
    };
    network
        .request(
            "http://gpu.lan:8000/v1/chat/completions",
            NetworkRequest::default(),
            scope.clone(),
        )
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(dns.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        t.seen.lock().unwrap()[0].0.address.to_string(),
        "192.168.1.50"
    );
    for value in [
        "http://gpu.lan:8001/v1",
        "http://gpu.lan:8000/admin",
        "http://gpu.lan:8000/v1/%252e%252e%252fadmin",
    ] {
        blocked(
            network
                .request(value, NetworkRequest::default(), scope.clone())
                .await,
        )
        .await;
    }
    let mut s = scope.clone();
    s.profile.as_mut().unwrap().allow_plain_http = false;
    blocked(
        network
            .request(&profile.base_url, NetworkRequest::default(), s)
            .await,
    )
    .await;
    let mut s = scope.clone();
    s.purpose = Purpose::Web;
    blocked(
        network
            .request(&profile.base_url, NetworkRequest::default(), s)
            .await,
    )
    .await;
    let mut s = scope;
    s.profile.as_mut().unwrap().base_url = "http://192.168.1.51:8000/v1".into();
    blocked(
        network
            .request("http://192.168.1.51:8000/v1", NetworkRequest::default(), s)
            .await,
    )
    .await;
}
#[tokio::test]
async fn cloud_all_answers_must_be_public_and_every_request_resolves_again() {
    for answers in [
        vec!["8.8.8.8", "127.0.0.1"],
        vec!["192.168.0.1"],
        vec!["169.254.169.254"],
        vec!["::ffff:8.8.8.8"],
        vec![],
    ] {
        let (network, _, t) = setup(&answers);
        blocked(
            network
                .request(
                    "https://models.example/v1",
                    NetworkRequest::default(),
                    cloud_scope(),
                )
                .await,
        )
        .await;
        assert!(t.seen.lock().unwrap().is_empty());
    }
    let (network, dns, t) = setup(&["8.8.8.8", "1.1.1.1"]);
    for _ in 0..2 {
        network
            .request(
                "https://models.example/v1",
                NetworkRequest::default(),
                cloud_scope(),
            )
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
    }
    assert_eq!(dns.calls.load(Ordering::SeqCst), 2);
    assert!(t
        .seen
        .lock()
        .unwrap()
        .iter()
        .all(|(a, _)| a.address.to_string() == "8.8.8.8"));
}
#[tokio::test]
async fn mixed_web_tool_dns_is_intentionally_stricter_than_javascript() {
    for mode in [NetworkMode::Offline, NetworkMode::TrustedLan] {
        for answers in [vec!["8.8.8.8", "127.0.0.1"], vec!["127.0.0.1", "8.8.8.8"]] {
            let (network, _, t) = setup(&answers);
            network.update_policy(NetworkPolicy {
                mode,
                ..NetworkPolicy::default()
            });
            blocked(
                network
                    .request(
                        "https://mixed.example/",
                        NetworkRequest::default(),
                        NetworkScope {
                            purpose: Purpose::WebTool,
                            ..Default::default()
                        },
                    )
                    .await,
            )
            .await;
            assert!(t.seen.lock().unwrap().is_empty());
        }
    }
}
#[tokio::test]
async fn policy_narrowing_marks_cloud_cancelled_before_return_but_keeps_device() {
    let transport = Arc::new(FakeTransport {
        seen: Mutex::new(vec![]),
        status: 200,
        chunks: vec![],
        delay: Duration::ZERO,
        pending: true,
    });
    let network = NativeNetwork::with_components(
        NetworkPolicy::default(),
        Dns::new(&["8.8.8.8"]),
        transport.clone(),
    );
    let cloud = network
        .request(
            "https://models.example/v1",
            NetworkRequest::default(),
            cloud_scope(),
        )
        .await
        .unwrap();
    let local = network
        .request(
            "http://localhost/v1",
            NetworkRequest::default(),
            NetworkScope::default(),
        )
        .await
        .unwrap();
    network.update_policy(offline());
    let handles = transport.seen.lock().unwrap();
    assert!(handles[0].1.is_cancelled());
    assert!(!handles[1].1.is_cancelled());
    drop(handles);
    assert!(cloud.bytes().await.unwrap_err().blocked);
    drop(local);
    assert_eq!(network.active_count(), 0);
}
struct SlowDns {
    started: Notify,
    release: Notify,
}
impl Resolver for SlowDns {
    fn lookup<'a>(&'a self, _: &'a str) -> NetworkFuture<'a, Vec<String>> {
        Box::pin(async move {
            self.started.notify_one();
            self.release.notified().await;
            Ok(vec!["8.8.8.8".into()])
        })
    }
}
#[tokio::test]
async fn policy_narrowing_and_close_cancel_pending_dns() {
    for close in [false, true] {
        let dns = Arc::new(SlowDns {
            started: Notify::new(),
            release: Notify::new(),
        });
        let transport = FakeTransport::plain(vec![]);
        let network = NativeNetwork::with_components(
            NetworkPolicy::default(),
            dns.clone(),
            transport.clone(),
        );
        let n = network.clone();
        let task = tokio::spawn(async move {
            n.request(
                "https://models.example/v1",
                NetworkRequest::default(),
                cloud_scope(),
            )
            .await
        });
        dns.started.notified().await;
        if close {
            network.close();
        } else {
            network.update_policy(offline());
        }
        dns.release.notify_one();
        blocked(task.await.unwrap()).await;
        assert!(transport.seen.lock().unwrap().is_empty());
        assert_eq!(network.active_count(), 0);
    }
}
#[tokio::test]
async fn response_budget_drop_redirects_and_gemini_query_scope() {
    let (network, _, _) = setup(&[]);
    let response = network
        .request(
            "http://localhost/v1",
            NetworkRequest::default(),
            NetworkScope {
                max_bytes: 3,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(response.bytes().await.unwrap_err().status, 502);
    assert_eq!(network.active_count(), 0);
    let response = network
        .request(
            "http://localhost/v1",
            NetworkRequest::default(),
            NetworkScope::default(),
        )
        .await
        .unwrap();
    assert_eq!(network.active_count(), 1);
    drop(response);
    assert_eq!(network.active_count(), 0);
    for (query, flag, allowed) in [
        ("alt=sse", true, true),
        ("alt=sse", false, false),
        ("alt=sse&x=1", true, false),
        ("x=1", true, false),
    ] {
        let result = network
            .request(
                &format!("http://localhost/v1?{query}"),
                NetworkRequest::default(),
                NetworkScope {
                    gemini_stream_query: flag,
                    ..Default::default()
                },
            )
            .await;
        assert_eq!(result.is_ok(), allowed, "{query}");
    }
    let t = Arc::new(FakeTransport {
        seen: Mutex::new(vec![]),
        status: 302,
        chunks: vec![],
        delay: Duration::ZERO,
        pending: false,
    });
    let n = NativeNetwork::with_components(NetworkPolicy::default(), Dns::new(&[]), t);
    blocked(
        n.request(
            "http://localhost/v1",
            NetworkRequest::default(),
            NetworkScope::default(),
        )
        .await,
    )
    .await;
    assert_eq!(
        n.request(
            "http://localhost/v1",
            NetworkRequest::default(),
            NetworkScope {
                redirects: true,
                ..Default::default()
            }
        )
        .await
        .unwrap()
        .status,
        302
    );
}
#[tokio::test]
async fn progressive_idle_total_and_caller_cancellation_are_distinct() {
    let t = Arc::new(FakeTransport {
        seen: Mutex::new(vec![]),
        status: 200,
        chunks: vec![Bytes::from_static(b"a"); 6],
        delay: Duration::from_millis(15),
        pending: false,
    });
    let n = NativeNetwork::with_components(NetworkPolicy::default(), Dns::new(&[]), t);
    let progressive = NetworkScope {
        timeout: Duration::from_millis(30),
        first_byte_timeout: Some(Duration::from_millis(60)),
        idle_timeout: Some(Duration::from_millis(60)),
        ..Default::default()
    };
    assert_eq!(
        n.request(
            "http://localhost/v1",
            NetworkRequest::default(),
            progressive.clone()
        )
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap()
        .len(),
        6
    );
    let e = n
        .request(
            "http://localhost/v1",
            NetworkRequest::default(),
            NetworkScope {
                timeout: Duration::from_millis(30),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap_err();
    assert!(e.timeout && !e.idle && !e.cancelled);
    let e = n
        .request(
            "http://localhost/v1",
            NetworkRequest::default(),
            NetworkScope {
                idle_timeout: Some(Duration::from_millis(2)),
                ..progressive.clone()
            },
        )
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap_err();
    assert!(e.timeout && e.idle && !e.cancelled);
    let e = n
        .request(
            "http://localhost/v1",
            NetworkRequest::default(),
            NetworkScope {
                deadline: Some(Duration::from_millis(30)),
                ..progressive
            },
        )
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap_err();
    assert!(e.timeout && !e.idle);
    let c = RequestCancellation::new();
    let response = n
        .request(
            "http://localhost/v1",
            NetworkRequest {
                cancellation: Some(c.clone()),
                ..Default::default()
            },
            NetworkScope::default(),
        )
        .await
        .unwrap();
    c.cancel();
    let e = response.bytes().await.unwrap_err();
    assert!(e.cancelled && !e.timeout && !e.blocked);
    assert_eq!(n.active_count(), 0);
}
#[tokio::test]
async fn json_is_strict_bounded_bom_aware_and_preserves_isolated_surrogates() {
    let t = FakeTransport::plain(vec![Bytes::from_static(b"\xef\xbb\xbf{\"x\":\"\\ud800\"}")]);
    let n = NativeNetwork::with_components(NetworkPolicy::default(), Dns::new(&[]), t);
    let v = n
        .request(
            "http://localhost/",
            NetworkRequest::default(),
            NetworkScope::default(),
        )
        .await
        .unwrap()
        .json(100)
        .await
        .unwrap();
    assert_eq!(
        tepora_core::json_codec::utf16_units(v["x"].as_str().unwrap()),
        vec![0xd800]
    );
    assert!(n
        .request(
            "http://localhost/",
            NetworkRequest::default(),
            NetworkScope::default()
        )
        .await
        .unwrap()
        .json(3)
        .await
        .is_err());
    let t = FakeTransport::plain(vec![Bytes::from_static(b"\xef\xbb\xbf\xff")]);
    let n = NativeNetwork::with_components(NetworkPolicy::default(), Dns::new(&[]), t);
    assert_eq!(
        n.request(
            "http://localhost/",
            NetworkRequest::default(),
            NetworkScope::default()
        )
        .await
        .unwrap()
        .text()
        .await
        .unwrap(),
        "\u{fffd}"
    );
    assert!(n
        .request(
            "http://localhost/",
            NetworkRequest::default(),
            NetworkScope::default()
        )
        .await
        .unwrap()
        .json(100)
        .await
        .is_err());
}
async fn http_fixture(response: Vec<u8>) -> (String, oneshot::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = oneshot::channel();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = vec![];
        loop {
            let mut buf = [0; 1024];
            let n = socket.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            request.extend_from_slice(&buf[..n]);
            if request.windows(4).any(|p| p == b"\r\n\r\n") {
                break;
            }
        }
        let _ = tx.send(String::from_utf8(request).unwrap());
        socket.write_all(&response).await.unwrap();
        socket.shutdown().await.unwrap();
    });
    (format!("http://localhost:{}", address.port()), rx)
}
#[tokio::test]
async fn actual_loopback_socket_overrides_host_accept_encoding_and_framing() {
    let (url, seen) = http_fixture(
        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: text/plain\r\n\r\nok".to_vec(),
    )
    .await;
    let n = NativeNetwork::new(offline());
    let mut request = NetworkRequest::default();
    request
        .headers
        .insert("host", "evil.example".parse().unwrap());
    request
        .headers
        .insert("accept-encoding", "gzip".parse().unwrap());
    request
        .headers
        .insert("proxy-authorization", "never-forward".parse().unwrap());
    let response = n
        .request(
            &(url.clone() + "/v1?x=1"),
            request,
            NetworkScope {
                purpose: Purpose::Web,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(response.text().await.unwrap(), "ok");
    let seen = seen.await.unwrap().to_lowercase();
    assert!(seen.starts_with("get /v1?x=1 http/1.1"));
    assert!(seen.contains(&format!("host: {}", url.strip_prefix("http://").unwrap())));
    assert!(seen.contains("accept-encoding: identity"));
    assert!(!seen.contains("never-forward"));
    assert!(!seen.contains("evil.example"));
    assert_eq!(n.active_count(), 0);
}
#[tokio::test]
async fn actual_transport_rejects_redirect_and_does_not_decompress() {
    let (url, _) = http_fixture(
        b"HTTP/1.1 302 Found\r\nLocation: https://evil.example/\r\nContent-Length: 0\r\n\r\n"
            .to_vec(),
    )
    .await;
    let n = NativeNetwork::new(NetworkPolicy::default());
    blocked(
        n.request(&url, NetworkRequest::default(), NetworkScope::default())
            .await,
    )
    .await;
    let (url, _) = http_fixture(
        b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 3\r\n\r\nraw".to_vec(),
    )
    .await;
    assert_eq!(
        n.request(&url, NetworkRequest::default(), NetworkScope::default())
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap(),
        Bytes::from_static(b"raw")
    );
}
#[tokio::test]
async fn actual_transport_first_byte_timeout_and_close_disconnect_socket() {
    for close in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted, rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0; 1024];
            let n = socket.read(&mut buf).await.unwrap();
            assert!(n > 0);
            let _ = accepted.send(());
            tokio::time::timeout(Duration::from_secs(2), socket.read(&mut buf))
                .await
                .unwrap()
                .unwrap()
        });
        let network = NativeNetwork::new(NetworkPolicy::default());
        let n = network.clone();
        let task = tokio::spawn(async move {
            n.request(
                &format!("http://{address}/v1"),
                NetworkRequest::default(),
                NetworkScope {
                    first_byte_timeout: Some(Duration::from_millis(100)),
                    ..Default::default()
                },
            )
            .await
        });
        rx.await.unwrap();
        if close {
            network.close();
        }
        let error = match task.await.unwrap() {
            Err(e) => e,
            Ok(_) => panic!("Unexpected response"),
        };
        assert_eq!(error.blocked, close);
        assert_eq!(error.idle, !close);
        assert_eq!(server.await.unwrap(), 0);
        assert_eq!(network.active_count(), 0);
    }
}

/// Generate a fresh local test identity at runtime. No key material is stored
/// in source, written to disk, or printed; only public CA PEM enters a temp file.
fn ephemeral_tls_identity() -> (
    tokio_rustls::rustls::pki_types::CertificateDer<'static>,
    tokio_rustls::rustls::pki_types::PrivatePkcs8KeyDer<'static>,
    String,
) {
    let rcgen::CertifiedKey { cert, signing_key } =
        rcgen::generate_simple_self_signed(vec!["localhost".to_owned()])
            .expect("Generate ephemeral TLS test identity");
    let key =
        tokio_rustls::rustls::pki_types::PrivatePkcs8KeyDer::from(signing_key.serialize_der());
    (cert.der().clone(), key, cert.pem())
}
struct TemporaryCaFile(std::path::PathBuf);
impl TemporaryCaFile {
    fn new(public_pem: &str) -> Self {
        use std::io::Write;
        let path =
            std::env::temp_dir().join(format!("tepora-generated-ca-{}.pem", uuid::Uuid::new_v4()));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .expect("Create temporary public CA file");
        file.write_all(public_pem.as_bytes())
            .expect("Write temporary public CA certificate");
        Self(path)
    }
}
impl Drop for TemporaryCaFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[tokio::test]
async fn direct_tls_validates_original_url_hostname_and_certificate() {
    use tokio_rustls::{rustls, TlsAcceptor};
    let (cert, key, pem) = ephemeral_tls_identity();
    let ca_file = TemporaryCaFile::new(&pem);
    for (host, trust, expected) in [
        ("localhost", true, true),
        ("wrong.example", true, false),
        ("localhost", false, false),
    ] {
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert.clone()], key.clone_key().into())
        .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            if let Ok(mut socket) = acceptor.accept(socket).await {
                let mut buf = [0; 4096];
                if socket.read(&mut buf).await.unwrap_or(0) > 0 {
                    let _ = socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                        .await;
                    let _ = socket.shutdown().await;
                }
            }
        });
        let transport = if trust {
            CheckedTransport::from_extra_ca_file(Some(&ca_file.0))
        } else {
            CheckedTransport::from_extra_ca_file(None)
        };
        // Exercise only the transport seam with a loopback destination; policy
        // never grants a production cloud request this test-only private target.
        let admitted = Admitted {
            url: Url::parse(&format!("https://{host}:{}/v1", address.port())).unwrap(),
            address: address.ip(),
            domain: Domain::Cloud,
            purpose: Purpose::Model,
            profile_id: None,
            domains: vec![Domain::Cloud],
        };
        let result = transport
            .request(
                admitted,
                NetworkRequest::default(),
                RequestCancellation::new(),
            )
            .await;
        assert_eq!(result.is_ok(), expected, "host={host}, trust={trust}");
        if let Ok(mut response) = result {
            let mut body = response.body.take().unwrap();
            assert_eq!(
                body.next().await.unwrap().unwrap(),
                Bytes::from_static(b"ok")
            );
        }
        server.await.unwrap();
    }
}

struct RebindingDns(AtomicUsize);
impl Resolver for RebindingDns {
    fn lookup<'a>(&'a self, _: &'a str) -> NetworkFuture<'a, Vec<String>> {
        Box::pin(async move {
            Ok(vec![if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
                "8.8.8.8"
            } else {
                "127.0.0.1"
            }
            .into()])
        })
    }
}
#[tokio::test]
async fn rebinding_on_subsequent_request_is_rejected() {
    let t = FakeTransport::plain(vec![]);
    let n = NativeNetwork::with_components(
        NetworkPolicy::default(),
        Arc::new(RebindingDns(AtomicUsize::new(0))),
        t.clone(),
    );
    n.request(
        "https://models.example/v1",
        NetworkRequest::default(),
        cloud_scope(),
    )
    .await
    .unwrap()
    .bytes()
    .await
    .unwrap();
    blocked(
        n.request(
            "https://models.example/v1",
            NetworkRequest::default(),
            cloud_scope(),
        )
        .await,
    )
    .await;
    assert_eq!(t.seen.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn checked_socket_uses_one_resolved_address_without_resolving_url_host_again() {
    let (url, seen) =
        http_fixture(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".to_vec()).await;
    let url = url.replace("localhost", "not-resolvable.invalid");
    let dns = Dns::new(&["127.0.0.1"]);
    let n = NativeNetwork::with_components(
        offline(),
        dns.clone(),
        Arc::new(CheckedTransport::default()),
    );
    assert_eq!(
        n.request(
            &url,
            NetworkRequest::default(),
            NetworkScope {
                purpose: Purpose::WebTool,
                ..Default::default()
            }
        )
        .await
        .unwrap()
        .text()
        .await
        .unwrap(),
        "ok"
    );
    assert_eq!(dns.calls.load(Ordering::SeqCst), 1);
    assert!(seen.await.unwrap().contains("not-resolvable.invalid"));
}
#[tokio::test]
async fn public_web_cannot_inherit_loopback_or_registered_private_exceptions() {
    for host in [
        "localhost",
        "localhost.",
        "127.0.0.1",
        "127.1",
        "2130706433",
        "0x7f000001",
        "0177.0.0.1",
        "[::1]",
        "[::ffff:127.0.0.1]",
    ] {
        let (n, _, t) = setup(&["127.0.0.1"]);
        blocked(
            n.request(
                &format!("https://{host}/private?q=1"),
                NetworkRequest::default(),
                NetworkScope {
                    purpose: Purpose::PublicWeb,
                    allow_cloud: true,
                    ..Default::default()
                },
            )
            .await,
        )
        .await;
        assert!(t.seen.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn raw_model_bodies_have_no_implicit_cap_but_callers_can_bound_encodings() {
    let (network, _, transport) = setup(&[]);
    let request = NetworkRequest {
        body: Bytes::from(vec![b'x'; 16 * 1024 * 1024 + 1]),
        ..Default::default()
    };
    network
        .request(
            "http://localhost/v1",
            request.clone(),
            NetworkScope::default(),
        )
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(transport.seen.lock().unwrap().len(), 1);
    blocked(
        network
            .request(
                "http://localhost/v1",
                request,
                NetworkScope {
                    max_request_bytes: Some(16 * 1024 * 1024),
                    ..Default::default()
                },
            )
            .await,
    )
    .await;
    assert_eq!(transport.seen.lock().unwrap().len(), 1);
}
#[test]
fn optional_extra_ca_loading_is_bounded_atomic_and_diagnostic() {
    use std::fs;
    let (_, _, pem) = ephemeral_tls_identity();
    let fixture = TemporaryCaFile::new(&pem);
    let valid = CheckedTransport::from_extra_ca_file(Some(&fixture.0));
    assert!(valid.diagnostics().is_empty());
    let baseline = CheckedTransport::from_extra_ca_file(None);
    assert!(baseline.diagnostics().is_empty());
    let path = std::env::temp_dir().join(format!("tepora-extra-ca-{}.pem", uuid::Uuid::new_v4()));
    let missing = CheckedTransport::from_extra_ca_file(Some(&path));
    assert_eq!(missing.diagnostics().len(), 1);
    assert!(missing.diagnostics()[0].contains("default verified TLS roots"));
    for body in [
        b"not a certificate".to_vec(),
        vec![b'x'; 1024 * 1024 + 1],
        [
            pem.as_bytes(),
            b"\n-----BEGIN CERTIFICATE-----\ncorrupted\n-----END CERTIFICATE-----\n",
        ]
        .concat(),
    ] {
        fs::write(&path, &body).unwrap();
        let transport = CheckedTransport::from_extra_ca_file(Some(&path));
        assert_eq!(transport.diagnostics().len(), 1);
        assert!(transport.diagnostics()[0].contains("default verified TLS roots"));
        assert!(!transport.diagnostics()[0].contains("corrupted"));
        assert!(!transport.diagnostics()[0].contains(&path.display().to_string()));
    }
    fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn invalid_optional_extra_ca_does_not_disable_http() {
    let missing =
        std::env::temp_dir().join(format!("tepora-absent-ca-{}.pem", uuid::Uuid::new_v4()));
    let transport = CheckedTransport::from_extra_ca_file(Some(&missing));
    let n = NativeNetwork::with_components(offline(), Dns::new(&[]), Arc::new(transport));
    assert_eq!(n.diagnostics().len(), 1);
    let (url, _) = http_fixture(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".to_vec()).await;
    assert_eq!(
        n.request(&url, NetworkRequest::default(), NetworkScope::default())
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "ok"
    );
}

#[test]
fn known_loopback_is_attributed_before_any_async_admission_step() {
    assert_eq!(
        pending_domains("http://localhost/v1", &NetworkScope::default()),
        Some(vec![Domain::Device])
    );
    assert_eq!(
        pending_domains("https://models.example/v1", &cloud_scope()),
        Some(vec![Domain::Cloud])
    );
    assert_eq!(
        pending_domains(
            "http://intranet.example/",
            &NetworkScope {
                purpose: Purpose::WebTool,
                ..Default::default()
            }
        ),
        None
    );
}
