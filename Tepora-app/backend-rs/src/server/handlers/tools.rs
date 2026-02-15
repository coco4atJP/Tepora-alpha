use std::sync::Arc;
use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use axum::http::HeaderMap;
use serde_json::json;

use crate::state::AppState;
use crate::core::errors::ApiError;
use crate::core::security::require_api_key;
use crate::mcp::McpToolInfo;

pub async fn list_tools(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let mut tools = Vec::new();
    tools.push(json!({
        "name": "native_web_fetch",
        "description": "Fetch content from a URL"
    }));
    tools.push(json!({
        "name": "native_search",
        "description": "Search the web"
    }));
    tools.push(json!({
        "name": "native_rag_search",
        "description": "Search RAG by embedding similarity"
    }));
    tools.push(json!({
        "name": "native_rag_ingest",
        "description": "Ingest text into RAG"
    }));
    tools.push(json!({
        "name": "native_rag_text_search",
        "description": "Search RAG by text pattern"
    }));
    tools.push(json!({
        "name": "native_rag_get_chunk",
        "description": "Get one RAG chunk by ID"
    }));
    tools.push(json!({
        "name": "native_rag_get_chunk_window",
        "description": "Get neighboring RAG chunks around one chunk"
    }));
    tools.push(json!({
        "name": "native_rag_clear_session",
        "description": "Clear all RAG chunks for a session"
    }));
    tools.push(json!({
        "name": "native_rag_reindex",
        "description": "Reindex RAG with a specific embedding model"
    }));

    let mcp_tools: Vec<McpToolInfo> = state.mcp.list_tools().await;
    for tool in mcp_tools {
        tools.push(json!({
            "name": tool.name,
            "description": tool.description
        }));
    }

    Ok(Json(json!({"tools": tools})))
}
