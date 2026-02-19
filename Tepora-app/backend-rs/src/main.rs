//! Tepora Backend Application
//!
//! This is the main entry point for the Tepora backend server.
//! It sets up the Axum router, initializes the application state,
//! and starts the HTTP server.

use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod a2a;
mod agent;
mod context;
mod core;
mod em_llm;
mod graph;
mod history;
mod llm;
mod mcp;
mod memory;
mod models;
mod rag;
mod server;
mod state;
mod tools;

use crate::state::AppState;

#[tokio::main]
/// Main entry point for the application.
///
/// Initializes tracing, application state, and starts the Axum server.
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info,backend_rs=debug".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    tracing::info!("Starting Tepora backend (Rust)...");

    let app_state = AppState::initialize().await?;

    if let Err(e) = app_state.mcp.initialize().await {
        tracing::warn!("MCP Manager initialization finished with warning: {}", e);
        if let Some(err_msg) = app_state.mcp.init_error().await {
            tracing::warn!("MCP Initialization detailed error: {}", err_msg);
        }
    }

    let app = server::router(app_state.clone()).layer(TraceLayer::new_for_http());

    let host = resolve_server_host();
    let port = resolve_server_port();
    let addr = format!("{}:{}", host, port);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    let local_addr = listener.local_addr()?;
    tracing::info!("Server listening on http://{}", local_addr);

    // dev_sync.mjs がポートを検出できるよう stdout に出力する
    // NOTE: tracing は stderr に出力するため、フロントエンド起動トリガーに使えない
    // stdout がパイプ接続時はバッファリングされるため、明示的にフラッシュする
    println!("TEPORA_PORT={}", local_addr.port());
    {
        use std::io::Write;
        let _ = std::io::stdout().flush();
    }

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    tracing::info!("Tepora backend shutdown complete");

    Ok(())
}

fn resolve_server_host() -> String {
    resolve_server_host_from_value(std::env::var("TEPORA_HOST").ok().as_deref())
}

fn resolve_server_host_from_value(raw: Option<&str>) -> String {
    match raw.map(str::trim) {
        Some(host) if !host.is_empty() => host.to_string(),
        Some(_) => {
            tracing::warn!("TEPORA_HOST is empty; using default 127.0.0.1");
            "127.0.0.1".to_string()
        }
        None => "127.0.0.1".to_string(),
    }
}

fn resolve_server_port() -> u16 {
    resolve_server_port_from_values(
        std::env::var("TEPORA_PORT").ok().as_deref(),
        std::env::var("PORT").ok().as_deref(),
    )
}

fn resolve_server_port_from_values(tepora_port: Option<&str>, port: Option<&str>) -> u16 {
    parse_port_value("TEPORA_PORT", tepora_port)
        .or_else(|| parse_port_value("PORT", port))
        .unwrap_or(3001)
}

fn parse_port_value(var_name: &str, raw: Option<&str>) -> Option<u16> {
    let raw = raw?;
    let trimmed = raw.trim();

    if trimmed.is_empty() {
        tracing::warn!("{} is empty; ignoring value", var_name);
        return None;
    }

    match trimmed.parse::<u16>() {
        Ok(port) => Some(port),
        Err(_) => {
            tracing::warn!("{}='{}' is invalid; expected 0-65535", var_name, raw);
            None
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(err) = tokio::signal::ctrl_c().await {
            tracing::warn!("Failed to listen for Ctrl+C: {}", err);
        }
    };

    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let terminate = async {
            match signal(SignalKind::terminate()) {
                Ok(mut stream) => {
                    let _ = stream.recv().await;
                }
                Err(err) => {
                    tracing::warn!("Failed to listen for SIGTERM: {}", err);
                }
            }
        };

        tokio::select! {
            _ = ctrl_c => {},
            _ = terminate => {},
        }
    }

    #[cfg(not(unix))]
    {
        ctrl_c.await;
    }

    tracing::info!("Shutdown signal received");
}

#[cfg(test)]
mod tests {
    use super::{
        parse_port_value, resolve_server_host_from_value, resolve_server_port_from_values,
    };

    #[test]
    fn resolve_server_port_prefers_tepora_port() {
        let port = resolve_server_port_from_values(Some("3002"), Some("9000"));
        assert_eq!(port, 3002);
    }

    #[test]
    fn resolve_server_port_falls_back_to_port_env() {
        let port = resolve_server_port_from_values(None, Some("8080"));
        assert_eq!(port, 8080);
    }

    #[test]
    fn resolve_server_port_uses_default_when_all_invalid() {
        let port = resolve_server_port_from_values(Some("invalid"), Some(""));
        assert_eq!(port, 3001);
    }

    #[test]
    fn parse_port_value_accepts_trimmed_numeric_input() {
        let parsed = parse_port_value("TEST_PORT", Some(" 5173 "));
        assert_eq!(parsed, Some(5173));
    }

    #[test]
    fn resolve_server_host_uses_default_when_empty() {
        let host = resolve_server_host_from_value(Some("  "));
        assert_eq!(host, "127.0.0.1");
    }

    #[test]
    fn resolve_server_host_preserves_valid_input() {
        let host = resolve_server_host_from_value(Some("0.0.0.0"));
        assert_eq!(host, "0.0.0.0");
    }
}
