use std::sync::Arc;

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;

use crate::core::errors::ApiError;
use crate::core::security::require_api_key;
use crate::state::AppState;

pub async fn require_api_key_middleware(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let allow_expired = request.uri().path() == "/api/auth/refresh";
    let token = state.core().session_token.read().await;
    require_api_key(request.headers(), &token, allow_expired)?;
    Ok(next.run(request).await)
}
