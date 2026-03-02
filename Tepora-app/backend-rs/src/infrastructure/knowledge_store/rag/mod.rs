#![allow(dead_code)]
#![allow(unused_imports)]
//! RAG (Retrieval-Augmented Generation) module.
//!
//! This module is now mounted from `infrastructure/knowledge_store/rag`.
//! Implementation files are kept in their current location during migration.

#[path = "../../../rag/context_builder.rs"]
mod context_builder;
#[path = "../../../rag/engine.rs"]
mod engine;
#[path = "../../../rag/sqlite.rs"]
pub mod sqlite;
#[path = "../../../rag/store.rs"]
pub mod store;

pub use context_builder::{ContextBuilderConfig, RAGContextBuilder};
pub use engine::{RAGConfig, RAGEngine, TextChunk};
pub use sqlite::SqliteRagStore;
pub use store::{ChunkSearchResult, RagStore, StoredChunk};
