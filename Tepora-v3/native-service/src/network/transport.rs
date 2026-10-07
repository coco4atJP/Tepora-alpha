//! Direct HTTP/1 + TLS. No proxy discovery, pooling, automatic redirects,
//! decompression, fallback destination, or second DNS resolution.
use super::*;
use http_body_util::{BodyExt, Full};
use hyper::{header, Request};
use hyper_util::rt::TokioIo;
use std::{fs::File, io::Read, net::SocketAddr, path::Path, sync::Arc};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
};
use tokio_rustls::{
    rustls::{
        self,
        pki_types::{pem::PemObject, CertificateDer, ServerName},
    },
    TlsConnector,
};
trait Socket: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Socket for T {}
pub struct CheckedTransport {
    tls: Arc<rustls::ClientConfig>,
    diagnostics: Vec<String>,
}
const MAX_EXTRA_CA_BYTES: u64 = 1024 * 1024;
impl Default for CheckedTransport {
    fn default() -> Self {
        // Like Node, read extra roots once when this transport is initialized.
        // Optional malformed input warns and leaves normal verified roots intact.
        let path = std::env::var_os("NODE_EXTRA_CA_CERTS").filter(|v| !v.is_empty());
        Self::from_extra_ca_file(path.as_deref().map(Path::new))
    }
}
impl CheckedTransport {
    pub(super) fn from_extra_ca_file(path: Option<&Path>) -> Self {
        let mut roots =
            rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let mut diagnostics = Vec::new();
        if let Some(path) = path {
            match load_extra_roots(path) {
                Ok(extra) => roots.roots.extend(extra.roots),
                Err(message) => {
                    diagnostics.push(format!("{message}; using default verified TLS roots"))
                }
            }
        }
        let mut tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("TLS versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        Self {
            tls: Arc::new(tls),
            diagnostics,
        }
    }
}
/// Parse into a separate store so malformed optional input cannot partially
/// modify the trust configuration. Bound both reads and PEM decoded allocation.
fn load_extra_roots(path: &Path) -> Result<rustls::RootCertStore, &'static str> {
    let file = File::open(path).map_err(|_| "NODE_EXTRA_CA_CERTS could not be read")?;
    let metadata = file
        .metadata()
        .map_err(|_| "NODE_EXTRA_CA_CERTS could not be read")?;
    if !metadata.is_file() {
        return Err("NODE_EXTRA_CA_CERTS must be a regular PEM file");
    }
    if metadata.len() > MAX_EXTRA_CA_BYTES {
        return Err("NODE_EXTRA_CA_CERTS exceeds the 1 MiB limit");
    }
    let mut pem = Vec::new();
    file.take(MAX_EXTRA_CA_BYTES + 1)
        .read_to_end(&mut pem)
        .map_err(|_| "NODE_EXTRA_CA_CERTS could not be read")?;
    if pem.len() as u64 > MAX_EXTRA_CA_BYTES {
        return Err("NODE_EXTRA_CA_CERTS exceeds the 1 MiB limit");
    }
    let mut extra = rustls::RootCertStore::empty();
    for cert in CertificateDer::pem_slice_iter(&pem) {
        let cert = cert.map_err(|_| "NODE_EXTRA_CA_CERTS contains malformed PEM certificates")?;
        extra
            .add(cert)
            .map_err(|_| "NODE_EXTRA_CA_CERTS contains an invalid certificate")?;
    }
    if extra.is_empty() {
        return Err("NODE_EXTRA_CA_CERTS contains no certificates");
    }
    Ok(extra)
}
impl Transport for CheckedTransport {
    fn diagnostics(&self) -> Vec<String> {
        self.diagnostics.clone()
    }
    fn request<'a>(
        &'a self,
        admitted: Admitted,
        request: NetworkRequest,
        cancel: RequestCancellation,
    ) -> NetworkFuture<'a, TransportResponse> {
        Box::pin(async move {
            cancel.check()?;
            let port = admitted
                .url
                .port_or_known_default()
                .ok_or_else(|| NetworkError::invalid("Missing HTTP port"))?;
            let socket = tokio::select! {
                biased;
                error = cancel.cancelled() => return Err(error),
                socket = TcpStream::connect(SocketAddr::new(admitted.address, port)) => {
                    socket.map_err(|e| NetworkError::transport(format!("Connection failed: {e}")))?
                }
            };
            socket
                .set_nodelay(true)
                .map_err(|e| NetworkError::transport(e.to_string()))?;
            let socket: Box<dyn Socket> = if admitted.url.scheme() == "https" {
                // URL hostname, never the DNS/pinned destination, is the validated
                // TLS peer name. rustls also checks literal IP SANs and sends no IP SNI.
                let name = ServerName::try_from(hostname(&admitted.url))
                    .map_err(|_| NetworkError::invalid("Invalid TLS hostname"))?;
                let connector = TlsConnector::from(self.tls.clone());
                let tls = tokio::select! {
                    biased;
                    error = cancel.cancelled() => return Err(error),
                    socket = connector.connect(name, socket) => {
                        socket.map_err(|e| NetworkError::transport(format!("TLS failed: {e}")))?
                    }
                };
                Box::new(tls)
            } else {
                Box::new(socket)
            };
            let (mut sender, connection) =
                hyper::client::conn::http1::handshake::<_, Full<Bytes>>(TokioIo::new(socket))
                    .await
                    .map_err(|e| NetworkError::transport(e.to_string()))?;
            let driver_cancel = cancel.clone();
            let driver = tokio::spawn(async move {
                tokio::select! {
                    biased;
                    _ = driver_cancel.cancelled() => {},
                    result = connection => {
                        if let Err(e) = result {
                            driver_cancel.fail(NetworkError::transport(format!("HTTP connection failed: {e}")));
                        }
                    }
                }
            });
            // Aborting a future/body must also drop the connection driver, including
            // failures while request headers are still in flight.
            struct Driver(AbortHandle);
            impl Drop for Driver {
                fn drop(&mut self) {
                    self.0.abort();
                }
            }
            let driver = Driver(driver.abort_handle());
            let mut target = admitted.url.path().to_owned();
            if let Some(query) = admitted.url.query() {
                target.push('?');
                target.push_str(query);
            }
            let body_len = request.body.len();
            let mut outgoing = Request::builder()
                .method(request.method)
                .uri(target)
                .body(Full::new(request.body))
                .map_err(|e| NetworkError::invalid(e.to_string()))?;
            *outgoing.headers_mut() = request.headers;
            let authority = &admitted.url[url::Position::BeforeHost..url::Position::AfterPort];
            outgoing.headers_mut().insert(
                header::HOST,
                authority
                    .parse()
                    .map_err(|_| NetworkError::invalid("Invalid Host"))?,
            );
            outgoing.headers_mut().insert(
                header::ACCEPT_ENCODING,
                header::HeaderValue::from_static("identity"),
            );
            outgoing.headers_mut().insert(
                header::CONNECTION,
                header::HeaderValue::from_static("close"),
            );
            // A caller cannot smuggle a second request or create a CONNECT tunnel.
            if outgoing.method() == Method::CONNECT {
                return Err(NetworkError::blocked("CONNECT tunneling is not supported"));
            }
            outgoing.headers_mut().remove(header::TRANSFER_ENCODING);
            outgoing.headers_mut().remove(header::PROXY_AUTHORIZATION);
            outgoing.headers_mut().remove("proxy-connection");
            outgoing.headers_mut().remove(header::UPGRADE);
            outgoing.headers_mut().insert(
                header::CONTENT_LENGTH,
                body_len.to_string().parse().unwrap(),
            );
            let response = tokio::select! {
                biased;
                error = cancel.cancelled() => return Err(error),
                result = sender.send_request(outgoing) => result.map_err(|e| NetworkError::transport(e.to_string()))?,
            };
            let (parts, mut body) = response.into_parts();
            let no_body = matches!(parts.status.as_u16(), 204 | 205 | 304);
            if no_body {
                drop(driver);
                return Ok(TransportResponse {
                    status: parts.status.as_u16(),
                    headers: parts.headers,
                    body: None,
                });
            }
            let stream = async_stream::try_stream! {
                let _driver = driver;
                loop {
                    let frame = tokio::select! {
                        biased;
                        error = cancel.cancelled() => Err(error),
                        frame = body.frame() => Ok(frame),
                    }?;
                    let Some(frame) = frame else { break; };
                    let frame = frame.map_err(|e| NetworkError::transport(e.to_string()))?;
                    if let Ok(bytes) = frame.into_data() { yield bytes; }
                }
            };
            Ok(TransportResponse {
                status: parts.status.as_u16(),
                headers: parts.headers,
                body: Some(Box::pin(stream)),
            })
        })
    }
}
