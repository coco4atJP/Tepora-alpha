use std::sync::Arc;

use chrono::{DateTime, Utc};

use crate::config::{AppPaths, ConfigService};
use crate::history::HistoryStore;
use crate::llama::LlamaService;
use crate::mcp::McpManager;
use crate::mcp_registry::McpRegistry;
use crate::models::ModelManager;
use crate::security::{init_session_token, SessionToken};
use crate::setup_state::SetupState;

#[derive(Clone)]
pub struct AppState {
    pub paths: Arc<AppPaths>,
    pub config: ConfigService,
    pub session_token: SessionToken,
    pub history: HistoryStore,
    pub llama: LlamaService,
    pub mcp: McpManager,
    pub mcp_registry: McpRegistry,
    pub models: ModelManager,
    pub setup: SetupState,
    #[allow(dead_code)]
    pub started_at: DateTime<Utc>,
}

impl AppState {
    pub fn initialize() -> anyhow::Result<Arc<Self>> {
        let paths = Arc::new(AppPaths::new());
        let config = ConfigService::new(paths.clone());
        let session_token = init_session_token();
        let history = HistoryStore::new(paths.db_path.clone())?;
        let llama = LlamaService::new(paths.clone())?;
        let mcp = McpManager::new(paths.clone(), config.clone());
        let mcp_registry = McpRegistry::new(&paths);
        let models = ModelManager::new(&paths, config.clone());
        let setup = SetupState::new(&paths);
        let started_at = Utc::now();

        Ok(Arc::new(AppState {
            paths,
            config,
            session_token,
            history,
            llama,
            mcp,
            mcp_registry,
            models,
            setup,
            started_at,
        }))
    }
}
