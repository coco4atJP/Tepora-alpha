use super::{PullPackets, SelectionCommit, SetupState, SetupStored};
use crate::{
    network::{
        NativeNetwork, NetworkMode, NetworkRequest, NetworkScope, Purpose, RequestCancellation,
    },
    provider::{validate_registry, ProviderRuntime, ProviderState},
    runtime_discovery::{local_endpoint, providers},
    ApiError,
};
use futures_util::{stream::FuturesUnordered, StreamExt};
use hyper::Method;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tepora_core::{
    js_value::{js_string, truthy},
    json_codec,
};
use tokio::{runtime::Handle, sync::Notify};

pub fn model_catalog() -> Value {
    json!([
     {"id":"compact","model":"qwen3:4b-instruct-2507-q4_K_M","label":"テキスト中心・小さめ","approxBytes":2500000000u64,"maxBytes":4000000000u64,"minRamGiB":8,"source":"https://ollama.com/library/qwen3:4b-instruct-2507-q4_K_M"},
     {"id":"general","model":"qwen3.5:4b","label":"画像も扱える候補","approxBytes":3400000000u64,"maxBytes":5000000000u64,"minRamGiB":12,"source":"https://ollama.com/library/qwen3.5:4b"}
    ])
}
pub fn installer_url(platform: &str) -> String {
    format!(
        "https://ollama.com/download{}",
        match platform {
            "win32" => "/windows",
            "darwin" => "/mac",
            _ => "",
        }
    )
}
/// Only the explicit install-help route may execute this fixed command.
pub fn installer_command(platform: &str) -> (String, Vec<String>) {
    let url = installer_url(platform);
    match platform {
        "win32" => (
            "rundll32".into(),
            vec!["url.dll,FileProtocolHandler".into(), url],
        ),
        "darwin" => ("open".into(), vec![url]),
        _ => ("xdg-open".into(), vec![url]),
    }
}
pub fn destination(settings: &Value) -> Result<String, ApiError> {
    digest(&json!([
        settings["provider"],
        settings["baseUrl"],
        settings["model"]
    ]))
}
pub fn configuration(settings: &Value) -> Result<String, ApiError> {
    digest(&json!([
        destination(settings)?,
        settings["apiKeyEnv"],
        settings["allowCloud"],
        settings["shareMemory"],
        settings["codexEnabled"]
    ]))
}
fn digest(value: &Value) -> Result<String, ApiError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(
            json_codec::stringify_js(value)
                .map_err(|e| ApiError::bad_request(e.to_string()))?
                .as_bytes()
        )
    ))
}
fn stamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|e| e.into_inner())
}
fn require(ok: bool, status: u16, message: &str) -> Result<(), ApiError> {
    if ok {
        Ok(())
    } else {
        Err(ApiError::new(status, message))
    }
}
fn check(cancel: &RequestCancellation) -> Result<(), ApiError> {
    cancel.error().map_or(Ok(()), |e| Err(e.into()))
}
fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn short(value: &str, max: usize) -> String {
    let units = json_codec::utf16_units(value);
    json_codec::from_utf16_units(&units[..units.len().min(max)])
}
pub(super) fn js_whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
#[derive(Clone)]
pub struct SetupOptions {
    pub providers: Vec<Value>,
    pub probe_timeout: Duration,
    pub download_idle: Duration,
    pub download_timeout: Duration,
    pub ram_gib: Option<u64>,
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}
impl Default for SetupOptions {
    fn default() -> Self {
        Self {
            providers: providers(),
            probe_timeout: Duration::from_secs(45),
            download_idle: Duration::from_secs(60),
            download_timeout: Duration::from_secs(7200),
            ram_gib: super::platform::memory_gib(),
            clock: Arc::new(|| chrono::Utc::now().timestamp_millis()),
        }
    }
}
#[derive(Clone)]
pub struct SetupManager {
    inner: Arc<Inner>,
}
struct Inner {
    state: Arc<dyn SetupState>,
    network: NativeNetwork,
    runtime: Handle,
    options: SetupOptions,
    live: Mutex<Live>,
    changed: Notify,
}
#[derive(Default)]
struct Live {
    candidates: Vec<Value>,
    engines: Vec<Value>,
    active: Option<RequestCancellation>,
    probing: Option<RequestCancellation>,
    scanning: Option<RequestCancellation>,
    closed: bool,
}
#[derive(Clone, Copy)]
enum Operation {
    Scan,
    Probe,
    Download,
}
struct Lease {
    manager: SetupManager,
    kind: Operation,
    cancel: RequestCancellation,
    finished: bool,
}
impl Lease {
    fn finish(mut self) {
        self.finished = true;
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if !self.finished {
            self.cancel.cancel();
        }
        {
            let mut live = lock(&self.manager.inner.live);
            match self.kind {
                Operation::Scan => live.scanning = None,
                Operation::Probe => live.probing = None,
                Operation::Download => live.active = None,
            };
        }
        self.manager.inner.changed.notify_waiters();
    }
}
impl SetupManager {
    pub fn new(
        state: Arc<dyn SetupState>,
        network: NativeNetwork,
        runtime: Handle,
    ) -> Result<Self, ApiError> {
        Self::with_options(state, network, runtime, SetupOptions::default())
    }
    pub fn with_options(
        state: Arc<dyn SetupState>,
        network: NativeNetwork,
        runtime: Handle,
        options: SetupOptions,
    ) -> Result<Self, ApiError> {
        let previous = state.capture()?.transfer;
        let manager = Self {
            inner: Arc::new(Inner {
                state,
                network,
                runtime,
                options,
                live: Mutex::new(Live::default()),
                changed: Notify::new(),
            }),
        };
        if matches!(field(&previous, "status"), "downloading" | "checking") {
            let mut interrupted = previous;
            interrupted["status"] = json!("interrupted");
            interrupted["note"] = json!("前回の取得は中断しました。再開するまでは通信しません。");
            manager.inner.state.save_transfer(interrupted)?;
        }
        Ok(manager)
    }
    fn admit(&self, kind: Operation, cancel: RequestCancellation) -> Result<Lease, ApiError> {
        check(&cancel)?;
        let mut live = lock(&self.inner.live);
        require(!live.closed, 503, "Service closing")?;
        match kind {
            Operation::Scan => require(live.scanning.is_none(), 429, "接続先を確認しています。")?,
            _ => require(
                live.active.is_none() && live.probing.is_none(),
                409,
                "別の準備処理が進行中です。",
            )?,
        }
        match kind {
            Operation::Scan => live.scanning = Some(cancel.clone()),
            Operation::Probe => live.probing = Some(cancel.clone()),
            Operation::Download => live.active = Some(cancel.clone()),
        };
        Ok(Lease {
            manager: self.clone(),
            kind,
            cancel,
            finished: false,
        })
    }
    pub fn snapshot(&self) -> Result<Value, ApiError> {
        self.snapshot_from(self.inner.state.capture()?)
    }
    /// Pure persisted input plus runtime-only fields. No SetupState callback or
    /// config lock; callers may keep their State snapshot/sequence lock held.
    pub fn snapshot_from(&self, stored: SetupStored) -> Result<Value, ApiError> {
        let now = (self.inner.options.clock)();
        let settings = &stored.settings;
        let local = local_endpoint(field(settings, "baseUrl")).is_ok();
        let checked = stored.model_probe["checkedAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|s| s.timestamp_millis());
        let verified = (local || truthy(&settings["allowCloud"]))
            && truthy(&stored.model_probe["passed"])
            && stored.model_probe["destination"] == destination(settings)?
            && checked.is_some_and(|at| now - at < 86400000);
        let first = stored.first_result.unwrap_or(Value::Null);
        let mut value = json!({"dismissed":stored.dismissed,"configured":truthy(&settings["model"]),"verified":verified,"checkedAt":if verified {stored.model_probe["checkedAt"].clone()} else {Value::Null},"model":settings["model"],"provider":settings["provider"],"local":local,"stage":if !first.is_null(){"first-result"}else if verified{"connected"}else{"connect"},"firstResult":first,"transfer":stored.transfer,
          "note":if verified{"この接続で道具の呼び出しを確認しました。依頼全体の品質・速度の保証ではありません。"}else{"モデル未確認でも画面の表示設定は使えます。"}});
        self.decorate_snapshot(&mut value);
        Ok(value)
    }
    pub fn decorate_snapshot(&self, value: &mut Value) {
        let (candidates, engines, checking) = {
            let live = lock(&self.inner.live);
            (
                live.candidates.clone(),
                live.engines.clone(),
                live.probing.is_some(),
            )
        };
        let strip = |rows: Vec<Value>| {
            rows.into_iter()
                .map(|mut v| {
                    v.as_object_mut().unwrap().remove("expiresAt");
                    v
                })
                .collect::<Vec<_>>()
        };
        value["candidates"] = json!(strip(candidates));
        value["engines"] = json!(strip(engines));
        value["checking"] = json!(checking);
        value["catalog"] = model_catalog();
        value["ramGiB"] = json!(self.inner.options.ram_gib);
    }
    fn emit(&self) -> Result<Option<Value>, ApiError> {
        if lock(&self.inner.live).closed {
            return Ok(None);
        }
        let value = self.snapshot()?;
        self.inner.state.emit_snapshot(value.clone())?;
        Ok(Some(value))
    }
    pub fn dismiss(&self) -> Result<Value, ApiError> {
        require(!lock(&self.inner.live).closed, 503, "Service closing")?;
        self.inner.state.dismiss()?;
        Ok(self.emit()?.unwrap_or(Value::Null))
    }
    async fn get_json(&self, url: &str, cancel: &RequestCancellation) -> Result<Value, ApiError> {
        let response = self
            .inner
            .network
            .request(
                url,
                NetworkRequest {
                    cancellation: Some(cancel.clone()),
                    ..Default::default()
                },
                NetworkScope {
                    purpose: Purpose::Model,
                    timeout: Duration::from_secs(5),
                    ..Default::default()
                },
            )
            .await?;
        require(
            (200..300).contains(&response.status),
            502,
            &format!("接続先が応答しませんでした (HTTP {})", response.status),
        )?;
        response.json(4 * 1024 * 1024).await.map_err(Into::into)
    }
    pub async fn scan(&self) -> Result<Value, ApiError> {
        self.scan_with_cancel(&RequestCancellation::new()).await
    }
    pub async fn scan_with_cancel(&self, caller: &RequestCancellation) -> Result<Value, ApiError> {
        let lease = self.admit(Operation::Scan, caller.clone())?;
        let cancel = &lease.cancel;
        let mut requests = FuturesUnordered::new();
        for provider in self.inner.options.providers.clone() {
            let cancel = cancel.clone();
            requests.push(async move { self.scan_provider(provider, &cancel).await });
        }
        let mut candidates = vec![];
        let mut engines = vec![];
        while let Some(result) = requests.next().await {
            if let Ok((found, engine)) = result {
                for candidate in found {
                    upsert(&mut candidates, candidate);
                }
                if let Some(engine) = engine {
                    upsert(&mut engines, engine);
                }
            }
        }
        check(cancel)?;
        {
            let mut live = lock(&self.inner.live);
            require(!live.closed, 503, "Service closing")?;
            live.candidates = candidates;
            live.engines = engines;
        }
        lease.finish();
        Ok(self.emit()?.unwrap_or(Value::Null))
    }
    async fn scan_provider(
        &self,
        provider: Value,
        cancel: &RequestCancellation,
    ) -> Result<(Vec<Value>, Option<Value>), ApiError> {
        let base = local_endpoint(field(&provider, "url"))?;
        let expires = (self.inner.options.clock)() + 600000;
        let mut engine = None;
        let models;
        if provider["id"] == "ollama" {
            let root = base.strip_suffix("/v1").unwrap_or(&base);
            let data = self.get_json(&format!("{root}/api/tags"), cancel).await?;
            let rows = data["models"]
                .as_array()
                .ok_or_else(|| ApiError::bad_request("Invalid Ollama model list"))?;
            engine = Some(
                json!({"id":digest(&json!([provider["id"],root]))?,"provider":provider["id"],"name":provider["name"],"baseUrl":root,"expiresAt":expires}),
            );
            models=rows.iter().filter(|m|m.is_object()&&m["name"].is_string()&&!truthy(&m["remote_host"])&&!truthy(&m["remote_model"])&&!field(m,"name").to_lowercase().ends_with("cloud")).map(|m|json!({"model":m["name"],"digest":if truthy(&m["digest"]){m["digest"].clone()}else{Value::Null},"bytes":if truthy(&m["size"]){m["size"].clone()}else{Value::Null}})).collect::<Vec<_>>();
        } else {
            let data = self.get_json(&format!("{base}/models"), cancel).await?;
            models = data["data"]
                .as_array()
                .ok_or_else(|| ApiError::bad_request("Invalid model list"))?
                .iter()
                .filter(|m| m["id"].is_string())
                .map(|m| json!({"model":m["id"]}))
                .collect();
        }
        let mut candidates = vec![];
        for model in models.into_iter().take(100) {
            if field(&model, "model").is_empty()
                || json_codec::utf16_units(field(&model, "model")).len() > 500
            {
                continue;
            }
            let id = digest(&json!([
                provider["id"],
                base,
                model["model"],
                model["digest"]
            ]))?;
            let mut candidate = json!({"id":id,"provider":provider["id"],"name":provider["name"],"baseUrl":base,"expiresAt":expires});
            candidate
                .as_object_mut()
                .unwrap()
                .extend(model.as_object().unwrap().clone());
            candidates.push(candidate);
        }
        Ok((candidates, engine))
    }
    pub async fn select(&self, id: &str, consent_test: bool) -> Result<Value, ApiError> {
        self.select_with_cancel(id, consent_test, &RequestCancellation::new())
            .await
    }
    pub async fn select_with_cancel(
        &self,
        id: &str,
        consent_test: bool,
        caller: &RequestCancellation,
    ) -> Result<Value, ApiError> {
        check(caller)?;
        let context = self.inner.state.selection_context()?;
        require(!context.registry_configured,409,"名前付きの接続が設定されています。接続先の変更は「知能と通信の使い分け」から行ってください。")?;
        require(
            consent_test,
            403,
            "接続確認には短いモデル呼び出しを行います。確認を許可してください。",
        )?;
        let lease = self.admit(Operation::Probe, caller.clone())?;
        let result=async {
            require(!context.busy,409,"仕事が進行中です。接続を切り替える前に停止してください。")?;
            let now=(self.inner.options.clock)();
            let candidate=lock(&self.inner.live).candidates.iter().find(|c|c["id"]==id&&c["expiresAt"].as_i64().is_some_and(|at|at>now)).cloned().ok_or_else(||ApiError::new(409,"候補を再検索してください。"))?;
            self.emit()?;
            let settings=crate::workspace::validate_setup_settings(&json!({"provider":candidate["provider"],"baseUrl":candidate["baseUrl"],"model":candidate["model"],"apiKeyEnv":""}),&context.settings)?;
            let raw=json!({"profiles":[{"id":"local-default","name":candidate["model"],"model":candidate["model"],"protocol":"chat-completions","baseUrl":candidate["baseUrl"],"domain":"device","apiKeyEnv":"","capabilities":{"text":true,"tools":true,"vision":null,"structured":null}}],"routes":{"main":{"primary":"local-default","fallbacks":[]}}});
            let registry=validate_registry(&raw)?;
            let report=match tokio::time::timeout(self.inner.options.probe_timeout,self.probe(&settings,&registry,&lease.cancel)).await {Ok(result)=>result?,Err(_)=>{lease.cancel.cancel();return Err(ApiError::new(504,"接続確認がタイムアウトしました。"));}};
            check(&lease.cancel)?;
            if candidate["provider"]=="ollama"&&truthy(&candidate["digest"]) {
                let base=field(&candidate,"baseUrl").strip_suffix("/v1").unwrap_or(field(&candidate,"baseUrl"));let listing=self.get_json(&format!("{base}/api/tags"),&lease.cancel).await?;
                require(listing["models"].as_array().into_iter().flatten().any(|m|m["name"]==candidate["model"]&&m["digest"]==candidate["digest"]&&!truthy(&m["remote_host"])&&!truthy(&m["remote_model"])),409,"確認中にモデルが変更されました。再検索してください。")?;
            }
            check(&lease.cancel)?;
            self.inner.state.activate_selection(SelectionCommit{cancellation:lease.cancel.clone(),expected_configuration:configuration(&context.settings)?,expected_registry_revision:context.registry_revision,settings,report:report.clone(),registry:raw})?;
            Ok(json!({"activated":true,"report":report}))
        }.await;
        lease.finish();
        let emitted = self.emit();
        match result {
            Ok(value) => {
                emitted?;
                Ok(value)
            }
            Err(error) => Err(error),
        }
    }
    async fn probe(
        &self,
        settings: &Value,
        registry: &Value,
        cancel: &RequestCancellation,
    ) -> Result<Value, ApiError> {
        let state = Arc::new(ProbeState::new(registry.clone()));
        let runtime = ProviderRuntime::with_options(
            state,
            self.inner.network.clone(),
            false,
            self.inner.options.clock.clone(),
        );
        let _close = ProbeClose(runtime.clone());
        let raw = runtime
            .probe("local-default", cancel)
            .await
            .map_err(ApiError::from)?;
        let mut report = json!({"destination":destination(settings)?});
        for key in [
            "passed",
            "model",
            "checkedAt",
            "latencyMs",
            "evidence",
            "limitation",
        ] {
            report[key] = raw[key].clone();
        }
        Ok(report)
    }
    pub fn install(&self, body: &Value) -> Result<Value, ApiError> {
        if self.inner.network.policy().mode!=NetworkMode::Online {return Err(crate::network::NetworkError::blocked("制限モードではモデルを取得しません。").into());}
        require(
            body["consentDownload"] == true,
            403,
            "モデル取得には外部通信と保存容量が必要です。",
        )?;
        let lease = self.admit(Operation::Download, RequestCancellation::new())?;
        let now = (self.inner.options.clock)();
        let engine = lock(&self.inner.live)
            .engines
            .iter()
            .find(|e| {
                e["id"] == body["engineId"] && e["expiresAt"].as_i64().is_some_and(|at| at > now)
            })
            .cloned();
        let model = model_catalog()
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == body["catalogId"])
            .cloned();
        let (Some(engine), Some(model)) = (engine, model) else {
            return Err(ApiError::new(
                409,
                "モデルと接続先をもう一度選んでください。",
            ));
        };
        local_endpoint(field(&engine, "baseUrl"))?;
        let transfer = json!({"id":uuid::Uuid::new_v4().to_string(),"engineId":body["engineId"],"catalogId":body["catalogId"],"model":model["model"],"baseUrl":engine["baseUrl"],"status":"downloading","createdAt":stamp(),"completedBytes":0,"totalBytes":null,"note":"モデルを取得しています。個人の会話やファイルは送信しません。保存先はOllamaが管理します。"});
        self.inner.state.save_transfer(transfer.clone())?;
        let manager = self.clone();
        let running = transfer.clone();
        self.inner.runtime.spawn(async move {
            manager.pull(running, model, &lease.cancel).await;
            lease.finish();
            let _ = manager.emit();
        });
        Ok(transfer)
    }
    fn save_transfer(&self, value: Value) -> Result<(), ApiError> {
        if lock(&self.inner.live).closed {
            return Ok(());
        }
        self.inner.state.save_transfer(value)
    }
    async fn pull(&self, mut transfer: Value, model: Value, cancel: &RequestCancellation) {
        let result = self.pull_inner(&mut transfer, &model, cancel).await;
        if let Err(error) = result {
            transfer["status"] = json!(if cancel.is_cancelled() {
                "interrupted"
            } else {
                "failed"
            });
            transfer["endedAt"] = json!(stamp());
            transfer["note"] = json!(crate::provider::safe_error(&error.message));
            transfer["recovery"]=json!("同じモデルを選ぶと、Ollamaに残る取得済みデータを利用して再取得します。他のアプリが使うモデルは削除しません。");
            let _ = self.save_transfer(transfer);
        }
    }
    async fn pull_inner(
        &self,
        transfer: &mut Value,
        model: &Value,
        cancel: &RequestCancellation,
    ) -> Result<(), ApiError> {
        let idle = self.inner.options.download_idle;
        let mut heartbeat = tokio::time::Instant::now();
        let mut headers = hyper::HeaderMap::new();
        headers.insert(
            "content-type",
            hyper::header::HeaderValue::from_static("application/json"),
        );
        let body = json_codec::stringify_js(
            &json!({"model":model["model"],"stream":true,"insecure":false}),
        )
        .map_err(|e| ApiError::bad_request(e.to_string()))?;
        let request = NetworkRequest {
            method: Method::POST,
            headers,
            body: body.into(),
            cancellation: Some(cancel.clone()),
        };
        let scope = NetworkScope {
            purpose: Purpose::Download,
            timeout: self.inner.options.download_timeout,
            ..Default::default()
        };
        let response = tokio::time::timeout(
            idle,
            self.inner.network.request(
                &format!("{}/api/pull", field(transfer, "baseUrl")),
                request,
                scope,
            ),
        )
        .await;
        let mut response = match response {
            Ok(value) => value?,
            Err(_) => {
                cancel.cancel();
                return Err(ApiError::new(
                    504,
                    "進捗が止まったため取得を中断しました。再開できます。",
                ));
            }
        };
        require(
            (200..300).contains(&response.status),
            502,
            &format!("モデル取得を開始できません (HTTP {})", response.status),
        )?;
        require(
            response.has_body,
            502,
            "Download progress stream is missing",
        )?;
        let mut parser = PullPackets::default();
        let mut progress = Progress::default();
        loop {
            let chunk = match tokio::time::timeout_at(heartbeat + idle, response.body.next()).await
            {
                Ok(chunk) => chunk,
                Err(_) => {
                    cancel.cancel();
                    return Err(ApiError::new(
                        504,
                        "進捗が止まったため取得を中断しました。再開できます。",
                    ));
                }
            };
            let Some(chunk) = chunk else {
                break;
            };
            let packets = parser.push(&chunk?)?;
            for packet in packets {
                heartbeat = tokio::time::Instant::now();
                check(cancel)?;
                progress.packet(packet, transfer, model)?;
                if progress
                    .last_emit
                    .is_none_or(|at| at.elapsed() > Duration::from_millis(200))
                {
                    self.save_transfer(transfer.clone())?;
                    progress.last_emit = Some(Instant::now());
                }
            }
        }
        for packet in parser.finish()? {
            check(cancel)?;
            progress.packet(packet, transfer, model)?;
        }
        check(cancel)?;
        require(
            progress.success,
            502,
            "取得完了の応答がありません。再開して確認してください。",
        )?;
        transfer["status"] = json!("checking");
        self.save_transfer(transfer.clone())?;
        let listing = self
            .get_json(&format!("{}/api/tags", field(transfer, "baseUrl")), cancel)
            .await?;
        require(
            listing["models"].as_array().into_iter().flatten().any(|m| {
                m["name"] == model["model"]
                    && !truthy(&m["remote_model"])
                    && !truthy(&m["remote_host"])
            }),
            502,
            "取得したモデルがローカル一覧にありません。",
        )?;
        check(cancel)?;
        transfer["status"] = json!("downloaded");
        transfer["endedAt"] = json!(stamp());
        transfer["note"] =
            json!("取得しました。次にこのモデルの道具呼び出しを確認して接続します。");
        self.save_transfer(transfer.clone())?;
        self.scan().await?;
        Ok(())
    }
    pub fn stop(&self) -> Value {
        let (active, probe) = {
            let live = lock(&self.inner.live);
            (live.active.clone(), live.probing.clone())
        };
        let stopping = active.is_some() || probe.is_some();
        if let Some(cancel) = active {
            cancel.cancel();
        }
        if let Some(cancel) = probe {
            cancel.cancel();
        }
        json!({"stopping":stopping})
    }
    pub fn begin_close(&self) {
        let tokens = {
            let mut live = lock(&self.inner.live);
            live.closed = true;
            [
                live.active.clone(),
                live.probing.clone(),
                live.scanning.clone(),
            ]
        };
        for cancel in tokens.into_iter().flatten() {
            cancel.cancel();
        }
    }
    pub async fn wait_idle(&self) {
        loop {
            let changed = self.inner.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let empty = {
                let live = lock(&self.inner.live);
                live.active.is_none() && live.probing.is_none() && live.scanning.is_none()
            };
            if empty {
                break;
            }
            changed.await;
        }
    }
    pub async fn close(&self) {
        self.begin_close();
        self.wait_idle().await;
    }
}
fn upsert(rows: &mut Vec<Value>, value: Value) {
    if let Some(row) = rows.iter_mut().find(|r| r["id"] == value["id"]) {
        *row = value;
    } else {
        rows.push(value);
    }
}
#[derive(Default)]
struct Progress {
    layers: HashMap<String, (u64, u64)>,
    success: bool,
    last_emit: Option<Instant>,
}
fn safe_integer(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0. && *n <= 9007199254740991. && n.fract() == 0.)
        .map(|n| n as u64)
}
impl Progress {
    fn packet(
        &mut self,
        packet: Value,
        transfer: &mut Value,
        model: &Value,
    ) -> Result<(), ApiError> {
        require(packet.is_object(), 502, "Invalid download progress")?;
        require(
            !truthy(&packet["error"]),
            502,
            &format!(
                "モデル取得に失敗しました: {}",
                short(&js_string(packet.get("error")), 200)
            ),
        )?;
        if let (Some(digest), Some(total)) =
            (packet["digest"].as_str(), safe_integer(&packet["total"]))
        {
            let completed = packet
                .get("completed")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(json!(0));
            let done = safe_integer(&completed)
                .filter(|n| *n <= total)
                .ok_or_else(|| ApiError::new(502, "Invalid download byte counts"))?;
            require(
                json_codec::utf16_units(digest).len() < 200 && self.layers.len() < 128,
                502,
                "Too many download layers",
            )?;
            self.layers.insert(digest.into(), (total, done));
            let total: u64 = self.layers.values().map(|v| v.0).sum();
            require(
                total <= model["maxBytes"].as_u64().unwrap(),
                413,
                "表示した取得予算を超えたため停止しました。別の構成を確認してください。",
            )?;
            transfer["totalBytes"] = json!(total);
            transfer["completedBytes"] = json!(self.layers.values().map(|v| v.1).sum::<u64>());
        }
        if packet["status"] == "success" {
            self.success = true;
        }
        Ok(())
    }
}
struct ProbeState {
    values: Mutex<HashMap<String, Value>>,
    docs: Mutex<HashMap<String, Value>>,
}
impl ProbeState {
    fn new(mut registry: Value) -> Self {
        registry["schema"] = json!(2);
        registry["revision"] = json!(0);
        Self {
            values: Mutex::new(HashMap::from([
                ("provider-registry".into(), registry),
                ("provider-keys".into(), json!({})),
            ])),
            docs: Mutex::new(HashMap::new()),
        }
    }
}
impl ProviderState for ProbeState {
    fn value(&self, key: &str) -> Result<Option<Value>, ApiError> {
        Ok(lock(&self.values).get(key).cloned())
    }
    fn set_value(&self, key: &str, value: Value) -> Result<(), ApiError> {
        lock(&self.values).insert(key.into(), value);
        Ok(())
    }
    fn get(&self, collection: &str, id: &str) -> Result<Option<Value>, ApiError> {
        Ok(lock(&self.docs).get(&format!("{collection}:{id}")).cloned())
    }
    fn put(&self, collection: &str, value: Value) -> Result<(), ApiError> {
        lock(&self.docs).insert(format!("{collection}:{}", field(&value, "id")), value);
        Ok(())
    }
    fn emit(&self, _: &str, _: Value) -> Result<(), ApiError> {
        Ok(())
    }
}
struct ProbeClose(ProviderRuntime);
impl Drop for ProbeClose {
    fn drop(&mut self) {
        self.0.close();
    }
}
