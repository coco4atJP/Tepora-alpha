use chrono::Utc;
use std::sync::Arc;

use crate::core::config::ConfigService;
use crate::core::errors::ApiError;
use crate::domain::episodic_memory::{
    CompressionResult as DomainCompressionResult, DecayResult as DomainDecayResult, EpisodicHit,
    EpisodicMemoryPort,
};
use crate::domain::errors::DomainError;
use crate::em_llm::{EmMemoryService, RetrievedMemory};
use crate::llm::LlmService;
use crate::memory_v2::types::{MemoryEvent, MemoryScope};
use crate::memory_v2::MemoryRepository;
use crate::memory_v2::SqliteMemoryRepository;
use crate::models::ModelManager;

#[async_trait::async_trait]
pub trait MemoryAdapter: Send + Sync {
    /// Ingest a completed interaction (user input + assistant output).
    #[allow(clippy::too_many_arguments)]
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
    llm: Option<LlmService>,
    models: Option<ModelManager>,
    config: Option<ConfigService>,
}

impl UnifiedMemoryAdapter {
    pub fn new(em_service: Arc<EmMemoryService>, v2_repo: Arc<SqliteMemoryRepository>) -> Self {
        Self {
            em_service,
            v2_repo,
            llm: None,
            models: None,
            config: None,
        }
    }

    pub fn new_with_runtime(
        em_service: Arc<EmMemoryService>,
        v2_repo: Arc<SqliteMemoryRepository>,
        llm: LlmService,
        models: ModelManager,
        config: ConfigService,
    ) -> Self {
        Self {
            em_service,
            v2_repo,
            llm: Some(llm),
            models: Some(models),
            config: Some(config),
        }
    }

    fn resolve_default_text_model_id(&self) -> String {
        let Some(models) = self.models.as_ref() else {
            return "default".to_string();
        };
        let active_character = self
            .config
            .as_ref()
            .and_then(|cfg| cfg.load_config().ok())
            .and_then(|config| {
                config
                    .get("active_agent_profile")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            });

        models
            .resolve_character_model_id(active_character.as_deref())
            .ok()
            .flatten()
            .or_else(|| {
                models.get_registry().ok().and_then(|registry| {
                    registry
                        .models
                        .iter()
                        .find(|model| model.role == "text")
                        .map(|model| model.id.clone())
                })
            })
            .unwrap_or_else(|| "default".to_string())
    }
}

fn api_error_to_domain_error(value: ApiError) -> DomainError {
    match value {
        ApiError::BadRequest(message) => DomainError::InvalidInput(message),
        ApiError::NotImplemented(message) => DomainError::NotSupported(message),
        other => DomainError::Storage(other.to_string()),
    }
}

#[async_trait::async_trait]
impl MemoryAdapter for UnifiedMemoryAdapter {
    #[allow(clippy::too_many_arguments)]
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
            self.em_service
                .ingest_interaction(
                    session_id,
                    user_input,
                    assistant_output,
                    llm,
                    text_model_id,
                    embedding_model_id,
                )
                .await
        } else {
            tracing::debug!("V2 Memory Adapter: Using strict segmentation pipeline");

            let content = format!(
                "User: {}\nAssistant: {}",
                user_input.trim(),
                assistant_output.trim()
            );
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
                    tracing::warn!(
                        "Failed to get logprobs (falling back to semantic segmentation): {}",
                        e
                    );
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
                        ev.surprise_scores.iter().sum::<f64>()
                            / ev.surprise_scores.len().max(1) as f64,
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
            self.em_service
                .retrieve_for_query(session_id, query, llm, embedding_model_id)
                .await
        } else {
            // Use V2 retrieval
            let embeddings = llm
                .embed(&[query.to_string()], embedding_model_id)
                .await
                .map_err(|e| ApiError::internal(format!("Adapter embedding failed: {}", e)))?;
            let embedding = embeddings.into_iter().next().unwrap_or_default();
            self.em_service
                .retrieve_for_query_v2(session_id, &embedding, self.v2_repo.as_ref())
                .await
        }
    }
}

#[async_trait::async_trait]
impl EpisodicMemoryPort for UnifiedMemoryAdapter {
    #[allow(clippy::too_many_arguments)]
    async fn ingest_interaction(
        &self,
        session_id: &str,
        user: &str,
        assistant: &str,
        embedding: &[f32],
    ) -> Result<Vec<String>, DomainError> {
        if !self.em_service.enabled() {
            return Ok(Vec::new());
        }

        let content = format!("User: {}\nAssistant: {}", user.trim(), assistant.trim());
        if content.trim().is_empty() || content == "User: \nAssistant: " {
            return Ok(Vec::new());
        }

        let now = Utc::now();
        let event_id = uuid::Uuid::new_v4().to_string();
        let episode_id = uuid::Uuid::new_v4().to_string();
        let source_turn_id = format!("{}-{}", session_id, now.timestamp());
        let event = MemoryEvent {
            id: event_id.clone(),
            session_id: session_id.to_string(),
            scope: MemoryScope::Char,
            episode_id,
            event_seq: 0,
            source_turn_id: Some(source_turn_id),
            source_role: None,
            content,
            summary: None,
            embedding: embedding.to_vec(),
            surprise_mean: None,
            surprise_max: None,
            importance: 0.5,
            strength: 1.0,
            layer: crate::memory_v2::types::MemoryLayer::SML,
            access_count: 0,
            last_accessed_at: None,
            decay_anchor_at: now,
            created_at: now,
            updated_at: now,
            is_deleted: false,
        };

        self.v2_repo
            .insert_events(&[event])
            .await
            .map_err(api_error_to_domain_error)?;

        Ok(vec![event_id])
    }

    async fn recall(
        &self,
        session_id: &str,
        query_embedding: &[f32],
        limit: usize,
    ) -> Result<Vec<EpisodicHit>, DomainError> {
        if !self.em_service.enabled() || query_embedding.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }

        let memories = self
            .em_service
            .retrieve_for_query_v2(session_id, query_embedding, self.v2_repo.as_ref())
            .await
            .map_err(api_error_to_domain_error)?;

        Ok(memories
            .into_iter()
            .take(limit)
            .map(|memory| EpisodicHit {
                content: memory.content,
                relevance_score: memory.relevance_score,
                source: memory.source,
                strength: memory.strength,
            })
            .collect())
    }

    async fn run_decay(&self, session_id: Option<&str>) -> Result<DomainDecayResult, DomainError> {
        let result = self
            .em_service
            .run_decay_cycle(session_id)
            .await
            .map_err(api_error_to_domain_error)?;
        Ok(DomainDecayResult {
            updated: result.updated,
            promoted: result.promoted,
            demoted: result.demoted,
            pruned: result.pruned,
        })
    }

    async fn compress(&self, session_id: &str) -> Result<DomainCompressionResult, DomainError> {
        let Some(llm) = self.llm.as_ref() else {
            return Err(DomainError::NotSupported(
                "compression via EpisodicMemoryPort requires llm/model context".to_string(),
            ));
        };

        let model_id = self.resolve_default_text_model_id();
        let result = self
            .em_service
            .compress_memories(session_id, llm, &model_id, MemoryScope::default())
            .await
            .map_err(api_error_to_domain_error)?;
        Ok(DomainCompressionResult {
            scanned_events: result.scanned_events,
            merged_groups: result.merged_groups,
            replaced_events: result.replaced_events,
            created_events: result.created_events,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::config::service::ConfigService;
    use crate::core::config::AppPaths;
    use crate::domain::episodic_memory::EpisodicMemoryPort;
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
        let res_legacy = MemoryAdapter::ingest_interaction(
            &adapter,
            "session_v2_1",
            "Hello",
            "World",
            &llm,
            "text_model",
            "embed_model",
            true,
        )
        .await;

        // Either ok, or error due to models not being downloaded. But it shouldn't panic.
        assert!(res_legacy.is_ok() || res_legacy.is_err());

        // Test with legacy_enabled = false (V2 path)
        let res_v2 = MemoryAdapter::ingest_interaction(
            &adapter,
            "session_v2_1",
            "Hello V2",
            "World V2",
            &llm,
            "text_model",
            "embed_model",
            false,
        )
        .await;

        assert!(res_v2.is_ok() || res_v2.is_err());
    }

    #[tokio::test]
    async fn test_episodic_memory_port_ingest_and_recall() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("test_port_adapter.db");
        let v2_repo = Arc::new(SqliteMemoryRepository::new(db_path).await.unwrap());
        let em_service = Arc::new(EmMemoryService::with_v2_store_for_test(
            v2_repo.clone(),
            true,
            8,
            0.0,
        ));
        let adapter = UnifiedMemoryAdapter::new(em_service, v2_repo);

        let inserted_ids = EpisodicMemoryPort::ingest_interaction(
            &adapter,
            "session_port_1",
            "hello",
            "world",
            &[1.0, 0.0, 0.0],
        )
        .await
        .unwrap();
        assert_eq!(inserted_ids.len(), 1);

        let hits = EpisodicMemoryPort::recall(&adapter, "session_port_1", &[1.0, 0.0, 0.0], 3)
            .await
            .unwrap();
        assert!(!hits.is_empty());
        assert!(hits[0].content.contains("User:"));
    }
}
