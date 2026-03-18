use serde_json::Value;

use crate::core::errors::ApiError;
use crate::mcp::McpManager;
use crate::state::AppState;

use super::rag::{
    execute_rag_clear_session, execute_rag_get_chunk, execute_rag_get_chunk_window,
    execute_rag_ingest, execute_rag_reindex, execute_rag_search, execute_rag_text_search,
};
use super::web::{execute_search, execute_web_fetch};
use super::web_security::is_isolation_mode;

#[derive(Debug, Clone)]
pub struct ToolExecution {
    pub output: String,
    pub search_results: Option<Vec<super::search::SearchResult>>,
}

pub async fn execute_tool(
    state: Option<&AppState>,
    config: &Value,
    mcp: Option<&McpManager>,
    session_id: Option<&str>,
    tool_name: &str,
    args: &Value,
) -> Result<ToolExecution, ApiError> {
    match tool_name {
        "native_web_fetch" | "native_fetch" | "web_fetch" => execute_web_fetch(config, args).await,
        "native_google_search" | "native_duckduckgo" | "native_search" | "search" => {
            execute_search(config, args).await
        }
        "rag_search" | "native_rag_search" => {
            execute_rag_search(state, config, session_id, args).await
        }
        "rag_ingest" | "native_rag_ingest" => execute_rag_ingest(state, session_id, args).await,
        "rag_text_search" | "native_rag_text_search" => {
            execute_rag_text_search(state, config, session_id, args).await
        }
        "rag_get_chunk" | "native_rag_get_chunk" => execute_rag_get_chunk(state, args).await,
        "rag_get_chunk_window" | "native_rag_get_chunk_window" => {
            execute_rag_get_chunk_window(state, config, session_id, args).await
        }
        "rag_clear_session" | "native_rag_clear_session" => {
            execute_rag_clear_session(state, session_id, args).await
        }
        "rag_reindex" | "native_rag_reindex" => execute_rag_reindex(state, args).await,
        _ => {
            if is_isolation_mode(config) {
                return Err(ApiError::Forbidden);
            }
            if let Some(manager) = mcp {
                let output = manager.execute_tool(tool_name, args).await?;
                return Ok(ToolExecution {
                    output,
                    search_results: None,
                });
            }
            Err(ApiError::BadRequest(format!("Unknown tool: {}", tool_name)))
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[tokio::test]
    async fn unknown_tool_is_rejected_without_mcp() {
        let result = execute_tool(None, &json!({}), None, None, "missing_tool", &json!({})).await;
        assert!(
            matches!(result, Err(ApiError::BadRequest(message)) if message.contains("missing_tool"))
        );
    }

    #[tokio::test]
    async fn isolation_mode_blocks_unknown_tool_fallback() {
        let result = execute_tool(
            None,
            &json!({"privacy": {"isolation_mode": true}}),
            None,
            None,
            "missing_tool",
            &json!({}),
        )
        .await;
        assert!(matches!(result, Err(ApiError::Forbidden)));
    }
}
