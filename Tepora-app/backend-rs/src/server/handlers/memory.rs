use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::core::errors::ApiError;
use crate::infrastructure::episodic_store::{CompactionJob, CompactionStatus, MemoryScope};
use crate::state::AppStateWrite;

#[derive(Debug, Deserialize, Default)]
pub struct CompressMemoriesRequest {
    pub session_id: Option<String>,
    pub model_id: Option<String>,
    pub scope: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct RunDecayRequest {
    pub session_id: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct ListCompactionJobsQuery {
    pub session_id: Option<String>,
    pub scope: Option<String>,
    pub status: Option<String>,
}

pub async fn compress_memories(
    State(state): State<AppStateWrite>,
    Json(payload): Json<CompressMemoriesRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let session_id = payload.session_id.unwrap_or_else(|| "default".to_string());
    let model_id = payload
        .model_id
        .unwrap_or_else(|| resolve_default_text_model_id(&state));
    let scope = match payload.scope.as_deref() {
        Some(s) => std::str::FromStr::from_str(s)?,
        None => MemoryScope::default(),
    };

    // V2 async job path:
    // 1. Create a CompactionJob record with status=queued.
    // 2. Spawn Tokio task to run the actual compression.
    // 3. Return 202 Accepted immediately with the job_id.
    let job_id = uuid::Uuid::new_v4().to_string();
    let job = CompactionJob {
        id: job_id.clone(),
        session_id: session_id.clone(),
        scope,
        status: CompactionStatus::Queued,
        scanned_events: 0,
        merged_groups: 0,
        replaced_events: 0,
        created_events: 0,
        created_at: chrono::Utc::now(),
        finished_at: None,
    };

    // Persist the initial job record.
    state
        .em_memory_service
        .create_compaction_job(&job)
        .await
        .map_err(|e| ApiError::internal(format!("Failed to create compaction job: {e}")))?;

    // Clone necessary state for the background task.
    let bg_service = state.em_memory_service.clone();
    let bg_llm = state.llm.clone();
    let bg_job_id = job_id.clone();
    let bg_session_id = session_id.clone();

    tokio::spawn(async move {
        if let Err(e) = bg_service
            .compress_memories_as_job(&bg_session_id, &bg_llm, &model_id, &bg_job_id, scope)
            .await
        {
            tracing::error!("Background compaction job {} failed: {}", bg_job_id, e);
            // Mark the job as failed.
            bg_service
                .fail_compaction_job(&bg_session_id, &bg_job_id)
                .await;
        }
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "status": "queued",
            "job_id": job_id,
            "session_id": session_id,
        })),
    ))
}

pub async fn list_compaction_jobs(
    State(state): State<AppStateWrite>,
    Query(query): Query<ListCompactionJobsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let session_id = query.session_id.unwrap_or_else(|| "default".to_string());
    let scope = match query.scope.as_deref() {
        Some(s) => Some(std::str::FromStr::from_str(s)?),
        None => None,
    };
    let status = match query.status.as_deref() {
        Some(s) => Some(std::str::FromStr::from_str(s)?),
        None => None,
    };

    let jobs = state
        .em_memory_service
        .list_compaction_jobs(&session_id, scope, status)
        .await?;

    Ok(Json(json!({
        "session_id": session_id,
        "jobs": jobs,
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
            state.models.get_registry().ok().and_then(|registry| {
                registry
                    .models
                    .iter()
                    .find(|model| model.role == "text")
                    .map(|model| model.id.clone())
            })
        })
        .unwrap_or_else(|| "default".to_string())
}

#[cfg(test)]
mod tests {
    use crate::core::errors::ApiError;
    use crate::infrastructure::episodic_store::{CompactionStatus, MemoryScope};

    /// Verify that compress_memories handler's scope parsing returns BadRequest for unknown scopes.
    /// The handler calls `std::str::FromStr::from_str(s)?` so we test the same conversion.
    #[test]
    fn compress_memories_rejects_invalid_scope() {
        let result: Result<MemoryScope, ApiError> = std::str::FromStr::from_str("INVALID_SCOPE");
        assert!(result.is_err());
        match result.unwrap_err() {
            ApiError::BadRequest(msg) => assert!(msg.contains("Invalid MemoryScope")),
            e => panic!("Expected BadRequest, got {:?}", e),
        }
    }

    /// Verify that list_compaction_jobs handler's status parsing returns BadRequest for unknown statuses.
    #[test]
    fn list_compaction_jobs_rejects_invalid_status() {
        let result: Result<CompactionStatus, ApiError> =
            std::str::FromStr::from_str("NOT_A_STATUS");
        assert!(result.is_err());
        match result.unwrap_err() {
            ApiError::BadRequest(msg) => assert!(msg.contains("Invalid CompactionStatus")),
            e => panic!("Expected BadRequest, got {:?}", e),
        }
    }

    /// Verify that valid scope strings are accepted.
    #[test]
    fn compress_memories_accepts_valid_scope() {
        let char_scope: Result<MemoryScope, ApiError> = std::str::FromStr::from_str("Char");
        let prof_scope: Result<MemoryScope, ApiError> = std::str::FromStr::from_str("Prof");
        assert!(char_scope.is_ok());
        assert!(prof_scope.is_ok());
    }

    /// Verify that valid status strings are accepted and map to the correct variants.
    #[test]
    fn list_compaction_jobs_accepts_valid_status() {
        for (s, expected) in [
            ("queued", CompactionStatus::Queued),
            ("running", CompactionStatus::Running),
            ("done", CompactionStatus::Done),
            ("failed", CompactionStatus::Failed),
        ] {
            let parsed: Result<CompactionStatus, ApiError> = std::str::FromStr::from_str(s);
            assert!(parsed.is_ok(), "Failed to parse status '{}'", s);
            assert_eq!(parsed.unwrap(), expected);
        }
    }
}
