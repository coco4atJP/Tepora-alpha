use serde_json::Value;

use crate::core::errors::ApiError;
use crate::domain::errors::DomainError;
use crate::domain::knowledge::KnowledgeSource;
use crate::models::types::ModelRuntimeConfig;
use crate::rag::{ChunkSearchResult, StoredChunk};
use crate::state::AppState;

use super::dispatcher::ToolExecution;

pub async fn execute_rag_search(
    state: Option<&AppState>,
    config: &Value,
    session_id: Option<&str>,
    args: &Value,
) -> Result<ToolExecution, ApiError> {
    let state = require_state(state)?;

    let query = args
        .get("query")
        .or_else(|| args.get("q"))
        .or_else(|| args.get("input"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if query.is_empty() {
        return Err(ApiError::BadRequest("RAG query missing".to_string()));
    }

    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(5)
        .clamp(1, 20) as usize;
    let sid = session_id.unwrap_or("default");

    let model_cfg = ModelRuntimeConfig::for_embedding(config)?;
    let embeddings = state
        .llama
        .embed(&model_cfg, &[query], std::time::Duration::from_secs(5))
        .await?;
    let query_embedding = embeddings
        .first()
        .ok_or_else(|| ApiError::Internal("RAG query embedding is empty".to_string()))?;

    let results = state
        .knowledge_use_case
        .search(query_embedding, limit, Some(sid))
        .await
        .map_err(domain_error_to_api_error)?;
    let legacy_results = results
        .into_iter()
        .map(|hit| ChunkSearchResult {
            chunk: StoredChunk {
                chunk_id: hit.chunk_id,
                content: hit.content,
                source: hit.source,
                session_id: sid.to_string(),
                metadata: hit.metadata,
            },
            score: hit.score,
        })
        .collect::<Vec<_>>();
    let output = serde_json::to_string_pretty(&legacy_results).unwrap_or_default();

    Ok(ToolExecution {
        output,
        search_results: None,
    })
}

pub async fn execute_rag_ingest(
    state: Option<&AppState>,
    session_id: Option<&str>,
    args: &Value,
) -> Result<ToolExecution, ApiError> {
    let state = require_state(state)?;
    let sid = session_id.unwrap_or("default");

    let content = args
        .get("content")
        .or_else(|| args.get("text"))
        .or_else(|| args.get("input"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if content.is_empty() {
        return Err(ApiError::BadRequest("RAG content missing".to_string()));
    }

    let source = args
        .get("source")
        .or_else(|| args.get("name"))
        .or_else(|| args.get("url"))
        .and_then(|v| v.as_str())
        .unwrap_or("user_input")
        .trim()
        .to_string();

    let user_metadata = args.get("metadata").cloned();
    let inserted = state
        .knowledge_use_case
        .ingest(
            KnowledgeSource::Text {
                content,
                source: source.clone(),
                metadata: user_metadata,
            },
            sid,
        )
        .await
        .map_err(domain_error_to_api_error)?
        .len();

    let output = serde_json::json!({
        "status": "ok",
        "inserted_chunks": inserted,
        "session_id": sid,
        "source": source,
    })
    .to_string();

    Ok(ToolExecution {
        output,
        search_results: None,
    })
}

pub async fn execute_rag_text_search(
    state: Option<&AppState>,
    session_id: Option<&str>,
    args: &Value,
) -> Result<ToolExecution, ApiError> {
    let state = require_state(state)?;

    let pattern = args
        .get("pattern")
        .or_else(|| args.get("query"))
        .or_else(|| args.get("q"))
        .or_else(|| args.get("input"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if pattern.is_empty() {
        return Err(ApiError::BadRequest("RAG text pattern missing".to_string()));
    }

    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(10)
        .clamp(1, 50) as usize;
    let sid = session_id.unwrap_or("default");

    let results = state
        .knowledge_use_case
        .text_search(&pattern, limit, Some(sid))
        .await
        .map_err(domain_error_to_api_error)?;
    let legacy_results = results
        .into_iter()
        .map(|chunk| StoredChunk {
            chunk_id: chunk.chunk_id,
            content: chunk.content,
            source: chunk.source,
            session_id: chunk.session_id,
            metadata: chunk.metadata,
        })
        .collect::<Vec<_>>();
    let output = serde_json::to_string_pretty(&legacy_results).unwrap_or_default();

    Ok(ToolExecution {
        output,
        search_results: None,
    })
}

pub async fn execute_rag_get_chunk(
    state: Option<&AppState>,
    args: &Value,
) -> Result<ToolExecution, ApiError> {
    let state = require_state(state)?;

    let chunk_id = args
        .get("chunk_id")
        .or_else(|| args.get("chunkId"))
        .or_else(|| args.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if chunk_id.is_empty() {
        return Err(ApiError::BadRequest("chunk_id is required".to_string()));
    }

    let result = state
        .knowledge_use_case
        .get_chunk(&chunk_id)
        .await
        .map_err(domain_error_to_api_error)?;
    let legacy_result = result.map(|chunk| StoredChunk {
        chunk_id: chunk.chunk_id,
        content: chunk.content,
        source: chunk.source,
        session_id: chunk.session_id,
        metadata: chunk.metadata,
    });
    let output = serde_json::to_string_pretty(&legacy_result).unwrap_or_default();

    Ok(ToolExecution {
        output,
        search_results: None,
    })
}

pub async fn execute_rag_get_chunk_window(
    state: Option<&AppState>,
    session_id: Option<&str>,
    args: &Value,
) -> Result<ToolExecution, ApiError> {
    let state = require_state(state)?;

    let chunk_id = args
        .get("chunk_id")
        .or_else(|| args.get("chunkId"))
        .or_else(|| args.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if chunk_id.is_empty() {
        return Err(ApiError::BadRequest("chunk_id is required".to_string()));
    }

    let chars = args
        .get("chars")
        .or_else(|| args.get("max_chars"))
        .or_else(|| args.get("maxChars"))
        .and_then(|v| v.as_u64())
        .unwrap_or(1200)
        .clamp(128, 20000) as usize;

    let sid = session_id.unwrap_or("default");
    let result = state
        .knowledge_use_case
        .get_chunk_window(&chunk_id, chars, Some(sid))
        .await
        .map_err(domain_error_to_api_error)?;
    let legacy_result = result
        .into_iter()
        .map(|chunk| StoredChunk {
            chunk_id: chunk.chunk_id,
            content: chunk.content,
            source: chunk.source,
            session_id: chunk.session_id,
            metadata: chunk.metadata,
        })
        .collect::<Vec<_>>();
    let output = serde_json::to_string_pretty(&legacy_result).unwrap_or_default();

    Ok(ToolExecution {
        output,
        search_results: None,
    })
}

pub async fn execute_rag_clear_session(
    state: Option<&AppState>,
    session_id: Option<&str>,
    args: &Value,
) -> Result<ToolExecution, ApiError> {
    let state = require_state(state)?;

    let sid = args
        .get("session_id")
        .or_else(|| args.get("sessionId"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| session_id.unwrap_or("default"));

    let deleted = state
        .knowledge_use_case
        .clear_session(sid)
        .await
        .map_err(domain_error_to_api_error)?;
    let output = serde_json::json!({
        "status": "ok",
        "session_id": sid,
        "deleted_chunks": deleted,
    })
    .to_string();

    Ok(ToolExecution {
        output,
        search_results: None,
    })
}

pub async fn execute_rag_reindex(
    state: Option<&AppState>,
    args: &Value,
) -> Result<ToolExecution, ApiError> {
    let state = require_state(state)?;

    let embedding_model = args
        .get("embedding_model")
        .or_else(|| args.get("embeddingModel"))
        .or_else(|| args.get("model"))
        .and_then(|v| v.as_str())
        .unwrap_or("default")
        .trim();

    state
        .knowledge_use_case
        .reindex(embedding_model)
        .await
        .map_err(domain_error_to_api_error)?;

    let output = serde_json::json!({
        "status": "ok",
        "embedding_model": embedding_model,
    })
    .to_string();

    Ok(ToolExecution {
        output,
        search_results: None,
    })
}

fn require_state(state: Option<&AppState>) -> Result<&AppState, ApiError> {
    state.ok_or_else(|| ApiError::BadRequest("RAG tool requires application state".to_string()))
}

fn domain_error_to_api_error(err: DomainError) -> ApiError {
    match err {
        DomainError::InvalidInput(message) => ApiError::BadRequest(message),
        DomainError::NotSupported(message) => ApiError::NotImplemented(message),
        DomainError::Storage(message) => ApiError::Internal(message),
    }
}
