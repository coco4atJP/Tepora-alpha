use super::pipeline_context::{ModelTokenizerSpec, PipelineContext, PipelineMode, TokenBudget};
use super::worker::WorkerPipeline;
use super::workers::character_worker::CharacterWorker;
use super::workers::memory_worker::MemoryWorker;
use super::workers::rag_worker::RagWorker;
use super::workers::search_worker::SearchWorker;
use super::workers::system_worker::SystemWorker;
use super::workers::tool_worker::ToolWorker;
use crate::core::errors::ApiError;
use crate::llm::ChatMessage;
use crate::state::AppState;
use serde_json::Value;
use std::sync::Arc;

pub struct ContextResult {
    pub messages: Vec<ChatMessage>,
}

pub struct ContextPipeline;

impl ContextPipeline {
    pub async fn build_v4(
        state: &Arc<AppState>,
        session_id: &str,
        user_input: &str,
        mode: PipelineMode,
        skip_web_search: bool,
    ) -> Result<PipelineContext, ApiError> {
        let config = state.core().config.load_config().unwrap_or_default();
        let token_budget = resolve_token_budget(state, &config, mode);
        let tokenizer_spec = resolve_tokenizer_spec(state, &config);

        let mut pipeline_ctx = PipelineContext::new(
            session_id,
            uuid::Uuid::new_v4().to_string(),
            mode,
            user_input,
        )
        .with_config_snapshot(config.clone())
        .with_token_budget(token_budget)
        .with_tokenizer_spec(tokenizer_spec);

        let pipeline = WorkerPipeline::new()
            .add_worker(Box::new(SystemWorker))
            .add_worker(Box::new(CharacterWorker))
            .add_worker(Box::new(MemoryWorker::default()))
            .add_worker(Box::new(ToolWorker))
            .add_worker(Box::new(SearchWorker::new(skip_web_search)))
            .add_worker(Box::new(RagWorker::default()));

        pipeline
            .run(&mut pipeline_ctx, state)
            .await
            .map_err(|e| ApiError::Internal(format!("Pipeline failed: {e}")))?;

        Ok(pipeline_ctx)
    }

    pub fn pipeline_to_context_result(ctx: &PipelineContext) -> ContextResult {
        let messages = ctx.to_messages();
        ContextResult { messages }
    }
}

fn resolve_token_budget(state: &Arc<AppState>, config: &Value, mode: PipelineMode) -> TokenBudget {
    let context_length = resolve_context_length(state, config);
    let (reserved_output, safety_margin) = match mode {
        PipelineMode::Chat => (
            clamp(context_length.saturating_mul(20) / 100, 256, 768),
            (context_length.saturating_mul(8) / 100).max(96),
        ),
        _ => (
            clamp(context_length.saturating_mul(25) / 100, 384, 1024),
            (context_length.saturating_mul(10) / 100).max(128),
        ),
    };

    TokenBudget::with_margin(context_length, reserved_output, safety_margin)
}

fn resolve_context_length(state: &Arc<AppState>, config: &Value) -> usize {
    let active_character = config
        .get("active_character")
        .or_else(|| config.get("active_agent_profile"))
        .and_then(|value| value.as_str());

    let context_from_registry = state
        .ai()
        .models
        .resolve_assignment_model(
            active_character
                .map(|value| format!("character:{value}"))
                .as_deref()
                .unwrap_or("character"),
        )
        .ok()
        .flatten()
        .and_then(|model| model.context_length);

    let context_from_assignment = state
        .ai()
        .models
        .find_first_model_by_modality("text")
        .ok()
        .flatten()
        .and_then(|model| model.context_length);

    let context_from_config = config
        .get("models")
        .or_else(|| config.get("models_gguf"))
        .and_then(|value| value.get("text").or_else(|| value.get("text_model")))
        .and_then(|value| value.get("n_ctx"))
        .and_then(|value| value.as_u64());

    context_from_registry
        .or(context_from_assignment)
        .or(context_from_config)
        .map(|value| value as usize)
        .unwrap_or(2048)
}

fn clamp(value: usize, min: usize, max: usize) -> usize {
    value.max(min).min(max)
}

fn resolve_tokenizer_spec(state: &Arc<AppState>, config: &Value) -> ModelTokenizerSpec {
    let active_character = config
        .get("active_character")
        .or_else(|| config.get("active_agent_profile"))
        .and_then(|value| value.as_str());
    let config_model = config
        .get("models")
        .or_else(|| config.get("models_gguf"))
        .and_then(|value| value.get("text").or_else(|| value.get("text_model")));

    let config_path = config_model
        .and_then(|value| value.get("tokenizer_path"))
        .and_then(|value| value.as_str())
        .map(ToString::to_string);
    let config_format = config_model
        .and_then(|value| value.get("tokenizer_format"))
        .and_then(|value| value.as_str())
        .map(ToString::to_string);

    let active_model = state
        .ai()
        .models
        .resolve_assignment_model(
            active_character
                .map(|value| format!("character:{value}"))
                .as_deref()
                .unwrap_or("character"),
        )
        .ok()
        .flatten()
        .or_else(|| {
            state
                .ai()
                .models
                .find_first_model_by_modality("text")
                .ok()
                .flatten()
        });
    let active_model_id = active_model.as_ref().map(|model| model.id.clone());
    let registry_entry = active_model.as_ref();

    let discovered_path = config_path
        .clone()
        .or_else(|| registry_entry.and_then(|entry| entry.tokenizer_path.clone()))
        .or_else(|| {
            config_model
                .and_then(|value| value.get("path"))
                .and_then(|value| value.as_str())
                .and_then(find_adjacent_tokenizer_json)
        })
        .or_else(|| {
            registry_entry.and_then(|entry| find_adjacent_tokenizer_json(&entry.file_path))
        });

    let tokenizer_format = config_format
        .clone()
        .or_else(|| registry_entry.and_then(|entry| entry.tokenizer_format.clone()))
        .or_else(|| {
            discovered_path
                .as_ref()
                .map(|_| "tokenizer_json".to_string())
        });

    ModelTokenizerSpec {
        model_id: active_model_id,
        tokenizer_path: discovered_path,
        tokenizer_format,
    }
}

fn find_adjacent_tokenizer_json(model_path: &str) -> Option<String> {
    if model_path.starts_with("ollama://") || model_path.starts_with("lmstudio://") {
        return None;
    }

    let path = std::path::Path::new(model_path);
    let parent = path.parent()?;
    let tokenizer = parent.join("tokenizer.json");
    if tokenizer.exists() {
        Some(tokenizer.to_string_lossy().to_string())
    } else {
        None
    }
}
