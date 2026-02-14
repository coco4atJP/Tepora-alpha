use std::sync::Arc;

use chrono::{DateTime, Utc};

use crate::core::config::{AppPaths, ConfigService};
use crate::history::HistoryStore;
use crate::llama::LlamaService;
use crate::mcp::McpManager;
use crate::mcp_registry::McpRegistry;
use crate::models::ModelManager;
use crate::core::security::{init_session_token, SessionToken};
use crate::setup_state::SetupState;
use crate::llm::LlmService;

#[derive(Clone)]
pub struct AppState {
    pub paths: Arc<AppPaths>,
    pub config: ConfigService,
    pub session_token: SessionToken,
    pub history: HistoryStore,
    pub llama: LlamaService,
    pub llm: LlmService,
    pub mcp: McpManager,
    pub mcp_registry: McpRegistry,
    pub models: ModelManager,
    pub setup: SetupState,
    #[allow(dead_code)]
    pub started_at: DateTime<Utc>,
}

impl AppState {
    pub async fn initialize() -> anyhow::Result<Arc<Self>> {
        let paths = Arc::new(AppPaths::new());
        let config = ConfigService::new(paths.clone());
        let session_token = init_session_token();
        let history = HistoryStore::new(paths.db_path.clone()).await?;
        let llama = LlamaService::new(paths.clone())?;
        let mcp = McpManager::new(paths.clone(), config.clone());
        let mcp_registry = McpRegistry::new(&paths);
        let models = ModelManager::new(&paths, config.clone());
        let setup = SetupState::new(&paths);
        let started_at = Utc::now();

        // Trigger loader refresh in background
        let models_clone = models.clone();
        tokio::spawn(async move {
            if let Err(e) = models_clone.refresh_all_loader_models().await {
                tracing::warn!("Failed to refresh loader models on startup: {}", e);
            }
        });

        // Initialize LlmService
        let llm = LlmService::new(models.clone(), llama.clone(), config.clone())?;

        Ok(Arc::new(AppState {
            paths,
            config,
            session_token,
            history,
            llama,
            llm,
            mcp,
            mcp_registry,
            models,
            setup,
            started_at,
        }))
    }
}
