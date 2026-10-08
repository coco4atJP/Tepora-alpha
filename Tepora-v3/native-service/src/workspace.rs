//! One state/event authority. This developmental workspace runs no external effects.
mod agent_state;
mod media_jobs;
mod speech_stream;
mod voice_operations;
pub(crate) mod photo_frame;
pub(crate) mod avatar_assets;
mod semantic_state;
mod preferences;
mod display_avatar;
pub use display_avatar::VisualAction;
mod capability_state;
pub(crate) mod input_files;
mod session_files;
mod web_state;
mod native_operations;
mod setup_state;
pub use preferences::validate_setup_settings;
mod tools_state;
use crate::{ApiError, Backend, EventRequest, EventSubscription, Operation, Reply, ServiceEvent};
use chrono::{Duration, SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, OnceLock},
};
use tepora_core::{json_codec, projection, store_domain, NativeState};
use tokio::sync::mpsc;
use uuid::Uuid;

pub struct Workspace {
    state: Arc<Mutex<State>>,
    native: OnceLock<NativeResources>,
    preference_changes: Mutex<()>,
    photo_changes: Mutex<()>,
    avatar_asset_changes: Mutex<()>,
    probe_cancel: Mutex<crate::network::RequestCancellation>,
}
struct NativeResources {
    media: Arc<media_jobs::MediaJobs>,
    speech: Arc<speech_stream::SpeechStream>,
    voice: voice_operations::VoiceOperations,
    setup: crate::setup::SetupManager,
    catalog: crate::model_catalog::ModelCatalog,
    host: Arc<crate::agent::host::NativeAgentHost>,
    capabilities: crate::capabilities::Capabilities,
    semantic: Arc<crate::semantic::SemanticMemory>,
    agent: crate::agent::AgentHandle,
    provider: crate::provider::ProviderRuntime,
    network: crate::network::NativeNetwork,
    runtime: tokio::runtime::Handle,
}
/// Narrow shared access to the same database owner, without a reference back
/// to Workspace or its runtime resources. No guard escapes a synchronous call.
#[derive(Clone)]
pub struct WorkspaceAccess {
    state: Arc<Mutex<State>>,
}
struct State {
    db: NativeState,
    dir: PathBuf,
    work_root: PathBuf,
    owner: String,
    defaults: Value,
    subscribers: HashMap<u64, mpsc::Sender<ServiceEvent>>,
    next_subscriber: u64,
    closed: bool,
    closing: bool,
    native_agent: bool,
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn error(e: impl ToString) -> ApiError {
    let s = e.to_string();
    if s.starts_with('[') && s.as_bytes().get(4) == Some(&b']') {
        if let Ok(code) = s[1..4].parse() {
            return ApiError::new(code, s[5..].trim_start());
        }
    }
    ApiError::new(500, s)
}
fn require(ok: bool, status: u16, message: &str) -> Result<(), ApiError> {
    if ok {
        Ok(())
    } else {
        Err(ApiError::new(status, message))
    }
}
fn safe_integer(v: &Value) -> Option<i64> {
    v.as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= crate::MAX_SAFE_INTEGER as f64)
        .map(|n| n as i64)
}
fn truth(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|n| n != 0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
fn str_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::Array(a) => a
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    str_of(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => "[object Object]".into(),
    }
}
fn slice(s: &str, n: usize) -> String {
    let u = json_codec::utf16_units(s);
    json_codec::from_utf16_units(&u[..u.len().min(n)])
}
fn pick(v: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for k in keys {
        if let Some(v) = v.get(*k) {
            out.insert((*k).into(), v.clone());
        }
    }
    Value::Object(out)
}
fn merge(a: &Value, b: &Value) -> Value {
    let mut out = a.as_object().cloned().unwrap_or_default();
    if let Some(b) = b.as_object() {
        for (k, v) in b {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}
fn sandbox_settings(defaults: &Value, raw: &Value) -> Result<Value, ApiError> {
    let raw = if truth(raw) { raw.clone() } else { json!({}) };
    let fields = ["mode", "network", "writable", "image", "engine"];
    require(
        raw.as_object()
            .is_some_and(|o| o.keys().all(|k| fields.contains(&k.as_str())))
            || raw.as_array().is_some_and(|a| a.is_empty()),
        400,
        "Invalid sandbox settings",
    )?;
    let mut c = merge(defaults, &raw);
    require(
        matches!(
            c["mode"].as_str(),
            Some("off" | "workspace" | "readonly" | "container")
        ),
        400,
        "Unknown sandbox mode",
    )?;
    require(c["network"].is_boolean(), 400, "Invalid sandbox network")?;
    require(
        c["writable"].as_array().is_some_and(|a| {
            a.len() <= 16
                && a.iter().all(|p| {
                    p.as_str()
                        .is_some_and(|p| Path::new(&json_codec::sql_text(p)).is_absolute())
                })
        }),
        400,
        "Writable paths must be absolute",
    )?;
    require(
        c["image"].as_str().is_some_and(|s| {
            !s.is_empty()
                && s.len() <= 300
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_./:@-".contains(&b))
        }),
        400,
        "Invalid container image",
    )?;
    require(
        matches!(c["engine"].as_str(), Some("auto" | "docker" | "podman")),
        400,
        "Invalid container engine",
    )?;
    let mut unique = Vec::new();
    for path in c["writable"].as_array().unwrap() {
        if !unique.contains(path) {
            unique.push(path.clone());
        }
    }
    c["writable"] = json!(unique);
    Ok(c)
}
fn platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        env::consts::OS
    }
}
fn arch() -> &'static str {
    match env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}
fn home() -> PathBuf {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}
fn default_dir() -> PathBuf {
    if cfg!(windows) {
        env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(home)
            .join("Tepora/v3")
    } else if cfg!(target_os = "macos") {
        home().join("Library/Application Support/Tepora/v3")
    } else {
        home().join(".local/share/tepora-v3")
    }
}
fn which(name: &str) -> Option<String> {
    env::split_paths(&env::var_os("PATH").unwrap_or_default())
        .map(|p| {
            p.join(if cfg!(windows) {
                format!("{name}.exe")
            } else {
                name.into()
            })
        })
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}
fn sandbox() -> Value {
    json!({"platform":platform(),"seatbelt":cfg!(target_os="macos")&&Path::new("/usr/bin/sandbox-exec").exists(),"bwrap":if cfg!(target_os="linux"){which("bwrap")}else{None},"docker":which("docker"),"podman":which("podman")})
}
#[cfg(unix)]
fn process_alive(pid: u64) -> bool {
    if pid == 0 || pid > i32::MAX as u64 {
        return true;
    }
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}
#[cfg(windows)]
fn process_alive(pid: u64) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    if pid == 0 || pid > u32::MAX as u64 {
        return true;
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
        if h.is_null() {
            return GetLastError() != ERROR_INVALID_PARAMETER;
        }
        let mut code = 0;
        let ok = GetExitCodeProcess(h, &mut code);
        CloseHandle(h);
        ok == 0 || code == 259
    }
}
#[cfg(not(any(unix, windows)))]
fn process_alive(_pid: u64) -> bool {
    true
}

impl Workspace {
    pub fn open(dir: &Path) -> Result<Self, ApiError> {
        // Preserve the caller-facing spelling, as the Node Store does. Windows
        // canonicalize adds a verbatim prefix that must stay an internal detail.
        let public_dir = dir.to_path_buf();
        fs::create_dir_all(dir).map_err(error)?;
        let dir = fs::canonicalize(dir).map_err(error)?;
        let defaults = json_codec::parse(include_str!("../defaults.json")).map_err(error)?;
        let db =
            NativeState::open(&dir.join("tepora-v3.sqlite").to_string_lossy()).map_err(error)?;
        let mut s = State {
            db,
            dir: public_dir.clone(),
            work_root: public_dir.join("work"),
            owner: Uuid::new_v4().to_string(),
            defaults,
            subscribers: HashMap::new(),
            next_subscriber: 0,
            closed: false,
            closing: false,
            native_agent: false,
        };
        s.call("exec", json!({"sql":"BEGIN IMMEDIATE"}))?;
        let result = (|| {
            let lease = s.value("service-owner")?;
            if !lease.is_null() {
                require(
                    lease["pid"].as_u64().is_some_and(|pid| !process_alive(pid)),
                    409,
                    "Tepora is already using this data directory.",
                )?;
            }
            s.set_value(
                "service-owner",
                json!({"id":s.owner,"pid":std::process::id()}),
            )?;
            if !truth(&s.value("search-schema-v1")?) {
                for kind in ["memory", "job"] {
                    for doc in s.list(kind)? {
                        s.index(kind, &doc)?;
                    }
                }
                s.set_value("search-schema-v1", json!(true))?;
            }
            for mut job in s.list("job")? {
                if job.get("revision").is_none()
                    && job["kind"] != "demo"
                    && job["step"].as_f64().unwrap_or(0.0) > 0.0
                    && s.get("checkpoint", job["id"].as_str().unwrap_or(""))?
                        .is_null()
                {
                    job["resumeBlocked"] = json!(true);
                    job["note"] = json!("以前の版の実行記録を確認できないため、自動再開しません。");
                    s.put("job", job.clone())?;
                }
                if matches!(
                    job["status"].as_str(),
                    Some("running" | "queued" | "waiting_approval")
                ) && !(job["status"] == "waiting_approval" && truth(&job["parked"]))
                {
                    job["status"] = json!("interrupted");
                    job["approval"] = Value::Null;
                    job["note"] = json!(
                        "前回の仕事を保存しています。結果不明の操作を確認してから再開できます。"
                    );
                    s.put("job", job)?;
                }
            }
            Ok(())
        })();
        if let Err(e) = result {
            let _ = s.call("exec", json!({"sql":"ROLLBACK"}));
            s.closed = true;
            let _ = s.call("close", json!({}));
            return Err(e);
        }
        s.call("exec", json!({"sql":"COMMIT"}))?;
        let settings = s.agent_settings()?;
        s.work_root = if settings["workRoot"].as_str().is_some_and(|s| !s.is_empty()) {
            PathBuf::from(json_codec::sql_text(settings["workRoot"].as_str().unwrap()))
        } else if env::var_os("TEPORA_DATA_DIR").is_none()
            && fs::canonicalize(default_dir()).ok().as_ref() == Some(&dir)
        {
            home().join("Tepora")
        } else {
            public_dir.join("work")
        };
        s.main()?;
        // Live approval waiters do not survive process restart. Retain the
        // original request for history, but never restore its permission.
        for mut approval in s.list("approval")? {
            if approval["status"] == "pending" {
                approval["status"] = json!("withdrawn");
                approval["decidedAt"] = json!(now());
                s.put("approval", approval)?;
            }
        }
        if s.get("skill", "artifact-studio")?.is_null() {
            s.put("skill",json!({"id":"artifact-studio","name":"Artifact studio","description":"成果物を早く公開し、同じIDで段階的に更新する。","content":"# Artifact studio\nPublish a first useful HTML or Markdown artifact early, then revise it with artifact edit.","enabled":true,"source":"builtin","createdAt":now()}))?;
        }
        Ok(Self {
            state: Arc::new(Mutex::new(s)),
            native: OnceLock::new(),
            preference_changes: Mutex::new(()),
            photo_changes: Mutex::new(()),
            avatar_asset_changes: Mutex::new(()),
            probe_cancel: Mutex::new(crate::network::RequestCancellation::new()),
        })
    }
    fn lock(&self) -> Result<MutexGuard<'_, State>, ApiError> {
        self.state
            .lock()
            .map_err(|_| ApiError::new(500, "State owner unavailable"))
    }
    pub fn access(&self) -> WorkspaceAccess {
        WorkspaceAccess {
            state: self.state.clone(),
        }
    }
    pub fn enable_agent(&self, runtime: tokio::runtime::Handle) -> Result<(), ApiError> {
        self.enable_agent_setup(runtime,crate::setup::SetupOptions::default())
    }
    #[cfg(test)]
    pub(crate) fn enable_agent_with_setup(&self,runtime:tokio::runtime::Handle,options:crate::setup::SetupOptions)->Result<(),ApiError> {
        self.enable_agent_setup(runtime,options)
    }
    fn enable_agent_setup(&self, runtime:tokio::runtime::Handle, setup_options:crate::setup::SetupOptions)->Result<(),ApiError> {
        require(
            self.native.get().is_none(),
            409,
            "Native agent is already enabled",
        )?;
        let (dir, policy) = {
            let mut s = self.lock()?;
            (s.dir.clone(), s.value("network-policy")?)
        };
        match fs::read_dir(dir.join("plugins")) {
            Ok(entries) => {
                for entry in entries {
                    let entry = entry.map_err(error)?;
                    if entry.file_name().to_string_lossy().ends_with(".mjs") {
                        return Err(ApiError::unavailable(
                            "Configured JavaScript plugins require the compatibility host",
                        ));
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(error(e)),
        }
        let network = crate::network::NativeNetwork::new(
            crate::network::NetworkPolicy::from_value(&policy).map_err(ApiError::from)?,
        );
        let provider =
            crate::provider::ProviderRuntime::new(Arc::new(self.access()), network.clone());
        let capabilities =
            crate::capabilities::Capabilities::new(Arc::new(self.access()), network.clone());
        let decisions = Arc::new(crate::agent::decisions::Decisions::with_backend(Arc::new(
            crate::capabilities::CapabilityDecisionBackend::new(capabilities.clone()),
        )));
        let semantic=Arc::new(crate::semantic::SemanticMemory::new(Arc::new(self.access()),capabilities.clone()));
        let host = Arc::new(crate::agent::host::NativeAgentHost::new_with_semantic(
            self.access(),
            provider.clone(),
            network.clone(),
            decisions,
            semantic.clone(),
        )?);
        host.preflight()?;
        host.recover()?;
        let agent = crate::agent::AgentCoordinator::start(host.clone(), runtime.clone())?;
        let setup=crate::setup::SetupManager::with_options(self.access().setup_state(agent.clone()),network.clone(),runtime.clone(),setup_options)?;
        let catalog=crate::model_catalog::ModelCatalog::new(Arc::new(self.access()),network.clone());
        let media=media_jobs::MediaJobs::new(self.access(),capabilities.clone(),network.clone(),runtime.clone())?;
        self.native
            .set(NativeResources {
                speech: speech_stream::SpeechStream::new(network.clone(),runtime.clone()),
                voice: voice_operations::VoiceOperations::new(provider.clone(),network.clone()),
                media,
                setup,
                catalog,
                host,
                capabilities,
                semantic,
                agent: agent.clone(),
                provider,
                network,
                runtime,
            })
            .map_err(|_| ApiError::new(409, "Native agent was enabled concurrently"))?;
        self.lock()?.native_agent = true;
        agent.request(crate::agent::AgentRequest::Initialize)?;
        Ok(())
    }
    fn cancel_probes(&self) -> Result<(), ApiError> {
        let mut token = self
            .probe_cancel
            .lock()
            .map_err(|_| ApiError::new(500, "Probe cancellation owner unavailable"))?;
        let old = std::mem::replace(&mut *token, crate::network::RequestCancellation::new());
        old.cancel();
        Ok(())
    }
}
impl WorkspaceAccess {
    fn lock(&self) -> Result<MutexGuard<'_, State>, ApiError> {
        let state = self
            .state
            .lock()
            .map_err(|_| ApiError::new(500, "State owner unavailable"))?;
        require(!state.closed, 503, "Workspace is closed")?;
        Ok(state)
    }
}
impl crate::provider::ProviderState for WorkspaceAccess {
    fn value(&self, key: &str) -> Result<Option<Value>, ApiError> {
        let value = self.lock()?.value(key)?;
        Ok((!value.is_null()).then_some(value))
    }
    fn set_value(&self, key: &str, value: Value) -> Result<(), ApiError> {
        self.lock()?.set_value(key, value)
    }
    fn set_values(&self, values: &[(String, Value)]) -> Result<(), ApiError> {
        self.agent_batch(
            &values
                .iter()
                .map(|(key, value)| ("kv.set".into(), json!({"key":key,"value":value})))
                .collect::<Vec<_>>(),
        )
        .map(|_| ())
    }
    fn get(&self, collection: &str, id: &str) -> Result<Option<Value>, ApiError> {
        let value = self.lock()?.get(collection, id)?;
        Ok((!value.is_null()).then_some(value))
    }
    fn put(&self, collection: &str, value: Value) -> Result<(), ApiError> {
        self.lock()?.put(collection, value).map(|_| ())
    }
    fn emit(&self, event: &str, data: Value) -> Result<(), ApiError> {
        let mut state = self.lock()?;
        let value = state.call("event.append", json!({"type":event,"data":data,"at":now()}))?;
        state.publish_value(value)
    }
}
impl State {
    fn call(&mut self, op: &str, p: Value) -> Result<Value, ApiError> {
        let request = json_codec::stringify_js(&p).map_err(error)?;
        json_codec::parse(&self.db.call_json(op, &request).map_err(error)?).map_err(error)
    }
    fn value(&mut self, key: &str) -> Result<Value, ApiError> {
        self.call("kv.get", json!({"key":key}))
    }
    fn set_value(&mut self, key: &str, value: Value) -> Result<(), ApiError> {
        self.call("kv.set", json!({"key":key,"value":value}))
            .map(|_| ())
    }
    fn list(&mut self, kind: &str) -> Result<Vec<Value>, ApiError> {
        Ok(self
            .call("document.list", json!({"kind":kind}))?
            .as_array()
            .cloned()
            .unwrap_or_default())
    }
    fn get(&mut self, kind: &str, id: &str) -> Result<Value, ApiError> {
        self.call("document.get", json!({"kind":kind,"id":id}))
    }
    fn index(&mut self, kind: &str, doc: &Value) -> Result<(), ApiError> {
        self.call(
            "document.index",
            json!({"kind":kind,"id":doc["id"],"terms":store_domain::indexed_text(doc,17)}),
        )
        .map(|_| ())
    }
    fn put(&mut self, kind: &str, doc: Value) -> Result<Value, ApiError> {
        let mut args = json!({"kind":kind,"doc":doc});
        if matches!(kind, "memory" | "job") {
            args["terms"] = json!(store_domain::indexed_text(&args["doc"], 17));
        }
        self.call("document.put", args)?;
        Ok(doc)
    }
    fn domain(&mut self, op: &str, args: Value) -> Result<Value, ApiError> {
        let reply = self.call(op, args)?;
        if let Some(events) = reply["events"].as_array() {
            for event in events {
                self.publish_value(event.clone())?;
            }
        }
        Ok(reply["value"].clone())
    }
    fn settings(&mut self) -> Result<Value, ApiError> {
        self.domain("store.settings", json!({}))
    }
    fn agent_settings(&mut self) -> Result<Value, ApiError> {
        let raw = self.value("agent-settings")?;
        let mut settings = merge(&self.defaults["agent"], &raw);
        for name in [
            "heartbeat",
            "cacheRetention",
            "budget",
            "webSearch",
            "policy",
        ] {
            settings[name] = merge(&self.defaults["agent"][name], &raw[name]);
        }
        settings["sandbox"] =
            sandbox_settings(&self.defaults["agent"]["sandbox"], &raw["sandbox"])?;
        Ok(settings)
    }
    fn personas(&mut self) -> Result<Value, ApiError> {
        let stored = self.value("dialogue-personas")?;
        let mut p = if truth(&stored) {
            require(stored.is_object(), 500, "Invalid saved personas")?;
            require(
                stored["character"].is_null() || stored["character"].is_object(),
                500,
                "Invalid saved character persona",
            )?;
            stored
        } else {
            let mut p = self.defaults["personas"].clone();
            let settings = self.settings()?;
            let name = if truth(&settings["companion"]) {
                str_of(&settings["companion"])
            } else {
                "Tepora".into()
            };
            p["character"]["name"] = json!(slice(&name, 80));
            p
        };
        if !truth(&p["character"]["voice"]) {
            p["character"]["voice"] = self.defaults["personas"]["character"]["voice"].clone();
        }
        Ok(p)
    }
    fn main(&mut self) -> Result<Value, ApiError> {
        if let Some(s) = self
            .list("session")?
            .into_iter()
            .find(|s| s["kind"] == "main")
        {
            return Ok(s);
        }
        fs::create_dir_all(&self.work_root).map_err(error)?;
        let personas = self.personas()?;
        let at = now();
        let s = json!({"id":Uuid::new_v4().to_string(),"kind":"main","title":personas["character"]["name"],"parentId":null,"rootId":null,"depth":0,"status":"idle","role":"chat","toolset":"main","persona":null,"cwd":self.work_root.to_string_lossy(),"task":null,"label":null,"result":null,"note":"","stats":{"steps":0,"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"compactions":0,"clears":0},"createdAt":at,"updatedAt":at});
        self.put("session", s)
    }
    fn usage(&mut self) -> Result<Value, ApiError> {
        let current = Utc::now();
        let mut days = Map::new();
        for i in 0..7 {
            let day = (current - Duration::days(i)).format("%Y-%m-%d").to_string();
            days.insert(day.clone(), self.value(&format!("agent-usage:{day}"))?);
        }
        let today = days.values().next().cloned().unwrap_or(Value::Null);
        Ok(json!({"today":today,"days":days}))
    }
    fn ui(&mut self, operation: &str) -> Result<Value, ApiError> {
        let main = self.main()?;
        let entries = self.call("session.tail", json!({"id":main["id"],"limit":1200}))?;
        let payload = json!({"main":main,"entries":entries,"sessions":self.list("session")?,"approvals":self.list("approval")?,"personas":self.personas()?,"settings":self.agent_settings()?,"usage":self.usage()?});
        json_codec::parse(
            &projection::project_json(
                operation,
                &json_codec::stringify_js(&payload).map_err(error)?,
            )
            .map_err(error)?,
        )
        .map_err(error)
    }
    fn providers(&mut self) -> Result<Value, ApiError> {
        let raw = self.value("provider-registry")?;
        let mut c = if raw.is_null() {
            json!({"schema":2,"revision":0,"profiles":[],"routes":{}})
        } else {
            raw
        };
        require(
            c.is_object() && c["profiles"].is_array(),
            500,
            "Invalid saved provider registry",
        )?;
        let keys = self.value("provider-keys")?;
        let mut profiles = Vec::new();
        for mut p in c["profiles"].as_array().cloned().unwrap_or_default() {
            let id = p["id"].as_str().unwrap_or("");
            let key_present = truth(&keys[id])
                || p["apiKeyEnv"]
                    .as_str()
                    .and_then(|name| env::var(name).ok())
                    .is_some_and(|s| !s.is_empty());
            p["keyPresent"] = json!(key_present);
            p["health"] = Value::Null;
            p["limits"] = self.value(&format!(
                "provider-limits:{}",
                p["identity"].as_str().unwrap_or("")
            ))?;
            p["probe"] = self.get("provider-probe", p["identity"].as_str().unwrap_or(""))?;
            profiles.push(p);
        }
        c["profiles"] = json!(profiles);
        c["resources"] = json!([]);
        Ok(c)
    }
    fn snapshot(&mut self) -> Result<Value, ApiError> {
        let base = self.domain("store.snapshot", json!({}))?;
        let ui = self.ui("ui.snapshot")?;
        let mut s = merge(&base, &ui);
        let network = self.value("network-policy")?;
        s["network"] = if network.is_null() {
            json!({"schema":1,"revision":0,"mode":"online","internetTools":true})
        } else {
            network
        };
        s["providers"] = self.providers()?;
        let capabilities = self.value("capabilities")?;
        let mut capabilities = if capabilities.is_null() {
            json!({"schema":1,"revision":0,"profiles":[],"routes":{}})
        } else {
            capabilities
        };
        require(
            capabilities.is_object() && capabilities["profiles"].is_array(),
            500,
            "Invalid saved capabilities",
        )?;
        if let Some(profiles) = capabilities["profiles"].as_array_mut() {
            for p in profiles {
                p["keyPresent"] = json!(p["apiKeyEnv"]
                    .as_str()
                    .and_then(|key| env::var(key).ok())
                    .is_some_and(|s| !s.is_empty()));
            }
        }
        s["capabilities"] = capabilities;
        let computer = self.value("computer-config")?;
        s["computer"] = json!({"config":if computer["schema"]==2{computer}else{json!({"schema":2,"revision":0,"enabled":true,"control":"both","headless":true,"browserExecutable":"","desktop":true,"maxSteps":12})},"browser":{"executable":null,"running":false,"tabs":0},"desktop":{"supported":cfg!(target_os="macos"),"running":false},"decision":false,"nativeUnavailable":true});
        let display = self.value("display")?;
        s["display"] = if display.is_null() {
            self.defaults["display"].clone()
        } else {
            display
        };
        let avatar = self.value("avatar")?;
        s["avatar"] = if avatar.is_null() {
            self.defaults["avatar"].clone()
        } else {
            avatar
        };
        let assets = self.value("avatar-assets")?;
        s["avatarAssets"] = avatar_assets::snapshot(&assets);
        let photos = self.value("frame-photos")?;
        s["frame"] = photo_frame::snapshot(&photos);
        s["mediaJobs"] = json!(self
            .list("media-job")?
            .iter()
            .map(|j| {
                let mut out = pick(
                    j,
                    &[
                        "id",
                        "title",
                        "kind",
                        "status",
                        "note",
                        "createdAt",
                        "updatedAt",
                        "model",
                        "jobId",
                        "asset",
                    ],
                );
                if let Some(name) = j.get("providerName") {
                    out["provider"] = name.clone();
                }
                out["providerMayContinue"] = json!(truth(&j["providerMayContinue"]));
                if self.native_agent {return media_jobs::public(j);}
                out["canResume"] = json!(false);
                out["nativeUnavailable"] = json!(true);
                out
            })
            .collect::<Vec<_>>());
        s["sandbox"] = sandbox();
        s["nativeHost"] = json!({"development":true,"mode":if self.native_agent{"native-agent"}else{"local-workspace"},"nodeRequired":false,"agentExecution":self.native_agent,"externalEffects":self.native_agent,"unavailable":if self.native_agent{json!(["browser rendering","MCP","media agent tools","computer use","schedules","heartbeat","dream optimization","JavaScript plugins"])}else{json!(["agent execution","external effects"])}});
        Ok(s)
    }
    fn publish_value(&mut self, value: Value) -> Result<(), ApiError> {
        let payload = json!({"event":value,"sessions":self.list("session")?,"approvals":self.list("approval")?});
        let derived = json_codec::parse(
            &projection::project_json(
                "ui.event",
                &json_codec::stringify_js(&payload).map_err(error)?,
            )
            .map_err(error)?,
        )
        .map_err(error)?;
        if let Some(events) = derived.as_array() {
            for event in events {
                self.send_event(ServiceEvent {
                    seq: None,
                    event_type: event["type"].as_str().unwrap_or("").into(),
                    data: event["data"].clone(),
                    at: Some(now()),
                });
            }
        }
        self.send_event(ServiceEvent {
            seq: value["seq"].as_u64(),
            event_type: value["type"].as_str().unwrap_or("").into(),
            data: value["data"].clone(),
            at: value["at"].as_str().map(str::to_owned),
        });
        Ok(())
    }
    fn send_event(&mut self, event: ServiceEvent) {
        self.subscribers
            .retain(|_, sender| sender.try_send(event.clone()).is_ok());
    }
    fn artifact(&mut self, id: &str, version: Option<u64>) -> Result<Value, ApiError> {
        let current = self.get("artifact", id)?;
        require(!current.is_null(), 404, "Artifact not found")?;
        if let Some(version) = version {
            if safe_integer(&current["version"]) != Some(version as i64) {
                let old = self.get("revision", &format!("{id}:{version}"))?;
                require(!old.is_null(), 404, "Artifact revision not found")?;
                return Ok(old);
            }
        }
        Ok(current)
    }
    fn close(&mut self) -> Result<(), ApiError> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        self.subscribers.clear();
        if self.value("service-owner")?["id"] == self.owner {
            self.call("kv.delete", json!({"key":"service-owner"}))?;
        }
        self.call("close", json!({})).map(|_| ())
    }
}
impl Drop for State {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
fn ram_bytes() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let pages = unsafe { libc::sysconf(libc::_SC_PHYS_PAGES) };
        let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if pages > 0 && size > 0 {
            return (pages as u64).checked_mul(size as u64);
        }
    }
    None
}
impl Backend for Workspace {
    fn setup_install_permitted(&self)->Result<(),ApiError> {
        {let state=self.lock()?;require(!state.closed&&!state.closing,503,"Service closing")?;}
        let native=self.native.get().ok_or_else(||ApiError::unavailable("This effect requires --dev-native --agent"))?;
        if native.network.policy().mode!=crate::network::NetworkMode::Online {return Err(crate::network::NetworkError::blocked("制限モードではモデルを取得しません。").into());}
        Ok(())
    }
    fn execute_setup(&self,operation:Operation,cancellation:crate::network::RequestCancellation)->std::pin::Pin<Box<dyn std::future::Future<Output=Result<Reply,ApiError>>+Send+'static>> {
        let resources=(|| {
            {let state=self.lock()?;require(!state.closed&&!state.closing,503,"Service closing")?;}
            let native=self.native.get().ok_or_else(||ApiError::unavailable("This effect requires --dev-native --agent"))?;
            Ok::<_,ApiError>((native.setup.clone(),native.catalog.clone(),native.network.clone()))
        })();
        Box::pin(async move {
            let (setup,catalog,network)=resources?;
            if let Some(error)=cancellation.error(){return Err(error.into());}
            let value=match operation {
                Operation::ModelCatalogRefresh=>catalog.refresh(&cancellation).await?,
                Operation::SetupScan=>setup.scan_with_cancel(&cancellation).await?,
                Operation::SetupSelect{body}=>setup.select_with_cancel(body["candidateId"].as_str().unwrap_or(""),body["consentTest"]==true,&cancellation).await?,
                Operation::RuntimeDiscover=>crate::runtime_discovery::discover(&network,&cancellation).await,
                _=>return Err(ApiError::bad_request("Not a setup network operation")),
            };
            if let Some(error)=cancellation.error(){return Err(error.into());}
            Ok(Reply::Json(value))
        })
    }
    fn execute(&self, operation: Operation) -> Result<Reply, ApiError> {
        if let Some(reply) = self.execute_avatar_assets(&operation)? { return Ok(reply); }
        if let Some(reply) = self.execute_frame(&operation)? { return Ok(reply); }
        if let Some(reply) = self.execute_visual(&operation)? { return Ok(reply); }
        match &operation {
            Operation::InputsStage { body } => return self.stage_inputs(&body["files"]).map(Reply::Json),
            Operation::InputDelete { id } => return self.remove_input(id).map(Reply::Json),
            Operation::SessionFiles { id } | Operation::SessionDownload { id, .. } => {
                let root = {
                    let mut state = self.lock()?;
                    require(!state.closed && !state.closing,503,"Service closing")?;
                    let session=state.get("session",id)?;
                    require(!session.is_null(),404,"Session not found")?;
                    session["cwd"].as_str().filter(|p|!p.is_empty())
                        .map(|p|PathBuf::from(json_codec::sql_text(p))).unwrap_or_else(||state.work_root.clone())
                };
                return match &operation {
                    Operation::SessionFiles { .. } => session_files::list_files(&root).map(Reply::Json),
                    Operation::SessionDownload { path, .. } => session_files::download(&root,path).map(|(bytes,disposition)|Reply::Download { bytes,disposition }),
                    _ => unreachable!(),
                };
            }
            _ => {}
        }

        if let Some(reply) = self.execute_native(&operation)? {
            return Ok(reply);
        }
        let invalidate_memory=match &operation {
            Operation::MemoryPatch{id,body} if ["content","scope","confirmed"].iter().any(|k|body.get(k).is_some())=>Some(id.clone()),
            Operation::MemoryDelete{id}=>Some(id.clone()),
            _=>None,
        };
        let bootstrap = matches!(&operation, Operation::Bootstrap);
        let process_session = match &operation {
            Operation::Session { id, .. } => Some(id.clone()),
            _ => None,
        };
        let mut s = self.lock()?;
        require(!s.closed && !s.closing, 503, "Service closing")?;
        let mut value=match operation{
   Operation::Bootstrap=>{
    let mut v=s.snapshot()?;let settings=s.settings()?;
    let first=s.list("session")?.into_iter().find(|s|s["kind"]!="main"&&matches!(s["status"].as_str(),Some("done"|"idle"))&&truth(&s["result"]));
    v["setup"]=json!({"dismissed":truth(&s.value("setup-dismissed")?),"configured":truth(&settings["model"]),"verified":false,"checkedAt":null,"model":settings["model"],"provider":settings["provider"],"local":settings["baseUrl"].as_str().is_some_and(|v|v.starts_with("http://127.0.0.1:")||v.starts_with("http://localhost:")),"stage":if first.is_some(){"first-result"}else{"connect"},"firstResult":first.as_ref().map(|s|pick(s,&["id","title"])),"candidates":[],"engines":[],"transfer":s.value("setup-transfer")?,"checking":false,"catalog":[],"ramGiB":ram_bytes().map(|n|n/(1<<30)),"note":"Rust開発用のローカル作業領域です。モデル接続と外部操作はこの起動方法ではまだ利用できません。"});
    v["platform"]=json!(platform());v["workspace"]=json!(s.work_root.to_string_lossy());v["preview"]=json!(false);v["version"]=json!(crate::VERSION);v
   },
   Operation::Agent=>s.ui("ui.snapshot")?,
   Operation::Dialogue=>s.ui("ui.dialogue")?,
   Operation::Sessions=>json!(s.list("session")?.into_iter().map(|mut v|{if let Some(o)=v.as_object_mut(){o.shift_remove("system");}v}).collect::<Vec<_>>()),
   Operation::Session{id,before,limit}=>{
    let session=s.get("session",&id)?;require(!session.is_null(),404,"Session not found")?;
    require(limit.is_finite()&&limit.fract()==0.0&&limit.abs()<=crate::MAX_SAFE_INTEGER as f64,400,"Invalid limit")?;let limit=limit.min(500.0)as i64;
    let mut entries=if let Some(before)=before.filter(|n|*n!=0.0){
     require(before.is_finite()&&before.fract()==0.0&&before.abs()<=crate::MAX_SAFE_INTEGER as f64,400,"Invalid before")?;
     let all=s.call("session.entries",json!({"id":id,"to":before as i64-1}))?;let mut a=all.as_array().cloned().unwrap_or_default();
     let start=if limit==0{0}else if limit>0{a.len().saturating_sub(limit as usize)}else{(-limit)as usize};a.drain(..start.min(a.len()));json!(a)
    }else{s.call("session.tail",json!({"id":id,"limit":limit}))?};
    if let Some(entries)=entries.as_array_mut(){for e in entries{if e["type"]=="tool"{let content=if truth(&e["content"]){str_of(&e["content"])}else{String::new()};e["content"]=json!(slice(&content,4000));}else if e["type"]=="checkpoint"{*e=pick(e,&["seq","type","at","upTo","method","reason","summary"]);}}}
    let job=if session["kind"]=="main"{Value::Null}else{let n=s.list("approval")?.iter().filter(|a|a["sessionId"]==id&&a["status"]=="pending").count();json_codec::parse(&projection::project_json("ui.job",&json_codec::stringify_js(&json!({"session":session,"approvals":n})).map_err(error)?).map_err(error)?).map_err(error)?};
    let mut public=session;if let Some(o)=public.as_object_mut(){o.shift_remove("system");}json!({"session":public,"job":job,"entries":entries,"processes":[]})
   },
   Operation::MemoryCreate{body}=>s.domain("store.memory",json!({"content":body["content"],"options":{"title":body["title"].as_str().unwrap_or(""),"confirmed":true,"scope":body["scope"]}}))?,
   Operation::MemoryPatch{id,body}=>s.domain("store.memoryPatch",json!({"id":id,"patch":body}))?,
   Operation::MemoryDelete{id}=>s.domain("store.memoryDelete",json!({"id":id}))?,
   Operation::Artifacts=>json!(s.list("artifact")?),
   Operation::ArtifactEdit{id,body}=>{
    let old=s.artifact(&id,None)?;require(body["expectedVersion"].as_f64().is_some_and(|n|n.is_finite()&&n.fract()==0.0&&n.abs()<=crate::MAX_SAFE_INTEGER as f64),400,"A base revision is required")?;
    s.domain("store.artifact",json!({"title":old["title"],"content":body["content"],"options":{"id":id,"kind":old["kind"],"jobId":old["jobId"],"expectedVersion":body["expectedVersion"]}}))?
   },
   Operation::ArtifactRevisions{id,version}=>{
    let current=s.artifact(&id,None)?;
    if let Some(version)=version{let doc=s.artifact(&id,Some(version))?;let mut v=pick(&doc,&["title","kind","version","updatedAt","content"]);v["id"]=current["id"].clone();v}
    else{let mut versions=vec![pick(&current,&["version","updatedAt","title"])];versions.extend(s.list("revision")?.iter().filter(|r|r["artifactId"]==id).map(|r|pick(r,&["version","updatedAt","title"])));versions.sort_by(|a,b|safe_integer(&b["version"]).unwrap_or(0).cmp(&safe_integer(&a["version"]).unwrap_or(0)));json!({"id":id,"versions":versions})}
   },
   Operation::RenderArtifact{id,version}=>{
    let current=s.artifact(&id,None)?;if let Some(v)=version{require(v>0&&v<=crate::MAX_SAFE_INTEGER,400,"Invalid revision")?;}
    let doc=if version.is_none(){current}else{s.artifact(&id,version)?};let interactive=s.agent_settings()?["sandbox"]["mode"]=="off";
    return Ok(Reply::Render{kind:doc["kind"].as_str().unwrap_or("text").into(),content:doc["content"].as_str().unwrap_or("").into(),interactive});
   },
   Operation::Export=>s.domain("store.export",json!({}))?,
   Operation::Import{body}=>s.domain("store.import",json!({"bundle":body}))?,
   Operation::Presence{body}=>{require(matches!(body["state"].as_str(),Some("present"|"away")),400,"Invalid presence")?;s.set_value("presence",json!({"state":body["state"],"at":now()}))?;json!({"presence":body["state"]})},
   Operation::Doctor=>{let providers=s.providers()?;json!({"platform":platform(),"arch":arch(),"ramBytes":ram_bytes(),"cpuThreads":std::thread::available_parallelism().map(|n|n.get()).unwrap_or(1),"sandbox":sandbox(),"providers":providers["profiles"].as_array().unwrap_or(&Vec::new()).iter().map(|p|pick(p,&["id","model","domain","limits"])).collect::<Vec<_>>(),"note":"Rust開発用ローカル作業領域。モデル・GPU・外部操作の動作確認ではありません。","dataLocation":s.dir.to_string_lossy(),"workRoot":s.work_root.to_string_lossy(),"nativeDevelopment":true})},
   _=>return Err(ApiError::unavailable("Native operation was not dispatched")),
  };
        if bootstrap {if let Some(native)=self.native.get(){value["setup"]=native.setup.snapshot_from(s.setup_stored()?)?;}}
        drop(s);
        if let (Some(id),Some(native))=(invalidate_memory,self.native.get()){native.semantic.invalidate_memory(&id);}
        // Process ownership is independent of the database. Never hold State
        // while consulting a live effect owner.
        if let (Some(id), Some(native)) = (process_session, self.native.get()) {
            value["processes"] = native.host.processes(&id);
        }
        if bootstrap {
            if let Some(native) = self.native.get() {
                value["providers"] = native.provider.public_snapshot()?;
                value["capabilities"] = native.capabilities.snapshot().map_err(ApiError::from)?;
                value["nativeHost"]["networkDiagnostics"] = json!(native.network.diagnostics());
            }
        }
        Ok(Reply::Json(value))
    }
    fn execute_voice(&self, operation: Operation, cancel: crate::network::RequestCancellation) -> crate::BackendFuture<'_> {
        Box::pin(async move {
            let native = self.native.get().ok_or_else(|| ApiError::unavailable("This effect requires --dev-native --agent"))?;
            let settings = { let mut state = self.lock()?; require(!state.closed && !state.closing, 503, "Service closing")?; state.settings()? };
            let value = match operation {
                Operation::VoiceEdit { body } => native.voice.edit(&settings, &body, cancel).await?,
                Operation::VoiceTranscribe { audio } => native.voice.transcribe(&settings, audio, cancel).await?,
                _ => return Err(ApiError::bad_request("Invalid voice operation")),
            };
            Ok(Reply::Json(value))
        })
    }
    fn execute_semantic(&self,operation:Operation,cancel:crate::network::RequestCancellation)->crate::BackendFuture<'_>{
        Box::pin(async move {
            let native=self.native.get().ok_or_else(||ApiError::unavailable("This effect requires --dev-native --agent"))?;
            {let state=self.lock()?;require(!state.closed&&!state.closing,503,"Service closing")?;}
            let (body,index)=match operation {Operation::SemanticIndex{body}=>(body,true),Operation::SemanticSearch{body}=>(body,false),_=>return Err(ApiError::bad_request("Invalid semantic operation"))};
            let access=crate::semantic::Access{allow_external:body["consent"]==true,..Default::default()};
            let work=async {
                if index {native.semantic.index(access,&cancel).await}
                else {native.semantic.search(&body["query"],crate::semantic::SearchOptions{access,..Default::default()},&cancel).await}
            };
            let value=match tokio::time::timeout(std::time::Duration::from_secs(if index{90}else{30}),work).await {
                Ok(result)=>result.map_err(ApiError::from)?,
                Err(_)=>{cancel.cancel();return Err(ApiError::new(504,"Semantic request timed out"));}
            };
            Ok(Reply::Json(value))
        })
    }
    fn subscribe(&self, request: EventRequest) -> Result<EventSubscription, ApiError> {
        let mut s = self.lock()?;
        require(!s.closed && !s.closing, 503, "Service closing")?;
        let events = s
            .call("event.replay", json!({"since":request.since}))?
            .as_array()
            .cloned()
            .unwrap_or_default();
        let gap = events
            .first()
            .and_then(|e| e["seq"].as_u64())
            .is_some_and(|n| n > request.since.saturating_add(1));
        let initial = if request.reconnect || gap {
            let mut snapshot = s.snapshot()?;
            if let Some(native) = self.native.get() {
                // Runtime-only decoration must not reenter State. Keep this
                // guard through sequence capture and subscriber registration.
                native.provider.decorate_snapshot(&mut snapshot["providers"]);
                native.capabilities.decorate_snapshot(&mut snapshot["capabilities"]);
                snapshot["setup"] = native.setup.snapshot_from(s.setup_stored()?)?;
            }
            vec![ServiceEvent {
                seq: s.call("event.seq", json!({}))?.as_u64(),
                event_type: "snapshot".into(),
                data: snapshot,
                at: None,
            }]
        } else {
            events
                .into_iter()
                .map(|e| ServiceEvent {
                    seq: e["seq"].as_u64(),
                    event_type: e["type"].as_str().unwrap_or("").into(),
                    data: e["data"].clone(),
                    at: e["at"].as_str().map(str::to_owned),
                })
                .collect()
        };
        let (tx, receiver) = mpsc::channel(64);
        s.next_subscriber += 1;
        let id = s.next_subscriber;
        s.subscribers.insert(id, tx);
        Ok(EventSubscription {
            id,
            initial,
            receiver,
        })
    }
    fn unsubscribe(&self, id: u64) {
        if let Ok(mut s) = self.state.lock() {
            s.subscribers.remove(&id);
        }
    }
    fn stop(&self) -> Result<(), ApiError> {
        self.cancel_probes()?;
        if let Some(native) = self.native.get() {
            let _speech_drain = native.speech.stop_barrier(false)?;
            let _voice_drain = native.voice.stop_barrier(false)?;
            native.media.stop_all()?;
            // Tray Stop matches the compatibility sidecar: only currently
            // active non-main runs stop. Resident conversation, idle workers
            // and completed transcripts keep their state. Their individual
            // run scopes cancel provider calls; a global cancellation here
            // would also interrupt the resident main inference.
            let sessions = self.lock()?.list("session")?;
            for session in sessions {
                if session["kind"] == "main" {
                    continue;
                }
                let id = session["id"].as_str().unwrap_or("");
                if native.agent.state(id)?["runtime"]["active"] == true {
                    native.agent.request(crate::agent::AgentRequest::Stop {
                        id: id.into(),
                        reason: "stopped from the tray".into(),
                        rearm_main: false,
                    })?;
                }
            }
        }
        Ok(())
    }
    fn begin_shutdown(&self) -> Result<(), ApiError> {
        self.lock()?.closing = true;
        self.cancel_probes()?;
        if let Some(native) = self.native.get() {
            let _speech_drain = native.speech.stop_barrier(true)?;
            let _voice_drain = native.voice.stop_barrier(true)?;
            native.media.begin_close()?;
            native.semantic.close();
            native.setup.begin_close();
            native.catalog.close();
            native.agent.begin_close();
            native.provider.close();
            native.capabilities.close();
        }
        Ok(())
    }
    fn shutdown(&self) -> Result<(), ApiError> {
        self.begin_shutdown()?;
        if let Some(native) = self.native.get() {
            native.runtime.block_on(native.media.drain());
            native.runtime.block_on(native.semantic.close_and_drain());
            native.runtime.block_on(native.setup.close());
            native.agent.begin_close().wait()?;
        }
        // Drain admitted photo file/metadata operations before releasing SQLite.
        let _assets = self.avatar_asset_changes.lock().map_err(error)?;
        let _photos = self.photo_changes.lock().map_err(error)?;
        self.lock()?.close()
    }
    fn probe_cancellation(&self) -> crate::network::RequestCancellation {
        match self.probe_cancel.lock() {
            Ok(token) => token.clone(),
            Err(_) => {
                let token = crate::network::RequestCancellation::new();
                token.cancel();
                token
            }
        }
    }
    fn execute_probe(
        &self,
        id: String,
        cancel: crate::network::RequestCancellation,
    ) -> Result<Reply, ApiError> {
        self.run_probe(&id, cancel).map(Reply::Json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::{Admitted, ByteStream, NetworkFuture, NetworkRequest, RequestCancellation, Resolver, Transport, TransportResponse};
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct SnapshotTransport(AtomicUsize);
    impl Resolver for SnapshotTransport {
        fn lookup<'a>(&'a self, _: &'a str) -> NetworkFuture<'a, Vec<String>> {
            Box::pin(async { panic!("snapshot fixture must not resolve DNS") })
        }
    }
    impl Transport for SnapshotTransport {
        fn request<'a>(&'a self, _: Admitted, _: NetworkRequest, cancel: RequestCancellation) -> NetworkFuture<'a, TransportResponse> {
            Box::pin(async move {
                if self.0.fetch_add(1, Ordering::SeqCst) > 0 {
                    return Err(cancel.cancelled().await);
                }
                let body: ByteStream = Box::pin(futures_util::stream::iter(vec![Ok(bytes::Bytes::from_static(br#"{"choices":[{"message":{"content":"snapshot fixture"},"finish_reason":"stop"}]}"#))]));
                let mut headers = hyper::HeaderMap::new();
                headers.insert("content-type", hyper::header::HeaderValue::from_static("application/json"));
                Ok(TransportResponse {status:200,headers,body:Some(body)})
            })
        }
    }
    fn snapshot_workspace() -> (Arc<Workspace>, tokio::runtime::Runtime, Arc<SnapshotTransport>, PathBuf) {
        let dir = env::temp_dir().join(format!("tepora-native-snapshot-{}", Uuid::new_v4()));
        let workspace = Arc::new(Workspace::open(&dir).unwrap());
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let transport = Arc::new(SnapshotTransport::default());
        let network = crate::network::NativeNetwork::with_components(crate::network::NetworkPolicy::default(),transport.clone(),transport.clone());
        let provider = crate::provider::ProviderRuntime::with_options(Arc::new(workspace.access()),network.clone(),false,Arc::new(||0));
        let capabilities = crate::capabilities::Capabilities::new(Arc::new(workspace.access()),network.clone());
        let host = Arc::new(crate::agent::host::NativeAgentHost::new(workspace.access(),provider.clone(),network.clone()).unwrap());
        let agent = crate::agent::AgentCoordinator::start(host.clone(),runtime.handle().clone()).unwrap();
        let setup=crate::setup::SetupManager::new(workspace.access().setup_state(agent.clone()),network.clone(),runtime.handle().clone()).unwrap();
        let catalog=crate::model_catalog::ModelCatalog::new(Arc::new(workspace.access()),network.clone());
        let semantic=Arc::new(crate::semantic::SemanticMemory::new(Arc::new(workspace.access()),capabilities.clone()));
        let media=media_jobs::MediaJobs::new(workspace.access(),capabilities.clone(),network.clone(),runtime.handle().clone()).unwrap();
        assert!(workspace.native.set(NativeResources {voice:voice_operations::VoiceOperations::new(provider.clone(),network.clone()),speech:speech_stream::SpeechStream::new(network.clone(),runtime.handle().clone()),media,host,capabilities,semantic,setup,catalog,agent:agent.clone(),provider,network,runtime:runtime.handle().clone()}).is_ok());
        workspace.lock().unwrap().native_agent = true;
        agent.request(crate::agent::AgentRequest::Initialize).unwrap();
        (workspace,runtime,transport,dir)
    }
    #[test]
    fn reconnect_and_retention_gap_snapshots_keep_live_provider_health_limits_and_queue() {
        let (workspace, runtime, transport, dir) = snapshot_workspace();
        let provider = workspace.native.get().unwrap().provider.clone();
        provider.save(&json!({"profiles":[{"id":"fixture","protocol":"chat-completions","baseUrl":"http://127.0.0.1:12345/v1","model":"fixture","domain":"device","maxParallel":1}],"routes":{"main":{"primary":"fixture"}}}),0).unwrap();
        let request = crate::provider::InvokeRequest {chain:provider.chain("main").unwrap(),messages:vec![json!({"role":"user","content":"fixture"})],options:json!({})};
        runtime.block_on(provider.invoke(request.clone(),&RequestCancellation::new(),Arc::new(|_|{}))).unwrap();
        let cancel = RequestCancellation::new();
        let mut tasks = vec![];
        for _ in 0..2 {
            let p = provider.clone();let r = request.clone();let c = cancel.clone();
            tasks.push(runtime.spawn(async move {p.invoke(r,&c,Arc::new(|_|{})).await}));
        }
        runtime.block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                loop {
                    let snapshot=provider.public_snapshot().unwrap();
                    if transport.0.load(Ordering::SeqCst)==2 && snapshot["resources"][0]["queued"]==1 {break;}
                    tokio::task::yield_now().await;
                }
            }).await.unwrap();
        });
        let expected = provider.public_snapshot().unwrap();
        assert_eq!(expected["profiles"][0]["health"]["failures"],0);
        assert!(expected["profiles"][0]["limits"]["context"].as_u64().unwrap()>0);
        assert_eq!(expected["resources"][0]["active"],1);
        assert_eq!(expected["resources"][0]["queued"],1);
        for reconnect in [true,false] {
            if !reconnect {
                let mut state=workspace.lock().unwrap();
                for _ in 0..3 {state.call("event.append",json!({"type":"fixture","data":{},"at":now()})).unwrap();}
                state.call("exec",json!({"sql":"DELETE FROM events WHERE seq < (SELECT MAX(seq) FROM events)"})).unwrap();
            }
            let mut subscription=workspace.subscribe(EventRequest {since:0,reconnect}).unwrap();
            assert_eq!(subscription.initial.len(),1);
            let snapshot=&subscription.initial[0];
            assert_eq!(snapshot.event_type,"snapshot");
            assert_eq!(snapshot.data["providers"],expected);
            let seq=snapshot.seq.unwrap();
            workspace.execute(Operation::MemoryCreate {body:json!({"content":"after snapshot"})}).unwrap();
            let next=subscription.receiver.blocking_recv().unwrap();
            assert_eq!(next.event_type,"memory.updated");
            assert!(next.seq.unwrap()>seq);
            workspace.unsubscribe(subscription.id);
        }
        cancel.cancel();
        runtime.block_on(async {for task in tasks {assert!(task.await.unwrap().unwrap_err().cancelled);}});
        workspace.shutdown().unwrap();
        drop(provider);drop(workspace);drop(runtime);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn decorated_reconnect_snapshot_and_live_registration_do_not_lose_or_duplicate_concurrent_events() {
        let (workspace,runtime,_,dir)=snapshot_workspace();
        for round in 0..8 {
            let barrier=Arc::new(std::sync::Barrier::new(2));
            let start=barrier.clone();let writer=workspace.clone();
            let task=std::thread::spawn(move || {
                start.wait();
                (0..16).map(|n| match writer.execute(Operation::MemoryCreate {body:json!({"content":format!("snapshot round {round} memory {n}")})}).unwrap() {
                    Reply::Json(value)=>value["id"].as_str().unwrap().to_owned(),
                    _=>panic!("memory create must return JSON"),
                }).collect::<std::collections::HashSet<_>>()
            });
            barrier.wait();
            let mut subscription=workspace.subscribe(EventRequest {since:0,reconnect:true}).unwrap();
            let expected=task.join().unwrap();
            let snapshot=&subscription.initial[0];let seq=snapshot.seq.unwrap();
            let mut seen:std::collections::HashSet<_>=snapshot.data["memories"].as_array().unwrap().iter().filter_map(|m|m["id"].as_str()).filter(|id|expected.contains(*id)).map(str::to_owned).collect();
            let mut last=seq;
            while let Ok(event)=subscription.receiver.try_recv() {
                assert!(event.seq.unwrap()>last);last=event.seq.unwrap();
                if event.event_type=="memory.updated" {
                    let id=event.data["id"].as_str().unwrap().to_owned();
                    if expected.contains(&id) {assert!(seen.insert(id),"event duplicated across snapshot/live boundary");}
                }
            }
            assert_eq!(seen,expected,"event lost across snapshot/live boundary");
            workspace.unsubscribe(subscription.id);
        }
        workspace.shutdown().unwrap();drop(workspace);drop(runtime);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn provider_registry_and_key_pruning_commit_as_one_state_batch() {
        let dir = env::temp_dir().join(format!("tepora-native-provider-atomic-{}", Uuid::new_v4()));
        let workspace = Workspace::open(&dir).unwrap();
        let access = workspace.access();
        crate::provider::ProviderState::set_values(
            &access,
            &[
                ("provider-keys".into(), json!({"fixture":"old-test-key"})),
                ("provider-registry".into(), json!({"revision":1})),
            ],
        )
        .unwrap();
        workspace.lock().unwrap().call("exec",json!({"sql":"CREATE TRIGGER reject_registry BEFORE INSERT ON kv WHEN NEW.key='provider-registry' BEGIN SELECT RAISE(ABORT,'fixture rejected registry'); END"})).unwrap();
        assert!(crate::provider::ProviderState::set_values(
            &access,
            &[
                ("provider-keys".into(), json!({})),
                ("provider-registry".into(), json!({"revision":2}))
            ]
        )
        .is_err());
        assert_eq!(
            crate::provider::ProviderState::value(&access, "provider-keys").unwrap(),
            Some(json!({"fixture":"old-test-key"}))
        );
        assert_eq!(
            crate::provider::ProviderState::value(&access, "provider-registry").unwrap(),
            Some(json!({"revision":1}))
        );
        workspace.shutdown().unwrap();
        drop(workspace);
        drop(access);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn malformed_saved_configuration_returns_errors_without_poisoning_state() {
        for key in ["provider-registry", "capabilities", "dialogue-personas"] {
            let dir = env::temp_dir().join(format!("tepora-native-invalid-{}", Uuid::new_v4()));
            let workspace = Workspace::open(&dir).unwrap();
            workspace
                .lock()
                .unwrap()
                .set_value(key, json!("invalid legacy value"))
                .unwrap();
            assert!(workspace.execute(Operation::Bootstrap).is_err());
            assert!(workspace.execute(Operation::Artifacts).is_ok());
            workspace.shutdown().unwrap();
            drop(workspace);
            fs::remove_dir_all(dir).unwrap();
        }
    }
}
