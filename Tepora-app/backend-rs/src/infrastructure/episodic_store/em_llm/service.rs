use std::sync::Arc;

use chrono::{DateTime, Utc};
use rand::Rng;
use serde::Serialize;
use serde_json::Value;

use crate::core::config::{AppPaths, ConfigService};
use crate::core::errors::ApiError;
use crate::infrastructure::episodic_store::{
    CompactionJob, CompactionStatus, MemoryEdge, MemoryEdgeType, MemoryEvent, MemoryRepository,
    MemoryScope, ScoredEvent, SourceRole, SqliteMemoryRepository,
};
use crate::llm::LlmService;

use super::compression::{CompressionResult, MemoryCompressor};
use super::decay::DecayEngine;
use super::integrator::EMLLMIntegrator;
use super::sentence::split_sentences;
use super::types::{DecayConfig, MemoryLayer};

const KEYRING_SERVICE: &str = "tepora-backend";
const KEYRING_USER: &str = "em_memory_encryption_key";

#[derive(Debug, Clone, Serialize)]
pub struct EmMemoryStats {
    pub enabled: bool,
    pub total_events: usize,
    pub retrieval_limit: usize,
    pub min_score: f32,
    pub lml_events: usize,
    pub sml_events: usize,
    pub mean_strength: f64,
    // Scope specific stats
    pub char_events: usize,
    pub char_lml: usize,
    pub char_sml: usize,
    pub char_mean_strength: f64,
    pub prof_events: usize,
    pub prof_lml: usize,
    pub prof_sml: usize,
    pub prof_mean_strength: f64,
}

#[derive(Debug, Clone)]
pub struct RetrievedMemory {
    pub content: String,
    pub relevance_score: f32,
    pub source: String,
    pub strength: f64,
    pub memory_layer: MemoryLayer,
}

#[derive(Debug, Clone, Serialize)]
pub struct DecayCycleResult {
    pub updated: usize,
    pub promoted: usize,
    pub demoted: usize,
    pub pruned: usize,
}

#[derive(Clone)]
pub struct EmMemoryService {
    pub v2_store: Arc<SqliteMemoryRepository>,
    enabled: bool,
    retrieval_limit: usize,
    min_score: f32,
    decay_config: DecayConfig,
    decay_interval_hours: f64,
}

impl EmMemoryService {
    pub async fn new(paths: &AppPaths, config_service: &ConfigService) -> Result<Self, ApiError> {
        let config = config_service
            .load_config()
            .unwrap_or_else(|_| Value::Object(Default::default()));

        let enabled = config
            .get("em_llm")
            .and_then(|v| v.get("enabled"))
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        let retrieval_limit = config
            .get("em_llm")
            .and_then(|v| v.get("retrieval_limit"))
            .and_then(|v| v.as_u64())
            .unwrap_or(5)
            .clamp(1, 20) as usize;

        let min_score = config
            .get("em_llm")
            .and_then(|v| v.get("min_score"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.15)
            .clamp(-1.0, 1.0) as f32;

        let decay_config = parse_decay_config(&config);
        let decay_interval_hours = config
            .get("em_llm")
            .and_then(|v| v.get("decay_interval_hours"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
            .clamp(0.0, 24.0);

        if let Some(memory_version) = config
            .get("em_llm")
            .and_then(|v| v.get("memory_version"))
            .and_then(|v| v.as_str())
        {
            if !memory_version.eq_ignore_ascii_case("v2") {
                tracing::warn!(
                    memory_version = memory_version,
                    "em_llm.memory_version is deprecated and forced to v2"
                );
            }
        }

        let v2_db_path = paths.user_data_dir.join("em_memory.db");
        let mut v2_repo = SqliteMemoryRepository::new(v2_db_path)
            .await
            .map_err(|e| ApiError::internal(format!("Failed to initialize v2 memory repository: {e}")))?;

        // Initialize encryption key
        match get_or_create_encryption_key() {
            Ok(key) => {
                v2_repo.set_encryption_key(&key);
            }
            Err(e) => tracing::warn!("Failed to initialize encryption key: {}", e),
        }

        let service = Self {
            v2_store: Arc::new(v2_repo),
            enabled,
            retrieval_limit,
            min_score,
            decay_config,
            decay_interval_hours,
        };

        if let Err(err) = service.run_decay_cycle(None).await {
            tracing::warn!("Initial EM decay cycle failed: {}", err);
        }

        Ok(service)
    }

    #[cfg(test)]
    pub fn with_v2_store_for_test(
        v2_store: Arc<SqliteMemoryRepository>,
        enabled: bool,
        retrieval_limit: usize,
        min_score: f32,
    ) -> Self {
        Self {
            v2_store,
            enabled,
            retrieval_limit: retrieval_limit.clamp(1, 50),
            min_score,
            decay_config: DecayConfig::default(),
            decay_interval_hours: 0.0,
        }
    }

    #[cfg(test)]
    pub async fn with_v2_path_for_test(
        path: std::path::PathBuf,
        enabled: bool,
        retrieval_limit: usize,
        min_score: f32,
    ) -> Result<Self, ApiError> {
        let repo = SqliteMemoryRepository::new(path).await?;
        Ok(Self::with_v2_store_for_test(
            Arc::new(repo),
            enabled,
            retrieval_limit,
            min_score,
        ))
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub async fn ingest_interaction(
        &self,
        session_id: &str,
        user_input: &str,
        assistant_output: &str,
        llm: &LlmService,
        text_model_id: &str,
        embedding_model_id: &str,
    ) -> Result<(), ApiError> {
        if !self.enabled {
            return Ok(());
        }

        let content = build_memory_text(user_input, assistant_output);
        if content.trim().is_empty() {
            return Ok(());
        }

        self.ingest_turn_v2(session_id, &content, llm, text_model_id, embedding_model_id)
            .await?;
        Ok(())
    }

    pub async fn ingest_turn_v2(
        &self,
        session_id: &str,
        content: &str,
        llm: &LlmService,
        text_model_id: &str,
        embedding_model_id: &str,
    ) -> Result<Vec<String>, ApiError> {
        let v2_store = self.v2_store.as_ref();

        // Attempt surprise-based segmentation first
        let logprobs_result = llm.get_logprobs(content, text_model_id).await;

        let events = match logprobs_result {
            Ok(logprobs) => {
                let mut sentences = split_sentences(content, 8);
                if sentences.is_empty() {
                    sentences.push(content.to_string());
                }
                let sentence_embeddings = match llm.embed(&sentences, embedding_model_id).await {
                    Ok(embs) => Some(embs),
                    Err(e) => {
                        tracing::warn!("Failed to embed sentences for boundary refinement: {}", e);
                        None
                    }
                };

                let mut integrator = EMLLMIntegrator::default();
                integrator.process_logprobs_for_memory(&logprobs, sentence_embeddings.as_deref())
            }
            Err(e) => {
                tracing::warn!("Failed to get logprobs (falling back to semantic segmentation): {}", e);
                // Fallback: Semantic segmentation
                let mut sentences = split_sentences(content, 8);
                if sentences.is_empty() {
                    sentences.push(content.to_string());
                }

                let sentence_embeddings = llm
                    .embed(&sentences, embedding_model_id)
                    .await
                    .map_err(|err| ApiError::internal(format!("EM v2 embedding failed: {err}")))?;

                let mut integrator = EMLLMIntegrator::default();
                integrator.process_conversation_for_memory(&sentences, &sentence_embeddings)
            }
        };

        self.save_v2_events(session_id, events, v2_store).await
    }

    pub async fn ingest_segmented_v2(
        &self,
        session_id: &str,
        sentences: &[String],
        sentence_embeddings: &[Vec<f32>],
    ) -> Result<Vec<String>, ApiError> {
        let v2_store = self.v2_store.as_ref();

        // Explicit fallback path for tests or external direct segmented injection
        let mut integrator = EMLLMIntegrator::default();
        let events =
            integrator.process_conversation_for_memory(sentences, sentence_embeddings);

        self.save_v2_events(session_id, events, v2_store).await
    }

    async fn save_v2_events(
        &self,
        session_id: &str,
        events: Vec<crate::em_llm::types::EpisodicEvent>,
        v2_store: &dyn MemoryRepository,
    ) -> Result<Vec<String>, ApiError> {
        // 4. Map to v2 MemoryEvent and save
        let episode_id = uuid::Uuid::new_v4().to_string();
        let source_turn_id = format!("{}-{}", session_id, Utc::now().timestamp());
        let mut v2_events = Vec::new();
        let mut v2_edges = Vec::new();
        let mut prev_event_id: Option<String> = None;

        let decay_engine = DecayEngine::new(self.decay_config.clone());

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
                    created_at: Utc::now(),
                });
            }
            prev_event_id = Some(ev.id.clone());

            // P1: Calculate dynamic initial importance based on semantic_relevance 0.0, access_count 0, age 0.0
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
                layer: MemoryLayer::SML,
                access_count: 0,
                last_accessed_at: None,
                decay_anchor_at: Utc::now(),
                created_at: Utc::now(),
                updated_at: Utc::now(),
                is_deleted: false,
            });
        }

        let inserted_ids: Vec<String> = v2_events.iter().map(|e| e.id.clone()).collect();
        v2_store.insert_events(&v2_events).await?;
        if !v2_edges.is_empty() {
            v2_store.insert_edges(&v2_edges).await?;
        }

        Ok(inserted_ids)
    }

    pub async fn retrieve_for_query(
        &self,
        session_id: &str,
        query: &str,
        llm: &LlmService,
        embedding_model_id: &str,
    ) -> Result<Vec<RetrievedMemory>, ApiError> {
        if !self.enabled || query.trim().is_empty() {
            return Ok(Vec::new());
        }

        let query = query.trim().to_string();
        let embeddings = llm
            .embed(&[query], embedding_model_id)
            .await
            .map_err(|err| {
                ApiError::internal(format!("EM memory retrieval embedding failed: {err}"))
            })?;

        let Some(query_embedding) = embeddings.first() else {
            return Ok(Vec::new());
        };

        self.retrieve_for_query_with_embedding(session_id, query_embedding)
            .await
    }

    pub async fn retrieve_for_query_with_embedding(
        &self,
        session_id: &str,
        query_embedding: &[f32],
    ) -> Result<Vec<RetrievedMemory>, ApiError> {
        if !self.enabled {
            return Ok(Vec::new());
        }

        self.retrieve_for_query_v2(session_id, query_embedding, self.v2_store.as_ref())
            .await
    }

    pub async fn retrieve_for_query_v2(
        &self,
        session_id: &str,
        query_embedding: &[f32],
        v2_store: &dyn MemoryRepository,
    ) -> Result<Vec<RetrievedMemory>, ApiError> {
        let limit = self.retrieval_limit;
        let ratio = self.decay_config.retrieval_similarity_ratio;
        let mut ks = (limit as f32 * ratio).ceil() as usize;
        if limit > 0 && ks == 0 {
            ks = 1;
        }
        let kc = limit.saturating_sub(ks);

        // Stage 1: Similarity based retrieval
        let similar_events = v2_store
            .retrieve_similar(session_id, None, query_embedding, ks)
            .await?;

        // Use HashMap to deduplicate and keep track of scored events
        let mut candidates: std::collections::HashMap<String, ScoredEvent> = std::collections::HashMap::new();
        let mut edges_to_fetch = Vec::new();

        for scored in similar_events {
            edges_to_fetch.push(scored.event.id.clone());
            candidates.insert(scored.event.id.clone(), scored);
        }

        // Stage 2: Contiguity based retrieval
        // Fetch adjacent events via TemporalNext edges (unidirectional)
        let mut contiguity_added = 0;
        let mut current_layer_edges = edges_to_fetch;
        let mut distance = 1;

        let mut contiguity_weights: std::collections::HashMap<String, f32> = std::collections::HashMap::new();

        while contiguity_added < kc && !current_layer_edges.is_empty() {
            let mut next_layer = Vec::new();
            // Simple exponential decay for temporal distance weight
            let weight = 0.9f32.powi(distance);
            
            for event_id in current_layer_edges {
                if contiguity_added >= kc { break; }
                if let Ok(edges) = v2_store.get_edges_from(&event_id, Some(MemoryEdgeType::TemporalNext)).await {
                    for edge in edges {
                        if contiguity_added >= kc { break; }
                        if !candidates.contains_key(&edge.to_event_id) {
                            if let Ok(Some(adj_ev)) = v2_store.get_event(&edge.to_event_id).await {
                                next_layer.push(adj_ev.id.clone());
                                contiguity_weights.insert(adj_ev.id.clone(), weight);
                                candidates.insert(adj_ev.id.clone(), ScoredEvent {
                                    event: adj_ev,
                                    score: 0.0, // Initial similarity is 0.0 unless computed
                                });
                                contiguity_added += 1;
                            }
                        }
                    }
                }
            }
            current_layer_edges = next_layer;
            distance += 1;
        }

        // Stage 3: FadeMem Ranking
        let now = Utc::now();
        let mut final_scored = Vec::new();
        let decay_engine = crate::em_llm::decay::DecayEngine::new(self.decay_config.clone());

        for (_, mut scored) in candidates {
            // If the event was fetched via contiguity but we want to know its semantic relevance,
            // we compute the cosine similarity here if embedding is available.
            if scored.score == 0.0 && !scored.event.embedding.is_empty() {
                scored.score = {
                    let a = query_embedding;
                    let b = &scored.event.embedding;
                    let dot: f64 = a.iter().zip(b.iter()).map(|(x, y)| (*x as f64) * (*y as f64)).sum();
                    let norm_a: f64 = a.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();
                    let norm_b: f64 = b.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();
                    if norm_a == 0.0 || norm_b == 0.0 { 0.0 } else { (dot / (norm_a * norm_b)).clamp(-1.0, 1.0) }
                };
            }

            // Apply contiguity weight
            if let Some(w) = contiguity_weights.get(&scored.event.id) {
                // Boost semantic similarity score by the temporal weight
                scored.score = (scored.score + (*w as f64)).clamp(0.0, 1.0);
            }

            let age_days = (now - scored.event.created_at).num_seconds() as f64 / 86400.0;
            let semantic_relevance = scored.score;

            // Update importance dynamically
            let new_importance = decay_engine.importance_score(
                semantic_relevance,
                scored.event.access_count,
                age_days
            );
            if (new_importance - scored.event.importance).abs() > 1e-9 {
                scored.event.importance = new_importance;
                if let Err(e) = v2_store.update_importance(&scored.event.id, new_importance).await {
                    tracing::warn!("Failed to update importance for v2 event {}: {}", scored.event.id, e);
                }
            }

            let days_since_anchor = (now - scored.event.decay_anchor_at).num_seconds() as f64 / 86400.0;
            let effective_strength = decay_engine.compute_strength(
                scored.event.strength,
                new_importance,
                scored.event.layer,
                days_since_anchor,
            );

            // Update the event's strength to the newly decayed effective strength,
            // so reinforcement builds on the decayed value instead of the old anchor value.
            scored.event.strength = effective_strength;

            let retrieval_score = crate::em_llm::ranking::compute_retrieval_score(
                scored.score as f32, // use the base similarity
                effective_strength,
            );

            // Filter out extremely low retrieval scores
            if retrieval_score >= self.min_score as f64 {
                final_scored.push((scored, retrieval_score));
            }
        }

        // Sort descending by retrieval score
        final_scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        final_scored.truncate(self.retrieval_limit);

        // Reinforce accessed memories
        let mut results = Vec::new();
        for (scored, score) in final_scored {
            // Reinforce using FadeMem logarithmic formula
            // We provide `1` as the access_count_in_window for this immediate reinforcement.
            let new_strength = decay_engine.reinforce(scored.event.strength, 1);

            if let Err(e) = v2_store.record_access(&scored.event.id, new_strength).await {
                tracing::warn!("Failed to record access for V2 event {}: {}", scored.event.id, e);
            }

            results.push(RetrievedMemory {
                content: scored.event.content,
                relevance_score: score as f32,
                source: format!("em://{}/evt/{}", scored.event.session_id, scored.event.id),
                strength: new_strength,
                memory_layer: scored.event.layer,
            });
        }

        Ok(results)
    }

    pub async fn stats(&self) -> Result<EmMemoryStats, ApiError> {
        let v2_store = self.v2_store.as_ref();
        let total_events = v2_store.count_events(None, None).await?;
        let layer_counts = v2_store.count_by_layer(None, None).await?;
        let mean_strength = v2_store.average_strength(None, None).await?;

        let char_events = v2_store.count_events(None, Some(MemoryScope::Char)).await?;
        let char_layers = v2_store.count_by_layer(None, Some(MemoryScope::Char)).await?;
        let char_strength = v2_store.average_strength(None, Some(MemoryScope::Char)).await?;

        let prof_events = v2_store.count_events(None, Some(MemoryScope::Prof)).await?;
        let prof_layers = v2_store.count_by_layer(None, Some(MemoryScope::Prof)).await?;
        let prof_strength = v2_store.average_strength(None, Some(MemoryScope::Prof)).await?;

        Ok(EmMemoryStats {
            enabled: self.enabled,
            total_events,
            retrieval_limit: self.retrieval_limit,
            min_score: self.min_score,
            lml_events: layer_counts.lml,
            sml_events: layer_counts.sml,
            mean_strength,
            char_events,
            char_lml: char_layers.lml,
            char_sml: char_layers.sml,
            char_mean_strength: char_strength,
            prof_events,
            prof_lml: prof_layers.lml,
            prof_sml: prof_layers.sml,
            prof_mean_strength: prof_strength,
        })
    }

    pub async fn run_decay_cycle(
        &self,
        session_id: Option<&str>,
    ) -> Result<DecayCycleResult, ApiError> {
        if !self.enabled {
            return Ok(DecayCycleResult {
                updated: 0,
                promoted: 0,
                demoted: 0,
                pruned: 0,
            });
        }

        let decay_engine = DecayEngine::new(self.decay_config.clone());
        let now = Utc::now();
        let now_str = now.to_rfc3339();
        let v2_store = self.v2_store.as_ref();
        let v2_events = v2_store.get_all_events(session_id, None).await?;

        let mut result = DecayCycleResult {
            updated: 0,
            promoted: 0,
            demoted: 0,
            pruned: 0,
        };

        let mut v2_soft_delete_ids = Vec::new();
        for event in v2_events {
            let decay_reference = if let Some(last_accessed) = event.last_accessed_at {
                if last_accessed > event.decay_anchor_at {
                    last_accessed
                } else {
                    event.decay_anchor_at
                }
            } else {
                event.decay_anchor_at
            };
            let elapsed_days = elapsed_days_since(&decay_reference.to_rfc3339(), now);

            let new_strength = decay_engine.compute_strength(
                event.strength,
                event.importance,
                event.layer,
                elapsed_days,
            );

            if (new_strength - event.strength).abs() > 1e-9 {
                if let Err(err) = v2_store
                    .update_strength_and_anchor(&event.id, new_strength, &now_str)
                    .await
                {
                    tracing::warn!("Failed to update v2 strength: {}", err);
                } else {
                    result.updated += 1;
                }
            }

            if let Some(new_layer) = decay_engine.determine_layer(event.importance, event.layer) {
                if new_layer != event.layer {
                    if let Err(err) = v2_store.update_layer(&event.id, new_layer).await {
                        tracing::warn!("Failed to update v2 layer: {}", err);
                    } else {
                        match (event.layer, new_layer) {
                            (MemoryLayer::SML, MemoryLayer::LML) => result.promoted += 1,
                            (MemoryLayer::LML, MemoryLayer::SML) => result.demoted += 1,
                            _ => {}
                        }
                    }
                }
            }

            if new_strength < self.decay_config.prune_threshold {
                v2_soft_delete_ids.push(event.id.clone());
            }
        }

        if !v2_soft_delete_ids.is_empty() {
            result.pruned += v2_store.soft_delete_events(&v2_soft_delete_ids).await?;
        }

        Ok(result)
    }

    pub async fn compress_memories(
        &self,
        session_id: &str,
        llm: &LlmService,
        model_id: &str,
        scope: MemoryScope,
    ) -> Result<CompressionResult, ApiError> {
        let compressor = MemoryCompressor::default();
        let result = compressor
            .compress_v2(session_id, self.v2_store.as_ref(), llm, model_id, scope)
            .await?;
        tracing::info!(
            "V2 memory compression completed successfully: {} groups merged",
            result.merged_groups
        );
        Ok(result)
    }

    /// Spawns the background decay worker if enabled.
    pub fn spawn_background_worker(self: Arc<Self>) {
        if !self.enabled {
            return;
        }
        // decay_interval_hours == 0.0 means periodic decay is disabled.
        if self.decay_interval_hours == 0.0 {
            tracing::info!("Periodic decay disabled (decay_interval_hours=0.0).");
            return;
        }
        let interval_duration = std::time::Duration::from_secs_f64(self.decay_interval_hours * 3600.0);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval_duration).await;
                tracing::info!("Running scheduled background decay cycle...");
                if let Err(e) = self.run_decay_cycle(None).await {
                    tracing::error!("Background decay cycle failed: {}", e);
                }
            }
        });
    }

    /// Create an initial compaction job record (status = Queued).
    pub async fn create_compaction_job(
        &self,
        job: &CompactionJob,
    ) -> Result<(), ApiError> {
        self.v2_store.create_compaction_job(job).await?;
        Ok(())
    }

    /// List compaction jobs for the given session.
    pub async fn list_compaction_jobs(
        &self,
        session_id: &str,
        scope: Option<MemoryScope>,
        status: Option<CompactionStatus>,
    ) -> Result<Vec<CompactionJob>, ApiError> {
        self.v2_store
            .list_compaction_jobs(session_id, scope, status)
            .await
    }

    /// Run compression in the context of an existing job record.
    pub async fn compress_memories_as_job(
        &self,
        session_id: &str,
        llm: &LlmService,
        model_id: &str,
        job_id: &str,
        scope: MemoryScope,
    ) -> Result<CompressionResult, ApiError> {
        let compressor = MemoryCompressor::default();
        compressor
            .compress_v2_with_job(
                session_id,
                self.v2_store.as_ref(),
                llm,
                model_id,
                Some(job_id),
                scope,
            )
            .await
    }

    /// Mark a compaction job as failed.
    pub async fn fail_compaction_job(&self, session_id: &str, job_id: &str) {
        let v2_store = self.v2_store.as_ref();
        let now = chrono::Utc::now();
        let existing_job = match v2_store.list_compaction_jobs(session_id, None, None).await {
            Ok(jobs) => jobs.into_iter().find(|job| job.id == job_id),
            Err(e) => {
                tracing::warn!(
                    "Failed to load compaction jobs for failure update {}: {}",
                    job_id,
                    e
                );
                None
            }
        };

        let failed_job = existing_job.map_or_else(
            || CompactionJob {
                id: job_id.to_string(),
                session_id: session_id.to_string(),
                scope: MemoryScope::Char,
                status: CompactionStatus::Failed,
                scanned_events: 0,
                merged_groups: 0,
                replaced_events: 0,
                created_events: 0,
                created_at: now,
                finished_at: Some(now),
            },
            |job| CompactionJob {
                status: CompactionStatus::Failed,
                finished_at: Some(now),
                ..job
            },
        );

        if let Err(e) = v2_store.update_compaction_job(&failed_job).await {
            tracing::warn!(
                "Failed to mark compaction job {} as failed: {}",
                job_id,
                e
            );
        };
    }
    #[cfg(test)]
    pub async fn ingest_interaction_for_test(
        &self,
        session_id: &str,
        user_input: &str,
        assistant_output: &str,
        embedding: &[f32],
    ) -> Result<(), ApiError> {
        let content = build_memory_text(user_input, assistant_output);
        let episode_id = uuid::Uuid::new_v4().to_string();
        let source_turn_id = format!("{}-{}", session_id, chrono::Utc::now().timestamp());
        let v2_event = MemoryEvent {
            id: uuid::Uuid::new_v4().to_string(),
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
            layer: MemoryLayer::SML,
            access_count: 0,
            last_accessed_at: None,
            decay_anchor_at: chrono::Utc::now(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            is_deleted: false,
        };
        self.v2_store.insert_events(&[v2_event]).await
    }
}

fn build_memory_text(user_input: &str, assistant_output: &str) -> String {
    format!(
        "User: {}\nAssistant: {}",
        user_input.trim(),
        assistant_output.trim()
    )
}

fn get_or_create_encryption_key() -> anyhow::Result<[u8; 32]> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)?;

    match entry.get_password() {
        Ok(hex_key) => {
            let bytes = hex::decode(hex_key)
                .map_err(|_| anyhow::anyhow!("Invalid key format in keyring"))?;
            if bytes.len() != 32 {
                return Err(anyhow::anyhow!("Invalid key length in keyring"));
            }
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            Ok(key)
        }
        Err(keyring::Error::NoEntry) => {
            tracing::info!("No encryption key found, generating new one...");
            let mut key = [0u8; 32];
            rand::thread_rng().fill(&mut key);
            let hex_key = hex::encode(key);
            entry.set_password(&hex_key)?;
            Ok(key)
        }
        Err(e) => Err(e.into()),
    }
}

fn parse_decay_config(config: &Value) -> DecayConfig {
    let defaults = DecayConfig::default();
    let section = config.get("em_llm").and_then(|v| v.get("decay"));

    DecayConfig {
        lambda_base: read_decay_f64(
            section,
            "lambda_base",
            defaults.lambda_base,
            0.000_001,
            10.0,
        ),
        importance_modulation: read_decay_f64(
            section,
            "importance_modulation",
            defaults.importance_modulation,
            0.0,
            10.0,
        ),
        beta_lml: read_decay_f64(section, "beta_lml", defaults.beta_lml, 0.1, 5.0),
        beta_sml: read_decay_f64(section, "beta_sml", defaults.beta_sml, 0.1, 5.0),
        promote_threshold: read_decay_f64(
            section,
            "promote_threshold",
            defaults.promote_threshold,
            0.0,
            1.0,
        ),
        demote_threshold: read_decay_f64(
            section,
            "demote_threshold",
            defaults.demote_threshold,
            0.0,
            1.0,
        ),
        prune_threshold: read_decay_f64(
            section,
            "prune_threshold",
            defaults.prune_threshold,
            0.0,
            1.0,
        ),
        reinforcement_delta: read_decay_f64(
            section,
            "reinforcement_delta",
            defaults.reinforcement_delta,
            0.0,
            1.0,
        ),
        alpha: read_decay_f64(section, "alpha", defaults.alpha, 0.0, 1.0),
        beta: read_decay_f64(section, "beta", defaults.beta, 0.0, 1.0),
        gamma: read_decay_f64(section, "gamma", defaults.gamma, 0.0, 1.0),
        frequency_growth_rate: read_decay_f64(
            section,
            "frequency_growth_rate",
            defaults.frequency_growth_rate,
            0.01,
            2.0,
        ),
        recency_time_constant: read_decay_f64(
            section,
            "recency_time_constant",
            defaults.recency_time_constant,
            0.1,
            365.0,
        ),
        time_unit: match section.and_then(|v| v.get("time_unit")).and_then(|v| v.as_str()) {
            Some("hours") => crate::em_llm::types::TimeUnit::Hours,
            _ => crate::em_llm::types::TimeUnit::Days,
        },
        transition_hysteresis: read_decay_f64(
            section,
            "transition_hysteresis",
            defaults.transition_hysteresis,
            0.0,
            1.0,
        ),
        retrieval_similarity_ratio: read_decay_f64(
            config.get("em_llm").and_then(|v| v.get("retrieval")),
            "similarity_ratio",
            defaults.retrieval_similarity_ratio as f64,
            0.0,
            1.0,
        ) as f32,
    }
}

fn read_decay_f64(section: Option<&Value>, key: &str, default: f64, min: f64, max: f64) -> f64 {
    section
        .and_then(|v| v.get(key))
        .and_then(|v| v.as_f64())
        .unwrap_or(default)
        .clamp(min, max)
}

fn elapsed_days_since(timestamp: &str, now: DateTime<Utc>) -> f64 {
    DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|dt| now.signed_duration_since(dt.with_timezone(&Utc)))
        .map(|dur| (dur.num_seconds().max(0) as f64) / 86_400.0)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;

    async fn test_service() -> EmMemoryService {
        let path = std::env::temp_dir().join(format!(
            "tepora-memory-v2-service-test-{}.db",
            uuid::Uuid::new_v4()
        ));
        EmMemoryService::with_v2_path_for_test(path, true, 5, 0.0)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn ingest_and_retrieve_with_embeddings() {
        let service = test_service().await;

        service
            .ingest_interaction_for_test(
                "s1",
                "user asks",
                "assistant answers",
                &[1.0, 0.0, 0.0],
            )
            .await
            .unwrap();

        let results = service
            .retrieve_for_query_with_embedding("s1", &[1.0, 0.0, 0.0])
            .await
            .unwrap();

        assert_eq!(results.len(), 1);
        assert!(results[0].content.contains("User:"));
        assert!(results[0].source.starts_with("em://s1/evt/"));
        assert_eq!(results[0].memory_layer, MemoryLayer::SML);
    }

    #[tokio::test]
    async fn stats_reflect_insertions() {
        let service = test_service().await;
        let before = service.stats().await.unwrap();
        assert_eq!(before.total_events, 0);

        service
            .ingest_interaction_for_test("s1", "u", "a", &[0.0, 1.0])
            .await
            .unwrap();

        let after = service.stats().await.unwrap();
        assert_eq!(after.total_events, 1);
        assert!(after.enabled);
        assert_eq!(after.sml_events, 1);
    }

    #[test]
    fn elapsed_days_since_invalid_timestamp_returns_zero() {
        let now = Utc::now();
        assert_eq!(elapsed_days_since("not-a-timestamp", now), 0.0);
    }
}
