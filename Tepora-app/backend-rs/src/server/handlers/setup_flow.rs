use std::fs;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

use super::setup_models::{build_target_models, download_tasks_from_specs, run_download_job};
use super::utils::ensure_object_path;
use crate::core::errors::ApiError;
use crate::state::{AppStateRead, AppStateWrite};

pub fn init_setup(state: &AppStateWrite, language: &str) -> Result<Value, ApiError> {
    state.core().setup.set_language(language.to_string())?;
    Ok(json!({"success": true, "language": language}))
}

pub fn preflight_payload(
    state: &AppStateRead,
    required_space_mb: Option<i64>,
) -> Result<Value, ApiError> {
    let test_path = state.core().paths.user_data_dir.join(".write_test");
    let write_ok = fs::write(&test_path, b"test").is_ok();
    if write_ok {
        let _ = fs::remove_file(&test_path);
    }
    if !write_ok {
        return Ok(json!({
            "success": false,
            "error": "Write permission denied for user data directory."
        }));
    }

    let available = fs2::available_space(&state.core().paths.user_data_dir).unwrap_or(0);
    let available_mb = available / (1024 * 1024);
    if let Some(required) = required_space_mb {
        if available_mb < required as u64 {
            return Ok(json!({
                "success": false,
                "error": format!("Insufficient disk space. Required: {}MB, Available: {}MB", required, available_mb)
            }));
        }
    }

    Ok(json!({"success": true, "available_mb": available_mb}))
}

pub fn requirements_payload(state: &AppStateRead) -> Result<Value, ApiError> {
    let text_model = state.ai().models.resolve_assignment_model("character")?;
    let embedding_model = state.ai().models.resolve_assignment_model("embedding")?;
    let text_ok = text_model
        .as_ref()
        .map(|model| model.file_path.starts_with("ollama://")
            || model.file_path.starts_with("lmstudio://")
            || std::path::Path::new(&model.file_path).exists())
        .unwrap_or(false);
    let embedding_ok = embedding_model
        .as_ref()
        .map(|model| model.file_path.starts_with("ollama://")
            || model.file_path.starts_with("lmstudio://")
            || std::path::Path::new(&model.file_path).exists())
        .unwrap_or(false);
    let has_missing = !(text_ok && embedding_ok);

    Ok(json!({
        "is_ready": text_ok && embedding_ok,
        "has_missing": has_missing,
        "binary": {"status": "ok", "version": null},
        "models": {
            "text": {"status": if text_ok { "ok" } else { "missing" }, "name": text_model.map(|m| m.display_name)},
            "embedding": {"status": if embedding_ok { "ok" } else { "missing" }, "name": embedding_model.map(|m| m.display_name)}
        }
    }))
}

pub fn default_models_payload(state: &AppStateRead) -> Result<Value, ApiError> {
    let config = state.core().config.load_config()?;
    let defaults = config.get("default_models").cloned().unwrap_or(json!({}));
    let mut text_models = defaults
        .get("text_models")
        .cloned()
        .unwrap_or(Value::Array(vec![]));
    if text_models
        .as_array()
        .map(|arr| arr.is_empty())
        .unwrap_or(true)
    {
        let mut fallback = Vec::new();
        for key in ["character", "executor", "text"] {
            if let Some(model) = defaults.get(key) {
                fallback.push(model.clone());
            }
        }
        text_models = Value::Array(fallback);
    }
    let embedding = defaults.get("embedding").cloned().unwrap_or(Value::Null);
    Ok(json!({"text_models": text_models, "embedding": embedding}))
}

pub fn progress_payload(state: &AppStateRead) -> Result<Value, ApiError> {
    let snapshot = state.core().setup.snapshot()?;
    Ok(json!(snapshot.progress))
}

pub fn finish_setup(state: &AppStateWrite) -> Result<Value, ApiError> {
    let snapshot = state.core().setup.snapshot()?;
    let mut config = state.core().config.load_config()?;
    ensure_object_path(&mut config, &["app", "setup_completed"], Value::Bool(true));
    ensure_object_path(
        &mut config,
        &["app", "language"],
        Value::String(snapshot.language),
    );
    ensure_object_path(
        &mut config,
        &["llm_manager", "loader"],
        Value::String(snapshot.loader),
    );
    state.core().config.update_config(config, true)?;
    state.core().setup.clear()?;
    Ok(json!({"success": true}))
}

pub fn start_setup_run(
    state: &AppStateWrite,
    target_models: Option<Vec<Value>>,
    acknowledge_warnings: Option<bool>,
    loader: Option<String>,
) -> Result<Response, ApiError> {
    state
        .core()
        .security
        .ensure_lockdown_disabled("model_download")?;
    let job_id = Uuid::new_v4().to_string();
    state.core().setup.set_job_id(Some(job_id.clone()))?;
    state
        .core()
        .setup
        .update_progress("pending", 0.0, "Starting setup...")?;
    if let Some(loader) = loader.clone() {
        state.core().setup.set_loader(loader)?;
    }

    let config_snapshot = state.core().config.load_config()?;
    let mut target_models = build_target_models(target_models, &config_snapshot);
    if loader.as_deref() == Some("ollama") {
        target_models.retain(|model| model.modality.eq_ignore_ascii_case("embedding"));
    }

    let mut warnings = Vec::new();
    for model in &target_models {
        let policy = state.ai().models.evaluate_download_policy(
            &model.repo_id,
            &model.filename,
            model.revision.as_deref(),
            model.sha256.as_deref(),
        );
        if !policy.allowed {
            return Ok(Json(json!({
                "success": false,
                "requires_consent": false,
                "warnings": policy.warnings
            }))
            .into_response());
        }
        if policy.requires_consent {
            warnings.push(json!({
                "repo_id": model.repo_id,
                "filename": model.filename,
                "revision": model.revision.clone(),
                "warnings": policy.warnings,
            }));
        }
    }

    if !warnings.is_empty() && acknowledge_warnings != Some(true) {
        state.core().setup.set_job_id(None)?;
        return Ok((
            StatusCode::CONFLICT,
            Json(json!({
                "error": "Download requires confirmation",
                "success": false,
                "requires_consent": true,
                "warnings": warnings
            })),
        )
            .into_response());
    }

    let dl_tasks = download_tasks_from_specs(target_models, acknowledge_warnings.unwrap_or(false));

    let state_clone = state.clone();
    tokio::spawn(run_download_job(state_clone, dl_tasks));

    Ok(Json(json!({"success": true, "job_id": job_id})).into_response())
}
