use axum::extract::{Path, State};
use axum::Json;
use std::sync::Arc;
use crate::state::AppState;
use crate::models::event::AgentEvent;

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
