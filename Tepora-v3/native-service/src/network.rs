//! Application-owned checked outbound transport. This is not an OS firewall.
//! A trusted caller supplies the registry scope. DNS is checked once, all answers
//! are validated, and the actual socket uses that exact checked destination.
//! The Workspace remains the sole persistent policy owner.
mod policy;
#[cfg(test)]
mod tests;
mod transport;

use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use hyper::{HeaderMap, Method};
use policy::{checked_ip, hostname};
pub use policy::{
    inside_endpoint, ip_domain, normal_url, Domain, NetworkMode, NetworkPolicy, Purpose,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    fmt,
    future::Future,
    net::IpAddr,
    pin::Pin,
    sync::{Arc, Mutex, Weak},
    task::{Context, Poll},
    time::Duration,
};
use tokio::{sync::watch, task::AbortHandle, time::Instant};
pub use transport::CheckedTransport;
use url::Url;

pub type NetworkFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, NetworkError>> + Send + 'a>>;
pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, NetworkError>> + Send>>;
#[derive(Clone, Debug)]
pub struct NetworkError {
    pub status: u16,
    pub blocked: bool,
    pub timeout: bool,
    pub idle: bool,
    pub cancelled: bool,
    pub message: String,
}
impl NetworkError {
    pub fn blocked(message: impl Into<String>) -> Self {
        Self {
            status: 403,
            blocked: true,
            timeout: false,
            idle: false,
            cancelled: false,
            message: message.into(),
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            blocked: false,
            timeout: false,
            idle: false,
            cancelled: false,
            message: message.into(),
        }
    }
    pub fn transport(message: impl Into<String>) -> Self {
        Self {
            status: 502,
            blocked: false,
            timeout: false,
            idle: false,
            cancelled: false,
            message: message.into(),
        }
    }
    fn timed_out(message: impl Into<String>, idle: bool) -> Self {
        Self {
            status: 504,
            blocked: false,
            timeout: true,
            idle,
            cancelled: false,
            message: message.into(),
        }
    }
    fn cancelled() -> Self {
        Self {
            status: 499,
            blocked: false,
            timeout: false,
            idle: false,
            cancelled: true,
            message: "Request cancelled".into(),
        }
    }
}
impl fmt::Display for NetworkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for NetworkError {}
impl From<NetworkError> for crate::ApiError {
    fn from(e: NetworkError) -> Self {
        Self {
            status: e.status,
            blocked: e.blocked,
            message: e.message,
        }
    }
}

/// Cancellation is synchronous and sticky; all waiters receive the first cause.
#[derive(Clone, Debug)]
pub struct RequestCancellation {
    tx: watch::Sender<Option<NetworkError>>,
}
impl Default for RequestCancellation {
    fn default() -> Self {
        Self::new()
    }
}
impl RequestCancellation {
    pub fn new() -> Self {
        Self {
            tx: watch::channel(None).0,
        }
    }
    pub fn cancel(&self) {
        self.fail(NetworkError::cancelled());
    }
    pub fn is_cancelled(&self) -> bool {
        self.tx.borrow().is_some()
    }
    pub fn error(&self) -> Option<NetworkError> {
        self.tx.borrow().clone()
    }
    fn check(&self) -> Result<(), NetworkError> {
        self.error().map_or(Ok(()), Err)
    }
    fn fail(&self, error: NetworkError) {
        self.tx.send_if_modified(|v| {
            if v.is_some() {
                false
            } else {
                *v = Some(error);
                true
            }
        });
    }
    pub async fn cancelled(&self) -> NetworkError {
        let mut rx = self.tx.subscribe();
        loop {
            if let Some(e) = rx.borrow_and_update().clone() {
                return e;
            }
            if rx.changed().await.is_err() {
                return NetworkError::cancelled();
            }
        }
    }
}
async fn optional_cancellation(cancel: &Option<RequestCancellation>) -> NetworkError {
    match cancel {
        Some(cancel) => cancel.cancelled().await,
        None => std::future::pending().await,
    }
}

#[derive(Clone, Debug)]
pub struct NetworkProfile {
    pub id: String,
    pub base_url: String,
    pub domain: Domain,
    pub enabled: bool,
    pub pinned_address: Option<String>,
    pub allow_plain_http: bool,
}
/// Trusted native authority, never supplied by model or HTTP payload JSON.
/// Implementations perform short synchronous checks and must not expose their
/// captured documents or credentials through Debug/errors.
pub trait EgressGuard: Send + Sync + std::fmt::Debug {
    fn check(&self) -> Result<(), NetworkError>;
}
#[derive(Clone, Debug)]
pub struct NetworkScope {
    pub profile: Option<NetworkProfile>,
    pub egress_guard: Option<Arc<dyn EgressGuard>>,
    pub purpose: Purpose,
    pub allow_cloud: bool,
    pub asset: bool,
    /// Return redirects for explicit caller handling; never follow them.
    pub redirects: bool,
    /// Trusted Gemini streaming caller only: permits exactly `alt=sse`.
    pub gemini_stream_query: bool,
    pub max_bytes: usize,
    /// Optional encoding-specific cap. Plain model JSON/bytes are unbounded by default, matching the source.
    pub max_request_bytes: Option<usize>,
    pub timeout: Duration,
    pub first_byte_timeout: Option<Duration>,
    pub idle_timeout: Option<Duration>,
    pub deadline: Option<Duration>,
}
impl Default for NetworkScope {
    fn default() -> Self {
        Self {
            profile: None,
            egress_guard: None,
            purpose: Purpose::Model,
            allow_cloud: false,
            asset: false,
            redirects: false,
            gemini_stream_query: false,
            max_bytes: 4_000_000,
            max_request_bytes: None,
            timeout: Duration::from_millis(180_000),
            first_byte_timeout: None,
            idle_timeout: None,
            deadline: None,
        }
    }
}
#[derive(Clone, Debug)]
pub struct NetworkRequest {
    pub method: Method,
    pub headers: HeaderMap,
    pub body: Bytes,
    pub cancellation: Option<RequestCancellation>,
}
impl Default for NetworkRequest {
    fn default() -> Self {
        Self {
            method: Method::GET,
            headers: HeaderMap::new(),
            body: Bytes::new(),
            cancellation: None,
        }
    }
}
#[derive(Clone, Debug)]
pub struct Admitted {
    pub url: Url,
    pub address: IpAddr,
    pub domain: Domain,
    pub purpose: Purpose,
    pub profile_id: Option<String>,
    domains: Vec<Domain>,
    egress_guard: Option<Arc<dyn EgressGuard>>,
}
impl Admitted {
    pub fn check_egress(&self) -> Result<(), NetworkError> {
        self.egress_guard
            .as_ref()
            .map_or(Ok(()), |guard| guard.check())
    }
}
/// Injection seam for tests and platform DNS. Implementations must return every
/// A/AAAA answer, rather than filtering disallowed addresses before admission.
pub trait Resolver: Send + Sync {
    fn lookup<'a>(&'a self, host: &'a str) -> NetworkFuture<'a, Vec<String>>;
}
pub struct SystemResolver;
impl Resolver for SystemResolver {
    fn lookup<'a>(&'a self, host: &'a str) -> NetworkFuture<'a, Vec<String>> {
        Box::pin(async move {
            let values = tokio::net::lookup_host((host, 0))
                .await
                .map_err(|e| NetworkError::transport(format!("DNS lookup failed: {e}")))?;
            Ok(values.map(|v| v.ip().to_string()).collect())
        })
    }
}
/// Raw transport never chooses permissions. The manager alone constructs its
/// admitted destination; a transport must connect exactly there without resolving
/// again, and call admitted.check_egress() immediately before writing request
/// bytes after its own TCP/TLS waits. CheckedTransport enforces this boundary.
pub trait Transport: Send + Sync {
    /// Sanitized startup diagnostics. Never include certificates, keys, or file contents.
    fn diagnostics(&self) -> Vec<String> {
        Vec::new()
    }
    fn request<'a>(
        &'a self,
        admitted: Admitted,
        request: NetworkRequest,
        cancellation: RequestCancellation,
    ) -> NetworkFuture<'a, TransportResponse>;
}
pub struct TransportResponse {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Option<ByteStream>,
}
pub struct NetworkResponse {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: NetworkBody,
    pub has_body: bool,
}
impl NetworkResponse {
    pub async fn bytes(mut self) -> Result<Bytes, NetworkError> {
        let mut out = Vec::new();
        while let Some(chunk) = self.body.next().await {
            out.extend_from_slice(&chunk?);
        }
        Ok(out.into())
    }
    pub async fn text(self) -> Result<String, NetworkError> {
        let bytes = self.bytes().await?;
        let text = String::from_utf8_lossy(&bytes);
        Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned())
    }
    /// Bounded UTF-8 JSON collection, equivalent to core/transport.mjs.
    pub async fn json(mut self, max_bytes: usize) -> Result<Value, NetworkError> {
        if !self.has_body {
            return Err(NetworkError::transport("Provider response has no body"));
        }
        let mut out = Vec::new();
        while let Some(chunk) = self.body.next().await {
            let chunk = chunk?;
            if chunk.len() > max_bytes.saturating_sub(out.len()) {
                return Err(NetworkError::transport(
                    "Provider response exceeds the response-size limit",
                ));
            }
            out.extend_from_slice(&chunk);
        }
        let text = std::str::from_utf8(&out)
            .map_err(|_| NetworkError::transport("Response is not valid UTF-8"))?;
        tepora_core::json_codec::parse(text.strip_prefix('\u{feff}').unwrap_or(text))
            .map_err(|e| NetworkError::transport(format!("Invalid provider JSON: {e}")))
    }
}
/// Dropping an unread body cancels the socket and unregisters policy tracking.
pub struct NetworkBody {
    inner: ByteStream,
    _lifetime: Option<OperationLifetime>,
}
impl Stream for NetworkBody {
    type Item = Result<Bytes, NetworkError>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let result = self.inner.as_mut().poll_next(cx);
        if matches!(result, Poll::Ready(None) | Poll::Ready(Some(Err(_)))) {
            self._lifetime.take();
        }
        result
    }
}
// Attribute requests before an awaited resolver/transport step, so narrowing
// cloud policy does not cancel a simultaneously starting known-loopback request.
// A web-tool hostname remains unknown until every DNS answer has been checked.
fn pending_domains(value: &str, scope: &NetworkScope) -> Option<Vec<Domain>> {
    if let Some(profile) = &scope.profile {
        return Some(vec![profile.domain]);
    }
    let url = Url::parse(value).ok()?;
    let host = hostname(&url);
    let lexical = if host == "localhost" {
        Domain::Device
    } else {
        ip_domain(&host)
    };
    if scope.purpose == Purpose::WebTool {
        if lexical == Domain::Name {
            None
        } else {
            Some(vec![lexical])
        }
    } else {
        Some(vec![if lexical == Domain::Device {
            Domain::Device
        } else {
            Domain::Cloud
        }])
    }
}

struct Active {
    cancel: RequestCancellation,
    purpose: Purpose,
    domains: Option<Vec<Domain>>,
}
struct State {
    policy: NetworkPolicy,
    closed: bool,
    next_id: u64,
    active: HashMap<u64, Active>,
}
struct Inner {
    state: Mutex<State>,
    resolver: Arc<dyn Resolver>,
    transport: Arc<dyn Transport>,
}
#[derive(Clone)]
pub struct NativeNetwork {
    inner: Arc<Inner>,
}
struct OperationLifetime {
    manager: Weak<Inner>,
    id: u64,
    cancel: RequestCancellation,
    watchdog: AbortHandle,
}
impl Drop for OperationLifetime {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.watchdog.abort();
        if let Some(manager) = self.manager.upgrade() {
            manager
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .active
                .remove(&self.id);
        }
    }
}
impl NativeNetwork {
    pub fn new(policy: NetworkPolicy) -> Self {
        Self::with_components(
            policy,
            Arc::new(SystemResolver),
            Arc::new(CheckedTransport::default()),
        )
    }
    pub fn with_components(
        policy: NetworkPolicy,
        resolver: Arc<dyn Resolver>,
        transport: Arc<dyn Transport>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State {
                    policy,
                    closed: false,
                    next_id: 0,
                    active: HashMap::new(),
                }),
                resolver,
                transport,
            }),
        }
    }
    pub fn diagnostics(&self) -> Vec<String> {
        self.inner.transport.diagnostics()
    }
    pub fn policy(&self) -> NetworkPolicy {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .policy
            .clone()
    }
    /// Workspace calls this under its mutation boundary after durable persistence
    /// and before acknowledging a change. Never opens an independent database.
    pub fn update_policy(&self, next: NetworkPolicy) {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        let narrows = next.narrows(&state.policy);
        for active in state.active.values() {
            if active.domains.as_ref().map_or(narrows, |ds| {
                ds.iter().any(|d| !next.permitted(*d, active.purpose))
            }) {
                active.cancel.fail(NetworkError::blocked(
                    "通信モードが変更されました。ローカル経路を再検討します。",
                ));
            }
        }
        state.policy = next;
    }
    pub fn close(&self) {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.closed = true;
        for active in state.active.values() {
            active.cancel.fail(NetworkError::blocked("Service closed"));
        }
        state.active.clear();
    }
    pub fn active_count(&self) -> usize {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active
            .len()
    }
    pub fn assert_uncontained(&self, kind: &str) -> Result<(), NetworkError> {
        let state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed || state.policy.mode != NetworkMode::Online {
            Err(NetworkError::blocked(format!("{kind}は通信を封じ込められないため、制限モードでは起動しません。ローカルのファイル処理・計算は継続できます。")))
        } else {
            Ok(())
        }
    }
    fn check_domains(&self, domains: &[Domain], purpose: Purpose) -> Result<(), NetworkError> {
        let state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            return Err(NetworkError::blocked("Service is closing"));
        }
        if domains.iter().any(|d| !state.policy.permitted(*d, purpose)) {
            return Err(NetworkError::blocked(
                "この通信は現在のモードで許可されていません。",
            ));
        }
        Ok(())
    }
    async fn resolve(
        &self,
        host: &str,
        cancel: &RequestCancellation,
    ) -> Result<Vec<String>, NetworkError> {
        tokio::select! {biased;e=cancel.cancelled()=>Err(e),result=self.inner.resolver.lookup(host)=>result}
    }
    async fn authorize(
        &self,
        value: &str,
        scope: &NetworkScope,
        cancel: &RequestCancellation,
    ) -> Result<Admitted, NetworkError> {
        cancel.check()?;
        let query = matches!(
            scope.purpose,
            Purpose::Web | Purpose::PublicWeb | Purpose::WebTool | Purpose::Feed
        ) || scope.asset;
        let special = scope.gemini_stream_query
            && scope.purpose == Purpose::Model
            && Url::parse(value)
                .ok()
                .is_some_and(|u| u.query() == Some("alt=sse"));
        let url = normal_url(value, query || special)?;
        let host = hostname(&url);
        let lexical = if host == "localhost" {
            Domain::Device
        } else {
            ip_domain(&host)
        };
        if scope.purpose == Purpose::WebTool && scope.profile.is_none() {
            if lexical == Domain::Reserved {
                return Err(NetworkError::blocked(
                    "予約済みのアドレスには接続しません。",
                ));
            }
            // Do not resolve any name when internet tools are disabled.
            if !self.policy().internet_tools {
                return Err(NetworkError::blocked(
                    "インターネットを使う道具が許可されていません。",
                ));
            }
            let addresses = if lexical == Domain::Name {
                self.resolve(&host, cancel).await?
            } else {
                vec![if host == "localhost" {
                    "127.0.0.1".into()
                } else {
                    host
                }]
            };
            let domains: Vec<_> = addresses.iter().map(|a| ip_domain(a)).collect();
            if domains.is_empty()
                || domains
                    .iter()
                    .any(|d| matches!(d, Domain::Reserved | Domain::Name))
            {
                return Err(NetworkError::blocked(
                    "DNSが予約済みのアドレスを返しました。",
                ));
            }
            // Deliberate tightening: JS picked the least-public label of mixed
            // answers but connected to the first, potentially more-public IP.
            self.check_domains(&domains, scope.purpose)?;
            cancel.check()?;
            let domain = if domains.contains(&Domain::Device) {
                Domain::Device
            } else if domains.contains(&Domain::Lan) {
                Domain::Lan
            } else {
                Domain::Cloud
            };
            return Ok(Admitted {
                url,
                address: checked_ip(&addresses[0])?,
                domain,
                purpose: scope.purpose,
                profile_id: None,
                domains,
                egress_guard: scope.egress_guard.clone(),
            });
        }
        let domain =
            scope
                .profile
                .as_ref()
                .map(|p| p.domain)
                .unwrap_or(if lexical == Domain::Device {
                    Domain::Device
                } else {
                    Domain::Cloud
                });
        if let Some(profile) = &scope.profile {
            if !inside_endpoint(url.as_str(), &profile.base_url) {
                return Err(NetworkError::blocked(
                    "登録した推論APIの範囲外へ接続しようとしました。",
                ));
            }
            if !profile.enabled {
                return Err(NetworkError::blocked("この接続先は無効です。"));
            }
        }
        self.check_domains(&[domain], scope.purpose)?;
        if domain == Domain::Cloud && scope.profile.is_none() && !scope.allow_cloud {
            return Err(NetworkError::blocked("外部通信の同意がありません。"));
        }
        let address = match domain {
            Domain::Device => {
                if lexical != Domain::Device {
                    return Err(NetworkError::blocked(
                        "同一PCの接続先はループバックに限定します。",
                    ));
                }
                checked_ip(if host == "localhost" {
                    "127.0.0.1"
                } else {
                    &host
                })?
            }
            Domain::Lan => {
                let p = scope
                    .profile
                    .as_ref()
                    .filter(|_| {
                        matches!(
                            scope.purpose,
                            Purpose::Model | Purpose::Vision | Purpose::Worker
                        )
                    })
                    .ok_or_else(|| {
                        NetworkError::blocked("LANは登録した推論機のAPIだけ許可します。")
                    })?;
                let pin = p
                    .pinned_address
                    .as_deref()
                    .filter(|p| ip_domain(p) == Domain::Lan)
                    .ok_or_else(|| {
                        NetworkError::blocked("LAN推論機のプライベートIPを固定してください。")
                    })?;
                if lexical != Domain::Name && host != pin {
                    return Err(NetworkError::blocked(
                        "登録したLANホストと固定IPが一致しません。",
                    ));
                }
                if url.scheme() == "http" && !p.allow_plain_http {
                    return Err(NetworkError::blocked(
                        "LANの平文HTTPは明示的に許可してください。",
                    ));
                }
                checked_ip(pin)?
            }
            Domain::Cloud => {
                if url.scheme() != "https" {
                    return Err(NetworkError::blocked("外部接続にはHTTPSが必要です。"));
                }
                if !matches!(lexical, Domain::Name | Domain::Cloud) {
                    return Err(NetworkError::blocked(
                        "外部URLからプライベート／予約済みIPへは接続しません。",
                    ));
                }
                let addresses = if lexical == Domain::Name {
                    self.resolve(&host, cancel).await?
                } else {
                    vec![host]
                };
                if addresses.is_empty() || addresses.iter().any(|a| ip_domain(a) != Domain::Cloud) {
                    return Err(NetworkError::blocked(
                        "DNSが非公開／予約済みIPを返しました。",
                    ));
                }
                // A saved policy can narrow during the DNS await.
                self.check_domains(&[domain], scope.purpose)?;
                cancel.check()?;
                checked_ip(&addresses[0])?
            }
            _ => return Err(NetworkError::blocked("Invalid destination domain")),
        };
        Ok(Admitted {
            url,
            address,
            domain,
            purpose: scope.purpose,
            profile_id: scope.profile.as_ref().map(|p| p.id.clone()),
            domains: vec![domain],
            egress_guard: scope.egress_guard.clone(),
        })
    }
    pub async fn request(
        &self,
        value: &str,
        request: NetworkRequest,
        scope: NetworkScope,
    ) -> Result<NetworkResponse, NetworkError> {
        if scope
            .max_request_bytes
            .is_some_and(|max| request.body.len() > max)
        {
            return Err(NetworkError::blocked("Request body exceeds budget"));
        }
        if let Some(c) = &request.cancellation {
            c.check()?;
        }
        let cancel = RequestCancellation::new();
        let progressive = scope.first_byte_timeout.is_some() || scope.idle_timeout.is_some();
        let first_byte = scope
            .first_byte_timeout
            .or(scope.idle_timeout)
            .unwrap_or(scope.timeout);
        let idle = scope.idle_timeout.unwrap_or(first_byte);
        let started = Instant::now();
        let (progress, mut updates) = watch::channel(
            started
                + if progressive {
                    first_byte
                } else {
                    scope.timeout
                },
        );
        let total = if progressive {
            scope.deadline.map(|d| started + d)
        } else {
            Some(started + scope.timeout)
        };
        let id = {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.closed {
                return Err(NetworkError::blocked("Service is closing"));
            }
            let id = state.next_id;
            state.next_id = state.next_id.wrapping_add(1);
            state.active.insert(
                id,
                Active {
                    cancel: cancel.clone(),
                    purpose: scope.purpose,
                    domains: pending_domains(value, &scope),
                },
            );
            id
        };
        let caller_cancel = request.cancellation.clone();
        let timer_cancel = cancel.clone();
        let external = caller_cancel.clone();
        let watchdog = tokio::spawn(async move {
            loop {
                let progress_expiry = *updates.borrow_and_update();
                let expiry = total.map_or(progress_expiry, |t| t.min(progress_expiry));
                tokio::select! {
                    biased;
                    _ = timer_cancel.cancelled() => break,
                    error = optional_cancellation(&external) => {
                        timer_cancel.fail(error);
                        break;
                    }
                    changed = updates.changed() => {
                        if changed.is_err() { break; }
                    }
                    _ = tokio::time::sleep_until(expiry) => {
                        let idle = progressive && total.is_none_or(|t| t > expiry);
                        timer_cancel.fail(NetworkError::timed_out(
                            if idle { "No data before first-byte/idle deadline" }
                            else { "Request total deadline exceeded" },
                            idle,
                        ));
                        break;
                    }
                }
            }
        })
        .abort_handle();
        let lifetime = OperationLifetime {
            manager: Arc::downgrade(&self.inner),
            id,
            cancel: cancel.clone(),
            watchdog,
        };
        let admitted = self.authorize(value, &scope, &cancel).await?;
        if let Some(c) = &caller_cancel {
            c.check()?;
        }
        {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.closed
                || admitted
                    .domains
                    .iter()
                    .any(|d| !state.policy.permitted(*d, scope.purpose))
            {
                return Err(NetworkError::blocked(
                    "この通信は現在のモードで許可されていません。",
                ));
            }
            cancel.check()?;
            state
                .active
                .get_mut(&id)
                .ok_or_else(|| NetworkError::blocked("Service closed"))?
                .domains = Some(admitted.domains.clone());
        }
        // DNS/resource waits cannot carry stale document consent into dispatch.
        admitted.check_egress()?;
        let result = tokio::select! {
            biased;
            error = cancel.cancelled() => return Err(error),
            error = optional_cancellation(&caller_cancel) => return Err(error),
            result = self.inner.transport.request(admitted, request, cancel.clone()) => result?,
        };
        cancel.check()?;
        if let Some(c) = &caller_cancel {
            c.check()?;
        }
        if (300..400).contains(&result.status) && !scope.redirects {
            return Err(NetworkError::blocked(
                "接続先からのリダイレクトは自動追跡しません。",
            ));
        }
        let has_body = result.body.is_some();
        if progressive {
            progress.send_replace(Instant::now() + idle);
        }
        let body = if let Some(mut source) = result.body {
            let body_cancel = cancel.clone();
            let max_bytes = scope.max_bytes;
            Box::pin(async_stream::try_stream! {
                let mut bytes = 0usize;
                loop {
                    if let Some(c) = &caller_cancel { c.check()?; }
                    let chunk = tokio::select! {
                        biased;
                        error = body_cancel.cancelled() => Err(error),
                        error = optional_cancellation(&caller_cancel) => Err(error),
                        chunk = source.next() => Ok(chunk),
                    }?;
                    let Some(chunk) = chunk else { break; };
                    let chunk = chunk?;
                    body_cancel.check()?;
                    if let Some(c) = &caller_cancel { c.check()?; }
                    if chunk.len() > max_bytes.saturating_sub(bytes) {
                        Err(NetworkError::transport("Response exceeds budget"))?;
                    }
                    bytes += chunk.len();
                    if progressive { progress.send_replace(Instant::now() + idle); }
                    yield chunk;
                }
            }) as ByteStream
        } else {
            Box::pin(futures_util::stream::empty()) as ByteStream
        };
        Ok(NetworkResponse {
            status: result.status,
            headers: result.headers,
            has_body,
            body: NetworkBody {
                inner: body,
                _lifetime: if has_body {
                    Some(lifetime)
                } else {
                    drop(lifetime);
                    None
                },
            },
        })
    }
}
