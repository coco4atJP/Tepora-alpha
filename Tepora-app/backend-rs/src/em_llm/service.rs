use std::sync::Arc;

use chrono::{DateTime, Utc};
use rand::Rng;
use serde::Serialize;
use serde_json::Value;

use crate::core::config::{AppPaths, ConfigService};
use crate::core::errors::ApiError;
use crate::llm::LlmService;

use super::compression::{CompressionResult, MemoryCompressor};
use super::decay::DecayEngine;
use super::store::EmMemoryStore;
use super::types::{DecayConfig, MemoryLayer};
use crate::memory_v2::sqlite_repository::SqliteMemoryRepository;
use crate::memory_v2::repository::MemoryRepository;
use crate::memory_v2::types::{MemoryEvent, MemoryScope};
use super::sentence::split_sentences;
use super::integrator::EMLLMIntegrator;

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
    pub store: Arc<EmMemoryStore>,
    pub v2_store: Option<Arc<SqliteMemoryRepository>>,
    enabled: bool,
    retrieval_limit: usize,
    min_score: f32,
    decay_config: DecayConfig,
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

        let mut store = EmMemoryStore::new(paths).await?;
        let v2_db_path = paths.user_data_dir.join("em_memory.db");
        let mut v2_repo = match SqliteMemoryRepository::new(v2_db_path).await {
            Ok(repo) => Some(repo),
            Err(e) => {
                tracing::warn!("Failed to initialize v2 memory repository: {}", e);
                None
            }
        };

        // Initialize encryption key
        match get_or_create_encryption_key() {
            Ok(key) => {
                store.set_encryption_key(&key);
                if let Some(repo) = v2_repo.as_mut() {
                    repo.set_encryption_key(&key);
                }
            }
            Err(e) => tracing::warn!("Failed to initialize encryption key: {}", e),
        }

        let service = Self {
            store: Arc::new(store),
            v2_store: v2_repo.map(Arc::new),
            enabled,
            retrieval_limit,
            min_score,
            decay_config,
        };

        if let Err(err) = service.run_decay_cycle(None).await {
            tracing::warn!("Initial EM decay cycle failed: {}", err);
        }

        Ok(service)
    }

    pub fn with_store_for_test(
        store: Arc<EmMemoryStore>,
        enabled: bool,
        retrieval_limit: usize,
        min_score: f32,
    ) -> Self {
        Self {
            store,
            v2_store: None,
            enabled,
            retrieval_limit: retrieval_limit.clamp(1, 50),
            min_score,
            decay_config: DecayConfig::default(),
        }
    }

    /// Construct service with both v1 and v2 stores for testing dual-write and retrieval pipelines.
    #[cfg(test)]
    pub fn with_dual_store_for_test(
        store: std::sync::Arc<crate::em_llm::store::EmMemoryStore>,
        v2_store: std::sync::Arc<crate::memory_v2::sqlite_repository::SqliteMemoryRepository>,
        enabled: bool,
        retrieval_limit: usize,
        min_score: f32,
    ) -> Self {
        Self {
            store,
            v2_store: Some(v2_store),
            enabled,
            retrieval_limit: retrieval_limit.clamp(1, 50),
            min_score,
            decay_config: DecayConfig::default(),
        }
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
        embedding_model_id: &str,
    ) -> Result<(), ApiError> {
        if !self.enabled {
            return Ok(());
        }

        let content = build_memory_text(user_input, assistant_output);
        if content.trim().is_empty() {
            return Ok(());
        }

        let embeddings = llm
            .embed(std::slice::from_ref(&content), embedding_model_id)
            .await
            .map_err(|err| ApiError::internal(format!("EM memory embedding failed: {err}")))?;

        let Some(embedding) = embeddings.first() else {
            return Err(ApiError::internal("EM memory embedding is empty"));
        };

        // v1: Direct legacy insert
        self.ingest_interaction_with_embedding(session_id, user_input, assistant_output, embedding)
            .await?;

        // v2: Dual-write (Segmented)
        if let Err(e) = self.ingest_turn_v2(session_id, &content, llm, embedding_model_id).await {
            tracing::warn!("Failed to ingest v2 memory event: {}", e);
        }

        Ok(())
    }

    async fn ingest_turn_v2(
        &self,
        session_id: &str,
        content: &str,
        llm: &LlmService,
        embedding_model_id: &str,
    ) -> Result<(), ApiError> {
        let v2_store = match &self.v2_store {
            Some(s) => s.as_ref(),
            None => return Ok(()),
        };

        // 1. Split text into semantic sentences
        let mut sentences = split_sentences(content, 8);
        if sentences.is_empty() {
            sentences.push(content.to_string());
        }

        // 2. Generate embeddings for each sentence
        let sentence_embeddings = llm
            .embed(&sentences, embedding_model_id)
            .await
            .map_err(|err| ApiError::internal(format!("EM v2 embedding failed: {err}")))?;

        // 3. Segment using EMLLMIntegrator
        let mut integrator = EMLLMIntegrator::default();
        let events =
            integrator.process_conversation_for_memory(&sentences, &sentence_embeddings);

        // 4. Map to v2 MemoryEvent and save
        let episode_id = uuid::Uuid::new_v4().to_string();
        let source_turn_id = format!("{}-{}", session_id, Utc::now().timestamp());
        let mut v2_events = Vec::new();
        let mut v2_edges = Vec::new();
        let mut prev_event_id: Option<String> = None;

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
                    created_at: Utc::now(),
                });
            }
            prev_event_id = Some(ev.id.clone());

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
                importance: 0.5,
                strength: 1.0,
                layer: crate::memory_v2::types::MemoryLayer::SML,
                access_count: 0,
                last_accessed_at: None,
                decay_anchor_at: Utc::now(),
                created_at: Utc::now(),
                updated_at: Utc::now(),
                is_deleted: false,
            });
        }

        v2_store.insert_events(&v2_events).await?;
        if !v2_edges.is_empty() {
            v2_store.insert_edges(&v2_edges).await?;
        }

        Ok(())
    }

    pub async fn ingest_interaction_with_embedding(
        &self,
        session_id: &str,
        user_input: &str,
        assistant_output: &str,
        embedding: &[f32],
    ) -> Result<(), ApiError> {
        if !self.enabled {
            return Ok(());
        }

        let event_id = uuid::Uuid::new_v4().to_string();
        let content = build_memory_text(user_input, assistant_output);

        if let Some(v2_store) = &self.v2_store {
            let episode_id = uuid::Uuid::new_v4().to_string();
            let source_turn_id = format!("{}-{}", session_id, Utc::now().timestamp());
            let v2_event = MemoryEvent {
                id: uuid::Uuid::new_v4().to_string(),
                session_id: session_id.to_string(),
                scope: MemoryScope::Char,
                episode_id,
                event_seq: 0,
                source_turn_id: Some(source_turn_id),
                source_role: None,
                content: content.clone(),
                summary: None,
                embedding: embedding.to_vec(),
                surprise_mean: None,
                surprise_max: None,
                importance: 0.5,
                strength: 1.0,
                layer: crate::memory_v2::types::MemoryLayer::SML,
                access_count: 0,
                last_accessed_at: None,
                decay_anchor_at: Utc::now(),
                created_at: Utc::now(),
                updated_at: Utc::now(),
                is_deleted: false,
            };
            if let Err(e) = v2_store.insert_events(&[v2_event]).await {
                tracing::warn!("Failed to insert dummy v2 event in test/legacy flow: {}", e);
            }
        }

        self.store
            .insert_event(
                &event_id,
                session_id,
                user_input,
                assistant_output,
                &content,
                embedding,
            )
            .await
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

        if let Some(v2_store) = &self.v2_store {
            match self.retrieve_for_query_v2(session_id, query_embedding, v2_store.as_ref()).await {
                Ok(res) => {
                    if !res.is_empty() {
                        return Ok(res);
                    }
                    tracing::debug!("V2 retrieval returned empty, falling back to V1");
                }
                Err(e) => {
                    tracing::warn!("V2 retrieval failed, falling back to V1: {}", e);
                }
            }
        }

        let mut records = self
            .store
            .retrieve_similar(
                query_embedding,
                Some(session_id),
                self.retrieval_limit,
                &self.decay_config,
            )
            .await?;

        records.retain(|record| (record.score as f32) >= self.min_score);
        self.store
            .reinforce_accesses(&mut records, &self.decay_config)
            .await?;

        Ok(records
            .into_iter()
            .map(|record| RetrievedMemory {
                content: record.content,
                relevance_score: record.score as f32,
                source: format!("em://{}/{}", record.session_id, record.id),
                strength: record.strength,
                memory_layer: record.memory_layer,
            })
            .collect())
    }

    async fn retrieve_for_query_v2(
        &self,
        session_id: &str,
        query_embedding: &[f32],
        v2_store: &dyn MemoryRepository,
    ) -> Result<Vec<RetrievedMemory>, ApiError> {
        let ks = self.retrieval_limit; 

        // Stage 1: Similarity based retrieval
        let similar_events = v2_store
            .retrieve_similar(session_id, None, query_embedding, ks)
            .await?;

        // Use HashMap to deduplicate and keep track of scored events
        let mut candidates: std::collections::HashMap<String, crate::memory_v2::repository::ScoredEvent> = std::collections::HashMap::new();
        let mut edges_to_fetch = Vec::new();

        for scored in similar_events {
            edges_to_fetch.push(scored.event.id.clone());
            candidates.insert(scored.event.id.clone(), scored);
        }

        // Stage 2: Contiguity based retrieval
        // Fetch adjacent events via TemporalNext edges
        for event_id in edges_to_fetch {
            // Next events in time
            if let Ok(edges) = v2_store.get_edges_from(&event_id, Some(crate::memory_v2::types::MemoryEdgeType::TemporalNext)).await {
                for edge in edges {
                    if !candidates.contains_key(&edge.to_event_id) {
                        if let Ok(Some(adj_ev)) = v2_store.get_event(&edge.to_event_id).await {
                            candidates.insert(adj_ev.id.clone(), crate::memory_v2::repository::ScoredEvent {
                                event: adj_ev,
                                score: 0.0, // Initial similarity is 0.0 unless computed
                            });
                        }
                    }
                }
            }
            // Previous events in time
            if let Ok(edges) = v2_store.get_edges_to(&event_id, Some(crate::memory_v2::types::MemoryEdgeType::TemporalNext)).await {
                for edge in edges {
                    if !candidates.contains_key(&edge.from_event_id) {
                        if let Ok(Some(adj_ev)) = v2_store.get_event(&edge.from_event_id).await {
                            candidates.insert(adj_ev.id.clone(), crate::memory_v2::repository::ScoredEvent {
                                event: adj_ev,
                                score: 0.0,
                            });
                        }
                    }
                }
            }
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

            let recency_days = age_days;
            let retrieval_score = crate::em_llm::ranking::compute_retrieval_score(
                scored.score as f32, // use the base similarity
                scored.event.strength,
                recency_days,
                scored.event.layer.clone(),
                &self.decay_config,
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
        if let Some(v2_store) = &self.v2_store {
            let total_events = v2_store.count_events(None, None).await?;
            let layer_counts = v2_store.count_by_layer(None, None).await?;
            let mean_strength = v2_store.average_strength(None, None).await?;

            return Ok(EmMemoryStats {
                enabled: self.enabled,
                total_events,
                retrieval_limit: self.retrieval_limit,
                min_score: self.min_score,
                lml_events: layer_counts.lml,
                sml_events: layer_counts.sml,
                mean_strength,
            });
        }

        let total_events = self.store.count_events(None).await?;
        let layer_counts = self.store.count_by_layer().await?;
        let mean_strength = self.store.average_strength().await?;

        Ok(EmMemoryStats {
            enabled: self.enabled,
            total_events,
            retrieval_limit: self.retrieval_limit,
            min_score: self.min_score,
            lml_events: layer_counts.lml,
            sml_events: layer_counts.sml,
            mean_strength,
        })
    }

    pub async fn run_decay_cycle(
        &self,
        session_id: Option<&str>,
    ) -> Result<DecayCycleResult, ApiError> {
        let decay_engine = DecayEngine::new(self.decay_config.clone());
        let events = self.store.get_all_events_with_metadata(session_id).await?;
        let now = Utc::now();
        let now_str = now.to_rfc3339();

        let mut updated = 0usize;
        let mut promoted = 0usize;
        let mut demoted = 0usize;

        for event in events {
            // Use the most recent anchor between decay/access for backward compatibility.
            let decay_reference = latest_timestamp(
                event.last_decayed_at.as_deref(),
                event.last_accessed_at.as_deref(),
            )
            .unwrap_or(&event.created_at);
            let elapsed_days = elapsed_days_since(decay_reference, now);

            // importance uses absolute age from creation (FadeMem spec).
            // Use stored importance from last retrieval; fallback to recalculation for legacy records.
            let age_days = elapsed_days_since(&event.created_at, now);
            let importance = if (event.importance - 0.5).abs() < 1e-9 && event.access_count == 0 {
                // Legacy record with default importance — recalculate.
                decay_engine.importance_score(0.5, event.access_count, age_days)
            } else {
                // Use the stored importance (updated during retrieval with actual similarity).
                event.importance
            };

            let new_strength = decay_engine.compute_strength(
                event.strength,
                importance,
                event.memory_layer,
                elapsed_days,
            );

            if (new_strength - event.strength).abs() > 1e-9 {
                // Write both strength AND decay anchor so next cycle is differential.
                self.store
                    .update_memory_strength_and_decay_anchor(&event.id, new_strength, &now_str)
                    .await?;
                updated += 1;
            }

            if let Some(new_layer) = decay_engine.determine_layer(importance) {
                if new_layer != event.memory_layer {
                    self.store.update_memory_layer(&event.id, new_layer).await?;
                    match (event.memory_layer, new_layer) {
                        (MemoryLayer::SML, MemoryLayer::LML) => promoted += 1,
                        (MemoryLayer::LML, MemoryLayer::SML) => demoted += 1,
                        _ => {}
                    }
                }
            }
        }

        let pruned = self
            .store
            .prune_weak_memories(self.decay_config.prune_threshold)
            .await?;

        let mut result = DecayCycleResult {
            updated,
            promoted,
            demoted,
            pruned,
        };

        if let Some(v2_store) = &self.v2_store {
            let v2_events = match v2_store.get_all_events(session_id, None).await {
                Ok(evs) => evs,
                Err(e) => {
                    tracing::warn!("Failed to fetch v2 events for decay: {}", e);
                    Vec::new()
                }
            };
            let mut v2_soft_delete_ids = Vec::new();
            
            for event in v2_events {
                 let decay_reference = if let Some(la) = event.last_accessed_at {
                    if la > event.decay_anchor_at { la } else { event.decay_anchor_at }
                 } else {
                    event.decay_anchor_at
                 };
                 let elapsed_days = elapsed_days_since(&decay_reference.to_rfc3339(), now);

                 let new_strength = decay_engine.compute_strength(
                     event.strength,
                     event.importance,
                     event.layer.clone(),
                     elapsed_days,
                 );

                 if (new_strength - event.strength).abs() > 1e-9 {
                     if let Err(e) = v2_store.update_strength_and_anchor(&event.id, new_strength, &now_str).await {
                         tracing::warn!("Failed to update strength v2: {}", e);
                     } else {
                         result.updated += 1;
                     }
                 }

                 if let Some(new_layer) = decay_engine.determine_layer(event.importance) {
                     if new_layer != event.layer {
                         if let Err(e) = v2_store.update_layer(&event.id, new_layer.clone()).await {
                             tracing::warn!("Failed to update layer v2: {}", e);
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
                match v2_store.soft_delete_events(&v2_soft_delete_ids).await {
                    Ok(count) => result.pruned += count,
                    Err(e) => tracing::warn!("Failed to prune v2: {}", e),
                }
            }
        }

        Ok(result)
    }

    pub async fn compress_memories(
        &self,
        session_id: &str,
        llm: &LlmService,
        model_id: &str,
    ) -> Result<CompressionResult, ApiError> {
        let compressor = MemoryCompressor::default();

        if let Some(v2_store) = &self.v2_store {
            match compressor.compress_v2(session_id, v2_store.as_ref(), llm, model_id).await {
                Ok(res) => {
                    tracing::info!("V2 memory compression completed successfully: {} groups merged", res.merged_groups);
                    return Ok(res);
                }
                Err(e) => {
                    tracing::warn!("V2 memory compression failed, falling back to V1: {}", e);
                }
            }
        }

        compressor
            .compress(session_id, self.store.as_ref(), llm, model_id)
            .await
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

fn latest_timestamp<'a>(lhs: Option<&'a str>, rhs: Option<&'a str>) -> Option<&'a str> {
    match (lhs, rhs) {
        (Some(left), Some(right)) => match (parse_rfc3339_utc(left), parse_rfc3339_utc(right)) {
            (Some(left_dt), Some(right_dt)) => {
                if right_dt >= left_dt {
                    Some(right)
                } else {
                    Some(left)
                }
            }
            (Some(_), None) => Some(left),
            (None, Some(_)) => Some(right),
            (None, None) => Some(right),
        },
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

fn parse_rfc3339_utc(timestamp: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use chrono::{Duration, Utc};

    use super::*;
    use crate::em_llm::store::EmMemoryStore;

    async fn test_service() -> EmMemoryService {
        let tmp = std::env::temp_dir().join(format!(
            "tepora-em-service-test-{}.db",
            uuid::Uuid::new_v4()
        ));
        let store = Arc::new(EmMemoryStore::with_path(tmp).await.unwrap());
        EmMemoryService::with_store_for_test(store, true, 5, 0.0)
    }

    #[tokio::test]
    async fn ingest_and_retrieve_with_embeddings() {
        let service = test_service().await;

        service
            .ingest_interaction_with_embedding(
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
        assert!(results[0].source.starts_with("em://s1/"));
        assert_eq!(results[0].memory_layer, MemoryLayer::SML);
    }

    #[tokio::test]
    async fn stats_reflect_insertions() {
        let service = test_service().await;
        let before = service.stats().await.unwrap();
        assert_eq!(before.total_events, 0);

        service
            .ingest_interaction_with_embedding("s1", "u", "a", &[0.0, 1.0])
            .await
            .unwrap();

        let after = service.stats().await.unwrap();
        assert_eq!(after.total_events, 1);
        assert!(after.enabled);
        assert_eq!(after.sml_events, 1);
    }

    #[test]
    fn latest_timestamp_picks_newer_anchor() {
        let older = (Utc::now() - Duration::days(1)).to_rfc3339();
        let newer = Utc::now().to_rfc3339();

        let selected = latest_timestamp(Some(&older), Some(&newer));
        assert_eq!(selected, Some(newer.as_str()));
    }
}
