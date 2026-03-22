use chrono::Utc;
use std::sync::Arc;

use crate::context::pipeline_context::{PipelineMode, PipelineStage};
use crate::core::config::ConfigService;
use crate::core::errors::ApiError;
use crate::domain::episodic_memory::{
    CompressionResult as DomainCompressionResult, DecayResult as DomainDecayResult, EpisodicHit,
    EpisodicMemoryPort,
};
use crate::domain::errors::DomainError;
use crate::llm::LlmService;
use crate::models::ModelManager;

use super::decay::DecayEngine;
use super::integrator::EMLLMIntegrator;
use super::repository::MemoryRepository;
use super::sentence::split_sentences;
use super::service::{MemoryService, RetrievedMemory};
use super::sqlite_repository::SqliteMemoryRepository;
use super::types::{
    DecayConfig, MemoryEdge, MemoryEdgeType, MemoryEvent, MemoryLayer, MemoryScope, SourceRole,
};

#[allow(clippy::too_many_arguments)]
#[async_trait::async_trait]
pub trait MemoryAdapter: Send + Sync {
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

    async fn retrieve_context(
        &self,
        session_id: &str,
        query: &str,
        llm: &LlmService,
        embedding_model_id: &str,
        legacy_enabled: bool,
        mode: PipelineMode,
        stage: PipelineStage,
    ) -> Result<Vec<RetrievedMemory>, ApiError>;

    async fn ingest_summary(
        &self,
        session_id: &str,
        summary: &str,
        llm: &LlmService,
        embedding_model_id: &str,
        scope: MemoryScope,
    ) -> Result<(), ApiError>;
}

pub struct UnifiedMemoryAdapter {
    em_service: Arc<MemoryService>,
    v2_repo: Arc<SqliteMemoryRepository>,
    llm: Option<LlmService>,
    models: Option<ModelManager>,
    config: Option<ConfigService>,
}

impl UnifiedMemoryAdapter {
    pub fn new(em_service: Arc<MemoryService>, v2_repo: Arc<SqliteMemoryRepository>) -> Self {
        Self {
            em_service,
            v2_repo,
            llm: None,
            models: None,
            config: None,
        }
    }

    pub fn new_with_runtime(
        em_service: Arc<MemoryService>,
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
        let active_character = self.resolve_active_character_id();

        models
            .resolve_character_model(active_character.as_deref())
            .ok()
            .flatten()
            .or_else(|| models.find_first_model_by_role("text").ok().flatten())
            .map(|model| model.id)
            .unwrap_or_else(|| "default".to_string())
    }

    fn resolve_active_character_id(&self) -> Option<String> {
        self.config
            .as_ref()
            .and_then(|cfg| cfg.load_config().ok())
            .and_then(|config| {
                config
                    .get("active_character")
                    .or_else(|| config.get("active_agent_profile"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
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

            let logprobs_result = llm.get_logprobs(&content, text_model_id).await;
            let sentences = split_sentences(&content, 8);
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

            let mut integrator = EMLLMIntegrator::default();
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

            let active_character_id = self.resolve_active_character_id();
            let episode_id = uuid::Uuid::new_v4().to_string();
            let source_turn_id = format!("{}-{}", session_id, chrono::Utc::now().timestamp());
            let mut v2_events = Vec::new();
            let mut v2_edges = Vec::new();
            let mut prev_event_id: Option<String> = None;

            let decay_cfg = DecayConfig::default();
            let decay_engine = DecayEngine::new(decay_cfg);

            for (i, ev) in events.into_iter().enumerate() {
                let event_content = ev.tokens.join(" ");

                if let Some(prev_id) = prev_event_id {
                    v2_edges.push(MemoryEdge {
                        id: uuid::Uuid::new_v4().to_string(),
                        session_id: session_id.to_string(),
                        from_event_id: prev_id,
                        to_event_id: ev.id.clone(),
                        edge_type: MemoryEdgeType::TemporalNext,
                        weight: 1.0,
                        created_at: chrono::Utc::now(),
                    });
                }
                prev_event_id = Some(ev.id.clone());

                let initial_importance = decay_engine.importance_score(0.0, 0, 0.0);

                v2_events.push(MemoryEvent {
                    id: ev.id,
                    session_id: session_id.to_string(),
                    character_id: active_character_id.clone(),
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
                    layer: MemoryLayer::SML,
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
        mode: PipelineMode,
        stage: PipelineStage,
    ) -> Result<Vec<RetrievedMemory>, ApiError> {
        if !self.em_service.enabled() || query.trim().is_empty() {
            return Ok(Vec::new());
        }

        if legacy_enabled {
            self.em_service
                .retrieve_for_query(session_id, query, llm, embedding_model_id)
                .await
        } else {
            let embeddings = llm
                .embed(&[query.to_string()], embedding_model_id)
                .await
                .map_err(|e| ApiError::internal(format!("Adapter embedding failed: {}", e)))?;
            let embedding = embeddings.into_iter().next().unwrap_or_default();
            self.em_service
                .retrieve_for_query_v2_scoped(
                    session_id,
                    &embedding,
                    self.v2_repo.as_ref(),
                    mode,
                    stage,
                )
                .await
        }
    }

    async fn ingest_summary(
        &self,
        session_id: &str,
        summary: &str,
        llm: &LlmService,
        embedding_model_id: &str,
        scope: MemoryScope,
    ) -> Result<(), ApiError> {
        let normalized = summary.trim();
        if !self.em_service.enabled() || normalized.is_empty() {
            return Ok(());
        }

        let embedding = llm
            .embed(&[normalized.to_string()], embedding_model_id)
            .await
            .map_err(|e| ApiError::internal(format!("Summary embedding failed: {}", e)))?
            .into_iter()
            .next()
            .unwrap_or_default();

        let now = Utc::now();
        let event = MemoryEvent {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            character_id: self.resolve_active_character_id(),
            scope,
            episode_id: uuid::Uuid::new_v4().to_string(),
            event_seq: 0,
            source_turn_id: Some(format!("{}-{}", session_id, now.timestamp())),
            source_role: Some(SourceRole::System),
            content: normalized.to_string(),
            summary: Some(normalized.to_string()),
            embedding,
            surprise_mean: None,
            surprise_max: None,
            importance: 0.7,
            strength: 1.0,
            layer: MemoryLayer::SML,
            access_count: 0,
            last_accessed_at: None,
            decay_anchor_at: now,
            created_at: now,
            updated_at: now,
            is_deleted: false,
        };

        self.v2_repo.insert_events(&[event]).await
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
        let active_character_id = self.resolve_active_character_id();
        let event_id = uuid::Uuid::new_v4().to_string();
        let episode_id = uuid::Uuid::new_v4().to_string();
        let source_turn_id = format!("{}-{}", session_id, now.timestamp());
        let event = MemoryEvent {
            id: event_id.clone(),
            session_id: session_id.to_string(),
            character_id: active_character_id,
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
            layer: MemoryLayer::SML,
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
