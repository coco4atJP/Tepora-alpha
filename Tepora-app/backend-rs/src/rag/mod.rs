// #![allow(dead_code)]
// #![allow(unused_imports)]
//! RAG (Retrieval-Augmented Generation) module.
//!
//! This module provides:
//! - `RAGEngine`: Collects and processes chunks from web content and attachments
//! - `RAGContextBuilder`: Builds context strings from chunks using embedding similarity

mod engine;
mod context_builder;

pub use engine::RAGEngine;
pub use context_builder::RAGContextBuilder;
