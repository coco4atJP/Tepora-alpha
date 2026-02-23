#![allow(dead_code)]
//! Memory v2 data types.
//!
//! Core domain models for the redesigned memory system based on
//! EM-LLM (arXiv 2407.09450) and FadeMem (arXiv 2601.18642).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// Re-export MemoryLayer from existing em_llm module to avoid duplication.
// Note: em_llm::types is private, but MemoryLayer is re-exported at crate::em_llm level.
pub use crate::em_llm::MemoryLayer;

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

    pub fn parse(s: &str) -> Self {
        if s.eq_ignore_ascii_case("PROF") {
            Self::Prof
        } else {
            Self::Char
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

    pub fn parse(s: &str) -> Self {
        match s {
            "running" => Self::Running,
            "done" => Self::Done,
            "failed" => Self::Failed,
            _ => Self::Queued,
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
        assert_eq!(MemoryScope::parse(MemoryScope::Char.as_str()), MemoryScope::Char);
        assert_eq!(MemoryScope::parse(MemoryScope::Prof.as_str()), MemoryScope::Prof);
        assert_eq!(MemoryScope::parse("unknown"), MemoryScope::Char); // default
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
        for s in [
            CompactionStatus::Queued,
            CompactionStatus::Running,
            CompactionStatus::Done,
            CompactionStatus::Failed,
        ] {
            assert_eq!(CompactionStatus::parse(s.as_str()), s);
        }
    }

    #[test]
    fn source_role_round_trip() {
        for r in [SourceRole::User, SourceRole::Assistant, SourceRole::Tool, SourceRole::System] {
            assert_eq!(SourceRole::parse(r.as_str()), r);
        }
    }
}
