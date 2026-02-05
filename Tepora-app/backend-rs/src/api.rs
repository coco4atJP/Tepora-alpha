use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use chrono::{Duration as ChronoDuration, Utc};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tower_http::cors::CorsLayer;
use uuid::Uuid;

use crate::errors::ApiError;
use crate::mcp::McpToolInfo;
use crate::mcp_installer;
use crate::mcp_registry::McpRegistryServer;
use crate::security::require_api_key;
use crate::state::AppState;
use crate::ws::ws_handler;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/status", get(get_status))
        .route("/api/shutdown", post(shutdown))
        .route(
            "/api/config",
            get(get_config).post(update_config).patch(patch_config),
        )
        .route("/api/logs", get(get_logs))
        .route("/api/logs/:filename", get(get_log_content))
        .route("/api/sessions", get(list_sessions).post(create_session))
        .route(
            "/api/sessions/:session_id",
            get(get_session)
                .patch(update_session)
                .delete(delete_session),
        )
        .route(
            "/api/sessions/:session_id/messages",
            get(get_session_messages),
        )
        .route(
            "/api/custom-agents",
            get(list_custom_agents).post(create_custom_agent),
        )
        .route(
            "/api/custom-agents/:agent_id",
            get(get_custom_agent)
                .put(update_custom_agent)
                .delete(delete_custom_agent),
        )
        .route("/api/tools", get(list_tools))
        .route("/api/setup/requirements", get(setup_requirements))
        .route("/api/setup/default-models", get(setup_default_models))
        .route("/api/setup/init", post(setup_init))
        .route("/api/setup/preflight", post(setup_preflight))
        .route("/api/setup/run", post(setup_run))
        .route("/api/setup/progress", get(setup_progress))
        .route("/api/setup/finish", post(setup_finish))
        .route("/api/setup/models", get(setup_models))
        .route("/api/setup/model/roles", get(setup_model_roles))
        .route(
            "/api/setup/model/roles/character",
            post(setup_set_character_role),
        )
        .route(
            "/api/setup/model/roles/professional",
            post(setup_set_professional_role),
        )
        .route(
            "/api/setup/model/roles/professional/:task_type",
            delete(setup_delete_professional_role),
        )
        .route("/api/setup/model/active", post(setup_set_active_model))
        .route("/api/setup/model/reorder", post(setup_reorder_models))
        .route("/api/setup/model/check", post(setup_check_model))
        .route("/api/setup/model/download", post(setup_download_model))
        .route("/api/setup/model/local", post(setup_register_local_model))
        .route("/api/setup/model/:model_id", delete(setup_delete_model))
        .route(
            "/api/setup/models/ollama/refresh",
            post(setup_refresh_ollama_models),
        )
        .route(
            "/api/setup/model/update-check",
            get(setup_model_update_check),
        )
        .route(
            "/api/setup/binary/update-info",
            get(setup_binary_update_info),
        )
        .route("/api/setup/binary/update", post(setup_binary_update))
        .route("/api/mcp/status", get(mcp_status))
        .route("/api/mcp/config", get(mcp_config).post(mcp_update_config))
        .route("/api/mcp/store", get(mcp_store))
        .route("/api/mcp/install/preview", post(mcp_install_preview))
        .route("/api/mcp/install/confirm", post(mcp_install_confirm))
        .route(
            "/api/mcp/servers/:server_name/approve",
            post(mcp_approve_server),
        )
        .route(
            "/api/mcp/servers/:server_name/revoke",
            post(mcp_revoke_server),
        )
        .route(
            "/api/mcp/servers/:server_name/enable",
            post(mcp_enable_server),
        )
        .route(
            "/api/mcp/servers/:server_name/disable",
            post(mcp_disable_server),
        )
        .route("/api/mcp/servers/:server_name", delete(mcp_delete_server))
        .route("/api/mcp/policy", get(mcp_policy).patch(mcp_update_policy))
        .route("/ws", get(ws_handler))
        .with_state(state)
        .layer(CorsLayer::permissive())
}

async fn health(State(_state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "initialized": true,
        "core_version": "v2"
    }))
}

async fn shutdown(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(250)).await;
        std::process::exit(0);
    });

    Ok(Json(json!({"status": "shutting_down"})))
}

async fn get_status(State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    let total_messages = state.history.get_message_count("default").unwrap_or(0);
    Ok(Json(json!({
        "initialized": true,
        "core_version": "v2",
        "em_llm_enabled": false,
        "degraded": true,
        "total_messages": total_messages,
        "memory_events": 0
    })))
}

async fn get_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let config = state.config.load_config()?;
    let mut redacted = state.config.redact_sensitive_values(&config);
    absolutize_mcp_path(&mut redacted, &state.paths);
    Ok(Json(redacted))
}

async fn update_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    state.config.update_config(payload, false)?;
    Ok(Json(json!({"status": "success"})))
}

async fn patch_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    state.config.update_config(payload, true)?;
    Ok(Json(json!({"status": "success"})))
}

async fn get_logs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let mut logs = Vec::new();
    let log_dir = &state.paths.log_dir;
    if let Ok(entries) = fs::read_dir(log_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("log") {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    logs.push((
                        name.to_string(),
                        entry.metadata().and_then(|m| m.modified()).ok(),
                    ));
                }
            }
        }
    }

    logs.sort_by(|a, b| b.1.cmp(&a.1));
    let names: Vec<String> = logs.into_iter().map(|(name, _)| name).collect();
    Ok(Json(json!({"logs": names})))
}

async fn get_log_content(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(filename): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    if filename.contains('/') || filename.contains('\\') {
        return Err(ApiError::Forbidden);
    }

    let log_dir = state
        .paths
        .log_dir
        .canonicalize()
        .map_err(ApiError::internal)?;
    let candidate = log_dir.join(&filename);
    if !candidate.exists() {
        return Err(ApiError::NotFound("Log file not found".to_string()));
    }

    let file_path = candidate.canonicalize().map_err(ApiError::internal)?;
    if !file_path.starts_with(&log_dir) {
        return Err(ApiError::Forbidden);
    }

    let metadata = fs::metadata(&file_path).map_err(ApiError::internal)?;
    let content = if metadata.len() > 100 * 1024 {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = fs::File::open(&file_path).map_err(ApiError::internal)?;
        let seek_pos = metadata.len().saturating_sub(100 * 1024);
        let _ = file.seek(SeekFrom::Start(seek_pos));
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).map_err(ApiError::internal)?;
        String::from_utf8_lossy(&buf).to_string()
    } else {
        fs::read_to_string(&file_path).unwrap_or_default()
    };

    Ok(Json(json!({"content": content})))
}

#[derive(Debug, Deserialize)]
struct CreateSessionRequest {
    title: Option<String>,
}

async fn list_sessions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let sessions = state.history.list_sessions()?;
    let result: Vec<Value> = sessions
        .into_iter()
        .map(|session| {
            json!({
                "id": session.id,
                "title": session.title,
                "created_at": session.created_at,
                "updated_at": session.updated_at,
                "message_count": session.message_count,
                "preview": session.preview
            })
        })
        .collect();
    Ok(Json(json!({"sessions": result})))
}

async fn create_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<CreateSessionRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let session_id = state.history.create_session(payload.title)?;
    let session = state.history.get_session(&session_id)?;
    Ok(Json(json!({"session": session})))
}

async fn get_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let session = state
        .history
        .get_session(&session_id)?
        .ok_or_else(|| ApiError::NotFound("Session not found".to_string()))?;

    let messages = state.history.get_history(&session_id, 100)?;
    let message_payload: Vec<Value> = messages
        .into_iter()
        .map(|msg| {
            json!({
                "type": msg.message_type,
                "content": msg.content
            })
        })
        .collect();

    Ok(Json(
        json!({"session": session, "messages": message_payload}),
    ))
}

async fn get_session_messages(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let limit = params
        .get("limit")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(100);

    let messages = state.history.get_history(&session_id, limit)?;

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
                .get("timestamp")
                .and_then(|v| v.as_str())
                .unwrap_or(&msg.created_at);
            let mode = msg
                .additional_kwargs
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("chat");

            json!({
                "id": Uuid::new_v4().to_string(),
                "role": role,
                "content": msg.content,
                "timestamp": timestamp,
                "mode": mode,
                "isComplete": true
            })
        })
        .collect();

    Ok(Json(json!({"messages": formatted})))
}

#[derive(Debug, Deserialize)]
struct UpdateSessionRequest {
    title: String,
}

#[derive(Debug, Deserialize, Default)]
struct McpStoreQuery {
    search: Option<String>,
    page: Option<i64>,
    #[serde(rename = "page_size")]
    page_size: Option<i64>,
    runtime: Option<String>,
    refresh: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
struct McpInstallPreviewRequest {
    server_id: String,
    runtime: Option<String>,
    #[serde(default)]
    env_values: Option<HashMap<String, String>>,
    server_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct McpInstallConfirmRequest {
    consent_id: String,
}

#[derive(Debug, Deserialize)]
struct McpApproveRequest {
    transport_types: Option<Vec<String>>,
}

struct PendingConsent {
    payload: Value,
    expires_at: chrono::DateTime<Utc>,
    request: McpInstallPreviewRequest,
    server: McpRegistryServer,
}

static MCP_PENDING_CONSENTS: OnceLock<Mutex<HashMap<String, PendingConsent>>> = OnceLock::new();
const MCP_CONSENT_TTL_SECS: i64 = 300;

async fn update_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(payload): Json<UpdateSessionRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let success = state
        .history
        .update_session_title(&session_id, &payload.title)?;
    if !success {
        return Err(ApiError::NotFound("Session not found".to_string()));
    }
    Ok(Json(json!({"success": true})))
}

async fn delete_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let success = state.history.delete_session(&session_id)?;
    if !success {
        return Err(ApiError::NotFound("Session not found".to_string()));
    }
    Ok(Json(json!({"success": true})))
}

#[derive(Debug, Deserialize)]
struct CustomAgentQuery {
    #[serde(default)]
    enabled_only: bool,
}

async fn list_custom_agents(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<CustomAgentQuery>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let config = state.config.load_config()?;
    let agents = config
        .get("custom_agents")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let list: Vec<Value> = agents
        .values()
        .filter(|agent| {
            if !query.enabled_only {
                return true;
            }
            agent
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true)
        })
        .cloned()
        .collect();

    Ok(Json(json!({"agents": list})))
}

async fn get_custom_agent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let config = state.config.load_config()?;
    let agent = config
        .get("custom_agents")
        .and_then(|v| v.as_object())
        .and_then(|map| map.get(&agent_id))
        .cloned()
        .ok_or_else(|| ApiError::NotFound("Agent not found".to_string()))?;

    Ok(Json(agent))
}

async fn create_custom_agent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(mut payload): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::BadRequest("Agent ID is required".to_string()))?
        .to_string();
    let name = payload
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::BadRequest("Agent name is required".to_string()))?;
    let system_prompt = payload
        .get("system_prompt")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::BadRequest("System prompt is required".to_string()))?;

    let mut config = state.config.load_config()?;
    let mut agents = config
        .get("custom_agents")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    if agents.contains_key(&id) {
        return Err(ApiError::BadRequest("Agent ID already exists".to_string()));
    }

    let now = Utc::now().to_rfc3339();
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("id".to_string(), Value::String(id.clone()));
        obj.insert("name".to_string(), Value::String(name.to_string()));
        obj.insert(
            "system_prompt".to_string(),
            Value::String(system_prompt.to_string()),
        );
        obj.insert("created_at".to_string(), Value::String(now.clone()));
        obj.insert("updated_at".to_string(), Value::String(now.clone()));
    }

    agents.insert(id.clone(), payload.clone());
    insert_config_section(&mut config, "custom_agents", Value::Object(agents));
    state.config.update_config(config, false)?;

    Ok(Json(json!({"status": "success", "agent": payload})))
}

async fn update_custom_agent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    Json(payload): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let mut config = state.config.load_config()?;
    let mut agents = config
        .get("custom_agents")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let existing = agents
        .get(&agent_id)
        .cloned()
        .ok_or_else(|| ApiError::NotFound("Agent not found".to_string()))?;

    let mut merged = merge_objects(existing, payload);
    if let Some(obj) = merged.as_object_mut() {
        obj.insert("id".to_string(), Value::String(agent_id.clone()));
        obj.insert(
            "updated_at".to_string(),
            Value::String(Utc::now().to_rfc3339()),
        );
    }

    agents.insert(agent_id.clone(), merged.clone());
    insert_config_section(&mut config, "custom_agents", Value::Object(agents));
    state.config.update_config(config, false)?;

    Ok(Json(json!({"status": "success", "agent": merged})))
}

async fn delete_custom_agent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let mut config = state.config.load_config()?;
    let mut agents = config
        .get("custom_agents")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    if agents.remove(&agent_id).is_none() {
        return Err(ApiError::NotFound("Agent not found".to_string()));
    }

    insert_config_section(&mut config, "custom_agents", Value::Object(agents));
    state.config.update_config(config, false)?;

    Ok(Json(json!({"status": "success"})))
}

async fn list_tools(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let mut tools = Vec::new();
    tools.push(json!({
        "name": "native_web_fetch",
        "description": "Fetch content from a URL"
    }));
    tools.push(json!({
        "name": "native_search",
        "description": "Search the web"
    }));

    let mcp_tools: Vec<McpToolInfo> = state.mcp.list_tools().await;
    for tool in mcp_tools {
        tools.push(json!({
            "name": tool.name,
            "description": tool.description
        }));
    }

    Ok(Json(json!({"tools": tools})))
}

// ----- Setup endpoints -----

#[derive(Debug, Deserialize)]
struct SetupInitRequest {
    language: String,
}

async fn setup_init(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<SetupInitRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    state.setup.set_language(payload.language.clone())?;
    Ok(Json(json!({"success": true, "language": payload.language})))
}

#[derive(Debug, Deserialize)]
struct SetupPreflightRequest {
    #[serde(default)]
    required_space_mb: Option<i64>,
}

async fn setup_preflight(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<SetupPreflightRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let test_path = state.paths.user_data_dir.join(".write_test");
    let write_ok = fs::write(&test_path, b"test").is_ok();
    if write_ok {
        let _ = fs::remove_file(&test_path);
    }
    if !write_ok {
        return Ok(Json(json!({
            "success": false,
            "error": "Write permission denied for user data directory."
        })));
    }

    let available = fs2::available_space(&state.paths.user_data_dir).unwrap_or(0);
    let available_mb = available / (1024 * 1024);
    if let Some(required) = payload.required_space_mb {
        if available_mb < required as u64 {
            return Ok(Json(json!({
                "success": false,
                "error": format!("Insufficient disk space. Required: {}MB, Available: {}MB", required, available_mb)
            })));
        }
    }

    Ok(Json(json!({"success": true, "available_mb": available_mb})))
}

async fn setup_requirements(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let config = state.config.load_config()?;
    let text_path = config
        .get("models_gguf")
        .and_then(|v| v.get("text_model"))
        .and_then(|v| v.get("path"))
        .and_then(|v| v.as_str())
        .map(|s| resolve_model_path(s, &state.paths));
    let embedding_path = config
        .get("models_gguf")
        .and_then(|v| v.get("embedding_model"))
        .and_then(|v| v.get("path"))
        .and_then(|v| v.as_str())
        .map(|s| resolve_model_path(s, &state.paths));

    let text_ok = text_path.as_ref().map(|p| p.exists()).unwrap_or(false);
    let embedding_ok = embedding_path.as_ref().map(|p| p.exists()).unwrap_or(false);
    let has_missing = !(text_ok && embedding_ok);

    Ok(Json(json!({
        "is_ready": text_ok,
        "has_missing": has_missing,
        "binary": {"status": "ok", "version": null},
        "models": {
            "text": {"status": if text_ok { "ok" } else { "missing" }, "name": text_path.map(|p| p.to_string_lossy().to_string())},
            "embedding": {"status": if embedding_ok { "ok" } else { "missing" }, "name": embedding_path.map(|p| p.to_string_lossy().to_string())}
        }
    })))
}

async fn setup_default_models(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let config = state.config.load_config()?;
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
    Ok(Json(
        json!({"text_models": text_models, "embedding": embedding}),
    ))
}

#[derive(Debug, Deserialize)]
struct SetupRunRequest {
    #[serde(default)]
    target_models: Option<Vec<Value>>,
    #[serde(default)]
    acknowledge_warnings: Option<bool>,
    #[serde(default)]
    loader: Option<String>,
}

#[derive(Debug, Clone)]
struct ModelDownloadSpec {
    repo_id: String,
    filename: String,
    role: String,
    display_name: String,
}

impl ModelDownloadSpec {
    fn role_key(&self) -> String {
        let lower = self.role.to_lowercase();
        if lower == "embedding" {
            "embedding".to_string()
        } else {
            "character".to_string()
        }
    }
}

async fn setup_run(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<SetupRunRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let job_id = Uuid::new_v4().to_string();
    state.setup.set_job_id(Some(job_id.clone()))?;
    state
        .setup
        .update_progress("pending", 0.0, "Starting setup...")?;
    if let Some(loader) = payload.loader.clone() {
        state.setup.set_loader(loader)?;
    }

    let config_snapshot = state.config.load_config()?;
    let mut target_models = build_target_models(payload.target_models, &config_snapshot);
    if payload.loader.as_deref() == Some("ollama") {
        target_models.retain(|model| model.role.to_lowercase() == "embedding");
    }

    let mut warnings = Vec::new();
    for model in &target_models {
        let policy = state
            .models
            .evaluate_download_policy(&model.repo_id, &model.filename);
        if !policy.allowed {
            return Ok(Json(json!({
                "success": false,
                "requires_consent": true,
                "warnings": policy.warnings
            })));
        }
        if policy.requires_consent {
            warnings.push(json!({
                "repo_id": model.repo_id,
                "filename": model.filename,
                "warnings": policy.warnings,
            }));
        }
    }

    if !warnings.is_empty() && payload.acknowledge_warnings != Some(true) {
        state.setup.set_job_id(None)?;
        return Ok(Json(json!({
            "success": false,
            "requires_consent": true,
            "warnings": warnings
        })));
    }

    let state_clone = state.clone();
    tokio::spawn(async move {
        let total = target_models.len().max(1) as f32;
        for (idx, model) in target_models.into_iter().enumerate() {
            let base_progress = idx as f32 / total;
            let progress_cb = |p: f32, message: &str| {
                let _ = state_clone.setup.update_progress(
                    "downloading",
                    base_progress + (p / total),
                    message,
                );
            };

            let result = state_clone
                .models
                .download_from_huggingface(
                    &model.repo_id,
                    &model.filename,
                    &model.role,
                    &model.display_name,
                    payload.acknowledge_warnings.unwrap_or(false),
                    Some(&progress_cb),
                )
                .await;

            if let Ok(result) = result {
                if result.success {
                    if let Some(model_id) = result.model_id.as_deref() {
                        let _ = state_clone
                            .models
                            .set_role_model(&model.role_key(), model_id);
                        let _ = state_clone
                            .models
                            .update_active_model_config(&model.role_key(), model_id);
                    }
                } else {
                    let _ = state_clone
                        .setup
                        .update_progress("failed", 0.0, "Setup failed");
                    let _ = state_clone.setup.set_job_id(None);
                    return;
                }
            } else {
                let _ = state_clone
                    .setup
                    .update_progress("failed", 0.0, "Setup failed");
                let _ = state_clone.setup.set_job_id(None);
                return;
            }
        }

        let _ =
            state_clone
                .setup
                .update_progress("completed", 1.0, "Setup completed successfully!");
        let _ = state_clone.setup.set_job_id(None);
    });

    Ok(Json(json!({"success": true, "job_id": job_id})))
}

async fn setup_progress(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let snapshot = state.setup.snapshot()?;
    Ok(Json(json!(snapshot.progress)))
}

#[derive(Debug, Deserialize)]
struct SetupFinishRequest {
    #[serde(default)]
    launch: Option<bool>,
}

fn build_target_models(payload: Option<Vec<Value>>, config: &Value) -> Vec<ModelDownloadSpec> {
    if let Some(list) = payload {
        let mut specs = Vec::new();
        for item in list {
            let repo_id = item
                .get("repo_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let filename = item
                .get("filename")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let role = item
                .get("role")
                .and_then(|v| v.as_str())
                .unwrap_or("text")
                .to_string();
            let display_name = item
                .get("display_name")
                .or_else(|| item.get("displayName"))
                .and_then(|v| v.as_str())
                .unwrap_or(&filename)
                .to_string();
            if repo_id.is_empty() || filename.is_empty() {
                continue;
            }
            specs.push(ModelDownloadSpec {
                repo_id,
                filename,
                role,
                display_name,
            });
        }
        if !specs.is_empty() {
            return specs;
        }
    }

    collect_default_models(config)
}

fn collect_default_models(config: &Value) -> Vec<ModelDownloadSpec> {
    let mut specs = Vec::new();
    if let Some(text_models) = config
        .get("default_models")
        .and_then(|v| v.get("text_models"))
        .and_then(|v| v.as_array())
    {
        for model in text_models {
            let repo_id = model
                .get("repo_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let filename = model
                .get("filename")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let display_name = model
                .get("display_name")
                .and_then(|v| v.as_str())
                .unwrap_or(&filename)
                .to_string();
            if repo_id.is_empty() || filename.is_empty() {
                continue;
            }
            specs.push(ModelDownloadSpec {
                repo_id,
                filename,
                role: "text".to_string(),
                display_name,
            });
        }
    }
    if let Some(embedding) = config
        .get("default_models")
        .and_then(|v| v.get("embedding"))
        .and_then(|v| v.as_object())
    {
        let repo_id = embedding
            .get("repo_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let filename = embedding
            .get("filename")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let display_name = embedding
            .get("display_name")
            .and_then(|v| v.as_str())
            .unwrap_or(&filename)
            .to_string();
        if !repo_id.is_empty() && !filename.is_empty() {
            specs.push(ModelDownloadSpec {
                repo_id,
                filename,
                role: "embedding".to_string(),
                display_name,
            });
        }
    }
    specs
}

async fn setup_finish(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(_payload): Json<SetupFinishRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let snapshot = state.setup.snapshot()?;
    let mut config = state.config.load_config()?;
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
    state.config.update_config(config, true)?;
    state.setup.clear()?;
    Ok(Json(json!({"success": true})))
}

async fn setup_models(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let models = state.models.list_models()?;
    let registry = state.models.get_registry()?;
    let active_text = registry.role_assignments.get("character").cloned();
    let active_embedding = registry.role_assignments.get("embedding").cloned();
    let payload: Vec<Value> = models
        .into_iter()
        .map(|model| {
            let is_active = if model.role == "embedding" {
                active_embedding.as_deref() == Some(&model.id)
            } else {
                active_text.as_deref() == Some(&model.id)
            };
            json!({
                "id": model.id,
                "display_name": model.display_name,
                "role": model.role,
                "file_size": model.file_size,
                "filename": model.filename,
                "source": model.source,
                "is_active": is_active,
            })
        })
        .collect();
    Ok(Json(json!({"models": payload})))
}

async fn setup_model_roles(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let registry = state.models.get_registry()?;
    let character_model_id = registry.role_assignments.get("character").cloned();
    let mut professional_map = Map::new();
    for (key, value) in registry.role_assignments.iter() {
        if key == "professional" {
            professional_map.insert("default".to_string(), Value::String(value.clone()));
        } else if let Some(task) = key.strip_prefix("professional:") {
            professional_map.insert(task.to_string(), Value::String(value.clone()));
        }
    }
    Ok(Json(json!({
        "character_model_id": character_model_id,
        "professional_model_map": professional_map
    })))
}

#[derive(Debug, Deserialize)]
struct ModelRoleRequest {
    model_id: String,
}

async fn setup_set_character_role(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<ModelRoleRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let ok = state
        .models
        .set_role_model("character", &payload.model_id)?;
    if ok {
        let _ = state
            .models
            .update_active_model_config("text", &payload.model_id);
        return Ok(Json(json!({"success": true})));
    }
    Err(ApiError::NotFound("Model not found".to_string()))
}

#[derive(Debug, Deserialize)]
struct ProfessionalRoleRequest {
    task_type: String,
    model_id: String,
}

async fn setup_set_professional_role(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<ProfessionalRoleRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let role_key = if payload.task_type == "default" || payload.task_type.is_empty() {
        "professional".to_string()
    } else {
        format!("professional:{}", payload.task_type)
    };
    let ok = state.models.set_role_model(&role_key, &payload.model_id)?;
    if ok {
        return Ok(Json(json!({"success": true})));
    }
    Err(ApiError::NotFound("Model not found".to_string()))
}

async fn setup_delete_professional_role(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(task_type): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let role_key = if task_type == "default" || task_type.is_empty() {
        "professional".to_string()
    } else {
        format!("professional:{}", task_type)
    };
    let _ = state.models.remove_role_assignment(&role_key)?;
    Ok(Json(json!({"success": true})))
}

#[derive(Debug, Deserialize)]
struct ActiveModelRequest {
    model_id: String,
    role: String,
}

async fn setup_set_active_model(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<ActiveModelRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let role_key = if payload.role.to_lowercase() == "embedding" {
        "embedding"
    } else {
        "character"
    };
    let ok = state.models.set_role_model(role_key, &payload.model_id)?;
    if ok {
        let _ = state
            .models
            .update_active_model_config(&payload.role.to_lowercase(), &payload.model_id);
        return Ok(Json(json!({"success": true})));
    }
    Err(ApiError::NotFound("Model not found".to_string()))
}

#[derive(Debug, Deserialize)]
struct ReorderRequest {
    role: String,
    model_ids: Vec<String>,
}

async fn setup_reorder_models(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<ReorderRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    state
        .models
        .reorder_models(&payload.role, payload.model_ids)?;
    Ok(Json(json!({"success": true})))
}

#[derive(Debug, Deserialize)]
struct ModelCheckRequest {
    repo_id: String,
    filename: String,
}

async fn setup_check_model(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<ModelCheckRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let size = state
        .models
        .get_remote_file_size(&payload.repo_id, &payload.filename)
        .await?;
    if let Some(size) = size {
        Ok(Json(json!({"exists": true, "size": size})))
    } else {
        Ok(Json(json!({"exists": false})))
    }
}

#[derive(Debug, Deserialize)]
struct ModelDownloadRequest {
    repo_id: String,
    filename: String,
    role: String,
    display_name: Option<String>,
    acknowledge_warnings: Option<bool>,
}

async fn setup_download_model(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<ModelDownloadRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let display = payload
        .display_name
        .clone()
        .unwrap_or_else(|| payload.filename.clone());
    let result = state
        .models
        .download_from_huggingface(
            &payload.repo_id,
            &payload.filename,
            &payload.role,
            &display,
            payload.acknowledge_warnings.unwrap_or(false),
            None,
        )
        .await?;

    if result.requires_consent {
        return Ok(Json(json!({
            "success": false,
            "requires_consent": true,
            "warnings": result.warnings
        })));
    }

    Ok(Json(json!({
        "success": result.success,
        "path": result.path.map(|p| p.to_string_lossy().to_string()),
        "error": result.error_message
    })))
}

#[derive(Debug, Deserialize)]
struct LocalModelRequest {
    file_path: String,
    role: String,
    display_name: Option<String>,
}

async fn setup_register_local_model(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<LocalModelRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let display = payload
        .display_name
        .clone()
        .unwrap_or_else(|| payload.file_path.clone());
    let path = PathBuf::from(&payload.file_path);
    let entry = state
        .models
        .register_local_model(&path, &payload.role, &display)?;
    Ok(Json(json!({"success": true, "model_id": entry.id})))
}

async fn setup_delete_model(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(model_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let ok = state.models.delete_model(&model_id)?;
    if !ok {
        return Err(ApiError::NotFound("Model not found".to_string()));
    }
    Ok(Json(json!({"success": true})))
}

async fn setup_refresh_ollama_models(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    Ok(Json(json!({"success": true, "synced_models": []})))
}

async fn setup_model_update_check(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    if let Some(model_id) = params.get("model_id") {
        let registry = state.models.get_registry()?;
        if let Some(entry) = registry.models.iter().find(|m| &m.id == model_id) {
            if let Some(repo_id) = entry.repo_id.as_ref() {
                let result = state
                    .models
                    .check_update(
                        repo_id,
                        &entry.filename,
                        entry.sha256.as_deref(),
                        Some(entry.file_size),
                    )
                    .await?;
                return Ok(Json(result));
            }
        }
        return Err(ApiError::NotFound("Model not found".to_string()));
    }

    if let (Some(repo_id), Some(filename)) = (params.get("repo_id"), params.get("filename")) {
        let result = state
            .models
            .check_update(repo_id, filename, None, None)
            .await?;
        return Ok(Json(result));
    }

    Err(ApiError::BadRequest(
        "repo_id and filename are required".to_string(),
    ))
}

async fn setup_binary_update_info(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(_params): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    Ok(Json(json!({"has_update": false, "current_version": null})))
}

#[derive(Debug, Deserialize)]
struct BinaryUpdateRequest {
    variant: Option<String>,
}

async fn setup_binary_update(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(_payload): Json<BinaryUpdateRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    Ok(Json(
        json!({"success": false, "job_id": Uuid::new_v4().to_string()}),
    ))
}

// ----- MCP endpoints (stubbed) -----

async fn mcp_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let status = state.mcp.status_snapshot().await;
    let mut servers = Map::new();
    for (name, entry) in status {
        servers.insert(
            name,
            json!({
                "status": entry.status,
                "tools_count": entry.tools_count,
                "error_message": entry.error_message,
                "last_connected": entry.last_connected,
            }),
        );
    }
    let error = state.mcp.init_error().await;
    Ok(Json(json!({
        "servers": servers,
        "initialized": state.mcp.initialized(),
        "config_path": state.mcp.config_path().to_string_lossy(),
        "error": error
    })))
}

async fn mcp_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let config = state.mcp.get_config().await;
    let config_value =
        serde_json::to_value(&config).unwrap_or_else(|_| json!({ "mcpServers": {} }));
    let servers = config_value
        .get("mcpServers")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let error = state.mcp.init_error().await;

    Ok(Json(json!({
        "mcpServers": servers,
        "initialized": state.mcp.initialized(),
        "config_path": state.mcp.config_path().to_string_lossy(),
        "error": error
    })))
}

async fn mcp_update_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    state.mcp.update_config(&payload).await?;
    Ok(Json(json!({"success": true})))
}

async fn mcp_store(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<McpStoreQuery>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let mut page = params.page.unwrap_or(1);
    if page < 1 {
        page = 1;
    }
    let mut page_size = params.page_size.unwrap_or(50);
    if page_size < 1 {
        page_size = 1;
    }
    if page_size > 200 {
        page_size = 200;
    }

    let refresh = params.refresh.unwrap_or(false);
    let search = params.search.as_deref();

    let mut servers = state
        .mcp_registry
        .fetch_servers(refresh, search, None)
        .await
        .unwrap_or_default();

    if let Some(runtime) = params.runtime.as_ref() {
        let runtime_lower = runtime.to_lowercase();
        servers = servers
            .into_iter()
            .filter(|server| {
                server.packages.iter().any(|pkg| {
                    pkg.runtime_hint
                        .as_ref()
                        .map(|hint| hint.to_lowercase() == runtime_lower)
                        .unwrap_or(false)
                })
            })
            .collect();
    }

    servers.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let total = servers.len() as i64;
    let start = (page - 1) * page_size;
    let end = start + page_size;
    let slice = if start >= total {
        Vec::new()
    } else {
        servers
            .into_iter()
            .skip(start as usize)
            .take(page_size as usize)
            .collect::<Vec<_>>()
    };

    let response_servers: Vec<Value> = slice
        .into_iter()
        .map(|server| {
            let McpRegistryServer {
                id,
                name,
                title,
                description,
                version,
                vendor,
                source_url,
                homepage,
                website_url,
                packages,
                environment_variables,
                icon,
                category,
            } = server;

            let packages_json: Vec<Value> = packages
                .iter()
                .map(|pkg| {
                    json!({
                        "name": pkg.package_name(),
                        "runtimeHint": pkg.runtime_hint.clone(),
                        "registry": pkg.package_registry(),
                        "version": pkg.version.clone(),
                    })
                })
                .collect();

            let env_json: Vec<Value> = environment_variables
                .iter()
                .map(|env| {
                    json!({
                        "name": env.name,
                        "description": env.description.clone(),
                        "isRequired": env.is_required,
                        "isSecret": env.is_secret,
                        "default": env.default.clone(),
                    })
                })
                .collect();

            json!({
                "id": id,
                "name": name,
                "title": title,
                "description": description,
                "version": version,
                "vendor": vendor,
                "packages": packages_json,
                "environmentVariables": env_json,
                "icon": icon,
                "category": category,
                "sourceUrl": source_url,
                "homepage": homepage,
                "websiteUrl": website_url,
            })
        })
        .collect();

    let has_more = end < total;

    Ok(Json(json!({
        "servers": response_servers,
        "total": total,
        "page": page,
        "page_size": page_size,
        "has_more": has_more
    })))
}

async fn mcp_install_preview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<McpInstallPreviewRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let server = state
        .mcp_registry
        .get_server_by_id(&payload.server_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("Server not found".to_string()))?;

    let consent_payload = mcp_installer::generate_consent_payload(
        &server,
        payload.runtime.as_deref(),
        payload.env_values.as_ref(),
    )?;

    let consent_id = Uuid::new_v4().to_string();
    let expires_at = Utc::now() + ChronoDuration::seconds(MCP_CONSENT_TTL_SECS);

    let pending = PendingConsent {
        payload: consent_payload.clone(),
        expires_at,
        request: payload.clone(),
        server,
    };

    {
        let store = pending_consents();
        let mut guard = store.lock().map_err(ApiError::internal)?;
        guard.insert(consent_id.clone(), pending);
        cleanup_expired_consents_locked(&mut guard);
    }

    Ok(Json(json!({
        "consent_id": consent_id,
        "expires_in_seconds": MCP_CONSENT_TTL_SECS,
        "server_id": consent_payload.get("server_id"),
        "server_name": consent_payload.get("server_name"),
        "description": consent_payload.get("description"),
        "command": consent_payload.get("command"),
        "args": consent_payload.get("args"),
        "env": consent_payload.get("env"),
        "full_command": consent_payload.get("full_command"),
        "warnings": consent_payload.get("warnings"),
        "requires_consent": consent_payload.get("requires_consent"),
        "runtime": consent_payload.get("runtime"),
    })))
}

async fn mcp_install_confirm(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<McpInstallConfirmRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;

    let pending = {
        let store = pending_consents();
        let mut guard = store.lock().map_err(ApiError::internal)?;
        cleanup_expired_consents_locked(&mut guard);
        guard
            .remove(&payload.consent_id)
            .ok_or_else(|| ApiError::BadRequest("Invalid or expired consent ID".to_string()))?
    };

    if pending.expires_at < Utc::now() {
        return Err(ApiError::BadRequest(
            "Consent has expired, please preview again".to_string(),
        ));
    }

    let mut servers = state.mcp.get_config().await.mcp_servers;
    let existing_names: std::collections::HashSet<String> = servers.keys().cloned().collect();
    let base_name = mcp_installer::normalize_server_key(
        pending
            .request
            .server_name
            .as_deref()
            .unwrap_or(&pending.request.server_id),
    );
    let server_name = mcp_installer::make_unique_key(&base_name, &existing_names);

    let mut config = mcp_installer::generate_config(
        &pending.server,
        pending.request.runtime.as_deref(),
        pending.request.env_values.as_ref(),
    )?;
    config.enabled = false;

    servers.insert(server_name.clone(), config);

    state
        .mcp
        .update_config(&json!({ "mcpServers": servers }))
        .await?;

    Ok(Json(json!({
        "status": "success",
        "server_name": server_name,
        "message": format!("Server '{}' installed successfully with consent", server_name)
    })))
}

async fn mcp_approve_server(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(server_name): Path<String>,
    Json(payload): Json<McpApproveRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let policy = state
        .mcp
        .approve_server(&server_name, payload.transport_types)?;
    Ok(Json(json!({"success": true, "policy": policy})))
}

async fn mcp_revoke_server(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(server_name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let (policy, removed) = state.mcp.revoke_server(&server_name)?;
    if !removed {
        return Err(ApiError::NotFound("Server not found".to_string()));
    }
    Ok(Json(json!({"success": true, "policy": policy})))
}

async fn mcp_enable_server(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(server_name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let ok = state.mcp.set_server_enabled(&server_name, true).await?;
    if !ok {
        return Err(ApiError::NotFound("Server not found".to_string()));
    }
    Ok(Json(json!({"success": true})))
}

async fn mcp_disable_server(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(server_name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let ok = state.mcp.set_server_enabled(&server_name, false).await?;
    if !ok {
        return Err(ApiError::NotFound("Server not found".to_string()));
    }
    Ok(Json(json!({"success": true})))
}

async fn mcp_delete_server(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(server_name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let ok = state.mcp.delete_server(&server_name).await?;
    if !ok {
        return Err(ApiError::NotFound("Server not found".to_string()));
    }
    Ok(Json(json!({"success": true})))
}

async fn mcp_policy(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let policy = state.mcp.load_policy()?;
    Ok(Json(policy))
}

async fn mcp_update_policy(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let policy = state.mcp.update_policy(&payload)?;
    Ok(Json(json!({"success": true, "policy": policy})))
}

fn insert_config_section(config: &mut Value, key: &str, section: Value) {
    if let Some(map) = config.as_object_mut() {
        map.insert(key.to_string(), section);
    }
}

fn ensure_object_path(config: &mut Value, path: &[&str], value: Value) {
    if path.is_empty() {
        return;
    }

    let mut current = config;
    for (index, key) in path.iter().enumerate() {
        if index == path.len() - 1 {
            if let Some(map) = current.as_object_mut() {
                map.insert(key.to_string(), value);
            }
            return;
        }

        if !current.get(*key).map(|v| v.is_object()).unwrap_or(false) {
            if let Some(map) = current.as_object_mut() {
                map.insert((*key).to_string(), Value::Object(Map::new()));
            }
        }

        current = current.get_mut(*key).unwrap();
    }
}

fn merge_objects(mut base: Value, overlay: Value) -> Value {
    match (base.as_object_mut(), overlay.as_object()) {
        (Some(base_map), Some(overlay_map)) => {
            for (key, value) in overlay_map {
                base_map.insert(key.clone(), value.clone());
            }
            base
        }
        _ => overlay,
    }
}

fn absolutize_mcp_path(config: &mut Value, paths: &crate::config::AppPaths) {
    let Some(app) = config.get_mut("app").and_then(|v| v.as_object_mut()) else {
        return;
    };
    let Some(path_value) = app.get("mcp_config_path").and_then(|v| v.as_str()) else {
        return;
    };
    let candidate = PathBuf::from(path_value);
    let absolute = if candidate.is_absolute() {
        candidate
    } else {
        paths.user_data_dir.join(candidate)
    };
    app.insert(
        "mcp_config_path".to_string(),
        Value::String(absolute.to_string_lossy().to_string()),
    );
}

fn resolve_model_path(raw: &str, paths: &crate::config::AppPaths) -> PathBuf {
    let candidate = PathBuf::from(raw);
    if candidate.is_absolute() {
        return candidate;
    }
    let user_candidate = paths.user_data_dir.join(&candidate);
    if user_candidate.exists() {
        return user_candidate;
    }
    let project_candidate = paths.project_root.join(&candidate);
    if project_candidate.exists() {
        return project_candidate;
    }
    user_candidate
}

fn pending_consents() -> &'static Mutex<HashMap<String, PendingConsent>> {
    MCP_PENDING_CONSENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cleanup_expired_consents_locked(store: &mut HashMap<String, PendingConsent>) {
    let now = Utc::now();
    store.retain(|_, consent| consent.expires_at > now);
}
