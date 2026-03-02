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

/// Memory tier used by FadeMem.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
#[allow(clippy::upper_case_acronyms)]
pub enum MemoryLayer {
    /// Long-term Memory Layer: slower decay
    LML,
    /// Short-term Memory Layer: faster decay
    #[default]
    SML,
}

impl MemoryLayer {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LML => "LML",
            Self::SML => "SML",
        }
    }
}

/// Time unit for decay calculations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimeUnit {
    Hours,
    Days,
}

impl Default for TimeUnit {
    fn default() -> Self {
        Self::Days
    }
}

/// FadeMem decay parameters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecayConfig {
    /// Base decay rate (lambda_base)
    pub lambda_base: f64,
    /// Importance modulation factor (mu)
    pub importance_modulation: f64,
    /// LML beta (sublinear decay)
    pub beta_lml: f64,
    /// SML beta (superlinear decay)
    pub beta_sml: f64,
    /// Promote threshold (theta_promote)
    pub promote_threshold: f64,
    /// Demote threshold (theta_demote)
    pub demote_threshold: f64,
    /// Pruning threshold (epsilon_prune)
    pub prune_threshold: f64,
    /// Reinforcement delta (delta_v)
    pub reinforcement_delta: f64,
    /// Importance weight: semantic relevance
    pub alpha: f64,
    /// Importance weight: access frequency
    pub beta: f64,
    /// Importance weight: recency
    pub gamma: f64,
    /// Access frequency growth rate
    pub frequency_growth_rate: f64,
    /// Recency time constant
    pub recency_time_constant: f64,
    /// Time unit for recency and decay
    #[serde(default)]
    pub time_unit: TimeUnit,
    /// Hysteresis margin around threshold to prevent toggling
    #[serde(default)]
    pub transition_hysteresis: f64,
    /// Ratio of K allocation reserved for semantic similarity retrieval (vs contiguity)
    pub retrieval_similarity_ratio: f32,
}

impl Default for DecayConfig {
    fn default() -> Self {
        Self {
            lambda_base: 0.1,
            importance_modulation: 2.0,
            beta_lml: 0.8,
            beta_sml: 1.2,
            promote_threshold: 0.7,
            demote_threshold: 0.3,
            prune_threshold: 0.05,
            reinforcement_delta: 0.05,
            alpha: 0.5,
            beta: 0.3,
            gamma: 0.2,
            frequency_growth_rate: 0.2,
            recency_time_constant: 7.0,
            time_unit: TimeUnit::Days,
            transition_hysteresis: 0.05,
            retrieval_similarity_ratio: 0.7,
        }
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

    // ===== Security parameters =====
    /// Whether to encrypt stored memory content
    pub encryption_enabled: bool,

    // ===== FadeMem decay =====
    /// Adaptive forgetting configuration
    #[serde(default)]
    pub decay: DecayConfig,

    // ===== Application operation parameters =====
    /// Interval in hours for periodic decay.
    /// `0.0` (the default) disables automatic periodic decay.
    /// Set to a positive value, e.g. `1.0`, to enable hourly decay.
    pub decay_interval_hours: f64,
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

            // Security
            encryption_enabled: false,

            // FadeMem decay
            decay: DecayConfig::default(),

            decay_interval_hours: 0.0,
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
        assert_eq!(config.decay.promote_threshold, 0.7);
        assert_eq!(config.decay.demote_threshold, 0.3);
    }
}
