use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Component, Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use chrono::{Duration as ChronoDuration, Utc};
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tar::Archive;
use tower_http::cors::{AllowOrigin, CorsLayer};
use uuid::Uuid;
use zip::ZipArchive;

use crate::errors::ApiError;
use crate::mcp::McpToolInfo;
use crate::mcp_installer;
use crate::mcp_registry::McpRegistryServer;
use crate::security::require_api_key;
use crate::state::AppState;
use crate::ws::ws_handler;

pub fn router(state: Arc<AppState>) -> Router {
    let cors_layer = build_cors_layer(&state);
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
        .layer(cors_layer)
}

fn build_cors_layer(state: &Arc<AppState>) -> CorsLayer {
    let config = state.config.load_config().unwrap_or(Value::Null);
    let allowed_origins = resolve_allowed_origins(&config)
        .into_iter()
        .filter_map(|origin| HeaderValue::from_str(&origin).ok())
        .collect::<Vec<_>>();

    let allow_origin = if allowed_origins.is_empty() {
        AllowOrigin::list(
            default_local_origins()
                .into_iter()
                .filter_map(|origin| HeaderValue::from_str(&origin).ok())
                .collect::<Vec<_>>(),
        )
    } else {
        AllowOrigin::list(allowed_origins)
    };

    CorsLayer::new()
        .allow_origin(allow_origin)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::ACCEPT,
            header::CONTENT_TYPE,
            header::HeaderName::from_static("x-api-key"),
        ])
}

fn resolve_allowed_origins(config: &Value) -> Vec<String> {
    let origins = config
        .get("server")
        .and_then(|v| v.as_object())
        .and_then(|server| {
            server
                .get("cors_allowed_origins")
                .or_else(|| server.get("allowed_origins"))
                .or_else(|| server.get("ws_allowed_origins"))
        })
        .and_then(|value| value.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(|item| item.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if origins.is_empty() {
        return default_local_origins();
    }

    origins
}

fn default_local_origins() -> Vec<String> {
    vec![
        "tauri://localhost".to_string(),
        "https://tauri.localhost".to_string(),
        "http://tauri.localhost".to_string(),
        "http://localhost".to_string(),
        "http://localhost:3000".to_string(),
        "http://localhost:5173".to_string(),
        "http://127.0.0.1".to_string(),
        "http://127.0.0.1:3000".to_string(),
        "http://127.0.0.1:5173".to_string(),
        "http://127.0.0.1:8000".to_string(),
    ]
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
    let total_messages = state
        .history
        .get_message_count("default")
        .await
        .unwrap_or(0);
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
    let sessions = state.history.list_sessions().await?;
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
    let session_id = state.history.create_session(payload.title).await?;
    let session = state.history.get_session(&session_id).await?;
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
        .get_session(&session_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("Session not found".to_string()))?;

    let messages = state.history.get_history(&session_id, 100).await?;
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

    let messages = state.history.get_history(&session_id, limit).await?;

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
    #[allow(dead_code)]
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
        .update_session_title(&session_id, &payload.title)
        .await?;
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
    let success = state.history.delete_session(&session_id).await?;
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
        .ok_or_else(|| ApiError::BadRequest("Agent name is required".to_string()))?
        .to_string();
    let system_prompt = payload
        .get("system_prompt")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::BadRequest("System prompt is required".to_string()))?
        .to_string();

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
    revision: Option<String>,
    sha256: Option<String>,
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
        let policy = state.models.evaluate_download_policy(
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
            })));
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
                    model.revision.as_deref(),
                    model.sha256.as_deref(),
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
    #[allow(dead_code)]
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
            let revision = item
                .get("revision")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| v.to_string());
            let sha256 = item
                .get("sha256")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| v.to_string());
            if repo_id.is_empty() || filename.is_empty() {
                continue;
            }
            specs.push(ModelDownloadSpec {
                repo_id,
                filename,
                role,
                display_name,
                revision,
                sha256,
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
            let revision = model
                .get("revision")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| v.to_string());
            let sha256 = model
                .get("sha256")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| v.to_string());
            if repo_id.is_empty() || filename.is_empty() {
                continue;
            }
            specs.push(ModelDownloadSpec {
                repo_id,
                filename,
                role: "text".to_string(),
                display_name,
                revision,
                sha256,
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
        let revision = embedding
            .get("revision")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(|v| v.to_string());
        let sha256 = embedding
            .get("sha256")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(|v| v.to_string());
        if !repo_id.is_empty() && !filename.is_empty() {
            specs.push(ModelDownloadSpec {
                repo_id,
                filename,
                role: "embedding".to_string(),
                display_name,
                revision,
                sha256,
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
    revision: Option<String>,
    sha256: Option<String>,
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
            payload.revision.as_deref(),
            payload.sha256.as_deref(),
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
        "error": result.error_message,
        "warnings": result.warnings
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

#[derive(Debug, PartialEq, Eq)]
enum ModelUpdateCheckTarget<'a> {
    ModelId(&'a str),
    RepoFile {
        repo_id: &'a str,
        filename: &'a str,
        revision: Option<&'a str>,
    },
}

fn parse_model_update_check_target<'a>(
    params: &'a HashMap<String, String>,
) -> Result<ModelUpdateCheckTarget<'a>, ApiError> {
    let model_id = params
        .get("model_id")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(model_id) = model_id {
        return Ok(ModelUpdateCheckTarget::ModelId(model_id));
    }

    let repo_id = params
        .get("repo_id")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let filename = params
        .get("filename")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let (Some(repo_id), Some(filename)) = (repo_id, filename) {
        let revision = params
            .get("revision")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        return Ok(ModelUpdateCheckTarget::RepoFile {
            repo_id,
            filename,
            revision,
        });
    }

    Err(ApiError::BadRequest(
        "repo_id and filename are required".to_string(),
    ))
}

async fn setup_model_update_check(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    match parse_model_update_check_target(&params)? {
        ModelUpdateCheckTarget::ModelId(model_id) => {
            let registry = state.models.get_registry()?;
            if let Some(entry) = registry.models.iter().find(|m| m.id == model_id) {
                if let Some(repo_id) = entry.repo_id.as_ref() {
                    let result = state
                        .models
                        .check_update(
                            repo_id,
                            &entry.filename,
                            entry.revision.as_deref(),
                            entry.sha256.as_deref(),
                            Some(entry.file_size),
                        )
                        .await?;
                    return Ok(Json(result));
                }
            }
            Err(ApiError::NotFound("Model not found".to_string()))
        }
        ModelUpdateCheckTarget::RepoFile {
            repo_id,
            filename,
            revision,
        } => {
            let result = state
                .models
                .check_update(repo_id, filename, revision, None, None)
                .await?;
            Ok(Json(result))
        }
    }
}

async fn setup_binary_update_info(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let requested_variant = normalize_binary_variant(
        params
            .get("variant")
            .map(String::as_str)
            .filter(|value| !value.trim().is_empty()),
    );
    let release = fetch_latest_llama_release().await?;
    let current_version = current_binary_version_snapshot(&state.paths);
    let has_update = select_release_asset(&release, &requested_variant)
        .map(|_| is_newer_llama_release(current_version.as_deref(), &release.tag_name))
        .unwrap_or(false);

    Ok(Json(json!({
        "has_update": has_update,
        "current_version": current_version.unwrap_or_else(|| "unknown".to_string()),
        "latest_version": if has_update { Some(release.tag_name) } else { None },
        "release_notes": release.body,
    })))
}

#[derive(Debug, Deserialize)]
struct BinaryUpdateRequest {
    variant: Option<String>,
}

async fn setup_binary_update(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<BinaryUpdateRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let requested_variant = normalize_binary_variant(payload.variant.as_deref());
    let job_id = Uuid::new_v4().to_string();
    state.setup.set_job_id(Some(job_id.clone()))?;
    state
        .setup
        .update_progress("pending", 0.0, "Starting binary update...")?;

    let state_clone = state.clone();
    tokio::spawn(async move {
        let result = install_latest_llama_binary(state_clone.clone(), &requested_variant).await;
        match result {
            Ok(version) => {
                let _ = state_clone.setup.update_progress(
                    "completed",
                    1.0,
                    &format!("Updated llama.cpp binary to {}", version),
                );
            }
            Err(err) => {
                let _ = state_clone.setup.update_progress(
                    "failed",
                    0.0,
                    &format!("Update failed: {}", err),
                );
            }
        }
        let _ = state_clone.setup.set_job_id(None);
    });

    Ok(Json(json!({"success": true, "job_id": job_id})))
}

const LLAMA_RELEASE_LATEST_URL: &str =
    "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";
const LLAMA_RELEASE_USER_AGENT: &str = "tepora-backend-rs";

#[derive(Debug, Clone, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GithubReleaseAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct BinaryInstallRegistry {
    #[serde(default)]
    current_version: Option<String>,
    #[serde(default)]
    current_variant: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

fn binary_root_dir(paths: &crate::config::AppPaths) -> PathBuf {
    paths.user_data_dir.join("bin").join("llama.cpp")
}

fn binary_current_dir(paths: &crate::config::AppPaths) -> PathBuf {
    binary_root_dir(paths).join("current")
}

fn binary_download_dir(paths: &crate::config::AppPaths) -> PathBuf {
    binary_root_dir(paths).join("downloads")
}

fn binary_tmp_dir(paths: &crate::config::AppPaths) -> PathBuf {
    binary_root_dir(paths).join("tmp")
}

fn binary_registry_path(paths: &crate::config::AppPaths) -> PathBuf {
    binary_root_dir(paths).join("binary_registry.json")
}

fn load_binary_registry(paths: &crate::config::AppPaths) -> BinaryInstallRegistry {
    let path = binary_registry_path(paths);
    let Ok(contents) = fs::read_to_string(path) else {
        return BinaryInstallRegistry::default();
    };
    serde_json::from_str::<BinaryInstallRegistry>(&contents).unwrap_or_default()
}

fn save_binary_registry(
    paths: &crate::config::AppPaths,
    registry: &BinaryInstallRegistry,
) -> Result<(), ApiError> {
    let path = binary_registry_path(paths);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(ApiError::internal)?;
    }
    let serialized = serde_json::to_string_pretty(registry).map_err(ApiError::internal)?;
    fs::write(path, serialized).map_err(ApiError::internal)
}

fn current_binary_version_snapshot(paths: &crate::config::AppPaths) -> Option<String> {
    let registry = load_binary_registry(paths);
    let current = registry
        .current_version
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if current.is_some() {
        return current;
    }
    let current_dir = binary_current_dir(paths);
    if find_llama_server_executable(&current_dir).is_some() {
        return Some("installed".to_string());
    }
    None
}

fn normalize_binary_variant(value: Option<&str>) -> String {
    let normalized = value.unwrap_or("auto").trim().to_ascii_lowercase();
    match normalized.as_str() {
        "auto" | "cuda-12.4" | "cuda-11.8" | "vulkan" | "cpu-avx2" | "cpu-avx" | "cpu-sse42"
        | "metal" => normalized,
        _ => "auto".to_string(),
    }
}

fn resolve_binary_variant(normalized_variant: &str) -> String {
    if normalized_variant == "auto" {
        if cfg!(target_os = "macos") {
            "metal".to_string()
        } else {
            "cpu-avx2".to_string()
        }
    } else {
        normalized_variant.to_string()
    }
}

fn release_asset_patterns(normalized_variant: &str) -> Vec<String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    match os {
        "macos" => match normalized_variant {
            "metal" | "auto" => {
                if arch == "aarch64" {
                    vec!["macos-arm64.tar.gz".to_string()]
                } else {
                    vec!["macos-x64.tar.gz".to_string()]
                }
            }
            _ => vec!["macos-x64.tar.gz".to_string()],
        },
        "windows" => match normalized_variant {
            "cuda-12.4" => vec!["win-cuda-12.4-x64.zip".to_string()],
            "cuda-11.8" => vec!["win-cuda-cu11".to_string(), "win-cuda-11.".to_string()],
            "vulkan" => vec!["win-vulkan-x64.zip".to_string()],
            "cpu-avx2" | "cpu-avx" | "cpu-sse42" => vec!["win-cpu-x64.zip".to_string()],
            _ => {
                if arch == "aarch64" {
                    vec!["win-cpu-arm64.zip".to_string()]
                } else {
                    vec!["win-cpu-x64.zip".to_string()]
                }
            }
        },
        _ => match normalized_variant {
            "cuda-12.4" => vec!["linux-cuda-12.4-x64.tar.gz".to_string()],
            "cuda-11.8" => vec!["linux-cuda-11.".to_string()],
            "vulkan" => vec!["ubuntu-vulkan-x64.tar.gz".to_string()],
            _ => {
                if arch == "aarch64" {
                    vec![
                        "ubuntu-arm64.tar.gz".to_string(),
                        "ubuntu-x64.tar.gz".to_string(),
                    ]
                } else {
                    vec!["ubuntu-x64.tar.gz".to_string()]
                }
            }
        },
    }
}

fn select_release_asset(
    release: &GithubRelease,
    requested_variant: &str,
) -> Option<(String, GithubReleaseAsset)> {
    let normalized_variant = normalize_binary_variant(Some(requested_variant));
    let patterns = release_asset_patterns(&normalized_variant);
    for asset in &release.assets {
        let name = asset.name.to_ascii_lowercase();
        if patterns.iter().any(|pattern| name.contains(pattern)) {
            return Some((resolve_binary_variant(&normalized_variant), asset.clone()));
        }
    }
    None
}

fn parse_llama_build_number(version: &str) -> Option<u64> {
    let trimmed = version.trim();
    if trimmed.is_empty() {
        return None;
    }
    let number = trimmed
        .strip_prefix('b')
        .or_else(|| trimmed.strip_prefix('B'))
        .unwrap_or(trimmed);
    if number.chars().all(|c| c.is_ascii_digit()) {
        return number.parse::<u64>().ok();
    }
    None
}

fn is_newer_llama_release(current: Option<&str>, latest: &str) -> bool {
    let latest_num = parse_llama_build_number(latest);
    let current_num = current.and_then(parse_llama_build_number);
    match (current_num, latest_num) {
        (Some(current), Some(latest)) => latest > current,
        _ => current
            .map(|value| value.trim() != latest.trim())
            .unwrap_or(true),
    }
}

fn parse_sha256_digest(digest: Option<&str>) -> Option<String> {
    let raw = digest?.trim();
    if let Some(value) = raw.strip_prefix("sha256:") {
        return normalize_sha256_hex(value);
    }
    normalize_sha256_hex(raw)
}

fn normalize_sha256_hex(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() == 64 && normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Some(normalized);
    }
    None
}

async fn fetch_latest_llama_release() -> Result<GithubRelease, ApiError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(ApiError::internal)?;
    let response = client
        .get(LLAMA_RELEASE_LATEST_URL)
        .header(header::ACCEPT, "application/vnd.github+json")
        .header(header::USER_AGENT, LLAMA_RELEASE_USER_AGENT)
        .send()
        .await
        .map_err(ApiError::internal)?
        .error_for_status()
        .map_err(ApiError::internal)?;
    response
        .json::<GithubRelease>()
        .await
        .map_err(ApiError::internal)
}

async fn download_release_asset(
    asset: &GithubReleaseAsset,
    target_path: &FsPath,
    mut progress_cb: impl FnMut(f32, &str),
) -> Result<String, ApiError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(ApiError::internal)?;
    let response = client
        .get(&asset.browser_download_url)
        .header(header::ACCEPT, "application/octet-stream")
        .header(header::USER_AGENT, LLAMA_RELEASE_USER_AGENT)
        .send()
        .await
        .map_err(ApiError::internal)?
        .error_for_status()
        .map_err(ApiError::internal)?;

    let total = response.content_length().or(asset.size).unwrap_or(0);
    let mut stream = response.bytes_stream();
    let mut file = fs::File::create(target_path).map_err(ApiError::internal)?;
    let mut downloaded: u64 = 0;
    let mut hasher = Sha256::new();

    while let Some(chunk) = stream.next().await {
        let data = chunk.map_err(ApiError::internal)?;
        file.write_all(&data).map_err(ApiError::internal)?;
        hasher.update(&data);
        downloaded += data.len() as u64;
        let progress = if total > 0 {
            downloaded as f32 / total as f32
        } else {
            0.0
        };
        let message = if total > 0 {
            format!(
                "Downloading binary... {:.1} MB / {:.1} MB",
                downloaded as f64 / (1024_f64 * 1024_f64),
                total as f64 / (1024_f64 * 1024_f64)
            )
        } else {
            "Downloading binary...".to_string()
        };
        progress_cb(progress, &message);
    }

    Ok(hex::encode(hasher.finalize()))
}

fn normalize_archive_member_path(raw: &FsPath) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in raw.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => normalized.push(part),
            Component::RootDir | Component::ParentDir | Component::Prefix(_) => return None,
        }
    }
    if normalized.as_os_str().is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn extract_zip_archive(archive_path: &FsPath, destination: &FsPath) -> Result<(), ApiError> {
    let file = fs::File::open(archive_path).map_err(ApiError::internal)?;
    let mut zip = ZipArchive::new(file).map_err(ApiError::internal)?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(ApiError::internal)?;
        let Some(relative) = entry.enclosed_name() else {
            return Err(ApiError::BadRequest(format!(
                "Unsafe archive entry: {}",
                entry.name()
            )));
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        let target = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(ApiError::internal)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(ApiError::internal)?;
            }
            let mut outfile = fs::File::create(&target).map_err(ApiError::internal)?;
            std::io::copy(&mut entry, &mut outfile).map_err(ApiError::internal)?;
        }
    }
    Ok(())
}

fn extract_tar_gz_archive(archive_path: &FsPath, destination: &FsPath) -> Result<(), ApiError> {
    let file = fs::File::open(archive_path).map_err(ApiError::internal)?;
    let decoder = GzDecoder::new(file);
    let mut archive = Archive::new(decoder);
    for item in archive.entries().map_err(ApiError::internal)? {
        let mut entry = item.map_err(ApiError::internal)?;
        let raw_path = entry.path().map_err(ApiError::internal)?.into_owned();
        let Some(relative) = normalize_archive_member_path(&raw_path) else {
            return Err(ApiError::BadRequest(format!(
                "Unsafe archive entry: {}",
                raw_path.to_string_lossy()
            )));
        };
        let target = destination.join(relative);
        let entry_type = entry.header().entry_type();
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            return Err(ApiError::BadRequest(
                "Unsupported archive symlink entry".to_string(),
            ));
        }
        if entry_type.is_dir() {
            fs::create_dir_all(&target).map_err(ApiError::internal)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(ApiError::internal)?;
        }
        entry.unpack(&target).map_err(ApiError::internal)?;
    }
    Ok(())
}

fn find_llama_server_executable(root: &FsPath) -> Option<PathBuf> {
    let exe_name = if cfg!(target_os = "windows") {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    if !root.exists() {
        return None;
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.file_name().and_then(|name| name.to_str()) == Some(exe_name) {
                return Some(path);
            }
        }
    }
    None
}

fn copy_dir_recursive(source: &FsPath, destination: &FsPath) -> Result<(), ApiError> {
    fs::create_dir_all(destination).map_err(ApiError::internal)?;
    for item in fs::read_dir(source).map_err(ApiError::internal)? {
        let entry = item.map_err(ApiError::internal)?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &destination_path)?;
        } else {
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent).map_err(ApiError::internal)?;
            }
            fs::copy(&source_path, &destination_path).map_err(ApiError::internal)?;
        }
    }
    Ok(())
}

fn replace_current_binary_dir(source: &FsPath, current_dir: &FsPath) -> Result<(), ApiError> {
    if current_dir.exists() {
        fs::remove_dir_all(current_dir).map_err(ApiError::internal)?;
    }

    match fs::rename(source, current_dir) {
        Ok(_) => Ok(()),
        Err(_) => {
            copy_dir_recursive(source, current_dir)?;
            fs::remove_dir_all(source).map_err(ApiError::internal)?;
            Ok(())
        }
    }
}

fn is_zip_archive(path: &FsPath) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_ascii_lowercase().ends_with(".zip"))
        .unwrap_or(false)
}

fn is_tar_gz_archive(path: &FsPath) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            let lower = name.to_ascii_lowercase();
            lower.ends_with(".tar.gz") || lower.ends_with(".tgz")
        })
        .unwrap_or(false)
}

fn extract_binary_archive(archive_path: &FsPath, destination: &FsPath) -> Result<(), ApiError> {
    if is_zip_archive(archive_path) {
        return extract_zip_archive(archive_path, destination);
    }
    if is_tar_gz_archive(archive_path) {
        return extract_tar_gz_archive(archive_path, destination);
    }
    Err(ApiError::BadRequest(format!(
        "Unsupported archive format: {}",
        archive_path.display()
    )))
}

async fn install_latest_llama_binary(
    state: Arc<AppState>,
    requested_variant: &str,
) -> Result<String, ApiError> {
    state
        .setup
        .update_progress("pending", 0.05, "Checking latest llama.cpp release...")?;
    let release = fetch_latest_llama_release().await?;
    let (resolved_variant, asset) =
        select_release_asset(&release, requested_variant).ok_or_else(|| {
            ApiError::NotFound(format!(
                "No matching release asset found for variant '{}'",
                requested_variant
            ))
        })?;

    let install_root = binary_root_dir(&state.paths);
    let downloads_dir = binary_download_dir(&state.paths);
    let tmp_dir = binary_tmp_dir(&state.paths);
    fs::create_dir_all(&downloads_dir).map_err(ApiError::internal)?;
    fs::create_dir_all(&tmp_dir).map_err(ApiError::internal)?;

    let archive_name = FsPath::new(&asset.name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("llama-release.bin")
        .to_string();
    let archive_path = downloads_dir.join(&archive_name);
    let partial_path = downloads_dir.join(format!("{}.part", archive_name));

    let state_for_progress = state.clone();
    let downloaded_sha = download_release_asset(&asset, &partial_path, move |progress, message| {
        let stage_progress = 0.1 + (progress * 0.6);
        let _ = state_for_progress
            .setup
            .update_progress("downloading", stage_progress, message);
    })
    .await?;

    if archive_path.exists() {
        let _ = fs::remove_file(&archive_path);
    }
    fs::rename(&partial_path, &archive_path).map_err(ApiError::internal)?;

    state
        .setup
        .update_progress("verifying", 0.75, "Verifying SHA256 digest...")?;
    let expected_sha = parse_sha256_digest(asset.digest.as_deref()).ok_or_else(|| {
        ApiError::BadRequest("Release asset is missing a valid SHA256 digest".to_string())
    })?;
    if downloaded_sha != expected_sha {
        let _ = fs::remove_file(&archive_path);
        return Err(ApiError::BadRequest(
            "SHA256 verification failed for downloaded binary".to_string(),
        ));
    }

    state
        .setup
        .update_progress("extracting", 0.82, "Extracting archive...")?;
    let extract_dir = tmp_dir.join(format!("extract_{}", Uuid::new_v4()));
    if extract_dir.exists() {
        let _ = fs::remove_dir_all(&extract_dir);
    }
    fs::create_dir_all(&extract_dir).map_err(ApiError::internal)?;
    extract_binary_archive(&archive_path, &extract_dir)?;
    let _ = fs::remove_file(&archive_path);

    let current_dir = binary_current_dir(&state.paths);
    state
        .setup
        .update_progress("extracting", 0.92, "Installing binary files...")?;
    replace_current_binary_dir(&extract_dir, &current_dir)?;

    if find_llama_server_executable(&current_dir).is_none() {
        return Err(ApiError::Internal(
            "Installed archive does not contain llama-server executable".to_string(),
        ));
    }

    fs::create_dir_all(&install_root).map_err(ApiError::internal)?;
    save_binary_registry(
        &state.paths,
        &BinaryInstallRegistry {
            current_version: Some(release.tag_name.clone()),
            current_variant: Some(resolved_variant),
            updated_at: Some(Utc::now().to_rfc3339()),
        },
    )?;

    state
        .setup
        .update_progress("finalizing", 0.97, "Refreshing runtime paths...")?;
    let _ = state.llama.refresh_binary_path(&state.paths).await;

    Ok(release.tag_name)
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
    let page_size = params.page_size.unwrap_or(50).clamp(1, 200);

    let refresh = params.refresh.unwrap_or(false);
    let search = params.search.as_deref();

    let mut servers = state
        .mcp_registry
        .fetch_servers(refresh, search, None)
        .await
        .unwrap_or_default();

    if let Some(runtime) = params.runtime.as_ref() {
        let runtime_lower = runtime.to_lowercase();
        servers.retain(|server| {
            server.packages.iter().any(|pkg| {
                pkg.runtime_hint
                    .as_ref()
                    .map(|hint| hint.to_lowercase() == runtime_lower)
                    .unwrap_or(false)
            })
        });
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
                license: _,
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
            let Some(map) = current.as_object_mut() else {
                return;
            };
            map.insert((*key).to_string(), Value::Object(Map::new()));
        }

        let Some(next) = current.get_mut(*key) else {
            return;
        };
        current = next;
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

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::path::{Path, PathBuf};

    use chrono::{Duration as ChronoDuration, Utc};
    use serde_json::json;
    use uuid::Uuid;

    use super::{
        absolutize_mcp_path, build_target_models, cleanup_expired_consents_locked,
        collect_default_models, default_local_origins, ensure_object_path, is_newer_llama_release,
        merge_objects, normalize_archive_member_path, normalize_binary_variant,
        parse_llama_build_number, parse_model_update_check_target, parse_sha256_digest,
        release_asset_patterns, resolve_allowed_origins, resolve_model_path, select_release_asset,
        GithubRelease, GithubReleaseAsset, McpInstallPreviewRequest, McpRegistryServer,
        ModelUpdateCheckTarget, PendingConsent,
    };
    use crate::config::AppPaths;
    use crate::errors::ApiError;

    #[test]
    fn normalize_binary_variant_defaults_to_auto() {
        assert_eq!(normalize_binary_variant(None), "auto");
        assert_eq!(normalize_binary_variant(Some("unknown-value")), "auto");
        assert_eq!(normalize_binary_variant(Some("CPU-AVX2")), "cpu-avx2");
    }

    #[test]
    fn parse_llama_build_number_accepts_b_prefix() {
        assert_eq!(parse_llama_build_number("b7813"), Some(7813));
        assert_eq!(parse_llama_build_number("7814"), Some(7814));
        assert_eq!(parse_llama_build_number("v1.0.0"), None);
    }

    #[test]
    fn parse_model_update_check_target_prefers_model_id() {
        let params = HashMap::from([
            ("model_id".to_string(), "  model-1  ".to_string()),
            ("repo_id".to_string(), "owner/model".to_string()),
            ("filename".to_string(), "model.gguf".to_string()),
        ]);
        let target = parse_model_update_check_target(&params).expect("target should parse");
        assert!(matches!(target, ModelUpdateCheckTarget::ModelId("model-1")));
    }

    #[test]
    fn parse_model_update_check_target_parses_repo_filename_and_revision() {
        let params = HashMap::from([
            ("repo_id".to_string(), "  owner/model  ".to_string()),
            ("filename".to_string(), "  model.gguf  ".to_string()),
            ("revision".to_string(), "  refs/pr/42  ".to_string()),
        ]);
        let target = parse_model_update_check_target(&params).expect("target should parse");
        match target {
            ModelUpdateCheckTarget::RepoFile {
                repo_id,
                filename,
                revision,
            } => {
                assert_eq!(repo_id, "owner/model");
                assert_eq!(filename, "model.gguf");
                assert_eq!(revision, Some("refs/pr/42"));
            }
            _ => panic!("expected RepoFile target"),
        }
    }

    #[test]
    fn parse_model_update_check_target_ignores_blank_model_id() {
        let params = HashMap::from([
            ("model_id".to_string(), "   ".to_string()),
            ("repo_id".to_string(), "owner/model".to_string()),
            ("filename".to_string(), "model.gguf".to_string()),
        ]);
        let target = parse_model_update_check_target(&params).expect("target should parse");
        assert!(matches!(
            target,
            ModelUpdateCheckTarget::RepoFile {
                repo_id: "owner/model",
                filename: "model.gguf",
                revision: None,
            }
        ));
    }

    #[test]
    fn parse_model_update_check_target_requires_repo_and_filename() {
        let params = HashMap::from([
            ("repo_id".to_string(), "owner/model".to_string()),
            ("filename".to_string(), "  ".to_string()),
        ]);
        let err = parse_model_update_check_target(&params).expect_err("target should be invalid");
        match err {
            ApiError::BadRequest(message) => {
                assert_eq!(message, "repo_id and filename are required");
            }
            _ => panic!("expected bad request error"),
        }
    }

    #[test]
    fn release_comparison_prefers_higher_build_number() {
        assert!(is_newer_llama_release(Some("b7812"), "b7813"));
        assert!(!is_newer_llama_release(Some("b7813"), "b7813"));
        assert!(!is_newer_llama_release(Some("b7814"), "b7813"));
    }

    #[test]
    fn release_comparison_falls_back_when_unparseable() {
        assert!(is_newer_llama_release(None, "b7813"));
        assert!(is_newer_llama_release(Some("installed"), "b7813"));
        assert!(!is_newer_llama_release(Some("b7813"), "b7813"));
    }

    #[test]
    fn sha256_digest_parser_requires_valid_length() {
        let hash = "A".repeat(64);
        let prefixed = format!("sha256:{}", hash);
        assert_eq!(
            parse_sha256_digest(Some(prefixed.as_str())),
            Some("a".repeat(64))
        );
        assert_eq!(parse_sha256_digest(Some(&hash)), Some("a".repeat(64)));
        assert_eq!(parse_sha256_digest(None), None);
        assert_eq!(parse_sha256_digest(Some("sha256:xyz")), None);
    }

    #[test]
    fn archive_member_path_rejects_unsafe_paths() {
        assert!(normalize_archive_member_path(Path::new("../../evil")).is_none());
        assert!(normalize_archive_member_path(Path::new("/absolute/path")).is_none());
        assert_eq!(
            normalize_archive_member_path(Path::new("safe/bin/llama-server"))
                .unwrap()
                .to_string_lossy()
                .replace("\\", "/"),
            "safe/bin/llama-server"
        );
    }

    #[test]
    fn select_release_asset_uses_platform_pattern() {
        let patterns = release_asset_patterns("auto");
        let expected_pattern = patterns
            .first()
            .cloned()
            .expect("at least one pattern should exist");
        let release = GithubRelease {
            tag_name: "b9999".to_string(),
            body: None,
            assets: vec![
                GithubReleaseAsset {
                    name: "llama-b9999-bin-unrelated.zip".to_string(),
                    browser_download_url: "https://example.invalid/unrelated.zip".to_string(),
                    size: Some(1),
                    digest: None,
                },
                GithubReleaseAsset {
                    name: format!("llama-b9999-bin-{}", expected_pattern),
                    browser_download_url: "https://example.invalid/matched.zip".to_string(),
                    size: Some(2),
                    digest: Some("sha256:".to_string() + &"a".repeat(64)),
                },
            ],
        };

        let selected = select_release_asset(&release, "auto");
        assert!(selected.is_some());
        let (_, asset) = selected.expect("asset should be selected");
        assert!(asset.name.contains(&expected_pattern));
    }

    #[test]
    fn select_release_asset_returns_none_when_not_found() {
        let release = GithubRelease {
            tag_name: "b9999".to_string(),
            body: None,
            assets: vec![GithubReleaseAsset {
                name: "llama-b9999-bin-other.zip".to_string(),
                browser_download_url: "https://example.invalid/other.zip".to_string(),
                size: Some(1),
                digest: None,
            }],
        };

        let selected = select_release_asset(&release, "auto");
        assert!(selected.is_none());
    }

    #[test]
    fn build_target_models_uses_valid_payload_entries_only() {
        let payload = Some(vec![
            json!({ "repo_id": "", "filename": "a.gguf" }),
            json!({ "repo_id": "owner/model", "filename": "", "role": "text" }),
            json!({
                "repo_id": "owner/model",
                "filename": "model.gguf",
                "role": "embedding",
                "displayName": "Embedding Model",
                "revision": "  refs/pr/1  ",
                "sha256": "  abcdef  "
            }),
        ]);
        let config = json!({});

        let models = build_target_models(payload, &config);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].repo_id, "owner/model");
        assert_eq!(models[0].filename, "model.gguf");
        assert_eq!(models[0].role, "embedding");
        assert_eq!(models[0].display_name, "Embedding Model");
        assert_eq!(models[0].revision.as_deref(), Some("refs/pr/1"));
        assert_eq!(models[0].sha256.as_deref(), Some("abcdef"));
    }

    #[test]
    fn build_target_models_falls_back_to_defaults_when_payload_invalid() {
        let payload = Some(vec![json!({ "repo_id": "", "filename": "" })]);
        let config = json!({
            "default_models": {
                "text_models": [
                    { "repo_id": "owner/text", "filename": "text.gguf" }
                ],
                "embedding": {
                    "repo_id": "owner/embed",
                    "filename": "embed.gguf"
                }
            }
        });

        let models = build_target_models(payload, &config);
        assert_eq!(models.len(), 2);
        assert!(models
            .iter()
            .any(|m| m.repo_id == "owner/text" && m.role == "text"));
        assert!(models
            .iter()
            .any(|m| m.repo_id == "owner/embed" && m.role == "embedding"));
    }

    #[test]
    fn collect_default_models_trims_revision_and_sha() {
        let config = json!({
            "default_models": {
                "text_models": [
                    {
                        "repo_id": "owner/text",
                        "filename": "text.gguf",
                        "revision": "  main  ",
                        "sha256": "  deadbeef  "
                    }
                ],
                "embedding": {
                    "repo_id": "owner/embed",
                    "filename": "embed.gguf",
                    "revision": "  refs/pr/2  ",
                    "sha256": "  cafebabe  "
                }
            }
        });

        let models = collect_default_models(&config);
        assert_eq!(models.len(), 2);

        let text = models
            .iter()
            .find(|m| m.role == "text")
            .expect("text model should exist");
        assert_eq!(text.revision.as_deref(), Some("main"));
        assert_eq!(text.sha256.as_deref(), Some("deadbeef"));

        let embedding = models
            .iter()
            .find(|m| m.role == "embedding")
            .expect("embedding model should exist");
        assert_eq!(embedding.revision.as_deref(), Some("refs/pr/2"));
        assert_eq!(embedding.sha256.as_deref(), Some("cafebabe"));
    }

    #[test]
    fn cleanup_expired_consents_removes_only_expired_entries() {
        let expired = PendingConsent {
            payload: json!({}),
            expires_at: Utc::now() - ChronoDuration::seconds(1),
            request: McpInstallPreviewRequest {
                server_id: "expired".to_string(),
                runtime: None,
                env_values: None,
                server_name: None,
            },
            server: McpRegistryServer {
                id: "expired".to_string(),
                name: "expired".to_string(),
                title: None,
                description: None,
                version: None,
                vendor: None,
                source_url: None,
                homepage: None,
                website_url: None,
                license: None,
                packages: Vec::new(),
                environment_variables: Vec::new(),
                icon: None,
                category: None,
            },
        };
        let alive = PendingConsent {
            payload: json!({}),
            expires_at: Utc::now() + ChronoDuration::seconds(60),
            request: McpInstallPreviewRequest {
                server_id: "alive".to_string(),
                runtime: None,
                env_values: None,
                server_name: None,
            },
            server: McpRegistryServer {
                id: "alive".to_string(),
                name: "alive".to_string(),
                title: None,
                description: None,
                version: None,
                vendor: None,
                source_url: None,
                homepage: None,
                website_url: None,
                license: None,
                packages: Vec::new(),
                environment_variables: Vec::new(),
                icon: None,
                category: None,
            },
        };

        let mut store = HashMap::new();
        store.insert("expired".to_string(), expired);
        store.insert("alive".to_string(), alive);

        cleanup_expired_consents_locked(&mut store);

        assert!(!store.contains_key("expired"));
        assert!(store.contains_key("alive"));
    }

    #[test]
    fn resolve_allowed_origins_defaults_when_not_configured() {
        let config = json!({});
        let resolved = resolve_allowed_origins(&config);
        assert_eq!(resolved, default_local_origins());
    }

    #[test]
    fn resolve_allowed_origins_trims_and_filters_values() {
        let config = json!({
            "server": {
                "cors_allowed_origins": [
                    "  http://localhost:5173  ",
                    "",
                    "https://tauri.localhost"
                ]
            }
        });
        let resolved = resolve_allowed_origins(&config);
        assert_eq!(
            resolved,
            vec![
                "http://localhost:5173".to_string(),
                "https://tauri.localhost".to_string()
            ]
        );
    }

    #[test]
    fn ensure_object_path_creates_nested_structure() {
        let mut config = json!({});
        ensure_object_path(&mut config, &["llm_manager", "loader"], json!("llama_cpp"));
        assert_eq!(
            config
                .get("llm_manager")
                .and_then(|v| v.get("loader"))
                .and_then(|v| v.as_str()),
            Some("llama_cpp")
        );
    }

    #[test]
    fn merge_objects_overlays_top_level_keys() {
        let base = json!({
            "a": 1,
            "b": {"x": true}
        });
        let overlay = json!({
            "b": 2,
            "c": 3
        });

        let merged = merge_objects(base, overlay);
        assert_eq!(merged.get("a").and_then(|v| v.as_i64()), Some(1));
        assert_eq!(merged.get("b").and_then(|v| v.as_i64()), Some(2));
        assert_eq!(merged.get("c").and_then(|v| v.as_i64()), Some(3));
    }

    #[test]
    fn absolutize_mcp_path_converts_relative_path() {
        let root = temp_test_dir("mcp_path_rel");
        let paths = make_app_paths(&root);
        let mut config = json!({
            "app": {
                "mcp_config_path": "config/mcp.json"
            }
        });

        absolutize_mcp_path(&mut config, &paths);

        let value = config
            .get("app")
            .and_then(|v| v.get("mcp_config_path"))
            .and_then(|v| v.as_str())
            .expect("mcp_config_path should be present");
        assert!(value.starts_with(paths.user_data_dir.to_string_lossy().as_ref() as &str));

        cleanup_test_dir(&root);
    }

    #[test]
    fn absolutize_mcp_path_keeps_absolute_path() {
        let root = temp_test_dir("mcp_path_abs");
        let paths = make_app_paths(&root);
        let absolute = root.join("already").join("mcp.json");
        let mut config = json!({
            "app": {
                "mcp_config_path": absolute.to_string_lossy().to_string()
            }
        });

        absolutize_mcp_path(&mut config, &paths);

        let value = config
            .get("app")
            .and_then(|v| v.get("mcp_config_path"))
            .and_then(|v| v.as_str())
            .expect("mcp_config_path should be present");
        assert_eq!(value, absolute.to_string_lossy());

        cleanup_test_dir(&root);
    }

    #[test]
    fn resolve_model_path_prefers_user_then_project_then_default_user_candidate() {
        let root = temp_test_dir("resolve_model_path");
        let paths = make_app_paths(&root);
        let rel = PathBuf::from("models").join("test.gguf");

        // user data path takes precedence
        let user_file = paths.user_data_dir.join(&rel);
        if let Some(parent) = user_file.parent() {
            fs::create_dir_all(parent).expect("user parent dir should be created");
        }
        fs::write(&user_file, b"user").expect("user file should be written");
        let resolved_user = resolve_model_path(rel.to_string_lossy().as_ref(), &paths);
        assert_eq!(resolved_user, user_file);

        // fallback to project root when user file doesn't exist
        fs::remove_file(&user_file).expect("user file should be removed");
        let project_file = paths.project_root.join(&rel);
        if let Some(parent) = project_file.parent() {
            fs::create_dir_all(parent).expect("project parent dir should be created");
        }
        fs::write(&project_file, b"project").expect("project file should be written");
        let resolved_project = resolve_model_path(rel.to_string_lossy().as_ref(), &paths);
        assert_eq!(resolved_project, project_file);

        // fallback result is user candidate when nothing exists
        fs::remove_file(&project_file).expect("project file should be removed");
        let resolved_default = resolve_model_path(rel.to_string_lossy().as_ref(), &paths);
        assert_eq!(resolved_default, paths.user_data_dir.join(&rel));

        cleanup_test_dir(&root);
    }

    fn temp_test_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("tepora-api-test-{}-{}", label, Uuid::new_v4()))
    }

    fn cleanup_test_dir(path: &PathBuf) {
        let _ = fs::remove_dir_all(path);
    }

    fn make_app_paths(root: &PathBuf) -> AppPaths {
        let project_root = root.join("project");
        let user_data_dir = root.join("data");
        let log_dir = user_data_dir.join("logs");
        let db_path = user_data_dir.join("tepora_core.db");
        let secrets_path = user_data_dir.join("secrets.yaml");

        fs::create_dir_all(&project_root).expect("project root should be created");
        fs::create_dir_all(&user_data_dir).expect("user data dir should be created");
        fs::create_dir_all(&log_dir).expect("log dir should be created");

        AppPaths {
            project_root,
            user_data_dir,
            log_dir,
            db_path,
            secrets_path,
        }
    }
}
