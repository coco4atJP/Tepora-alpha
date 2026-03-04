//! Knowledge store infrastructure boundary.
//!
//! Phase 2 keeps the existing RAG implementation while exposing a
//! domain-facing adapter (`KnowledgePort`) for gradual migration.
#![allow(unused_imports)]

pub mod adapter;

pub use crate::rag::{
    ChunkSearchResult, ContextBuilderConfig, RAGConfig, RAGContextBuilder, RAGEngine, RagStore,
    SqliteRagStore, StoredChunk, TextChunk,
};
pub use adapter::RagKnowledgeAdapter;
