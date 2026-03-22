use serde_json::{json, Value};

use crate::core::errors::ApiError;
use crate::state::AppState;

use super::request::GenerationRequest;

pub async fn build_history_payload(state: &AppState, session_id: &str) -> Result<Value, ApiError> {
    let messages = state.runtime().history.get_history(session_id, 100).await?;
    let formatted: Vec<Value> = messages
        .into_iter()
        .map(|msg| {
            let role = match msg.message_type.as_str() {
                "ai" => "assistant",
                "system" => "system",
                _ => "user",
            };
            let timestamp = msg
                .additional_kwargs
                .as_ref()
                .and_then(|k| k.get("timestamp"))
                .and_then(|v| v.as_str())
                .unwrap_or(&msg.created_at)
                .to_string();
            let mode = msg
                .additional_kwargs
                .as_ref()
                .and_then(|k| k.get("mode"))
                .and_then(|v| v.as_str())
                .unwrap_or("chat")
                .to_string();

            json!({
                "id": msg.id.to_string(),
                "role": role,
                "content": msg.content,
                "timestamp": timestamp,
                "mode": mode,
                "isComplete": true
            })
        })
        .collect();

    Ok(json!({"type": "history", "messages": formatted}))
}

pub async fn persist_graph_interaction(
    state: &AppState,
    request: &GenerationRequest,
    assistant_output: &str,
) -> Result<(), ApiError> {
    let assistant_kwargs = json!({
        "timestamp": request.timestamp,
        "mode": request.mode.clone(),
        "thinking_budget": request.thinking_budget,
        "agent_id": request.requested_agent_id.clone(),
        "agent_mode": request.requested_agent_mode.clone(),
    });
    state
        .runtime()
        .history
        .add_message(
            &request.session_id,
            "ai",
            assistant_output,
            Some(assistant_kwargs),
        )
        .await?;

    let text_model_id = state
        .ai()
        .models
        .resolve_agent_model_id(request.requested_agent_id.as_deref())
        .ok()
        .flatten()
        .unwrap_or_else(|| "default".to_string());
    let embedding_model_id = resolve_embedding_model_id(state);
    let legacy_enabled = state.is_redesign_enabled("legacy_memory");

    let _ = state
        .memory()
        .memory_adapter
        .ingest_interaction(
            &request.session_id,
            &request.message_text,
            assistant_output,
            &state.ai().llm,
            &text_model_id,
            &embedding_model_id,
            legacy_enabled,
        )
        .await;

    Ok(())
}

fn resolve_embedding_model_id(state: &AppState) -> String {
    state
        .ai()
        .models
        .resolve_embedding_model_id()
        .ok()
        .flatten()
        .unwrap_or_else(|| "default".to_string())
}
