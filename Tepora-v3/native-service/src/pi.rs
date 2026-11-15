//! pi-ai on the Rust host. The pinned Node SDK runs only inside the shared, short-lived
//! child-process worker (`core/pi-worker.mjs`, the same one core/pi-ai.mjs runs).
//! Rust owns the credential vault (`credentials/pi-ai.json`, same schema as the Node
//! host), login state, catalog checks, NativeNetwork admission for every SDK fetch,
//! and cancellation (caller/Stop All, logout, shutdown, bounded OAuth refresh drain).
mod catalog;
#[cfg(test)]
mod tests;
mod worker;

pub use catalog::{protocol_for, Catalog};
pub use worker::WorkerCommand;

use crate::{
    model_usage::DispatchMarker,
    network::{
        inside_endpoint, normal_url, Domain, NativeNetwork, NetworkBody, NetworkError,
        NetworkProfile, NetworkRequest, NetworkScope, Purpose, RequestCancellation,
    },
    provider::{classify_response, EventSink, ProviderEvent, ProviderFailure},
    ApiError,
};
use base64::Engine;
use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::Duration,
};
use tepora_core::json_codec;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt},
    sync::{mpsc, oneshot},
    time::Instant,
};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);

fn auth_origins(provider: &str) -> &'static [&'static str] {
    match provider {
        "openai" | "openai-codex" => &["https://auth.openai.com"],
        "anthropic" => &["https://platform.claude.com"],
        "github-copilot" => &[
            "https://github.com",
            "https://api.github.com",
            "https://api.individual.githubcopilot.com",
            "https://api.business.githubcopilot.com",
            "https://api.enterprise.githubcopilot.com",
        ],
        "openrouter" => &["https://openrouter.ai"],
        "kimi-coding" => &["https://auth.kimi.com"],
        "meta" => &["https://auth.meta.com", "https://api.meta.ai"],
        "xai" => &["https://auth.x.ai"],
        "radius" => &["https://radius.pi.dev"],
        _ => &[],
    }
}
fn account_id(value: &str) -> bool {
    regex::Regex::new(r"^pi-[a-f0-9-]{36}$").unwrap().is_match(value)
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
fn fail(status: u16, message: &str) -> ApiError {
    ApiError::new(status, message)
}
fn require(ok: bool, status: u16, message: &str) -> Result<(), ApiError> {
    if ok {
        Ok(())
    } else {
        Err(fail(status, message))
    }
}
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn safe_link(value: &str) -> Option<String> {
    normal_url(value, true)
        .ok()
        .filter(|u| u.scheme() == "https")
        .map(|u| u.to_string())
}
fn public_account(a: &Value) -> Value {
    json!({"id":a["id"],"provider":a["provider"],"type":a["type"],"label":a["label"],
        "connected":a.get("credential").is_some_and(|c| !c.is_null()),"error":a.get("error").cloned().unwrap_or(Value::Null)})
}
fn cancelled_by_host() -> ProviderFailure {
    ProviderFailure::new("auth", "pi-aiの処理を取り消しました。")
}

pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Clone)]
pub struct PiService {
    inner: Arc<Inner>,
}
struct Inner {
    file: PathBuf,
    network: NativeNetwork,
    emit: Emit,
    command: WorkerCommand,
    runtime: tokio::runtime::Handle,
    drain: Duration,
    // Lock order: catalog, then state. Emit never runs under state.
    catalog: Mutex<Option<Arc<Catalog>>>,
    state: Mutex<State>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}
struct State {
    vault: Value,
    storage_error: Option<String>,
    pending: Option<Pending>,
    jobs: HashMap<u64, Job>,
    next_job: u64,
    closed: bool,
    epochs: HashMap<String, u64>,
    refreshes: HashMap<String, u64>,
}
struct Pending {
    id: String,
    provider: String,
    account_id: String,
    status: &'static str,
    prompt: Option<Value>,
    event: Option<Value>,
    error: Option<&'static str>,
    cancel: RequestCancellation,
    reply: Option<mpsc::UnboundedSender<String>>,
}
/// Caller cancellation lets an already-leased OAuth refresh drain; hard ends the worker.
#[derive(Clone)]
struct Job {
    account_id: Option<String>,
    domain: Domain,
    caller: RequestCancellation,
    hard: RequestCancellation,
    reason: Arc<Mutex<Option<ProviderFailure>>>,
}
impl Job {
    fn abort(&self, hard: bool, reason: ProviderFailure) {
        lock(&self.reason).get_or_insert(reason);
        self.caller.cancel();
        if hard {
            self.hard.cancel();
        }
    }
    fn reason(&self) -> ProviderFailure {
        lock(&self.reason).clone().unwrap_or_else(cancelled_by_host)
    }
}
#[derive(Default)]
struct RunOptions {
    on_delta: Option<Arc<dyn Fn(&str, &str) + Send + Sync>>,
    pending: Option<String>,
    dispatch: Option<DispatchMarker>,
}

impl PiService {
    pub fn new(file: PathBuf, network: NativeNetwork, emit: Emit, runtime: tokio::runtime::Handle) -> Self {
        Self::with_options(file, network, emit, runtime, WorkerCommand::discover(), Duration::from_secs(20))
    }
    pub fn with_options(
        file: PathBuf,
        network: NativeNetwork,
        emit: Emit,
        runtime: tokio::runtime::Handle,
        command: WorkerCommand,
        drain: Duration,
    ) -> Self {
        let (vault, storage_error) = match read_vault(&file) {
            Ok(v) => (v, None),
            Err(_) => (fresh_vault(), Some("pi-aiの認証ファイルを読み込めません。ファイルを保全して停止しています。".to_owned())),
        };
        Self {
            inner: Arc::new(Inner {
                file,
                network,
                emit,
                command,
                runtime,
                drain,
                catalog: Mutex::new(None),
                state: Mutex::new(State {
                    vault,
                    storage_error,
                    pending: None,
                    jobs: HashMap::new(),
                    next_job: 0,
                    closed: false,
                    epochs: HashMap::new(),
                    refreshes: HashMap::new(),
                }),
                locks: Mutex::new(HashMap::new()),
            }),
        }
    }
    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.inner.state)
    }
    fn changed(&self) {
        if self.state().closed {
            return;
        }
        let version = lock(&self.inner.catalog).as_ref().map(|c| c.version.clone());
        (self.inner.emit)(json!({"version":version}));
    }
    /// Loaded once from the worker; the first load also checks saved accounts against it.
    pub fn catalog(&self) -> Result<Arc<Catalog>, ApiError> {
        let mut cached = lock(&self.inner.catalog);
        if let Some(c) = cached.as_ref() {
            return Ok(c.clone());
        }
        let value = self
            .inner
            .command
            .oneshot(json!({"operation":"catalog"}), Duration::from_secs(60))
            .map_err(|e| ApiError::unavailable(e))?;
        let catalog = Arc::new(Catalog::from_value(value).map_err(ApiError::unavailable)?);
        let mut st = self.state();
        if st.storage_error.is_none() && check_vault(&st.vault, &catalog).is_err() {
            st.vault = fresh_vault();
            st.storage_error = Some("pi-aiの認証ファイルを読み込めません。ファイルを保全して停止しています。".into());
        }
        drop(st);
        *cached = Some(catalog.clone());
        Ok(catalog)
    }
    pub(crate) async fn catalog_async(&self) -> Result<Arc<Catalog>, ApiError> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.catalog())
            .await
            .map_err(|_| ApiError::unavailable("pi-ai catalog task failed"))?
    }
    pub fn providers(&self) -> Result<Value, ApiError> {
        Ok(self.catalog()?.snapshot())
    }
    pub fn snapshot(&self) -> Value {
        let catalog = self.catalog();
        let st = self.state();
        let note = match (&st.storage_error, &catalog) {
            (Some(e), _) => e.clone(),
            (None, Err(e)) => e.message.clone(),
            _ => "OAuthとAPIキー、異なる登録アカウントへの自動切替はしません。".into(),
        };
        let pending = st.pending.as_ref().map_or(Value::Null, |p| {
            json!({"id":p.id,"provider":p.provider,"accountId":p.account_id,"status":p.status,"prompt":p.prompt,"event":p.event,"error":p.error})
        });
        let accounts: Vec<Value> = st.vault["accounts"].as_object().map(|a| a.values().map(public_account).collect()).unwrap_or_default();
        json!({"supported":st.storage_error.is_none()&&catalog.is_ok(),"version":catalog.as_ref().ok().map(|c|c.version.clone()),"note":note,"accounts":accounts,"pending":pending})
    }
    pub fn status(&self, id: &str) -> Value {
        self.state().vault["accounts"]
            .get(id)
            .map(public_account)
            .unwrap_or_else(|| json!({"connected":false,"error":"pi-aiへログインしてください。"}))
    }
    fn account(&self, id: &str, provider: &str) -> Result<Value, ApiError> {
        let st = self.state();
        st.vault["accounts"]
            .get(id)
            .filter(|a| s(a, "provider") == provider)
            .cloned()
            .ok_or_else(|| fail(409, "pi-aiのアカウントとプロバイダーが一致しません。"))
    }
    /// Account availability filters (Copilot) are enforced by the worker with the live credential.
    pub fn model(&self, provider: &str, id: &str, account: Option<&str>) -> Result<Option<Value>, ApiError> {
        let catalog = self.catalog()?;
        if catalog.provider(provider).is_none() {
            return Ok(None);
        }
        let list: Vec<Value> = match account {
            None => catalog.models(provider).to_vec(),
            Some(account) => {
                let a = self.account(account, provider)?;
                match a.get("catalog").filter(|c| s(c, "version") == catalog.version) {
                    Some(saved) => saved["models"].as_array().cloned().unwrap_or_default(),
                    None => catalog.models(provider).to_vec(),
                }
            }
        };
        Ok(list.into_iter().find(|m| s(m, "id") == id && m["enabled"] != false))
    }
    /// `validatePiProfile` + `assertProfile` from core/pi-ai.mjs, with account-aware models.
    pub fn assert_profile(&self, p: &Value) -> Result<(), ApiError> {
        let catalog = self.catalog()?;
        let account = Some(s(p, "accountId")).filter(|a| !a.is_empty());
        let provider = catalog.provider(s(p, "piProvider"));
        let model = match provider {
            Some(_) => self.model(s(p, "piProvider"), s(p, "model"), account)?,
            None => None,
        };
        let auth = s(p, "authMode");
        require(["", "api-key", "pi-oauth", "pi-key"].contains(&auth), 400, "pi-aiの認証方式が不正です。")?;
        let (Some(provider), Some(model)) = (provider, model) else {
            return Err(fail(400, "pi-aiのプロバイダーとモデルを選択してください。"));
        };
        require(catalog::supported(s(&model, "api")) && model["enabled"] != false, 400, "このpi-aiアダプターの専用通信はまだ接続していません。")?;
        require(s(p, "protocol") == protocol_for(s(&model, "api")), 400, "pi-aiモデルのAPI形式が一致しません。")?;
        if auth.starts_with("pi-") {
            require(account_id(s(p, "accountId")), 400, "pi-aiの認証アカウントを選択してください。")?;
            require(s(p, "domain") == "cloud" && s(p, "apiKeyEnv").is_empty(), 400, "アカウント認証と環境変数のキーを混在できません。")?;
        }
        if auth == "pi-oauth" {
            require(provider["oauth"].is_object(), 400, "このプロバイダーにはOAuthがありません。")?;
            let fixed = if s(&model, "baseUrl").is_empty() { s(provider, "baseUrl") } else { s(&model, "baseUrl") };
            require(json_codec::sql_text(s(p, "baseUrl")).trim_end_matches('/') == fixed.trim_end_matches('/'), 400, "OAuthの送信先はpi-aiのモデル定義に固定します。")?;
        }
        if let Some(account) = account {
            let a = self.account(account, s(p, "piProvider"))?;
            require(s(&a, "type") == if auth == "pi-oauth" { "oauth" } else { "api_key" }, 400, "pi-aiの認証方式が一致しません。")?;
        }
        Ok(())
    }
    pub fn models(&self, provider: &str, account: Option<&str>) -> Result<Value, ApiError> {
        let catalog = self.catalog()?;
        require(catalog.provider(provider).is_some(), 400, "Unknown pi-ai provider")?;
        let mut saved = None;
        let models: Vec<Value> = match account {
            None => catalog.models(provider).to_vec(),
            Some(account) => {
                let a = self.account(account, provider)?;
                saved = a.get("catalog").filter(|c| s(c, "version") == catalog.version).cloned();
                saved.as_ref().map_or_else(|| catalog.models(provider).to_vec(), |c| c["models"].as_array().cloned().unwrap_or_default())
            }
        };
        let mut out = json!({"models":models.iter().map(catalog::model_info).collect::<Vec<_>>(),"verified":false,
            "note":if saved.is_some(){"このアカウントが取得した保存済みpi-ai一覧です。現在の利用資格・推論品質は未検証です。"}else{"pi-aiのカタログです。実際の利用権限・応答品質は未検証です。"}});
        if let Some(saved) = saved {
            out["refreshedAt"] = saved["at"].clone();
        }
        Ok(out)
    }
    fn persist(&self, st: &State) -> Result<(), ApiError> {
        require(st.storage_error.is_none(), 409, "認証ファイルを保全するため変更できません。")?;
        let text = json_codec::stringify_js(&st.vault).map_err(|e| ApiError::new(500, e.to_string()))?;
        require(text.len() < 4_000_000, 400, "pi-ai保存データが大きすぎます。")?;
        atomic_write(&self.inner.file, &(text + "\n")).map_err(|_| fail(500, "pi-aiの認証ファイルを保存できません。"))
    }
    fn permitted(&self, domain: Domain) -> bool {
        self.inner.network.policy().permitted(domain, Purpose::Model)
    }
    fn account_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        lock(&self.inner.locks).entry(id.into()).or_default().clone()
    }
    fn invalidate(&self, st: &mut State, id: &str) {
        *st.epochs.entry(id.into()).or_default() += 1;
        for job in st.jobs.values().filter(|j| j.account_id.as_deref() == Some(id)) {
            job.abort(true, cancelled_by_host());
        }
    }
    pub async fn refresh_models(&self, provider: &str, account: &str, consent: bool, cancel: &RequestCancellation) -> Result<Value, ApiError> {
        require(consent, 403, "モデル一覧の外部取得を許可してください。")?;
        let catalog = self.catalog_async().await?;
        let a = self.account(account, provider)?;
        require(a.get("credential").is_some_and(|c| !c.is_null()), 400, "ログインしてください。")?;
        let (epoch, sequence) = {
            let mut st = self.state();
            let epoch = st.epochs.get(account).copied().unwrap_or(0);
            let sequence = st.refreshes.get(account).copied().unwrap_or(0) + 1;
            st.refreshes.insert(account.into(), sequence);
            (epoch, sequence)
        };
        let result = self
            .run(json!({"operation":"models","provider":provider,"accountId":account}), cancel, RunOptions::default())
            .await
            .map_err(ApiError::from)?;
        if let Some(e) = cancel.error() {
            return Err(e.into());
        }
        let models = catalog.checked_models(provider, &result)?;
        {
            let mut st = self.state();
            let current = st.vault["accounts"].get(account).filter(|x| s(x, "provider") == provider && x.get("credential").is_some_and(|c| !c.is_null()));
            require(
                !st.closed && st.storage_error.is_none() && self.permitted(Domain::Cloud) && current.is_some()
                    && st.epochs.get(account).copied().unwrap_or(0) == epoch && st.refreshes.get(account) == Some(&sequence),
                409,
                "pi-aiモデル一覧の取得状態が更新されています。",
            )?;
            let previous = st.vault["accounts"][account].get("catalog").cloned();
            st.vault["accounts"][account]["catalog"] = json!({"schema":1,"version":catalog.version,"at":now_iso(),"models":models});
            if let Err(e) = self.persist(&st) {
                let a = st.vault["accounts"][account].as_object_mut().unwrap();
                match previous {
                    Some(p) => { a.insert("catalog".into(), p); }
                    None => { a.shift_remove("catalog"); }
                }
                return Err(e);
            }
        }
        self.changed();
        self.models(provider, Some(account))
    }
    pub fn begin(&self, body: &Value) -> Result<Value, ApiError> {
        require(body["consent"] == true, 403, "選択したサービスへの認証と利用条件を確認してください。")?;
        let catalog = self.catalog()?;
        let provider = s(body, "provider").to_owned();
        let kind = if body["type"].is_null() { "oauth" } else { s(body, "type") }.to_owned();
        let def = catalog.provider(&provider);
        let (id, pending_id, cancel) = {
            let mut st = self.state();
            require(!st.closed && st.storage_error.is_none(), 400, "pi-ai認証を利用できません。")?;
            require(self.permitted(Domain::Cloud), 403, "オンラインにしてください。")?;
            require(
                def.is_some_and(|d| match kind.as_str() { "oauth" => d["oauth"]["login"] == true, "api_key" => d["apiKeyLogin"] == true, _ => false }),
                400,
                "この認証方式は利用できません。",
            )?;
            require(!st.pending.as_ref().is_some_and(|p| ["pending", "cancelling"].contains(&p.status)), 409, "別のログインを完了または取り消してください。")?;
            let requested = Some(s(body, "accountId")).filter(|a| !a.is_empty());
            let id = match requested {
                Some(id) => {
                    let a = st.vault["accounts"].get(id).filter(|a| s(a, "provider") == provider).ok_or_else(|| fail(409, "pi-aiのアカウントとプロバイダーが一致しません。"))?;
                    require(s(a, "type") == kind, 400, "再ログインの方式を変更できません。")?;
                    id.to_owned()
                }
                None => {
                    require(st.vault["accounts"].as_object().map_or(0, |a| a.len()) < 128, 400, "認証アカウントは128件までです。")?;
                    let id = format!("pi-{}", uuid::Uuid::new_v4());
                    let label = format!("{} · {}", s(def.unwrap(), "name"), &id[id.len() - 6..]);
                    st.vault["accounts"][&id] = json!({"id":id,"provider":provider,"type":kind,"label":label});
                    id
                }
            };
            self.invalidate(&mut st, &id);
            let previous = st.vault["accounts"][&id].as_object_mut().unwrap().shift_remove("catalog");
            if let Err(e) = self.persist(&st) {
                if let Some(p) = previous {
                    st.vault["accounts"][&id]["catalog"] = p;
                }
                return Err(e);
            }
            let pending_id = uuid::Uuid::new_v4().to_string();
            let cancel = RequestCancellation::new();
            st.pending = Some(Pending { id: pending_id.clone(), provider: provider.clone(), account_id: id.clone(), status: "pending", prompt: None, event: None, error: None, cancel: cancel.clone(), reply: None });
            (id, pending_id, cancel)
        };
        let device = s(&self.state().vault, "deviceId").to_owned();
        let this = self.clone();
        self.inner.runtime.spawn(async move {
            let timer = {
                let cancel = cancel.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(LOGIN_TIMEOUT).await;
                    cancel.cancel();
                })
            };
            let data = json!({"operation":"login","provider":provider,"accountId":id,"authType":kind,"deviceId":device});
            let result = this.run(data, &cancel, RunOptions { pending: Some(pending_id.clone()), ..Default::default() }).await;
            timer.abort();
            {
                let mut st = this.state();
                if result.is_ok() {
                    if let Some(a) = st.vault["accounts"].get_mut(&id).and_then(Value::as_object_mut) {
                        a.shift_remove("error");
                    }
                }
                if let Some(p) = st.pending.as_mut().filter(|p| p.id == pending_id) {
                    let aborted = cancel.is_cancelled();
                    p.status = if result.is_ok() { "connected" } else if aborted { "cancelled" } else { "error" };
                    p.error = match (result.is_ok(), aborted) {
                        (true, _) => None,
                        (false, true) => Some("ログインを取り消しました。"),
                        (false, false) => Some("認証に失敗しました。利用条件・入力内容を確認して再試行してください。"),
                    };
                    p.prompt = None;
                    p.event = None;
                    p.reply = None;
                }
            }
            this.changed();
        });
        Ok(self.snapshot())
    }
    pub fn respond(&self, body: &Value) -> Result<Value, ApiError> {
        {
            let mut st = self.state();
            let p = st.pending.as_mut().filter(|p| p.id == s(body, "id") && p.status == "pending" && p.prompt.as_ref().is_some_and(|x| x["id"] == body["promptId"]));
            let p = p.ok_or_else(|| fail(409, "認証の入力待ちが更新されています。"))?;
            let value = body["value"].as_str().filter(|v| json_codec::utf16_units(v).len() <= 64000).ok_or_else(|| fail(400, "認証入力が不正です。"))?;
            let prompt = p.prompt.as_ref().unwrap();
            if prompt["type"] == "select" {
                require(prompt["options"].as_array().is_some_and(|o| o.iter().any(|x| x["id"] == value)), 400, "選択肢が不正です。")?;
            }
            let line = json_codec::stringify_js(&json!({"type":"reply","id":body["promptId"],"value":value})).map_err(|e| ApiError::new(500, e.to_string()))?;
            if let Some(reply) = &p.reply {
                let _ = reply.send(line);
            }
            p.prompt = None;
        }
        Ok(self.snapshot())
    }
    pub fn cancel(&self, id: Option<&str>) -> Value {
        {
            let mut st = self.state();
            if let Some(p) = st.pending.as_mut().filter(|p| id.is_none_or(|id| id == p.id)) {
                p.cancel.cancel();
                if p.status == "pending" {
                    p.status = "cancelling";
                }
                p.prompt = None;
                p.event = None;
            }
        }
        self.snapshot()
    }
    /// Blocking: waits for an in-flight credential mutation. Call off the async reactor.
    pub fn disconnect(&self, id: &str) -> Result<Value, ApiError> {
        {
            let mut st = self.state();
            require(st.vault["accounts"].get(id).is_some(), 404, "Unknown pi-ai account")?;
            self.invalidate(&mut st, id);
        }
        let account_lock = self.account_lock(id);
        let _held = account_lock.blocking_lock();
        {
            let mut st = self.state();
            let a = st.vault["accounts"][id].as_object_mut().ok_or_else(|| fail(404, "Unknown pi-ai account"))?;
            let previous = a.shift_remove("credential");
            a.shift_remove("error");
            if let Err(e) = self.persist(&st) {
                if let Some(c) = previous {
                    st.vault["accounts"][id]["credential"] = c;
                }
                return Err(e);
            }
        }
        self.changed();
        Ok(self.snapshot())
    }
    pub fn browser_url(&self, id: &str) -> Result<String, ApiError> {
        let st = self.state();
        require(!st.closed && st.storage_error.is_none() && self.permitted(Domain::Cloud), 403, "オンラインで認証を開始してください。")?;
        let p = st.pending.as_ref().filter(|p| p.id == id && p.status == "pending" && !p.cancel.is_cancelled());
        let p = p.ok_or_else(|| fail(409, "認証の状態が変わりました。ログインをやり直してください。"))?;
        let url = match p.event.as_ref().map(|e| s(e, "type")) {
            Some("auth_url") => p.event.as_ref().map(|e| s(e, "url")),
            Some("device_code") => p.event.as_ref().map(|e| s(e, "verificationUri")),
            _ => None,
        };
        url.and_then(safe_link).ok_or_else(|| fail(409, "ブラウザーで開く認証URLがまだありません。"))
    }
    /// Explicit profile egress plus provider-owned auth endpoints; no ambient SDK HTTP.
    pub fn scope(&self, url: &str, data: &Value, catalog: &Catalog) -> Result<(Option<Value>, bool), NetworkError> {
        let u = normal_url(url, true)?;
        let provider = s(data, "provider");
        let profile = data.get("profile").filter(|p| p.is_object());
        if provider == "github-copilot" && regex::Regex::new(r"/models/[^/]+/policy$").unwrap().is_match(u.path()) {
            return Err(NetworkError::blocked("Copilotのモデル利用設定はサービス側で明示的に有効化してください。"));
        }
        if let Some(p) = profile {
            if inside_endpoint(u.as_str(), &json_codec::sql_text(s(p, "baseUrl"))) {
                return Ok((Some(p.clone()), true));
            }
        }
        let origin = u.origin().ascii_serialization();
        let mut origins: Vec<String> = auth_origins(provider).iter().map(|o| o.to_string()).collect();
        if profile.is_none() {
            let def = catalog.provider(provider);
            let bases = catalog.models(provider).iter().map(|m| s(m, "baseUrl")).chain(def.map(|d| s(d, "baseUrl")));
            origins.extend(bases.filter_map(|b| url::Url::parse(b).ok()).map(|b| b.origin().ascii_serialization()));
        }
        if let Some(p) = profile {
            if provider == "github-copilot" && data["accountId"].is_string() && catalog::copilot_origin(&origin) {
                let mut p = p.clone();
                p["baseUrl"] = json!(origin);
                return Ok((Some(p), true));
            }
        }
        if !origins.contains(&origin) || u.scheme() != "https" {
            return Err(NetworkError::blocked("pi-aiが登録外の送信先へ接続しようとしました。"));
        }
        Ok((None, false))
    }
    pub fn price(&self, route: &Value) -> Option<Value> {
        if s(route, "authMode") == "pi-oauth" {
            return None;
        }
        let account = Some(s(route, "accountId")).filter(|a| !a.is_empty());
        let cost = self.model(s(route, "piProvider"), s(route, "model"), account).ok()??["cost"].clone();
        cost.is_object().then(|| json!({"input":cost["input"],"output":cost["output"],"cache_read":cost["cacheRead"],"cache_write":cost["cacheWrite"]}))
    }
    /// `PiAIService.chat`: one SDK stream for a registry route.
    #[allow(clippy::too_many_arguments)]
    pub async fn chat(&self, profile: &Value, key: &str, messages: &[Value], options: &Value, sink: &EventSink, cancel: &RequestCancellation, dispatch: Option<DispatchMarker>) -> Result<Value, ProviderFailure> {
        let checked = {
            let this = self.clone();
            let profile = profile.clone();
            tokio::task::spawn_blocking(move || this.assert_profile(&profile).and_then(|_| {
                let account = Some(s(&profile, "accountId")).filter(|a| !a.is_empty());
                this.model(s(&profile, "piProvider"), s(&profile, "model"), account)
            }))
            .await
            .map_err(|_| ProviderFailure::new("unavailable", "pi-ai catalog task failed"))??
        };
        let account = Some(s(profile, "accountId")).filter(|a| !a.is_empty());
        if let Some(account) = account {
            if self.status(account)["connected"] != true {
                let mut e = ProviderFailure::new("auth", "pi-aiへログインしてください。");
                e.status = 401;
                return Err(e);
            }
        }
        let cache_key = options.get("cacheKey").filter(|v| !v.is_null() && v.as_str() != Some(""));
        let cache_text = cache_key.map(|v| v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string()));
        let session_header = match (s(profile, "sessionHeader"), &cache_text) {
            (header, Some(text)) if !header.is_empty() => {
                let digest = format!("{:x}", Sha256::digest(json_codec::sql_text(text).as_bytes()));
                let mut h = Map::new();
                h.insert(header.to_owned(), json!(format!("tepora-{}", &digest[..32])));
                Value::Object(h)
            }
            _ => Value::Null,
        };
        let mut sampling = options["sampling"].as_object().cloned().unwrap_or_default();
        for k in options["compat"]["drop"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            if let Some(k) = k.as_str() {
                sampling.shift_remove(k);
            }
        }
        let mut stream = Map::new();
        stream.insert("tools".into(), options.get("tools").filter(|t| t.is_array()).cloned().unwrap_or(json!([])));
        if let Some(max) = options.get("maxTokens").filter(|v| !v.is_null()) {
            stream.insert("maxTokens".into(), max.clone());
        }
        stream.insert("toolChoice".into(), options.get("toolChoice").filter(|v| v.as_str().is_some_and(|s| !s.is_empty())).cloned().unwrap_or(json!("auto")));
        if let Some(t) = sampling.get("temperature") {
            stream.insert("temperature".into(), t.clone());
        }
        stream.insert("samplingParams".into(), Value::Object(sampling));
        if let Some(key) = cache_key {
            stream.insert("sessionId".into(), key.clone());
        }
        stream.insert("cacheRetention".into(), if profile["cache"] == false { json!("none") } else { options.get("cacheRetention").filter(|v| v.as_str().is_some_and(|s| !s.is_empty())).cloned().unwrap_or(json!("short")) });
        if !s(profile, "reasoningEffort").is_empty() {
            stream.insert("reasoning".into(), profile["reasoningEffort"].clone());
        }
        if let Some(b) = profile.get("thinkingBudget").filter(|b| b.is_number()) {
            stream.insert("thinkingBudgets".into(), json!({"minimal":b,"low":b,"medium":b,"high":b}));
        }
        let data = json!({"operation":"chat","model":checked,"provider":profile["piProvider"],"profile":profile,"key":if account.is_some(){""}else{key},
            "accountId":account,"messages":messages,"options":stream,"sessionHeader":session_header});
        let sink = sink.clone();
        let on_delta: Arc<dyn Fn(&str, &str) + Send + Sync> = Arc::new(move |kind, text| {
            sink(ProviderEvent { kind: if kind == "text_delta" { "text" } else { "reasoning" }.into(), value: json!(text) });
        });
        self.run(data, cancel, RunOptions { on_delta: Some(on_delta), dispatch, ..Default::default() }).await
    }
    pub fn network_changed(&self) {
        let st = self.state();
        for job in st.jobs.values().filter(|j| !self.permitted(j.domain)) {
            job.abort(true, NetworkError::blocked("現在の通信モードではpi-aiの接続先を使用できません。").into());
        }
    }
    pub fn close(&self) {
        let mut st = self.state();
        st.closed = true;
        if let Some(p) = &st.pending {
            p.cancel.cancel();
        }
        for job in st.jobs.values() {
            job.abort(true, cancelled_by_host());
        }
    }
    pub fn active_jobs(&self) -> usize {
        self.state().jobs.len()
    }

    async fn run(&self, data: Value, cancel: &RequestCancellation, options: RunOptions) -> Result<Value, ProviderFailure> {
        let catalog = self.catalog_async().await?;
        let login = s(&data, "operation") == "login";
        let domain = Domain::parse(data["profile"]["domain"].as_str().unwrap_or("cloud")).unwrap_or(Domain::Cloud);
        let account = data["accountId"].as_str().map(str::to_owned);
        let (job_id, job, durable) = {
            let mut st = self.state();
            if st.closed || st.storage_error.is_some() {
                return Err(ProviderFailure::new("unavailable", "pi-aiサービスを利用できません。"));
            }
            if !self.permitted(domain) {
                return Err(NetworkError::blocked("この通信モードではpi-ai接続を利用できません。").into());
            }
            if let Some(e) = cancel.error() {
                return Err(e.into());
            }
            let mut durable = false;
            if let Some(id) = &account {
                let a = st.vault["accounts"].get(id).filter(|a| s(a, "provider") == s(&data, "provider"));
                let a = a.ok_or_else(|| ProviderFailure::from(fail(409, "pi-aiのアカウントとプロバイダーが一致しません。")))?;
                durable = !login && s(a, "type") == "oauth";
            }
            let job = Job { account_id: account.clone(), domain, caller: RequestCancellation::new(), hard: RequestCancellation::new(), reason: Arc::new(Mutex::new(None)) };
            let id = st.next_job;
            st.next_job += 1;
            st.jobs.insert(id, job.clone());
            (id, job, durable)
        };
        let child = match self.inner.command.spawn() {
            Ok(child) => child,
            Err(_) => {
                self.state().jobs.remove(&job_id);
                return Err(ProviderFailure::new("unavailable", "pi-ai Workerを起動できません。依存パッケージとNodeのバージョンを確認してください。"));
            }
        };
        let (done, result) = oneshot::channel();
        let ctx = Arc::new(Context { service: self.clone(), catalog, data, job: job.clone(), durable, dispatch: options.dispatch.clone(), out: Mutex::new(None), leases: Mutex::new(HashMap::new()), last_error: Mutex::new(None), settled: AtomicBool::new(false) });
        self.inner.runtime.spawn(drive(ctx, job_id, child, options, done));
        let watcher = {
            let (job, cancel) = (job.clone(), cancel.clone());
            tokio::spawn(async move {
                let e = cancel.cancelled().await;
                job.abort(!durable, e.into());
            })
        };
        let outcome = if login {
            result.await.unwrap_or_else(|_| Err(job.reason()))
        } else {
            // Release the caller promptly; an OAuth refresh keeps its bounded drain.
            tokio::select! {
                biased;
                _ = job.caller.cancelled() => Err(job.reason()),
                r = result => r.unwrap_or_else(|_| Err(job.reason())),
            }
        };
        watcher.abort();
        outcome
    }
}

struct Lease {
    _guard: tokio::sync::OwnedMutexGuard<()>,
    durable: bool,
}
struct Context {
    service: PiService,
    catalog: Arc<Catalog>,
    data: Value,
    job: Job,
    durable: bool,
    dispatch: Option<DispatchMarker>,
    out: Mutex<Option<mpsc::UnboundedSender<String>>>,
    leases: Mutex<HashMap<String, Lease>>,
    last_error: Mutex<Option<ProviderFailure>>,
    settled: AtomicBool,
}
impl Context {
    fn send(&self, value: Value) {
        if let (Some(out), Ok(line)) = (lock(&self.out).as_ref(), json_codec::stringify_js(&value)) {
            let _ = out.send(line);
        }
    }
}
enum FetchCommand {
    Pull,
    Cancel,
}

async fn drive(ctx: Arc<Context>, job_id: u64, mut child: tokio::process::Child, options: RunOptions, done: oneshot::Sender<Result<Value, ProviderFailure>>) {
    let job = ctx.job.clone();
    let (out, mut lines_out) = mpsc::unbounded_channel::<String>();
    *lock(&ctx.out) = Some(out.clone());
    if let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) {
        tokio::spawn(async move {
            while let Some(line) = lines_out.recv().await {
                if stdin.write_all(format!("{line}\n").as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
        });
        let (messages_tx, mut messages) = mpsc::unbounded_channel::<Value>();
        let reader = tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stdout);
            let mut buffer = Vec::new();
            loop {
                buffer.clear();
                match (&mut reader).take(worker::MAX_LINE as u64 + 1).read_until(b'\n', &mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) if buffer.len() > worker::MAX_LINE => break,
                    Ok(_) => {}
                }
                let Ok(text) = std::str::from_utf8(&buffer) else { break };
                let Ok(message) = json_codec::parse(text.trim_end()) else { break };
                if messages_tx.send(message).is_err() {
                    break;
                }
            }
        });
        ctx.send(json!({"type":"start","data":ctx.data}));
        if let Some(id) = &options.pending {
            if let Some(p) = ctx.service.state().pending.as_mut().filter(|p| &p.id == id) {
                p.reply = Some(out.clone());
            }
        }
        let mut fetches: HashMap<u64, mpsc::UnboundedSender<FetchCommand>> = HashMap::new();
        let mut tasks: Vec<tokio::task::AbortHandle> = Vec::new();
        let (mut caller_seen, mut hard_seen) = (false, false);
        let (mut drain_at, mut kill_at): (Option<Instant>, Option<Instant>) = (None, None);
        let far = || Instant::now() + Duration::from_secs(86400);
        let outcome = loop {
            tokio::select! {
                message = messages.recv() => {
                    let Some(m) = message else { break None };
                    match s(&m, "type") {
                        "fetch" => {
                            let (tx, rx) = mpsc::unbounded_channel();
                            if let Some(id) = m["id"].as_u64() { fetches.insert(id, tx); }
                            tasks.push(tokio::spawn(fetch(ctx.clone(), m, rx)).abort_handle());
                        }
                        "fetch-pull" | "fetch-cancel" => {
                            let command = if s(&m, "type") == "fetch-pull" { FetchCommand::Pull } else { FetchCommand::Cancel };
                            if let Some(tx) = m["id"].as_u64().and_then(|id| fetches.get(&id)) { let _ = tx.send(command); }
                        }
                        "rpc" => tasks.push(tokio::spawn(rpc(ctx.clone(), m)).abort_handle()),
                        "delta" => {
                            if !job.caller.is_cancelled() {
                                if let Some(on_delta) = &options.on_delta { on_delta(s(&m, "kind"), &json_codec::sql_text(s(&m, "text"))); }
                            }
                        }
                        "prompt" | "prompt-cancel" | "auth-event" => {
                            if let Some(id) = &options.pending {
                                if update_pending(&ctx.service, id, &m, job.caller.is_cancelled()) { ctx.service.changed(); }
                            }
                        }
                        "result" => break Some(Ok(m["value"].clone())),
                        "failure" => {
                            let fallback = || ProviderFailure::new(if ["oauth", "auth"].contains(&s(&m, "code")) { "auth" } else { "invalid-output" }, "pi-aiの認証またはモデル応答を処理できませんでした。");
                            break Some(Err(lock(&ctx.last_error).clone().unwrap_or_else(fallback)));
                        }
                        _ => {}
                    }
                }
                _ = job.caller.cancelled(), if !caller_seen => {
                    caller_seen = true;
                    if !job.hard.is_cancelled() {
                        ctx.send(json!({"type":"abort","hard":false}));
                        drain_at.get_or_insert(Instant::now() + ctx.service.inner.drain);
                    }
                }
                _ = job.hard.cancelled(), if !hard_seen => {
                    hard_seen = true;
                    ctx.send(json!({"type":"abort","hard":true}));
                    drain_at = None;
                    kill_at.get_or_insert(Instant::now() + Duration::from_millis(100));
                }
                _ = tokio::time::sleep_until(drain_at.unwrap_or_else(far)), if drain_at.is_some() => {
                    drain_at = None;
                    lock(&job.reason).get_or_insert_with(cancelled_by_host);
                    job.hard.cancel();
                    kill_at = Some(Instant::now());
                }
                _ = tokio::time::sleep_until(kill_at.unwrap_or_else(far)), if kill_at.is_some() => {
                    kill_at = None;
                    let _ = child.start_kill();
                }
            }
        };
        let mut result = outcome.unwrap_or_else(|| Err(if job.hard.is_cancelled() { job.reason() } else { ProviderFailure::new("unavailable", "pi-ai Workerが終了しました。") }));
        if job.caller.is_cancelled() {
            result = Err(job.reason());
        }
        ctx.settled.store(true, Ordering::SeqCst);
        // Cleanup before answering, like the Node host's drained promise.
        job.hard.cancel();
        let _ = child.start_kill();
        let _ = child.wait().await;
        reader.abort();
        for task in tasks {
            task.abort();
        }
        lock(&ctx.leases).clear();
        *lock(&ctx.out) = None;
        finish(&ctx, job_id, &options);
        let _ = done.send(result);
    } else {
        let _ = child.start_kill();
        finish(&ctx, job_id, &options);
        let _ = done.send(Err(ProviderFailure::new("unavailable", "pi-ai Workerを起動できません。")));
    }
}
fn finish(ctx: &Context, job_id: u64, options: &RunOptions) {
    let mut st = ctx.service.state();
    st.jobs.remove(&job_id);
    if let Some(id) = &options.pending {
        if let Some(p) = st.pending.as_mut().filter(|p| &p.id == id) {
            p.reply = None;
        }
    }
}
fn update_pending(service: &PiService, id: &str, m: &Value, cancelled: bool) -> bool {
    let mut st = service.state();
    let Some(p) = st.pending.as_mut().filter(|p| p.id == id) else { return false };
    match s(m, "type") {
        "prompt" if !cancelled => {
            let mut prompt = Map::new();
            prompt.insert("id".into(), m["id"].clone());
            prompt.extend(m["prompt"].as_object().cloned().unwrap_or_default());
            p.prompt = Some(Value::Object(prompt));
            true
        }
        "prompt-cancel" => {
            if p.prompt.as_ref().is_some_and(|x| x["id"] == m["id"]) {
                p.prompt = None;
            }
            false
        }
        "auth-event" if !cancelled => {
            let e = &m["event"];
            let clip = |v: &Value, n: usize| -> String {
                let text = v.as_str().map(str::to_owned).unwrap_or_else(|| if v.is_null() { String::new() } else { v.to_string() });
                json_codec::from_utf16_units(&json_codec::utf16_units(&text).into_iter().take(n).collect::<Vec<_>>())
            };
            p.event = Some(match s(e, "type") {
                "auth_url" => json!({"type":"auth_url","url":safe_link(&json_codec::sql_text(s(e,"url"))),"instructions":clip(&e["instructions"],2000)}),
                "device_code" => json!({"type":"device_code","userCode":clip(&e["userCode"],100),"verificationUri":safe_link(&json_codec::sql_text(s(e,"verificationUri")))}),
                t => json!({"type":t,"message":clip(&e["message"],2000)}),
            });
            true
        }
        _ => false,
    }
}

/// One checked SDK fetch. The worker pulls body chunks; dropping this task drops the socket.
async fn fetch(ctx: Arc<Context>, m: Value, mut commands: mpsc::UnboundedReceiver<FetchCommand>) {
    let id = m["id"].clone();
    let started = async {
        let lease = m["credentialLease"].as_str();
        let durable = ctx.durable && lease.is_some_and(|l| lock(&ctx.leases).get(l).is_some_and(|x| x.durable));
        if !durable {
            if let Some(e) = ctx.job.caller.error() {
                return Err(ProviderFailure::from(e));
            }
        }
        let url = json_codec::sql_text(s(&m, "url"));
        let (profile, inference) = ctx.service.scope(&url, &ctx.data, &ctx.catalog)?;
        if inference && ctx.job.caller.is_cancelled() {
            return Err(ProviderFailure::from(ctx.job.caller.error().unwrap()));
        }
        let cancellation = RequestCancellation::new();
        let link = {
            let (job, cancellation) = (ctx.job.clone(), cancellation.clone());
            tokio::spawn(async move {
                let caller = async { if durable { std::future::pending::<NetworkError>().await } else { job.caller.cancelled().await } };
                tokio::select! { _ = job.hard.cancelled() => {}, _ = caller => {} }
                cancellation.cancel();
            })
        };
        let link = AbortOnDrop(link.abort_handle());
        let init = &m["init"];
        let mut headers = hyper::HeaderMap::new();
        for pair in init["headers"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let (Some(name), Some(value)) = (pair[0].as_str(), pair[1].as_str()) else {
                return Err(ProviderFailure::new("bad-request", "Invalid pi-ai request header"));
            };
            let name = hyper::header::HeaderName::from_bytes(json_codec::sql_text(name).as_bytes());
            let value = hyper::header::HeaderValue::from_str(&json_codec::sql_text(value));
            let (Ok(name), Ok(value)) = (name, value) else {
                return Err(ProviderFailure::new("bad-request", "Invalid pi-ai request header"));
            };
            headers.append(name, value);
        }
        let body = match init["body"].as_str() {
            Some(b) => B64.decode(b).map_err(|_| ProviderFailure::new("bad-request", "Invalid pi-ai request body"))?,
            None => Vec::new(),
        };
        let method = hyper::Method::from_bytes(s(init, "method").as_bytes()).map_err(|_| ProviderFailure::new("bad-request", "Invalid pi-ai request method"))?;
        let mut scope = NetworkScope {
            profile: profile.as_ref().map(NetworkProfile::from_value).transpose()?,
            purpose: Purpose::Model,
            allow_cloud: true,
            asset: true,
            max_bytes: if inference { 64_000_000 } else { 4_000_000 },
            ..Default::default()
        };
        if inference {
            let p = &ctx.data["profile"];
            scope.first_byte_timeout = Some(Duration::from_millis(p["firstByteTimeoutMs"].as_u64().unwrap_or(180_000)));
            scope.idle_timeout = Some(Duration::from_millis(p["idleTimeoutMs"].as_u64().unwrap_or(120_000)));
            scope.dispatch_observer = ctx.dispatch.clone();
        } else {
            scope.timeout = Duration::from_secs(30);
        }
        let request = NetworkRequest { method, headers, body: body.into(), cancellation: Some(cancellation) };
        let response = ctx.service.inner.network.request(&url, request, scope).await?;
        Ok::<_, ProviderFailure>((response, link))
    }
    .await;
    let (response, _link) = match started {
        Ok(r) => r,
        Err(e) => {
            *lock(&ctx.last_error) = Some(e);
            ctx.send(json!({"type":"fetch-error","id":id,"message":"Checked provider request failed"}));
            return;
        }
    };
    let status = response.status;
    let headers: Vec<Value> = response.headers.iter().map(|(k, v)| json!([k.as_str(), String::from_utf8_lossy(v.as_bytes())])).collect();
    enum Source {
        Stream(NetworkBody),
        Buffered(Option<bytes::Bytes>),
    }
    let has_body = response.has_body;
    let mut source = if (200..300).contains(&status) {
        Source::Stream(response.body)
    } else {
        let response_headers = response.headers.clone();
        let bytes = response.bytes().await.unwrap_or_default();
        let mut e = classify_response(status, &response_headers, &String::from_utf8_lossy(&bytes), &[], chrono::Utc::now().timestamp_millis());
        e.message = format!("pi-ai接続先がHTTP {status}を返しました。");
        e.body.clear();
        e.upstream_status = Some(status);
        *lock(&ctx.last_error) = Some(e);
        Source::Buffered(Some(bytes))
    };
    ctx.send(json!({"type":"fetch-headers","id":id,"status":status,"headers":headers,"noBody":!has_body}));
    if !has_body {
        return;
    }
    while let Some(command) = commands.recv().await {
        if matches!(command, FetchCommand::Cancel) {
            return;
        }
        let next = match &mut source {
            Source::Stream(body) => body.next().await,
            Source::Buffered(bytes) => bytes.take().map(Ok),
        };
        match next {
            Some(Ok(chunk)) => ctx.send(json!({"type":"fetch-chunk","id":id,"bytes":B64.encode(&chunk)})),
            None => {
                ctx.send(json!({"type":"fetch-end","id":id}));
                return;
            }
            Some(Err(_)) => {
                ctx.send(json!({"type":"fetch-error","id":id,"message":"Provider stream failed"}));
                return;
            }
        }
    }
}
struct AbortOnDrop(tokio::task::AbortHandle);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Credential calls from the SDK. Only an OAuth refresh holding a lease may commit after
/// caller cancellation; logout/shutdown (hard) always wins.
async fn rpc(ctx: Arc<Context>, m: Value) {
    let result = async {
        let failed = || ProviderFailure::new("auth", "Pi credential operation failed");
        if ctx.job.hard.is_cancelled() {
            return Err(failed());
        }
        let kind = s(&m, "kind");
        let value = &m["value"];
        let lease = value["lease"].as_str().unwrap_or("");
        let held_durable = lock(&ctx.leases).get(lease).is_some_and(|l| l.durable);
        if !(held_durable && ["credential-commit", "credential-unlock"].contains(&kind)) && ctx.job.caller.is_cancelled() {
            return Err(failed());
        }
        let (account, provider) = (s(&ctx.data, "accountId"), s(&ctx.data, "provider"));
        let a = ctx.service.account(account, provider)?;
        match kind {
            "credential-read" => Ok(a.get("credential").cloned()),
            "credential-lock" => {
                let mutex = ctx.service.account_lock(account);
                let guard = tokio::select! {
                    g = mutex.lock_owned() => g,
                    _ = ctx.job.hard.cancelled() => return Err(failed()),
                    _ = ctx.job.caller.cancelled() => return Err(failed()),
                };
                let a = ctx.service.account(account, provider)?;
                let id = uuid::Uuid::new_v4().to_string();
                lock(&ctx.leases).insert(id.clone(), Lease { _guard: guard, durable: ctx.durable });
                let mut out = json!({"lease":id});
                if let Some(c) = a.get("credential") {
                    out["credential"] = c.clone();
                }
                Ok(Some(out))
            }
            "credential-commit" => {
                let held = lock(&ctx.leases).remove(lease).ok_or_else(failed)?;
                let committed = (|| {
                    let mut st = ctx.service.state();
                    let Some(next) = value.get("credential") else {
                        return Ok(st.vault["accounts"][account].get("credential").cloned());
                    };
                    let size = json_codec::stringify_js(next).map(|t| json_codec::utf16_units(&t).len()).unwrap_or(usize::MAX);
                    if s(next, "type") != s(&a, "type") || size >= 256_000 || st.vault["accounts"].get(account).is_none() {
                        return Err(failed());
                    }
                    let previous = st.vault["accounts"][account].get("credential").cloned();
                    st.vault["accounts"][account]["credential"] = next.clone();
                    if ctx.service.persist(&st).is_err() {
                        let a = st.vault["accounts"][account].as_object_mut().unwrap();
                        match previous {
                            Some(p) => { a.insert("credential".into(), p); }
                            None => { a.shift_remove("credential"); }
                        }
                        return Err(failed());
                    }
                    Ok(Some(next.clone()))
                })();
                drop(held);
                committed
            }
            "credential-unlock" => {
                lock(&ctx.leases).remove(lease);
                Ok(None)
            }
            _ => Err(failed()),
        }
    }
    .await;
    if ctx.settled.load(Ordering::SeqCst) {
        return;
    }
    match result {
        Ok(Some(value)) => ctx.send(json!({"type":"reply","id":m["id"],"value":value})),
        Ok(None) => ctx.send(json!({"type":"reply","id":m["id"]})),
        Err(_) => ctx.send(json!({"type":"reply","id":m["id"],"error":"Pi credential operation failed"})),
    }
}

fn fresh_vault() -> Value {
    json!({"schema":1,"deviceId":uuid::Uuid::new_v4().to_string(),"accounts":{}})
}
fn safe_parent(file: &Path) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        match std::fs::symlink_metadata(dir) {
            Ok(m) if !m.is_dir() || m.file_type().is_symlink() => return Err(std::io::Error::other("unsafe credential directory")),
            _ => {}
        }
    }
    match std::fs::symlink_metadata(file) {
        Ok(m) if !m.is_file() || m.file_type().is_symlink() => Err(std::io::Error::other("unsafe credential file")),
        _ => Ok(()),
    }
}
/// Structure only; provider and saved-catalog checks need the SDK catalog (`check_vault`).
fn read_vault(file: &Path) -> Result<Value, String> {
    if !file.exists() {
        return Ok(fresh_vault());
    }
    safe_parent(file).map_err(|e| e.to_string())?;
    let meta = std::fs::symlink_metadata(file).map_err(|e| e.to_string())?;
    if meta.len() > 4_000_000 {
        return Err("Pi credential file is too large".into());
    }
    let text = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
    let v = json_codec::parse(text.trim_end()).map_err(|e| e.to_string())?;
    let accounts = v["accounts"].as_object().filter(|a| a.len() <= 128);
    if v["schema"] != 1 || !v["deviceId"].is_string() || accounts.is_none() {
        return Err("Invalid Pi credential store".into());
    }
    for (id, a) in accounts.unwrap() {
        if !account_id(id) || s(a, "id") != id || !["oauth", "api_key"].contains(&s(a, "type")) || !a["provider"].is_string() {
            return Err("Invalid Pi account".into());
        }
    }
    Ok(v)
}
fn check_vault(vault: &Value, catalog: &Catalog) -> Result<(), ApiError> {
    for a in vault["accounts"].as_object().map(|a| a.values().collect::<Vec<_>>()).unwrap_or_default() {
        require(catalog.provider(s(a, "provider")).is_some(), 500, "Invalid Pi account")?;
        catalog.stored(a.get("catalog").unwrap_or(&Value::Null), s(a, "provider"))?;
    }
    Ok(())
}
fn atomic_write(file: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let dir = file.parent().ok_or_else(|| std::io::Error::other("no credential directory"))?;
    safe_parent(file)?;
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let tmp = dir.join(format!(".pi-ai-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut f = options.open(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, file)?;
        #[cfg(unix)]
        std::fs::File::open(dir)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}
