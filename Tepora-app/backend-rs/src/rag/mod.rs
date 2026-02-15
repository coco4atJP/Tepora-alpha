#![allow(dead_code)]
#![allow(unused_imports)]
//! RAG (Retrieval-Augmented Generation) module.
//!
//! This module provides:
//! - `RAGEngine`: Collects and processes chunks from web content and attachments
//! - `RAGContextBuilder`: Builds context strings from chunks using embedding similarity
//! - `RagStore` trait: Abstract interface for vector storage backends
//! - `SqliteRagStore`: In-process SQLite-backed implementation of `RagStore`

mod context_builder;
mod engine;
pub mod sqlite;
pub mod store;

pub use context_builder::RAGContextBuilder;
pub use engine::RAGEngine;
pub use sqlite::SqliteRagStore;
pub use store::{ChunkSearchResult, RagStore, StoredChunk};
