//! Episodic memory infrastructure boundary.
//!
//! Phase 1 keeps existing implementations (`em_llm`, `memory_v2`) and exposes
//! them from a single namespace to prepare migration away from legacy paths.
#![allow(unused_imports)]

pub use crate::em_llm::{EmMemoryService, RetrievedMemory};
pub use crate::memory_v2::adapter::{MemoryAdapter, UnifiedMemoryAdapter};
pub use crate::memory_v2::repository::{MemoryRepository, ScoredEvent};
pub use crate::memory_v2::sqlite_repository::SqliteMemoryRepository;
pub use crate::memory_v2::types::{
    CompactionJob, CompactionMember, CompactionStatus, MemoryEdge, MemoryEdgeType, MemoryEvent,
    MemoryLayer, MemoryScope, ScopeStats, SourceRole,
};
