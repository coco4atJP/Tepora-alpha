//! HTTP/1 loopback shell. Authentication and routing stay in this process; the
//! backend receives typed domain operations, never requests or credentials.
use crate::{
    ApiError, Backend, EventRequest, EventSubscription, Operation, Reply, ServiceEvent,
    MAX_SAFE_INTEGER, VERSION,
};
use bytes::{Bytes, BytesMut};
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full, StreamBody};
use hyper::{
    body::{Body, Frame, Incoming},
    header::{self, HeaderName, HeaderValue},
    service::service_fn,
    Method, Request, Response, StatusCode,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    io,
    net::SocketAddr,
    path::PathBuf,
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, LazyLock,
    },
    task::{Context, Poll},
    time::Duration,
};
use subtle::ConstantTimeEq;
#[cfg(test)]
use tokio::net::TcpStream;
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpListener,
    sync::{watch, Notify, Semaphore},
    task::JoinSet,
    time::{Instant, Sleep},
};
use url::Url;

pub const BODY_LIMIT: usize = 12 * 1024 * 1024;
pub const APP_CSP:&str="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; media-src 'self' blob:; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
pub type ResponseBody = UnsyncBoxBody<Bytes, io::Error>;
#[derive(Clone, Debug)]
pub struct HttpConfig {
    pub port: u16,
    /// Explicit native-agent development admission. Ordinary --dev-native keeps
    /// its original unavailable-before-body-consumption route behavior.
    pub agent: bool,
    pub web_dir: PathBuf,
    pub bundle_path: PathBuf,
    pub header_timeout: Duration,
    pub body_timeout: Duration,
    pub heartbeat: Duration,
    pub write_timeout: Duration,
}
impl HttpConfig {
    pub fn new(web_dir: PathBuf, bundle_path: PathBuf) -> Self {
        Self {
            port: 0,
            agent: false,
            web_dir,
            bundle_path,
            header_timeout: Duration::from_secs(15),
            body_timeout: Duration::from_secs(150),
            heartbeat: Duration::from_secs(15),
            write_timeout: Duration::from_secs(15),
        }
    }
}
#[derive(Default)]
struct WorkTracker {
    count: AtomicUsize,
    finished: Notify,
}
struct WorkGuard(Arc<WorkTracker>);
impl Drop for WorkGuard {
    fn drop(&mut self) {
        if self.0.count.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.finished.notify_one();
        }
    }
}
struct HttpState {
    backend: Arc<dyn Backend>,
    config: HttpConfig,
    origin: String,
    host: String,
    secret: String,
    csrf: String,
    bundle: Bytes,
    shutdown: watch::Sender<bool>,
    work: Arc<WorkTracker>,
    /// Probes may wait on a model for 90 seconds. They get four dedicated
    /// threads, never the blocking workers used by control admission and DNS.
    probes: Arc<Semaphore>,
}
pub struct Server {
    listener: TcpListener,
    state: Arc<HttpState>,
}
impl Server {
    pub async fn bind(config: HttpConfig, backend: Arc<dyn Backend>) -> Result<Self, ApiError> {
        let bundle = tokio::fs::read(&config.bundle_path).await.map_err(|e| {
            ApiError::new(
                500,
                format!(
                    "Prebuilt browser bundle is required at {}: {e}",
                    config.bundle_path.display()
                ),
            )
        })?;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, config.port))
            .await
            .map_err(|e| ApiError::new(500, e.to_string()))?;
        let address = listener
            .local_addr()
            .map_err(|e| ApiError::new(500, e.to_string()))?;
        let host = address.to_string();
        let origin = format!("http://{host}");
        let (shutdown, _) = watch::channel(false);
        Ok(Self {
            listener,
            state: Arc::new(HttpState {
                backend,
                config,
                origin,
                host,
                secret: random_token()?,
                csrf: random_token()?,
                bundle: Bytes::from(bundle),
                shutdown,
                work: Arc::new(WorkTracker::default()),
                probes: Arc::new(Semaphore::new(4)),
            }),
        })
    }
    pub fn launch_url(&self) -> String {
        format!("{}/launch?token={}", self.state.origin, self.state.secret)
    }
    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }
    pub fn shutdown_sender(&self) -> watch::Sender<bool> {
        self.state.shutdown.clone()
    }
    pub async fn run(self) -> Result<(), ApiError> {
        let mut stop = self.state.shutdown.subscribe();
        let mut connections = JoinSet::new();
        let mut accept_error = None;
        loop {
            tokio::select! {
             _=shutdown_requested(&mut stop)=>break,
             accepted=self.listener.accept()=>match accepted{
              Ok((stream,_))=>{
               if connections.len()>=256{drop(stream);continue;}
               let state=self.state.clone();connections.spawn(async move{
                let mut shutdown=state.shutdown.subscribe();let io=TokioIo::new(TimedIo::new(stream,state.config.write_timeout));
                let service_state=state.clone();let service=service_fn(move|request:Request<Incoming>|{let state=service_state.clone();async move{Ok::<_,Infallible>(state.handle(request).await)}});
                let mut builder=hyper::server::conn::http1::Builder::new();builder.timer(TokioTimer::new()).header_read_timeout(state.config.header_timeout).max_buf_size(16*1024);
                let connection=builder.serve_connection(io,service);tokio::pin!(connection);
                tokio::select!{_=&mut connection=>{},_=shutdown_requested(&mut shutdown)=>{connection.as_mut().graceful_shutdown();let _=tokio::time::timeout(Duration::from_secs(5),&mut connection).await;}}
               });
              },Err(error)=>{accept_error=Some(error);break;}
             },
             Some(_)=connections.join_next(),if !connections.is_empty()=>{},
            }
        }
        self.state.shutdown.send_replace(true);
        // A pending HTTP provider probe owns a WorkTracker guard. Cancel it
        // before waiting for that guard; final shutdown alone would deadlock
        // this ordering until the probe's 90-second external deadline expired.
        let backend = self.state.backend.clone();
        let begin_error = run_dedicated("tepora-shutdown", move || backend.begin_shutdown())
            .await
            .err();
        while connections.join_next().await.is_some() {}
        // Dropping a HTTP future must not close SQLite while an authorized domain
        // mutation is still running on the blocking pool.
        while self.state.work.count.load(Ordering::Acquire) != 0 {
            self.state.work.finished.notified().await;
        }
        if let Some(error) = accept_error {
            return Err(ApiError::new(500, error.to_string()));
        }
        if let Some(error) = begin_error {
            return Err(error);
        }
        Ok(())
    }
}
/// Short lifecycle control and bounded long probes must not queue behind the
/// shared blocking pool that they may need to cancel or use for DNS. A dropped
/// receiver never cancels the thread or drops its captured effect/permit guards.
async fn run_dedicated<T: Send + 'static>(
    name: &'static str,
    work: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(work))
                .unwrap_or_else(|_| Err(ApiError::new(500, format!("{name} task panicked"))));
            let _ = sender.send(result);
        })
        .map_err(|error| ApiError::new(500, format!("Cannot start {name} task: {error}")))?;
    receiver
        .await
        .map_err(|_| ApiError::new(500, format!("{name} task stopped without a result")))?
}
async fn shutdown_requested(stop: &mut watch::Receiver<bool>) {
    if *stop.borrow() {
        return;
    }
    while stop.changed().await.is_ok() {
        if *stop.borrow() {
            return;
        }
    }
}
fn random_token() -> Result<String, ApiError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|e| ApiError::new(500, format!("Operating-system randomness failed: {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn constant_eq(left: &str, right: &str) -> bool {
    left.len() == right.len() && bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}
fn full(bytes: impl Into<Bytes>) -> ResponseBody {
    Full::new(bytes.into())
        .map_err(|never: Infallible| match never {})
        .boxed_unsync()
}
fn response(status: u16, content_type: &str, bytes: impl Into<Bytes>) -> Response<ResponseBody> {
    let mut r = Response::new(full(bytes));
    *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    set_header(&mut r, "content-type", content_type);
    r
}
fn set_header(response: &mut Response<ResponseBody>, name: &str, value: &str) {
    if let (Ok(name), Ok(value)) = (
        HeaderName::from_bytes(name.as_bytes()),
        HeaderValue::from_str(value),
    ) {
        response.headers_mut().insert(name, value);
    }
}
fn base_headers(response: &mut Response<ResponseBody>) {
    for (name, value) in [
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("x-frame-options", "DENY"),
        (
            "permissions-policy",
            "camera=(), microphone=(self), geolocation=()",
        ),
    ] {
        if !response.headers().contains_key(name) {
            set_header(response, name, value);
        }
    }
}
fn json_response(value: Value, status: u16) -> Response<ResponseBody> {
    let bytes = tepora_core::json_codec::stringify_js(&value)
        .unwrap_or_else(|_| "{\"error\":\"Response serialization failed\"}".into());
    let mut r = response(status, "application/json; charset=utf-8", bytes);
    set_header(&mut r, "cache-control", "no-store");
    r
}
fn safe_error(message: &str) -> String {
    static BEARER: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?i)Bearer[\s\u{feff}]+[^\s\u{feff}]+").unwrap());
    static KEY: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"sk-[A-Za-z0-9_-]+").unwrap());
    let redacted = BEARER.replace_all(message, "Bearer [redacted]");
    let redacted = KEY.replace_all(&redacted, "[redacted]");
    let units = redacted.encode_utf16().take(600).collect::<Vec<_>>();
    tepora_core::json_codec::from_utf16_units(&units)
}
fn error_response(error: ApiError) -> Response<ResponseBody> {
    let mut body = json!({"error":safe_error(&error.message)});
    if error.blocked {
        body["blocked"] = json!(true);
    }
    json_response(body, error.status)
}
fn field<'a>(headers: &'a hyper::HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|h| h.to_str().ok())
}
fn js_whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn js_number(raw: &str) -> f64 {
    let s = raw.trim_matches(js_whitespace);
    if s.is_empty() {
        return 0.0;
    }
    if matches!(s, "Infinity" | "+Infinity") {
        return f64::INFINITY;
    }
    if s == "-Infinity" {
        return f64::NEG_INFINITY;
    }
    if s.len() > 2 {
        let (base, digits) = if s.starts_with("0x") || s.starts_with("0X") {
            (16, &s[2..])
        } else if s.starts_with("0b") || s.starts_with("0B") {
            (2, &s[2..])
        } else if s.starts_with("0o") || s.starts_with("0O") {
            (8, &s[2..])
        } else {
            (0, "")
        };
        if base != 0 {
            return digits
                .chars()
                .try_fold(0.0, |n, c| {
                    c.to_digit(base).map(|digit| n * base as f64 + digit as f64)
                })
                .unwrap_or(f64::NAN);
        }
    }
    static DECIMAL: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$").unwrap()
    });
    if DECIMAL.is_match(s) {
        s.parse().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}
fn query(url: &Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}
fn cursor(headers: &hyper::HeaderMap, url: &Url) -> Result<EventRequest, ApiError> {
    if headers.get_all("last-event-id").iter().count() > 1
        || headers.contains_key("last-event-id") && field(headers, "last-event-id").is_none()
    {
        return Err(ApiError::bad_request("Invalid event cursor"));
    }
    let header = field(headers, "last-event-id").filter(|s| !s.is_empty());
    let query_ = query(url, "since");
    let raw = header
        .or(query_.as_deref().filter(|s| !s.is_empty()))
        .unwrap_or("0");
    let n = js_number(raw);
    if !n.is_finite() || n < 0.0 || n > MAX_SAFE_INTEGER as f64 || n.fract() != 0.0 {
        return Err(ApiError::bad_request("Invalid event cursor"));
    }
    Ok(EventRequest {
        since: n as u64,
        reconnect: header.is_some(),
    })
}
fn raw_id(value: &str) -> bool {
    !value.is_empty() && !value.contains('/')
}
fn session_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[derive(Clone)]
struct ArtifactFrame;
impl HttpState {
    async fn backend_call<T: Send + 'static>(
        self: &Arc<Self>,
        work: impl FnOnce(Arc<dyn Backend>) -> Result<T, ApiError> + Send + 'static,
    ) -> Result<T, ApiError> {
        if *self.shutdown.borrow() {
            return Err(ApiError::unavailable("Service is closing"));
        }
        self.work.count.fetch_add(1, Ordering::AcqRel);
        let guard = WorkGuard(self.work.clone());
        let backend = self.backend.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            work(backend)
        })
        .await
        .map_err(|e| ApiError::new(500, format!("Domain task failed: {e}")))?
    }
    async fn domain(self: &Arc<Self>, op: Operation) -> Result<Reply, ApiError> {
        if matches!(&op,Operation::ModelCatalogRefresh|Operation::SetupScan|Operation::SetupSelect{..}|Operation::RuntimeDiscover) {
            if *self.shutdown.borrow(){return Err(ApiError::unavailable("Service is closing"));}
            let cancellation=crate::network::RequestCancellation::new();
            struct CancelSetupOnDrop(crate::network::RequestCancellation);
            impl Drop for CancelSetupOnDrop {fn drop(&mut self){self.0.cancel();}}
            let _cancel=CancelSetupOnDrop(cancellation.clone());
            let mut shutdown=self.shutdown.subscribe();
            self.work.count.fetch_add(1,Ordering::AcqRel);
            let _work=WorkGuard(self.work.clone());
            return tokio::select!{biased;
                _=shutdown_requested(&mut shutdown)=>Err(ApiError::unavailable("Service is closing")),
                result=self.backend.execute_setup(op,cancellation)=>result,
            };
        }
        if matches!(&op,Operation::SemanticIndex{..}|Operation::SemanticSearch{..}) {
            if *self.shutdown.borrow(){return Err(ApiError::unavailable("Service is closing"));}
            let cancellation=crate::network::RequestCancellation::new();
            struct CancelOnDrop(crate::network::RequestCancellation);
            impl Drop for CancelOnDrop {fn drop(&mut self){self.0.cancel();}}
            let _cancel=CancelOnDrop(cancellation.clone());
            let mut shutdown=self.shutdown.subscribe();
            self.work.count.fetch_add(1,Ordering::AcqRel);
            let _work=WorkGuard(self.work.clone());
            // No blocking thread is consumed while capability admission/I/O waits.
            return tokio::select!{biased;
                _=shutdown_requested(&mut shutdown)=>Err(ApiError::unavailable("Service is closing")),
                result=self.backend.execute_semantic(op,cancellation)=>result,
            };
        }
        if let Operation::ProviderProbe { id } = &op {
            let id = id.clone();
            let cancellation = self.backend.probe_cancellation();
            let mut shutdown = self.shutdown.subscribe();
            let permit = tokio::select! {
                biased;
                _ = shutdown_requested(&mut shutdown) => return Err(ApiError::unavailable("Service is closing")),
                error = cancellation.cancelled() => return Err(error.into()),
                permit = self.probes.clone().acquire_owned() => permit.map_err(|_| ApiError::unavailable("Provider probe admission is closed"))?,
            };
            if let Some(error) = cancellation.error() {
                return Err(error.into());
            }
            if *self.shutdown.borrow() {
                return Err(ApiError::unavailable("Service is closing"));
            }
            self.work.count.fetch_add(1, Ordering::AcqRel);
            let guard = WorkGuard(self.work.clone());
            let backend = self.backend.clone();
            return run_dedicated("tepora-provider-probe", move || {
                let _guard = guard;
                let _permit = permit;
                backend.execute_probe(id, cancellation)
            })
            .await;
        }
        self.backend_call(move |backend| backend.execute(op)).await
    }
    async fn handle<B>(self: Arc<Self>, request: Request<B>) -> Response<ResponseBody>
    where
        B: Body<Data = Bytes> + Unpin + Send + 'static,
        B::Error: std::fmt::Display + Send + Sync,
    {
        let mut response = match self.inner(request).await {
            Ok(response) => response,
            Err(error) => error_response(error),
        };
        base_headers(&mut response);
        if response.extensions().get::<ArtifactFrame>().is_some() {
            response.headers_mut().remove(header::X_FRAME_OPTIONS);
        }
        response
    }
    fn authorize<B>(&self, request: &Request<B>) -> Result<Url, ApiError> {
        let headers = request.headers();
        if headers.get_all(header::HOST).iter().count() != 1
            || field(headers, "host") != Some(self.host.as_str())
        {
            return Err(ApiError::new(403, "Invalid Host"));
        }
        if headers.get_all(header::ORIGIN).iter().count() > 1 {
            return Err(ApiError::new(403, "Cross-origin requests are not allowed"));
        }
        if let Some(origin) = headers.get(header::ORIGIN) {
            let origin = origin
                .to_str()
                .map_err(|_| ApiError::new(403, "Cross-origin requests are not allowed"))?;
            if !origin.is_empty() && origin != self.origin {
                return Err(ApiError::new(403, "Cross-origin requests are not allowed"));
            }
        }
        if field(headers, "sec-fetch-site") == Some("cross-site") {
            return Err(ApiError::new(403, "Cross-site requests are not allowed"));
        }
        let base =
            Url::parse(&self.origin).map_err(|_| ApiError::new(500, "Invalid service origin"))?;
        let url = base
            .join(&request.uri().to_string())
            .map_err(|_| ApiError::bad_request("Invalid request URL"))?;
        if request.method() == Method::GET && matches!(url.path(), "/health" | "/launch") {
            return Ok(url);
        }
        let cookie = headers
            .get_all(header::COOKIE)
            .iter()
            .map(|v| v.to_str())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| ApiError::new(401, "このアプリを起動したときのURLから開いてください。"))?
            .join("; ");
        let session = cookie
            .split(';')
            .map(str::trim)
            .find_map(|c| c.strip_prefix("tepora_session="));
        if !session.is_some_and(|s| constant_eq(s, &self.secret)) {
            return Err(ApiError::new(
                401,
                "このアプリを起動したときのURLから開いてください。",
            ));
        }
        if request.method() != Method::GET
            && request.method() != Method::HEAD
            && (headers.get_all("x-tepora-csrf").iter().count() != 1
                || !field(headers, "x-tepora-csrf").is_some_and(|s| constant_eq(s, &self.csrf)))
        {
            return Err(ApiError::new(403, "Invalid CSRF token"));
        }
        Ok(url)
    }
    async fn inner<B>(
        self: &Arc<Self>,
        request: Request<B>,
    ) -> Result<Response<ResponseBody>, ApiError>
    where
        B: Body<Data = Bytes> + Unpin + Send + 'static,
        B::Error: std::fmt::Display + Send + Sync,
    {
        let url = self.authorize(&request)?;
        let path = url.path();
        let method = request.method().clone();
        if path == "/health" && method == Method::GET {
            return Ok(json_response(json!({"ok":true,"version":VERSION}), 200));
        }
        if path == "/launch" && method == Method::GET {
            if !query(&url, "token").is_some_and(|token| constant_eq(&token, &self.secret)) {
                return Err(ApiError::new(403, "Launch token is invalid"));
            }
            let mut r = response(303, "text/plain; charset=utf-8", Bytes::new());
            set_header(
                &mut r,
                "set-cookie",
                &format!(
                    "tepora_session={}; HttpOnly; SameSite=Strict; Path=/",
                    self.secret
                ),
            );
            set_header(&mut r, "location", "/");
            set_header(&mut r, "cache-control", "no-store");
            return Ok(r);
        }
        if *self.shutdown.borrow() {
            return Err(ApiError::unavailable("Service is closing"));
        }
        if path == "/app.bundle.js" && method == Method::GET {
            let mut r = response(200, "text/javascript; charset=utf-8", self.bundle.clone());
            set_header(&mut r, "cache-control", "no-cache");
            return Ok(r);
        }
        if path == "/api/events" && method == Method::GET {
            if request.headers().contains_key("last-event-id")
                && field(request.headers(), "last-event-id").is_none()
            {
                return Err(ApiError::bad_request("Invalid event cursor"));
            }
            let event_request = cursor(request.headers(), &url)?;
            let (subscription, guard) = self
                .backend_call(move |backend| {
                    let subscription = backend.subscribe(event_request)?;
                    let guard = SubscriptionGuard {
                        backend,
                        id: subscription.id,
                    };
                    Ok((subscription, guard))
                })
                .await?;
            let mut r = Response::new(self.events(subscription, guard));
            set_header(&mut r, "content-type", "text/event-stream");
            set_header(&mut r, "cache-control", "no-cache, no-transform");
            set_header(&mut r, "connection", "keep-alive");
            return Ok(r);
        }
        if path.starts_with("/render/") && method == Method::GET {
            let version = query(&url, "v").map(|raw| {
                let n = js_number(&raw);
                if n.is_finite() && n >= 1.0 && n <= MAX_SAFE_INTEGER as f64 && n.fract() == 0.0 {
                    n as u64
                } else {
                    u64::MAX
                }
            });
            return match self
                .domain(Operation::RenderArtifact {
                    id: path[8..].into(),
                    version,
                })
                .await?
            {
                Reply::Render {
                    kind,
                    content,
                    interactive,
                } => Ok(render_artifact(&self.origin, &kind, &content, interactive)),
                _ => Err(ApiError::new(500, "Invalid artifact response")),
            };
        }
        if path == "/api/avatar/assets" && method == Method::GET {
            return self.json_operation(Operation::AvatarAssets, 200).await;
        }
        if path == "/api/avatar/assets" && method == Method::PUT {
            let filename = decode_photo_filename(field(request.headers(), "x-tepora-filename").unwrap_or(""));
            let kind = field(request.headers(), "x-tepora-asset-kind").unwrap_or("").to_owned();
            let bytes = self.read_asset_bytes(request.into_body(), crate::workspace::avatar_assets::MAX_ASSET_BYTES).await?;
            return self.json_operation(Operation::AvatarAssetAdd { kind, bytes, filename }, 200).await;
        }
        if let Some(suffix) = path.strip_prefix("/api/avatar/assets/") {
            let (id, tail) = suffix.split_once('/').unwrap_or((suffix, ""));
            if id.len()==36 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b==b'-') {
                if tail.is_empty() && suffix == id && method == Method::DELETE {
                    return self.json_operation(Operation::AvatarAssetDelete { id: id.into() }, 200).await;
                }
                if let Some(file) = tail.strip_prefix("files/").filter(|p| !p.is_empty()) {
                    if method == Method::GET || method == Method::HEAD {
                        return match self.domain(Operation::AvatarAssetRead { id: id.into(), path: decode_photo_filename(file) }).await? {
                            Reply::AvatarFile { bytes, mime } => {
                                let length = bytes.len();
                                let mut r = response(200, &mime, if method==Method::HEAD {Bytes::new()} else {Bytes::from(bytes)});
                                set_header(&mut r, "content-length", &length.to_string());
                                set_header(&mut r, "cache-control", "private, max-age=3600");
                                set_header(&mut r, "content-security-policy", "default-src 'none'; sandbox");
                                return Ok(r);
                            },
                            _ => Err(ApiError::new(500, "Invalid avatar file response")),
                        };
                    }
                }
            }
        }
        if path == "/api/frame" && method == Method::GET {
            return self.json_operation(Operation::Frame, 200).await;
        }
        if path == "/api/frame/photos" && method == Method::PUT {
            let filename = decode_photo_filename(field(request.headers(), "x-tepora-filename").unwrap_or(""));
            let bytes = self.read_asset_bytes(request.into_body(), crate::workspace::photo_frame::MAX_PHOTO_BYTES).await?;
            return self.json_operation(Operation::FrameAdd { bytes, filename }, 200).await;
        }
        if let Some(id) = path.strip_prefix("/api/frame/photos/").filter(|id| id.len()==36 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b==b'-')) {
            if method == Method::DELETE {
                return self.json_operation(Operation::FrameDelete { id: id.into() }, 200).await;
            }
            if method == Method::GET || method == Method::HEAD {
                return match self.domain(Operation::FrameRead { id: id.into() }).await? {
                    Reply::Photo { bytes, mime } => {
                        let length = bytes.len();
                        let mut r = response(200, &mime, if method==Method::HEAD {Bytes::new()} else {Bytes::from(bytes)});
                        set_header(&mut r, "content-length", &length.to_string());
                        set_header(&mut r, "cache-control", "private, max-age=3600");
                        set_header(&mut r, "content-security-policy", "default-src 'none'; sandbox");
                        Ok(r)
                    },
                    _ => Err(ApiError::new(500, "Invalid photo response")),
                };
            }
        }
        if let Some(route) = visual_route(&method, path) {
            let operation = match route {
                NativeAgentRoute::Ready(operation, _) => operation,
                NativeAgentRoute::Body(route, _) => {
                    route.operation(self.read_json(request.into_body()).await?)
                }
            };
            return self.json_operation(operation, 200).await;
        }
        if self.config.agent && method == Method::GET {
            if path=="/api/model-catalog" {
                let query=tepora_core::json_codec::encode_text(&query(&url,"q").unwrap_or_default());
                return self.json_operation(Operation::ModelCatalogSearch{query},200).await;
            }
            if let Some((id, action)) = path
                .strip_prefix("/api/agent/sessions/")
                .and_then(|rest| rest.split_once('/'))
                .filter(|(id, _)| session_id(id))
            {
                if action == "files" {
                    return self
                        .json_operation(Operation::SessionFiles { id: id.into() }, 200)
                        .await;
                }
                if action == "download" {
                    let selected = url
                        .query_pairs()
                        .find(|(key, _)| key == "path")
                        .map(|(_, value)| value.into_owned())
                        .unwrap_or_default();
                    return match self
                        .domain(Operation::SessionDownload {
                            id: id.into(),
                            path: tepora_core::json_codec::encode_text(&selected),
                        })
                        .await?
                    {
                        Reply::Download { bytes, disposition } => {
                            let mut reply =
                                response(200, "application/octet-stream", Bytes::from(bytes));
                            set_header(&mut reply, "content-disposition", &disposition);
                            set_header(&mut reply, "cache-control", "no-store");
                            Ok(reply)
                        }
                        _ => Err(ApiError::new(500, "Invalid download response")),
                    };
                }
            }
        }
        if self.config.agent {
            if let Some(route) = native_agent_route(&method, path) {
                let (operation, status) = match route {
                    NativeAgentRoute::Ready(operation, status) => (operation, status),
                    NativeAgentRoute::Body(route, status) => {
                        if matches!(route, NativeAgentBodyRoute::SetupInstall) {
                            self.backend_call(|backend| backend.setup_install_permitted())
                                .await?;
                        }
                        let body = self.read_json(request.into_body()).await?;
                        (route.operation(body), status)
                    }
                };
                return self.json_operation(operation, status).await;
            }
        }
        let mut status = 200;
        let mut export = false;
        let operation = match (method.as_str(), path) {
            ("GET", "/api/bootstrap") => Some(Operation::Bootstrap),
            ("GET", "/api/agent") => Some(Operation::Agent),
            ("GET", "/api/agent/dialogue") => Some(Operation::Dialogue),
            ("GET", "/api/agent/sessions") => Some(Operation::Sessions),
            ("GET", "/api/artifacts") => Some(Operation::Artifacts),
            ("GET", "/api/context/export") => {
                export = true;
                Some(Operation::Export)
            }
            ("GET", "/api/doctor") => Some(Operation::Doctor),
            _ => None,
        };
        if let Some(operation) = operation {
            let mut value = match self.domain(operation).await? {
                Reply::Json(value) => value,
                _ => return Err(ApiError::new(500, "Invalid JSON domain response")),
            };
            if path == "/api/bootstrap" {
                if !value.is_object() {
                    return Err(ApiError::new(500, "Invalid bootstrap snapshot"));
                }
                value["csrf"] = json!(self.csrf);
                value["version"] = json!(VERSION);
                value["preview"] = json!(false);
            }
            let mut r = json_response(value, status);
            if export {
                set_header(
                    &mut r,
                    "content-disposition",
                    "attachment; filename=\"tepora-context.json\"",
                );
            }
            return Ok(r);
        }
        if method == Method::GET {
            if let Some(id) = path
                .strip_prefix("/api/agent/sessions/")
                .filter(|id| session_id(id))
            {
                let before = query(&url, "before")
                    .map(|s| js_number(&s))
                    .filter(|n| *n != 0.0 && !n.is_nan());
                let raw_limit = query(&url, "limit")
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "150".into());
                let n = js_number(&raw_limit);
                let limit = if n.is_nan() { f64::NAN } else { n.min(500.0) };
                return self
                    .json_operation(
                        Operation::Session {
                            id: id.into(),
                            before,
                            limit,
                        },
                        200,
                    )
                    .await;
            }
            if let Some(rest) = path.strip_prefix("/api/artifacts/") {
                if let Some((id, suffix)) = rest.split_once("/revisions") {
                    if raw_id(id)
                        && (suffix.is_empty()
                            || suffix.starts_with('/')
                                && suffix[1..].bytes().all(|b| b.is_ascii_digit())
                                && !suffix[1..].is_empty())
                    {
                        let version = if suffix.is_empty() {
                            None
                        } else {
                            Some(suffix[1..].parse::<u64>().unwrap_or(u64::MAX))
                        };
                        return self
                            .json_operation(
                                Operation::ArtifactRevisions {
                                    id: id.into(),
                                    version,
                                },
                                200,
                            )
                            .await;
                    }
                }
            }
        }
        enum BodyRoute {
            Inputs,
            MemoryCreate,
            MemoryPatch(String),
            ArtifactEdit(String),
            Import,
            Presence,
        }
        let body_route = match (method.as_str(), path) {
            ("POST", "/api/memories") => {
                status = 201;
                Some(BodyRoute::MemoryCreate)
            }
            ("POST", "/api/context/import") => Some(BodyRoute::Import),
            ("POST", "/api/inputs") => {
                status = 201;
                Some(BodyRoute::Inputs)
            }
            ("POST", "/api/presence") => Some(BodyRoute::Presence),
            _ => {
                if method == Method::PATCH {
                    if let Some(id) = path.strip_prefix("/api/memories/").filter(|id| raw_id(id)) {
                        Some(BodyRoute::MemoryPatch(id.into()))
                    } else {
                        path.strip_prefix("/api/artifacts/")
                            .filter(|id| raw_id(id))
                            .map(|id| BodyRoute::ArtifactEdit(id.into()))
                    }
                } else {
                    None
                }
            }
        };
        if let Some(route) = body_route {
            let body = self.read_json(request.into_body()).await?;
            let op = match route {
                BodyRoute::Inputs => Operation::InputsStage { body },
                BodyRoute::MemoryCreate => Operation::MemoryCreate { body },
                BodyRoute::MemoryPatch(id) => Operation::MemoryPatch { id, body },
                BodyRoute::ArtifactEdit(id) => Operation::ArtifactEdit { id, body },
                BodyRoute::Import => Operation::Import { body },
                BodyRoute::Presence => Operation::Presence { body },
            };
            return self.json_operation(op, status).await;
        }
        if method == Method::DELETE {
            if let Some(id) = path.strip_prefix("/api/inputs/").filter(|id| raw_id(id)) {
                return self
                    .json_operation(Operation::InputDelete { id: id.into() }, 200)
                    .await;
            }
            if let Some(id) = path.strip_prefix("/api/memories/").filter(|id| raw_id(id)) {
                return self
                    .json_operation(Operation::MemoryDelete { id: id.into() }, 200)
                    .await;
            }
        }
        if path.starts_with("/api/") {
            if known_unavailable(&method, path) {
                return Err(ApiError::unavailable("This operation is unavailable in the developmental native workspace; its adapter has not been migrated."));
            }
            return Err(ApiError::new(404, "Unknown endpoint or HTTP method"));
        }
        if method != Method::GET && method != Method::HEAD {
            return Err(ApiError::new(405, "Method not allowed"));
        }
        let relative = static_asset(path).ok_or_else(|| ApiError::new(404, "Not found"))?;
        let bytes = tokio::fs::read(self.config.web_dir.join(relative))
            .await
            .map_err(|e| ApiError::new(500, format!("Static asset is unavailable: {e}")))?;
        let mut r = response(
            200,
            mime(relative),
            if method == Method::HEAD {
                Bytes::new()
            } else {
                Bytes::from(bytes)
            },
        );
        set_header(&mut r, "cache-control", "no-cache");
        set_header(&mut r, "content-security-policy", APP_CSP);
        Ok(r)
    }
    async fn json_operation(
        self: &Arc<Self>,
        operation: Operation,
        status: u16,
    ) -> Result<Response<ResponseBody>, ApiError> {
        match self.domain(operation).await? {
            Reply::Json(value) => Ok(json_response(value, status)),
            _ => Err(ApiError::new(500, "Invalid JSON domain response")),
        }
    }
    async fn read_asset_bytes<B>(&self, mut body: B, max_bytes: usize) -> Result<Vec<u8>, ApiError>
    where B: Body<Data=Bytes> + Unpin, B::Error: std::fmt::Display {
        tokio::time::timeout(self.config.body_timeout, async {
            let mut bytes=Vec::new();
            while let Some(frame)=body.frame().await {
                let frame=frame.map_err(|_|ApiError::bad_request("Invalid request body"))?;
                if let Ok(data)=frame.into_data() {
                    if bytes.len().saturating_add(data.len())>max_bytes {return Err(ApiError::new(413,"ファイルが大きすぎます。"));}
                    bytes.extend_from_slice(&data);
                }
            }
            Ok(bytes)
        }).await.map_err(|_|ApiError::new(408,"Request body timed out"))?
    }
    async fn read_json<B>(&self, mut body: B) -> Result<Value, ApiError>
    where
        B: Body<Data = Bytes> + Unpin,
        B::Error: std::fmt::Display,
    {
        let bytes = tokio::time::timeout(self.config.body_timeout, async {
            let mut bytes = BytesMut::new();
            while let Some(frame) = body.frame().await {
                let frame = frame.map_err(|_| ApiError::bad_request("Invalid request body"))?;
                if let Ok(data) = frame.into_data() {
                    if bytes.len().saturating_add(data.len()) > BODY_LIMIT {
                        return Err(ApiError::new(413, "Request body too large"));
                    }
                    bytes.extend_from_slice(&data);
                }
            }
            Ok::<_, ApiError>(bytes)
        })
        .await
        .map_err(|_| ApiError::new(408, "Request body timed out"))??;
        if bytes.is_empty() {
            return Ok(json!({}));
        }
        let source = String::from_utf8_lossy(&bytes);
        tepora_core::json_codec::parse(&source)
            .map_err(|_| ApiError::bad_request("Invalid JSON body"))
    }
    fn events(&self, subscription: EventSubscription, guard: SubscriptionGuard) -> ResponseBody {
        let mut shutdown = self.shutdown.subscribe();
        let heartbeat = self.config.heartbeat;
        let stream = async_stream::try_stream! {
         let _guard=guard;let mut receiver=subscription.receiver;
         for event in subscription.initial{if let Some(bytes)=event_frame(&event)?{yield Frame::data(bytes);}}
         let mut interval=tokio::time::interval_at(Instant::now()+heartbeat,heartbeat);interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
         loop{
          let next=tokio::select!{biased;
           _=shutdown_requested(&mut shutdown)=>SseNext::Close,
           event=receiver.recv()=>SseNext::Event(event),
           _=interval.tick()=>SseNext::Heartbeat,
          };
          match next{SseNext::Close|SseNext::Event(None)=>break,
           SseNext::Event(Some(event))=>{if let Some(bytes)=event_frame(&event)?{yield Frame::data(bytes);}},
           SseNext::Heartbeat=>yield Frame::data(Bytes::from_static(b": heartbeat\n\n")),
          }
         }
        };
        StreamBody::new(stream).boxed_unsync()
    }
}
enum NativeAgentRoute {
    Ready(Operation, u16),
    Body(NativeAgentBodyRoute, u16),
}
enum NativeAgentBodyRoute {
    Display(crate::workspace::VisualAction),
    Avatar(crate::workspace::VisualAction),
    ModelCatalogImport,
    SetupSelect,
    SetupInstall,
    DialoguePersonas,
    Preferences,
    SearchKey,
    Input,
    Spawn,
    Message(String),
    Settings,
    Approvals,
    Approval(String),
    Capabilities,
    CapabilityKey(String),
    Providers,
    ProviderKey(String),
    ProviderProbe(String),
    SemanticIndex,
    SemanticSearch,
    Network,
}
impl NativeAgentBodyRoute {
    fn operation(self, body: Value) -> Operation {
        match self {
            Self::Display(action) => Operation::Display { action, body },
            Self::Avatar(action) => Operation::Avatar { action, body },
            Self::ModelCatalogImport=>Operation::ModelCatalogImport{body},
            Self::SetupSelect=>Operation::SetupSelect{body},
            Self::SetupInstall=>Operation::SetupInstall{body},
            Self::DialoguePersonas => Operation::DialoguePersonasSave { body },
            Self::Preferences => Operation::SettingsPatch { body },
            Self::SearchKey => Operation::SearchKey { body },
            Self::Input => Operation::AgentInput { body },
            Self::Spawn => Operation::AgentSpawn { body },
            Self::Message(id) => Operation::SessionMessage { id, body },
            Self::Settings => Operation::AgentSettingsPatch { body },
            Self::Approvals => Operation::ApprovalsDecide { body },
            Self::Approval(id) => Operation::ApprovalDecide { id, body },
            Self::Capabilities => Operation::CapabilitiesSave { body },
            Self::CapabilityKey(id) => Operation::CapabilityKey { id, body },
            Self::Providers => Operation::ProvidersSave { body },
            Self::ProviderKey(id) => Operation::ProviderKey { id, body },
            Self::ProviderProbe(id) => Operation::ProviderProbe { id },
            Self::SemanticIndex=>Operation::SemanticIndex{body},
            Self::SemanticSearch=>Operation::SemanticSearch{body},
            Self::Network => Operation::NetworkPatch { body },
        }
    }
}
/// This is an explicit finite route table, not an arbitrary agent command proxy.
/// Identity, capabilities, revisions and argument validation stay in Workspace.
fn visual_route(method: &Method, path: &str) -> Option<NativeAgentRoute> {
    use crate::workspace::VisualAction as Action;
    let (avatar, action) = match (method.as_str(), path) {
        ("GET", "/api/display") => (false, Action::Get),
        ("PATCH", "/api/display") => (false, Action::Change),
        ("POST", "/api/display/undo") => (false, Action::Undo),
        ("POST", "/api/display/reset") => (false, Action::Reset),
        ("GET", "/api/display/export") => (false, Action::Export),
        ("POST", "/api/display/import") => (false, Action::Import),
        ("GET", "/api/avatar") => (true, Action::Get),
        ("PATCH", "/api/avatar") => (true, Action::Change),
        ("POST", "/api/avatar/undo") => (true, Action::Undo),
        ("POST", "/api/avatar/reset") => (true, Action::Reset),
        ("GET", "/api/avatar/export") => (true, Action::Export),
        ("POST", "/api/avatar/import") => (true, Action::Import),
        _ => return None,
    };
    Some(if method == Method::GET {
        NativeAgentRoute::Ready(if avatar {
            Operation::Avatar { action, body: Value::Null }
        } else {
            Operation::Display { action, body: Value::Null }
        }, 200)
    } else {
        NativeAgentRoute::Body(if avatar {
            NativeAgentBodyRoute::Avatar(action)
        } else {
            NativeAgentBodyRoute::Display(action)
        }, 200)
    })
}
fn native_agent_route(method: &Method, path: &str) -> Option<NativeAgentRoute> {
    use NativeAgentBodyRoute as Body;
    use NativeAgentRoute::{Body as Json, Ready};
    match (method.as_str(), path) {
        ("POST","/api/model-catalog/import")=>return Some(Json(Body::ModelCatalogImport,200)),
        ("POST","/api/model-catalog/refresh")=>return Some(Ready(Operation::ModelCatalogRefresh,200)),
        ("GET","/api/setup")=>return Some(Ready(Operation::Setup,200)),
        ("POST","/api/setup/scan")=>return Some(Ready(Operation::SetupScan,200)),
        ("POST","/api/setup/dismiss")=>return Some(Ready(Operation::SetupDismiss,200)),
        ("POST","/api/setup/select")=>return Some(Json(Body::SetupSelect,200)),
        ("POST","/api/setup/install")=>return Some(Json(Body::SetupInstall,202)),
        ("POST","/api/setup/stop")=>return Some(Ready(Operation::SetupStop,200)),
        ("POST","/api/setup/install-help")=>return Some(Ready(Operation::SetupInstallHelp,200)),
        ("POST","/api/runtime/discover")=>return Some(Ready(Operation::RuntimeDiscover,200)),
        ("GET", "/api/dialogue/personas") => return Some(Ready(Operation::DialoguePersonas, 200)),
        ("PUT", "/api/dialogue/personas") => return Some(Json(Body::DialoguePersonas, 200)),
        ("PATCH", "/api/settings") => return Some(Json(Body::Preferences, 200)),
        ("POST", "/api/semantic/index")=>return Some(Json(Body::SemanticIndex,200)),
        ("POST", "/api/semantic/search")=>return Some(Json(Body::SemanticSearch,200)),
        ("POST", "/api/agent/input") => return Some(Json(Body::Input, 202)),
        ("PUT", "/api/agent/search-key") => return Some(Json(Body::SearchKey, 200)),
        ("POST", "/api/agent/spawn") => return Some(Json(Body::Spawn, 202)),
        ("GET", "/api/agent/settings") => return Some(Ready(Operation::AgentSettings, 200)),
        ("PATCH", "/api/agent/settings") => return Some(Json(Body::Settings, 200)),
        ("GET", "/api/agent/approvals") => return Some(Ready(Operation::Approvals, 200)),
        ("POST", "/api/agent/approvals") => return Some(Json(Body::Approvals, 200)),
        ("GET", "/api/capabilities") => return Some(Ready(Operation::Capabilities, 200)),
        ("PUT", "/api/capabilities") => return Some(Json(Body::Capabilities, 200)),
        ("GET", "/api/providers") => return Some(Ready(Operation::Providers, 200)),
        ("PUT", "/api/providers") => return Some(Json(Body::Providers, 200)),
        ("GET", "/api/network") => return Some(Ready(Operation::Network, 200)),
        ("PATCH", "/api/network") => return Some(Json(Body::Network, 200)),
        ("POST", "/api/stop") => return Some(Ready(Operation::StopAll, 200)),
        _ => {}
    }
    if method == Method::DELETE {
        if let Some(id) = path.strip_prefix("/api/agent/sessions/").filter(|id| session_id(id)) {
            return Some(Ready(Operation::SessionDelete { id: id.into() }, 200));
        }
    }
    if method != Method::POST {
        return None;
    }
    if let Some((id, action)) = path
        .strip_prefix("/api/agent/sessions/")
        .and_then(|rest| rest.split_once('/'))
        .filter(|(id, _)| session_id(id))
    {
        return match action {
            "message" => Some(Json(Body::Message(id.into()), 202)),
            "stop" => Some(Ready(Operation::SessionStop { id: id.into() }, 200)),
            "resume" => Some(Ready(Operation::SessionResume { id: id.into() }, 200)),
            "accept" => Some(Ready(Operation::SessionAccept { id: id.into() }, 200)),
            _ => None,
        };
    }
    if let Some(id) = path
        .strip_prefix("/api/agent/approvals/")
        .filter(|id| session_id(id))
    {
        return Some(Json(Body::Approval(id.into()), 200));
    }
    // Capability IDs are captured exactly as the source's [^/]+ path group.
    // Saved-profile/identity validation belongs to the shared owner; never URL
    // decode an encoded slash into a different profile authority.
    if let Some(id) = path
        .strip_prefix("/api/capabilities/")
        .and_then(|rest| rest.strip_suffix("/key"))
        .filter(|id| !id.is_empty() && !id.contains('/'))
    {
        return Some(Json(Body::CapabilityKey(id.into()), 200));
    }
    if let Some((id, action)) = path
        .strip_prefix("/api/providers/")
        .and_then(|rest| rest.split_once('/'))
        .filter(|(id, _)| session_id(id))
    {
        return match action {
            "key" => Some(Json(Body::ProviderKey(id.into()), 200)),
            "probe" => Some(Json(Body::ProviderProbe(id.into()), 200)),
            _ => None,
        };
    }
    None
}
enum SseNext {
    Close,
    Event(Option<ServiceEvent>),
    Heartbeat,
}
struct SubscriptionGuard {
    backend: Arc<dyn Backend>,
    id: u64,
}
impl Drop for SubscriptionGuard {
    fn drop(&mut self) {
        self.backend.unsubscribe(self.id);
    }
}
fn internal_event(kind: &str) -> bool {
    matches!(
        kind,
        "session.entry"
            | "session.inbox"
            | "agent.delta"
            | "agent.event"
            | "agent.reply"
            | "agent.compaction"
            | "agent.finished"
    )
}
fn event_frame(event: &ServiceEvent) -> Result<Option<Bytes>, io::Error> {
    if internal_event(&event.event_type) {
        return Ok(None);
    }
    let json = tepora_core::json_codec::stringify_js(&event.value())
        .map_err(|e| io::Error::other(e.to_string()))?;
    let prefix = event
        .seq
        .map(|seq| format!("id: {seq}\n"))
        .unwrap_or_default();
    Ok(Some(Bytes::from(format!("{prefix}data: {json}\n\n"))))
}
fn render_artifact(
    origin: &str,
    kind: &str,
    encoded_content: &str,
    interactive: bool,
) -> Response<ResponseBody> {
    let content = tepora_core::json_codec::sql_text(encoded_content);
    let content = if kind == "html" && interactive {
        content
    } else {
        let escaped = content
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;");
        format!("<!doctype html><meta charset=\"utf-8\"><body style=\"font:16px/1.8 system-ui;padding:30px;background:#faf6ee;color:#42372b;white-space:pre-wrap;overflow-wrap:anywhere\">{escaped}")
    };
    let csp=format!("default-src 'none'; script-src {}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors {origin}; sandbox{}",if interactive{"'unsafe-inline'"}else{"'none'"},if interactive{" allow-scripts"}else{""});
    let mut r = response(200, "text/html; charset=utf-8", content);
    set_header(&mut r, "cache-control", "no-store");
    set_header(&mut r, "content-security-policy", &csp);
    r.extensions_mut().insert(ArtifactFrame);
    r
}

fn static_asset(path: &str) -> Option<&str> {
    const ALLOWED: &[&str] = &[
        "/index.html",
        "/styles.css",
        "/avatar.css",
        "/app.mjs",
        "/ui.mjs",
        "/bridge.mjs",
        "/voice.mjs",
        "/draft.mjs",
        "/realtime-voice.mjs",
        "/onboarding.mjs",
        "/provider-settings.mjs",
        "/capability-ui.mjs",
        "/pcm-worklet.js",
        "/display-model.mjs",
        "/demo.mjs",
        "/favicon.svg",
        "/vrm-stage.mjs",
        "/mesh-avatar.mjs",
        "/three-body.mjs",
        "/vendor/three.core.js",
        "/vendor/three.module.js",
        "/vendor/GLTFLoader.js",
        "/vendor/BufferGeometryUtils.js",
        "/vendor/SkeletonUtils.js",
        "/vendor/three-vrm.module.min.js",
        "/vendor/mesh-avatar/createMeshAvatar.js",
        "/vendor/mesh-avatar/renderer.js",
        "/vendor/mesh-avatar/rig.js",
        "/vendor/mesh-avatar/motion.js",
        "/vendor/mesh-avatar/motions.js",
        "/vendor/mesh-avatar/physics.js",
        "/vendor/mesh-avatar/sprites.js",
        "/vendor/mesh-avatar/kana.js",
    ];
    if path == "/" {
        Some("index.html")
    } else if ALLOWED.contains(&path) {
        Some(&path[1..])
    } else {
        None
    }
}
fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "mjs" | "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}
fn known_unavailable(method: &Method, path: &str) -> bool {
    static ROUTES: LazyLock<Vec<(&'static str, regex::Regex)>> = LazyLock::new(|| {
        [
  ("GET",r"^/api/(?:agent/(?:settings|policy|approvals)|dialogue/personas|display(?:/export)?|avatar(?:/export|/assets)?|frame|providers|network|setup|model-catalog|capabilities|media/jobs|computer)$"),
  ("PATCH",r"^/api/(?:agent/settings|settings|display|avatar|network|computer|skills/[^/]+|mcp/[^/]+)$"),
  ("PUT",r"^/api/(?:agent/search-key|dialogue/personas|avatar/assets|frame/photos|providers|capabilities)$"),
  ("POST",r"^/api/(?:agent/(?:input|spawn|policy/revert|dream|plugins/reload|approvals(?:/[\w-]+)?)|stop|display/(?:undo|reset|import)|avatar/(?:undo|reset|import)|skills|shared/scan|inputs|providers/[\w-]+/(?:key|probe)|runtime/discover|setup/(?:install-help|scan|dismiss|select|install|stop)|model-catalog/(?:import|refresh)|capabilities/[^/]+/key|semantic/(?:index|search)|media/(?:jobs|embed|open)|connector/(?:weather|news)|mcp|tools/(?:import/(?:preview|apply)|connect/(?:preview|apply)|search|[^/]+/discover)|computer/(?:windows|status|release)|voice/(?:start|chunk|finish|cancel|edit|transcribe))$"),
  ("POST",r"^/api/agent/sessions/[A-Za-z0-9_-]+/(?:message|stop|resume|accept)$"),
  ("GET",r"^/api/agent/sessions/[A-Za-z0-9_-]+/(?:files|download)$"),
  ("DELETE",r"^/api/agent/sessions/[A-Za-z0-9_-]+$"),
  ("DELETE",r"^/api/(?:inputs|skills|mcp)/[^/]+$"),
  ("DELETE",r"^/api/(?:avatar/assets|frame/photos)/[a-f0-9-]{36}$"),
  ("GET",r"^/api/(?:avatar/assets/[a-f0-9-]{36}/files/.+|frame/photos/[a-f0-9-]{36}|media/assets/[a-f0-9-]{36})$"),
  ("HEAD",r"^/api/(?:avatar/assets/[a-f0-9-]{36}/files/.+|frame/photos/[a-f0-9-]{36}|media/assets/[a-f0-9-]{36})$"),
  ("POST",r"^/api/media/jobs/[a-f0-9]{64}/(?:cancel|resume)$"),
  ("DELETE",r"^/api/media/jobs/[a-f0-9]{64}$"),
 ].into_iter().map(|(method,pattern)|(method,regex::Regex::new(pattern).unwrap())).collect()
    });
    ROUTES
        .iter()
        .any(|(verb, pattern)| method.as_str() == *verb && pattern.is_match(path))
}
/// Bound a socket which stops accepting response bytes. The backend's bounded
/// event queue and this write deadline prevent unbounded slow-SSE buffering.
struct TimedIo<T> {
    stream: T,
    write_timeout: Duration,
    blocked: Option<Pin<Box<Sleep>>>,
}
impl<T> TimedIo<T> {
    fn new(stream: T, write_timeout: Duration) -> Self {
        Self {
            stream,
            write_timeout,
            blocked: None,
        }
    }
    fn blocked(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        use std::future::Future;
        if self.blocked.is_none() {
            self.blocked = Some(Box::pin(tokio::time::sleep(self.write_timeout)));
        }
        if self.blocked.as_mut().unwrap().as_mut().poll(cx).is_ready() {
            Poll::Ready(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Response consumer stopped reading",
            )))
        } else {
            Poll::Pending
        }
    }
}
impl<T: AsyncRead + Unpin> AsyncRead for TimedIo<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}
impl<T: AsyncWrite + Unpin> AsyncWrite for TimedIo<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        match Pin::new(&mut self.stream).poll_write(cx, bytes) {
            Poll::Ready(result) => {
                self.blocked = None;
                Poll::Ready(result)
            }
            Poll::Pending => self.blocked(cx).map(|r| r.map(|_| 0)),
        }
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match Pin::new(&mut self.stream).poll_flush(cx) {
            Poll::Ready(result) => {
                self.blocked = None;
                Poll::Ready(result)
            }
            Poll::Pending => self.blocked(cx),
        }
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tokio::sync::mpsc;
    include!("http/visual_tests.rs");
    include!("http/semantic_tests.rs");
    #[tokio::test]
    async fn preference_routes_keep_explicit_native_mode_auth_methods_and_codec() {
        let fake=Arc::new(Fake::default());let active=agent_state(fake.clone());
        for (method,path,variant) in [("GET","/api/dialogue/personas","DialoguePersonas"),("PUT","/api/dialogue/personas","DialoguePersonasSave"),("PATCH","/api/settings","SettingsPatch")] {
            let mut denied=request(method,path,"{bad");denied.headers_mut().remove("cookie");
            assert_eq!(active.clone().handle(denied).await.status(),401);
            assert_eq!(state(fake.clone()).handle(request(method,path,"{bad")).await.status(),503);
            let response=active.clone().handle(request(method,path,r#"{"companion":"x\ud800\ue000","expectedRevision":0}"#)).await;
            assert_eq!(response.status(),200);
            assert!(format!("{:?}",fake.calls.lock().unwrap().last().unwrap()).starts_with(variant));
            if method!="GET" {let value=bytes(response).await;let value=tepora_core::json_codec::parse(std::str::from_utf8(&value).unwrap()).unwrap();assert_eq!(value["companion"],tepora_core::json_codec::parse(r#""x\ud800\ue000""#).unwrap());}
        }
        let count=fake.calls.lock().unwrap().len();
        for (method,path) in [("POST","/api/dialogue/personas"),("PATCH","/api/dialogue/personas"),("PUT","/api/settings"),("GET","/api/settings")] {assert_eq!(active.clone().handle(request(method,path,"{}")).await.status(),404);}
        let mut denied=request("PUT","/api/dialogue/personas","{bad");denied.headers_mut().remove("x-tepora-csrf");assert_eq!(active.clone().handle(denied).await.status(),403);
        assert_eq!(fake.calls.lock().unwrap().len(),count);
    }


    #[tokio::test(flavor="multi_thread",worker_threads=2)]
    async fn preference_http_persona_change_refreshes_the_real_actor_without_replacing_cached_prefix() {
        use crate::workspace::Workspace;
        use tepora_core::json_codec;
        let dir=std::env::temp_dir().join(format!("tepora-preference-http-{}",uuid::Uuid::new_v4()));
        let workspace=Arc::new(Workspace::open(&dir).unwrap());
        workspace.enable_agent(tokio::runtime::Handle::current()).unwrap();
        let access=workspace.access();let main=access.agent_state("main",json!({})).unwrap();let id=main["id"].as_str().unwrap();
        access.agent_state("session.update",json!({"id":id,"patch":{"system":"stable cached prefix","tools":[],"status":"idle"}})).unwrap();
        let mut http=agent_state(Arc::new(Fake::default()));Arc::get_mut(&mut http).unwrap().backend=workspace.clone();
        let response=http.clone().handle(request("PUT","/api/dialogue/personas",r#"{"expectedRevision":0,"character":{"name":"Fixture Persona","instructions":"Use a short response.","allowNetwork":true}}"#)).await;
        assert_eq!(response.status(),200);let output=bytes(response).await;let output=json_codec::parse(std::str::from_utf8(&output).unwrap()).unwrap();
        assert_eq!(output["revision"],1);assert!(output["character"].get("allowNetwork").is_none());
        let updated=access.agent_state("session.get",json!({"id":id})).unwrap();
        assert_eq!(updated["system"],"stable cached prefix");assert_eq!(updated["tools"],json!([]));assert_eq!(updated["promptStale"],true);
        assert!(updated["announced"]["system"].as_str().unwrap().contains("Fixture Persona"));
        let entries=access.agent_state("session.tail",json!({"id":id,"limit":20})).unwrap();
        assert!(entries.as_array().unwrap().iter().any(|entry|entry["type"]=="notice"&&entry["promptUpdate"]==true&&entry["text"].as_str().is_some_and(|text|text.contains("Fixture Persona"))));
        let settings=http.clone().handle(request("PATCH","/api/settings",r#"{"companion":"Updated companion","allowNetwork":false,"permissions":"allow"}"#)).await;
        assert_eq!(settings.status(),200);let body=bytes(settings).await;let body=json_codec::parse(std::str::from_utf8(&body).unwrap()).unwrap();assert_eq!(body["allowNetwork"],false);assert!(body.get("permissions").is_none());
        assert_eq!(http.clone().handle(request("PUT","/api/dialogue/personas",r#"{"expectedRevision":0}"#)).await.status(),409);
        let closing=workspace.clone();tokio::task::spawn_blocking(move||closing.shutdown()).await.unwrap().unwrap();
        drop(http);drop(access);drop(workspace);std::fs::remove_dir_all(dir).unwrap();
    }

    #[derive(Default)]
    struct Fake {
        calls: Mutex<Vec<Operation>>,
        sender: Mutex<Option<mpsc::Sender<ServiceEvent>>>,
        initial: Mutex<Vec<ServiceEvent>>,
        unsubscribed: AtomicUsize,
    }
    impl Backend for Fake {
        fn execute(&self, op: Operation) -> Result<Reply, ApiError> {
            self.calls.lock().unwrap().push(op.clone());
            Ok(match op {
                Operation::MemoryCreate { body }
                | Operation::Display { body, .. }
                | Operation::Avatar { body, .. }
                | Operation::DialoguePersonasSave { body }
                | Operation::SettingsPatch { body }
                | Operation::Presence { body }
                | Operation::Import { body }
                | Operation::AgentInput { body }
                | Operation::AgentSpawn { body }
                | Operation::SessionMessage { body, .. }
                | Operation::AgentSettingsPatch { body }
                | Operation::ApprovalsDecide { body }
                | Operation::ApprovalDecide { body, .. }
                | Operation::CapabilitiesSave { body }
                | Operation::CapabilityKey { body, .. }
                | Operation::ProvidersSave { body }
                | Operation::ProviderKey { body, .. }
                | Operation::NetworkPatch { body } => Reply::Json(body),
                Operation::Session { id, .. } => Reply::Json(json!({"id":id})),
                Operation::RenderArtifact { .. } => Reply::Render {
                    kind: "html".into(),
                    content: "<h1>ok</h1>".into(),
                    interactive: false,
                },
                _ => Reply::Json(json!({})),
            })
        }
        fn subscribe(&self, _: EventRequest) -> Result<EventSubscription, ApiError> {
            let (tx, rx) = mpsc::channel(2);
            *self.sender.lock().unwrap() = Some(tx);
            Ok(EventSubscription {
                id: 1,
                initial: self.initial.lock().unwrap().clone(),
                receiver: rx,
            })
        }
        fn unsubscribe(&self, _: u64) {
            self.sender.lock().unwrap().take();
            self.unsubscribed.fetch_add(1, Ordering::SeqCst);
        }
        fn stop(&self) -> Result<(), ApiError> {
            Ok(())
        }
        fn shutdown(&self) -> Result<(), ApiError> {
            Ok(())
        }
    }
    fn state(fake: Arc<Fake>) -> Arc<HttpState> {
        let (shutdown, _) = watch::channel(false);
        let mut config = HttpConfig::new(PathBuf::new(), PathBuf::new());
        config.body_timeout = Duration::from_millis(20);
        config.heartbeat = Duration::from_millis(10);
        Arc::new(HttpState {
            backend: fake,
            config,
            origin: "http://127.0.0.1:4321".into(),
            host: "127.0.0.1:4321".into(),
            secret: "a".repeat(64),
            csrf: "b".repeat(64),
            bundle: Bytes::from_static(b"window.test=1;"),
            shutdown,
            work: Arc::new(WorkTracker::default()),
            probes: Arc::new(Semaphore::new(4)),
        })
    }
    fn request(method: &str, path: &str, body: impl Into<Bytes>) -> Request<Full<Bytes>> {
        Request::builder()
            .method(method)
            .uri(path)
            .header("host", "127.0.0.1:4321")
            .header(
                "cookie",
                format!("other=x; tepora_session={}", "a".repeat(64)),
            )
            .header("x-tepora-csrf", "b".repeat(64))
            .body(Full::new(body.into()))
            .unwrap()
    }
    fn agent_state(fake: Arc<Fake>) -> Arc<HttpState> {
        let mut state = state(fake);
        Arc::get_mut(&mut state).unwrap().config.agent = true;
        state
    }
    async fn bytes(r: Response<ResponseBody>) -> Bytes {
        r.into_body().collect().await.unwrap().to_bytes()
    }
    #[tokio::test]
    async fn auth_order_method_distinctions_and_headers() {
        let s = state(Arc::new(Fake::default()));
        let mut r = request("GET", "/health", Bytes::new());
        r.headers_mut().remove("cookie");
        assert_eq!(s.clone().handle(r).await.status(), 200);
        let mut r = request("GET", "/health", Bytes::new());
        r.headers_mut()
            .insert("host", HeaderValue::from_static("localhost:4321"));
        assert_eq!(s.clone().handle(r).await.status(), 403);
        let mut r = request("GET", "/health", Bytes::new());
        r.headers_mut().insert(
            "origin",
            HeaderValue::from_static("https://external.invalid"),
        );
        assert_eq!(s.clone().handle(r).await.status(), 403);
        let mut r = request("GET", "/api/bootstrap", Bytes::new());
        r.headers_mut().remove("cookie");
        let r = s.clone().handle(r).await;
        assert_eq!(r.status(), 401);
        assert_eq!(r.headers()["x-frame-options"], "DENY");
        assert_eq!(r.headers()["cache-control"], "no-store");
        let mut r = request("POST", "/unknown", Bytes::new());
        r.headers_mut().remove("x-tepora-csrf");
        assert_eq!(s.clone().handle(r).await.status(), 403);
        for (method, path, status) in [
            ("HEAD", "/health", 404),
            ("HEAD", "/app.bundle.js", 404),
            ("GET", "/app.bundle.js", 200),
            ("POST", "/app.bundle.js", 405),
            ("PATCH", "/api/agent", 404),
            ("POST", "/api/agent/input", 503),
        ] {
            assert_eq!(
                s.clone()
                    .handle(request(method, path, Bytes::new()))
                    .await
                    .status(),
                status,
                "{method} {path}"
            );
        }
    }
    #[tokio::test]
    async fn native_agent_routes_use_typed_operations_and_existing_statuses() {
        let fake = Arc::new(Fake::default());
        let state = agent_state(fake.clone());
        for (method, path, status, variant) in [
            ("POST", "/api/agent/input", 202, "AgentInput"),
            ("POST", "/api/agent/spawn", 202, "AgentSpawn"),
            ("POST", "/api/agent/sessions/a/accept", 200, "SessionAccept"),
            ("GET", "/api/agent/sessions/a/files", 200, "SessionFiles"),
            (
                "POST",
                "/api/agent/sessions/worker-a/message",
                202,
                "SessionMessage",
            ),
            (
                "POST",
                "/api/agent/sessions/worker-a/stop",
                200,
                "SessionStop",
            ),
            (
                "POST",
                "/api/agent/sessions/worker-a/resume",
                200,
                "SessionResume",
            ),
            ("GET", "/api/agent/settings", 200, "AgentSettings"),
            ("PATCH", "/api/agent/settings", 200, "AgentSettingsPatch"),
            ("GET", "/api/agent/approvals", 200, "Approvals"),
            ("POST", "/api/agent/approvals", 200, "ApprovalsDecide"),
            (
                "POST",
                "/api/agent/approvals/approval-1",
                200,
                "ApprovalDecide",
            ),
            ("GET", "/api/capabilities", 200, "Capabilities"),
            ("PUT", "/api/capabilities", 200, "CapabilitiesSave"),
            ("POST", "/api/capabilities/local/key", 200, "CapabilityKey"),
            ("GET", "/api/providers", 200, "Providers"),
            ("PUT", "/api/providers", 200, "ProvidersSave"),
            ("POST", "/api/providers/local/key", 200, "ProviderKey"),
            ("POST", "/api/providers/local/probe", 200, "ProviderProbe"),
            ("GET", "/api/network", 200, "Network"),
            ("PATCH", "/api/network", 200, "NetworkPatch"),
            ("POST", "/api/stop", 200, "StopAll"),
        ] {
            let response = state.clone().handle(request(method, path, "{}")).await;
            assert_eq!(response.status(), status, "{method} {path}");
            assert!(
                format!("{:?}", fake.calls.lock().unwrap().last().unwrap()).starts_with(variant),
                "{method} {path}"
            );
            assert_eq!(response.headers()["cache-control"], "no-store");
            assert_eq!(response.headers()["x-frame-options"], "DENY");
        }
        assert_eq!(fake.calls.lock().unwrap().len(), 22);
    }
    #[tokio::test]
    async fn native_agent_routes_keep_auth_csrf_method_and_path_boundaries() {
        let fake = Arc::new(Fake::default());
        let state = agent_state(fake.clone());
        let mut no_cookie = request("POST", "/api/agent/input", "{bad");
        no_cookie.headers_mut().remove("cookie");
        assert_eq!(state.clone().handle(no_cookie).await.status(), 401);
        let mut no_csrf = request("PUT", "/api/providers", "{}");
        no_csrf.headers_mut().remove("x-tepora-csrf");
        assert_eq!(state.clone().handle(no_csrf).await.status(), 403);
        for (method, path, status) in [
            ("GET", "/api/agent/input", 404),
            ("POST", "/api/providers", 404),
            ("POST", "/api/providers/a/key/extra", 404),
            ("POST", "/api/capabilities", 404),
            ("GET", "/api/capabilities/local/key", 404),
            ("POST", "/api/capabilities//key", 404),
            ("POST", "/api/capabilities/local/key/extra", 404),
            ("POST", "/api/providers/a%2fb/key", 404),
            ("POST", "/api/agent/sessions/a%2fb/message", 404),
            ("POST", "/api/agent/approvals/a/extra", 404),
        ] {
            assert_eq!(
                state
                    .clone()
                    .handle(request(method, path, "{}"))
                    .await
                    .status(),
                status,
                "{method} {path}"
            );
        }
        assert!(fake.calls.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn native_agent_bodies_preserve_codec_and_validate_before_dispatch() {
        let fake = Arc::new(Fake::default());
        let state = agent_state(fake.clone());
        let source = r#"{"text":"x\ud800\ue000\ue100😀","requestId":"request-1"}"#;
        let response = state
            .clone()
            .handle(request("POST", "/api/agent/input", source))
            .await;
        assert_eq!(response.status(), 202);
        let output = String::from_utf8(bytes(response).await.to_vec()).unwrap();
        assert_eq!(
            tepora_core::json_codec::parse(&output).unwrap(),
            tepora_core::json_codec::parse(source).unwrap()
        );
        for path in [
            "/api/agent/input",
            "/api/agent/spawn",
            "/api/providers/local/key",
            "/api/capabilities/local/key",
            "/api/providers/local/probe",
            "/api/agent/approvals/a",
        ] {
            assert_eq!(
                state
                    .clone()
                    .handle(request("POST", path, "{bad"))
                    .await
                    .status(),
                400
            );
        }
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
        // Existing stop/resume handlers do not parse a body at all.
        assert_eq!(
            state
                .clone()
                .handle(request("POST", "/api/agent/sessions/a/stop", "{bad"))
                .await
                .status(),
            200
        );
        assert_eq!(
            state
                .clone()
                .handle(request("POST", "/api/agent/sessions/a/resume", "{bad"))
                .await
                .status(),
            200
        );
    }
    #[tokio::test]
    async fn offline_native_routes_remain_unavailable_before_body_consumption() {
        let fake = Arc::new(Fake::default());
        let state = state(fake.clone());
        for (method, path) in [
            ("POST", "/api/agent/input"),
            ("POST", "/api/agent/spawn"),
            ("POST", "/api/agent/sessions/a/message"),
            ("PATCH", "/api/agent/settings"),
            ("POST", "/api/agent/approvals/a"),
            ("PUT", "/api/providers"),
            ("GET", "/api/capabilities"),
            ("PUT", "/api/capabilities"),
            ("POST", "/api/capabilities/local/key"),
            ("POST", "/api/providers/a/probe"),
            ("PATCH", "/api/network"),
            ("POST", "/api/stop"),
        ] {
            assert_eq!(
                state
                    .clone()
                    .handle(request(method, path, "{bad"))
                    .await
                    .status(),
                503,
                "{method} {path}"
            );
        }
        assert!(fake.calls.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn attachment_and_session_file_routes_use_real_workspace() {
        use crate::workspace::Workspace;
        use tepora_core::json_codec;
        let dir = std::env::temp_dir().join(format!("tepora-input-http-{}", uuid::Uuid::new_v4()));
        let workspace = Arc::new(Workspace::open(&dir).unwrap());
        workspace
            .enable_agent(tokio::runtime::Handle::current())
            .unwrap();
        let mut state = agent_state(Arc::new(Fake::default()));
        Arc::get_mut(&mut state).unwrap().backend = workspace.clone();
        let response = state
            .clone()
            .handle(request(
                "POST",
                "/api/inputs",
                r#"{"files":[{"name":"a.txt","content":"hello"}]}"#,
            ))
            .await;
        assert_eq!(response.status(), 201);
        let staged =
            json_codec::parse(std::str::from_utf8(&bytes(response).await).unwrap()).unwrap();
        let id = staged["files"][0]["id"].as_str().unwrap();
        assert_eq!(
            workspace.access().resolve_inputs(&json!([id])).unwrap()[0]["content"],
            "hello"
        );
        let root = dir.join("files");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("hello.txt"), b"exact bytes").unwrap();
        workspace.access().agent_state("session.create",json!({"kind":"worker","id":"files-session","cwd":json_codec::encode_text(&root.to_string_lossy())})).unwrap();
        let response = state
            .clone()
            .handle(request(
                "GET",
                "/api/agent/sessions/files-session/files",
                Bytes::new(),
            ))
            .await;
        assert_eq!(response.status(), 200);
        let listed =
            json_codec::parse(std::str::from_utf8(&bytes(response).await).unwrap()).unwrap();
        assert_eq!(listed["files"][0]["path"], "hello.txt");
        let response = state
            .clone()
            .handle(request(
                "GET",
                "/api/agent/sessions/files-session/download?path=hello.txt",
                Bytes::new(),
            ))
            .await;
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()["content-type"],
            "application/octet-stream"
        );
        assert_eq!(bytes(response).await, b"exact bytes"[..]);
        let response = state
            .clone()
            .handle(request(
                "GET",
                "/api/agent/sessions/files-session/download?path=../missing",
                Bytes::new(),
            ))
            .await;
        assert_eq!(response.status(), 403);
        let response = state
            .clone()
            .handle(request(
                "POST",
                "/api/agent/sessions/files-session/accept",
                Bytes::new(),
            ))
            .await;
        assert_eq!(response.status(), 200);
        assert_eq!(
            workspace
                .access()
                .agent_state("session.get", json!({"id":"files-session"}))
                .unwrap()["accepted"],
            true
        );
        let response = state
            .clone()
            .handle(request(
                "DELETE",
                &format!("/api/inputs/{id}"),
                Bytes::new(),
            ))
            .await;
        assert_eq!(response.status(), 200);
        assert_eq!(
            workspace
                .access()
                .resolve_inputs(&json!([id]))
                .unwrap_err()
                .status,
            404
        );
        let response = state
            .clone()
            .handle(request(
                "GET",
                "/api/agent/sessions/missing/files",
                Bytes::new(),
            ))
            .await;
        assert_eq!(response.status(), 404);
        let closing = workspace.clone();
        tokio::task::spawn_blocking(move || closing.shutdown()).await.unwrap().unwrap();
        drop(state);
        drop(workspace);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn capability_routes_preserve_literal_ids_codec_and_auth_boundaries() {
        let fake = Arc::new(Fake::default());
        let state = agent_state(fake.clone());
        let mut no_cookie = request("GET", "/api/capabilities", "");
        no_cookie.headers_mut().remove("cookie");
        assert_eq!(state.clone().handle(no_cookie).await.status(), 401);
        let mut no_csrf = request("PUT", "/api/capabilities", "{bad");
        no_csrf.headers_mut().remove("x-tepora-csrf");
        assert_eq!(state.clone().handle(no_csrf).await.status(), 403);
        assert!(fake.calls.lock().unwrap().is_empty());
        let source = r#"{"key":"x\ud800\ue000😀","identity":"pinned"}"#;
        let response = state
            .clone()
            .handle(request("POST", "/api/capabilities/a%2Fb/key", source))
            .await;
        assert_eq!(response.status(), 200);
        let output = bytes(response).await;
        assert_eq!(
            tepora_core::json_codec::parse(std::str::from_utf8(&output).unwrap()).unwrap(),
            tepora_core::json_codec::parse(source).unwrap()
        );
        match fake.calls.lock().unwrap().last().unwrap() {
            Operation::CapabilityKey { id, .. } => assert_eq!(id, "a%2Fb"),
            other => panic!("Wrong capability operation: {other:?}"),
        }
        assert_eq!(
            state
                .clone()
                .handle(request("PUT", "/api/capabilities", "{bad"))
                .await
                .status(),
            400
        );
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn capability_http_uses_shared_workspace_cas_memory_keys_and_live_bootstrap() {
        use crate::{capabilities::CapabilityState, workspace::Workspace};
        use tepora_core::json_codec;
        async fn call(
            state: &Arc<HttpState>,
            method: &str,
            path: &str,
            body: Value,
        ) -> (u16, Value) {
            let response = state
                .clone()
                .handle(request(
                    method,
                    path,
                    json_codec::stringify_js(&body).unwrap(),
                ))
                .await;
            let status = response.status().as_u16();
            let body = bytes(response).await;
            (
                status,
                json_codec::parse(std::str::from_utf8(&body).unwrap()).unwrap(),
            )
        }
        let dir =
            std::env::temp_dir().join(format!("tepora-capability-http-{}", uuid::Uuid::new_v4()));
        let workspace = Arc::new(Workspace::open(&dir).unwrap());
        workspace
            .enable_agent(tokio::runtime::Handle::current())
            .unwrap();
        let mut state = agent_state(Arc::new(Fake::default()));
        Arc::get_mut(&mut state).unwrap().backend = workspace.clone();
        assert_eq!(
            call(&state, "GET", "/api/capabilities", json!({})).await,
            (
                200,
                json!({"schema":1,"revision":0,"profiles":[],"routes":{}})
            )
        );
        for revision in [Value::Null, json!("0"), json!(false), json!(-1), json!(0.5)] {
            assert_eq!(
                call(
                    &state,
                    "PUT",
                    "/api/capabilities",
                    json!({"expectedRevision":revision,"config":{}})
                )
                .await
                .0,
                409
            );
        }
        assert_eq!(
            call(
                &state,
                "PUT",
                "/api/capabilities",
                json!({"expectedRevision":0,"config":{"profiles":[],"extra":true}})
            )
            .await
            .0,
            400
        );
        assert_eq!(call(&state,"PUT","/api/capabilities",json!({"expectedRevision":0,"config":{"profiles":[],"routes":{"decision":"pending"}}})).await.0,400);
        assert_eq!(
            call(&state, "GET", "/api/capabilities", json!({})).await.1["revision"],
            0
        );
        let mut config = json!({"profiles":[{"id":"local","protocol":"openai-embeddings","baseUrl":"http://127.0.0.1:8123/v1","model":"fixture","domain":"device"}],"routes":{"embedding":"local"}});
        let (status, first) = call(
            &state,
            "PUT",
            "/api/capabilities",
            json!({"expectedRevision":0.0,"config":config}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(first["revision"], 1);
        assert_eq!(first["profiles"][0]["keyPresent"], false);
        let identity = first["profiles"][0]["identity"].clone();
        for body in [
            json!({"key":"must-not-store"}),
            json!({"key":"must-not-store","identity":"stale"}),
        ] {
            assert_eq!(
                call(&state, "POST", "/api/capabilities/local/key", body)
                    .await
                    .0,
                409
            );
        }
        assert_eq!(
            call(
                &state,
                "POST",
                "/api/capabilities/local/key",
                json!({"identity":identity,"key":42})
            )
            .await
            .0,
            400
        );
        assert_eq!(
            call(
                &state,
                "POST",
                "/api/capabilities/local/key",
                json!({"identity":identity,"key":"😀".repeat(2001)})
            )
            .await
            .0,
            400
        );
        assert_eq!(
            call(
                &state,
                "POST",
                "/api/capabilities/%6cocal/key",
                json!({"identity":identity,"key":"must-not-store"})
            )
            .await
            .0,
            409
        );
        assert_eq!(
            call(
                &state,
                "POST",
                "/api/capabilities/local/key",
                json!({"identity":identity,"key":"synthetic-http-memory-key"})
            )
            .await,
            (200, json!({"id":"local","keyPresent":true}))
        );
        assert_eq!(
            call(&state, "GET", "/api/capabilities", json!({})).await.1["profiles"][0]
                ["keyPresent"],
            true
        );
        assert_eq!(
            call(&state, "GET", "/api/bootstrap", json!({})).await.1["capabilities"]["profiles"][0]
                ["keyPresent"],
            true
        );
        assert_eq!(
            call(
                &state,
                "PUT",
                "/api/capabilities",
                json!({"expectedRevision":0,"config":config})
            )
            .await
            .0,
            409
        );
        config["profiles"][0]["model"] = json!("renamed-model");
        let (status, second) = call(
            &state,
            "PUT",
            "/api/capabilities",
            json!({"expectedRevision":1,"config":config}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(second["profiles"][0]["keyPresent"], true);
        assert_ne!(second["profiles"][0]["identity"], identity);
        assert_eq!(
            call(
                &state,
                "POST",
                "/api/capabilities/local/key",
                json!({"identity":identity,"key":""})
            )
            .await
            .0,
            409
        );
        let identity = second["profiles"][0]["identity"].clone();
        assert_eq!(
            call(
                &state,
                "POST",
                "/api/capabilities/local/key",
                json!({"identity":identity,"key":""})
            )
            .await,
            (200, json!({"id":"local","keyPresent":false}))
        );
        assert_eq!(
            call(
                &state,
                "POST",
                "/api/capabilities/local/key",
                json!({"identity":identity,"key":"synthetic-http-memory-key"})
            )
            .await
            .0,
            200
        );
        config["profiles"][0]["baseUrl"] = json!("http://127.0.0.1:8124/v1");
        let (status, third) = call(
            &state,
            "PUT",
            "/api/capabilities",
            json!({"expectedRevision":2,"config":config}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(third["profiles"][0]["keyPresent"], false);
        let persisted = CapabilityState::value(&workspace.access(), "capabilities")
            .unwrap()
            .unwrap();
        assert!(!json_codec::stringify_js(&persisted)
            .unwrap()
            .contains("synthetic-http-memory-key"));
        let closing = workspace.clone();
        tokio::task::spawn_blocking(move || closing.shutdown())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            call(&state, "GET", "/api/capabilities", json!({})).await.0,
            503
        );
        drop(state);
        drop(workspace);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn singleton_header_duplicates_fail_closed_but_cookie_lines_concatenate() {
        let s = state(Arc::new(Fake::default()));
        let mut origin = request("GET", "/health", Bytes::new());
        origin
            .headers_mut()
            .append("origin", HeaderValue::from_static("http://127.0.0.1:4321"));
        origin
            .headers_mut()
            .append("origin", HeaderValue::from_static("http://127.0.0.1:4321"));
        assert_eq!(s.clone().handle(origin).await.status(), 403);
        let mut csrf = request("POST", "/api/presence", "{}");
        csrf.headers_mut().append(
            "x-tepora-csrf",
            HeaderValue::from_str(&"b".repeat(64)).unwrap(),
        );
        assert_eq!(s.clone().handle(csrf).await.status(), 403);
        let mut events = request("GET", "/api/events", Bytes::new());
        events
            .headers_mut()
            .append("last-event-id", HeaderValue::from_static("0"));
        events
            .headers_mut()
            .append("last-event-id", HeaderValue::from_static("1"));
        assert_eq!(s.clone().handle(events).await.status(), 400);
        let mut cookies = request("GET", "/api/bootstrap", Bytes::new());
        cookies.headers_mut().remove("cookie");
        cookies
            .headers_mut()
            .append("cookie", HeaderValue::from_static("unrelated=first"));
        cookies.headers_mut().append(
            "cookie",
            HeaderValue::from_str(&format!("tepora_session={}", "a".repeat(64))).unwrap(),
        );
        assert_eq!(s.clone().handle(cookies).await.status(), 200);
        let mut first_wins = request("GET", "/api/bootstrap", Bytes::new());
        first_wins
            .headers_mut()
            .insert("cookie", HeaderValue::from_static("tepora_session=wrong"));
        first_wins.headers_mut().append(
            "cookie",
            HeaderValue::from_str(&format!("tepora_session={}", "a".repeat(64))).unwrap(),
        );
        assert_eq!(s.handle(first_wins).await.status(), 401);
    }
    #[tokio::test]
    async fn reusable_launch_sets_exact_cookie_and_redirect() {
        let s = state(Arc::new(Fake::default()));
        for _ in 0..2 {
            let r = s
                .clone()
                .handle(request(
                    "GET",
                    &format!("/launch?token={}", "a".repeat(64)),
                    Bytes::new(),
                ))
                .await;
            assert_eq!(r.status(), 303);
            assert_eq!(r.headers()["location"], "/");
            assert_eq!(
                r.headers()["set-cookie"],
                format!(
                    "tepora_session={}; HttpOnly; SameSite=Strict; Path=/",
                    "a".repeat(64)
                )
            );
        }
        assert_eq!(
            s.handle(request("GET", "/launch?token=bad", Bytes::new()))
                .await
                .status(),
            403
        );
    }
    #[tokio::test]
    async fn bodies_are_bounded_empty_malformed_and_utf16_lossless() {
        let fake = Arc::new(Fake::default());
        let s = state(fake.clone());
        let r = s
            .clone()
            .handle(request("POST", "/api/memories", Bytes::new()))
            .await;
        assert_eq!(r.status(), 201);
        assert_eq!(bytes(r).await, b"{}"[..]);
        let r = s
            .clone()
            .handle(request(
                "POST",
                "/api/memories",
                r#"{"text":"\ud800\ue000\ue100"}"#,
            ))
            .await;
        assert_eq!(r.status(), 201);
        let body = String::from_utf8(bytes(r).await.to_vec()).unwrap();
        let decoded = tepora_core::json_codec::parse(&body).unwrap();
        assert_eq!(
            tepora_core::json_codec::utf16_units(decoded["text"].as_str().unwrap()),
            vec![0xd800, 0xe000, 0xe100]
        );
        assert_eq!(
            s.clone()
                .handle(request("POST", "/api/memories", "{"))
                .await
                .status(),
            400
        );
        let mut exact = vec![b' '; BODY_LIMIT];
        exact[0] = b'{';
        exact[1] = b'}';
        assert_eq!(
            s.clone()
                .handle(request("POST", "/api/memories", exact))
                .await
                .status(),
            201
        );
        assert_eq!(
            s.handle(request("POST", "/api/memories", vec![b' '; BODY_LIMIT + 1]))
                .await
                .status(),
            413
        );
        assert_eq!(fake.calls.lock().unwrap().len(), 3);
    }
    #[tokio::test]
    async fn body_timeout_does_not_dispatch_a_partial_operation() {
        let fake = Arc::new(Fake::default());
        let s = state(fake.clone());
        let body = StreamBody::new(futures_util::stream::pending::<
            Result<Frame<Bytes>, Infallible>,
        >());
        let r = Request::builder()
            .method("POST")
            .uri("/api/memories")
            .header("host", "127.0.0.1:4321")
            .header("cookie", format!("tepora_session={}", "a".repeat(64)))
            .header("x-tepora-csrf", "b".repeat(64))
            .body(body)
            .unwrap();
        assert_eq!(s.handle(r).await.status(), 408);
        assert!(fake.calls.lock().unwrap().is_empty());
    }
    #[test]
    fn cursors_match_js_numbers_and_last_event_precedence() {
        let mut h = hyper::HeaderMap::new();
        let u = Url::parse("http://127.0.0.1/?since=0x10").unwrap();
        assert_eq!(cursor(&h, &u).unwrap().since, 16);
        h.insert("last-event-id", HeaderValue::from_static("0"));
        let c = cursor(&h, &u).unwrap();
        assert_eq!(c.since, 0);
        assert!(c.reconnect);
        for text in [
            "-1",
            "1.5",
            "9007199254740992",
            "Infinity",
            "日本",
            "invalid",
        ] {
            h.insert("last-event-id", HeaderValue::from_str(text).unwrap());
            assert_eq!(cursor(&h, &u).unwrap_err().status, 400);
        }
        assert_eq!(js_number("\u{feff}0b11\u{feff}"), 3.0);
        assert!(js_number("inf").is_nan());
    }
    #[test]
    fn static_allowlist_keeps_percent_encoded_paths_literal() {
        assert_eq!(static_asset("/"), Some("index.html"));
        assert_eq!(
            static_asset("/vendor/mesh-avatar/kana.js"),
            Some("vendor/mesh-avatar/kana.js")
        );
        for p in [
            "/%69ndex.html",
            "/vendor%2Fthree.core.js",
            "/../Cargo.toml",
            "/core/server.mjs",
            "/avatar/model.mjs",
            "/app.bundle.js",
        ] {
            assert_eq!(static_asset(p), None, "{p}");
        }
    }
    #[test]
    fn sse_frames_filter_internals_preserve_envelopes_and_broadcast_cursor() {
        let event = ServiceEvent {
            seq: Some(7),
            event_type: "memory.updated".into(),
            data: json!({"text":"a\nb"}),
            at: Some("now".into()),
        };
        let frame = String::from_utf8(event_frame(&event).unwrap().unwrap().to_vec()).unwrap();
        assert!(frame.starts_with("id: 7\ndata: {\"seq\":7,\"type\":\"memory.updated\""));
        assert!(!frame.contains("event:"));
        assert!(frame.ends_with("\n\n"));
        let broadcast = ServiceEvent {
            seq: None,
            event_type: "dialogue.delta".into(),
            data: json!({}),
            at: None,
        };
        let frame = String::from_utf8(event_frame(&broadcast).unwrap().unwrap().to_vec()).unwrap();
        assert!(frame.starts_with("data: {\"seq\":null"));
        assert!(!frame.contains("id:"));
        assert!(!frame.contains("\"at\""));
        for kind in [
            "session.entry",
            "session.inbox",
            "agent.delta",
            "agent.event",
            "agent.reply",
            "agent.compaction",
            "agent.finished",
        ] {
            let hidden = ServiceEvent {
                event_type: kind.into(),
                ..broadcast.clone()
            };
            assert!(event_frame(&hidden).unwrap().is_none());
        }
    }
    #[tokio::test]
    async fn sse_heartbeat_and_disconnect_cleanup_are_bounded() {
        let fake = Arc::new(Fake::default());
        let s = state(fake.clone());
        let mut response = s
            .clone()
            .handle(request("GET", "/api/events", Bytes::new()))
            .await;
        assert_eq!(response.status(), 200);
        let frame = tokio::time::timeout(Duration::from_millis(250), response.body_mut().frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .into_data()
            .unwrap();
        assert_eq!(frame, b": heartbeat\n\n"[..]);
        let sender = fake.sender.lock().unwrap().clone().unwrap();
        let event = ServiceEvent {
            seq: None,
            event_type: "dialogue.delta".into(),
            data: json!({"text":"live"}),
            at: None,
        };
        sender.try_send(event.clone()).unwrap();
        sender.try_send(event.clone()).unwrap();
        assert!(matches!(
            sender.try_send(event),
            Err(mpsc::error::TrySendError::Full(_))
        ));
        drop(response);
        assert_eq!(fake.unsubscribed.load(Ordering::SeqCst), 1);
        assert!(sender.is_closed());
    }
    #[tokio::test]
    async fn artifact_render_is_opaque_and_escapes_protected_text() {
        let s = state(Arc::new(Fake::default()));
        let r = s.handle(request("GET", "/render/a", Bytes::new())).await;
        assert!(!r.headers().contains_key("x-frame-options"));
        assert!(r.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("connect-src 'none'"));
        assert!(!r.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("allow-scripts"));
        assert!(String::from_utf8(bytes(r).await.to_vec())
            .unwrap()
            .contains("&lt;h1&gt;ok&lt;/h1&gt;"));
    }
    #[tokio::test]
    async fn stalled_write_hits_a_finite_deadline() {
        use tokio::io::AsyncWriteExt;
        // A bounded in-memory transport guarantees backpressure on every OS.
        // An unconsumed TCP peer may buffer many MiB on Windows, so payload
        // size is not a portable way to force poll_write to return Pending.
        let (server, client) = tokio::io::duplex(1);
        let mut stream = TimedIo::new(server, Duration::from_millis(20));
        let payload = [0u8; 64];
        let result = tokio::time::timeout(Duration::from_secs(2), stream.write_all(&payload))
            .await
            .unwrap();
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
        drop(client);
    }
    #[tokio::test]
    async fn incomplete_headers_hit_the_configured_deadline() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let dir =
            std::env::temp_dir().join(format!("tepora-native-headers-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let bundle = dir.join("bundle.js");
        std::fs::write(&bundle, b"window.fixture=true;").unwrap();
        let mut config = HttpConfig::new(dir.clone(), bundle);
        config.header_timeout = Duration::from_millis(25);
        let server = Server::bind(config, Arc::new(Fake::default()))
            .await
            .unwrap();
        let address = server.local_addr().unwrap();
        let shutdown = server.shutdown_sender();
        let task = tokio::spawn(server.run());
        let mut socket = TcpStream::connect(address).await.unwrap();
        socket
            .write_all(b"GET /health HTTP/1.1\r\nHost:")
            .await
            .unwrap();
        let mut received = vec![];
        tokio::time::timeout(Duration::from_secs(1), socket.read_to_end(&mut received))
            .await
            .unwrap()
            .unwrap();
        assert!(!String::from_utf8_lossy(&received).contains("200 OK"));
        shutdown.send_replace(true);
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn safe_error_redacts_secrets_and_truncates_utf16() {
        let text = safe_error(&format!(
            "Bearer TOPSECRET sk-hidden-key {}",
            "😀".repeat(400)
        ));
        let json = tepora_core::json_codec::stringify_js(&json!({"error":text})).unwrap();
        assert!(!json.contains("TOPSECRET"));
        assert!(!json.contains("sk-hidden"));
        assert_eq!(tepora_core::json_codec::utf16_units(&text).len(), 600);
    }
}

// decodeURIComponent semantics: '+' stays literal; any invalid escape/UTF-8 clears the name.
fn decode_photo_filename(raw: &str) -> String {
    let input=raw.as_bytes();let mut out=Vec::with_capacity(input.len());let mut at=0;
    while at<input.len() {
        if input[at]==b'%' {
            let Some(pair)=input.get(at+1..at+3) else{return String::new()};
            let hex=|b:u8|(b as char).to_digit(16);
            let (Some(a),Some(b))=(hex(pair[0]),hex(pair[1])) else{return String::new()};
            out.push((a*16+b) as u8);at+=3;
        } else {out.push(input[at]);at+=1;}
    }
    String::from_utf8(out).map(|s|tepora_core::json_codec::encode_text(&s)).unwrap_or_default()
}
