//! EM-LLM two-stage retrieval system.
//!
//! This module implements the two-stage retrieval system from the paper:
//! 1. Similarity buffer (Ks): Retrieve similar events based on query embedding
//! 2. Contiguity buffer (Kc): Retrieve temporally adjacent events
//!
//! # Algorithm Overview
//!
//! Given a query:
//! 1. Compute query embedding
//! 2. Retrieve top-Ks events by cosine similarity
//! 3. For each retrieved event, also retrieve Kc temporally adjacent events
//! 4. Combine and deduplicate results

use crate::em_llm::types::{EMConfig, EpisodicEvent};

/// Two-stage retrieval system (similarity buffer + contiguity buffer).
///
/// Combines semantic similarity with temporal contiguity for
/// more contextually relevant memory retrieval.
pub struct EMTwoStageRetrieval {
    config: EMConfig,
    /// In-memory event storage (will be replaced by Qdrant)
    events: Vec<EpisodicEvent>,
}

impl EMTwoStageRetrieval {
    /// Create a new two-stage retrieval system.
    pub fn new(config: EMConfig) -> Self {
        Self {
            config,
            events: Vec::new(),
        }
    }

    /// Add new events to the retrieval system.
    pub fn add_events(&mut self, events: Vec<EpisodicEvent>) {
        for mut event in events {
            // Assign sequence number based on current count
            event.sequence_number = Some(self.events.len() as u64);
            self.events.push(event);
        }
    }

    /// Get the total number of stored events.
    pub fn event_count(&self) -> usize {
        self.events.len()
    }

    /// Clear all stored events.
    pub fn clear(&mut self) {
        self.events.clear();
    }

    /// Retrieve relevant events using two-stage retrieval.
    ///
    /// # Arguments
    /// * `query_embedding` - Embedding vector for the query
    ///
    /// # Returns
    /// List of retrieved episodic events
    pub fn retrieve(&self, query_embedding: &[f32]) -> Vec<EpisodicEvent> {
        self.retrieve_with_k(query_embedding, None)
    }

    /// Retrieve relevant events with custom k value.
    ///
    /// # Arguments
    /// * `query_embedding` - Embedding vector for the query
    /// * `k` - Optional override for total events to retrieve
    ///
    /// # Returns
    /// List of retrieved episodic events
    pub fn retrieve_with_k(&self, query_embedding: &[f32], k: Option<usize>) -> Vec<EpisodicEvent> {
        if self.events.is_empty() || query_embedding.is_empty() {
            return vec![];
        }

        let total_k = k.unwrap_or(self.config.total_retrieved_events);
        let ks = ((total_k as f64) * self.config.similarity_buffer_ratio).ceil() as usize;
        let kc = ((total_k as f64) * self.config.contiguity_buffer_ratio).ceil() as usize;

        // Stage 1: Similarity-based retrieval
        let similar_events = self.similarity_based_retrieval(query_embedding, ks);

        // Stage 2: Contiguity-based retrieval
        let contiguous_events = self.contiguity_based_retrieval(&similar_events, kc);

        // Combine and deduplicate
        self.combine_and_deduplicate(similar_events, contiguous_events, total_k)
    }

    /// Stage 1: Retrieve events by cosine similarity.
    fn similarity_based_retrieval(
        &self,
        query_embedding: &[f32],
        ks: usize,
    ) -> Vec<(EpisodicEvent, f64)> {
        if self.events.is_empty() {
            return vec![];
        }

        // Calculate similarity scores for all events with embeddings
        let mut scored_events: Vec<(usize, f64)> = self
            .events
            .iter()
            .enumerate()
            .filter_map(|(idx, event)| {
                event.embedding.as_ref().map(|emb| {
                    let sim = cosine_similarity(query_embedding, emb);
                    (idx, sim)
                })
            })
            .collect();

        // Sort by similarity (descending)
        scored_events.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        // Take top-Ks
        scored_events
            .into_iter()
            .take(ks)
            .map(|(idx, sim)| (self.events[idx].clone(), sim))
            .collect()
    }

    /// Stage 2: Retrieve temporally adjacent events.
    fn contiguity_based_retrieval(
        &self,
        similar_events: &[(EpisodicEvent, f64)],
        kc: usize,
    ) -> Vec<EpisodicEvent> {
        if kc == 0 || similar_events.is_empty() {
            return vec![];
        }

        let mut contiguous_ids = std::collections::HashSet::new();
        let similar_ids: std::collections::HashSet<String> =
            similar_events.iter().map(|(e, _)| e.id.clone()).collect();

        // For each similar event, find adjacent events
        for (event, _) in similar_events {
            if let Some(seq_num) = event.sequence_number {
                // Look for events with adjacent sequence numbers
                let adjacent_range = (seq_num.saturating_sub(kc as u64))..=(seq_num + kc as u64);

                for adj_seq in adjacent_range {
                    // Find events with this sequence number
                    for e in &self.events {
                        if let Some(e_seq) = e.sequence_number {
                            if e_seq == adj_seq && !similar_ids.contains(&e.id) {
                                contiguous_ids.insert(e.id.clone());
                            }
                        }
                    }
                }
            }
        }

        // Collect contiguous events
        self.events
            .iter()
            .filter(|e| contiguous_ids.contains(&e.id))
            .take(kc)
            .cloned()
            .collect()
    }

    /// Combine similar and contiguous events, removing duplicates.
    fn combine_and_deduplicate(
        &self,
        similar: Vec<(EpisodicEvent, f64)>,
        contiguous: Vec<EpisodicEvent>,
        max_events: usize,
    ) -> Vec<EpisodicEvent> {
        let mut seen_ids = std::collections::HashSet::new();
        let mut result = Vec::new();

        // Add similar events first (higher priority)
        for (event, _) in similar {
            if !seen_ids.contains(&event.id) {
                seen_ids.insert(event.id.clone());
                result.push(event);
            }
        }

        // Add contiguous events
        for event in contiguous {
            if !seen_ids.contains(&event.id) && result.len() < max_events {
                seen_ids.insert(event.id.clone());
                result.push(event);
            }
        }

        // Sort by sequence number for temporal coherence
        result.sort_by_key(|e| e.sequence_number.unwrap_or(u64::MAX));

        result.truncate(max_events);
        result
    }

    /// Apply recency boost to similarity scores.
    ///
    /// Events with more recent timestamps get a boost to their scores.
    pub fn apply_recency_boost(&self, events: &mut [(EpisodicEvent, f64)]) {
        if events.is_empty() {
            return;
        }

        // Find the most recent timestamp
        let max_timestamp = events
            .iter()
            .map(|(e, _)| e.timestamp)
            .fold(f64::NEG_INFINITY, f64::max);

        let min_timestamp = events
            .iter()
            .map(|(e, _)| e.timestamp)
            .fold(f64::INFINITY, f64::min);

        let time_range = max_timestamp - min_timestamp;
        if time_range <= 0.0 {
            return;
        }

        let recency_weight = self.config.recency_weight;

        for (event, score) in events.iter_mut() {
            // Normalize timestamp to [0, 1]
            let normalized_time = (event.timestamp - min_timestamp) / time_range;
            // Apply recency boost
            *score = *score * (1.0 - recency_weight) + normalized_time * recency_weight;
        }
    }
}

/// Calculate cosine similarity between two vectors.
fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }

    let dot: f64 = a
        .iter()
        .zip(b.iter())
        .map(|(x, y)| (*x as f64) * (*y as f64))
        .sum();
    let norm_a: f64 = a.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();
    let norm_b: f64 = b.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();

    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }

    (dot / (norm_a * norm_b)).clamp(-1.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_event(id: &str, embedding: Vec<f32>, seq: u64) -> EpisodicEvent {
        let mut event =
            EpisodicEvent::new(id.to_string(), vec!["test".to_string()], 0, 1, vec![0.5]);
        event.embedding = Some(embedding);
        event.sequence_number = Some(seq);
        event
    }

    #[test]
    fn test_similarity_retrieval() {
        let config = EMConfig {
            total_retrieved_events: 2,
            similarity_buffer_ratio: 1.0,
            contiguity_buffer_ratio: 0.0,
            ..Default::default()
        };
        let mut retrieval = EMTwoStageRetrieval::new(config);

        // Add events with different embeddings
        let events = vec![
            create_test_event("e1", vec![1.0, 0.0, 0.0], 0),
            create_test_event("e2", vec![0.9, 0.1, 0.0], 1),
            create_test_event("e3", vec![0.0, 1.0, 0.0], 2),
        ];
        retrieval.add_events(events);

        // Query similar to e1 and e2
        let query = vec![1.0, 0.0, 0.0];
        let results = retrieval.retrieve(&query);

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].id, "e1"); // Most similar
    }

    #[test]
    fn test_contiguity_retrieval() {
        let config = EMConfig {
            total_retrieved_events: 4,
            similarity_buffer_ratio: 0.5,
            contiguity_buffer_ratio: 0.5,
            ..Default::default()
        };
        let mut retrieval = EMTwoStageRetrieval::new(config);

        // Add sequential events
        let events = vec![
            create_test_event("e0", vec![0.0, 1.0, 0.0], 0),
            create_test_event("e1", vec![0.1, 0.9, 0.0], 1),
            create_test_event("e2", vec![1.0, 0.0, 0.0], 2), // Target
            create_test_event("e3", vec![0.9, 0.1, 0.0], 3),
            create_test_event("e4", vec![0.0, 0.0, 1.0], 4),
        ];
        retrieval.add_events(events);

        // Query similar to e2
        let query = vec![1.0, 0.0, 0.0];
        let results = retrieval.retrieve(&query);

        // Should get e2 (similar) plus some adjacent events
        assert!(results.iter().any(|e| e.id == "e2"));
        assert!(results.len() >= 2);
    }
}
