//! MemoryWorker - Retrieves the interaction tail and episodic memory.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::context::pipeline_context::{
    InteractionTail, LocalContext, MemoryChunk, PipelineContext,
};
use crate::context::worker::{ContextWorker, WorkerError};
use crate::history::HistoryMessage;
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
        Self::new(6)
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
            .get_history(&ctx.session_id, self.history_limit.max(2))
            .await
            .map_err(|e| {
                WorkerError::retryable("memory", format!("Failed to load history: {e}"))
            })?;

        ctx.interaction_tail = extract_interaction_tail(&history_messages);

        if state.em_memory_service.enabled() && !ctx.user_input.trim().is_empty() {
            if let Some(embedding_model_id) = resolve_embedding_model_id(state) {
                let legacy_enabled = state.is_redesign_enabled("legacy_memory");

                match state
                    .memory_adapter
                    .retrieve_context(
                        &ctx.session_id,
                        &ctx.user_input,
                        &state.llm,
                        &embedding_model_id,
                        legacy_enabled,
                        ctx.mode,
                        ctx.stage,
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
                                strength: memory.strength,
                                memory_layer: memory.memory_layer,
                                scope: memory.scope,
                                session_id: memory.session_id,
                                character_id: memory.character_id,
                            })
                            .collect();
                    }
                    Err(err) => {
                        tracing::warn!("MemoryWorker: failed to retrieve EM memory: {}", err);
                    }
                }
            }
        }

        ctx.local_context = build_local_context(
            &ctx.user_input,
            &ctx.working_memory,
            ctx.interaction_tail.as_ref(),
            &ctx.memory_chunks,
        );

        Ok(())
    }
}

fn resolve_embedding_model_id(state: &Arc<AppState>) -> Option<String> {
    let registry = match state.models.get_registry() {
        Ok(registry) => registry,
        Err(err) => {
            tracing::warn!(
                "MemoryWorker: failed to load model registry for embedding lookup: {}",
                err
            );
            return None;
        }
    };

    if let Some(model_id) = registry.role_assignments.get("embedding").cloned() {
        return Some(model_id);
    }

    if let Some(model_id) = registry
        .models
        .iter()
        .find(|model| model.role == "embedding")
        .map(|model| model.id.clone())
    {
        return Some(model_id);
    }

    tracing::warn!("MemoryWorker: no embedding model is configured; skipping episodic retrieval");
    None
}

fn extract_interaction_tail(history_messages: &[HistoryMessage]) -> Option<InteractionTail> {
    let normalized = history_messages
        .iter()
        .filter_map(normalize_history_message)
        .collect::<Vec<_>>();

    if normalized.is_empty() {
        return None;
    }

    let assistant_index = normalized.iter().rposition(|msg| msg.role == "assistant");
    let messages = if let Some(assistant_index) = assistant_index {
        let start = normalized[..assistant_index]
            .iter()
            .rposition(|msg| msg.role == "user")
            .unwrap_or(assistant_index);
        normalized[start..=assistant_index].to_vec()
    } else {
        normalized
            .iter()
            .rev()
            .find(|msg| msg.role == "user")
            .cloned()
            .into_iter()
            .collect()
    };

    if messages.is_empty() {
        None
    } else {
        Some(InteractionTail { messages })
    }
}

fn normalize_history_message(message: &HistoryMessage) -> Option<ChatMessage> {
    let role = match message.message_type.as_str() {
        "ai" | "assistant" | "tool" => "assistant",
        "system" => "system",
        "human" | "user" => "user",
        _ => "user",
    };

    let content = message.content.trim();
    if content.is_empty() {
        return None;
    }

    Some(ChatMessage {
        role: role.to_string(),
        content: content.to_string(),
    })
}

fn build_local_context(
    user_input: &str,
    working_memory: &HashMap<String, Value>,
    interaction_tail: Option<&InteractionTail>,
    memory_chunks: &[MemoryChunk],
) -> LocalContext {
    let mut local_context = LocalContext::default();

    local_context.goal = working_memory
        .get("goal")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| summarize_goal(user_input, interaction_tail));

    local_context.current_topic = working_memory
        .get("current_topic")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| derive_current_topic(user_input, interaction_tail));

    local_context.constraints = normalize_list(read_string_list(working_memory.get("constraints")));
    local_context.resolved_points =
        normalize_list(read_string_list(working_memory.get("resolved_points")));
    local_context.open_questions =
        normalize_list(read_string_list(working_memory.get("open_questions")));
    local_context.session_entities =
        normalize_list(read_string_list(working_memory.get("session_entities")));

    for constraint in extract_constraints(user_input) {
        push_unique(&mut local_context.constraints, constraint);
    }

    if let Some(tail) = interaction_tail {
        for message in &tail.messages {
            for entity in extract_entities(&message.content) {
                push_unique(&mut local_context.session_entities, entity);
            }

            match message.role.as_str() {
                "assistant" => {
                    if let Some(summary) = summarize_line(&message.content, 96) {
                        push_unique(&mut local_context.resolved_points, summary);
                    }
                }
                "user" => {
                    for question in extract_questions(&message.content) {
                        push_unique(&mut local_context.open_questions, question);
                    }
                }
                _ => {}
            }
        }
    }

    for entity in extract_entities(user_input) {
        push_unique(&mut local_context.session_entities, entity);
    }
    for question in extract_questions(user_input) {
        push_unique(&mut local_context.open_questions, question);
    }

    for memory in memory_chunks.iter().take(4) {
        if let Some(summary) = summarize_line(&memory.content, 96) {
            push_unique(&mut local_context.resolved_points, summary);
        }
        for entity in extract_entities(&memory.content) {
            push_unique(&mut local_context.session_entities, entity);
        }
    }

    local_context.constraints = normalize_list(local_context.constraints);
    local_context.resolved_points = normalize_list(local_context.resolved_points);
    local_context.open_questions = normalize_list(
        local_context
            .open_questions
            .into_iter()
            .filter(|item| !local_context.resolved_points.contains(item))
            .collect(),
    );
    local_context.session_entities = normalize_list(local_context.session_entities);

    local_context
}

fn read_string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn extract_entities(input: &str) -> Vec<String> {
    const ASCII_STOPWORDS: &[&str] = &[
        "the", "and", "this", "that", "with", "from", "into", "your", "you", "for", "are", "was",
        "were", "have", "has", "had", "not", "but", "about", "what", "when", "where", "will",
        "would", "could", "should", "there", "their", "them", "they", "then",
    ];

    let mut entities = Vec::new();
    for candidate in tokenize_entity_candidates(input) {
        if contains_japanese_script(&candidate) {
            for fragment in split_japanese_candidate(&candidate) {
                let len = fragment.chars().count();
                if (2..=12).contains(&len) {
                    push_unique(&mut entities, fragment);
                }
                if entities.len() >= 6 {
                    return entities;
                }
            }
            continue;
        }

        let lowered = candidate.to_ascii_lowercase();
        let len = candidate.chars().count();
        if len >= 3
            && !ASCII_STOPWORDS.contains(&lowered.as_str())
            && candidate.chars().any(|ch| ch.is_alphanumeric())
        {
            push_unique(&mut entities, candidate);
        }

        if entities.len() >= 6 {
            break;
        }
    }

    entities
}

fn tokenize_entity_candidates(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();

    for ch in input.chars() {
        if is_entity_char(ch) {
            current.push(ch);
        } else if !current.trim().is_empty() {
            tokens.push(current.trim().to_string());
            current.clear();
        } else {
            current.clear();
        }
    }

    if !current.trim().is_empty() {
        tokens.push(current.trim().to_string());
    }

    tokens
}

fn split_japanese_candidate(candidate: &str) -> Vec<String> {
    const PARTICLES: &[char] = &[
        'は', 'が', 'を', 'に', 'で', 'と', 'の', 'も', 'へ', 'や', 'か',
    ];
    let char_count = candidate.chars().count();
    if char_count <= 12 {
        return vec![candidate.to_string()];
    }

    candidate
        .split(|ch| PARTICLES.contains(&ch))
        .map(str::trim)
        .filter(|fragment| {
            let len = fragment.chars().count();
            (2..=12).contains(&len)
        })
        .map(ToString::to_string)
        .take(4)
        .collect()
}

fn is_entity_char(ch: char) -> bool {
    ch.is_alphanumeric() || matches!(ch, '_' | '-') || contains_japanese_script_char(ch)
}

fn contains_japanese_script(input: &str) -> bool {
    input.chars().any(contains_japanese_script_char)
}

fn contains_japanese_script_char(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3040..=0x309F | 0x30A0..=0x30FF | 0x31F0..=0x31FF | 0x4E00..=0x9FFF | 0xFF66..=0xFF9D
    )
}

fn extract_constraints(input: &str) -> Vec<String> {
    input
        .split(['\n', '.'])
        .map(str::trim)
        .filter(|line| {
            let lowered = line.to_lowercase();
            lowered.contains("must")
                || lowered.contains("should")
                || lowered.contains("without")
                || lowered.contains("need to")
                || lowered.contains("avoid")
        })
        .filter_map(|line| summarize_line(line, 96))
        .take(4)
        .collect()
}

fn extract_questions(input: &str) -> Vec<String> {
    input
        .split('\n')
        .map(str::trim)
        .filter(|line| line.ends_with('?'))
        .filter_map(|line| summarize_line(line, 96))
        .take(4)
        .collect()
}

fn summarize_goal(user_input: &str, interaction_tail: Option<&InteractionTail>) -> Option<String> {
    if let Some(summary) = summarize_line(user_input, 120) {
        return Some(summary);
    }

    interaction_tail
        .and_then(|tail| {
            tail.messages
                .iter()
                .rev()
                .find(|message| message.role == "user")
        })
        .and_then(|message| summarize_line(&message.content, 120))
}

fn derive_current_topic(
    user_input: &str,
    interaction_tail: Option<&InteractionTail>,
) -> Option<String> {
    if let Some(summary) = summarize_line(user_input, 80) {
        return Some(summary);
    }

    interaction_tail
        .and_then(|tail| tail.messages.last())
        .and_then(|message| summarize_line(&message.content, 80))
}

fn summarize_line(input: &str, max_chars: usize) -> Option<String> {
    let normalized = input.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.trim().is_empty() {
        return None;
    }
    if normalized.chars().count() <= max_chars {
        return Some(normalized);
    }
    let shortened: String = normalized
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect();
    Some(format!("{}...", shortened.trim_end()))
}

fn normalize_list(items: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for item in items {
        let value = item.split_whitespace().collect::<Vec<_>>().join(" ");
        let value = value.trim().to_string();
        if value.is_empty() {
            continue;
        }
        if !normalized
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(&value))
        {
            normalized.push(value);
        }
    }
    normalized
}

fn push_unique(target: &mut Vec<String>, value: String) {
    if value.trim().is_empty() {
        return;
    }
    if !target
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(value.trim()))
    {
        target.push(value.trim().to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::episodic_memory::EpisodicMemoryUseCase;
    use crate::application::knowledge::KnowledgeUseCase;
    use crate::context::pipeline_context::{PipelineMode, PipelineStage};
    use crate::core::errors::ApiError;
    use crate::domain::episodic_memory::{
        CompressionResult, DecayResult, EpisodicHit, EpisodicMemoryPort,
    };
    use crate::domain::knowledge::{
        ContextConfig, KnowledgeChunk, KnowledgeHit, KnowledgePort, KnowledgeSource,
    };
    use crate::em_llm::RetrievedMemory;
    use crate::infrastructure::episodic_store::{MemoryAdapter, MemoryScope};
    use crate::models::types::{ModelEntry, ModelRegistry};
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn extract_entities_filters_ascii_stopwords_and_keeps_japanese_phrases() {
        let entities =
            extract_entities("the project uses 検索モード と MemoryWorker for task continuity");

        assert!(entities.iter().any(|entity| entity == "検索モード"));
        assert!(entities.iter().any(|entity| entity == "MemoryWorker"));
        assert!(!entities
            .iter()
            .any(|entity| entity.eq_ignore_ascii_case("the")));
    }

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
            _mode: PipelineMode,
            _stage: PipelineStage,
        ) -> Result<Vec<RetrievedMemory>, ApiError> {
            self.called.store(true, Ordering::SeqCst);
            self.last_legacy_flag
                .store(legacy_enabled, Ordering::SeqCst);
            Ok(vec![])
        }

        async fn ingest_summary(
            &self,
            _session_id: &str,
            _summary: &str,
            _llm: &crate::llm::LlmService,
            _embedding_model_id: &str,
            _scope: MemoryScope,
        ) -> Result<(), ApiError> {
            Ok(())
        }
    }

    #[async_trait::async_trait]
    impl EpisodicMemoryPort for MockAdapter {
        async fn ingest_interaction(
            &self,
            _session_id: &str,
            _user: &str,
            _assistant: &str,
            _embedding: &[f32],
        ) -> Result<Vec<String>, crate::domain::errors::DomainError> {
            Ok(Vec::new())
        }

        async fn recall(
            &self,
            _session_id: &str,
            _query_embedding: &[f32],
            _limit: usize,
        ) -> Result<Vec<EpisodicHit>, crate::domain::errors::DomainError> {
            Ok(Vec::new())
        }

        async fn run_decay(
            &self,
            _session_id: Option<&str>,
        ) -> Result<DecayResult, crate::domain::errors::DomainError> {
            Ok(DecayResult::default())
        }

        async fn compress(
            &self,
            _session_id: &str,
        ) -> Result<CompressionResult, crate::domain::errors::DomainError> {
            Ok(CompressionResult::default())
        }
    }

    #[async_trait::async_trait]
    impl KnowledgePort for MockAdapter {
        async fn ingest(
            &self,
            _source: KnowledgeSource,
            _session_id: &str,
        ) -> Result<Vec<String>, crate::domain::errors::DomainError> {
            Ok(Vec::new())
        }

        async fn search(
            &self,
            _query_embedding: &[f32],
            _limit: usize,
            _session_id: Option<&str>,
        ) -> Result<Vec<KnowledgeHit>, crate::domain::errors::DomainError> {
            Ok(Vec::new())
        }

        async fn text_search(
            &self,
            _pattern: &str,
            _limit: usize,
            _session_id: Option<&str>,
        ) -> Result<Vec<KnowledgeChunk>, crate::domain::errors::DomainError> {
            Ok(Vec::new())
        }

        async fn get_chunk(
            &self,
            _chunk_id: &str,
        ) -> Result<Option<KnowledgeChunk>, crate::domain::errors::DomainError> {
            Ok(None)
        }

        async fn get_chunk_window(
            &self,
            _chunk_id: &str,
            _max_chars: usize,
            _session_id: Option<&str>,
        ) -> Result<Vec<KnowledgeChunk>, crate::domain::errors::DomainError> {
            Ok(Vec::new())
        }

        async fn build_context(
            &self,
            _query: &str,
            _query_embedding: &[f32],
            _config: &ContextConfig,
        ) -> Result<String, crate::domain::errors::DomainError> {
            Ok(String::new())
        }

        async fn clear_session(
            &self,
            _session_id: &str,
        ) -> Result<usize, crate::domain::errors::DomainError> {
            Ok(0)
        }

        async fn reindex(
            &self,
            _embedding_model: &str,
        ) -> Result<(), crate::domain::errors::DomainError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn test_memory_worker_adapter_routing() {
        let paths = Arc::new(crate::core::config::AppPaths::new());
        let temp_dir = tempfile::tempdir().unwrap();
        let mut new_paths = (*paths).clone();
        new_paths.user_data_dir = temp_dir.path().to_path_buf();
        let new_paths_arc = Arc::new(new_paths);
        let config = crate::core::config::service::ConfigService::new(new_paths_arc.clone());

        let session_token = Arc::new(tokio::sync::RwLock::new(
            crate::core::security::init_session_token(),
        ));
        let history = crate::history::HistoryStore::new(temp_dir.path().join("mock_history.db"))
            .await
            .unwrap();
        let llama = crate::llm::LlamaService::new(new_paths_arc.clone()).unwrap();
        let mcp = crate::mcp::McpManager::new(new_paths_arc.clone(), config.clone());
        let mcp_registry = crate::mcp::registry::McpRegistry::new(&new_paths_arc);
        let models = crate::models::ModelManager::new(&new_paths_arc, config.clone());
        let setup = crate::state::setup::SetupState::new(&new_paths_arc);
        let skill_registry = crate::agent::skill_registry::SkillRegistry::new(
            new_paths_arc.as_ref(),
            config.clone(),
        );
        let graph_runtime = Arc::new(crate::graph::GraphBuilder::new().build().unwrap());
        let em_memory_service = Arc::new(
            crate::em_llm::EmMemoryService::new(new_paths_arc.as_ref(), &config)
                .await
                .unwrap(),
        );
        let llm = crate::llm::LlmService::new(models.clone(), llama.clone(), config.clone());
        let rate_limiters = Arc::new(crate::server::middleware::rate_limit::RateLimiters::new());
        let actor_manager = Arc::new(crate::actor::ActorManager::new());

        let adapter = Arc::new(MockAdapter {
            called: AtomicBool::new(false),
            last_legacy_flag: AtomicBool::new(false),
        });

        let core = Arc::new(crate::state::AppCoreState {
            paths: new_paths_arc.clone(),
            config: config.clone(),
            session_token,
            setup: setup.clone(),
            security: Arc::new(crate::core::security_controls::SecurityControls::new(
                new_paths_arc.clone(),
                config.clone(),
            )),
        });
        let ai = Arc::new(crate::state::AppAiState {
            llama: llama.clone(),
            llm: llm.clone(),
            models: models.clone(),
            skill_registry: skill_registry.clone(),
        });
        let integration = Arc::new(crate::state::AppIntegrationState {
            mcp: mcp.clone(),
            mcp_registry: mcp_registry.clone(),
        });
        let runtime = Arc::new(crate::state::AppRuntimeState {
            history: history.clone(),
            graph_runtime: graph_runtime.clone(),
            rate_limiters: rate_limiters.clone(),
            actor_manager: actor_manager.clone(),
        });
        let memory = Arc::new(crate::state::AppMemoryState {
            em_memory_service: em_memory_service.clone(),
            memory_adapter: adapter.clone() as Arc<dyn MemoryAdapter>,
            episodic_memory: adapter.clone() as Arc<dyn EpisodicMemoryPort>,
            knowledge: adapter.clone() as Arc<dyn KnowledgePort>,
            episodic_memory_use_case: Arc::new(EpisodicMemoryUseCase::new(
                adapter.clone() as Arc<dyn EpisodicMemoryPort>
            )),
            knowledge_use_case: Arc::new(KnowledgeUseCase::new(
                adapter.clone() as Arc<dyn KnowledgePort>
            )),
        });

        let base_state = Arc::new(AppState::from_groups(
            core,
            ai,
            integration,
            runtime,
            memory,
        ));

        base_state
            .models
            .save_registry(&ModelRegistry {
                models: vec![ModelEntry {
                    id: "embed-1".to_string(),
                    display_name: "Embedding Model".to_string(),
                    role: "embedding".to_string(),
                    file_size: 0,
                    filename: "embed.gguf".to_string(),
                    source: "local".to_string(),
                    file_path: "E:/mock/embed.gguf".to_string(),
                    loader: "gguf".to_string(),
                    loader_model_name: None,
                    repo_id: None,
                    revision: None,
                    sha256: None,
                    added_at: "2026-01-01T00:00:00Z".to_string(),
                    parameter_size: None,
                    quantization: None,
                    context_length: Some(2048),
                    architecture: None,
                    chat_template: None,
                    stop_tokens: None,
                    default_temperature: None,
                    capabilities: None,
                    publisher: None,
                    description: None,
                    format: Some("gguf".to_string()),
                    tokenizer_path: None,
                    tokenizer_format: None,
                }],
                role_assignments: std::iter::once(("embedding".to_string(), "embed-1".to_string()))
                    .collect(),
                role_order: HashMap::new(),
            })
            .unwrap();

        let mut ctx = PipelineContext::new(
            "test_session",
            "test_turn",
            crate::context::pipeline_context::PipelineMode::Chat,
            "Hello query",
        );

        {
            let state_clone = (*base_state).clone();
            let mut config_val = state_clone
                .config
                .load_config()
                .unwrap_or_else(|_| serde_json::json!({}));

            let features = config_val
                .as_object_mut()
                .unwrap()
                .entry("features")
                .or_insert_with(|| serde_json::json!({}));
            let redesign = features
                .as_object_mut()
                .unwrap()
                .entry("redesign")
                .or_insert_with(|| serde_json::json!({}));
            redesign
                .as_object_mut()
                .unwrap()
                .insert("legacy_memory".to_string(), serde_json::Value::Bool(true));

            let app = config_val
                .as_object_mut()
                .unwrap()
                .entry("app")
                .or_insert_with(|| serde_json::json!({}));
            app.as_object_mut().unwrap().insert(
                "em_memory_enabled".to_string(),
                serde_json::Value::Bool(true),
            );

            state_clone
                .config
                .update_config(config_val.clone(), false)
                .unwrap();

            let state_arc = Arc::new(state_clone);
            let worker = MemoryWorker::new(10);

            worker.execute(&mut ctx, &state_arc).await.unwrap();

            assert!(adapter.called.load(Ordering::SeqCst));
            assert!(adapter.last_legacy_flag.load(Ordering::SeqCst));
        }

        {
            adapter.called.store(false, Ordering::SeqCst);
            let state_clone = (*base_state).clone();

            let mut config_val = state_clone
                .config
                .load_config()
                .unwrap_or_else(|_| serde_json::json!({}));

            let features = config_val
                .as_object_mut()
                .unwrap()
                .entry("features")
                .or_insert_with(|| serde_json::json!({}));
            let redesign = features
                .as_object_mut()
                .unwrap()
                .entry("redesign")
                .or_insert_with(|| serde_json::json!({}));
            redesign
                .as_object_mut()
                .unwrap()
                .insert("legacy_memory".to_string(), serde_json::Value::Bool(false));

            let app = config_val
                .as_object_mut()
                .unwrap()
                .entry("app")
                .or_insert_with(|| serde_json::json!({}));
            app.as_object_mut().unwrap().insert(
                "em_memory_enabled".to_string(),
                serde_json::Value::Bool(true),
            );

            state_clone
                .config
                .update_config(config_val.clone(), false)
                .unwrap();

            let state_arc = Arc::new(state_clone);
            let worker = MemoryWorker::new(10);

            worker.execute(&mut ctx, &state_arc).await.unwrap();

            assert!(adapter.called.load(Ordering::SeqCst));
            assert!(!adapter.last_legacy_flag.load(Ordering::SeqCst));
        }
    }
}
