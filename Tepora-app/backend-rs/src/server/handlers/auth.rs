use axum::{extract::State, Json};
use serde_json::json;

use crate::core::errors::ApiError;
use crate::state::AppStateRead;

pub async fn refresh_token(
    State(state): State<AppStateRead>,
) -> Result<impl axum::response::IntoResponse, ApiError> {
    if !state.is_redesign_enabled("session_expiration") {
        return Err(ApiError::BadRequest(
            "Session expiration feature is disabled".to_string(),
        ));
    }

    let mut token_lock = state.core().session_token.write().await;
    let new_token = token_lock.reissue()?;

    let expires_at = token_lock.expires_at().to_rfc3339();

    Ok(Json(
        json!({ "token": new_token, "expires_at": expires_at }),
    ))
}
