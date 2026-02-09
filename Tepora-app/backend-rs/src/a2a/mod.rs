#![allow(dead_code)]
#![allow(unused_imports)]
//! A2A (Agent-to-Agent) Protocol module.
//!
//! Defines message types and structures for inter-agent communication.

mod protocol;

// #[allow(unused_imports)]
pub use protocol::{A2AMessage, MessageType};
