//! Native capability registry and modality transport. Explicit keys stay in
//! memory only. Workspace owns registry persistence/CAS/events; NativeNetwork
//! owns every destination.
use crate::{
    agent::decisions::{
        decision_payload, validate_answers, DecisionBackend, DecisionError, DecisionFuture,
    },
    network::{
        normal_url, Domain, EgressGuard, NativeNetwork, NetworkError, NetworkProfile,
        NetworkRequest, NetworkScope, Purpose, RequestCancellation,
    },
    provider::{validate_profile, ProviderFailure, ResourceGate},
    ApiError,
};
use bytes::Bytes;
use hyper::{header, HeaderMap, Method};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fmt,
    sync::{Arc, Mutex, MutexGuard, Weak},
    time::Duration,
};
use tepora_core::{
    js_value::{js_string, truthy},
    json_codec,
};

pub const PROTOCOL_ROLES: &[(&str, &str)] = &[
    ("system-one", "decision"),
    ("openai-embeddings", "embedding"),
    ("ollama-embed", "embedding"),
    ("openai-speech", "tts"),
    ("openai-images", "image"),
    ("openai-image-edit", "image_edit"),
    ("xai-video", "video"),
];
pub const ROLES: &[&str] = &[
    "decision",
    "embedding",
    "tts",
    "image",
    "image_edit",
    "video",
];
const FIELDS: &[&str] = &[
    "id",
    "name",
    "protocol",
    "baseUrl",
    "model",
    "domain",
    "pinnedAddress",
    "allowPlainHttp",
    "enabled",
    "apiKeyEnv",
    "timeoutMs",
    "maxParallel",
    "resource",
    "voice",
    "dimensions",
    "assetOrigins",
];
const BASE_FIELDS: &[&str] = &[
    "id",
    "name",
    "baseUrl",
    "model",
    "domain",
    "pinnedAddress",
    "allowPlainHttp",
    "enabled",
    "apiKeyEnv",
    "timeoutMs",
    "maxParallel",
    "resource",
];
const RESULT_FIELDS: &[&str] = &[
    "id",
    "name",
    "baseUrl",
    "model",
    "domain",
    "enabled",
    "pinnedAddress",
    "allowPlainHttp",
    "apiKeyEnv",
    "timeoutMs",
    "maxParallel",
    "resource",
];
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
fn require(ok: bool, status: u16, message: &str) -> Result<(), CapabilityError> {
    if ok {
        Ok(())
    } else {
        Err(CapabilityError::new(status, message))
    }
}
fn js_keys(v: &Value) -> Vec<String> {
    let mut keys: Vec<_> = v
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    keys.sort_by_key(|k| {
        let i = k
            .parse::<u32>()
            .ok()
            .filter(|i| *i < u32::MAX && i.to_string() == *k);
        (i.is_none(), i.unwrap_or(0))
    });
    keys
}

#[derive(Clone)]
pub struct CapabilityError {
    pub status: u16,
    pub upstream_status: Option<u16>,
    pub known_rejected: Option<bool>,
    pub blocked: bool,
    pub cancelled: bool,
    /// Trusted lifecycle invalidation, distinct from caller cancellation and
    /// provider failure. Decision circuit health must ignore these outcomes.
    pub invalidated: bool,
    pub message: String,
}
impl CapabilityError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            upstream_status: None,
            known_rejected: None,
            blocked: false,
            cancelled: false,
            invalidated: false,
            message: message.into(),
        }
    }
    fn changed() -> Self {
        let mut e = Self::new(403, "Capability endpoint changed");
        e.blocked = true;
        e.invalidated = true;
        e
    }
    fn closed() -> Self {
        let mut e = Self::new(403, "Service closed");
        e.blocked = true;
        e.invalidated = true;
        e
    }
    fn invalidated(status: u16, message: impl Into<String>) -> Self {
        let mut e = Self::new(status, message);
        e.invalidated = true;
        e
    }
    fn upstream(status: u16) -> Self {
        let mut e = Self::new(502, format!("能力接続 HTTP {status}"));
        e.upstream_status = Some(status);
        e.known_rejected = Some(status < 500);
        e
    }
    pub fn value(&self) -> Value {
        let mut value =
            json!({"message":crate::provider::safe_error(&self.message),"status":self.status});
        if let Some(status) = self.upstream_status {
            value["upstreamStatus"] = json!(status)
        }
        if let Some(known) = self.known_rejected {
            value["knownRejected"] = json!(known)
        }
        if self.blocked {
            value["blocked"] = json!(true)
        }
        if self.cancelled {
            value["cancelled"] = json!(true)
        }
        value
    }
}
impl fmt::Debug for CapabilityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CapabilityError")
            .field("status", &self.status)
            .field("upstream_status", &self.upstream_status)
            .field("message", &crate::provider::safe_error(&self.message))
            .finish()
    }
}
impl fmt::Display for CapabilityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&crate::provider::safe_error(&self.message))
    }
}
impl std::error::Error for CapabilityError {}
impl From<CapabilityError> for ApiError {
    fn from(error: CapabilityError) -> Self {
        Self {
            status: error.status,
            message: error.message,
            blocked: error.blocked,
        }
    }
}
impl From<ApiError> for CapabilityError {
    fn from(e: ApiError) -> Self {
        let mut x = Self::new(e.status, e.message);
        x.blocked = e.blocked;
        x
    }
}
impl From<NetworkError> for CapabilityError {
    fn from(e: NetworkError) -> Self {
        let mut x = Self::new(e.status, e.message);
        x.blocked = e.blocked;
        x.cancelled = e.cancelled;
        x
    }
}
impl From<ProviderFailure> for CapabilityError {
    fn from(e: ProviderFailure) -> Self {
        let mut x = Self::new(e.status, e.message);
        x.blocked = e.blocked;
        x.cancelled = e.cancelled;
        x.upstream_status = e.upstream_status;
        x
    }
}
impl From<DecisionError> for CapabilityError {
    fn from(e: DecisionError) -> Self {
        let mut x = Self::new(e.status, e.message);
        x.cancelled = e.cancelled;
        x.invalidated = e.invalidated;
        x.upstream_status = e.upstream_status;
        x
    }
}
impl From<tepora_core::CoreError> for CapabilityError {
    fn from(e: tepora_core::CoreError) -> Self {
        Self::new(400, e.to_string())
    }
}

/// One existing Workspace connection must implement this atomic boundary.
/// Keys are deliberately absent from this interface and every persisted value.
pub trait CapabilityState: Send + Sync {
    fn value(&self, key: &str) -> Result<Option<Value>, ApiError>;
    /// Atomically compare registry revision, persist KV `capabilities`, then
    /// publish `capabilities.updated` with this public snapshot after commit.
    /// On CAS or write failure, neither the registry nor its event may change.
    fn commit_registry(
        &self,
        expected_revision: u64,
        next: Value,
        public_snapshot: Value,
    ) -> Result<(), ApiError>;
}
pub type Environment = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Pure validator. Exact ordered capability identity is distinct from a chat
/// profile identity even though the underlying endpoint validators are shared.
pub fn validate_capability(raw: &Value) -> Result<Value, CapabilityError> {
    require(
        raw.is_object() && js_keys(raw).iter().all(|k| FIELDS.contains(&k.as_str())),
        400,
        "Unknown capability setting",
    )?;
    let role = PROTOCOL_ROLES
        .iter()
        .find(|(p, _)| raw["protocol"] == *p)
        .map(|(_, r)| *r)
        .ok_or_else(|| CapabilityError::new(400, "Choose a supported modality protocol"))?;
    let mut base = Map::new();
    for k in BASE_FIELDS {
        if let Some(v) = raw.get(*k) {
            base.insert((*k).into(), v.clone());
        }
    }
    base.insert("protocol".into(), json!("chat-completions"));
    let profile = validate_profile(&Value::Object(base))?;
    let empty = json!([]);
    let origins = raw
        .get("assetOrigins")
        .filter(|v| truthy(v))
        .unwrap_or(&empty);
    require(
        origins.as_array().is_some_and(|a| a.len() <= 8),
        400,
        "At most eight media download origins",
    )?;
    let mut normalized_origins = Vec::new();
    for value in arr(origins) {
        let u = normal_url(&json_codec::sql_text(&js_string(Some(value))), false)?;
        require(
            u.scheme() == "https" && u.path() == "/" && u.port().is_none(),
            400,
            "Media origins must be exact HTTPS origins",
        )?;
        normalized_origins.push(json_codec::encode_text(&u.origin().ascii_serialization()));
    }
    require(
        raw.get("voice").is_none_or(|v| {
            v.as_str()
                .is_some_and(|s| json_codec::utf16_units(s).len() <= 120)
        }),
        400,
        "Invalid voice",
    )?;
    require(
        raw.get("dimensions").is_none_or(|v| {
            v.as_f64()
                .is_some_and(|n| n.fract() == 0. && n > 0. && n <= 8192.)
        }),
        400,
        "Invalid embedding dimensions",
    )?;
    let mut out = Map::new();
    for k in RESULT_FIELDS {
        if let Some(v) = profile.get(*k) {
            out.insert((*k).into(), v.clone());
        }
    }
    out.insert("protocol".into(), raw["protocol"].clone());
    out.insert("role".into(), json!(role));
    out.insert(
        "voice".into(),
        raw.get("voice")
            .filter(|v| truthy(v))
            .cloned()
            .unwrap_or(json!("alloy")),
    );
    out.insert(
        "dimensions".into(),
        raw.get("dimensions")
            .filter(|v| truthy(v))
            .cloned()
            .unwrap_or(Value::Null),
    );
    out.insert("assetOrigins".into(), json!(normalized_origins));
    let mut out = Value::Object(out);
    let wire = json_codec::stringify_js(&out)?;
    out["identity"] = json!(format!("{:x}", Sha256::digest(wire.as_bytes())));
    Ok(out)
}
pub fn validate_registry(input: &Value) -> Result<Value, CapabilityError> {
    require(
        truthy(input)
            && input.is_object()
            && js_keys(input)
                .iter()
                .all(|k| matches!(k.as_str(), "profiles" | "routes"))
            && input["profiles"].as_array().is_some_and(|a| a.len() <= 64),
        400,
        "Invalid capability registry",
    )?;
    let mut profiles = Vec::new();
    let mut ids = HashSet::new();
    for raw in arr(&input["profiles"]) {
        let p = validate_capability(raw)?;
        require(
            ids.insert(s(&p, "id").to_owned()),
            400,
            "Duplicate capability ID",
        )?;
        profiles.push(p);
    }
    let routes_value = input
        .get("routes")
        .filter(|v| truthy(v))
        .cloned()
        .unwrap_or(json!({}));
    let mut routes = Map::new();
    // Object.entries on JSON arrays exposes numeric keys, which fail role checks.
    let routes_entries: Vec<(String, Value)> = if let Some(a) = routes_value.as_array() {
        a.iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect()
    } else if let Some(text) = routes_value.as_str() {
        json_codec::utf16_units(text)
            .iter()
            .enumerate()
            .map(|(i, c)| (i.to_string(), json!(json_codec::from_utf16_units(&[*c]))))
            .collect()
    } else {
        js_keys(&routes_value)
            .iter()
            .map(|k| (k.clone(), routes_value[k].clone()))
            .collect()
    };
    for (role, id) in routes_entries {
        require(
            ROLES.contains(&role.as_str()),
            400,
            "Unknown capability role",
        )?;
        let p = profiles.iter().find(|p| p["id"] == id);
        require(
            p.is_some_and(|p| truthy(&p["enabled"]) && p["role"] == role),
            400,
            "Route and endpoint capability do not match",
        )?;
        routes.insert(role, id);
    }
    Ok(json!({"profiles":profiles,"routes":routes}))
}

#[derive(Clone, Default)]
pub enum CapabilityBody {
    #[default]
    Empty,
    Bytes(Bytes),
    /// Internal encoded JS text; conversion to UTF-8 replaces lone surrogates.
    Text(String),
    /// Trusted multipart/blob encoder output. Mirrors the network FormData/Blob
    /// content type and its 16MiB request budget; not arbitrary extra headers.
    EncodedMedia {
        bytes: Bytes,
        content_type: String,
    },
}
#[derive(Clone)]
pub struct CapabilityRequest {
    pub method: Method,
    pub json: Option<Value>,
    pub body: CapabilityBody,
    pub max_bytes: usize,
    pub egress_guard: Option<Arc<dyn EgressGuard>>,
}
impl Default for CapabilityRequest {
    fn default() -> Self {
        Self {
            method: Method::POST,
            json: None,
            body: CapabilityBody::Empty,
            max_bytes: 8_000_000,
            egress_guard: None,
        }
    }
}
pub struct BufferedResponse {
    pub status: u16,
    pub headers: HeaderMap,
    pub bytes: Bytes,
}
impl BufferedResponse {
    /// Fetch Response.json decodes replacement UTF-8 and strips a UTF-8 BOM.
    pub fn json(&self) -> Result<Value, CapabilityError> {
        let text = String::from_utf8_lossy(&self.bytes);
        json_codec::parse(text.strip_prefix('\u{feff}').unwrap_or(&text))
            .map_err(|_| CapabilityError::new(502, "Invalid capability JSON"))
    }
}
pub struct Download {
    pub bytes: Bytes,
    pub content_type: Option<String>,
}
#[derive(Clone)]
struct EphemeralKey {
    value: String,
    base_url: Value,
    protocol: Value,
    pinned_address: Value,
}
impl EphemeralKey {
    fn new(value: &str, profile: &Value) -> Self {
        Self {
            value: value.into(),
            base_url: profile["baseUrl"].clone(),
            protocol: profile["protocol"].clone(),
            pinned_address: profile["pinnedAddress"].clone(),
        }
    }
    fn matches(&self, profile: &Value) -> bool {
        self.base_url == profile["baseUrl"]
            && self.protocol == profile["protocol"]
            && self.pinned_address == profile["pinnedAddress"]
    }
}
struct Active {
    profile_id: String,
    identity: String,
    cancel: RequestCancellation,
    reason: Arc<Mutex<Option<CapabilityError>>>,
}
#[derive(Default)]
struct Memory {
    keys: HashMap<String, EphemeralKey>,
    // Shared-owner epoch only; no credential material enters advisory bindings.
    key_generation: u64,
    active: HashMap<u64, Active>,
    next: u64,
    closed: bool,
}
struct Inner {
    state: Arc<dyn CapabilityState>,
    network: NativeNetwork,
    gate: ResourceGate,
    environment: Environment,
    configuration: Mutex<()>,
    memory: Mutex<Memory>,
}
#[derive(Clone)]
pub struct Capabilities {
    inner: Arc<Inner>,
}
struct Operation {
    owner: Weak<Inner>,
    id: u64,
    cancel: RequestCancellation,
    parent: RequestCancellation,
    reason: Arc<Mutex<Option<CapabilityError>>>,
    watcher: tokio::task::AbortHandle,
}
impl Drop for Operation {
    fn drop(&mut self) {
        self.watcher.abort();
        if let Some(owner) = self.owner.upgrade() {
            lock(&owner.memory).active.remove(&self.id);
        }
    }
}
impl Operation {
    fn check(&self) -> Result<(), CapabilityError> {
        if let Some(reason) = lock(&self.reason).clone() {
            return Err(reason);
        }
        if let Some(e) = self.parent.error().or_else(|| self.cancel.error()) {
            return Err(e.into());
        }
        Ok(())
    }
    fn error(&self, error: impl Into<CapabilityError>) -> CapabilityError {
        lock(&self.reason).clone().unwrap_or_else(|| {
            self.parent
                .error()
                .map(Into::into)
                .unwrap_or_else(|| error.into())
        })
    }
}
impl Capabilities {
    pub fn new(state: Arc<dyn CapabilityState>, network: NativeNetwork) -> Self {
        Self::with_options(
            state,
            network,
            ResourceGate::default(),
            Arc::new(|key| std::env::var(key).ok()),
        )
    }
    pub fn with_options(
        state: Arc<dyn CapabilityState>,
        network: NativeNetwork,
        gate: ResourceGate,
        environment: Environment,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                state,
                network,
                gate,
                environment,
                configuration: Mutex::new(()),
                memory: Mutex::new(Memory::default()),
            }),
        }
    }
    pub fn get(&self) -> Result<Value, CapabilityError> {
        Ok(self
            .inner
            .state
            .value("capabilities")?
            .filter(truthy)
            .unwrap_or_else(|| json!({"schema":1,"revision":0,"profiles":[],"routes":{}})))
    }
    pub fn current(&self, p: &Value) -> Result<bool, CapabilityError> {
        let registry = self.get()?;
        Ok(!lock(&self.inner.memory).closed
            && arr(&registry["profiles"])
                .iter()
                .any(|x| truthy(&x["enabled"]) && x["identity"] == p["identity"]))
    }
    pub fn pin(&self, role: &str) -> Result<Value, CapabilityError> {
        let registry = self.get()?;
        let p = arr(&registry["profiles"])
            .iter()
            .find(|p| p["id"] == registry["routes"][role])
            .filter(|p| truthy(&p["enabled"]) && p["role"] == role)
            .ok_or_else(|| {
                CapabilityError::invalidated(409, format!("{role} の接続先を選んでください。"))
            })?;
        Ok(p.clone())
    }
    fn key_from(&self, p: &Value, keys: &HashMap<String, EphemeralKey>) -> String {
        keys.get(s(p, "id"))
            .filter(|key| key.matches(p) && !key.value.is_empty())
            .map(|key| key.value.clone())
            .or_else(|| {
                let name = s(p, "apiKeyEnv");
                if name.is_empty() {
                    None
                } else {
                    (self.inner.environment)(&json_codec::sql_text(name))
                        .map(|s| json_codec::encode_text(&s))
                }
            })
            .unwrap_or_default()
    }
    fn key_for(&self, p: &Value) -> Result<String, CapabilityError> {
        if !self.current(p)? {
            return Ok(String::new());
        }
        Ok(self.key_from(p, &lock(&self.inner.memory).keys))
    }
    pub fn key_present(&self, p: &Value) -> Result<bool, CapabilityError> {
        Ok(!self.key_for(p)?.is_empty())
    }
    fn public_snapshot(
        &self,
        registry: &Value,
        keys: &HashMap<String, EphemeralKey>,
        closed: bool,
    ) -> Value {
        let mut out = registry.clone();
        out["profiles"] = json!(arr(&registry["profiles"])
            .iter()
            .map(|p| {
                let mut p = p.clone();
                let current = !closed && truthy(&p["enabled"]);
                p["keyPresent"] = json!(current && !self.key_from(&p, keys).is_empty());
                p
            })
            .collect::<Vec<_>>());
        out
    }
    /// Refresh ephemeral key-presence hints in a registry already read by
    /// Workspace. Safe while its State lock is held: no configuration lock or
    /// CapabilityState callback is used, and no explicit key value is exposed.
    pub fn decorate_snapshot(&self, registry: &mut Value) {
        let memory = lock(&self.inner.memory);
        *registry = self.public_snapshot(registry, &memory.keys, memory.closed);
    }
    pub fn snapshot(&self) -> Result<Value, CapabilityError> {
        let registry = self.get()?;
        require(
            registry.is_object()
                && registry["profiles"]
                    .as_array()
                    .is_some_and(|profiles| profiles.iter().all(Value::is_object)),
            500,
            "Invalid saved capabilities",
        )?;
        let memory = lock(&self.inner.memory);
        Ok(self.public_snapshot(&registry, &memory.keys, memory.closed))
    }
    pub fn save(&self, input: &Value, expected_revision: u64) -> Result<Value, CapabilityError> {
        let _configuration = lock(&self.inner.configuration);
        let previous = self.get()?;
        require(
            previous["revision"].as_u64() == Some(expected_revision),
            409,
            "Capability settings changed. Reload before saving.",
        )?;
        let validated = validate_registry(input)?;
        let next = json!({"schema":1,"revision":expected_revision+1,"profiles":validated["profiles"],"routes":validated["routes"]});
        let (mut keys, closed) = {
            let memory = lock(&self.inner.memory);
            (memory.keys.clone(), memory.closed)
        };
        for p in arr(&previous["profiles"]) {
            let replacement = arr(&next["profiles"]).iter().find(|n| n["id"] == p["id"]);
            if replacement.is_none_or(|n| {
                n["baseUrl"] != p["baseUrl"]
                    || n["protocol"] != p["protocol"]
                    || n["pinnedAddress"] != p["pinnedAddress"]
            }) {
                keys.remove(s(p, "id"));
            }
        }
        let public = self.public_snapshot(&next, &keys, closed);
        // Match the source's revocation-before-publication order. In particular,
        // a synchronous registry event must never expose a new endpoint while
        // its old endpoint's explicit credential is still installed. A failed
        // durable write can cancel prior work/prune a key, but cannot grant it.
        {
            let mut memory = lock(&self.inner.memory);
            if memory.keys.len() != keys.len() {
                memory.key_generation = memory.key_generation.wrapping_add(1);
            }
            memory.keys = keys;
            for active in memory.active.values() {
                if !arr(&next["profiles"]).iter().any(|p| {
                    p["id"] == active.profile_id
                        && p["identity"] == active.identity
                        && truthy(&p["enabled"])
                }) {
                    *lock(&active.reason) = Some(CapabilityError::changed());
                    active.cancel.cancel();
                }
            }
        }
        self.inner
            .state
            .commit_registry(expected_revision, next, public.clone())?;
        Ok(public)
    }
    pub fn set_key(
        &self,
        id: &str,
        key: &Value,
        identity: &Value,
    ) -> Result<Value, CapabilityError> {
        let _configuration = lock(&self.inner.configuration);
        let registry = self.get()?;
        let p = arr(&registry["profiles"])
            .iter()
            .find(|p| p["id"] == id)
            .filter(|p| p["identity"] == *identity)
            .ok_or_else(|| CapabilityError::new(409, "Capability changed"))?;
        let key = key
            .as_str()
            .filter(|s| json_codec::utf16_units(s).len() <= 4000)
            .ok_or_else(|| CapabilityError::new(400, "Invalid key"))?;
        {
            let mut memory = lock(&self.inner.memory);
            // Preserve source in-flight behavior. Settled advisory results are
            // rejected at actor commit through this epoch, not transport cancellation.
            memory.key_generation = memory.key_generation.wrapping_add(1);
            if key.is_empty() {
                memory.keys.remove(id);
            } else {
                memory.keys.insert(id.into(), EphemeralKey::new(key, p));
            }
        }
        Ok(json!({"id":id,"keyPresent":self.key_present(p)?}))
    }
    pub fn resources(&self) -> Value {
        self.inner.gate.snapshot()
    }
    pub fn active_count(&self) -> usize {
        lock(&self.inner.memory).active.len()
    }
    fn operation(
        &self,
        p: &Value,
        parent: &RequestCancellation,
    ) -> Result<Operation, CapabilityError> {
        let _configuration = lock(&self.inner.configuration);
        if let Some(e) = parent.error() {
            return Err(e.into());
        }
        if !self.current(p)? {
            return Err(CapabilityError::invalidated(
                409,
                "The capability endpoint changed or was disabled",
            ));
        }
        let cancel = RequestCancellation::new();
        let reason = Arc::new(Mutex::new(None));
        let id = {
            let mut memory = lock(&self.inner.memory);
            let id = memory.next;
            memory.next = memory.next.wrapping_add(1);
            memory.active.insert(
                id,
                Active {
                    profile_id: s(p, "id").into(),
                    identity: s(p, "identity").into(),
                    cancel: cancel.clone(),
                    reason: reason.clone(),
                },
            );
            id
        };
        let source = parent.clone();
        let child = cancel.clone();
        let watcher = tokio::spawn(async move {
            source.cancelled().await;
            child.cancel();
        })
        .abort_handle();
        Ok(Operation {
            owner: Arc::downgrade(&self.inner),
            id,
            cancel,
            parent: parent.clone(),
            reason,
            watcher,
        })
    }
    pub async fn request(
        &self,
        p: &Value,
        route: &str,
        request: CapabilityRequest,
        cancel: &RequestCancellation,
    ) -> Result<BufferedResponse, CapabilityError> {
        if !self.current(p)? {
            return Err(CapabilityError::invalidated(
                409,
                "The capability endpoint changed or was disabled",
            ));
        }
        // ECMAScript /i keeps this range ASCII-only. Without multiline, $
        // requires the actual end of input, including for line terminators.
        require(
            route.starts_with('/')
                && route.len() > 1
                && route
                    .bytes()
                    .skip(1)
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'/' | b'-'))
                && !route.contains(".."),
            400,
            "Invalid modality route",
        )?;
        // Valid saves normalize submitted null to the ordinary source default.
        // Only malformed legacy/direct state can retain a null/zero limit. The
        // shared native gate clamps zero to one; reject such state explicitly
        // rather than silently granting it an executable slot.
        let parallel = p["maxParallel"]
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or_else(|| {
                CapabilityError::new(
                    409,
                    "Capability concurrency is unavailable: maxParallel must be a positive integer",
                )
            })?;
        let operation = self.operation(p, cancel)?;
        operation.check()?;
        let _lease = self
            .inner
            .gate
            .acquire(
                &format!("cap:{}", s(p, "resource")),
                parallel as usize,
                if p["role"] == "tts" { 10. } else { 0. },
                0,
                &operation.cancel,
            )
            .await
            .map_err(|e| operation.error(e))?;
        if let Some(guard) = &request.egress_guard {
            guard.check()?;
        }
        let key = {
            // One dispatch snapshot with save/set_key. No config lock is held
            // across serialization, network admission, I/O, or response parsing.
            let _configuration = lock(&self.inner.configuration);
            operation.check()?;
            if !self.current(p)? {
                return Err(CapabilityError::invalidated(
                    409,
                    "Capability changed while queued",
                ));
            }
            self.key_for(p)?
        };
        let mut headers = HeaderMap::new();
        if !key.is_empty() {
            let value = format!("Bearer {}", json_codec::sql_text(&key));
            let value = value.trim_matches([' ', '\t']);
            // Fetch Headers uses ByteString rather than UTF-8 for header values.
            let units: Vec<u16> = value.encode_utf16().collect();
            require(
                units.iter().all(|u| *u <= 255),
                400,
                "Invalid authorization header",
            )?;
            let bytes: Vec<u8> = units.into_iter().map(|u| u as u8).collect();
            headers.insert(
                header::AUTHORIZATION,
                header::HeaderValue::from_bytes(&bytes)
                    .map_err(|_| CapabilityError::new(400, "Invalid authorization header"))?,
            );
        }
        let (body, media) = if let Some(json) = request.json {
            headers.insert(
                header::CONTENT_TYPE,
                header::HeaderValue::from_static("application/json"),
            );
            (Bytes::from(json_codec::stringify_js(&json)?), false)
        } else {
            match request.body {
                CapabilityBody::Empty => (Bytes::new(), false),
                CapabilityBody::Bytes(b) => (b, false),
                CapabilityBody::Text(s) => (Bytes::from(json_codec::sql_text(&s)), false),
                CapabilityBody::EncodedMedia {
                    bytes,
                    content_type,
                } => {
                    if bytes.len() > 16 * 1024 * 1024 {
                        return Err(NetworkError::blocked("Request body exceeds budget").into());
                    }
                    headers.insert(
                        header::CONTENT_TYPE,
                        header::HeaderValue::from_str(&content_type)
                            .map_err(|_| CapabilityError::new(400, "Invalid media content type"))?,
                    );
                    (bytes, true)
                }
            }
        };
        let mut profile = NetworkProfile::from_value(p)?;
        profile.id = format!("cap:{}", s(p, "id"));
        let base = json_codec::sql_text(s(p, "baseUrl"));
        let url = format!("{}{}", base.strip_suffix('/').unwrap_or(&base), route);
        let scope = NetworkScope {
            profile: Some(profile),
            egress_guard: request.egress_guard,
            purpose: Purpose::Model,
            timeout: Duration::from_millis(
                p["timeoutMs"].as_u64().filter(|n| *n > 0).unwrap_or(180000),
            ),
            max_bytes: if request.max_bytes == 0 {
                4_000_000
            } else {
                request.max_bytes
            },
            max_request_bytes: if media { Some(16 * 1024 * 1024) } else { None },
            ..Default::default()
        };
        operation.check()?;
        let response = self
            .inner
            .network
            .request(
                &url,
                NetworkRequest {
                    method: request.method,
                    headers,
                    body,
                    cancellation: Some(operation.cancel.clone()),
                },
                scope,
            )
            .await
            .map_err(|e| operation.error(e))?;
        operation.check()?;
        let status = response.status;
        if !(200..300).contains(&status) {
            drop(response);
            return Err(CapabilityError::upstream(status));
        }
        let headers = response.headers.clone();
        let bytes = response.bytes().await.map_err(|e| operation.error(e))?;
        operation.check()?;
        if !self.current(p)? {
            return Err(CapabilityError::invalidated(
                409,
                "Capability changed during response",
            ));
        }
        Ok(BufferedResponse {
            status,
            headers,
            bytes,
        })
    }
    pub async fn decide(
        &self,
        state: &Value,
        questions: &Value,
        profile: Option<&Value>,
        cancel: &RequestCancellation,
    ) -> Result<Value, CapabilityError> {
        let owned;
        let p = if let Some(p) = profile {
            p
        } else {
            owned = self.pin("decision")?;
            &owned
        };
        require(p["role"] == "decision", 400, "Not a decision endpoint")?;
        let payload = decision_payload(s(p, "model"), state, questions)?;
        let body = json_codec::parse(&payload)?;
        let timeout_ms = p["timeoutMs"].as_u64().filter(|n| *n > 0).ok_or_else(|| {
            CapabilityError::new(
                409,
                "Decision capability timeout must be a positive integer",
            )
        })?;
        let call = async {
            let response = self
                .request(
                    p,
                    "/systemone",
                    CapabilityRequest {
                        json: Some(body),
                        ..Default::default()
                    },
                    cancel,
                )
                .await?;
            let result = validate_answers(s(p, "model"), questions, &response.json()?)?;
            if let Some(error) = cancel.error() {
                return Err(error.into());
            }
            if !self.current(p)? {
                return Err(CapabilityError::invalidated(
                    409,
                    "Capability changed during decision validation",
                ));
            }
            Ok(result)
        };
        // DecisionClient's deadline includes its complete fetch, including
        // capability resource admission. Ordinary modality request() correctly
        // starts its own network timeout only after that admission.
        tokio::select! {
            biased;
            error=cancel.cancelled()=>Err(error.into()),
            result=tokio::time::timeout(Duration::from_millis(timeout_ms),call)=>match result {
                Ok(result)=>result,
                Err(_)=>Err(CapabilityError::new(504,"Decision request timed out")),
            },
        }
    }

    pub async fn embed(
        &self,
        inputs: &Value,
        profile: Option<&Value>,
        cancel: &RequestCancellation,
    ) -> Result<Value, CapabilityError> {
        self.embed_guarded(inputs, profile, cancel, None).await
    }
    pub async fn embed_guarded(
        &self,
        inputs: &Value,
        profile: Option<&Value>,
        cancel: &RequestCancellation,
        egress_guard: Option<Arc<dyn EgressGuard>>,
    ) -> Result<Value, CapabilityError> {
        let owned;
        let p = if let Some(p) = profile {
            p
        } else {
            owned = self.pin("embedding")?;
            &owned
        };
        require(p["role"] == "embedding", 400, "Not an embedding endpoint")?;
        require(
            inputs.as_array().is_some_and(|a| {
                (1..=32).contains(&a.len())
                    && a.iter().all(|s| {
                        s.as_str().is_some_and(|s| {
                            let n = json_codec::utf16_units(s).len();
                            n > 0 && n <= 12000
                        })
                    })
            }),
            400,
            "Embedding input budget exceeded",
        )?;
        let mut payload = json!({"model":p["model"],"input":inputs});
        if p["protocol"] == "openai-embeddings" {
            payload["encoding_format"] = json!("float");
            if truthy(&p["dimensions"]) {
                payload["dimensions"] = p["dimensions"].clone();
            }
        }
        let response = self
            .request(
                p,
                if p["protocol"] == "ollama-embed" {
                    "/embed"
                } else {
                    "/embeddings"
                },
                CapabilityRequest {
                    json: Some(payload),
                    egress_guard,
                    ..Default::default()
                },
                cancel,
            )
            .await?;
        let result=validate_embeddings(p, inputs, &response.json()?)?;
        if let Some(error)=cancel.error(){return Err(error.into());}
        if !self.current(p)? {return Err(CapabilityError::invalidated(409,"Embedding endpoint changed during validation"));}
        Ok(result)
    }
    pub async fn download(
        &self,
        p: &Value,
        url: &str,
        cancel: &RequestCancellation,
    ) -> Result<Download, CapabilityError> {
        if !self.current(p)? {
            return Err(CapabilityError::invalidated(409, "Capability changed"));
        }
        let url = normal_url(&json_codec::sql_text(url), true)?;
        let origin = url.origin().ascii_serialization();
        let base = normal_url(&json_codec::sql_text(s(p, "baseUrl")), false)?
            .origin()
            .ascii_serialization();
        require(
            origin == base
                || arr(&p["assetOrigins"]).iter().any(|x| {
                    x.as_str()
                        .is_some_and(|s| json_codec::sql_text(s) == origin)
                }),
            403,
            "生成済みファイルの配信元を接続設定で許可してください。",
        )?;
        let operation = self.operation(p, cancel)?;
        let mut profile = NetworkProfile::from_value(p)?;
        profile.id = format!("cap:{}", s(p, "id"));
        profile.base_url = origin.clone();
        if origin != base {
            profile.domain = Domain::Cloud;
        }
        let response = self
            .inner
            .network
            .request(
                url.as_str(),
                NetworkRequest {
                    cancellation: Some(operation.cancel.clone()),
                    ..Default::default()
                },
                NetworkScope {
                    profile: Some(profile),
                    purpose: Purpose::Model,
                    asset: true,
                    max_bytes: 32 * 1024 * 1024,
                    timeout: Duration::from_millis(
                        p["timeoutMs"].as_u64().filter(|n| *n > 0).unwrap_or(180000),
                    ),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| operation.error(e))?;
        operation.check()?;
        require(
            (200..300).contains(&response.status),
            502,
            "Generated media download failed",
        )?;
        let content_type = response
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|s| s.to_str().ok())
            .map(str::to_owned);
        let bytes = response.bytes().await.map_err(|e| operation.error(e))?;
        operation.check()?;
        if !self.current(p)? {
            return Err(CapabilityError::invalidated(
                409,
                "Capability changed during download",
            ));
        }
        Ok(Download {
            bytes,
            content_type,
        })
    }
    pub fn close(&self) {
        let _configuration = lock(&self.inner.configuration);
        let mut memory = lock(&self.inner.memory);
        memory.closed = true;
        memory.keys.clear();
        for active in memory.active.values() {
            *lock(&active.reason) = Some(CapabilityError::closed());
            active.cancel.cancel();
        }
        drop(memory);
        self.inner.gate.close();
    }
}

/// Inject this adapter into Decisions::with_backend. It has no registry,
/// credential cache, resource gate, network owner, or persistent state of its
/// own: every one-shot operation resolves through the same Capabilities owner.
#[derive(Clone)]
pub struct CapabilityDecisionBackend {
    capabilities: Capabilities,
}
impl CapabilityDecisionBackend {
    pub fn new(capabilities: Capabilities) -> Self {
        Self { capabilities }
    }
}
impl DecisionBackend for CapabilityDecisionBackend {
    fn binding(&self) -> Value {
        // One synchronous snapshot under the shared owner's configuration lock.
        // Never return credentials or credential hashes to advisory consumers.
        let _configuration = lock(&self.capabilities.inner.configuration);
        let Ok(registry) = self.capabilities.get() else { return Value::Null };
        let memory = lock(&self.capabilities.inner.memory);
        let profile = arr(&registry["profiles"]).iter()
            .find(|p| p["id"] == registry["routes"]["decision"]);
        json!({"revision":registry["revision"],
            "identity":profile.map(|p| &p["identity"]),
            "keyGeneration":memory.key_generation,"closed":memory.closed})
    }
    fn available(&self) -> bool {
        self.capabilities
            .pin("decision")
            .and_then(|p| self.capabilities.current(&p))
            .unwrap_or(false)
    }
    fn decide<'a>(
        &'a self,
        state: &'a Value,
        questions: &'a Value,
        cancel: &'a RequestCancellation,
    ) -> DecisionFuture<'a> {
        Box::pin(async move {
            self.capabilities
                .decide(state, questions, None, cancel)
                .await
                .map_err(|e| DecisionError {
                    status: e.status,
                    upstream_status: e.upstream_status,
                    cancelled: e.cancelled,
                    invalidated: e.invalidated,
                    message: e.message,
                })
        })
    }
}

pub fn validate_embeddings(
    profile: &Value,
    inputs: &Value,
    data: &Value,
) -> Result<Value, CapabilityError> {
    let mut vectors = if profile["protocol"] == "ollama-embed" {
        data["embeddings"].clone()
    } else {
        require(
            data["data"]
                .as_array()
                .is_some_and(|a| a.len() == arr(inputs).len()),
            502,
            "Missing embeddings",
        )?;
        let mut vectors = vec![Value::Null; arr(inputs).len()];
        for row in arr(&data["data"]) {
            let index = row["index"]
                .as_f64()
                .filter(|n| n.fract() == 0. && *n >= 0. && *n < arr(inputs).len() as f64)
                .ok_or_else(|| CapabilityError::new(502, "Invalid embedding indices"))?
                as usize;
            require(!truthy(&vectors[index]), 502, "Invalid embedding indices")?;
            vectors[index] = row.get("embedding").cloned().unwrap_or(Value::Null);
        }
        json!(vectors)
    };
    require(
        vectors
            .as_array()
            .is_some_and(|a| a.len() == arr(inputs).len()),
        502,
        "Embedding count mismatch",
    )?;
    // JS optional .length is observable even on malformed string/object
    // vectors: dimension validation precedes the per-vector array check.
    let first = arr(&vectors).first();
    let dimensions = match first {
        Some(Value::Array(a)) => Some(a.len() as f64),
        Some(Value::String(s)) => Some(json_codec::utf16_units(s).len() as f64),
        Some(Value::Object(o)) => o.get("length").and_then(Value::as_f64),
        _ => None,
    }
    .filter(|n| n.fract() == 0. && *n > 0. && *n <= 8192.);
    let dimensions = dimensions
        .ok_or_else(|| CapabilityError::new(502, "Embedding dimension mismatch"))?
        as usize;
    require(
        !truthy(&profile["dimensions"])
            || profile["dimensions"].as_f64() == Some(dimensions as f64),
        502,
        "Embedding dimension mismatch",
    )?;
    for v in arr(&vectors) {
        require(
            v.as_array().is_some_and(|a| {
                a.len() == dimensions
                    && a.iter().all(|n| n.as_f64().is_some_and(f64::is_finite))
                    && a.iter().any(|n| n.as_f64() != Some(0.))
            }),
            502,
            "Invalid embedding vector",
        )?;
    }
    Ok(
        json!({"vectors":vectors.take(),"dimensions":dimensions,"model":profile["model"],"identity":profile["identity"]}),
    )
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
