//! Tepora Backend Library
//!
//! Exposes all core backend logic for use in embedded scenarios (like Tauri IPC).

pub mod a2a;
pub mod actor;
pub mod agent;
pub mod application;
pub mod cli;
pub mod context;
pub mod core;
pub mod domain;
pub mod graph;
pub mod history;
pub mod infrastructure;
pub mod llm;
pub mod mcp;
#[path = "infrastructure/episodic_store/memory/mod.rs"]
pub mod memory;
pub mod models;
#[path = "infrastructure/knowledge_store/rag/mod.rs"]
pub mod rag;
pub mod server;
pub mod state;
#[cfg(test)]
pub mod test_support;
pub mod tools;

#[cfg(test)]
pub mod crdt;
#[cfg(feature = "redesign_sandbox")]
pub mod sandbox;
