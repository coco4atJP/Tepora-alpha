use super::*;
use crate::network::{
    Admitted, ByteStream, NativeNetwork, NetworkFuture, NetworkPolicy, NetworkRequest,
    RequestCancellation, Resolver, Transport, TransportResponse,
};
use serde_json::json;
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::Notify;

struct Data {
    settings: Value,
    registry: Value,
    probe: Value,
    transfer: Value,
    dismissed: bool,
    busy: bool,
    events: Vec<(String, Value)>,
    commits: usize,
}
struct State(Mutex<Data>);
impl Default for State {
    fn default() -> Self {
        Self(Mutex::new(Data {
            settings: tepora_core::store_domain::default_settings(),
            registry: json!({"schema":2,"revision":0,"profiles":[],"routes":{}}),
            probe: Value::Null,
            transfer: Value::Null,
            dismissed: false,
            busy: false,
            events: vec![],
            commits: 0,
        }))
    }
}
impl SetupState for State {
    fn capture(&self) -> Result<SetupStored, ApiError> {
        let d = self.0.lock().unwrap();
        Ok(SetupStored {
            settings: d.settings.clone(),
            model_probe: d.probe.clone(),
            dismissed: d.dismissed,
            transfer: d.transfer.clone(),
            first_result: None,
        })
    }
    fn selection_context(&self) -> Result<SelectionContext, ApiError> {
        let d = self.0.lock().unwrap();
        Ok(SelectionContext {
            settings: d.settings.clone(),
            registry_revision: d.registry["revision"].as_u64().unwrap(),
            registry_configured: !d.registry["profiles"].as_array().unwrap().is_empty(),
            busy: d.busy,
        })
    }
    fn activate_selection(&self, commit: SelectionCommit) -> Result<(), ApiError> {
        let mut d = self.0.lock().unwrap();
        if let Some(error) = commit.cancellation.error() {
            return Err(error.into());
        }
        if d.busy {
            return Err(ApiError::new(
                409,
                "確認中に仕事が始まったため切り替えていません。",
            ));
        }
        if configuration(&d.settings)? != commit.expected_configuration {
            return Err(ApiError::new(409, "設定が変更されました。"));
        }
        if d.registry["revision"] != commit.expected_registry_revision {
            return Err(ApiError::new(409, "接続設定が変更されました。"));
        }
        d.settings = commit.settings;
        d.probe = commit.report;
        d.registry = crate::provider::validate_registry(&commit.registry)?;
        d.registry["revision"] = json!(commit.expected_registry_revision + 1);
        d.registry["schema"] = json!(2);
        d.commits += 1;
        Ok(())
    }
    fn save_transfer(&self, value: Value) -> Result<(), ApiError> {
        let mut d = self.0.lock().unwrap();
        d.transfer = value.clone();
        d.events.push(("setup.transfer".into(), value));
        Ok(())
    }
    fn dismiss(&self) -> Result<(), ApiError> {
        self.0.lock().unwrap().dismissed = true;
        Ok(())
    }
    fn emit_snapshot(&self, value: Value) -> Result<(), ApiError> {
        self.0
            .lock()
            .unwrap()
            .events
            .push(("setup.updated".into(), value));
        Ok(())
    }
}
#[derive(Clone, Copy)]
enum Mode {
    Normal,
    BadProbe,
    SlowProbe,
    SlowPull,
    MissingSuccess,
    OverBudget,
    BadCounts,
    RemoteOnly,
    InvalidUtf8,
    TruncatedJson,
}
struct Fake {
    mode: Mode,
    models: Mutex<Vec<Value>>,
    requests: Mutex<Vec<(String, NetworkRequest)>>,
    probe_calls: AtomicUsize,
    release: Notify,
}
impl Resolver for Fake {
    fn lookup<'a>(&'a self, _: &'a str) -> NetworkFuture<'a, Vec<String>> {
        Box::pin(async { panic!("setup fixtures use literal loopback only") })
    }
}
impl Transport for Fake {
    fn request<'a>(
        &'a self,
        a: Admitted,
        r: NetworkRequest,
        c: RequestCancellation,
    ) -> NetworkFuture<'a, TransportResponse> {
        Box::pin(async move {
            assert!(a.address.is_loopback());
            assert!(
                !r.headers.contains_key("authorization"),
                "first-use candidates never inherit live or environment credentials"
            );
            let path = a.url.path().to_owned();
            self.requests
                .lock()
                .unwrap()
                .push((path.clone(), r.clone()));
            let bytes = if path.ends_with("/api/tags") {
                serde_json::to_vec(&json!({"models":self.models.lock().unwrap().clone()})).unwrap()
            } else if path.ends_with("/models") {
                serde_json::to_vec(
                    &json!({"data":[{"id":"local-one"},{"id":4},{"id":"local-two"}]}),
                )
                .unwrap()
            } else if path.ends_with("/api/pull") {
                let input: Value = serde_json::from_slice(&r.body).unwrap();
                assert_eq!(input["insecure"], false);
                assert_eq!(input["stream"], true);
                assert_eq!(input["model"], model_catalog()[0]["model"]);
                if matches!(self.mode, Mode::SlowPull) {
                    return Ok(TransportResponse {
                        status: 200,
                        headers: hyper::HeaderMap::new(),
                        body: Some(Box::pin(futures_util::stream::pending())),
                    });
                }
                let model = json!({"name":input["model"],"digest":"download-digest","size":10,"remote_host":if matches!(self.mode,Mode::RemoteOnly){json!("remote")}else{Value::Null}});
                *self.models.lock().unwrap() = vec![model];
                match self.mode {
    Mode::MissingSuccess=>b"{\"status\":\"pulling\"}\n".to_vec(),
    Mode::OverBudget=>b"{\"digest\":\"a\",\"total\":4000000001,\"completed\":0}\n".to_vec(),
    Mode::BadCounts=>b"{\"digest\":\"a\",\"total\":10,\"completed\":11}\n".to_vec(),
    Mode::InvalidUtf8=>vec![0xff,b'\n'],Mode::TruncatedJson=>b"{\"status\":".to_vec(),
    _=>"{\"status\":\"取得中\",\"digest\":\"a\",\"total\":10,\"completed\":5}\n{\"digest\":\"a\",\"total\":10,\"completed\":10}\n{\"status\":\"success\"}\n".as_bytes().to_vec(),
   }
            } else if path.ends_with("/chat/completions") {
                let index = self.probe_calls.fetch_add(1, Ordering::SeqCst);
                if index == 0 && matches!(self.mode, Mode::SlowProbe) {
                    tokio::select! {error=c.cancelled()=>return Err(error),_=self.release.notified()=>{}}
                }
                let input: Value = serde_json::from_slice(&r.body).unwrap();
                let messages = input["messages"].as_array().unwrap();
                let answer = if matches!(self.mode, Mode::BadProbe) {
                    json!({"content":"no tool"})
                } else if index == 0 {
                    let challenge = messages
                        .iter()
                        .find_map(|m| {
                            m["content"]
                                .as_str()
                                .and_then(|s| s.strip_prefix("Challenge: "))
                        })
                        .unwrap();
                    json!({"role":"assistant","content":null,"tool_calls":[{"id":"safe-call","type":"function","function":{"name":"tepora_probe","arguments":serde_json::to_string(&json!({"challenge":challenge})).unwrap()}}]})
                } else {
                    let tool = messages.iter().find(|m| m["role"] == "tool").unwrap();
                    let result: Value =
                        serde_json::from_str(tool["content"].as_str().unwrap()).unwrap();
                    json!({"role":"assistant","content":result["receipt"]})
                };
                serde_json::to_vec(&json!({"choices":[{"message":answer,"finish_reason":"stop"}]}))
                    .unwrap()
            } else {
                panic!("Unexpected setup path {path}")
            };
            let chunks = bytes
                .chunks(3)
                .map(|b| Ok(bytes::Bytes::copy_from_slice(b)))
                .collect::<Vec<_>>();
            let body: ByteStream = Box::pin(futures_util::stream::iter(chunks));
            let mut headers = hyper::HeaderMap::new();
            headers.insert(
                "content-type",
                hyper::header::HeaderValue::from_static("application/json"),
            );
            Ok(TransportResponse {
                status: 200,
                headers,
                body: Some(body),
            })
        })
    }
}
fn fixture(mode: Mode, models: Vec<Value>) -> (SetupManager, Arc<State>, Arc<Fake>, NativeNetwork) {
    let state = Arc::new(State::default());
    let fake = Arc::new(Fake {
        mode,
        models: Mutex::new(models),
        requests: Mutex::new(vec![]),
        probe_calls: AtomicUsize::new(0),
        release: Notify::new(),
    });
    let network =
        NativeNetwork::with_components(NetworkPolicy::default(), fake.clone(), fake.clone());
    let options = SetupOptions {
        providers: vec![
            json!({"id":"ollama","name":"Ollama fixture","url":"http://127.0.0.1:11434/v1"}),
        ],
        ram_gib: Some(16),
        probe_timeout: Duration::from_secs(3),
        download_idle: Duration::from_secs(3),
        download_timeout: Duration::from_secs(10),
        ..Default::default()
    };
    let manager = SetupManager::with_options(
        state.clone(),
        network.clone(),
        tokio::runtime::Handle::current(),
        options,
    )
    .unwrap();
    (manager, state, fake, network)
}
async fn until(mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !predicate() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
fn local_model() -> Value {
    json!({"name":"safe-local","digest":"fixture-digest","size":10})
}

#[tokio::test]
async fn reads_dismiss_and_restart_recovery_never_discover_download_or_probe() {
    let (manager, state, fake, network) = fixture(Mode::Normal, vec![]);
    assert_eq!(manager.snapshot().unwrap()["stage"], "connect");
    assert_eq!(manager.snapshot().unwrap()["ramGiB"], 16);
    assert_eq!(manager.dismiss().unwrap()["dismissed"], true);
    assert!(fake.requests.lock().unwrap().is_empty());
    state
        .save_transfer(json!({"id":"old","status":"downloading"}))
        .unwrap();
    let recovered = SetupManager::with_options(
        state.clone(),
        network,
        tokio::runtime::Handle::current(),
        SetupOptions::default(),
    )
    .unwrap();
    assert_eq!(
        recovered.snapshot().unwrap()["transfer"]["status"],
        "interrupted"
    );
    assert!(fake.requests.lock().unwrap().is_empty());
    recovered.close().await;
    manager.close().await;
}
#[tokio::test]
async fn explicit_download_then_real_safe_probe_activates_once_without_inheriting_credentials() {
    let (manager, state, fake, _) = fixture(Mode::Normal, vec![]);
    state.0.lock().unwrap().settings["apiKeyEnv"] = json!("PATH");
    let scan = manager.scan().await.unwrap();
    assert_eq!(scan["engines"].as_array().unwrap().len(), 1);
    assert!(scan["candidates"].as_array().unwrap().is_empty());
    let mut input = json!({"engineId":scan["engines"][0]["id"],"catalogId":"compact"});
    assert_eq!(manager.install(&input).unwrap_err().status, 403);
    input["consentDownload"] = json!(true);
    assert_eq!(manager.install(&input).unwrap()["status"], "downloading");
    manager.wait_idle().await;
    assert_eq!(state.0.lock().unwrap().transfer["status"], "downloaded");
    assert_eq!(state.0.lock().unwrap().transfer["completedBytes"], 10);
    let snapshot = manager.snapshot().unwrap();
    let id = snapshot["candidates"][0]["id"].as_str().unwrap();
    assert_eq!(manager.select(id, false).await.unwrap_err().status, 403);
    let result = manager.select(id, true).await.unwrap();
    assert_eq!(result["activated"], true);
    assert_eq!(fake.probe_calls.load(Ordering::SeqCst), 2);
    {
        let data = state.0.lock().unwrap();
        assert_eq!(data.commits, 1);
        assert_eq!(data.registry["profiles"][0]["apiKeyEnv"], "");
        assert_eq!(data.settings["apiKeyEnv"], "");
        assert_eq!(
            data.probe["destination"],
            destination(&data.settings).unwrap()
        );
    }
    assert_eq!(manager.snapshot().unwrap()["verified"], true);
    assert_eq!(manager.snapshot().unwrap()["stage"], "connected");
    assert_eq!(manager.select(id, true).await.unwrap_err().status, 409);
    manager.close().await;
}
#[tokio::test]
async fn discovery_excludes_remote_ollama_models_and_runtime_discovery_retains_fixed_provider_order(
) {
    let (manager, _, fake, network) = fixture(
        Mode::Normal,
        vec![
            local_model(),
            json!({"name":"remote:cloud"}),
            json!({"name":"remote","remote_model":"qwen"}),
            json!({"name":"remote2","remote_host":"host"}),
        ],
    );
    let scan = manager.scan().await.unwrap();
    assert_eq!(scan["candidates"].as_array().unwrap().len(), 1);
    assert!(scan["candidates"][0].get("expiresAt").is_none());
    let rows = crate::runtime_discovery::discover(&network, &RequestCancellation::new()).await;
    assert_eq!(rows.as_array().unwrap().len(), 4);
    assert_eq!(rows[0]["id"], "llama.cpp");
    assert_eq!(rows[2]["id"], "ollama");
    assert_eq!(rows[0]["models"], json!(["local-one", "local-two"]));
    assert_eq!(fake.requests.lock().unwrap().len(), 5);
    manager.close().await;
}
#[tokio::test]
async fn canceled_failed_stale_and_busy_probes_never_change_live_settings_or_registry() {
    for case in [
        "failed",
        "cancelled",
        "settings",
        "registry",
        "busy",
        "digest",
        "closed",
    ] {
        let mode = if case == "failed" {
            Mode::BadProbe
        } else {
            Mode::SlowProbe
        };
        let (manager, state, fake, _) = fixture(mode, vec![local_model()]);
        let scan = manager.scan().await.unwrap();
        let id = scan["candidates"][0]["id"].as_str().unwrap().to_owned();
        let m = manager.clone();
        let task = tokio::spawn(async move { m.select(&id, true).await });
        until(|| fake.probe_calls.load(Ordering::SeqCst) > 0).await;
        match case {
            "cancelled" => {
                manager.stop();
            }
            "closed" => manager.begin_close(),
            "settings" => state.0.lock().unwrap().settings["model"] = json!("manual-choice"),
            "registry" => state.0.lock().unwrap().registry["revision"] = json!(1),
            "busy" => state.0.lock().unwrap().busy = true,
            "digest" => fake.models.lock().unwrap()[0]["digest"] = json!("replacement"),
            _ => {}
        }
        let expected = {
            let d = state.0.lock().unwrap();
            (d.settings.clone(), d.registry.clone())
        };
        fake.release.notify_one();
        assert!(task.await.unwrap().is_err(), "{case}");
        {
            let d = state.0.lock().unwrap();
            assert_eq!(
                (&d.settings, &d.registry),
                (&expected.0, &expected.1),
                "{case}"
            );
            assert_eq!(d.commits, 0, "{case}");
            assert!(d.probe.is_null());
        }
        manager.close().await;
    }
}
#[tokio::test]
async fn pull_budget_framing_remote_listing_and_missing_success_fail_without_configuration() {
    for mode in [
        Mode::MissingSuccess,
        Mode::OverBudget,
        Mode::BadCounts,
        Mode::RemoteOnly,
        Mode::InvalidUtf8,
        Mode::TruncatedJson,
    ] {
        let (manager, state, _, _) = fixture(mode, vec![]);
        let scan = manager.scan().await.unwrap();
        manager.install(&json!({"engineId":scan["engines"][0]["id"],"catalogId":"compact","consentDownload":true})).unwrap();
        manager.wait_idle().await;
        let data = state.0.lock().unwrap();
        assert_eq!(data.transfer["status"], "failed");
        assert_eq!(data.settings["model"], "");
        assert_eq!(data.commits, 0);
        drop(data);
        manager.close().await;
    }
}
#[tokio::test]
async fn stop_and_network_revocation_cancel_pull_and_never_delete_shared_models() {
    for revoke in [false, true] {
        let (manager, state, fake, network) = fixture(Mode::SlowPull, vec![]);
        let scan = manager.scan().await.unwrap();
        manager.install(&json!({"engineId":scan["engines"][0]["id"],"catalogId":"compact","consentDownload":true})).unwrap();
        until(|| {
            fake.requests
                .lock()
                .unwrap()
                .iter()
                .any(|(p, _)| p == "/api/pull")
        })
        .await;
        if revoke {
            network.update_policy(
                NetworkPolicy::from_value(
                    &json!({"schema":1,"revision":1,"mode":"offline","internetTools":true}),
                )
                .unwrap(),
            );
        } else {
            assert_eq!(manager.stop()["stopping"], true);
        }
        manager.wait_idle().await;
        assert_eq!(
            state.0.lock().unwrap().transfer["status"],
            if revoke { "failed" } else { "interrupted" }
        );
        assert_eq!(state.0.lock().unwrap().settings["model"], "");
        assert!(!fake
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|(p, r)| p.contains("delete") || r.method == hyper::Method::DELETE));
        manager.close().await;
    }
}
#[test]
fn ndjson_is_incremental_fatal_utf8_and_bounded_by_utf16_units() {
    let mut bom = PullPackets::default();
    for byte in [0xef, 0xbb, 0xbf] {
        assert!(bom.push(&[byte]).unwrap().is_empty());
    }
    assert!(bom.push(&vec![b' '; 262144]).unwrap().is_empty());
    assert!(bom.finish().unwrap().is_empty());
    let mut parser = PullPackets::default();
    let mut values = vec![];
    for byte in "{\"status\":\"取得中🦊\"}\n{\"status\":\"success\"}".as_bytes() {
        values.extend(parser.push(&[*byte]).unwrap());
    }
    values.extend(parser.finish().unwrap());
    assert_eq!(values[0]["status"], "取得中🦊");
    assert_eq!(values.len(), 2);
    assert!(PullPackets::default().push(&[0xff]).is_err());
    let mut partial = PullPackets::default();
    partial.push(&[0xf0, 0x9f]).unwrap();
    assert!(partial.finish().is_err());
    let mut truncated = PullPackets::default();
    truncated.push(b"{\"unfinished\":").unwrap();
    assert!(truncated.finish().is_err());
    assert!(PullPackets::default().push(&vec![b' '; 262145]).is_err());
}
#[test]
fn install_help_is_fixed_and_only_explicit_invocation_calls_the_fake_launcher() {
    struct Launcher(Mutex<Vec<(String, Vec<String>)>>);
    impl InstallerLauncher for Launcher {
        fn spawn(&self, p: &str, a: &[String]) -> Result<(), ApiError> {
            self.0.lock().unwrap().push((p.into(), a.to_vec()));
            Ok(())
        }
    }
    let launcher = Launcher(Mutex::new(vec![]));
    for platform in ["win32", "darwin", "linux"] {
        let result = open_installer_page_with(platform, &launcher).unwrap();
        assert_eq!(result["opened"], true);
    }
    let calls = launcher.0.lock().unwrap();
    assert_eq!(
        calls[0],
        (
            "rundll32".into(),
            vec![
                "url.dll,FileProtocolHandler".into(),
                "https://ollama.com/download/windows".into()
            ]
        )
    );
    assert_eq!(
        calls[1],
        (
            "open".into(),
            vec!["https://ollama.com/download/mac".into()]
        )
    );
    assert_eq!(
        calls[2],
        (
            "xdg-open".into(),
            vec!["https://ollama.com/download".into()]
        )
    );
}
