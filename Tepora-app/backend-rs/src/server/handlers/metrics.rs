use axum::extract::{Path, State};
use axum::Json;
use std::sync::Arc;

use crate::infrastructure::observability::RuntimeMetricsSnapshot;
use crate::models::event::AgentEvent;
use crate::state::AppState;

#[derive(serde::Serialize)]
pub struct MetricsResponse {
    pub events: Vec<AgentEvent>,
}

pub async fn get_session_metrics(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<MetricsResponse>, crate::core::errors::ApiError> {
    let events = state.history.get_agent_events(&session_id).await?;
    Ok(Json(MetricsResponse { events }))
}

pub async fn get_runtime_metrics(
    State(state): State<Arc<AppState>>,
) -> Result<Json<RuntimeMetricsSnapshot>, crate::core::errors::ApiError> {
    Ok(Json(state.actor_manager.runtime_metrics_snapshot()))
}
