//! ToolWorker — Injects available tool definitions into the pipeline.
//!
//! Collects native tools and MCP tools and adds their definitions to the
//! `PipelineContext` so the LLM knows which tools are available.

use std::sync::Arc;

use async_trait::async_trait;

use crate::context::pipeline_context::PipelineContext;
use crate::context::worker::{ContextWorker, WorkerError};
use crate::state::AppState;

/// Worker that injects tool definitions.
pub struct ToolWorker;

impl ToolWorker {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ToolWorker {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ContextWorker for ToolWorker {
    fn name(&self) -> &str {
        "tool"
    }

    async fn execute(
        &self,
        ctx: &mut PipelineContext,
        state: &Arc<AppState>,
    ) -> Result<(), WorkerError> {
        // Only inject tools for modes that support them
        if !ctx.mode.has_tools() {
            return Err(WorkerError::skipped("tool", "mode does not use tools"));
        }

        let mut tool_definitions = Vec::new();

        // 1. Native tools — web_search, fetch_url
        if ctx.mode.has_web_search() {
            tool_definitions.push(
                "web_search(query: string) — Searches the web and returns results.".to_string(),
            );
            tool_definitions
                .push("fetch_url(url: string) — Fetches content from a URL.".to_string());
        }

        // 2. RAG tools
        if ctx.mode.has_rag() {
            tool_definitions.push(
                "rag_search(query: string, limit?: int) — Searches the RAG store for similar content.".to_string(),
            );
            tool_definitions.push(
                "rag_ingest(content: string, source: string) — Ingests content into the RAG store."
                    .to_string(),
            );
            tool_definitions.push(
                "rag_text_search(pattern: string, limit?: int) — Searches RAG chunks by text pattern.".to_string(),
            );
            tool_definitions.push(
                "rag_get_chunk(chunk_id: string) — Retrieves a specific RAG chunk.".to_string(),
            );
            tool_definitions.push(
                "rag_get_chunk_window(chunk_id: string, chars?: int) — Retrieves neighboring chunks around one chunk.".to_string(),
            );
            tool_definitions.push(
                "rag_clear_session(session_id?: string) — Clears all RAG chunks in a session."
                    .to_string(),
            );
            tool_definitions.push(
                "rag_reindex(embedding_model?: string) — Rebuilds the RAG index after embedding model changes.".to_string(),
            );
        }

        // 3. MCP tools — enumerate available servers and their tools
        let mcp_tools = state.mcp.list_tools().await;
        for tool in mcp_tools {
            tool_definitions.push(format!("mcp:{} — {}", tool.name, tool.description));
        }

        // Inject tool information into the context
        if !tool_definitions.is_empty() {
            let tools_text = tool_definitions.join("\n");
            ctx.add_system_part(
                "available_tools",
                format!("[Available Tools]\n{tools_text}"),
                80,
            );
        }

        Ok(())
    }
}
