//! MemoryWorker — Retrieves conversation history and long-term memory.

use std::sync::Arc;

use async_trait::async_trait;

use crate::context::pipeline_context::{MemoryChunk, PipelineContext};
use crate::context::worker::{ContextWorker, WorkerError};
use crate::llm::ChatMessage;
use crate::state::AppState;

pub struct MemoryWorker {
    history_limit: i64,
}

impl MemoryWorker {
    pub fn new(history_limit: i64) -> Self {
        Self { history_limit }
    }
}

impl Default for MemoryWorker {
    fn default() -> Self {
        Self::new(50)
    }
}

#[async_trait]
impl ContextWorker for MemoryWorker {
    fn name(&self) -> &str {
        "memory"
    }

    async fn execute(
        &self,
        ctx: &mut PipelineContext,
        state: &Arc<AppState>,
    ) -> Result<(), WorkerError> {
        let history_messages = state
            .history
            .get_history(&ctx.session_id, self.history_limit)
            .await
            .map_err(|e| {
                WorkerError::retryable("memory", format!("Failed to load history: {e}"))
            })?;

        let mut chat_messages = Vec::new();
        for msg in history_messages {
            let role = match msg.message_type.as_str() {
                "ai" => "assistant",
                "system" => "system",
                "tool" => "assistant",
                _ => "user",
            };
            if msg.content.trim().is_empty() {
                continue;
            }
            chat_messages.push(ChatMessage {
                role: role.to_string(),
                content: msg.content,
            });
        }

        ctx.messages = chat_messages;

        if state.em_memory_service.enabled() && !ctx.user_input.trim().is_empty() {
            let embedding_model_id = state
                .models
                .get_registry()
                .ok()
                .and_then(|registry| {
                    registry
                        .role_assignments
                        .get("embedding")
                        .cloned()
                        .or_else(|| {
                            registry
                                .models
                                .iter()
                                .find(|model| model.role == "embedding")
                                .map(|model| model.id.clone())
                        })
                        .or_else(|| registry.models.first().map(|model| model.id.clone()))
                })
                .unwrap_or_else(|| "default".to_string());

            let legacy_enabled = state.is_redesign_enabled("legacy_memory");

            match state
                .memory_adapter
                .retrieve_context(
                    &ctx.session_id,
                    &ctx.user_input,
                    &state.llm,
                    &embedding_model_id,
                    legacy_enabled,
                )
                .await
            {
                Ok(memories) => {
                    ctx.memory_chunks = memories
                        .into_iter()
                        .map(|memory| MemoryChunk {
                            content: memory.content,
                            relevance_score: memory.relevance_score,
                            source: memory.source,
                        })
                        .collect();
                }
                Err(err) => {
                    tracing::warn!("MemoryWorker: failed to retrieve EM memory: {}", err);
                }
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::errors::ApiError;
    use crate::em_llm::RetrievedMemory;
    use crate::memory_v2::adapter::MemoryAdapter;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct MockAdapter {
        called: AtomicBool,
        last_legacy_flag: AtomicBool,
    }

    #[async_trait::async_trait]
    impl MemoryAdapter for MockAdapter {
        async fn ingest_interaction(
            &self,
            _session_id: &str,
            _user_input: &str,
            _assistant_output: &str,
            _llm: &crate::llm::LlmService,
            _text_model_id: &str,
            _embedding_model_id: &str,
            _legacy_enabled: bool,
        ) -> Result<(), ApiError> {
            Ok(())
        }

        async fn retrieve_context(
            &self,
            _session_id: &str,
            _query: &str,
            _llm: &crate::llm::LlmService,
            _embedding_model_id: &str,
            legacy_enabled: bool,
        ) -> Result<Vec<RetrievedMemory>, ApiError> {
            self.called.store(true, Ordering::SeqCst);
            self.last_legacy_flag.store(legacy_enabled, Ordering::SeqCst);
            Ok(vec![])
        }
    }

    #[tokio::test]
    async fn test_memory_worker_adapter_routing() {
        // AppState::initialize() can fail due to DB lock issues or other OS errors on Windows. 
        // We will construct a minimal mock AppState for this test manually to ensure deterministic behavior.
        
        let paths = Arc::new(crate::core::config::AppPaths::new());
        let temp_dir = tempfile::tempdir().unwrap();
        let mut new_paths = (*paths).clone();
        new_paths.user_data_dir = temp_dir.path().to_path_buf();
        let new_paths_arc = Arc::new(new_paths);
        let config = crate::core::config::service::ConfigService::new(new_paths_arc.clone());

        // Dummy components
        let session_token = Arc::new(tokio::sync::RwLock::new(crate::core::security::init_session_token()));
        let history = crate::history::HistoryStore::new(temp_dir.path().join("mock_history.db")).await.unwrap();
        let llama = crate::llm::LlamaService::new(new_paths_arc.clone()).unwrap();
        let mcp = crate::mcp::McpManager::new(new_paths_arc.clone(), config.clone());
        let mcp_registry = crate::mcp::registry::McpRegistry::new(&new_paths_arc);
        let models = crate::models::ModelManager::new(&new_paths_arc, config.clone());
        let setup = crate::state::setup::SetupState::new(&new_paths_arc);
        let exclusive_agents = crate::agent::exclusive_manager::ExclusiveAgentManager::new(new_paths_arc.as_ref(), config.clone());
        let rag_store = Arc::new(crate::rag::SqliteRagStore::new(new_paths_arc.as_ref()).await.unwrap());
        let graph_runtime = Arc::new(crate::graph::GraphBuilder::new().build().unwrap());
        let em_memory_service = Arc::new(crate::em_llm::EmMemoryService::new(new_paths_arc.as_ref(), &config).await.unwrap());
        let llm = crate::llm::LlmService::new(models.clone(), llama.clone(), config.clone());
        let rate_limiters = Arc::new(crate::server::middleware::rate_limit::RateLimiters::new());
        let actor_manager = Arc::new(crate::actor::ActorManager::new());

        let adapter = Arc::new(MockAdapter {
            called: AtomicBool::new(false),
            last_legacy_flag: AtomicBool::new(false),
        });

        let base_state = Arc::new(AppState {
            paths: new_paths_arc,
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
            rate_limiters,
            actor_manager,
            memory_adapter: adapter.clone() as Arc<dyn MemoryAdapter>,
        });

        let mut ctx = PipelineContext::new("test_session", "test_turn", crate::context::pipeline_context::PipelineMode::Chat, "Hello query");

        // Test with legacy_memory = true
        {
            let mut state_clone = (*base_state).clone();
            
            // Force config adjustments in temp file
            let mut config_val = state_clone.config.load_config().unwrap_or_else(|_| serde_json::json!({}));
            
            let features = config_val.as_object_mut().unwrap().entry("features").or_insert_with(|| serde_json::json!({}));
            let redesign = features.as_object_mut().unwrap().entry("redesign").or_insert_with(|| serde_json::json!({}));
            redesign.as_object_mut().unwrap().insert("legacy_memory".to_string(), serde_json::Value::Bool(true));
            
            let app = config_val.as_object_mut().unwrap().entry("app").or_insert_with(|| serde_json::json!({}));
            app.as_object_mut().unwrap().insert("em_memory_enabled".to_string(), serde_json::Value::Bool(true));
            
            state_clone.config.update_config(config_val.clone(), false).unwrap();

            let state_arc = Arc::new(state_clone);
            let worker = MemoryWorker::new(10);
            
            worker.execute(&mut ctx, &state_arc).await.unwrap();
            
            assert!(adapter.called.load(Ordering::SeqCst), "Adapter should be called");
            assert!(adapter.last_legacy_flag.load(Ordering::SeqCst), "Legacy flag should be true");
        }

        // Test with legacy_memory = false
        {
            adapter.called.store(false, Ordering::SeqCst);
            let mut state_clone = (*base_state).clone();

            let mut config_val = state_clone.config.load_config().unwrap_or_else(|_| serde_json::json!({}));
            
            let features = config_val.as_object_mut().unwrap().entry("features").or_insert_with(|| serde_json::json!({}));
            let redesign = features.as_object_mut().unwrap().entry("redesign").or_insert_with(|| serde_json::json!({}));
            redesign.as_object_mut().unwrap().insert("legacy_memory".to_string(), serde_json::Value::Bool(false));
            
            let app = config_val.as_object_mut().unwrap().entry("app").or_insert_with(|| serde_json::json!({}));
            app.as_object_mut().unwrap().insert("em_memory_enabled".to_string(), serde_json::Value::Bool(true));
            
            state_clone.config.update_config(config_val.clone(), false).unwrap();

            let state_arc = Arc::new(state_clone);
            let worker = MemoryWorker::new(10);
            
            worker.execute(&mut ctx, &state_arc).await.unwrap();
            
            assert!(adapter.called.load(Ordering::SeqCst), "Adapter should be called");
            assert!(!adapter.last_legacy_flag.load(Ordering::SeqCst), "Legacy flag should be false");
        }
    }
}
