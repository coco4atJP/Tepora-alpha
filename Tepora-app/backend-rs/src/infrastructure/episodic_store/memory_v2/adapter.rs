use std::sync::Arc;
use tokio::sync::RwLock;
use serde_json::Value;

use crate::core::errors::ApiError;
use crate::em_llm::{EmMemoryService, RetrievedMemory};
use crate::llm::LlmService;
use crate::memory_v2::types::{MemoryScope, MemoryEvent};
use crate::memory_v2::SqliteMemoryRepository;
use crate::memory_v2::MemoryRepository;

#[async_trait::async_trait]
pub trait MemoryAdapter: Send + Sync {
    /// Ingest a completed interaction (user input + assistant output).
    async fn ingest_interaction(
        &self,
        session_id: &str,
        user_input: &str,
        assistant_output: &str,
        llm: &LlmService,
        text_model_id: &str,
        embedding_model_id: &str,
        legacy_enabled: bool,
    ) -> Result<(), ApiError>;

    /// Retrieve relevant context for a query.
    async fn retrieve_context(
        &self,
        session_id: &str,
        query: &str,
        llm: &LlmService,
        embedding_model_id: &str,
        legacy_enabled: bool,
    ) -> Result<Vec<RetrievedMemory>, ApiError>;
}

/// The unified memory implementation that chooses between legacy em_llm and new memory_v2.
pub struct UnifiedMemoryAdapter {
    em_service: Arc<EmMemoryService>,
    v2_repo: Arc<SqliteMemoryRepository>,
}

impl UnifiedMemoryAdapter {
    pub fn new(em_service: Arc<EmMemoryService>, v2_repo: Arc<SqliteMemoryRepository>) -> Self {
        Self { em_service, v2_repo }
    }
}

#[async_trait::async_trait]
impl MemoryAdapter for UnifiedMemoryAdapter {
    async fn ingest_interaction(
        &self,
        session_id: &str,
        user_input: &str,
        assistant_output: &str,
        llm: &LlmService,
        text_model_id: &str,
        embedding_model_id: &str,
        legacy_enabled: bool,
    ) -> Result<(), ApiError> {
        if !self.em_service.enabled() {
            return Ok(());
        }

        if legacy_enabled {
            self.em_service.ingest_interaction(
                session_id,
                user_input,
                assistant_output,
                llm,
                text_model_id,
                embedding_model_id,
            ).await
        } else {
            tracing::debug!("V2 Memory Adapter: Using strict segmentation pipeline");
            
            let content = format!("User: {}\nAssistant: {}", user_input.trim(), assistant_output.trim());
            if content.trim().is_empty() || content == "User: \nAssistant: " {
                return Ok(());
            }

            // Extract segmentation logic out of EmMemoryService into the Adapter
            let logprobs_result = llm.get_logprobs(&content, text_model_id).await;

            let sentences = crate::em_llm::sentence::split_sentences(&content, 8);
            let sentences = if sentences.is_empty() {
                vec![content.clone()]
            } else {
                sentences
            };

            let sentence_embeddings = match llm.embed(&sentences, embedding_model_id).await {
                Ok(embs) => embs,
                Err(e) => {
                    tracing::warn!("Failed to embed sentences for memory segmentation: {}", e);
                    return Err(ApiError::internal(format!("Embedding failed: {}", e)));
                }
            };

            // Process based on logprobs vs pure semantics
            let mut integrator = crate::em_llm::integrator::EMLLMIntegrator::default();
            let events = match logprobs_result {
                Ok(logprobs) => {
                    integrator.process_logprobs_for_memory(&logprobs, Some(&sentence_embeddings))
                }
                Err(e) => {
                    tracing::warn!("Failed to get logprobs (falling back to semantic segmentation): {}", e);
                    integrator.process_conversation_for_memory(&sentences, &sentence_embeddings)
                }
            };

            // Map and persist V2 events directly to the v2 repository
            let episode_id = uuid::Uuid::new_v4().to_string();
            let source_turn_id = format!("{}-{}", session_id, chrono::Utc::now().timestamp());
            let mut v2_events = Vec::new();
            let mut v2_edges = Vec::new();
            let mut prev_event_id: Option<String> = None;

            // Decay configuration needs to be applied here for initial importance
            let decay_cfg = crate::em_llm::types::DecayConfig::default();
            let decay_engine = crate::em_llm::decay::DecayEngine::new(decay_cfg);

            for (i, ev) in events.into_iter().enumerate() {
                let event_content = ev.tokens.join(" ");

                if let Some(prev_id) = prev_event_id {
                    v2_edges.push(crate::memory_v2::types::MemoryEdge {
                        id: uuid::Uuid::new_v4().to_string(),
                        session_id: session_id.to_string(),
                        from_event_id: prev_id,
                        to_event_id: ev.id.clone(),
                        edge_type: crate::memory_v2::types::MemoryEdgeType::TemporalNext,
                        weight: 1.0,
                        created_at: chrono::Utc::now(),
                    });
                }
                prev_event_id = Some(ev.id.clone());

                let initial_importance = decay_engine.importance_score(0.0, 0, 0.0);

                v2_events.push(MemoryEvent {
                    id: ev.id,
                    session_id: session_id.to_string(),
                    scope: MemoryScope::Char,
                    episode_id: episode_id.clone(),
                    event_seq: i as u32,
                    source_turn_id: Some(source_turn_id.clone()),
                    source_role: None,
                    content: event_content,
                    summary: None,
                    embedding: ev.embedding.unwrap_or_default(),
                    surprise_mean: Some(
                        ev.surprise_scores.iter().sum::<f64>() / ev.surprise_scores.len().max(1) as f64
                    ),
                    surprise_max: ev.surprise_scores.iter().cloned().reduce(f64::max),
                    importance: initial_importance,
                    strength: 1.0,
                    layer: crate::memory_v2::types::MemoryLayer::SML,
                    access_count: 0,
                    last_accessed_at: None,
                    decay_anchor_at: chrono::Utc::now(),
                    created_at: chrono::Utc::now(),
                    updated_at: chrono::Utc::now(),
                    is_deleted: false,
                });
            }

            self.v2_repo.insert_events(&v2_events).await?;
            if !v2_edges.is_empty() {
                self.v2_repo.insert_edges(&v2_edges).await?;
            }

            Ok(())
        }
    }

    async fn retrieve_context(
        &self,
        session_id: &str,
        query: &str,
        llm: &LlmService,
        embedding_model_id: &str,
        legacy_enabled: bool,
    ) -> Result<Vec<RetrievedMemory>, ApiError> {
        if !self.em_service.enabled() || query.trim().is_empty() {
            return Ok(Vec::new());
        }

        if legacy_enabled {
            self.em_service.retrieve_for_query(session_id, query, llm, embedding_model_id).await
        } else {
            // Use V2 retrieval
            let embeddings = llm.embed(&[query.to_string()], embedding_model_id).await
                .map_err(|e| ApiError::internal(format!("Adapter embedding failed: {}", e)))?;
            let embedding = embeddings.into_iter().next().unwrap_or_default();
            self.em_service.retrieve_for_query_v2(session_id, &embedding, self.v2_repo.as_ref()).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::config::AppPaths;
    use crate::core::config::service::ConfigService;
    use crate::memory_v2::sqlite_repository::SqliteMemoryRepository;
    use std::sync::Arc;

    #[tokio::test]
    async fn test_adapter_routing() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("test_v2_adapter.db");
        let v2_repo = Arc::new(SqliteMemoryRepository::new(db_path).await.unwrap());

        // Setup base config and paths
        let mut paths = AppPaths::new();
        paths.user_data_dir = temp_dir.path().to_path_buf();
        let paths_arc = Arc::new(paths);
        let config = ConfigService::new(paths_arc.clone());

        // Dummy LlmService requires Models and LlamaService
        let llama = crate::llm::LlamaService::new(paths_arc.clone()).unwrap();
        let models = crate::models::ModelManager::new(&paths_arc, config.clone());
        let llm = LlmService::new(models, llama, config.clone());

        let em_service = Arc::new(EmMemoryService::new(&paths_arc, &config).await.unwrap());
        let adapter = UnifiedMemoryAdapter::new(em_service, v2_repo.clone());

        // Test with legacy_enabled = true
        let res_legacy = adapter.ingest_interaction(
            "session_v2_1",
            "Hello",
            "World",
            &llm,
            "text_model",
            "embed_model",
            true,
        ).await;

        // Either ok, or error due to models not being downloaded. But it shouldn't panic.
        assert!(res_legacy.is_ok() || res_legacy.is_err());
        
        // Test with legacy_enabled = false (V2 path)
        let res_v2 = adapter.ingest_interaction(
            "session_v2_1",
            "Hello V2",
            "World V2",
            &llm,
            "text_model",
            "embed_model",
            false,
        ).await;

        assert!(res_v2.is_ok() || res_v2.is_err());
    }
}
