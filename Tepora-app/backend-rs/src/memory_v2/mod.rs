#![allow(dead_code, unused_imports)]
//! Memory v2 — redesigned memory system (EM-LLM × FadeMem).
//!
//! This module provides the new memory architecture described in the
//! full redesign document.  It is introduced alongside the existing
//! `em_llm` module and will gradually replace it over phases 1-6.

pub mod repository;
pub mod sqlite_repository;
pub mod types;

#[cfg(test)]
mod tests;

pub use repository::{MemoryRepository, ScoredEvent};
pub use sqlite_repository::SqliteMemoryRepository;
pub use types::{
    CompactionJob, CompactionMember, CompactionStatus, MemoryEdge, MemoryEdgeType, MemoryEvent,
    MemoryLayer, MemoryScope, ScopeStats, SourceRole,
};
