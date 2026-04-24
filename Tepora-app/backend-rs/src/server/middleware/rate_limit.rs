use std::net::IpAddr;
use std::num::NonZeroU32;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Request, State};
use axum::middleware::Next;
use axum::response::Response;
use governor::clock::DefaultClock;
use governor::state::{InMemoryState, NotKeyed};
use governor::{Quota, RateLimiter};

use crate::core::errors::ApiError;
use crate::state::AppState;

/// IP不要な共有レート制限（WebSocket / ヘルスチェック等、非認証エンドポイント向け）
pub type SharedRateLimiter = Arc<RateLimiter<NotKeyed, InMemoryState, DefaultClock>>;

/// アプリケーション全体で共有されるレート制限セット
pub struct RateLimiters {
    /// 一般APIエンドポイント: 60 リクエスト/分
    pub api: SharedRateLimiter,
}

impl RateLimiters {
    pub fn new() -> Self {
        let api_quota = Quota::per_minute(NonZeroU32::new(60).expect("60 is non-zero"));
        Self {
            api: Arc::new(RateLimiter::direct(api_quota)),
        }
    }
}

impl Default for RateLimiters {
    fn default() -> Self {
        Self::new()
    }
}

/// 一般APIエンドポイント向けレート制限ミドルウェア。
///
/// `AppState` に保持されている `runtime.rate_limiters.api` を使用し、
/// グローバルなトークンバケット方式でリクエスト数を制限する。
/// 制限を超えた場合は 429 Too Many Requests を返す。
pub async fn rate_limit_middleware(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    if !state.is_redesign_enabled("rate_limit") {
        return Ok(next.run(request).await);
    }
    match state.runtime().rate_limiters.api.check() {
        Ok(_) => Ok(next.run(request).await),
        Err(_) => {
            tracing::warn!(
                "Rate limit exceeded for API request: {} {}",
                request.method(),
                request.uri().path(),
            );
            Err(ApiError::TooManyRequests)
        }
    }
}

/// ConnectInfo からクライアントIPを取得するユーティリティ（将来の IP別制限に向けて用意）
#[allow(dead_code)]
pub fn extract_client_ip(request: &Request) -> Option<IpAddr> {
    // Tauri サイドカー環境では実際のIPベースの制限は不要だが、
    // 将来のネットワーク配置に備えて X-Forwarded-For も考慮する
    request
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .and_then(|ip| ip.trim().parse().ok())
        .or_else(|| {
            request
                .extensions()
                .get::<ConnectInfo<std::net::SocketAddr>>()
                .map(|ci| ci.0.ip())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limiters_can_be_created() {
        let limiters = RateLimiters::new();
        // 最初のリクエストは通過できる
        assert!(limiters.api.check().is_ok());
    }

    #[test]
    fn rate_limiter_eventually_blocks_burst() {
        // バースト上限（60 req/min のデフォルト）を超えると拒否されることを確認
        let quota = Quota::per_minute(NonZeroU32::new(3).unwrap());
        let limiter: SharedRateLimiter = Arc::new(RateLimiter::direct(quota));
        // 最初の数回は通過
        assert!(limiter.check().is_ok());
        assert!(limiter.check().is_ok());
        assert!(limiter.check().is_ok());
        // バースト上限超過後は拒否
        assert!(limiter.check().is_err());
    }
}
