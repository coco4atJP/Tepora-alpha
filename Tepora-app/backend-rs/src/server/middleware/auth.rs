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
    require_api_key(request.headers(), &state.session_token)?;
    Ok(next.run(request).await)
}
