use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::json;
use std::time::Duration;

use crate::core::errors::ApiError;
use crate::core::security::require_api_key;
use crate::state::AppStateRead;

fn resolve_overall_health(llm_status: &str, db_status: &str, mcp_status: &str) -> &'static str {
    if db_status == "error" || llm_status != "ok" || mcp_status != "ok" {
        "degraded"
    } else {
        "healthy"
    }
}

pub async fn health(State(state): State<AppStateRead>) -> impl IntoResponse {
    // Check LLM availability via role_assignments
    let active_character = state.config.load_config().ok().and_then(|config| {
        config
            .get("active_agent_profile")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    });

    let (llm_status, llm_model) = match state
        .models
        .resolve_character_model_id(active_character.as_deref())
    {
        Ok(Some(model_id)) => ("ok", model_id),
        Ok(None) => ("no_model", String::new()),
        Err(_) => ("error", String::new()),
    };

    // Check database availability via a lightweight query
    let db_start = std::time::Instant::now();
    let db_status = match state.history.get_total_message_count().await {
        Ok(_) => "ok",
        Err(_) => "error",
    };
    let db_latency_ms = db_start.elapsed().as_millis();

    // Check MCP status
    let mcp_statuses = state.mcp.status_snapshot().await;
    let mcp_connected = mcp_statuses
        .values()
        .filter(|s| s.status == "connected")
        .count();
    let mcp_failed = mcp_statuses
        .values()
        .filter(|s| s.status == "error")
        .count();
    let mcp_status = if mcp_failed > 0 && mcp_connected == 0 {
        "error"
    } else if mcp_failed > 0 {
        "degraded"
    } else {
        "ok"
    };

    let overall = resolve_overall_health(llm_status, db_status, mcp_status);

    Json(json!({
        "status": overall,
        "initialized": true,
        "core_version": "v2",
        "components": {
            "llm": {
                "status": llm_status,
                "model": llm_model
            },
            "database": {
                "status": db_status,
                "latency_ms": db_latency_ms
            },
            "mcp": {
                "status": mcp_status,
                "connected": mcp_connected,
                "failed": mcp_failed
            }
        }
    }))
}

pub async fn shutdown(
    State(state): State<AppStateRead>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(250)).await;
        std::process::exit(0);
    });

    Ok(Json(json!({"status": "shutting_down"})))
}

pub async fn get_status(
    State(state): State<AppStateRead>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let total_messages = state.history.get_total_message_count().await.unwrap_or(0);
    let memory_stats = state.em_memory_service.stats().await?;
    Ok(Json(json!({
        "initialized": true,
        "core_version": "v2",
        "em_llm_enabled": memory_stats.enabled,
        "degraded": false,
        "total_messages": total_messages,
        "memory_events": memory_stats.total_events,
        "retrieval": {
            "limit": memory_stats.retrieval_limit,
            "min_score": memory_stats.min_score
        }
    })))
}

#[cfg(test)]
mod tests {
    use super::resolve_overall_health;

    #[test]
    fn resolve_overall_health_requires_all_components_ok() {
        assert_eq!(resolve_overall_health("ok", "ok", "ok"), "healthy");
    }

    #[test]
    fn resolve_overall_health_marks_degraded_on_error_or_missing_model() {
        assert_eq!(resolve_overall_health("error", "ok", "ok"), "degraded");
        assert_eq!(resolve_overall_health("no_model", "ok", "ok"), "degraded");
        assert_eq!(resolve_overall_health("ok", "error", "ok"), "degraded");
        assert_eq!(resolve_overall_health("ok", "ok", "degraded"), "degraded");
        assert_eq!(resolve_overall_health("ok", "ok", "error"), "degraded");
    }
}
