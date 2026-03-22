//! Episodic memory infrastructure boundary.
//!
//! Exposes the unified memory service, repository, and shared types from a
//! single namespace.
#![allow(unused_imports)]

pub use crate::memory::types::{
    CompactionJob, CompactionMember, CompactionStatus, MemoryEdge, MemoryEdgeType, MemoryEvent,
    MemoryLayer, ScopeStats, SourceRole,
};
pub use crate::memory::{
    MemoryAdapter, MemoryRepository, MemoryScope, MemoryService, RetrievedMemory, ScoredEvent,
    SqliteMemoryRepository, UnifiedMemoryAdapter,
};
