use std::sync::Arc;

use crate::actor::ActorManager;
use crate::agent::skill_registry::SkillRegistry;
use crate::application::episodic_memory::EpisodicMemoryUseCase;
use crate::application::knowledge::KnowledgeUseCase;
use crate::core::config::{AppPaths, ConfigService};
use crate::core::security::init_session_token;
use crate::core::security_controls::SecurityControls;
use crate::domain::episodic_memory::EpisodicMemoryPort;
use crate::domain::knowledge::KnowledgePort;
use crate::graph::build_tepora_graph;
use crate::history::HistoryStore;
use crate::infrastructure::episodic_store::{MemoryAdapter, UnifiedMemoryAdapter};
use crate::llm::{LlamaService, LlmService};
use crate::mcp::registry::McpRegistry;
use crate::mcp::McpManager;
use crate::memory::MemoryService;
use crate::models::ModelManager;
use crate::server::middleware::rate_limit::RateLimiters;
use crate::workspace::{ProjectHistoryStore, ProjectKnowledgePort, WorkspaceManager};

use super::error::InitializationError;
use super::{
    AppAiState, AppCoreState, AppIntegrationState, AppMemoryState, AppRuntimeState, AppState,
    AppWorkspaceState, SetupState,
};

const DEFAULT_STARTUP_AUTO_BACKUP_LIMIT: usize = 10;

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
        let startup_config = config.load_config().unwrap_or_default();
        let security = Arc::new(SecurityControls::new(paths.clone(), config.clone()));
        let session_token = Arc::new(tokio::sync::RwLock::new(init_session_token()));
        let workspace_manager = Arc::new(
            WorkspaceManager::new(paths.clone())
                .map_err(|e| InitializationError::Workspace(anyhow::anyhow!(e.to_string())))?,
        );
        backup_sqlite_databases(paths.as_ref(), &startup_config);

        let base_history = HistoryStore::new(paths.db_path.clone())
            .await
            .map_err(|e| InitializationError::History(e.into()))?;
        let history = ProjectHistoryStore::new(
            base_history,
            workspace_manager.current_project_id.clone(),
        );

        let llama = LlamaService::new_with_config(paths.clone(), config.clone())
            .map_err(|e| InitializationError::Llm(e.into()))?;

        let mcp = McpManager::new(paths.clone(), config.clone());
        let mcp_registry = McpRegistry::new(&paths);
        let models = ModelManager::new(&paths, config.clone());
        let setup = SetupState::new(&paths);
        let skill_registry =
            SkillRegistry::new(paths.as_ref(), config.clone(), workspace_manager.current_project_id.clone());

        let is_declarative = startup_config
            .get("features")
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

        let memory_service = Arc::new(
            MemoryService::new(paths.as_ref(), &config)
                .await
                .map_err(|e| InitializationError::EmMemory(e.into()))?,
        );

        let llm = LlmService::new(models.clone(), llama.clone(), config.clone());
        let knowledge = Arc::new(ProjectKnowledgePort::new(
            paths.clone(),
            workspace_manager.current_project_id.clone(),
            history.clone(),
            llama.clone(),
            config.clone(),
        )) as Arc<dyn KnowledgePort>;

        let rate_limiters = Arc::new(RateLimiters::new());
        let actor_manager = Arc::new(ActorManager::new());
        let unified_memory_adapter = Arc::new(UnifiedMemoryAdapter::new_with_runtime(
            memory_service.clone(),
            memory_service.v2_store.clone(),
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
            skill_registry: skill_registry.clone(),
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
            memory_service: memory_service.clone(),
            memory_adapter: memory_adapter.clone(),
            episodic_memory: episodic_memory.clone(),
            knowledge: knowledge.clone(),
            episodic_memory_use_case: episodic_memory_use_case.clone(),
            knowledge_use_case: knowledge_use_case.clone(),
        });
        let workspace = Arc::new(AppWorkspaceState {
            manager: workspace_manager.clone(),
        });

        let app_state = Arc::new(AppState::from_groups(
            core,
            ai,
            integration,
            runtime,
            memory,
            workspace,
        ));
        app_state.runtime().actor_manager.clone().start_gc();

        app_state
            .memory()
            .memory_service
            .clone()
            .spawn_background_worker();

        let models_clone = app_state.ai().models.clone();
        tokio::spawn(async move {
            if let Err(e) = models_clone.refresh_all_loader_models().await {
                tracing::warn!("Failed to refresh loader models on startup: {}", e);
            }
        });

        Ok(app_state)
    }
}

fn backup_sqlite_databases(paths: &AppPaths, config: &serde_json::Value) {
    let backup_limit = startup_auto_backup_limit(config);
    let timestamp = chrono::Utc::now().format("%Y%m%d%H%M%S").to_string();
    let candidates = [
        paths.db_path.clone(),
        paths.user_data_dir.join("em_memory.db"),
        paths.user_data_dir.join("episodic_memory.db"),
        paths.user_data_dir.join("rag.db"),
    ];

    for source in candidates {
        if !source.exists() {
            continue;
        }

        let backup = next_backup_path(&source, &timestamp);
        match std::fs::copy(&source, &backup) {
            Ok(_) => {
                tracing::info!(
                    source = %source.display(),
                    backup = %backup.display(),
                    limit = backup_limit,
                    "Created startup database backup"
                );

                prune_startup_backups(&source, backup_limit);
            }
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

fn startup_auto_backup_limit(config: &serde_json::Value) -> usize {
    config
        .get("backup")
        .and_then(|backup| backup.get("startup_auto_backup_limit"))
        .and_then(|value| value.as_u64())
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_STARTUP_AUTO_BACKUP_LIMIT)
}

fn prune_startup_backups(source: &std::path::Path, limit: usize) {
    if limit == 0 {
        return;
    }

    let mut backups = list_startup_backups(source);
    if backups.len() <= limit {
        return;
    }

    backups.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    for stale_backup in backups.into_iter().skip(limit) {
        match std::fs::remove_file(&stale_backup) {
            Ok(_) => tracing::info!(
                source = %source.display(),
                backup = %stale_backup.display(),
                limit,
                "Removed old startup database backup"
            ),
            Err(err) => tracing::warn!(
                source = %source.display(),
                backup = %stale_backup.display(),
                limit,
                "Failed to remove old startup database backup: {}",
                err
            ),
        }
    }
}

fn list_startup_backups(source: &std::path::Path) -> Vec<std::path::PathBuf> {
    let Some(base_name) = source.file_name().and_then(|name| name.to_str()) else {
        return Vec::new();
    };
    let Some(parent) = source.parent() else {
        return Vec::new();
    };
    let backup_prefix = format!("{}.bak.", base_name);

    std::fs::read_dir(parent)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with(&backup_prefix))
                .unwrap_or(false)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        list_startup_backups, prune_startup_backups, startup_auto_backup_limit,
        DEFAULT_STARTUP_AUTO_BACKUP_LIMIT,
    };
    use serde_json::json;

    #[test]
    fn startup_backup_limit_uses_default_when_unset() {
        assert_eq!(
            startup_auto_backup_limit(&json!({})),
            DEFAULT_STARTUP_AUTO_BACKUP_LIMIT
        );
    }

    #[test]
    fn startup_backup_limit_reads_configured_value() {
        assert_eq!(
            startup_auto_backup_limit(&json!({
                "backup": {
                    "startup_auto_backup_limit": 7
                }
            })),
            7
        );
    }

    #[test]
    fn prune_startup_backups_keeps_only_newest_files_for_database() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let source = temp_dir.path().join("tepora.db");
        std::fs::write(&source, b"db").expect("write source db");

        let stale = temp_dir.path().join("tepora.db.bak.20260101000000");
        let newest = temp_dir.path().join("tepora.db.bak.20260102000000");
        let latest = temp_dir.path().join("tepora.db.bak.20260103000000");
        let other_db_backup = temp_dir.path().join("rag.db.bak.20260101000000");

        std::fs::write(&stale, b"old").expect("write stale backup");
        std::fs::write(&newest, b"newer").expect("write newer backup");
        std::fs::write(&latest, b"latest").expect("write latest backup");
        std::fs::write(&other_db_backup, b"other").expect("write unrelated backup");

        prune_startup_backups(&source, 2);

        let remaining = list_startup_backups(&source);
        assert_eq!(remaining.len(), 2);
        assert!(!stale.exists());
        assert!(newest.exists());
        assert!(latest.exists());
        assert!(other_db_backup.exists());
    }
}
