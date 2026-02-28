//! Tepora Backend Library
//! 
//! Exposes all core backend logic for use in embedded scenarios (like Tauri IPC).

pub mod a2a;
pub mod actor;
pub mod agent;
pub mod context;
pub mod core;
pub mod em_llm;
pub mod graph;
pub mod history;
pub mod llm;
pub mod mcp;
pub mod memory;
pub mod memory_v2;
pub mod models;
pub mod rag;
pub mod server;
pub mod state;
pub mod tools;

#[cfg(test)]
pub mod crdt;
#[cfg(feature = "redesign_sandbox")]
pub mod sandbox;
