#![allow(dead_code, unused_imports, unused_variables)]
//! EM-LLM (Episodic Memory for Large Language Models) module.
//!
//! This module implements the EM-LLM system based on the ICLR 2025 paper
//! "Human-inspired Episodic Memory for Infinite Context LLMs".

mod boundary;
mod compression;
mod decay;
mod integrator;
mod ranking;
mod retrieval;
mod segmenter;
pub mod service;
pub mod store;
mod types;
pub mod sentence;

#[cfg(test)]
mod tests;

pub use boundary::EMBoundaryRefiner;
pub use compression::{CompressionResult, MemoryCompressor};
pub use decay::DecayEngine;
pub use integrator::EMLLMIntegrator;
pub use retrieval::EMTwoStageRetrieval;
pub use segmenter::EMEventSegmenter;
pub use service::{EmMemoryService, EmMemoryStats, RetrievedMemory};
pub use store::EmMemoryStore;
pub use types::{DecayConfig, EMConfig, EpisodicEvent, MemoryLayer};
