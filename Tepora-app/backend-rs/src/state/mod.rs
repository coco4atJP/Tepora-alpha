use std::ops::Deref;
use std::sync::Arc;

use axum::extract::FromRef;

use crate::actor::ActorManager;
use crate::agent::exclusive_manager::ExclusiveAgentManager;
use crate::application::episodic_memory::EpisodicMemoryUseCase;
use crate::application::knowledge::KnowledgeUseCase;
use crate::core::config::{AppPaths, ConfigService};
use crate::core::security::{init_session_token, SessionToken};
use crate::core::security_controls::SecurityControls;
use crate::domain::episodic_memory::EpisodicMemoryPort;
use crate::domain::knowledge::KnowledgePort;
use crate::em_llm::EmMemoryService;
use crate::graph::{build_tepora_graph, GraphRuntime};
use crate::history::HistoryStore;
use crate::infrastructure::episodic_store::{MemoryAdapter, UnifiedMemoryAdapter};
use crate::infrastructure::knowledge_store::RagKnowledgeAdapter;
use crate::llm::LlamaService;
use crate::llm::LlmService;
use crate::mcp::registry::McpRegistry;
use crate::mcp::McpManager;
use crate::models::ModelManager;
use crate::rag::{RagStore, SqliteRagStore};
use crate::server::middleware::rate_limit::RateLimiters;

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

#[derive(Clone)]
pub struct AppCoreState {
    pub paths: Arc<AppPaths>,
    pub config: ConfigService,
    pub session_token: Arc<tokio::sync::RwLock<SessionToken>>,
    pub setup: SetupState,
    pub security: Arc<SecurityControls>,
}

#[derive(Clone)]
pub struct AppAiState {
    pub llama: LlamaService,
    pub llm: LlmService,
    pub models: ModelManager,
    pub exclusive_agents: ExclusiveAgentManager,
}

#[derive(Clone)]
pub struct AppIntegrationState {
    pub mcp: McpManager,
    pub mcp_registry: McpRegistry,
}

#[derive(Clone)]
pub struct AppRuntimeState {
    pub history: HistoryStore,
    pub graph_runtime: Arc<GraphRuntime>,
    pub rate_limiters: Arc<RateLimiters>,
    pub actor_manager: Arc<ActorManager>,
}

#[derive(Clone)]
pub struct AppMemoryState {
    pub em_memory_service: Arc<EmMemoryService>,
    pub memory_adapter: Arc<dyn MemoryAdapter>,
    pub episodic_memory: Arc<dyn EpisodicMemoryPort>,
    pub knowledge: Arc<dyn KnowledgePort>,
    pub episodic_memory_use_case: Arc<EpisodicMemoryUseCase>,
    pub knowledge_use_case: Arc<KnowledgeUseCase>,
}

/// Backward-compatible flattened view used by existing call sites (`state.history`, `state.llm`, etc.).
#[derive(Clone)]
pub struct AppStateCompat {
    pub paths: Arc<AppPaths>,
    pub config: ConfigService,
    pub session_token: Arc<tokio::sync::RwLock<SessionToken>>,
    pub security: Arc<SecurityControls>,
    pub history: HistoryStore,
    pub llama: LlamaService,
    pub llm: LlmService,
    pub mcp: McpManager,
    pub mcp_registry: McpRegistry,
    pub models: ModelManager,
    pub setup: SetupState,
    pub exclusive_agents: ExclusiveAgentManager,
    pub graph_runtime: Arc<GraphRuntime>,
    pub em_memory_service: Arc<EmMemoryService>,
    pub rate_limiters: Arc<RateLimiters>,
    pub actor_manager: Arc<ActorManager>,
    pub memory_adapter: Arc<dyn MemoryAdapter>,
    pub episodic_memory: Arc<dyn EpisodicMemoryPort>,
    pub knowledge: Arc<dyn KnowledgePort>,
    pub episodic_memory_use_case: Arc<EpisodicMemoryUseCase>,
    pub knowledge_use_case: Arc<KnowledgeUseCase>,
}

/// Global application state shared across all routes and background tasks.
/// Top-level fields are grouped by responsibility to avoid a God Object.
#[derive(Clone)]
pub struct AppState {
    pub core: Arc<AppCoreState>,
    pub ai: Arc<AppAiState>,
    pub integration: Arc<AppIntegrationState>,
    pub runtime: Arc<AppRuntimeState>,
    pub memory: Arc<AppMemoryState>,
    compat: AppStateCompat,
}

impl Deref for AppState {
    type Target = AppStateCompat;

    fn deref(&self) -> &Self::Target {
        &self.compat
    }
}

impl AppState {
    pub(crate) fn from_groups(
        core: Arc<AppCoreState>,
        ai: Arc<AppAiState>,
        integration: Arc<AppIntegrationState>,
        runtime: Arc<AppRuntimeState>,
        memory: Arc<AppMemoryState>,
    ) -> Self {
        let compat = AppStateCompat {
            paths: core.paths.clone(),
            config: core.config.clone(),
            session_token: core.session_token.clone(),
            security: core.security.clone(),
            history: runtime.history.clone(),
            llama: ai.llama.clone(),
            llm: ai.llm.clone(),
            mcp: integration.mcp.clone(),
            mcp_registry: integration.mcp_registry.clone(),
            models: ai.models.clone(),
            setup: core.setup.clone(),
            exclusive_agents: ai.exclusive_agents.clone(),
            graph_runtime: runtime.graph_runtime.clone(),
            em_memory_service: memory.em_memory_service.clone(),
            rate_limiters: runtime.rate_limiters.clone(),
            actor_manager: runtime.actor_manager.clone(),
            memory_adapter: memory.memory_adapter.clone(),
            episodic_memory: memory.episodic_memory.clone(),
            knowledge: memory.knowledge.clone(),
            episodic_memory_use_case: memory.episodic_memory_use_case.clone(),
            knowledge_use_case: memory.knowledge_use_case.clone(),
        };

        Self {
            core,
            ai,
            integration,
            runtime,
            memory,
            compat,
        }
    }

    /// Check if a specific redesign feature is enabled via feature flags.
    pub fn is_redesign_enabled(&self, feature: &str) -> bool {
        self.config
            .load_config()
            .ok()
            .and_then(|c| c.get("features").cloned())
            .and_then(|f| f.get("redesign").cloned())
            .and_then(|r| r.get(feature).cloned())
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

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
        let security = Arc::new(SecurityControls::new(paths.clone(), config.clone()));
        let session_token = Arc::new(tokio::sync::RwLock::new(init_session_token()));
        backup_sqlite_databases(paths.as_ref());

        let history = HistoryStore::new(paths.db_path.clone())
            .await
            .map_err(|e| InitializationError::History(e.into()))?;

        let llama =
            LlamaService::new(paths.clone()).map_err(|e| InitializationError::Llm(e.into()))?;

        let mcp = McpManager::new(paths.clone(), config.clone());
        let mcp_registry = McpRegistry::new(&paths);
        let models = ModelManager::new(&paths, config.clone());
        let setup = SetupState::new(&paths);
        let exclusive_agents = ExclusiveAgentManager::new(paths.as_ref(), config.clone());

        if exclusive_agents.list_all().is_empty() {
            if let Err(e) = exclusive_agents.create_default_config() {
                tracing::warn!("Failed to create default custom_agents config: {}", e);
            }
        }

        let is_declarative = config
            .load_config()
            .ok()
            .and_then(|c| c.get("features").cloned())
            .and_then(|f| f.get("redesign").cloned())
            .and_then(|r| r.get("declarative_graph").cloned())
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let graph_runtime = if is_declarative {
            let json_path = paths.project_root.join("workflows").join("default.json");
            let loaded = std::fs::read_to_string(&json_path)
                .map_err(|e| InitializationError::Graph(e.into()))
                .and_then(|s| {
                    serde_json::from_str::<serde_json::Value>(&s)
                        .map_err(|e| InitializationError::Graph(e.into()))
                })
                .and_then(|val| {
                    if let Err(errors) = crate::graph::schema::validate_workflow_json(&val) {
                        tracing::error!(
                            "Declarative workflow JSON failed schema validation: {:?}",
                            errors
                        );
                        return Err(InitializationError::Graph(anyhow::anyhow!(
                            "Workflow schema validation failed"
                        )));
                    }
                    serde_json::from_value::<crate::graph::schema::WorkflowDef>(val)
                        .map_err(|e| InitializationError::Graph(e.into()))
                })
                .and_then(|def| {
                    crate::graph::loader::load_workflow_from_json(&def)
                        .map_err(|e| InitializationError::Graph(e.into()))
                });

            match loaded {
                Ok(rt) => {
                    tracing::info!("Loaded declarative graph from JSON successfully.");
                    Arc::new(rt)
                }
                Err(e) => {
                    tracing::error!(
                        "Failed to load declarative graph: {:?}, falling back to hardcoded graph",
                        e
                    );
                    Arc::new(
                        build_tepora_graph(&config)
                            .map_err(|e| InitializationError::Graph(e.into()))?,
                    )
                }
            }
        } else {
            Arc::new(build_tepora_graph(&config).map_err(|e| InitializationError::Graph(e.into()))?)
        };

        let em_memory_service = Arc::new(
            EmMemoryService::new(paths.as_ref(), &config)
                .await
                .map_err(|e| InitializationError::EmMemory(e.into()))?,
        );

        let rag_store = Arc::new(
            SqliteRagStore::new(paths.as_ref())
                .await
                .map_err(|e| InitializationError::Rag(e.into()))?,
        );
        let rag_store: Arc<dyn RagStore> = rag_store;

        let llm = LlmService::new(models.clone(), llama.clone(), config.clone());
        let knowledge = Arc::new(RagKnowledgeAdapter::new(
            rag_store.clone(),
            llama.clone(),
            config.clone(),
        )) as Arc<dyn KnowledgePort>;

        let rate_limiters = Arc::new(RateLimiters::new());
        let actor_manager = Arc::new(ActorManager::new());
        let unified_memory_adapter = Arc::new(UnifiedMemoryAdapter::new_with_runtime(
            em_memory_service.clone(),
            em_memory_service.v2_store.clone(),
            llm.clone(),
            models.clone(),
            config.clone(),
        ));
        let memory_adapter = unified_memory_adapter.clone() as Arc<dyn MemoryAdapter>;
        let episodic_memory = unified_memory_adapter as Arc<dyn EpisodicMemoryPort>;
        let episodic_memory_use_case =
            Arc::new(EpisodicMemoryUseCase::new(episodic_memory.clone()));
        let knowledge_use_case = Arc::new(KnowledgeUseCase::new(knowledge.clone()));

        let core = Arc::new(AppCoreState {
            paths: paths.clone(),
            config: config.clone(),
            session_token: session_token.clone(),
            setup: setup.clone(),
            security: security.clone(),
        });
        let ai = Arc::new(AppAiState {
            llama: llama.clone(),
            llm: llm.clone(),
            models: models.clone(),
            exclusive_agents: exclusive_agents.clone(),
        });
        let integration = Arc::new(AppIntegrationState {
            mcp: mcp.clone(),
            mcp_registry: mcp_registry.clone(),
        });
        let runtime = Arc::new(AppRuntimeState {
            history: history.clone(),
            graph_runtime: graph_runtime.clone(),
            rate_limiters: rate_limiters.clone(),
            actor_manager: actor_manager.clone(),
        });
        let memory = Arc::new(AppMemoryState {
            em_memory_service: em_memory_service.clone(),
            memory_adapter: memory_adapter.clone(),
            episodic_memory: episodic_memory.clone(),
            knowledge: knowledge.clone(),
            episodic_memory_use_case: episodic_memory_use_case.clone(),
            knowledge_use_case: knowledge_use_case.clone(),
        });

        let app_state = Arc::new(AppState::from_groups(
            core,
            ai,
            integration,
            runtime,
            memory,
        ));
        app_state.actor_manager.clone().start_gc();

        // Start background tasks only after all state initialization succeeds.
        app_state
            .em_memory_service
            .clone()
            .spawn_background_worker();

        let models_clone = app_state.models.clone();
        tokio::spawn(async move {
            if let Err(e) = models_clone.refresh_all_loader_models().await {
                tracing::warn!("Failed to refresh loader models on startup: {}", e);
            }
        });

        Ok(app_state)
    }
}

fn backup_sqlite_databases(paths: &AppPaths) {
    let timestamp = chrono::Utc::now().format("%Y%m%d%H%M%S").to_string();
    let candidates = [
        paths.db_path.clone(),
        paths.user_data_dir.join("em_memory.db"),
        paths.user_data_dir.join("rag.db"),
    ];

    for source in candidates {
        if !source.exists() {
            continue;
        }

        let backup = next_backup_path(&source, &timestamp);
        match std::fs::copy(&source, &backup) {
            Ok(_) => tracing::info!(
                source = %source.display(),
                backup = %backup.display(),
                "Created startup database backup"
            ),
            Err(err) => tracing::warn!(
                source = %source.display(),
                backup = %backup.display(),
                "Failed to create startup database backup: {}",
                err
            ),
        }
    }
}

fn next_backup_path(source: &std::path::Path, timestamp: &str) -> std::path::PathBuf {
    let base_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("database.db");
    let parent = source
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    let primary = parent.join(format!("{}.bak.{}", base_name, timestamp));
    if !primary.exists() {
        return primary;
    }

    for idx in 1..1000 {
        let candidate = parent.join(format!("{}.bak.{}.{}", base_name, timestamp, idx));
        if !candidate.exists() {
            return candidate;
        }
    }

    parent.join(format!("{}.bak.{}.overflow", base_name, timestamp))
}
