#![allow(dead_code)]
//! Memory v2 repository trait.
//!
//! Defines the storage abstraction layer for the redesigned memory system.
//! Implementations can target SQLite (default), PostgreSQL, etc.

use async_trait::async_trait;

use crate::core::errors::ApiError;

use super::types::{
    CompactionJob, CompactionMember, CompactionStatus, LayerCounts, MemoryEdge, MemoryEdgeType,
    MemoryEvent, MemoryLayer, MemoryScope, ScopeStats,
};

/// Retrieved event with its relevance score.
#[derive(Debug, Clone)]
pub struct ScoredEvent {
    pub event: MemoryEvent,
    pub score: f64,
}

/// Abstract storage interface for memory v2 events, edges, and compaction jobs.
#[async_trait]
pub trait MemoryRepository: Send + Sync {
    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    /// Persist a single memory event.
    async fn insert_event(&self, event: &MemoryEvent) -> Result<(), ApiError>;

    /// Persist multiple memory events in a batch.
    async fn insert_events(&self, events: &[MemoryEvent]) -> Result<(), ApiError>;

    /// Retrieve a single event by ID (including soft-deleted).
    async fn get_event(&self, id: &str) -> Result<Option<MemoryEvent>, ApiError>;

    /// List events for a session+scope, ordered by `created_at DESC`.
    /// Excludes soft-deleted events.
    async fn get_events_by_scope(
        &self,
        session_id: &str,
        scope: MemoryScope,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<MemoryEvent>, ApiError>;

    /// Embedding-based similarity search.  Returns top-`limit` events ordered
    /// by cosine similarity, excluding soft-deleted events.
    async fn retrieve_similar(
        &self,
        session_id: Option<&str>,
        scope: Option<MemoryScope>,
        query_embedding: &[f32],
        limit: usize,
    ) -> Result<Vec<ScoredEvent>, ApiError>;

    /// Update the strength value of a single event.
    async fn update_strength(&self, id: &str, strength: f64) -> Result<(), ApiError>;

    /// Update the strength and decay\_anchor\_at of a single event (used by decay cycle).
    async fn update_strength_and_anchor(
        &self,
        id: &str,
        strength: f64,
        anchor_time_rfc3339: &str,
    ) -> Result<(), ApiError>;

    /// Update the memory layer of a single event.
    async fn update_layer(&self, id: &str, layer: MemoryLayer) -> Result<(), ApiError>;

    /// Update the importance value of a single event.
    async fn update_importance(&self, id: &str, importance: f64) -> Result<(), ApiError>;

    /// Record an access: increment `access_count`, set `last_accessed_at`,
    /// and optionally update strength (reinforcement).
    async fn record_access(&self, id: &str, new_strength: f64) -> Result<(), ApiError>;

    /// Soft-delete events by setting `is_deleted = 1`.
    async fn soft_delete_events(&self, ids: &[String]) -> Result<usize, ApiError>;

    /// Get all non-deleted events with full metadata (used by decay cycle).
    async fn get_all_events(
        &self,
        session_id: Option<&str>,
        scope: Option<MemoryScope>,
    ) -> Result<Vec<MemoryEvent>, ApiError>;

    // ---------------------------------------------------------------
    // Aggregates
    // ---------------------------------------------------------------

    /// Count non-deleted events.
    async fn count_events(
        &self,
        session_id: Option<&str>,
        scope: Option<MemoryScope>,
    ) -> Result<usize, ApiError>;

    /// Count non-deleted events per layer.
    async fn count_by_layer(
        &self,
        session_id: Option<&str>,
        scope: Option<MemoryScope>,
    ) -> Result<LayerCounts, ApiError>;

    /// Average strength of non-deleted events.
    async fn average_strength(
        &self,
        session_id: Option<&str>,
        scope: Option<MemoryScope>,
    ) -> Result<f64, ApiError>;

    /// Per-scope statistics.
    async fn scope_stats(
        &self,
        session_id: Option<&str>,
        scope: MemoryScope,
    ) -> Result<ScopeStats, ApiError>;

    // ---------------------------------------------------------------
    // Edges
    // ---------------------------------------------------------------

    /// Insert a directed edge between two events.
    async fn insert_edge(&self, edge: &MemoryEdge) -> Result<(), ApiError>;

    /// Insert multiple edges in a batch.
    async fn insert_edges(&self, edges: &[MemoryEdge]) -> Result<(), ApiError>;

    /// Get outgoing edges from an event, optionally filtered by type.
    async fn get_edges_from(
        &self,
        event_id: &str,
        edge_type: Option<MemoryEdgeType>,
    ) -> Result<Vec<MemoryEdge>, ApiError>;

    /// Get incoming edges to an event, optionally filtered by type.
    async fn get_edges_to(
        &self,
        event_id: &str,
        edge_type: Option<MemoryEdgeType>,
    ) -> Result<Vec<MemoryEdge>, ApiError>;

    // ---------------------------------------------------------------
    // Compaction
    // ---------------------------------------------------------------

    /// Create a new compaction job record.
    async fn create_compaction_job(&self, job: &CompactionJob) -> Result<(), ApiError>;

    /// Update a compaction job (status, counts, finished_at).
    async fn update_compaction_job(&self, job: &CompactionJob) -> Result<(), ApiError>;

    /// Add provenance records for a compaction.
    async fn add_compaction_members(&self, members: &[CompactionMember]) -> Result<(), ApiError>;

    /// List compaction jobs for a session+scope.
    async fn list_compaction_jobs(
        &self,
        session_id: Option<&str>,
        scope: Option<MemoryScope>,
        status: Option<CompactionStatus>,
    ) -> Result<Vec<CompactionJob>, ApiError>;
}
