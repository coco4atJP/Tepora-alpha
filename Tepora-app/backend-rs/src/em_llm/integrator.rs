//! EM-LLM integrator - Main integration point.
//!
//! This module provides the EMLLMIntegrator class that orchestrates
//! all EM-LLM components for memory formation and retrieval.

use crate::em_llm::{
    EMBoundaryRefiner, EMConfig, EMEventSegmenter, EMTwoStageRetrieval, EpisodicEvent,
};

/// Main integration class for the EM-LLM system.
///
/// Orchestrates:
/// 1. Event segmentation (surprise-based or semantic)
/// 2. Boundary refinement (graph-theoretic)
/// 3. Memory storage and retrieval (two-stage)
pub struct EMLLMIntegrator {
    config: EMConfig,
    segmenter: EMEventSegmenter,
    refiner: EMBoundaryRefiner,
    retrieval: EMTwoStageRetrieval,
}

impl EMLLMIntegrator {
    /// Create a new EM-LLM integrator with the given configuration.
    pub fn new(config: EMConfig) -> Self {
        let segmenter = EMEventSegmenter::new(config.clone());
        let refiner = EMBoundaryRefiner::new(config.clone());
        let retrieval = EMTwoStageRetrieval::new(config.clone());

        Self {
            config,
            segmenter,
            refiner,
            retrieval,
        }
    }

    /// Create with default configuration.
    pub fn default() -> Self {
        Self::new(EMConfig::default())
    }

    /// Get current configuration.
    pub fn config(&self) -> &EMConfig {
        &self.config
    }

    /// Process LLM logprobs for surprise-based memory formation.
    ///
    /// This is the main memory formation path from the EM-LLM paper.
    ///
    /// # Arguments
    /// * `logprobs` - List of (token, logprob) pairs from LLM output
    /// * `embeddings` - Optional embedding vectors for boundary refinement
    ///
    /// # Returns
    /// List of created episodic events
    pub fn process_logprobs_for_memory(
        &mut self,
        logprobs: &[(String, f64)],
        embeddings: Option<&[Vec<f32>]>,
    ) -> Vec<EpisodicEvent> {
        if logprobs.is_empty() {
            return vec![];
        }

        // Extract tokens and calculate surprise scores
        let tokens: Vec<String> = logprobs.iter().map(|(t, _)| t.clone()).collect();
        let surprise_scores = self.segmenter.calculate_surprise_from_logprobs(logprobs);

        // Segment into events
        let mut events = self.segmenter.segment_tokens(&tokens, &surprise_scores);

        // Apply boundary refinement if embeddings provided
        if let Some(embs) = embeddings {
            if self.config.use_boundary_refinement {
                events = self.refiner.refine_boundaries(events, embs);
            }
        }

        // Select representative tokens and store events
        let finalized_events = self.finalize_events(events, embeddings);

        // Store in retrieval system
        self.retrieval.add_events(finalized_events.clone());

        finalized_events
    }

    /// Process a conversation turn for memory formation.
    ///
    /// Alternative path for when logprobs are not available.
    /// Uses semantic embeddings to detect event boundaries.
    ///
    /// # Arguments
    /// * `sentences` - List of sentences from the conversation
    /// * `embeddings` - Embedding vector for each sentence
    ///
    /// # Returns
    /// List of created episodic events
    pub fn process_conversation_for_memory(
        &mut self,
        sentences: &[String],
        embeddings: &[Vec<f32>],
    ) -> Vec<EpisodicEvent> {
        if sentences.is_empty() || sentences.len() != embeddings.len() {
            return vec![];
        }

        // Segment by semantic change
        let boundaries = self
            .segmenter
            .segment_by_semantic_change(sentences, embeddings);

        // Create events from boundaries
        let mut events = Vec::new();
        for window in boundaries.windows(2) {
            let start = window[0];
            let end = window[1];

            let event_sentences = sentences[start..end].to_vec();
            let summary = event_sentences.join(" ");

            // Create pseudo surprise scores (semantic distance-based)
            let surprise_scores = vec![1.0; event_sentences.len()];

            let mut event = EpisodicEvent::new(
                uuid::Uuid::new_v4().to_string(),
                event_sentences,
                start,
                end,
                surprise_scores,
            );
            event.summary = Some(summary);

            // Use mean embedding for the event
            if start < embeddings.len() && end <= embeddings.len() {
                let event_embeddings = &embeddings[start..end];
                event.embedding = Some(mean_embedding(event_embeddings));
            }

            events.push(event);
        }

        // Handle last segment
        if let Some(&last_boundary) = boundaries.last() {
            if last_boundary < sentences.len() {
                let event_sentences = sentences[last_boundary..].to_vec();
                let summary = event_sentences.join(" ");
                let surprise_scores = vec![1.0; event_sentences.len()];

                let mut event = EpisodicEvent::new(
                    uuid::Uuid::new_v4().to_string(),
                    event_sentences,
                    last_boundary,
                    sentences.len(),
                    surprise_scores,
                );
                event.summary = Some(summary);

                if last_boundary < embeddings.len() {
                    let event_embeddings = &embeddings[last_boundary..];
                    event.embedding = Some(mean_embedding(event_embeddings));
                }

                events.push(event);
            }
        }

        // Store in retrieval system
        self.retrieval.add_events(events.clone());

        events
    }

    /// Retrieve relevant memories for a query.
    ///
    /// Uses two-stage retrieval (similarity + contiguity).
    ///
    /// # Arguments
    /// * `query_embedding` - Embedding vector for the query
    ///
    /// # Returns
    /// List of relevant episodic events
    pub fn retrieve_memories(&self, query_embedding: &[f32]) -> Vec<EpisodicEvent> {
        self.retrieval.retrieve(query_embedding)
    }

    /// Retrieve memories with custom number of results.
    pub fn retrieve_memories_with_k(
        &self,
        query_embedding: &[f32],
        k: usize,
    ) -> Vec<EpisodicEvent> {
        self.retrieval.retrieve_with_k(query_embedding, Some(k))
    }

    /// Get memory statistics.
    pub fn get_statistics(&self) -> MemoryStatistics {
        MemoryStatistics {
            total_events: self.retrieval.event_count(),
            config: self.config.clone(),
        }
    }

    /// Finalize events by selecting representative tokens and computing embeddings.
    fn finalize_events(
        &self,
        mut events: Vec<EpisodicEvent>,
        embeddings: Option<&[Vec<f32>]>,
    ) -> Vec<EpisodicEvent> {
        for event in &mut events {
            // Select representative tokens (highest surprise)
            let representative = self.select_representative_tokens(event);
            event.representative_tokens = Some(representative);

            // Generate summary from tokens
            event.summary = Some(event.text());

            // Compute event embedding from token embeddings
            if let Some(embs) = embeddings {
                // Get embeddings for this event's token range
                let start = event.start_position;
                let end = event.end_position.min(embs.len());
                if start < end {
                    let event_embeddings = &embs[start..end];
                    event.embedding = Some(mean_embedding(event_embeddings));
                }
            }
        }

        events
    }

    /// Select representative tokens within an event (highest surprise scores).
    fn select_representative_tokens(&self, event: &EpisodicEvent) -> Vec<usize> {
        let topk = self.config.repr_topk.min(event.surprise_scores.len());

        // Get indices sorted by surprise score (descending)
        let mut indexed_scores: Vec<(usize, f64)> = event
            .surprise_scores
            .iter()
            .enumerate()
            .map(|(i, &s)| (i, s))
            .collect();

        indexed_scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        // Return top-k indices, sorted by position
        let mut top_indices: Vec<usize> = indexed_scores
            .into_iter()
            .take(topk)
            .map(|(i, _)| i)
            .collect();
        top_indices.sort();
        top_indices
    }
}

/// Statistics about the EM-LLM memory system.
#[derive(Debug, Clone)]
pub struct MemoryStatistics {
    pub total_events: usize,
    pub config: EMConfig,
}

/// Calculate mean embedding from a list of embeddings.
fn mean_embedding(embeddings: &[Vec<f32>]) -> Vec<f32> {
    if embeddings.is_empty() {
        return vec![];
    }

    let dim = embeddings[0].len();
    let n = embeddings.len() as f32;

    let mut mean = vec![0.0f32; dim];
    for emb in embeddings {
        for (i, &val) in emb.iter().enumerate() {
            if i < dim {
                mean[i] += val / n;
            }
        }
    }

    mean
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_integrator_creation() {
        let integrator = EMLLMIntegrator::default();
        assert_eq!(integrator.config().surprise_window, 128);
    }

    #[test]
    fn test_logprobs_processing() {
        let mut integrator = EMLLMIntegrator::new(EMConfig {
            min_event_size: 2,
            max_event_size: 5,
            ..Default::default()
        });

        // Create test logprobs with a spike
        let logprobs: Vec<(String, f64)> = vec![
            ("Hello".to_string(), -0.5),
            (" ".to_string(), -0.1),
            ("world".to_string(), -0.3),
            ("!".to_string(), -0.2),
            (" ".to_string(), -0.1),
            ("How".to_string(), -3.0), // Spike
            (" ".to_string(), -0.1),
            ("are".to_string(), -0.4),
            (" ".to_string(), -0.1),
            ("you".to_string(), -0.3),
        ];

        let events = integrator.process_logprobs_for_memory(&logprobs, None);

        // Should have created at least one event
        assert!(!events.is_empty());

        // Statistics should reflect stored events
        let stats = integrator.get_statistics();
        assert!(stats.total_events > 0);
    }

    #[test]
    fn test_memory_retrieval() {
        let mut integrator = EMLLMIntegrator::default();

        // Add events with embeddings
        let sentences = vec![
            "The sky is blue.".to_string(),
            "The grass is green.".to_string(),
            "The sun is bright.".to_string(),
        ];
        let embeddings = vec![
            vec![1.0, 0.0, 0.0],
            vec![0.9, 0.1, 0.0],
            vec![0.0, 1.0, 0.0],
        ];

        integrator.process_conversation_for_memory(&sentences, &embeddings);

        // Query similar to first sentences
        let query = vec![1.0, 0.0, 0.0];
        let results = integrator.retrieve_memories(&query);

        // Should retrieve something
        assert!(!results.is_empty());
    }
}
