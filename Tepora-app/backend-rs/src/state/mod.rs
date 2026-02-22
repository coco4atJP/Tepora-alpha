use std::ops::Deref;
use std::sync::Arc;

use axum::extract::FromRef;

use crate::agent::exclusive_manager::ExclusiveAgentManager;
use crate::core::config::{AppPaths, ConfigService};
use crate::core::security::{init_session_token, SessionToken};
use crate::em_llm::EmMemoryService;
use crate::graph::{build_tepora_graph, GraphRuntime};
use crate::history::HistoryStore;
use crate::llm::LlamaService;
use crate::llm::LlmService;
use crate::mcp::registry::McpRegistry;
use crate::mcp::McpManager;
use crate::models::ModelManager;
use crate::rag::{RagStore, SqliteRagStore};

pub mod error;
pub mod setup;

use error::InitializationError;
use setup::SetupState;

#[allow(dead_code)]
/// Marker type for read-only application state access.
pub enum ReadAccess {}

#[allow(dead_code)]
/// Marker type for mutating application state access.
pub enum WriteAccess {}

#[allow(dead_code)]
/// Access contract that keeps read/write intent explicit at type level.
pub trait AppStateRef<Access> {
    fn state(&self) -> &AppState;
    fn shared(&self) -> Arc<AppState>;
}

/// Read-only reference extracted from shared application state.
#[derive(Clone)]
pub struct AppStateRead(Arc<AppState>);

/// Mutating reference extracted from shared application state.
#[derive(Clone)]
pub struct AppStateWrite(Arc<AppState>);

#[allow(dead_code)]
impl AppStateRead {
    pub fn shared(&self) -> Arc<AppState> {
        self.0.clone()
    }
}

impl AppStateWrite {
    pub fn shared(&self) -> Arc<AppState> {
        self.0.clone()
    }

    pub fn into_read(self) -> AppStateRead {
        AppStateRead(self.0)
    }
}

impl From<AppStateWrite> for AppStateRead {
    fn from(value: AppStateWrite) -> Self {
        value.into_read()
    }
}

impl Deref for AppStateRead {
    type Target = AppState;

    fn deref(&self) -> &Self::Target {
        self.0.as_ref()
    }
}

impl Deref for AppStateWrite {
    type Target = AppState;

    fn deref(&self) -> &Self::Target {
        self.0.as_ref()
    }
}

impl AsRef<AppState> for AppStateRead {
    fn as_ref(&self) -> &AppState {
        self.0.as_ref()
    }
}

impl AsRef<AppState> for AppStateWrite {
    fn as_ref(&self) -> &AppState {
        self.0.as_ref()
    }
}

impl AppStateRef<ReadAccess> for AppStateRead {
    fn state(&self) -> &AppState {
        self.0.as_ref()
    }

    fn shared(&self) -> Arc<AppState> {
        self.0.clone()
    }
}

impl AppStateRef<WriteAccess> for AppStateWrite {
    fn state(&self) -> &AppState {
        self.0.as_ref()
    }

    fn shared(&self) -> Arc<AppState> {
        self.0.clone()
    }
}

impl FromRef<Arc<AppState>> for AppStateRead {
    fn from_ref(input: &Arc<AppState>) -> Self {
        Self(input.clone())
    }
}

impl FromRef<Arc<AppState>> for AppStateWrite {
    fn from_ref(input: &Arc<AppState>) -> Self {
        Self(input.clone())
    }
}

/// Global application state shared across all routes and background tasks.
///
/// Contains references to:
/// - Configuration and paths
/// - Database connections (History, RAG)
/// - LLM services and models
/// - Helper managers (MCP, Exclusive Agents)
/// - Graph runtime for agent execution
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
    pub exclusive_agents: ExclusiveAgentManager,
    pub rag_store: Arc<dyn RagStore>,
    pub graph_runtime: Arc<GraphRuntime>,
    pub em_memory_service: Arc<EmMemoryService>,
}

impl AppState {
    /// Initializes the application state.
    ///
    /// This process includes:
    /// 1. Setting up paths and loading configuration
    /// 2. Initializing databases (History, RAG, Memory)
    /// 3. Setting up LLM services and downloading default models if needed
    /// 4. Initializing MCP and Exclusive Agent managers
    /// 5. Building the agent execution graph
    pub async fn initialize() -> Result<Arc<Self>, InitializationError> {
        let paths = Arc::new(AppPaths::new());
        let config = ConfigService::new(paths.clone());
        let session_token = init_session_token();

        let history = HistoryStore::new(paths.db_path.clone())
            .await
            .map_err(|e| InitializationError::History(e.into()))?;

        let llama =
            LlamaService::new(paths.clone()).map_err(|e| InitializationError::Llm(e.into()))?;

        let mcp = McpManager::new(paths.clone(), config.clone());
        let mcp_registry = McpRegistry::new(&paths);
        let models = ModelManager::new(&paths, config.clone());
        let setup = SetupState::new(&paths);
        let exclusive_agents = ExclusiveAgentManager::new(paths.as_ref());

        if !exclusive_agents.config_path().exists() {
            if let Err(e) = exclusive_agents.create_default_config() {
                tracing::warn!("Failed to create default agents.yaml: {}", e);
            }
        }

        let rag_store = Arc::new(
            SqliteRagStore::new(paths.as_ref())
                .await
                .map_err(|e| InitializationError::Rag(e.into()))?,
        );

        let graph_runtime = Arc::new(
            build_tepora_graph(&config).map_err(|e| InitializationError::Graph(e.into()))?,
        );

        let em_memory_service = Arc::new(
            EmMemoryService::new(paths.as_ref(), &config)
                .await
                .map_err(|e| InitializationError::EmMemory(e.into()))?,
        );

        let models_clone = models.clone();
        tokio::spawn(async move {
            if let Err(e) = models_clone.refresh_all_loader_models().await {
                tracing::warn!("Failed to refresh loader models on startup: {}", e);
            }
        });

        let llm = LlmService::new(models.clone(), llama.clone(), config.clone());

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
            exclusive_agents,
            rag_store,
            graph_runtime,
            em_memory_service,
        }))
    }
}
