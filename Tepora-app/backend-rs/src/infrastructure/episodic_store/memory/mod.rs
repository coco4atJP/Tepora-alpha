#![allow(dead_code, unused_imports)]
//! Unified memory module (EM-LLM × FadeMem).
//!
//! This module is the single implementation entry point for the memory system.

pub mod adapter;
pub mod boundary;
pub mod compression;
pub mod decay;
pub mod integrator;
pub mod ranking;
pub mod repository;
pub mod retrieval;
pub mod segmenter;
pub mod sentence;
pub mod service;
pub mod sqlite_repository;
pub mod types;

#[cfg(test)]
mod tests;

pub use adapter::{MemoryAdapter, UnifiedMemoryAdapter};
pub use boundary::EMBoundaryRefiner;
pub use compression::{CompressionResult, MemoryCompressor};
pub use decay::DecayEngine;
pub use integrator::EMLLMIntegrator;
pub use repository::{MemoryRepository, ScoredEvent};
pub use retrieval::EMTwoStageRetrieval;
pub use segmenter::EMEventSegmenter;
pub use service::{DecayCycleResult, MemoryService, MemoryStats, RetrievedMemory};
pub use sqlite_repository::SqliteMemoryRepository;
pub use types::{
    CompactionJob, CompactionMember, CompactionStatus, DecayConfig, EMConfig, EpisodicEvent,
    LayerCounts, MemoryEdge, MemoryEdgeType, MemoryEvent, MemoryLayer, MemoryScope, ScopeStats,
    SourceRole, TimeUnit,
};
