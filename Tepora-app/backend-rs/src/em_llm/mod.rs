#![allow(dead_code)]
#![allow(unused_imports)]
//! EM-LLM (Episodic Memory for Large Language Models) module.
//!
//! This module implements the EM-LLM system based on the ICLR 2025 paper
//! "Human-inspired Episodic Memory for Infinite Context LLMs".
//!
//! # Components
//!
//! - `types`: Core data structures (EpisodicEvent, EMConfig)
//! - `segmenter`: Event segmentation based on surprise/semantic change
//! - `boundary`: Graph-theoretic boundary refinement
//! - `retrieval`: Two-stage retrieval (similarity + contiguity)
//! - `integrator`: Main integration point for the EM-LLM system

mod types;
mod segmenter;
mod boundary;
mod retrieval;
mod integrator;

pub use types::{EMConfig, EpisodicEvent};
pub use segmenter::EMEventSegmenter;
pub use boundary::EMBoundaryRefiner;
pub use retrieval::EMTwoStageRetrieval;
pub use integrator::EMLLMIntegrator;
