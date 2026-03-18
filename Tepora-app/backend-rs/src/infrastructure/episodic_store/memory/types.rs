#![allow(dead_code)]
//! Memory v2 data types.
//!
//! Core domain models for the redesigned memory system based on
//! EM-LLM (arXiv 2407.09450) and FadeMem (arXiv 2601.18642).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Represents a single episodic event in the EM-LLM system.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpisodicEvent {
    pub id: String,
    pub tokens: Vec<String>,
    pub start_position: usize,
    pub end_position: usize,
    pub surprise_scores: Vec<f64>,
    pub representative_tokens: Option<Vec<usize>>,
    pub summary: Option<String>,
    pub embedding: Option<Vec<f32>>,
    pub timestamp: f64,
    pub session_id: Option<String>,
    pub sequence_number: Option<u64>,
}

impl EpisodicEvent {
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

    pub fn text(&self) -> String {
        self.tokens.join("")
    }

    pub fn len(&self) -> usize {
        self.tokens.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }
}

/// Memory tier used by FadeMem.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
#[allow(clippy::upper_case_acronyms)]
pub enum MemoryLayer {
    LML,
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TimeUnit {
    Hours,
    #[default]
    Days,
}

/// FadeMem decay parameters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecayConfig {
    pub lambda_base: f64,
    pub importance_modulation: f64,
    pub beta_lml: f64,
    pub beta_sml: f64,
    pub promote_threshold: f64,
    pub demote_threshold: f64,
    pub prune_threshold: f64,
    pub reinforcement_delta: f64,
    pub alpha: f64,
    pub beta: f64,
    pub gamma: f64,
    pub frequency_growth_rate: f64,
    pub recency_time_constant: f64,
    #[serde(default)]
    pub time_unit: TimeUnit,
    #[serde(default)]
    pub transition_hysteresis: f64,
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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EMConfig {
    pub surprise_window: usize,
    pub surprise_gamma: f64,
    pub min_event_size: usize,
    pub max_event_size: usize,
    pub similarity_buffer_ratio: f64,
    pub contiguity_buffer_ratio: f64,
    pub total_retrieved_events: usize,
    pub repr_topk: usize,
    pub recency_weight: f64,
    pub use_boundary_refinement: bool,
    pub refinement_metric: String,
    pub refinement_search_range: usize,
    pub encryption_enabled: bool,
    #[serde(default)]
    pub decay: DecayConfig,
    pub decay_interval_hours: f64,
}

impl Default for EMConfig {
    fn default() -> Self {
        Self {
            surprise_window: 128,
            surprise_gamma: 1.0,
            min_event_size: 8,
            max_event_size: 128,
            similarity_buffer_ratio: 0.7,
            contiguity_buffer_ratio: 0.3,
            total_retrieved_events: 4,
            repr_topk: 4,
            recency_weight: 0.1,
            use_boundary_refinement: true,
            refinement_metric: "modularity".to_string(),
            refinement_search_range: 16,
            encryption_enabled: false,
            decay: DecayConfig::default(),
            decay_interval_hours: 0.0,
        }
    }
}

impl EMConfig {
    pub fn similarity_buffer_size(&self) -> usize {
        ((self.total_retrieved_events as f64) * self.similarity_buffer_ratio).round() as usize
    }

    pub fn contiguity_buffer_size(&self) -> usize {
        ((self.total_retrieved_events as f64) * self.contiguity_buffer_ratio).round() as usize
    }
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/// Scope of a memory event — determines which memory pool it belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum MemoryScope {
    /// Character memory — associated with a specific persona / character.
    #[default]
    Char,
    /// Professional memory — associated with general knowledge / tasks.
    Prof,
}

impl MemoryScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Char => "CHAR",
            Self::Prof => "PROF",
        }
    }
}

impl std::str::FromStr for MemoryScope {
    type Err = crate::core::errors::ApiError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        if s.eq_ignore_ascii_case("PROF") {
            Ok(Self::Prof)
        } else if s.eq_ignore_ascii_case("CHAR") {
            Ok(Self::Char)
        } else {
            Err(crate::core::errors::ApiError::BadRequest(format!(
                "Invalid MemoryScope: {}",
                s
            )))
        }
    }
}

/// Type of relationship between two memory events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryEdgeType {
    /// Temporal adjacency within an episode.
    TemporalNext,
    /// Semantic similarity link (cross-episode).
    SemanticNeighbor,
    /// Provenance link: the `from` event was compressed into the `to` event.
    CompressedFrom,
}

impl MemoryEdgeType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TemporalNext => "temporal_next",
            Self::SemanticNeighbor => "semantic_neighbor",
            Self::CompressedFrom => "compressed_from",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "semantic_neighbor" => Self::SemanticNeighbor,
            "compressed_from" => Self::CompressedFrom,
            _ => Self::TemporalNext,
        }
    }
}

/// Status of a compaction job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionStatus {
    Queued,
    Running,
    Done,
    Failed,
}

impl CompactionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }
}

impl std::str::FromStr for CompactionStatus {
    type Err = crate::core::errors::ApiError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "done" => Ok(Self::Done),
            "failed" => Ok(Self::Failed),
            _ => Err(crate::core::errors::ApiError::BadRequest(format!(
                "Invalid CompactionStatus: {}",
                s
            ))),
        }
    }
}

/// Source role of a memory event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceRole {
    User,
    Assistant,
    Tool,
    System,
}

impl SourceRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
            Self::System => "system",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "assistant" => Self::Assistant,
            "tool" => Self::Tool,
            "system" => Self::System,
            _ => Self::User,
        }
    }
}

// ---------------------------------------------------------------------------
// Core domain structs
// ---------------------------------------------------------------------------

/// A single memory event (the atomic unit of memory in v2).
///
/// Corresponds to `memory_events` table.  One conversation turn can yield
/// multiple `MemoryEvent`s after segmentation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEvent {
    pub id: String,
    pub session_id: String,
    pub character_id: Option<String>,
    pub scope: MemoryScope,
    pub episode_id: String,
    pub event_seq: u32,
    pub source_turn_id: Option<String>,
    pub source_role: Option<SourceRole>,
    pub content: String,
    pub summary: Option<String>,
    pub embedding: Vec<f32>,
    pub surprise_mean: Option<f64>,
    pub surprise_max: Option<f64>,
    pub importance: f64,
    pub strength: f64,
    pub layer: MemoryLayer,
    pub access_count: u32,
    pub last_accessed_at: Option<DateTime<Utc>>,
    pub decay_anchor_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub is_deleted: bool,
}

/// A directed edge between two memory events.
///
/// Corresponds to `memory_edges` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEdge {
    pub id: String,
    pub session_id: String,
    pub from_event_id: String,
    pub to_event_id: String,
    pub edge_type: MemoryEdgeType,
    pub weight: f64,
    pub created_at: DateTime<Utc>,
}

/// A compaction (LLM-assisted compression) job.
///
/// Corresponds to `memory_compaction_jobs` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactionJob {
    pub id: String,
    pub session_id: String,
    pub scope: MemoryScope,
    pub status: CompactionStatus,
    pub scanned_events: usize,
    pub merged_groups: usize,
    pub replaced_events: usize,
    pub created_events: usize,
    pub created_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

/// A record linking an original event to a newly created (compressed) event.
///
/// Corresponds to `memory_compaction_members` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactionMember {
    pub id: String,
    pub job_id: String,
    pub original_event_id: String,
    pub new_event_id: String,
}

// ---------------------------------------------------------------------------
// Query / filter helpers
// ---------------------------------------------------------------------------

/// Lightweight aggregate counts per layer.
#[derive(Debug, Clone, Default, Serialize)]
pub struct LayerCounts {
    pub lml: usize,
    pub sml: usize,
}

/// Memory statistics for a single scope.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ScopeStats {
    pub total_events: usize,
    pub layer_counts: LayerCounts,
    pub mean_strength: f64,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_scope_round_trip() {
        use std::str::FromStr;
        assert_eq!(
            MemoryScope::from_str(MemoryScope::Char.as_str()).unwrap(),
            MemoryScope::Char
        );
        assert_eq!(
            MemoryScope::from_str(MemoryScope::Prof.as_str()).unwrap(),
            MemoryScope::Prof
        );
        assert!(MemoryScope::from_str("unknown").is_err());
    }

    #[test]
    fn memory_edge_type_round_trip() {
        for ty in [
            MemoryEdgeType::TemporalNext,
            MemoryEdgeType::SemanticNeighbor,
            MemoryEdgeType::CompressedFrom,
        ] {
            assert_eq!(MemoryEdgeType::parse(ty.as_str()), ty);
        }
    }

    #[test]
    fn compaction_status_round_trip() {
        use std::str::FromStr;
        for s in [
            CompactionStatus::Queued,
            CompactionStatus::Running,
            CompactionStatus::Done,
            CompactionStatus::Failed,
        ] {
            assert_eq!(CompactionStatus::from_str(s.as_str()).unwrap(), s);
        }
        assert!(CompactionStatus::from_str("unknown").is_err());
    }

    #[test]
    fn source_role_round_trip() {
        for r in [
            SourceRole::User,
            SourceRole::Assistant,
            SourceRole::Tool,
            SourceRole::System,
        ] {
            assert_eq!(SourceRole::parse(r.as_str()), r);
        }
    }
}
