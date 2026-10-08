use super::*;
use crate::network::{Admitted, NetworkFuture, Resolver, Transport, TransportResponse};
use bytes::Bytes;
use std::{
    collections::VecDeque,
    sync::atomic::{AtomicI64, AtomicUsize, Ordering},
};
#[derive(Default)]
struct Mock {
    seen: Mutex<Vec<String>>,
    queued: Mutex<VecDeque<(u16, Vec<Bytes>)>>,
    hold: Mutex<bool>,
    hold_body: Mutex<bool>,
    body_waiting: Arc<AtomicUsize>,
    entered: AtomicUsize,
}
impl Resolver for Mock {
    fn lookup<'a>(&'a self, _: &'a str) -> NetworkFuture<'a, Vec<String>> {
        // Synthetic admission address only. This transport never creates a socket.
        Box::pin(async { Ok(vec!["93.184.215.14".into()]) })
    }
}
impl Transport for Mock {
    fn request<'a>(
        &'a self,
        admitted: Admitted,
        request: NetworkRequest,
        cancel: RequestCancellation,
    ) -> NetworkFuture<'a, TransportResponse> {
        Box::pin(async move {
            assert_eq!(admitted.purpose, Purpose::Feed);
            assert_eq!(request.method, hyper::Method::GET);
            assert!(request.headers.is_empty() && request.body.is_empty());
            self.seen.lock().unwrap().push(admitted.url.to_string());
            self.entered.fetch_add(1, Ordering::SeqCst);
            if *self.hold.lock().unwrap() {
                return Err(cancel.cancelled().await);
            }
            let (status, chunks) = self
                .queued
                .lock()
                .unwrap()
                .pop_front()
                .expect("Unplanned mock request");
            let hold_body = *self.hold_body.lock().unwrap();
            let body_waiting = self.body_waiting.clone();
            Ok(TransportResponse {
                status,
                headers: Default::default(),
                body: Some(Box::pin(async_stream::try_stream! {
                    for chunk in chunks { yield chunk; }
                    if hold_body {
                        body_waiting.fetch_add(1, Ordering::SeqCst);
                        std::future::pending::<()>().await;
                    }
                })),
            })
        })
    }
}
impl Mock {
    fn queue(&self, status: u16, body: impl Into<Bytes>) {
        self.queued
            .lock()
            .unwrap()
            .push_back((status, vec![body.into()]));
    }
    fn weather(&self) {
        self.queue(
            200,
            br#"{"results":[{"name":"Asterhaven","latitude":12.25,"longitude":-34.5}]}"#.as_slice(),
        );
        self.queue(200, br#"{"current":{"temperature_2m":18}}"#.as_slice());
    }
}
fn fixture() -> (Arc<FeedConnectors>, Arc<Mock>, Arc<AtomicI64>) {
    let mock = Arc::new(Mock::default());
    let network = NativeNetwork::with_components(Default::default(), mock.clone(), mock.clone());
    let clock = Arc::new(AtomicI64::new(1_791_446_400_000));
    let mut owner = FeedConnectors::new(network);
    let time = clock.clone();
    owner.clock = Arc::new(move || time.load(Ordering::SeqCst));
    (Arc::new(owner), mock, clock)
}
fn settings() -> Value {
    json!({"allowNetwork":true,"weatherCity":"Asterhaven","newsUrl":"https://bulletin.example.test/feed"})
}
fn fixtures() -> Value {
    json_codec::parse(include_str!("source-fixtures.json")).unwrap()
}
#[tokio::test]
async fn frozen_weather_projections_and_exact_fixed_queries() {
    for case in fixtures()["weather"].as_array().unwrap() {
        let (owner, mock, _) = fixture();
        mock.queue(
            200,
            json_codec::stringify(&json!({"results":[case["place"]]})).unwrap(),
        );
        mock.queue(200, json_codec::stringify(&case["data"]).unwrap());
        let mut settings = settings();
        settings["weatherCity"] = case["city"].clone();
        let value = owner
            .weather(&settings, RequestCancellation::new())
            .await
            .unwrap();
        assert_eq!(value, case["value"], "{}", case["city"]);
        assert_eq!(
            geocode_url(case["city"].as_str().unwrap()).unwrap(),
            case["urls"][0]
        );
        assert_eq!(forecast_url(&case["place"]), case["urls"][1]);
        assert_eq!(json!(*mock.seen.lock().unwrap()), case["admittedUrls"]);
    }
}
#[tokio::test]
async fn frozen_ordinary_rss_atom_and_utf16_projection() {
    for case in fixtures()["news"].as_array().unwrap() {
        let (owner, mock, _) = fixture();
        mock.queue(200, json_codec::sql_text(case["xml"].as_str().unwrap()));
        let value = owner
            .news(&settings(), RequestCancellation::new())
            .await
            .unwrap();
        assert_eq!(value, case["value"], "{}", case["name"]);
        assert_eq!(json!(*mock.seen.lock().unwrap()), case["admittedUrls"]);
    }
}
#[tokio::test]
async fn frozen_ordinary_source_errors_never_cache_failures() {
    for case in fixtures()["errors"].as_array().unwrap() {
        let (owner, mock, _) = fixture();
        for response in case["responses"].as_array().unwrap() {
            mock.queue(
                response["status"].as_u64().unwrap_or(200) as u16,
                response["body"].as_str().unwrap().to_owned(),
            );
        }
        let result = if case["kind"] == "weather" {
            owner
                .weather(&case["settings"], RequestCancellation::new())
                .await
        } else {
            owner
                .news(&case["settings"], RequestCancellation::new())
                .await
        };
        let e = result.unwrap_err();
        assert_eq!(
            json!({"status":e.status,"message":e.message}),
            case["error"],
            "{}",
            case["name"]
        );
        assert!(owner.life.lock().unwrap().cache.is_empty());
    }
}
#[tokio::test]
async fn cache_keys_ttls_clock_and_current_permission_match_source() {
    let (owner, mock, clock) = fixture();
    let initial = clock.load(Ordering::SeqCst);
    mock.weather();
    let weather = owner
        .weather(&settings(), RequestCancellation::new())
        .await
        .unwrap();
    clock.store(initial + WEATHER_TTL - 1, Ordering::SeqCst);
    assert_eq!(
        owner
            .weather(&settings(), RequestCancellation::new())
            .await
            .unwrap(),
        weather
    );
    assert_eq!(mock.entered.load(Ordering::SeqCst), 2);
    clock.store(initial + WEATHER_TTL, Ordering::SeqCst);
    mock.weather();
    assert_ne!(
        owner
            .weather(&settings(), RequestCancellation::new())
            .await
            .unwrap()["fetchedAt"],
        weather["fetchedAt"]
    );
    let mut disabled = settings();
    disabled["allowNetwork"] = json!(false);
    assert_eq!(
        owner
            .weather(&disabled, RequestCancellation::new())
            .await
            .unwrap_err()
            .status,
        403
    );
    mock.queue(200, "<rss><title>One</title></rss>");
    let news = owner
        .news(&settings(), RequestCancellation::new())
        .await
        .unwrap();
    let news_at = clock.load(Ordering::SeqCst);
    clock.store(news_at + NEWS_TTL - 1, Ordering::SeqCst);
    assert_eq!(
        owner
            .news(&settings(), RequestCancellation::new())
            .await
            .unwrap(),
        news
    );
    clock.store(news_at + NEWS_TTL, Ordering::SeqCst);
    mock.queue(200, "<rss><title>Two</title></rss>");
    assert_eq!(
        owner
            .news(&settings(), RequestCancellation::new())
            .await
            .unwrap()["title"],
        "Two"
    );
    assert_eq!(
        owner
            .news(&disabled, RequestCancellation::new())
            .await
            .unwrap_err()
            .status,
        409
    );
    let mut changed = settings();
    changed["weatherCity"] = json!("Other fictional city");
    mock.weather();
    owner
        .weather(&changed, RequestCancellation::new())
        .await
        .unwrap();
    changed["newsUrl"] = json!("https://bulletin.example.test/other");
    mock.queue(200, "<rss/>");
    owner
        .news(&changed, RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(owner.life.lock().unwrap().cache.len(), 4);
    // Source Date.now subtraction treats a backwards clock as still fresh.
    clock.store(initial - 1, Ordering::SeqCst);
    owner
        .news(&settings(), RequestCancellation::new())
        .await
        .unwrap();
}
#[tokio::test]
async fn incremental_utf8_decoder_and_source_million_utf16_limit() {
    let (owner, mock, _) = fixture();
    let text = "\u{feff}<rss><title>語😀</title></rss>";
    mock.queued.lock().unwrap().push_back((
        200,
        text.as_bytes()
            .iter()
            .map(|b| Bytes::from(vec![*b]))
            .collect(),
    ));
    assert_eq!(
        owner
            .news(&settings(), RequestCancellation::new())
            .await
            .unwrap()["title"],
        "語😀"
    );
    for (body, status) in [
        ("x".repeat(NEWS_UNITS - 1), 200),
        ("x".repeat(NEWS_UNITS), 400),
        ("語".repeat(NEWS_UNITS), 400),
        ("😀".repeat(NEWS_UNITS / 2), 400),
    ] {
        let (owner, mock, _) = fixture();
        mock.queue(200, body);
        let result = owner.news(&settings(), RequestCancellation::new()).await;
        if status == 200 {
            assert!(result.is_ok());
        } else {
            let e = result.unwrap_err();
            assert_eq!((e.status, e.message), (400, "RSS feed too large".into()));
        }
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn timeouts_request_drop_stop_close_and_no_late_cache_publication() {
    let (mut owner, mock, _) = fixture();
    Arc::get_mut(&mut owner).unwrap().timeout = Duration::from_millis(20);
    *mock.hold.lock().unwrap() = true;
    for weather in [true, false] {
        let result = if weather {
            owner.weather(&settings(), RequestCancellation::new()).await
        } else {
            owner.news(&settings(), RequestCancellation::new()).await
        };
        let e = result.unwrap_err();
        assert_eq!(
            (e.status, e.message),
            (500, "The operation was aborted due to timeout".into())
        );
    }
    let (owner, mock, _) = fixture();
    *mock.hold.lock().unwrap() = true;
    for abort in [true, false] {
        let before = mock.entered.load(Ordering::SeqCst);
        let task_owner = owner.clone();
        let task = tokio::spawn(async move {
            task_owner
                .weather(&settings(), RequestCancellation::new())
                .await
        });
        while mock.entered.load(Ordering::SeqCst) == before {
            tokio::task::yield_now().await;
        }
        if abort {
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        } else {
            let first = owner.stop_barrier(false).unwrap();
            let second = owner.stop_barrier(false).unwrap();
            assert_eq!(task.await.unwrap().unwrap_err().status, 499);
            drop(first);
            assert_eq!(
                owner
                    .admit(RequestCancellation::new())
                    .err()
                    .unwrap()
                    .status,
                503
            );
            drop(second);
        }
        assert!(owner.life.lock().unwrap().active.is_empty());
        assert!(owner.life.lock().unwrap().cache.is_empty());
    }
    let flight = owner.admit(RequestCancellation::new()).unwrap();
    let close = owner.stop_barrier(true).unwrap();
    assert_eq!(
        owner
            .publish(&flight, "late".into(), json!({"title":"late"}))
            .unwrap_err()
            .status,
        499
    );
    drop(flight);
    drop(close);
    assert!(owner.life.lock().unwrap().cache.is_empty());
    assert_eq!(
        owner
            .admit(RequestCancellation::new())
            .err()
            .unwrap()
            .status,
        503
    );
}
#[test]
fn native_flight_and_cache_budgets_are_bounded() {
    let (owner, _, clock) = fixture();
    let mut flights = vec![];
    for _ in 0..MAX_FLIGHTS {
        flights.push(owner.admit(RequestCancellation::new()).unwrap());
    }
    assert_eq!(
        owner
            .admit(RequestCancellation::new())
            .err()
            .unwrap()
            .status,
        429
    );
    drop(flights.pop());
    flights.push(owner.admit(RequestCancellation::new()).unwrap());
    for n in 0..MAX_CACHE + 1 {
        clock.store(n as i64, Ordering::SeqCst);
        owner
            .publish(&flights[0], format!("key{n}"), json!(n))
            .unwrap();
    }
    let life = owner.life.lock().unwrap();
    assert_eq!(life.cache.len(), MAX_CACHE);
    assert!(!life.cache.contains_key("key0"));
}

// Real authenticated HTTP sockets on loopback; ALL outbound service networking
// uses Mock, including the unchanged fixed Open-Meteo URLs. No external socket
// or DNS implementation is reachable from this fixture's NativeResources.
async fn http(
    addr: std::net::SocketAddr,
    method: &str,
    path: &str,
    cookie: &str,
    csrf: &str,
    body: &str,
) -> (u16, String, Value) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let request=format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nOrigin: http://{addr}\r\nCookie: {cookie}\r\nx-tepora-csrf: {csrf}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut bytes = vec![];
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    let raw = String::from_utf8(bytes).unwrap();
    let (head, body) = raw.split_once("\r\n\r\n").unwrap();
    let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    let cookie = head
        .lines()
        .find_map(|line| line.strip_prefix("set-cookie: "))
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    (
        status,
        cookie,
        json_codec::parse(body).unwrap_or(Value::Null),
    )
}
async fn real_http(
    agent: bool,
) -> (
    Arc<Workspace>,
    Arc<Mock>,
    std::net::SocketAddr,
    String,
    String,
    tokio::sync::watch::Sender<bool>,
    tokio::task::JoinHandle<Result<(), ApiError>>,
    PathBuf,
) {
    let dir = env::temp_dir().join(format!("tepora-feeds-http-{}", Uuid::new_v4()));
    let workspace = Arc::new(Workspace::open(&dir).unwrap());
    let mock = Arc::new(Mock::default());
    let network = NativeNetwork::with_components(Default::default(), mock.clone(), mock.clone());
    if agent {
        workspace
            .enable_agent_components(
                tokio::runtime::Handle::current(),
                Default::default(),
                Some(network),
            )
            .unwrap();
    }
    let bundle = dir.join("fixture-bundle.mjs");
    fs::write(&bundle, "// inert bundle").unwrap();
    let mut config = crate::http::HttpConfig::new(dir.clone(), bundle);
    config.agent = agent;
    let server = crate::http::Server::bind(config, workspace.clone())
        .await
        .unwrap();
    let addr = server.local_addr().unwrap();
    let launch = server.launch_url();
    let shutdown = server.shutdown_sender();
    let task = tokio::spawn(server.run());
    let launch = url::Url::parse(&launch).unwrap();
    let (status, cookie, _) = http(
        addr,
        "GET",
        &format!("{}?{}", launch.path(), launch.query().unwrap()),
        "",
        "",
        "",
    )
    .await;
    assert_eq!(status, 303);
    let (status, _, bootstrap) = http(addr, "GET", "/api/bootstrap", &cookie, "", "").await;
    assert_eq!(status, 200);
    let csrf = bootstrap["csrf"].as_str().unwrap().to_owned();
    (workspace, mock, addr, cookie, csrf, shutdown, task, dir)
}
async fn finish_http(
    workspace: Arc<Workspace>,
    shutdown: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<Result<(), ApiError>>,
    dir: PathBuf,
) {
    shutdown.send_replace(true);
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    tokio::task::spawn_blocking(move || workspace.shutdown().unwrap())
        .await
        .unwrap();
    fs::remove_dir_all(dir).unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_http_routes_use_saved_settings_caches_and_effect_free_gate() {
    for agent in [false, true] {
        let (workspace, mock, addr, cookie, csrf, shutdown, task, dir) = real_http(agent).await;
        if agent {
            let (status, _, _) = http(
                addr,
                "PATCH",
                "/api/settings",
                &cookie,
                &csrf,
                &settings().to_string(),
            )
            .await;
            assert_eq!(status, 200);
            mock.weather();
            mock.queue(200, "<rss><title>Fictional bulletin</title></rss>");
        }
        for (path, field, expected) in [
            ("/api/connector/weather", "city", "Asterhaven"),
            ("/api/connector/news", "title", "Fictional bulletin"),
        ] {
            // The source routes ignore request data and use only saved settings.
            let (status, _, value) =
                http(addr, "POST", path, &cookie, &csrf, "malformed unread body").await;
            assert_eq!(status, if agent { 200 } else { 503 });
            if agent {
                assert_eq!(value[field], expected);
                assert_eq!(
                    http(addr, "POST", path, &cookie, &csrf, "{}").await.2,
                    value
                );
            }
        }
        assert_eq!(
            mock.entered.load(Ordering::SeqCst),
            if agent { 3 } else { 0 }
        );
        if agent {
            assert_eq!(
                http(
                    addr,
                    "PATCH",
                    "/api/settings",
                    &cookie,
                    &csrf,
                    r#"{"allowNetwork":false}"#
                )
                .await
                .0,
                200
            );
            assert_eq!(
                http(addr, "POST", "/api/connector/weather", &cookie, &csrf, "")
                    .await
                    .0,
                403
            );
            assert_eq!(
                http(addr, "POST", "/api/connector/news", &cookie, &csrf, "")
                    .await
                    .0,
                409
            );
        }
        finish_http(workspace, shutdown, task, dir).await;
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_http_stop_all_tray_and_shutdown_cancel_both_feed_flights() {
    for mode in ["stop-all", "tray", "shutdown"] {
        let (workspace, mock, addr, cookie, csrf, shutdown, task, dir) = real_http(true).await;
        assert_eq!(
            http(
                addr,
                "PATCH",
                "/api/settings",
                &cookie,
                &csrf,
                &settings().to_string()
            )
            .await
            .0,
            200
        );
        *mock.hold.lock().unwrap() = true;
        let mut requests = vec![];
        for path in ["/api/connector/weather", "/api/connector/news"] {
            let c = cookie.clone();
            let s = csrf.clone();
            requests.push(tokio::spawn(async move {
                http(addr, "POST", path, &c, &s, "").await
            }));
        }
        tokio::time::timeout(Duration::from_secs(2), async {
            while mock.entered.load(Ordering::SeqCst) < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        match mode {
            "stop-all" => assert_eq!(
                http(addr, "POST", "/api/stop", &cookie, &csrf, "").await.0,
                200
            ),
            "tray" => {
                let owner = workspace.clone();
                tokio::task::spawn_blocking(move || owner.stop().unwrap())
                    .await
                    .unwrap();
            }
            _ => {
                shutdown.send_replace(true);
            }
        }
        for request in requests {
            let status = request.await.unwrap().0;
            assert!(
                if mode == "shutdown" {
                    [499, 503].contains(&status)
                } else {
                    status == 499
                },
                "{mode}: {status}"
            );
        }
        let life = workspace.native.get().unwrap().feeds.life.lock().unwrap();
        assert!(life.active.is_empty());
        assert!(life.cache.is_empty());
        drop(life);
        if mode != "shutdown" {
            *mock.hold.lock().unwrap() = false;
            mock.weather();
            assert_eq!(
                http(addr, "POST", "/api/connector/weather", &cookie, &csrf, "")
                    .await
                    .0,
                200
            );
        }
        finish_http(workspace, shutdown, task, dir).await;
    }
}

#[tokio::test]
async fn frozen_source_cache_time_and_setting_transitions() {
    let (owner, mock, clock) = fixture();
    let mut requests = 0;
    for case in fixtures()["cache"].as_array().unwrap() {
        clock.store(case["at"].as_i64().unwrap(), Ordering::SeqCst);
        let next = case["requests"].as_u64().unwrap();
        if next > requests {
            if case["kind"] == "weather" {
                mock.queue(200,json!({"results":[{"name":case["settings"]["weatherCity"],"latitude":12.25,"longitude":-34.5}]}).to_string());
                mock.queue(200, r#"{"current":{"temperature_2m":18}}"#);
            } else {
                mock.queue(200, "<rss><title>Cached bulletin</title></rss>");
            }
        }
        let result = if case["kind"] == "weather" {
            owner
                .weather(&case["settings"], RequestCancellation::new())
                .await
        } else {
            owner
                .news(&case["settings"], RequestCancellation::new())
                .await
        };
        if let Some(expected) = case.get("error") {
            let e = result.unwrap_err();
            assert_eq!(json!({"status":e.status,"message":e.message}), *expected);
        } else {
            assert_eq!(result.unwrap(), case["value"]);
        }
        assert_eq!(mock.entered.load(Ordering::SeqCst) as u64, next);
        requests = next;
    }
}

#[tokio::test]
async fn native_raw_response_byte_caps_fail_without_cache() {
    for (weather, size) in [(true, WEATHER_BYTES + 1), (false, NEWS_BYTES + 1)] {
        let (owner, mock, _) = fixture();
        mock.queue(200, "x".repeat(size));
        let result = if weather {
            owner.weather(&settings(), RequestCancellation::new()).await
        } else {
            owner.news(&settings(), RequestCancellation::new()).await
        };
        let e = result.unwrap_err();
        assert_eq!(
            (e.status, e.message),
            (502, "Response exceeds budget".into())
        );
        let life = owner.life.lock().unwrap();
        assert!(life.cache.is_empty());
        assert!(life.active.is_empty());
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_during_streamed_body_drains_without_cache() {
    for weather in [true, false] {
        let (owner, mock, _) = fixture();
        *mock.hold_body.lock().unwrap() = true;
        mock.queue(
            200,
            if weather {
                r#"{"results":["#
            } else {
                "<rss><title>Partial"
            },
        );
        let task_owner = owner.clone();
        let task = tokio::spawn(async move {
            if weather {
                task_owner
                    .weather(&settings(), RequestCancellation::new())
                    .await
            } else {
                task_owner
                    .news(&settings(), RequestCancellation::new())
                    .await
            }
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while mock.body_waiting.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let barrier = owner.stop_barrier(false).unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err()
                .status,
            499
        );
        drop(barrier);
        let life = owner.life.lock().unwrap();
        assert!(life.cache.is_empty());
        assert!(life.active.is_empty());
    }
}
