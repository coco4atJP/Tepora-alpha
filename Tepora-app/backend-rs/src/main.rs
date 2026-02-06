mod api;
mod config;
mod errors;
mod history;
mod llama;
mod logging;
mod mcp;
mod mcp_installer;
mod mcp_registry;
mod models;
mod search;
mod security;
mod setup_state;
mod state;
mod tooling;
mod vector_math;
mod ws;

use std::env;

use anyhow::Context;
use axum::Router;
use tokio::net::TcpListener;

use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let state = AppState::initialize().await?;
    logging::init(&state.paths);

    if let Err(err) = state.mcp.initialize().await {
        tracing::warn!("Failed to initialize MCP: {}", err);
    }

    let port = env::var("PORT")
        .ok()
        .and_then(|val| val.parse::<u16>().ok())
        .unwrap_or(0);
    let bind_addr = format!("127.0.0.1:{}", port);

    let listener = TcpListener::bind(&bind_addr)
        .await
        .with_context(|| format!("Failed to bind to {}", bind_addr))?;
    let addr = listener.local_addr()?;

    println!("TEPORA_PORT={}", addr.port());
    tracing::info!("Listening on {}", addr);

    let app: Router = api::router(state.clone());

    axum::serve(listener, app).await.context("Server error")?;

    Ok(())
}
