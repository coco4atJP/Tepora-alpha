//! EM-LLM data types and configuration.
//!
//! This module defines the core data structures for the EM-LLM system:
//! - `EpisodicEvent`: Represents a single episodic event in memory
//! - `EMConfig`: Configuration parameters for EM-LLM components
//!
//! Based on the paper "Human-inspired Episodic Memory for Infinite Context LLMs" (ICLR 2025).

use serde::{Deserialize, Serialize};

/// Represents a single episodic event in the EM-LLM system.
///
/// An episodic event is a segment of text that has been identified as
/// semantically coherent based on surprise scores or semantic change.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpisodicEvent {
    /// Unique identifier for this event
    pub id: String,

    /// List of tokens comprising this event
    pub tokens: Vec<String>,

    /// Starting position in the overall token sequence
    pub start_position: usize,

    /// Ending position in the overall token sequence
    pub end_position: usize,

    /// Surprise score for each token (from -log P(x|...))
    pub surprise_scores: Vec<f64>,

    /// Indices of tokens that best represent this event
    pub representative_tokens: Option<Vec<usize>>,

    /// Text summary of this event
    pub summary: Option<String>,

    /// Embedding vector for this event (for similarity search)
    pub embedding: Option<Vec<f32>>,

    /// Unix timestamp when this event was created
    pub timestamp: f64,

    /// Session ID this event belongs to
    pub session_id: Option<String>,

    /// Sequence number for temporal ordering within a session
    pub sequence_number: Option<u64>,
}

impl EpisodicEvent {
    /// Creates a new episodic event with minimal required fields.
    pub fn new(
        id: String,
        tokens: Vec<String>,
        start_position: usize,
        end_position: usize,
        surprise_scores: Vec<f64>,
    ) -> Self {
        Self {
            id,
            tokens,
            start_position,
            end_position,
            surprise_scores,
            representative_tokens: None,
            summary: None,
            embedding: None,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0),
            session_id: None,
            sequence_number: None,
        }
    }

    /// Gets the text content by joining tokens.
    pub fn text(&self) -> String {
        self.tokens.join("")
    }

    /// Returns the number of tokens in this event.
    pub fn len(&self) -> usize {
        self.tokens.len()
    }

    /// Returns true if this event has no tokens.
    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }
}

/// Configuration parameters for the EM-LLM system.
///
/// Based on the paper "Human-inspired Episodic Memory for Infinite Context LLMs" (ICLR 2025).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EMConfig {
    // ===== Surprise-related parameters =====
    /// Window size for rolling statistics in surprise calculation
    pub surprise_window: usize,

    /// Threshold adjustment parameter (γ in paper): T = μ + γσ
    pub surprise_gamma: f64,

    /// Minimum number of tokens per event
    pub min_event_size: usize,

    /// Maximum number of tokens per event
    pub max_event_size: usize,

    // ===== Retrieval-related parameters =====
    /// Ratio of similarity buffer (Ks/K in paper)
    pub similarity_buffer_ratio: f64,

    /// Ratio of contiguity buffer (Kc/K in paper)  
    pub contiguity_buffer_ratio: f64,

    /// Total number of events to retrieve (K in paper)
    pub total_retrieved_events: usize,

    /// Number of representative tokens per event (for embedding)
    pub repr_topk: usize,

    /// Temporal recency weight for retrieval (0.0 - 1.0)
    pub recency_weight: f64,

    // ===== Boundary refinement parameters =====
    /// Whether to apply graph-theoretic boundary refinement
    pub use_boundary_refinement: bool,

    /// Metric to use for refinement: "modularity" or "conductance"
    pub refinement_metric: String,

    /// Maximum search range for boundary refinement (positions)
    pub refinement_search_range: usize,
}

impl Default for EMConfig {
    fn default() -> Self {
        Self {
            // Surprise-related (from paper defaults)
            surprise_window: 128,
            surprise_gamma: 1.0,
            min_event_size: 8,
            max_event_size: 128,

            // Retrieval-related (from paper defaults)
            similarity_buffer_ratio: 0.7,
            contiguity_buffer_ratio: 0.3,
            total_retrieved_events: 4,
            repr_topk: 4,
            recency_weight: 0.1,

            // Boundary refinement
            use_boundary_refinement: true,
            refinement_metric: "modularity".to_string(),
            refinement_search_range: 16,
        }
    }
}

impl EMConfig {
    /// Calculate the size of the similarity buffer (Ks).
    pub fn similarity_buffer_size(&self) -> usize {
        ((self.total_retrieved_events as f64) * self.similarity_buffer_ratio).round() as usize
    }

    /// Calculate the size of the contiguity buffer (Kc).
    pub fn contiguity_buffer_size(&self) -> usize {
        ((self.total_retrieved_events as f64) * self.contiguity_buffer_ratio).round() as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_episodic_event_creation() {
        let event = EpisodicEvent::new(
            "test-id".to_string(),
            vec!["Hello".to_string(), " ".to_string(), "world".to_string()],
            0,
            3,
            vec![0.5, 0.1, 0.8],
        );

        assert_eq!(event.id, "test-id");
        assert_eq!(event.len(), 3);
        assert_eq!(event.text(), "Hello world");
        assert!(!event.is_empty());
    }

    #[test]
    fn test_em_config_defaults() {
        let config = EMConfig::default();

        assert_eq!(config.surprise_window, 128);
        assert_eq!(config.surprise_gamma, 1.0);
        assert_eq!(config.total_retrieved_events, 4);
        assert_eq!(config.similarity_buffer_size(), 3); // 4 * 0.7 = 2.8 -> 3
        assert_eq!(config.contiguity_buffer_size(), 1); // 4 * 0.3 = 1.2 -> 1
    }
}
