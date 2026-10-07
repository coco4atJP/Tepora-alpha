//! Native registry and streaming protocol host. Workspace is the only durable
//! state owner; all state access is synchronous, owned, and ends before awaits.
mod gate;
#[cfg(test)]
mod tests;
mod validation;
mod wire;
pub use gate::{ResourceGate, SlotPool};
pub use validation::{role_chain, validate_profile, validate_registry, PROTOCOLS, ROLES, SERVERS};
pub use wire::{
    classify_response, overflow_limit, protocol_chat, request_headers, request_path, retry_after,
    USER_AGENT,
};

use crate::{
    network::{
        Domain, NativeNetwork, NetworkError, NetworkProfile, NetworkRequest, NetworkScope, Purpose,
        RequestCancellation,
    },
    ApiError,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fmt,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tepora_core::json_codec;

/// Implement on a facade holding the existing Workspace state mutex. Never
/// open a second connection. Mutation methods publish only committed values.
pub trait ProviderState: Send + Sync {
    fn value(&self, key: &str) -> Result<Option<Value>, ApiError>;
    fn set_value(&self, key: &str, value: Value) -> Result<(), ApiError>;
    /// Workspace overrides this with one state lock/transaction. The default
    /// supports small in-memory fixtures that have no concurrent observers.
    fn set_values(&self, values: &[(String, Value)]) -> Result<(), ApiError> {
        for (key, value) in values {
            self.set_value(key, value.clone())?;
        }
        Ok(())
    }
    fn get(&self, collection: &str, id: &str) -> Result<Option<Value>, ApiError>;
    fn put(&self, collection: &str, value: Value) -> Result<(), ApiError>;
    fn emit(&self, event: &str, data: Value) -> Result<(), ApiError>;
}
#[derive(Clone)]
pub struct ProviderFailure {
    pub kind: String,
    pub message: String,
    pub status: u16,
    pub upstream_status: Option<u16>,
    pub retry_after_ms: Option<u64>,
    pub limit: Option<u64>,
    pub param: Option<String>,
    pub body: String,
    pub blocked: bool,
    pub idle: bool,
    pub cancelled: bool,
}
impl ProviderFailure {
    pub fn new(kind: impl Into<String>, message: impl Into<String>) -> Self {
        let kind = kind.into();
        Self {
            status: if kind == "auth" { 401 } else { 502 },
            kind,
            message: message.into(),
            upstream_status: None,
            retry_after_ms: None,
            limit: None,
            param: None,
            body: String::new(),
            blocked: false,
            idle: false,
            cancelled: false,
        }
    }
    pub fn unavailable(message: impl Into<String>, wait: u64) -> Self {
        let mut e = Self::new("unavailable", message);
        e.status = 409;
        e.retry_after_ms = Some(wait);
        e
    }
    fn with_status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }
    pub fn retryable(&self) -> bool {
        ["transient", "rate", "unavailable"].contains(&self.kind.as_str())
    }
    /// No private upstream body or credential is included in actor/UI errors.
    pub fn value(&self) -> Value {
        json!({"kind":self.kind,"message":safe_error(&self.message),"status":self.status,"upstreamStatus":self.upstream_status,"retryAfterMs":self.retry_after_ms,"limit":self.limit,"param":self.param,"blocked":self.blocked,"idle":self.idle,"cancelled":self.cancelled,"retryable":self.retryable()})
    }
    fn from_core(error: tepora_core::CoreError) -> Self {
        let message = error.to_string();
        if let Some(value) = message
            .strip_prefix("[provider]")
            .and_then(|s| json_codec::parse(s).ok())
        {
            return Self::new(s(&value, "kind"), s(&value, "message"));
        }
        Self::new("transient", message)
    }
}
impl fmt::Debug for ProviderFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProviderFailure")
            .field("kind", &self.kind)
            .field("message", &safe_error(&self.message))
            .field("status", &self.status)
            .field("blocked", &self.blocked)
            .field("cancelled", &self.cancelled)
            .finish()
    }
}
impl fmt::Display for ProviderFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&safe_error(&self.message))
    }
}
impl std::error::Error for ProviderFailure {}
impl From<ApiError> for ProviderFailure {
    fn from(e: ApiError) -> Self {
        let mut v = Self::new("bad-request", e.message);
        v.status = e.status;
        v.blocked = e.blocked;
        v
    }
}
impl From<NetworkError> for ProviderFailure {
    fn from(e: NetworkError) -> Self {
        let mut v = Self::new(
            if e.cancelled {
                "cancelled"
            } else if e.blocked {
                "blocked"
            } else {
                "transient"
            },
            if e.blocked || e.cancelled {
                e.message
            } else {
                format!("Model connection failed: {}", truncate(&e.message, 200))
            },
        );
        v.status = e.status;
        v.blocked = e.blocked;
        v.idle = e.idle;
        v.cancelled = e.cancelled;
        v
    }
}
impl From<ProviderFailure> for ApiError {
    fn from(e: ProviderFailure) -> Self {
        Self {
            status: e.status,
            message: safe_error(&e.message),
            blocked: e.blocked,
        }
    }
}
pub fn safe_error(message: &str) -> String {
    let bearer = regex::Regex::new(r"(?i)Bearer\s+\S+")
        .unwrap()
        .replace_all(message, "Bearer [redacted]");
    let key = regex::Regex::new(r"sk-[\w-]+").unwrap();
    truncate(&key.replace_all(&bearer, "[redacted]"), 600)
}

#[derive(Clone, Debug)]
pub struct ProviderEvent {
    pub kind: String,
    pub value: Value,
}
pub type EventSink = Arc<dyn Fn(ProviderEvent) + Send + Sync>;
#[derive(Clone, Debug)]
pub struct InvokeRequest {
    pub chain: Vec<Value>,
    pub messages: Vec<Value>,
    pub options: Value,
}
impl InvokeRequest {
    pub fn new(chain: Vec<Value>, messages: Vec<Value>) -> Self {
        Self {
            chain,
            messages,
            options: json!({}),
        }
    }
}
#[derive(Default)]
struct ActiveState {
    next: u64,
    requests: HashMap<u64, (String, RequestCancellation)>,
    closed: bool,
}
struct Inner {
    state: Arc<dyn ProviderState>,
    network: NativeNetwork,
    config: Mutex<()>,
    // Leaf locks: never call ProviderState or acquire config while holding
    // health/limits/gate. Workspace may read these while its State is locked.
    health: Mutex<HashMap<String, Value>>,
    limits: Mutex<HashMap<String, Value>>,
    gate: ResourceGate,
    slots: SlotPool,
    active: Mutex<ActiveState>,
    detect_limits: bool,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}
#[derive(Clone)]
pub struct ProviderRuntime {
    inner: Arc<Inner>,
}
struct OperationLease {
    inner: Arc<Inner>,
    id: u64,
    watcher: tokio::task::AbortHandle,
    pub cancel: RequestCancellation,
}
impl Drop for OperationLease {
    fn drop(&mut self) {
        self.watcher.abort();
        lock(&self.inner.active).requests.remove(&self.id);
    }
}
impl ProviderRuntime {
    pub fn new(state: Arc<dyn ProviderState>, network: NativeNetwork) -> Self {
        Self::with_options(state, network, true, Arc::new(now_ms))
    }
    pub fn with_options(
        state: Arc<dyn ProviderState>,
        network: NativeNetwork,
        detect_limits: bool,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                state,
                network,
                config: Mutex::new(()),
                health: Mutex::new(HashMap::new()),
                limits: Mutex::new(HashMap::new()),
                gate: ResourceGate::default(),
                slots: SlotPool::default(),
                active: Mutex::new(ActiveState::default()),
                detect_limits,
                clock,
            }),
        }
    }
    pub fn get(&self) -> Result<Value, ApiError> {
        Ok(self
            .inner
            .state
            .value("provider-registry")?
            .unwrap_or_else(|| json!({"schema":2,"revision":0,"profiles":[],"routes":{}})))
    }
    pub fn configured(&self) -> Result<bool, ApiError> {
        Ok(!array(&self.get()?["profiles"]).is_empty())
    }
    pub fn chain(&self, role: &str) -> Result<Vec<Value>, ApiError> {
        Ok(role_chain(role, &self.get()?))
    }
    pub fn has_route(&self, role: &str) -> Result<bool, ApiError> {
        let c = self.get()?;
        let names: Vec<_> = match role {
            "chat" => vec!["chat", "main"],
            "work" => vec!["work", "main"],
            "compaction" => vec!["compaction", "work", "main"],
            "grounding" => vec!["grounding", "work", "main"],
            _ => vec![role],
        };
        Ok(names.iter().any(|r| c["routes"].get(*r).is_some()))
    }
    fn current(&self, p: &Value) -> Result<bool, ApiError> {
        Ok(array(&self.get()?["profiles"])
            .iter()
            .any(|x| x["enabled"] == true && x["identity"] == p["identity"] && x["id"] == p["id"]))
    }
    pub fn permitted(&self, p: &Value, purpose: Purpose) -> Result<bool, ApiError> {
        Ok(self.current(p)?
            && Domain::parse(s(p, "domain"))
                .is_some_and(|d| self.inner.network.policy().permitted(d, purpose)))
    }
    fn assert_current(&self, p: &Value, purpose: Purpose) -> Result<(), ProviderFailure> {
        if self.permitted(p, purpose)? {
            Ok(())
        } else {
            Err(NetworkError::blocked(
                "Provider profile was disabled, replaced, or blocked by the current network policy",
            )
            .into())
        }
    }
    /// Reject stale identities before reading a same-ID profile's replacement key.
    fn key_for(&self, p: &Value) -> Result<String, ApiError> {
        // Disabled profiles still show whether a saved key exists. Exact identity
        // is mandatory so a stale endpoint can never read its replacement key.
        if !array(&self.get()?["profiles"])
            .iter()
            .any(|current| current["id"] == p["id"] && current["identity"] == p["identity"])
        {
            return Ok(String::new());
        }
        let keys = self
            .inner
            .state
            .value("provider-keys")?
            .unwrap_or_else(|| json!({}));
        if let Some(key) = keys[s(p, "id")].as_str().filter(|k| !k.is_empty()) {
            return Ok(json_codec::sql_text(key));
        }
        Ok(if s(p, "apiKeyEnv").is_empty() {
            String::new()
        } else {
            std::env::var(s(p, "apiKeyEnv")).unwrap_or_default()
        })
    }
    pub fn public_snapshot(&self) -> Result<Value, ApiError> {
        let mut c = self.get()?;
        let mut profiles = vec![];
        for mut p in array(&c["profiles"]).to_vec() {
            p["keyPresent"] = json!(!self.key_for(&p)?.is_empty());
            p["limits"] = self.known_limits(&p)?.unwrap_or(Value::Null);
            p["probe"] = self
                .inner
                .state
                .get("provider-probe", s(&p, "identity"))?
                .unwrap_or(Value::Null);
            profiles.push(p);
        }
        c["profiles"] = json!(profiles);
        self.decorate_snapshot(&mut c);
        Ok(c)
    }
    /// Add live runtime information to an already captured public registry.
    /// Safe under Workspace's State lock: this never calls ProviderState,
    /// acquires config, invokes callbacks, or retains a lock between fields.
    /// Persisted key/probe/limit fields keep the caller's atomic state snapshot.
    pub fn decorate_snapshot(&self, registry: &mut Value) {
        let health = lock(&self.inner.health).clone();
        let limits = lock(&self.inner.limits).clone();
        if let Some(profiles) = registry.get_mut("profiles").and_then(Value::as_array_mut) {
            for p in profiles {
                p["health"] = health
                    .get(s(p, "id"))
                    .filter(|h| !s(p, "identity").is_empty() && h["identity"] == p["identity"])
                    .cloned()
                    .unwrap_or(Value::Null);
                if let Some(value) = limits.get(s(p, "identity")) {
                    p["limits"] = value.clone();
                }
            }
        }
        registry["resources"] = self.inner.gate.snapshot();
    }
    pub fn save(&self, raw: &Value, expected_revision: u64) -> Result<Value, ApiError> {
        let _config = lock(&self.inner.config);
        let old = self.get()?;
        if old["revision"].as_u64() != Some(expected_revision) {
            return Err(ApiError::new(409, "接続設定が更新されています。"));
        }
        let validated = validate_registry(raw)?;
        let mut c = json!({"schema":2,"revision":expected_revision+1});
        c["profiles"] = validated["profiles"].clone();
        c["routes"] = validated["routes"].clone();
        let mut keys = self
            .inner
            .state
            .value("provider-keys")?
            .unwrap_or_else(|| json!({}));
        if let Some(keys) = keys.as_object_mut() {
            keys.retain(|id,_|{
            let a=array(&old["profiles"]).iter().find(|p|s(p,"id")==id);let b=array(&c["profiles"]).iter().find(|p|s(p,"id")==id);
            matches!((a,b),(Some(a),Some(b)) if a["baseUrl"]==b["baseUrl"]&&a["protocol"]==b["protocol"])
        });
        }
        self.inner.state.set_values(&[
            ("provider-keys".into(), keys),
            ("provider-registry".into(), c.clone()),
        ])?;
        lock(&self.inner.health)
            .retain(|id, _| array(&c["profiles"]).iter().any(|p| s(p, "id") == id));
        // Config-lock serializes mutation with register+dispatch snapshots. Revoke
        // affected operations before acknowledgement, including queued discovery.
        for (identity, cancel) in lock(&self.inner.active).requests.values() {
            if !array(&c["profiles"])
                .iter()
                .any(|p| p["enabled"] == true && s(p, "identity") == identity)
            {
                cancel.cancel();
            }
        }
        let snapshot = self.public_snapshot()?;
        self.inner
            .state
            .emit("providers.updated", snapshot.clone())?;
        Ok(snapshot)
    }
    pub fn set_key(&self, id: &str, key: &str) -> Result<Value, ApiError> {
        let _config = lock(&self.inner.config);
        let registry = self.get()?;
        let p = array(&registry["profiles"])
            .iter()
            .find(|p| s(p, "id") == id)
            .ok_or_else(|| ApiError::new(404, "接続先が見つかりません。"))?;
        if key.encode_utf16().count() > 8000 {
            return Err(ApiError::bad_request("Invalid key"));
        }
        let mut keys = self
            .inner
            .state
            .value("provider-keys")?
            .unwrap_or_else(|| json!({}));
        if key.is_empty() {
            if let Some(keys) = keys.as_object_mut() {
                keys.shift_remove(id);
            }
        } else {
            keys[id] = json!(json_codec::encode_text(key));
        }
        self.inner.state.set_value("provider-keys", keys)?;
        lock(&self.inner.health).remove(id);
        for (identity, cancel) in lock(&self.inner.active).requests.values() {
            if identity == s(p, "identity") {
                cancel.cancel();
            }
        }
        Ok(json!({"id":id,"keyPresent":!self.key_for(p)?.is_empty()}))
    }
    fn operation(
        &self,
        p: &Value,
        purpose: Purpose,
        parent: &RequestCancellation,
    ) -> Result<OperationLease, ProviderFailure> {
        let _config = lock(&self.inner.config);
        check(parent)?;
        self.assert_current(p, purpose)?;
        let cancel = RequestCancellation::new();
        let id = {
            let mut state = lock(&self.inner.active);
            if state.closed {
                return Err(ProviderFailure::unavailable("Service closed", 30000));
            }
            let id = state.next;
            state.next = state.next.wrapping_add(1);
            state
                .requests
                .insert(id, (s(p, "identity").into(), cancel.clone()));
            id
        };
        let child = cancel.clone();
        let parent = parent.clone();
        let watcher = tokio::spawn(async move {
            parent.cancelled().await;
            child.cancel();
        })
        .abort_handle();
        Ok(OperationLease {
            inner: self.inner.clone(),
            id,
            watcher,
            cancel,
        })
    }
    pub fn known_limits(&self, p: &Value) -> Result<Option<Value>, ApiError> {
        let cached = lock(&self.inner.limits).get(s(p, "identity")).cloned();
        if let Some(value) = cached {
            return Ok(Some(value));
        }
        self.inner
            .state
            .value(&format!("provider-limits:{}", s(p, "identity")))
    }
    /// Discoveries intentionally are not shared. Cancelling one caller cannot
    /// poison another caller's result or persist guessed limits after abort.
    pub async fn limits(
        &self,
        p: &Value,
        cancel: &RequestCancellation,
    ) -> Result<Value, ProviderFailure> {
        let parent_cancel = cancel;
        let operation = self.operation(p, Purpose::Model, cancel)?;
        let cancel = &operation.cancel;
        check(cancel)?;
        let known = self.known_limits(p)?;
        if let Some(value) = known.as_ref().filter(|v| {
            s(v, "source") != "guess" || (self.inner.clock)() - parse_date(s(v, "at")) < 120000
        }) {
            check(cancel)?;
            return Ok(value.clone());
        }
        let found = self.detect(p, cancel).await?;
        let context = integer(&p["contextTokens"])
            .or_else(|| integer(&found["context"]))
            .unwrap_or_else(|| default_context(p));
        let server = if s(p, "server") == "auto" {
            found["server"].as_str().unwrap_or("other")
        } else {
            s(p, "server")
        };
        let mut value = json!({"context":context,"server":server,"slots":found.get("slots").filter(|v|!v.is_null()&&**v!=0).cloned().unwrap_or(Value::Null),"source":if p["contextTokens"].is_number(){"configured"}else{found["source"].as_str().unwrap_or("default")},"at":timestamp()});
        if let Some(max) = found.get("modelMax") {
            value["modelMax"] = max.clone();
        }
        if let Some(old) =
            known.filter(|v| v["learned"] == true && n(v, "context", context) < context)
        {
            value["context"] = old["context"].clone();
            value["learned"] = json!(true);
        }
        let _config = lock(&self.inner.config);
        check(parent_cancel)?;
        check(cancel)?;
        self.assert_current(p, Purpose::Model)?;
        // Overflow learned by a concurrent request also survives this discovery.
        if let Some(old) = self
            .known_limits(p)?
            .filter(|v| v["learned"] == true && n(v, "context", u64::MAX) < n(&value, "context", 0))
        {
            value["context"] = old["context"].clone();
            value["learned"] = json!(true);
        }
        self.inner.state.set_value(
            &format!("provider-limits:{}", s(p, "identity")),
            value.clone(),
        )?;
        lock(&self.inner.limits).insert(s(p, "identity").into(), value.clone());
        Ok(value)
    }
    pub fn learn_limit(&self, p: &Value, limit: u64) -> Result<Value, ApiError> {
        let _config = lock(&self.inner.config);
        let mut value = self
            .known_limits(p)?
            .unwrap_or_else(|| json!({"context":default_context(p),"server":p["server"]}));
        value["context"] = json!(limit.min(n(&value, "context", limit)).max(1024));
        value["learned"] = json!(true);
        value["source"] = json!("overflow");
        value["at"] = json!(timestamp());
        self.inner.state.set_value(
            &format!("provider-limits:{}", s(p, "identity")),
            value.clone(),
        )?;
        lock(&self.inner.limits).insert(s(p, "identity").into(), value.clone());
        Ok(value)
    }
    async fn discover_get(
        &self,
        p: &Value,
        url: &str,
        base: &str,
        body: Option<Value>,
        cancel: &RequestCancellation,
    ) -> Result<Option<Value>, ProviderFailure> {
        check(cancel)?;
        let mut profile = NetworkProfile::from_value(p)?;
        profile.base_url = base.into();
        let mut request = NetworkRequest {
            cancellation: Some(cancel.clone()),
            ..Default::default()
        };
        if let Some(body) = body {
            request.method = hyper::Method::POST;
            request.headers.insert(
                "content-type",
                hyper::header::HeaderValue::from_static("application/json"),
            );
            request.body = json_codec::stringify_js(&body)
                .map_err(ProviderFailure::from_core)?
                .into();
        }
        let scope = NetworkScope {
            profile: Some(profile),
            timeout: Duration::from_millis(4000),
            max_bytes: 2_000_000,
            ..Default::default()
        };
        let result = async {
            let response = self.inner.network.request(url, request, scope).await?;
            if !(200..300).contains(&response.status) {
                return Ok(None);
            }
            response.json(2_000_000).await.map(Some)
        }
        .await;
        check(cancel)?;
        match result {
            Ok(value) => Ok(value),
            Err(e) if e.cancelled || e.blocked => Err(e.into()),
            Err(_) => Ok(None),
        }
    }
    async fn detect(
        &self,
        p: &Value,
        cancel: &RequestCancellation,
    ) -> Result<Value, ProviderFailure> {
        if !self.inner.detect_limits {
            return Ok(json!({}));
        }
        if s(p, "protocol") == "chat-completions" && s(p, "domain") != "cloud" {
            let base = json_codec::sql_text(s(p, "baseUrl"));
            let origin = url::Url::parse(&base)
                .map_err(|_| ProviderFailure::new("bad-request", "Invalid provider URL"))?
                .origin()
                .ascii_serialization();
            if let Some(props) = self
                .discover_get(p, &format!("{origin}/props"), &origin, None, cancel)
                .await?
            {
                if let Some(context) = integer(&props["default_generation_settings"]["n_ctx"])
                    .or_else(|| integer(&props["n_ctx"]))
                    .filter(|v| *v > 0)
                {
                    return Ok(
                        json!({"context":context,"server":"llama.cpp","slots":props["total_slots"],"source":"llama.cpp /props"}),
                    );
                }
            }
            if self
                .discover_get(p, &format!("{origin}/api/version"), &origin, None, cancel)
                .await?
                .is_some_and(|v| !v["version"].is_null() && v["version"] != "")
            {
                let show = self
                    .discover_get(
                        p,
                        &format!("{origin}/api/show"),
                        &origin,
                        Some(json!({"model":p["model"]})),
                        cancel,
                    )
                    .await?
                    .unwrap_or(Value::Null);
                let max = show["model_info"]
                    .as_object()
                    .and_then(|o| o.iter().find(|(k, _)| k.ends_with(".context_length")))
                    .and_then(|(_, v)| integer(v));
                return Ok(
                    json!({"context":max.filter(|n|*n>=2048).unwrap_or(32768).min(32768),"server":"ollama","modelMax":max,"source":"ollama /api/show"}),
                );
            }
            let encoded = url::form_urlencoded::byte_serialize(
                json_codec::sql_text(s(p, "model")).as_bytes(),
            )
            .collect::<String>()
            .replace('+', "%20");
            if let Some(lm) = self
                .discover_get(
                    p,
                    &format!("{origin}/api/v0/models/{encoded}"),
                    &origin,
                    None,
                    cancel,
                )
                .await?
            {
                if let Some(context) = integer(&lm["loaded_context_length"])
                    .filter(|v| *v > 0)
                    .or_else(|| integer(&lm["max_context_length"]).filter(|v| *v > 0))
                {
                    return Ok(json!({"context":context,"server":"lmstudio","source":"lmstudio"}));
                }
            }
            if let Some(models) = self
                .discover_get(p, &format!("{base}/models"), &base, None, cancel)
                .await?
            {
                let data = array(&models["data"]);
                if let Some(entry) = data
                    .iter()
                    .find(|m| m["id"] == p["model"])
                    .or_else(|| data.first())
                {
                    if let Some(context) = integer(&entry["max_model_len"]) {
                        return Ok(
                            json!({"context":context,"server":"vllm","source":"vllm /models"}),
                        );
                    }
                }
            }
            return Ok(json!({}));
        }
        let catalog = self
            .inner
            .state
            .get("catalog", "models.dev")?
            .unwrap_or(Value::Null);
        let model = s(p, "model");
        let hit = array(&catalog["entries"])
            .iter()
            .find(|m| s(m, "modelId") == model || s(m, "modelId").ends_with(&format!("/{model}")));
        let server = if s(p, "domain") == "cloud" {
            "openai"
        } else {
            "other"
        };
        Ok(
            match hit.filter(|m| integer(&m["context"]).is_some_and(|v| v > 0)) {
                Some(m) => json!({"context":m["context"],"server":server,"source":"models.dev"}),
                None => json!({"server":server}),
            },
        )
    }
    pub fn timeouts(&self, p: &Value) -> Result<Value, ApiError> {
        let learned = self
            .inner
            .state
            .value(&format!("provider-timeouts:{}", s(p, "identity")))?
            .unwrap_or(Value::Null);
        Ok(
            json!({"firstByteTimeoutMs":n(p,"firstByteTimeoutMs",180000).max(n(&learned,"firstByteTimeoutMs",0)),"idleTimeoutMs":n(p,"idleTimeoutMs",120000).max(n(&learned,"idleTimeoutMs",0))}),
        )
    }
    pub fn learn_timeout(&self, p: &Value) -> Result<Value, ApiError> {
        let _config = lock(&self.inner.config);
        let t = self.timeouts(p)?;
        let next = json!({"firstByteTimeoutMs":n(&t,"firstByteTimeoutMs",0).max(n(&t,"idleTimeoutMs",0)*2).min(3600000),"idleTimeoutMs":(n(&t,"idleTimeoutMs",0)*2).min(1800000),"at":timestamp()});
        self.inner.state.set_value(
            &format!("provider-timeouts:{}", s(p, "identity")),
            next.clone(),
        )?;
        self.inner.state.emit(
            "route.timeout",
            json!({"profileId":p["id"],"idleTimeoutMs":next["idleTimeoutMs"]}),
        )?;
        Ok(next)
    }
    pub fn vision_allowed(&self, p: &Value) -> Result<bool, ApiError> {
        Ok(!p.is_null()
            && p["capabilities"]["vision"] != false
            && self
                .inner
                .state
                .value(&format!("provider-novision:{}", s(p, "identity")))?
                .is_none_or(|v| v.is_null() || v == false))
    }
    pub fn learn_no_vision(&self, p: &Value) -> Result<(), ApiError> {
        self.inner.state.set_value(
            &format!("provider-novision:{}", s(p, "identity")),
            json!({"at":timestamp()}),
        )
    }
    pub fn price(&self, route: &Value) -> Result<Option<Value>, ApiError> {
        if s(route, "domain") != "cloud" {
            return Ok(None);
        }
        let catalog = self
            .inner
            .state
            .get("catalog", "models.dev")?
            .unwrap_or(Value::Null);
        let entries = array(&catalog["entries"]);
        let model = s(route, "model");
        let hit = entries
            .iter()
            .find(|e| !e["cost"].is_null() && s(e, "modelId") == model)
            .or_else(|| {
                entries.iter().find(|e| {
                    !e["cost"].is_null()
                        && (s(e, "modelId").ends_with(&format!("/{model}"))
                            || model.ends_with(&format!("/{}", s(e, "modelId"))))
                })
            });
        Ok(hit
            .filter(|e| e["cost"]["input"].as_f64().is_some_and(f64::is_finite))
            .map(|e| e["cost"].clone()))
    }
    pub fn compat(&self, p: &Value) -> Result<Value, ApiError> {
        Ok(self
            .inner
            .state
            .value(&format!("provider-compat:{}", s(p, "identity")))?
            .unwrap_or_else(|| json!({"drop":[]})))
    }
    pub fn add_compat(&self, p: &Value, param: &str) -> Result<Value, ApiError> {
        let _config = lock(&self.inner.config);
        let mut c = self.compat(p)?;
        if !array(&c["drop"]).contains(&json!(param)) {
            if !c["drop"].is_array() {
                c["drop"] = json!([]);
            }
            c["drop"].as_array_mut().unwrap().push(json!(param));
            self.inner
                .state
                .set_value(&format!("provider-compat:{}", s(p, "identity")), c.clone())?;
        }
        Ok(c)
    }
    fn mark_down(
        &self,
        p: &Value,
        ms: u64,
        error: &ProviderFailure,
        failures: Option<u64>,
    ) -> Result<(), ApiError> {
        let until = (self.inner.clock)() + ms as i64;
        let mut health = lock(&self.inner.health);
        let failures =
            failures.unwrap_or_else(|| health.get(s(p, "id")).map_or(0, |v| n(v, "failures", 0)));
        health.insert(s(p,"id").into(),json!({"identity":p["identity"],"failures":failures,"until":until,"lastError":error.kind}));
        drop(health);
        self.inner.state.emit(
            "route.failed",
            json!({"profileId":p["id"],"kind":error.kind,"retryAfterMs":ms}),
        )
    }
    pub async fn invoke(
        &self,
        request: InvokeRequest,
        cancel: &RequestCancellation,
        sink: EventSink,
    ) -> Result<Value, ProviderFailure> {
        check(cancel)?;
        if request.chain.is_empty() {
            let mut e = ProviderFailure::unavailable(
                "会話・作業に使うモデルを「AIとの接続」で登録してください。",
                60000,
            );
            e.kind = "unconfigured".into();
            return Err(e);
        }
        let requirement = request.options["requirement"].as_str().unwrap_or(
            if array(&request.options["tools"]).is_empty() {
                "text"
            } else {
                "tools"
            },
        );
        let purpose = if requirement == "vision" {
            Purpose::Vision
        } else {
            Purpose::Model
        };
        let priority = request.options["priority"].as_f64().unwrap_or(0.);
        let mut last: Option<ProviderFailure> = None;
        let mut attempted = 0;
        let mut soonest: Option<u64> = None;
        for p in &request.chain {
            check(cancel)?;
            if !self.permitted(p, purpose)? {
                last.get_or_insert_with(|| {
                    ProviderFailure::unavailable(
                        "現在の通信モードでは使える接続先がありません。",
                        30000,
                    )
                });
                continue;
            }
            if requirement == "vision" && !self.vision_allowed(p)? {
                continue;
            }
            let health = lock(&self.inner.health)
                .get(s(p, "id"))
                .cloned()
                .unwrap_or(Value::Null);
            if health["identity"] == p["identity"]
                && health["until"]
                    .as_i64()
                    .is_some_and(|t| t > (self.inner.clock)())
            {
                let wait = (health["until"].as_i64().unwrap() - (self.inner.clock)()).max(0) as u64;
                soonest = Some(soonest.map_or(wait, |s| s.min(wait)));
                continue;
            }
            let operation = match self.operation(p, purpose, cancel) {
                Ok(op) => op,
                Err(e) if e.blocked => {
                    last = Some(e);
                    continue;
                }
                Err(e) => return Err(e),
            };
            let child = &operation.cancel;
            let mut learned = 0;
            let mut attempt = 0;
            while attempt < 3 {
                check(cancel)?;
                check(child)?;
                let mut admission = None;
                let mut slot = None;
                let result=async{
                    let limits=self.limits(p,child).await?;let compat=self.compat(p)?;check(child)?;
                    let slots=if s(&limits,"server")=="llama.cpp"{n(&limits,"slots",0) as usize}else{0};let slots=if slots>1{slots}else{0};let parallel=(n(p,"maxParallel",1) as usize).max(slots);
                    admission=Some(self.inner.gate.acquire(s(p,"resource"),parallel,priority,usize::from(parallel>1&&s(p,"domain")!="cloud"),child).await?);
                    if slots>0&&!s(&request.options,"slotKey").is_empty(){slot=self.inner.slots.acquire(s(p,"resource"),slots,s(&request.options,"slotKey"),priority>=10.);}
                    let requested_cap=n(&request.options,"maxTokens",n(p,"maxTokens",8192));
                    let requested_cap=if requested_cap==0 {n(p,"maxTokens",8192)} else {requested_cap};
                    let output_cap=requested_cap.min(n(p,"maxTokens",8192)).min(n(&limits,"context",default_context(p))/2).max(256);
                    let (key,timeouts)={let _config=lock(&self.inner.config);check(child)?;self.assert_current(p,purpose)?;(self.key_for(p)?,self.timeouts(p)?)};
                    attempted+=1;let event=json!({"profileId":p["id"],"model":p["model"],"domain":p["domain"],"protocol":p["protocol"],"identity":p["identity"],"attempt":attempted,"contextTokens":limits["context"],"server":limits["server"],"at":timestamp()});
                    sink(ProviderEvent{kind:"route".into(),value:event.clone()});check(child)?;self.assert_current(p,purpose)?;
                    let mut profile=p.clone();profile["server"]=limits["server"].clone();let mut options=request.options.clone();if !options.is_object(){options=json!({});}options["maxTokens"]=json!(output_cap);options["sampling"]=p["sampling"].clone();options["compat"]=compat;options["slot"]=slot.as_ref().map(|s|json!(s.slot)).unwrap_or(Value::Null);options["numCtx"]=if s(&limits,"server")=="ollama"{limits["context"].clone()}else{Value::Null};
                    let scope=NetworkScope{profile:Some(NetworkProfile::from_value(&profile)?),purpose,max_bytes:64_000_000,first_byte_timeout:Some(Duration::from_millis(n(&timeouts,"firstByteTimeoutMs",180000))),idle_timeout:Some(Duration::from_millis(n(&timeouts,"idleTimeoutMs",120000))),..Default::default()};
                    let mut answer=protocol_chat(&self.inner.network,&profile,&key,&request.messages,&options,scope,child,&sink).await?;check(child)?;check(cancel)?;self.assert_current(p,purpose)?;
                    lock(&self.inner.health).insert(s(p,"id").into(),json!({"identity":p["identity"],"failures":0,"until":0}));let mut route=event;route["maxTokens"]=json!(output_cap);answer["route"]=route;Ok::<_,ProviderFailure>(answer)
                }.await;
                let error = match result {
                    Ok(answer) => return Ok(answer),
                    Err(e) => e,
                };
                check(cancel)?;
                if child.is_cancelled() {
                    return Err(child.error().unwrap().into());
                }
                last = Some(error.clone());
                if error.idle && learned < 3 {
                    learned += 1;
                    self.learn_timeout(p)?;
                    continue;
                }
                if error.kind == "bad-request" {
                    if let Some(param) = &error.param {
                        if !array(&self.compat(p)?["drop"]).contains(&json!(param)) {
                            self.add_compat(p, param)?;
                            continue;
                        }
                    }
                }
                if error.kind == "overflow" {
                    if let Some(limit) = error.limit {
                        self.learn_limit(p, limit)?;
                    }
                    return Err(error);
                }
                if error.blocked {
                    break;
                }
                if error.kind == "rate" {
                    let wait = error.retry_after_ms.filter(|v| *v > 0).unwrap_or(15000);
                    self.mark_down(p, wait, &error, None)?;
                    soonest = Some(soonest.map_or(wait, |s| s.min(wait)));
                    break;
                }
                if ["auth", "bad-request", "invalid-output"].contains(&error.kind.as_str()) {
                    break;
                }
                if attempt < 2 {
                    sleep_cancelled(if attempt == 0 { 1000 } else { 3000 }, child).await?;
                } else {
                    let failures = n(&health, "failures", 0) + 1;
                    let wait = (5000 * (1u64 << failures.min(6))).min(300000);
                    self.mark_down(p, wait, &error, Some(failures))?;
                    soonest = Some(soonest.map_or(wait, |s| s.min(wait)));
                }
                // Like the existing host, retries hold the admitted resource and
                // llama.cpp slot through the sleep, then release before retry.
                drop(slot);
                drop(admission);
                attempt += 1;
            }
        }
        if let Some(error) = last
            .as_ref()
            .filter(|e| ["auth", "bad-request", "invalid-output"].contains(&e.kind.as_str()))
        {
            return Err(error.clone());
        }
        Err(ProviderFailure::unavailable(
            last.map(|e| {
                format!(
                    "接続先が応答しません（{}）。時間を置いて再試行します。",
                    truncate(&safe_error(&e.message), 160)
                )
            })
            .unwrap_or_else(|| "使える接続先がありません。".into()),
            soonest.map_or(30000, |s| s.max(1000)),
        ))
    }
    pub async fn probe(
        &self,
        id: &str,
        cancel: &RequestCancellation,
    ) -> Result<Value, ProviderFailure> {
        let registry = self.get()?;
        let profile = array(&registry["profiles"])
            .iter()
            .find(|p| s(p, "id") == id && p["enabled"] == true)
            .cloned()
            .ok_or_else(|| {
                ProviderFailure::new("bad-request", "Unknown enabled provider").with_status(404)
            })?;
        // Keep one cancellable lease over discovery and both roundtrip calls.
        // A service-wide Stop must not miss the gap between individual requests.
        let parent_cancel = cancel;
        let operation = self.operation(&profile, Purpose::Model, cancel)?;
        let cancel = &operation.cancel;
        let limits = self.limits(&profile, cancel).await?;
        let start = std::time::Instant::now();
        let nonce = uuid::Uuid::new_v4().to_string();
        let receipt = uuid::Uuid::new_v4().to_string();
        let tools = json!([{"type":"function","function":{"name":"tepora_probe","description":"Echo the exact challenge in a safe capability test.","parameters":{"type":"object","properties":{"challenge":{"type":"string"}},"required":["challenge"],"additionalProperties":false}}}]);
        let mut messages = vec![
            json!({"role":"system","content":"This is a safe tool protocol test. Call tepora_probe with the challenge. After the tool responds, reply with only the receipt string it returned."}),
            json!({"role":"user","content":format!("Challenge: {nonce}")}),
        ];
        let sink: EventSink = Arc::new(|_| {});
        let a = self
            .invoke(
                InvokeRequest {
                    chain: vec![profile.clone()],
                    messages: messages.clone(),
                    options: json!({"tools":tools,"maxTokens":200}),
                },
                cancel,
                sink.clone(),
            )
            .await?;
        let calls = array(&a["tool_calls"]);
        if calls.len() != 1 || s(&calls[0]["function"], "name") != "tepora_probe" {
            return Err(ProviderFailure::new(
                "invalid-output",
                "This model did not produce the required tool call",
            )
            .with_status(422));
        }
        let args =
            json_codec::parse_js_text(s(&calls[0]["function"], "arguments")).map_err(|_| {
                ProviderFailure::new("invalid-output", "Tool arguments are not valid JSON")
            })?;
        if args["challenge"] != nonce {
            return Err(
                ProviderFailure::new("invalid-output", "Model changed the tool challenge")
                    .with_status(422),
            );
        }
        let mut assistant = a.clone();
        assistant["role"] = json!("assistant");
        messages.push(assistant);
        messages.push(json!({"role":"tool","tool_call_id":calls[0]["id"],"content":json_codec::encode_text(&json_codec::stringify_js(&json!({"receipt":receipt})).map_err(ProviderFailure::from_core)?)}));
        let b = self
            .invoke(
                InvokeRequest {
                    chain: vec![profile.clone()],
                    messages,
                    options: json!({"tools":[],"maxTokens":200}),
                },
                cancel,
                sink,
            )
            .await?;
        if !s(&b, "content").contains(&receipt) || !array(&b["tool_calls"]).is_empty() {
            return Err(ProviderFailure::new(
                "invalid-output",
                "Model did not use the returned tool result",
            )
            .with_status(422));
        }
        let doc = json!({"passed":true,"destination":digest(&json!([profile["protocol"],profile["baseUrl"],profile["model"]]))?,"model":profile["model"],"checkedAt":timestamp(),"latencyMs":start.elapsed().as_millis() as u64,"evidence":["structured-tool-call","arguments-round-trip","tool-result-consumption"],"limitation":"This safe two-call probe does not certify task quality, vision, performance under load, or arbitrary tool support.","id":profile["identity"],"profileId":id,"ok":true,"limits":limits,"at":timestamp(),"scope":"safe tool roundtrip only, not quality or vision"});
        let _config = lock(&self.inner.config);
        check(parent_cancel)?;
        check(cancel)?;
        self.assert_current(&profile, Purpose::Model)?;
        self.inner.state.put("provider-probe", doc.clone())?;
        self.inner
            .state
            .emit("providers.updated", self.public_snapshot()?)?;
        Ok(doc)
    }
    /// Stop all current inference/discovery/probes while leaving the registry
    /// and admission gate usable for a later user turn.
    pub fn cancel_all(&self) {
        for (_, cancellation) in lock(&self.inner.active).requests.values() {
            cancellation.cancel();
        }
    }
    pub fn close(&self) {
        let mut state = lock(&self.inner.active);
        state.closed = true;
        for (_, cancel) in state.requests.values() {
            cancel.cancel();
        }
        drop(state);
        self.inner.gate.close();
    }
    pub fn active_count(&self) -> usize {
        lock(&self.inner.active).requests.len()
    }
}
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn integer(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| {
        v.as_f64()
            .filter(|n| n.is_finite() && *n >= 0. && n.fract() == 0.)
            .map(|n| n as u64)
    })
}
fn n(v: &Value, k: &str, default: u64) -> u64 {
    integer(&v[k]).unwrap_or(default)
}

fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn truncate(s: &str, max: usize) -> String {
    json_codec::from_utf16_units(
        &json_codec::utf16_units(s)
            .into_iter()
            .take(max)
            .collect::<Vec<_>>(),
    )
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
fn check(cancel: &RequestCancellation) -> Result<(), ProviderFailure> {
    cancel.error().map_or(Ok(()), |e| Err(e.into()))
}
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn parse_date(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value).map_or(i64::MIN / 2, |d| d.timestamp_millis())
}
fn default_context(p: &Value) -> u64 {
    match s(p, "protocol") {
        "anthropic" | "responses" => 200000,
        "gemini" => 1000000,
        _ => 128000,
    }
}
async fn sleep_cancelled(ms: u64, cancel: &RequestCancellation) -> Result<(), ProviderFailure> {
    check(cancel)?;
    tokio::select! {biased;error=cancel.cancelled()=>Err(error.into()),_=tokio::time::sleep(Duration::from_millis(ms))=>Ok(())}
}
