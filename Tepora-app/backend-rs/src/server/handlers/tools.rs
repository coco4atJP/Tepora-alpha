use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::json;

use crate::core::errors::ApiError;
use crate::core::native_tools::NATIVE_TOOLS;
use crate::mcp::McpToolInfo;
use crate::state::AppStateRead;

pub async fn list_tools(State(state): State<AppStateRead>) -> Result<impl IntoResponse, ApiError> {
    let mut tools: Vec<serde_json::Value> = NATIVE_TOOLS
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description
            })
        })
        .collect();

    let mcp_tools: Vec<McpToolInfo> = state.mcp.list_tools().await;
    for tool in mcp_tools {
        tools.push(json!({
            "name": tool.name,
            "description": tool.description
        }));
    }

    Ok(Json(json!({"tools": tools})))
}
