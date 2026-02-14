#![allow(dead_code)]
#![allow(unused_imports)]
//! RAG (Retrieval-Augmented Generation) module.
//!
//! This module provides:
//! - `RAGEngine`: Collects and processes chunks from web content and attachments
//! - `RAGContextBuilder`: Builds context strings from chunks using embedding similarity
//! - `RagStore` trait: Abstract interface for vector storage backends
//! - `LanceDbRagStore`: LanceDB-backed implementation of `RagStore` (in-process ANN search)

mod context_builder;
mod engine;
pub mod lancedb;
pub mod store;

pub use context_builder::RAGContextBuilder;
pub use engine::RAGEngine;
pub use lancedb::LanceDbRagStore;
pub use store::{ChunkSearchResult, RagStore, StoredChunk};
