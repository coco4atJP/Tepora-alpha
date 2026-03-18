//! Tepora Backend Library
//!
//! Exposes all core backend logic for use in embedded scenarios (like Tauri IPC).

pub mod a2a;
pub mod actor;
pub mod agent;
pub mod application;
pub mod context;
pub mod core;
pub mod domain;
#[path = "infrastructure/episodic_store/em_llm/mod.rs"]
pub mod em_llm;
pub mod graph;
pub mod history;
pub mod infrastructure;
pub mod llm;
pub mod mcp;
#[path = "infrastructure/episodic_store/memory_v2/mod.rs"]
pub mod memory_v2;
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
