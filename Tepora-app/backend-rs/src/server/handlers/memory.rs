use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::core::errors::ApiError;
use crate::state::AppStateWrite;

#[derive(Debug, Deserialize, Default)]
pub struct CompressMemoriesRequest {
    pub session_id: Option<String>,
    pub model_id: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct RunDecayRequest {
    pub session_id: Option<String>,
}

pub async fn compress_memories(
    State(state): State<AppStateWrite>,
    Json(payload): Json<CompressMemoriesRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let session_id = payload.session_id.unwrap_or_else(|| "default".to_string());
    let model_id = payload
        .model_id
        .unwrap_or_else(|| resolve_default_text_model_id(&state));

    let result = state
        .em_memory_service
        .compress_memories(&session_id, &state.llm, &model_id)
        .await?;

    Ok(Json(json!({
        "status": "success",
        "session_id": session_id,
        "model_id": model_id,
        "result": result
    })))
}

pub async fn run_decay_cycle(
    State(state): State<AppStateWrite>,
    Json(payload): Json<RunDecayRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let result = state
        .em_memory_service
        .run_decay_cycle(payload.session_id.as_deref())
        .await?;

    Ok(Json(json!({
        "status": "success",
        "result": result
    })))
}

fn resolve_default_text_model_id(state: &crate::state::AppState) -> String {
    let active_character = state.config.load_config().ok().and_then(|config| {
        config
            .get("active_agent_profile")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    });

    state
        .models
        .resolve_character_model_id(active_character.as_deref())
        .ok()
        .flatten()
        .or_else(|| {
            state
                .models
                .get_registry()
                .ok()
                .and_then(|registry| {
                    registry
                        .models
                        .iter()
                        .find(|model| model.role == "text")
                        .map(|model| model.id.clone())
                })
        })
        .unwrap_or_else(|| "default".to_string())
}
