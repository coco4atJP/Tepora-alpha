//! Real authenticated HTTP + real Workspace/actor + production native transport.
//! The only upstream is an in-process loopback fixture; no browser or real model.
use super::*;
use crate::{
    http::{HttpConfig, Server},
    network::RequestCancellation,
    workspace::Workspace,
    ApiError, Backend,
};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{body::Incoming, service::service_fn, Request, Response};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{watch, Notify},
    task::{JoinHandle, JoinSet},
};

#[derive(Default)]
struct Provider {
    models: Mutex<Vec<Value>>,
    calls: Mutex<Vec<String>>,
    probes: AtomicUsize,
    hold: AtomicBool,
    release: Notify,
}
impl Provider {
    async fn handle(&self, request: Request<Incoming>) -> Response<Full<Bytes>> {
        assert!(!request.headers().contains_key("authorization"));
        let path = request.uri().path().to_owned();
        let body = request.into_body().collect().await.unwrap().to_bytes();
        self.calls.lock().unwrap().push(path.clone());
        let value = match path.as_str() {
            "/api/tags" => json!({"models":self.models.lock().unwrap().clone()}),
            "/v1/models" => {
                json!({"data":self.models.lock().unwrap().iter().map(|m|json!({"id":m["name"]})).collect::<Vec<_>>()})
            }
            "/api/pull" => {
                let body: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(
                    body,
                    json!({"model":"qwen3:4b-instruct-2507-q4_K_M","stream":true,"insecure":false})
                );
                *self.models.lock().unwrap() =
                    vec![json!({"name":body["model"],"digest":"download-digest","size":10})];
                return Response::builder().header("content-type","application/x-ndjson").body(Full::new(Bytes::from_static(b"{\"digest\":\"local-layer\",\"total\":10,\"completed\":10}\n{\"status\":\"success\"}\n"))).unwrap();
            }
            "/v1/chat/completions" => {
                let index = self.probes.fetch_add(1, Ordering::SeqCst);
                if index == 0 && self.hold.load(Ordering::SeqCst) {
                    self.release.notified().await;
                }
                let body: Value = serde_json::from_slice(&body).unwrap();
                let messages = body["messages"].as_array().unwrap();
                let answer = if let Some(tool) = messages.iter().find(|m| m["role"] == "tool") {
                    let receipt: Value =
                        serde_json::from_str(tool["content"].as_str().unwrap()).unwrap();
                    json!({"role":"assistant","content":receipt["receipt"]})
                } else {
                    let challenge = messages
                        .iter()
                        .find_map(|m| {
                            m["content"]
                                .as_str()
                                .and_then(|s| s.strip_prefix("Challenge: "))
                        })
                        .unwrap();
                    json!({"role":"assistant","content":null,"tool_calls":[{"id":"fixture-call","type":"function","function":{"name":"tepora_probe","arguments":serde_json::to_string(&json!({"challenge":challenge})).unwrap()}}]})
                };
                json!({"choices":[{"message":answer,"finish_reason":"stop"}]})
            }
            _ => panic!("Unexpected upstream request {path}"),
        };
        Response::builder()
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(serde_json::to_vec(&value).unwrap())))
            .unwrap()
    }
}
#[derive(Clone)]
struct Client {
    address: std::net::SocketAddr,
    cookie: String,
    csrf: String,
}
struct Reply {
    status: u16,
    headers: hyper::HeaderMap,
    value: Value,
}
struct AbortConnection(JoinHandle<()>);
impl Drop for AbortConnection {
    fn drop(&mut self) {
        self.0.abort();
    }
}
impl Client {
    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> Reply {
        self.raw(method, path, body, true, true).await
    }
    async fn raw(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        cookie: bool,
        csrf: bool,
    ) -> Reply {
        tokio::time::timeout(Duration::from_secs(8), async {
            let stream = TcpStream::connect(self.address).await.unwrap();
            let (mut sender, connection) =
                hyper::client::conn::http1::handshake(TokioIo::new(stream))
                    .await
                    .unwrap();
            let _connection = AbortConnection(tokio::spawn(async move {
                let _ = connection.await;
            }));
            let mut request = Request::builder()
                .method(method)
                .uri(path)
                .header("host", self.address.to_string())
                .header("connection", "close");
            if cookie && !self.cookie.is_empty() {
                request = request.header("cookie", &self.cookie);
            }
            if csrf && !self.csrf.is_empty() {
                request = request.header("x-tepora-csrf", &self.csrf);
            }
            let body = body
                .map(|v| serde_json::to_vec(&v).unwrap())
                .unwrap_or_default();
            let response = sender
                .send_request(request.body(Full::new(Bytes::from(body))).unwrap())
                .await
                .unwrap();
            let status = response.status().as_u16();
            let headers = response.headers().clone();
            let body = response.into_body().collect().await.unwrap().to_bytes();
            let value = if body.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&body).unwrap()
            };
            Reply {
                status,
                headers,
                value,
            }
        })
        .await
        .expect("bounded HTTP fixture request")
    }
}
struct Fixture {
    root: PathBuf,
    workspace: Option<Arc<Workspace>>,
    provider: Arc<Provider>,
    provider_url: String,
    provider_cancel: RequestCancellation,
    provider_task: Option<JoinHandle<()>>,
    server: Option<JoinHandle<Result<(), ApiError>>>,
    shutdown: watch::Sender<bool>,
    client: Client,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.shutdown.send_replace(true);
        self.provider_cancel.cancel();
        self.provider.release.notify_waiters();
        if let Some(workspace) = &self.workspace {
            let _ = workspace.begin_shutdown();
        }
    }
}
impl Fixture {
    async fn new(models: Vec<Value>, hold: bool) -> Self {
        let root =
            std::env::temp_dir().join(format!("tepora-real-setup-http-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("web")).unwrap();
        std::fs::write(root.join("app.bundle.js"), b"/* fixture */").unwrap();
        let provider = Arc::new(Provider {
            models: Mutex::new(models),
            hold: AtomicBool::new(hold),
            ..Default::default()
        });
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let provider_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let provider_cancel = RequestCancellation::new();
        let cancel = provider_cancel.clone();
        let upstream = provider.clone();
        let provider_task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {biased;_=cancel.cancelled()=>break,result=listener.accept()=>{let (stream,_)=result.unwrap();let provider=upstream.clone();connections.spawn(async move {let service=service_fn(move|r|{let p=provider.clone();async move{Ok::<_,Infallible>(p.handle(r).await)}});let _=hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream),service).await;});},Some(_)=connections.join_next(),if !connections.is_empty()=>{}}
            }
            connections.abort_all();
            while connections.join_next().await.is_some() {}
        });
        let (workspace, server, shutdown, client) = Self::start(&root, &provider_url).await;
        Self {
            root,
            workspace: Some(workspace),
            provider,
            provider_url,
            provider_cancel,
            provider_task: Some(provider_task),
            server: Some(server),
            shutdown,
            client,
        }
    }
    async fn start(
        root: &std::path::Path,
        provider_url: &str,
    ) -> (
        Arc<Workspace>,
        JoinHandle<Result<(), ApiError>>,
        watch::Sender<bool>,
        Client,
    ) {
        let workspace = Arc::new(Workspace::open(&root.join("data")).unwrap());
        let options = SetupOptions {
            providers: vec![json!({"id":"ollama","name":"Ollama HTTP fixture","url":provider_url})],
            probe_timeout: Duration::from_secs(6),
            download_idle: Duration::from_secs(3),
            ..Default::default()
        };
        workspace
            .enable_agent_with_setup(tokio::runtime::Handle::current(), options)
            .unwrap();
        let mut config = HttpConfig::new(root.join("web"), root.join("app.bundle.js"));
        config.agent = true;
        let service = Server::bind(config, workspace.clone()).await.unwrap();
        let address = service.local_addr().unwrap();
        let launch = url::Url::parse(&service.launch_url()).unwrap();
        let path = format!("{}?{}", launch.path(), launch.query().unwrap());
        let shutdown = service.shutdown_sender();
        let server = tokio::spawn(service.run());
        let mut client = Client {
            address,
            cookie: String::new(),
            csrf: String::new(),
        };
        let login = client.raw("GET", &path, None, false, false).await;
        assert_eq!(login.status, 303);
        client.cookie = login.headers["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .into();
        let bootstrap = client.call("GET", "/api/bootstrap", None).await;
        assert_eq!(bootstrap.status, 200);
        client.csrf = bootstrap.value["csrf"].as_str().unwrap().into();
        (workspace, server, shutdown, client)
    }
    async fn stop_service(&mut self) {
        self.shutdown.send_replace(true);
        if let Some(server) = self.server.take() {
            tokio::time::timeout(Duration::from_secs(6), server)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        }
        if let Some(workspace) = self.workspace.take() {
            tokio::task::spawn_blocking(move || workspace.shutdown())
                .await
                .unwrap()
                .unwrap();
        }
    }
    async fn restart(&mut self) {
        self.stop_service().await;
        let (workspace, server, shutdown, client) =
            Self::start(&self.root, &self.provider_url).await;
        self.workspace = Some(workspace);
        self.server = Some(server);
        self.shutdown = shutdown;
        self.client = client;
    }
    async fn finish(mut self) {
        self.stop_service().await;
        self.provider_cancel.cancel();
        self.provider.release.notify_waiters();
        if let Some(task) = self.provider_task.take() {
            task.await.unwrap();
        }
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
async fn until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !condition() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn authenticated_setup_download_probe_actor_commit_catalog_and_restart_use_real_http() {
    let mut f = Fixture::new(vec![], false).await;
    let client = &f.client;
    assert!(f.provider.calls.lock().unwrap().is_empty());
    assert_eq!(
        client
            .raw("GET", "/api/setup", None, false, false)
            .await
            .status,
        401
    );
    assert_eq!(
        client
            .raw("POST", "/api/setup/scan", None, true, false)
            .await
            .status,
        403
    );
    assert!(f.provider.calls.lock().unwrap().is_empty());
    let setup = client.call("GET", "/api/setup", None).await;
    assert_eq!(setup.value["stage"], "connect");
    assert_eq!(setup.value["catalog"].as_array().unwrap().len(), 2);
    assert_eq!(client.call("PATCH","/api/network",Some(json!({"patch":{"mode":"offline"},"expectedRevision":0}))).await.status,200);
    let blocked=client.call("POST","/api/setup/install",Some(json!({}))).await;assert_eq!(blocked.status,403);assert_eq!(blocked.value["blocked"],true);
    // A restricted-mode install must reject before waiting for any body bytes.
    {use tokio::io::{AsyncReadExt,AsyncWriteExt};let mut socket=TcpStream::connect(client.address).await.unwrap();let headers=format!("POST /api/setup/install HTTP/1.1\r\nHost: {}\r\nCookie: {}\r\nX-Tepora-CSRF: {}\r\nContent-Length: 100\r\nConnection: close\r\n\r\n",client.address,client.cookie,client.csrf);socket.write_all(headers.as_bytes()).await.unwrap();let mut status=[0u8;12];tokio::time::timeout(Duration::from_secs(2),socket.read_exact(&mut status)).await.unwrap().unwrap();assert_eq!(&status,b"HTTP/1.1 403");}
    assert_eq!(client.call("PATCH","/api/network",Some(json!({"patch":{"mode":"online"},"expectedRevision":1}))).await.status,200);
    let imported=client.call("POST","/api/model-catalog/import",Some(json!({"p":{"npm":"never execute","api":"file:///private","models":{"vision":{"name":"Local vision","modalities":{"input":["image"]},"tool_call":true}}}}))).await;
    assert_eq!(imported.status, 200);
    let found = client.call("GET", "/api/model-catalog?q=image", None).await;
    assert_eq!(found.value["count"], 1);
    assert_eq!(found.value["models"][0]["verified"], false);
    assert!(found.value["models"][0].get("npm").is_none());
    assert!(found.value["models"][0].get("api").is_none());
    assert!(f.provider.calls.lock().unwrap().is_empty());
    let scan = client.call("POST", "/api/setup/scan", None).await;
    assert_eq!(scan.status, 200);
    let mut download = json!({"engineId":scan.value["engines"][0]["id"],"catalogId":"compact"});
    assert_eq!(
        client
            .call("POST", "/api/setup/install", Some(download.clone()))
            .await
            .status,
        403
    );
    download["consentDownload"] = json!(true);
    assert_eq!(
        client
            .call("POST", "/api/setup/install", Some(download))
            .await
            .status,
        202
    );
    let snapshot = tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let s = client.call("GET", "/api/setup", None).await.value;
            if s["transfer"]["status"] == "downloaded"
                && s["candidates"].as_array().is_some_and(|v| !v.is_empty())
            {
                break s;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    // Discovery publishes candidates before the download task releases its
    // lease. A concurrent HTTP selection may correctly see that final busy
    // turn; retry only that admission rejection, never a failed probe.
    let select = tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let reply = client
                .call(
                    "POST",
                    "/api/setup/select",
                    Some(json!({"candidateId":snapshot["candidates"][0]["id"],"consentTest":true})),
                )
                .await;
            if reply.status != 409 || reply.value["error"] != "別の準備処理が進行中です。" {
                break reply;
            }
            assert_eq!(f.provider.probes.load(Ordering::SeqCst), 0);
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    assert_eq!(select.status, 200, "{}", select.value);
    assert_eq!(select.value["report"]["passed"], true);
    assert_eq!(f.provider.probes.load(Ordering::SeqCst), 2);
    let registry = client.call("GET", "/api/providers", None).await.value;
    assert_eq!(registry["revision"], 1);
    assert_eq!(registry["profiles"][0]["probe"]["ok"], true);
    let bootstrap = client.call("GET", "/api/bootstrap", None).await.value;
    assert_eq!(
        bootstrap["settings"]["model"],
        "qwen3:4b-instruct-2507-q4_K_M"
    );
    assert_eq!(bootstrap["setup"]["verified"], true);
    let workspace = f.workspace.as_ref().unwrap();
    let subscription = workspace.subscribe(crate::EventRequest {since: 0, reconnect: true}).unwrap();
    assert_eq!(subscription.initial[0].data["setup"], bootstrap["setup"], "Reconnect must retain verified setup and live candidates");
    workspace.unsubscribe(subscription.id);

    let before = f.provider.calls.lock().unwrap().len();
    f.restart().await;
    let restored = f.client.call("GET", "/api/setup", None).await.value;
    assert_eq!(restored["verified"], true);
    assert_eq!(restored["transfer"]["status"], "downloaded");
    assert!(restored["candidates"].as_array().unwrap().is_empty());
    assert_eq!(
        f.provider.calls.lock().unwrap().len(),
        before,
        "restart and reads do not resume installation or inference"
    );
    assert_eq!(
        f.client
            .call("GET", "/api/model-catalog?q=image", None)
            .await
            .value["count"],
        1
    );
    f.finish().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_http_settings_change_cannot_be_overwritten_by_delayed_setup_probe() {
    let f = Fixture::new(
        vec![json!({"name":"safe-local","digest":"fixture-digest"})],
        true,
    )
    .await;
    let scan = f.client.call("POST", "/api/setup/scan", None).await.value;
    let client = f.client.clone();
    let task = tokio::spawn(async move {
        client
            .call(
                "POST",
                "/api/setup/select",
                Some(json!({"candidateId":scan["candidates"][0]["id"],"consentTest":true})),
            )
            .await
    });
    until(|| f.provider.probes.load(Ordering::SeqCst) == 1).await;
    assert_eq!(
        f.client
            .call(
                "PATCH",
                "/api/settings",
                Some(json!({"model":"manual-choice"}))
            )
            .await
            .status,
        200
    );
    f.provider.release.notify_one();
    let result = task.await.unwrap();
    assert_eq!(result.status, 409, "{}", result.value);
    let bootstrap = f.client.call("GET", "/api/bootstrap", None).await.value;
    assert_eq!(bootstrap["settings"]["model"], "manual-choice");
    assert!(bootstrap["providers"]["profiles"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(bootstrap["setup"]["verified"], false);
    f.finish().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn http_stop_cancels_the_actual_setup_probe_and_keeps_activation_absent() {
    let f = Fixture::new(
        vec![json!({"name":"safe-local","digest":"fixture-digest"})],
        true,
    )
    .await;
    let scan = f.client.call("POST", "/api/setup/scan", None).await.value;
    let client = f.client.clone();
    let task = tokio::spawn(async move {
        client
            .call(
                "POST",
                "/api/setup/select",
                Some(json!({"candidateId":scan["candidates"][0]["id"],"consentTest":true})),
            )
            .await
    });
    until(|| f.provider.probes.load(Ordering::SeqCst) == 1).await;
    let stopped = f.client.call("POST", "/api/setup/stop", None).await;
    assert_eq!(stopped.status, 200);
    assert_eq!(stopped.value["stopping"], true);
    let reply = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reply.status, 499, "{}", reply.value);
    let bootstrap = f.client.call("GET", "/api/bootstrap", None).await.value;
    assert_eq!(bootstrap["settings"]["model"], "");
    assert!(bootstrap["providers"]["profiles"]
        .as_array()
        .unwrap()
        .is_empty());
    f.provider.release.notify_one();
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_cancels_setup_before_http_drain_and_restart_does_not_activate_or_reprobe() {
    let mut f = Fixture::new(
        vec![json!({"name":"safe-local","digest":"fixture-digest"})],
        true,
    )
    .await;
    let scan = f.client.call("POST", "/api/setup/scan", None).await.value;
    let client = f.client.clone();
    let pending = tokio::spawn(async move {
        let stream = TcpStream::connect(client.address)
            .await
            .map_err(|e| e.to_string())?;
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|e| e.to_string())?;
        let _connection = AbortConnection(tokio::spawn(async move {
            let _ = connection.await;
        }));
        let body = serde_json::to_vec(
            &json!({"candidateId":scan["candidates"][0]["id"],"consentTest":true}),
        )
        .unwrap();
        let request = Request::builder()
            .method("POST")
            .uri("/api/setup/select")
            .header("host", client.address.to_string())
            .header("cookie", client.cookie)
            .header("x-tepora-csrf", client.csrf)
            .body(Full::new(Bytes::from(body)))
            .unwrap();
        let reply = sender
            .send_request(request)
            .await
            .map_err(|e| e.to_string())?;
        Ok::<_, String>(reply.status().as_u16())
    });
    until(|| f.provider.probes.load(Ordering::SeqCst) == 1).await;
    tokio::time::timeout(Duration::from_secs(6), f.stop_service())
        .await
        .unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(1), pending)
        .await
        .unwrap()
        .unwrap();
    if let Ok(status) = outcome {
        assert!(
            status == 499 || status == 503,
            "unexpected accepted selection after shutdown: {status}"
        );
    }
    f.provider.release.notify_waiters();
    let calls = f.provider.calls.lock().unwrap().len();
    f.restart().await;
    let bootstrap = f.client.call("GET", "/api/bootstrap", None).await.value;
    assert_eq!(bootstrap["settings"]["model"], "");
    assert!(bootstrap["providers"]["profiles"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(bootstrap["setup"]["verified"], false);
    assert_eq!(
        f.provider.calls.lock().unwrap().len(),
        calls,
        "restart cannot resume or replay a canceled first-use probe"
    );
    f.finish().await;
}

#[test]
fn setup_scan_and_selection_do_not_wait_for_the_blocking_pool() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let f = Fixture::new(
            vec![json!({"name":"safe-local","digest":"fixture-digest"})],
            false,
        ).await;
        let (release, held) = std::sync::mpsc::channel::<()>();
        let (started, ready) = tokio::sync::oneshot::channel();
        let blocker = tokio::task::spawn_blocking(move || {
            started.send(()).unwrap();
            let _ = held.recv();
        });
        ready.await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(3), async {
            let scan = f.client.call("POST", "/api/setup/scan", None).await;
            assert_eq!(scan.status, 200, "{}", scan.value);
            f.client.call("POST", "/api/setup/select", Some(json!({
                "candidateId":scan.value["candidates"][0]["id"],"consentTest":true
            }))).await
        }).await;
        drop(release);
        blocker.await.unwrap();
        let response = result.expect("setup network waits must not use the blocking pool");
        assert_eq!(response.status, 200, "{}", response.value);
        assert_eq!(response.value["activated"], true);
        f.finish().await;
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_unrelated_preferences_survive_successful_setup_selection() {
    let f = Fixture::new(
        vec![json!({"name":"safe-local","digest":"fixture-digest"})],
        true,
    )
    .await;
    let scan = f.client.call("POST", "/api/setup/scan", None).await.value;
    let client = f.client.clone();
    let task = tokio::spawn(async move {
        client
            .call(
                "POST",
                "/api/setup/select",
                Some(json!({"candidateId":scan["candidates"][0]["id"],"consentTest":true})),
            )
            .await
    });
    until(|| f.provider.probes.load(Ordering::SeqCst) == 1).await;
    assert_eq!(
        f.client
            .call(
                "PATCH",
                "/api/settings",
                Some(json!({"companion":"manual-companion","allowNetwork":false}))
            )
            .await
            .status,
        200
    );
    f.provider.release.notify_one();
    let result = task.await.unwrap();
    assert_eq!(result.status, 200, "{}", result.value);
    let bootstrap = f.client.call("GET", "/api/bootstrap", None).await.value;
    assert_eq!(bootstrap["settings"]["model"], "safe-local");
    assert_eq!(bootstrap["settings"]["companion"], "manual-companion");
    assert_eq!(bootstrap["settings"]["allowNetwork"], false);
    assert!(!bootstrap["providers"]["profiles"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(bootstrap["setup"]["verified"], true);
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn http_network_revocation_cancels_selection_before_activation() {
    let f = Fixture::new(
        vec![json!({"name":"safe-local","digest":"fixture-digest"})],
        true,
    )
    .await;
    let scan = f.client.call("POST", "/api/setup/scan", None).await.value;
    let client = f.client.clone();
    let task = tokio::spawn(async move {
        client
            .call(
                "POST",
                "/api/setup/select",
                Some(json!({"candidateId":scan["candidates"][0]["id"],"consentTest":true})),
            )
            .await
    });
    until(|| f.provider.probes.load(Ordering::SeqCst) == 1).await;
    let stopped = f.client.call("PATCH", "/api/network", Some(json!({"expectedRevision":0,"patch":{"mode":"offline"}}))).await;
    assert_eq!(stopped.status, 200);
    let reply = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(reply.status, 403 | 499), "{}", reply.value);
    let bootstrap = f.client.call("GET", "/api/bootstrap", None).await.value;
    assert_eq!(bootstrap["settings"]["model"], "");
    assert!(bootstrap["providers"]["profiles"]
        .as_array()
        .unwrap()
        .is_empty());
    f.provider.release.notify_one();
    f.finish().await;
}
