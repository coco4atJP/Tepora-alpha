// Included in HTTP tests; all embedding sockets are ephemeral loopback fixtures.
#[tokio::test]
async fn semantic_routes_keep_auth_csrf_offline_gate_and_lossless_request_data() {
    let fake = Arc::new(Fake::default());
    let native = agent_state(fake.clone());
    for path in ["/api/semantic/index", "/api/semantic/search"] {
        let mut no_csrf = request("POST", path, "{}");
        no_csrf.headers_mut().remove("x-tepora-csrf");
        assert_eq!(native.clone().handle(no_csrf).await.status(), 403);
        assert_eq!(
            state(fake.clone())
                .handle(request("POST", path, "malformed unread body"))
                .await
                .status(),
            503
        );
        assert_eq!(
            native
                .clone()
                .handle(request(
                    "POST",
                    path,
                    r#"{"query":"\ud800","consent":true}"#
                ))
                .await
                .status(),
            200
        );
    }
    let calls = fake.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    for op in calls.iter() {
        let body = match op {
            Operation::SemanticIndex { body } | Operation::SemanticSearch { body } => body,
            _ => panic!("Wrong semantic operation"),
        };
        assert_eq!(
            tepora_core::json_codec::utf16_units(body["query"].as_str().unwrap()),
            vec![0xd800]
        );
        assert_eq!(body["consent"], true);
    }
}
#[derive(Default)]
struct SemanticWaitBackend {
    inner: Fake,
    tokens: Mutex<Vec<crate::network::RequestCancellation>>,
    hold: std::sync::atomic::AtomicBool,
}
impl Backend for SemanticWaitBackend {
    fn execute(&self, op: Operation) -> Result<Reply, ApiError> {
        self.inner.execute(op)
    }
    fn execute_semantic(
        &self,
        _: Operation,
        cancel: crate::network::RequestCancellation,
    ) -> crate::BackendFuture<'_> {
        self.tokens.lock().unwrap().push(cancel.clone());
        let hold = self.hold.load(Ordering::SeqCst);
        Box::pin(async move {
            if hold {
                return Err(cancel.cancelled().await.into());
            }
            tokio::task::yield_now().await;
            Ok(Reply::Json(json!({"ok":true})))
        })
    }
    fn subscribe(&self, r: EventRequest) -> Result<EventSubscription, ApiError> {
        self.inner.subscribe(r)
    }
    fn unsubscribe(&self, id: u64) {
        self.inner.unsubscribe(id)
    }
    fn stop(&self) -> Result<(), ApiError> {
        Ok(())
    }
    fn shutdown(&self) -> Result<(), ApiError> {
        Ok(())
    }
}
#[test]
fn semantic_http_waits_do_not_need_blocking_pool_and_request_drop_cancels_scope() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let backend = Arc::new(SemanticWaitBackend::default());
        let mut http = agent_state(Arc::new(Fake::default()));
        Arc::get_mut(&mut http).unwrap().backend = backend.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let blocker = tokio::task::spawn_blocking(move || rx.recv().unwrap());
        let response = tokio::time::timeout(
            Duration::from_secs(2),
            http.clone().handle(request(
                "POST",
                "/api/semantic/search",
                r#"{"query":"fixture"}"#,
            )),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), 200);
        backend.hold.store(true, Ordering::SeqCst);
        let owned = http.clone();
        let task = tokio::spawn(async move {
            owned
                .handle(request(
                    "POST",
                    "/api/semantic/search",
                    r#"{"query":"blocked"}"#,
                ))
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while backend.tokens.lock().unwrap().len() < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let token = backend.tokens.lock().unwrap()[1].clone();
        task.abort();
        assert!(task.await.err().unwrap().is_cancelled());
        assert!(token.is_cancelled());
        assert_eq!(http.work.count.load(Ordering::SeqCst), 0);
        tx.send(()).unwrap();
        blocker.await.unwrap();
    });
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn semantic_http_indexes_searches_and_revokes_through_real_checked_loopback_transport() {
    use crate::workspace::Workspace;
    use tepora_core::json_codec;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
    let hold = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let gate = Arc::new(Semaphore::new(0));
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel();
    let captured = seen.clone();
    let h = hold.clone();
    let g = gate.clone();
    let server = tokio::spawn(async move {
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {_=&mut stop_rx=>break,accepted=listener.accept()=>{
                let(socket,_)=accepted.unwrap();let captured=captured.clone();let h=h.clone();let g=g.clone();
                connections.spawn(async move{let service=service_fn(move|r:Request<Incoming>|{let captured=captured.clone();let h=h.clone();let g=g.clone();async move{
                    assert_eq!(r.uri().path(),"/v1/embeddings");let body=r.into_body().collect().await.unwrap().to_bytes();let wire=json_codec::parse(std::str::from_utf8(&body).unwrap()).unwrap();captured.lock().unwrap().push(wire.clone());
                    if h.swap(false,Ordering::SeqCst){let _permit=g.acquire().await.unwrap();}
                    let data=wire["input"].as_array().unwrap().iter().enumerate().map(|(index,v)|{let t=v.as_str().unwrap();json!({"index":index,"embedding":if t.contains("coffee")||t.contains("珈琲"){vec![1,0]}else{vec![0,1]}})}).collect::<Vec<_>>();
                    Ok::<_,Infallible>(Response::new(Full::new(Bytes::from(json_codec::stringify_js(&json!({"data":data})).unwrap()))))
                }});let _=hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(socket),service).await;});
            }}
        }
        connections.abort_all();
        while connections.join_next().await.is_some() {}
    });
    let root = std::env::temp_dir().join(format!("tepora-semantic-http-{}", uuid::Uuid::new_v4()));
    let workspace = Arc::new(Workspace::open(&root).unwrap());
    workspace
        .enable_agent(tokio::runtime::Handle::current())
        .unwrap();
    let mut http = agent_state(Arc::new(Fake::default()));
    Arc::get_mut(&mut http).unwrap().backend = workspace.clone();
    async fn call(http: &Arc<HttpState>, method: &str, path: &str, body: Value) -> (u16, Value) {
        let response = http
            .clone()
            .handle(request(
                method,
                path,
                tepora_core::json_codec::stringify_js(&body).unwrap(),
            ))
            .await;
        let status = response.status().as_u16();
        let raw = bytes(response).await;
        (
            status,
            tepora_core::json_codec::parse(std::str::from_utf8(&raw).unwrap()).unwrap(),
        )
    }
    let (_, memory) = call(
        &http,
        "POST",
        "/api/memories",
        json!({"content":"I enjoy coffee","scope":"private"}),
    )
    .await;
    let id = memory["id"].as_str().unwrap().to_owned();
    let (status,_)=call(&http,"PUT","/api/capabilities",json!({"expectedRevision":0,"config":{"profiles":[{"id":"embedding","protocol":"openai-embeddings","baseUrl":format!("http://{address}/v1"),"model":"fixture","domain":"device"}],"routes":{"embedding":"embedding"}}})).await;
    assert_eq!(status, 200);
    let (status, index) = call(&http, "POST", "/api/semantic/index", json!({})).await;
    assert_eq!(status, 200);
    assert_eq!(index["added"], 1);
    let (status, search) = call(
        &http,
        "POST",
        "/api/semantic/search",
        json!({"query":"珈琲"}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(search["hits"][0]["id"], id);
    assert_eq!(search["coverageComplete"], true);
    let (status, _) = call(
        &http,
        "PATCH",
        &format!("/api/memories/{id}"),
        json!({"content":"changed coffee"}),
    )
    .await;
    assert_eq!(status, 200);
    hold.store(true, Ordering::SeqCst);
    let h = http.clone();
    let waiting =
        tokio::spawn(async move { call(&h, "POST", "/api/semantic/index", json!({})).await });
    tokio::time::timeout(Duration::from_secs(3), async {
        while seen.lock().unwrap().len() < 3 {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        call(
            &http,
            "PATCH",
            &format!("/api/memories/{id}"),
            json!({"confirmed":false})
        )
        .await
        .0,
        200
    );
    let (status, _) = tokio::time::timeout(Duration::from_secs(3), waiting)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(status, 200);
    gate.add_permits(1);
    let cached = workspace
        .access()
        .agent_state("document.get", json!({"kind":"memory-vector","id":id}))
        .unwrap();
    assert_ne!(
        cached["contentHash"],
        crate::semantic::content_hash("changed coffee")
    );
    let shutdown = workspace.clone();
    tokio::task::spawn_blocking(move || shutdown.shutdown())
        .await
        .unwrap()
        .unwrap();
    drop(http);
    drop(workspace);
    let _ = stop_tx.send(());
    server.await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
