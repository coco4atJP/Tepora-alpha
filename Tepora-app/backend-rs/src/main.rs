mod a2a;
mod agent;
mod context;
mod core;
mod em_llm;
mod graph;
mod history;
mod llama;
mod llm;
mod mcp;
mod mcp_installer;
mod mcp_registry;
mod memory;
mod models;
mod rag;
mod server;
mod setup_state;
mod state;
mod tools;

use std::env;

use anyhow::Context;
use axum::Router;
use tokio::net::TcpListener;

use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let state = AppState::initialize().await?;
    core::logging::init(&state.paths);

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

    let app: Router = server::router::router(state.clone());

    // Initialize graph (check build)
    match graph::build_tepora_graph() {
        Ok(_) => tracing::info!("Graph initialized successfully"),
        Err(e) => tracing::error!("Failed to initialize graph: {}", e),
    }

    axum::serve(listener, app).await.context("Server error")?;

    Ok(())
}
