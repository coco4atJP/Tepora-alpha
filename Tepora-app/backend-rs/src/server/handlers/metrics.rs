use axum::extract::{Path, State};
use axum::Json;

use crate::infrastructure::observability::RuntimeMetricsSnapshot;
use crate::models::event::AgentEvent;
use crate::state::AppStateRead;

#[derive(serde::Serialize)]
pub struct MetricsResponse {
    pub events: Vec<AgentEvent>,
}

pub async fn get_session_metrics(
    State(state): State<AppStateRead>,
    Path(session_id): Path<String>,
) -> Result<Json<MetricsResponse>, crate::core::errors::ApiError> {
    let events = state
        .runtime()
        .history
        .get_agent_events(&session_id)
        .await?;
    Ok(Json(MetricsResponse { events }))
}

pub async fn get_runtime_metrics(
    State(state): State<AppStateRead>,
) -> Result<Json<RuntimeMetricsSnapshot>, crate::core::errors::ApiError> {
    Ok(Json(
        state.runtime().actor_manager.runtime_metrics_snapshot(),
    ))
}
