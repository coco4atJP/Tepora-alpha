//! Tepora Backend Application
//!
//! This is the main entry point for the Tepora backend server.
//! It sets up the Axum router, initializes the application state,
//! and starts the HTTP server.

use axum::http::Method;
use tower_http::cors::{Any, CorsLayer};
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

    let app = server::router(app_state.clone())
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([
                    Method::GET,
                    Method::POST,
                    Method::PUT,
                    Method::DELETE,
                    Method::OPTIONS,
                ])
                .allow_headers(Any),
        )
        .layer(TraceLayer::new_for_http());

    let host = std::env::var("TEPORA_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("TEPORA_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(3001);
    let addr = format!("{}:{}", host, port);

    tracing::info!("Server listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await?;

    axum::serve(listener, app).await?;

    Ok(())
}
