use super::*;
use crate::{
    capabilities::Capabilities,
    network::{
        Admitted, NativeNetwork, NetworkFuture, NetworkPolicy, NetworkRequest, Resolver, Transport,
        TransportResponse,
    },
    workspace::Workspace,
    Backend, Operation as ApiOperation, Reply,
};
use bytes::Bytes;
use hyper::HeaderMap;
use std::{collections::VecDeque, path::PathBuf};
use tokio::sync::Semaphore;
struct NoDns;
impl Resolver for NoDns {
    fn lookup<'a>(&'a self, _: &'a str) -> NetworkFuture<'a, Vec<String>> {
        Box::pin(async { panic!("Semantic fixtures cannot resolve external hosts") })
    }
}
#[derive(Clone)]
enum Plan {
    Auto,
    Held(Arc<Semaphore>),
    Malformed(Value),
}
#[derive(Default)]
struct Script {
    records: Mutex<Vec<Value>>,
    plans: Mutex<VecDeque<Plan>>,
    connect: Mutex<Option<Arc<Semaphore>>>,
}
impl Transport for Script {
    fn request<'a>(
        &'a self,
        admitted: Admitted,
        request: NetworkRequest,
        cancel: RequestCancellation,
    ) -> NetworkFuture<'a, TransportResponse> {
        Box::pin(async move {
            // This seam models a TCP/TLS wait before any payload has left the client.
            let connect = self.connect.lock().unwrap().take();
            if let Some(gate) = connect {
                tokio::select! {_=gate.acquire()=>{},error=cancel.cancelled()=>return Err(error)}
            }
            admitted.check_egress()?;
            let wire = json_codec::parse(std::str::from_utf8(&request.body).unwrap()).unwrap();
            self.records.lock().unwrap().push(wire.clone());
            let plan = self.plans.lock().unwrap().pop_front().unwrap_or(Plan::Auto);
            let body = match plan {
                Plan::Malformed(body) => body,
                other => {
                    if let Plan::Held(gate) = other {
                        tokio::select! {_=gate.acquire()=>{},error=cancel.cancelled()=>return Err(error)}
                    }
                    let vectors = wire["input"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| {
                            let t = v.as_str().unwrap();
                            if t.contains("coffee") || t.contains("珈琲") {
                                json!([1.0, 0.0])
                            } else {
                                json!([0.0, 1.0])
                            }
                        })
                        .collect::<Vec<_>>();
                    if admitted.url.path().ends_with("/embed") {
                        json!({"embeddings":vectors})
                    } else {
                        json!({"data":vectors.iter().enumerate().map(|(index,embedding)|json!({"index":index,"embedding":embedding})).collect::<Vec<_>>()})
                    }
                }
            };
            Ok(TransportResponse {
                status: 200,
                headers: HeaderMap::new(),
                body: Some(Box::pin(futures_util::stream::iter(vec![Ok(Bytes::from(
                    json_codec::stringify_js(&body).unwrap(),
                ))]))),
            })
        })
    }
}
struct Fixture {
    root: PathBuf,
    workspace: Workspace,
    network: NativeNetwork,
    capabilities: Capabilities,
    semantic: SemanticMemory,
    script: Arc<Script>,
}
impl Fixture {
    fn new(configured: bool) -> Self {
        let root = std::env::temp_dir().join(format!("tepora-semantic-{}", uuid::Uuid::new_v4()));
        let workspace = Workspace::open(&root).unwrap();
        let script = Arc::new(Script::default());
        let network = NativeNetwork::with_components(
            NetworkPolicy::default(),
            Arc::new(NoDns),
            script.clone(),
        );
        let capabilities = Capabilities::new(Arc::new(workspace.access()), network.clone());
        let semantic = SemanticMemory::new(Arc::new(workspace.access()), capabilities.clone());
        let f = Self {
            root,
            workspace,
            network,
            capabilities,
            semantic,
            script,
        };
        if configured {
            f.install("device", "model", 0);
        }
        f
    }
    fn install(&self, domain: &str, model: &str, revision: u64) {
        let base = if domain == "device" {
            "http://127.0.0.1:17777/v1"
        } else {
            "http://10.0.0.2:17777/v1"
        };
        self.capabilities.save(&json!({"profiles":[{"id":"embedding","protocol":"openai-embeddings","model":model,"baseUrl":base,"domain":domain,"resource":"semantic","maxParallel":1,"pinnedAddress":if domain=="lan"{json!("10.0.0.2")}else{Value::Null},"allowPlainHttp":domain=="lan"}],"routes":{"embedding":"embedding"}}),revision).unwrap();
    }
    fn state(&self, op: &str, args: Value) -> Value {
        self.workspace.access().agent_state(op, args).unwrap()
    }
    fn memory(&self, content: &str, scope: &str) -> Value {
        match self
            .workspace
            .execute(ApiOperation::MemoryCreate {
                body: json!({"content":content,"scope":scope}),
            })
            .unwrap()
        {
            Reply::Json(v) => v,
            _ => panic!(),
        }
    }
    fn patch(&self, id: &str, patch: Value) {
        self.workspace
            .execute(ApiOperation::MemoryPatch {
                id: id.into(),
                body: patch,
            })
            .unwrap();
    }
    async fn wait(&self, condition: impl Fn() -> bool) {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while !condition() {
                tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap();
    }
    async fn close(&self) {
        self.semantic.close_and_drain().await;
        self.capabilities.close();
        self.network.close();
        assert_eq!(self.semantic.active_count(), 0);
        self.workspace.shutdown().unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.semantic.close();
        self.capabilities.close();
        self.network.close();
        let _ = self.workspace.shutdown();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn access_external() -> Access {
    Access {
        allow_external: true,
        ..Default::default()
    }
}
struct FrozenDocuments(Vec<Value>);
impl SemanticState for FrozenDocuments {
    fn snapshot(&self) -> Result<MemorySnapshot, ApiError> {
        Ok(MemorySnapshot {
            documents: self.0.clone(),
            ..Default::default()
        })
    }
    fn current(&self, ids: &[String]) -> Result<Vec<Value>, ApiError> {
        Ok(self
            .0
            .iter()
            .filter(|v| ids.iter().any(|id| v["id"] == *id))
            .cloned()
            .collect())
    }
    fn commit_vectors(&self, _: &Value, _: &[VectorProposal]) -> Result<usize, ApiError> {
        panic!("Frozen lexical oracle cannot write vectors")
    }
}
#[tokio::test]
async fn frozen_source_queries_privacy_limits_utf16_and_cosine() {
    let oracle = json_codec::parse(include_str!("fixtures/source.json")).unwrap();
    let f = Fixture::new(false);
    for case in oracle["search"].as_array().unwrap() {
        let semantic = SemanticMemory::new(
            Arc::new(FrozenDocuments(case["docs"].as_array().unwrap().clone())),
            f.capabilities.clone(),
        );
        let options = &case["options"];
        let access = Access {
            recipient_private: options["recipientPrivate"] != false,
            share: options["share"] == true,
            ..Default::default()
        };
        let result = semantic
            .search(
                &case["query"],
                SearchOptions {
                    access,
                    limit: options["limit"].as_u64().unwrap_or(8) as usize,
                },
                &RequestCancellation::new(),
            )
            .await;
        if let Some(expected) = case.get("error") {
            let error = result.unwrap_err();
            assert_eq!(
                json!({"status":error.status,"message":error.message}),
                *expected
            );
        } else {
            assert_eq!(
                result.unwrap(),
                case["result"],
                "query {} options {}",
                case["query"],
                options
            );
        }
    }
    for case in oracle["hash"].as_array().unwrap() {
        assert_eq!(
            content_hash(case["content"].as_str().unwrap()),
            case["result"]
        );
    }
    for case in oracle["cosine"].as_array().unwrap() {
        match cosine(&case["a"], &case["b"]) {
            Ok(v) => {
                if case["result"].is_null() {
                    assert!(!v.is_finite());
                } else {
                    assert!((v - case["result"].as_f64().unwrap()).abs() < 1e-14);
                }
            }
            Err(e) => assert_eq!(
                json!({"status":e.status,"message":e.message}),
                case["error"]
            ),
        }
    }
    assert!(f.script.records.lock().unwrap().is_empty());
    f.close().await;
}
#[tokio::test]
async fn concepts_use_valid_cache_and_content_identity_dimension_changes_invalidate() {
    let f = Fixture::new(true);
    let m = f.memory("I enjoy coffee", "private");
    let cancel = RequestCancellation::new();
    assert_eq!(
        f.semantic.index(Access::default(), &cancel).await.unwrap()["added"],
        1
    );
    let result = f
        .semantic
        .search(&json!("珈琲"), SearchOptions::default(), &cancel)
        .await
        .unwrap();
    assert_eq!(result["hits"][0]["id"], m["id"]);
    assert_eq!(result["coverageComplete"], true);
    assert_eq!(result["automaticLearning"], false);
    assert_eq!(
        f.semantic.index(Access::default(), &cancel).await.unwrap(),
        json!({"indexed":1,"remaining":0})
    );
    f.patch(m["id"].as_str().unwrap(), json!({"content":"I enjoy tea"}));
    let result = f
        .semantic
        .search(&json!("珈琲"), SearchOptions::default(), &cancel)
        .await
        .unwrap();
    assert_eq!(result["indexed"], 0);
    assert_eq!(result["hits"], json!([]));
    f.semantic.index(Access::default(), &cancel).await.unwrap();
    f.install("device", "new-model", 1);
    assert_eq!(
        f.semantic
            .search(&json!("tea"), SearchOptions::default(), &cancel)
            .await
            .unwrap()["indexed"],
        0
    );
    assert_eq!(
        f.semantic.index(Access::default(), &cancel).await.unwrap()["added"],
        1
    );
    let mut vector = f.state("document.get", json!({"kind":"memory-vector","id":m["id"]}));
    vector["dimensions"] = json!(3);
    f.state("document.put", json!({"kind":"memory-vector","doc":vector}));
    assert_eq!(
        f.semantic
            .search(&json!("tea"), SearchOptions::default(), &cancel)
            .await
            .unwrap()["indexed"],
        0
    );
    f.close().await;
}
#[tokio::test]
async fn external_index_needs_consent_and_only_shared_confirmed_content_is_transmitted() {
    let f = Fixture::new(false);
    f.install("lan", "model", 0);
    let private = f.memory("private coffee", "private");
    let shared = f.memory("shared coffee", "shared");
    let unconfirmed = f.memory("unconfirmed coffee", "shared");
    f.patch(
        unconfirmed["id"].as_str().unwrap(),
        json!({"confirmed":false}),
    );
    let cancel = RequestCancellation::new();
    assert_eq!(
        f.semantic
            .index(Access::default(), &cancel)
            .await
            .unwrap_err()
            .status,
        403
    );
    assert!(f.script.records.lock().unwrap().is_empty());
    f.semantic.index(access_external(), &cancel).await.unwrap();
    assert_eq!(
        f.script.records.lock().unwrap()[0]["input"],
        json!(["shared coffee"])
    );
    let result = f
        .semantic
        .search(&json!("coffee"), SearchOptions::default(), &cancel)
        .await
        .unwrap();
    assert_eq!(result["indexed"], 0);
    assert_eq!(result["hits"].as_array().unwrap().len(), 2);
    assert_eq!(f.script.records.lock().unwrap().len(), 1);
    let result = f
        .semantic
        .search(
            &json!("coffee"),
            SearchOptions {
                access: Access {
                    recipient_private: false,
                    share: true,
                    allow_external: true,
                },
                limit: 8,
            },
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(result["hits"].as_array().unwrap().len(), 1);
    assert_eq!(result["hits"][0]["id"], shared["id"]);
    assert_ne!(result["hits"][0]["id"], private["id"]);
    f.close().await;
}
#[tokio::test]
async fn batch_24_full_hash_utf16_truncation_busy_and_post_response_document_recheck() {
    let f = Fixture::new(true);
    let long = format!("{}😀tail", "a".repeat(11999));
    let first = f.memory(&long, "private");
    for n in 0..24 {
        f.memory(&format!("tea {n}"), "private");
    }
    let gate = Arc::new(Semaphore::new(0));
    f.script
        .plans
        .lock()
        .unwrap()
        .push_back(Plan::Held(gate.clone()));
    let owner = f.semantic.clone();
    let index = tokio::spawn(async move {
        owner
            .index(Access::default(), &RequestCancellation::new())
            .await
    });
    f.wait(|| f.script.records.lock().unwrap().len() == 1).await;
    assert_eq!(
        f.semantic
            .index(Access::default(), &RequestCancellation::new())
            .await
            .unwrap_err()
            .status,
        429
    );
    let sent = f.script.records.lock().unwrap()[0]["input"].clone();
    assert_eq!(sent.as_array().unwrap().len(), 24);
    // Modify a document already sent. It must not receive a stale cache result.
    let snapshot = f.workspace.access().snapshot().unwrap();
    let changed = snapshot
        .documents
        .iter()
        .find(|d| {
            sent.as_array()
                .unwrap()
                .contains(&json!(slice(text(d, "content"), 12000)))
        })
        .unwrap();
    f.patch(id(changed), json!({"scope":"shared"}));
    gate.add_permits(1);
    let result = index.await.unwrap().unwrap();
    assert_eq!(result["added"], 23);
    assert_eq!(result["remaining"], 2);
    f.semantic
        .index(Access::default(), &RequestCancellation::new())
        .await
        .unwrap();
    let vector = f.state(
        "document.get",
        json!({"kind":"memory-vector","id":first["id"]}),
    );
    assert_eq!(vector["contentHash"], content_hash(&long));
    assert!(f
        .script
        .records
        .lock()
        .unwrap()
        .iter()
        .flat_map(|r| r["input"].as_array().unwrap())
        .any(|s| utf16_units(s.as_str().unwrap()).len() == 12000));
    f.close().await;
}
#[tokio::test]
async fn resource_queue_rechecks_doc_privacy_before_sending_any_old_payload() {
    let f = Fixture::new(false);
    f.install("lan", "model", 0);
    let m = f.memory("shared secret coffee", "shared");
    let gate = Arc::new(Semaphore::new(0));
    f.script
        .plans
        .lock()
        .unwrap()
        .push_back(Plan::Held(gate.clone()));
    let cap = f.capabilities.clone();
    let filler = tokio::spawn(async move {
        cap.embed(&json!(["filler"]), None, &RequestCancellation::new())
            .await
    });
    f.wait(|| f.script.records.lock().unwrap().len() == 1).await;
    let semantic = f.semantic.clone();
    let index = tokio::spawn(async move {
        semantic
            .index(access_external(), &RequestCancellation::new())
            .await
    });
    f.wait(|| f.semantic.active_count() == 1).await;
    f.patch(m["id"].as_str().unwrap(), json!({"scope":"private"}));
    gate.add_permits(1);
    filler.await.unwrap().unwrap();
    let e = index.await.unwrap().unwrap_err();
    assert!(e.blocked);
    assert_eq!(f.script.records.lock().unwrap().len(), 1);
    f.close().await;
}
#[tokio::test]
async fn connect_wait_rechecks_deletion_before_actual_http_dispatch() {
    let f = Fixture::new(true);
    let m = f.memory("never send after deletion", "private");
    let gate = Arc::new(Semaphore::new(0));
    *f.script.connect.lock().unwrap() = Some(gate.clone());
    let semantic = f.semantic.clone();
    let index = tokio::spawn(async move {
        semantic
            .index(Access::default(), &RequestCancellation::new())
            .await
    });
    f.wait(|| f.script.connect.lock().unwrap().is_none()).await;
    f.workspace
        .execute(ApiOperation::MemoryDelete { id: id(&m).into() })
        .unwrap();
    gate.add_permits(1);
    assert!(index.await.unwrap().unwrap_err().blocked);
    assert!(f.script.records.lock().unwrap().is_empty());
    f.close().await;
}
#[tokio::test]
async fn revocation_and_caller_cancellation_never_publish_vectors_or_poison_next_index() {
    let f = Fixture::new(true);
    let m = f.memory("coffee", "private");
    let gate = Arc::new(Semaphore::new(0));
    f.script.plans.lock().unwrap().push_back(Plan::Held(gate));
    let token = RequestCancellation::new();
    let c = token.clone();
    let owner = f.semantic.clone();
    let task = tokio::spawn(async move { owner.index(Access::default(), &c).await });
    f.wait(|| f.script.records.lock().unwrap().len() == 1).await;
    token.cancel();
    assert!(task.await.unwrap().unwrap_err().cancelled);
    assert!(f
        .state("document.get", json!({"kind":"memory-vector","id":m["id"]}))
        .is_null());
    assert_eq!(
        f.semantic
            .index(Access::default(), &RequestCancellation::new())
            .await
            .unwrap()["added"],
        1
    );
    f.patch(id(&m), json!({"content":"new coffee"}));
    let gate = Arc::new(Semaphore::new(0));
    f.script.plans.lock().unwrap().push_back(Plan::Held(gate));
    let owner = f.semantic.clone();
    let task = tokio::spawn(async move {
        owner
            .index(Access::default(), &RequestCancellation::new())
            .await
    });
    f.wait(|| f.script.records.lock().unwrap().len() == 3).await;
    f.capabilities
        .save(&json!({"profiles":[],"routes":{}}), 1)
        .unwrap();
    assert!(task.await.unwrap().is_err());
    assert_ne!(
        f.state("document.get", json!({"kind":"memory-vector","id":m["id"]}))["contentHash"],
        content_hash("new coffee")
    );
    f.close().await;
}
#[tokio::test]
async fn malformed_vectors_fall_back_lexically_and_rank_limits_are_enforced() {
    let f = Fixture::new(true);
    let m = f.memory("coffee", "private");
    f.script.plans.lock().unwrap().push_back(Plan::Malformed(
        json!({"data":[{"index":0,"embedding":[0,0]}]}),
    ));
    let result = f
        .semantic
        .search(
            &json!("coffee"),
            SearchOptions::default(),
            &RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["hits"][0]["id"], m["id"]);
    assert!(result["note"].as_str().unwrap().contains("使えない"));
    let ranking = f
        .semantic
        .rank(
            &json!("珈琲"),
            &json!(["tea", "coffee"]),
            None,
            &RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(ranking[0]["index"], 1);
    assert_eq!(ranking[0]["similarity"], 1.0);
    assert_eq!(
        f.semantic
            .rank(&json!("q"), &json!([]), None, &RequestCancellation::new())
            .await
            .unwrap_err()
            .status,
        400
    );
    f.close().await;
}
#[tokio::test]
async fn background_index_is_bounded_receipt_independent_and_shutdown_drained() {
    let f = Fixture::new(true);
    let m = f.memory("coffee", "private");
    let gate = Arc::new(Semaphore::new(0));
    f.script.plans.lock().unwrap().push_back(Plan::Held(gate));
    for _ in 0..100 {
        f.semantic
            .schedule_index(&tokio::runtime::Handle::current());
    }
    f.wait(|| f.script.records.lock().unwrap().len() == 1).await;
    assert_eq!(f.semantic.active_count(), 1);
    // This is the synchronous hook used after a committed privacy mutation.
    f.patch(id(&m), json!({"confirmed":false}));
    f.semantic.invalidate_memory(id(&m));
    f.semantic.close_and_drain().await;
    assert_eq!(f.semantic.active_count(), 0);
    assert!(f
        .state("document.get", json!({"kind":"memory-vector","id":m["id"]}))
        .is_null());
    f.close().await;
}

#[tokio::test]
async fn stop_cancels_unpolled_background_job_and_allows_later_index() {
    let f = Fixture::new(true);
    let m = f.memory("coffee", "private");
    // On this current-thread executor the spawned task cannot start before Stop.
    f.semantic
        .schedule_index(&tokio::runtime::Handle::current());
    f.semantic.cancel_all();
    tokio::task::yield_now().await;
    assert!(f.script.records.lock().unwrap().is_empty());
    assert!(f
        .state("document.get", json!({"kind":"memory-vector","id":m["id"]}))
        .is_null());
    assert_eq!(
        f.semantic
            .index(Access::default(), &RequestCancellation::new())
            .await
            .unwrap()["added"],
        1
    );
    f.close().await;
}

#[tokio::test]
async fn close_drains_foreground_operations_before_returning() {
    let f = Fixture::new(true);
    f.memory("coffee", "private");
    f.script
        .plans
        .lock()
        .unwrap()
        .push_back(Plan::Held(Arc::new(Semaphore::new(0))));
    let semantic = f.semantic.clone();
    let task = tokio::spawn(async move {
        semantic
            .index(Access::default(), &RequestCancellation::new())
            .await
    });
    f.wait(|| f.script.records.lock().unwrap().len() == 1).await;
    f.semantic.close_and_drain().await;
    assert_eq!(f.semantic.active_count(), 0);
    assert!(task.await.unwrap().is_err());
    f.close().await;
}

#[tokio::test]
async fn session_stop_cancels_only_its_background_index_and_keeps_foreground_search() {
    let f = Fixture::new(true);
    f.memory("coffee", "private");
    let gate = Arc::new(Semaphore::new(0));
    f.script
        .plans
        .lock()
        .unwrap()
        .push_back(Plan::Held(gate.clone()));
    let semantic = f.semantic.clone();
    let search = tokio::spawn(async move {
        semantic
            .search(
                &json!("coffee"),
                SearchOptions::default(),
                &RequestCancellation::new(),
            )
            .await
    });
    f.wait(|| f.script.records.lock().unwrap().len() == 1).await;
    f.semantic
        .schedule_index_for(&tokio::runtime::Handle::current(), Some("worker"));
    f.semantic.cancel_session("unrelated");
    f.semantic.cancel_session("worker");
    assert!(!search.is_finished());
    gate.add_permits(1);
    assert_eq!(
        search.await.unwrap().unwrap()["hits"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    tokio::task::yield_now().await;
    assert_eq!(f.script.records.lock().unwrap().len(), 1);
    f.close().await;
}

#[tokio::test]
async fn coalesced_background_index_survives_until_its_last_owner_stops() {
    let f = Fixture::new(true);
    let memory = f.memory("coffee", "private");
    let gate = Arc::new(Semaphore::new(0));
    f.script
        .plans
        .lock()
        .unwrap()
        .push_back(Plan::Held(gate.clone()));
    let executor = tokio::runtime::Handle::current();
    f.semantic.schedule_index_for(&executor, Some("session-a"));
    f.semantic.schedule_index_for(&executor, Some("session-b"));
    f.wait(|| f.script.records.lock().unwrap().len() == 1).await;
    f.semantic.cancel_session("session-a");
    tokio::task::yield_now().await;
    assert_eq!(f.semantic.active_count(), 1);
    assert!(!f
        .semantic
        .inner
        .background
        .lock()
        .unwrap()
        .cancel
        .as_ref()
        .unwrap()
        .is_cancelled());
    f.semantic.cancel_session("session-b");
    f.wait(|| f.semantic.active_count() == 0).await;
    gate.add_permits(1);
    assert!(f
        .state(
            "document.get",
            json!({"kind":"memory-vector","id":memory["id"]})
        )
        .is_null());
    f.close().await;
}
