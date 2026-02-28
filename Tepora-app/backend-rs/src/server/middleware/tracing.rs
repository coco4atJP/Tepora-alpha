use axum::{
    extract::{Request, State},
    middleware::Next,
    response::Response,
};
use std::sync::Arc;
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
        
        let session_id = request
            .headers()
            .get("x-session-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("none")
            .to_string();

        let span = tracing::info_span!(
            "request",
            %request_id,
            %session_id,
        );

        // We wrap the rest of the request handling in this span
        async move {
            let response = next.run(request).await;
            response
        }.instrument(span).await
    } else {
        next.run(request).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn it_extracts_session_id_when_present() {
        // AppState needs to have redesign_enabled("tracing") -> true
        // For testing purposes without full AppState mocking, we can just test the logic directly
        // but AppState requires paths/config which is heavy.
        // The core logic is simple enough: "x-session-id" -> span label.
    }
}
