use std::sync::Arc;

use axum::extract::FromRef;

use crate::actor::ActorManager;
use crate::agent::skill_registry::SkillRegistry;
use crate::application::episodic_memory::EpisodicMemoryUseCase;
use crate::application::knowledge::KnowledgeUseCase;
use crate::core::config::{AppPaths, ConfigService};
use crate::core::security::SessionToken;
use crate::core::security_controls::SecurityControls;
use crate::domain::episodic_memory::EpisodicMemoryPort;
use crate::domain::knowledge::KnowledgePort;
use crate::graph::GraphRuntime;
use crate::history::HistoryStore;
use crate::infrastructure::episodic_store::MemoryAdapter;
use crate::llm::{LlamaService, LlmService};
use crate::mcp::registry::McpRegistry;
use crate::mcp::McpManager;
use crate::memory::MemoryService;
use crate::models::ModelManager;
use crate::server::middleware::rate_limit::RateLimiters;

mod bootstrap;
pub mod error;
pub mod setup;

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

    pub fn core(&self) -> &AppCoreState {
        self.0.core()
    }

    pub fn ai(&self) -> &AppAiState {
        self.0.ai()
    }

    pub fn integration(&self) -> &AppIntegrationState {
        self.0.integration()
    }

    pub fn runtime(&self) -> &AppRuntimeState {
        self.0.runtime()
    }

    pub fn memory(&self) -> &AppMemoryState {
        self.0.memory()
    }

    pub fn is_redesign_enabled(&self, feature: &str) -> bool {
        self.0.is_redesign_enabled(feature)
    }
}

impl AppStateWrite {
    pub fn shared(&self) -> Arc<AppState> {
        self.0.clone()
    }

    pub fn into_read(self) -> AppStateRead {
        AppStateRead(self.0)
    }

    #[allow(dead_code)]
    pub fn core(&self) -> &AppCoreState {
        self.0.core()
    }

    #[allow(dead_code)]
    pub fn ai(&self) -> &AppAiState {
        self.0.ai()
    }

    #[allow(dead_code)]
    pub fn integration(&self) -> &AppIntegrationState {
        self.0.integration()
    }

    #[allow(dead_code)]
    pub fn runtime(&self) -> &AppRuntimeState {
        self.0.runtime()
    }

    #[allow(dead_code)]
    pub fn memory(&self) -> &AppMemoryState {
        self.0.memory()
    }
}

impl From<AppStateWrite> for AppStateRead {
    fn from(value: AppStateWrite) -> Self {
        value.into_read()
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
    pub skill_registry: SkillRegistry,
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
    pub memory_service: Arc<MemoryService>,
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
}

impl AppState {
    pub fn core(&self) -> &AppCoreState {
        self.core.as_ref()
    }

    pub fn ai(&self) -> &AppAiState {
        self.ai.as_ref()
    }

    pub fn integration(&self) -> &AppIntegrationState {
        self.integration.as_ref()
    }

    pub fn runtime(&self) -> &AppRuntimeState {
        self.runtime.as_ref()
    }

    pub fn memory(&self) -> &AppMemoryState {
        self.memory.as_ref()
    }

    pub(crate) fn from_groups(
        core: Arc<AppCoreState>,
        ai: Arc<AppAiState>,
        integration: Arc<AppIntegrationState>,
        runtime: Arc<AppRuntimeState>,
        memory: Arc<AppMemoryState>,
    ) -> Self {
        Self {
            core,
            ai,
            integration,
            runtime,
            memory,
        }
    }

    /// Check if a specific redesign feature is enabled via feature flags.
    pub fn is_redesign_enabled(&self, feature: &str) -> bool {
        self.core()
            .config
            .load_config()
            .ok()
            .and_then(|c| c.get("features").cloned())
            .and_then(|f| f.get("redesign").cloned())
            .and_then(|r| r.get(feature).cloned())
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }
}
