mod config_store;
mod connection_manager;
pub mod installer;
mod manager;
mod policy_manager;
pub mod registry;
mod state;
#[cfg(test)]
mod tests;
mod tool_executor;
mod types;

pub use manager::McpManager;
#[allow(unused_imports)]
pub use types::{
    McpPolicy, McpServerConfig, McpServerMetadata, McpServerPermission, McpServerStatus,
    McpToolInfo, McpToolsConfig,
};
