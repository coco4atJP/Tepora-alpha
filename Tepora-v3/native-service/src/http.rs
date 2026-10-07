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
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::{watch, Notify},
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
        while connections.join_next().await.is_some() {}
        // Dropping a HTTP future must not close SQLite while an authorized domain
        // mutation is still running on the blocking pool.
        while self.state.work.count.load(Ordering::Acquire) != 0 {
            self.state.work.finished.notified().await;
        }
        if let Some(error) = accept_error {
            return Err(ApiError::new(500, error.to_string()));
        }
        Ok(())
    }
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
                BodyRoute::MemoryCreate => Operation::MemoryCreate { body },
                BodyRoute::MemoryPatch(id) => Operation::MemoryPatch { id, body },
                BodyRoute::ArtifactEdit(id) => Operation::ArtifactEdit { id, body },
                BodyRoute::Import => Operation::Import { body },
                BodyRoute::Presence => Operation::Presence { body },
            };
            return self.json_operation(op, status).await;
        }
        if method == Method::DELETE {
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
                | Operation::Presence { body }
                | Operation::Import { body } => Reply::Json(body),
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
