use axum::{
    extract::{Request, State},
    middleware::Next,
    response::Response,
};
use axum::http::{HeaderMap, HeaderValue};
use std::sync::Arc;
use std::time::Instant;
use uuid::Uuid;
use tracing::Instrument;

use crate::state::AppState;

pub async fn require_tracing_middleware(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    if state.is_redesign_enabled("tracing") {
        let request_id = Uuid::new_v4().to_string();
        let session_id = extract_session_id(request.headers());
        let user_agent = extract_user_agent(request.headers());
        let method = request.method().to_string();
        let path = request.uri().path().to_string();
        let started = Instant::now();

        let span = tracing::info_span!(
            "http.request",
            %request_id,
            %session_id,
            %method,
            %path,
            %user_agent,
        );

        // We wrap the rest of the request handling in this span
        async move {
            tracing::info!(
                target: "http",
                request_id = %request_id,
                session_id = %session_id,
                method = %method,
                path = %path,
                "request started"
            );
            let mut response = next.run(request).await;
            let status = response.status().as_u16();
            let latency_ms = started.elapsed().as_millis() as u64;

            if let Ok(value) = HeaderValue::from_str(&request_id) {
                response.headers_mut().insert("x-request-id", value);
            }

            if status >= 500 {
                tracing::error!(
                    target: "http",
                    request_id = %request_id,
                    session_id = %session_id,
                    method = %method,
                    path = %path,
                    status,
                    latency_ms,
                    "request completed with server error"
                );
            } else if status >= 400 {
                tracing::warn!(
                    target: "http",
                    request_id = %request_id,
                    session_id = %session_id,
                    method = %method,
                    path = %path,
                    status,
                    latency_ms,
                    "request completed with client error"
                );
            } else {
                tracing::info!(
                    target: "http",
                    request_id = %request_id,
                    session_id = %session_id,
                    method = %method,
                    path = %path,
                    status,
                    latency_ms,
                    "request completed"
                );
            }
            response
        }.instrument(span).await
    } else {
        next.run(request).await
    }
}

fn extract_session_id(headers: &HeaderMap) -> String {
    headers
        .get("x-session-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("none")
        .to_string()
}

fn extract_user_agent(headers: &HeaderMap) -> String {
    headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string()
}

#[cfg(test)]
mod tests {
    use axum::http::{header::USER_AGENT, HeaderMap, HeaderValue};

    use super::{extract_session_id, extract_user_agent};

    #[tokio::test]
    async fn it_extracts_session_id_when_present() {
        let mut headers = HeaderMap::new();
        headers.insert("x-session-id", HeaderValue::from_static("session-123"));
        assert_eq!(extract_session_id(&headers), "session-123");
    }

    #[tokio::test]
    async fn it_returns_default_session_id_when_missing() {
        let headers = HeaderMap::new();
        assert_eq!(extract_session_id(&headers), "none");
    }

    #[tokio::test]
    async fn it_extracts_user_agent_when_present() {
        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("tepora-test/1.0"));
        assert_eq!(extract_user_agent(&headers), "tepora-test/1.0");
    }

    #[tokio::test]
    async fn it_returns_default_user_agent_when_missing() {
        let headers = HeaderMap::new();
        assert_eq!(extract_user_agent(&headers), "unknown");
    }
}
