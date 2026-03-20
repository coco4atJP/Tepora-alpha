pub mod loader;
pub mod node;
pub mod builder;
pub mod nodes;
pub mod runtime;
pub mod schema;
pub mod state;
pub mod stream;

pub use node::NodeContext;
pub use runtime::{GraphBuilder, GraphRuntime};
pub use state::{AgentState, Mode};

// Factory function
use crate::core::config::ConfigService;

pub fn build_tepora_graph(
    config_service: &ConfigService,
) -> Result<GraphRuntime, crate::state::error::InitializationError> {
    builder::build_tepora_graph(config_service)
        .map_err(|e| crate::state::error::InitializationError::Graph(e.into()))
}
