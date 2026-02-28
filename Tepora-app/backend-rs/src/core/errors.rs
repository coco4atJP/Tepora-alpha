use axum::{
    http::{HeaderValue, StatusCode},
    response::IntoResponse,
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("unauthorized")]
    Unauthorized,
    #[error("token expired")]
    TokenExpired,
    #[error("forbidden")]
    Forbidden,
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("not implemented: {0}")]
    #[allow(dead_code)]
    NotImplemented(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("internal error: {0}")]
    Internal(String),
    #[error("too many requests")]
    TooManyRequests,
}

impl ApiError {
    pub fn internal<E: std::fmt::Display>(err: E) -> Self {
        ApiError::Internal(err.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match &self {
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()),
            ApiError::TokenExpired => (StatusCode::UNAUTHORIZED, "Token Expired".to_string()),
            ApiError::Forbidden => (StatusCode::FORBIDDEN, "Forbidden".to_string()),
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            ApiError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            ApiError::NotImplemented(msg) => (StatusCode::NOT_IMPLEMENTED, msg.clone()),
            ApiError::Conflict(msg) => (StatusCode::CONFLICT, msg.clone()),
            ApiError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg.clone()),
            ApiError::TooManyRequests => (
                StatusCode::TOO_MANY_REQUESTS,
                "Too many requests. Please try again later.".to_string(),
            ),
        };

        let body = Json(json!({ "error": message }));
        let mut response = (status, body).into_response();

        // RFC 7231 準拠: 429 レスポンスに Retry-After ヘッダを付加
        if status == StatusCode::TOO_MANY_REQUESTS {
            response
                .headers_mut()
                .insert("Retry-After", HeaderValue::from_static("60"));
        }

        response
    }
}
