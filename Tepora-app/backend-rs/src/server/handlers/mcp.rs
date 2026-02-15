use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::Json;
use chrono::{Duration as ChronoDuration, Utc};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use uuid::Uuid;

use crate::core::errors::ApiError;
use crate::core::security::require_api_key;
use crate::mcp::installer as mcp_installer;
use crate::mcp::registry::McpRegistryServer;
use crate::state::AppState;

#[derive(Debug, Deserialize, Default)]
pub struct McpStoreQuery {
    pub search: Option<String>,
    pub page: Option<i64>,
    #[serde(rename = "page_size")]
    pub page_size: Option<i64>,
    pub runtime: Option<String>,
    pub refresh: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct McpInstallPreviewRequest {
    pub server_id: String,
    pub runtime: Option<String>,
    #[serde(default)]
    pub env_values: Option<HashMap<String, String>>,
    pub server_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct McpInstallConfirmRequest {
    pub consent_id: String,
}

#[derive(Debug, Deserialize)]
pub struct McpApproveRequest {
    pub transport_types: Option<Vec<String>>,
}

pub struct PendingConsent {
    #[allow(dead_code)]
    pub payload: Value,
    pub expires_at: chrono::DateTime<Utc>,
    pub request: McpInstallPreviewRequest,
    pub server: McpRegistryServer,
}

static MCP_PENDING_CONSENTS: OnceLock<Mutex<HashMap<String, PendingConsent>>> = OnceLock::new();
const MCP_CONSENT_TTL_SECS: i64 = 300;

fn pending_consents() -> &'static Mutex<HashMap<String, PendingConsent>> {
    MCP_PENDING_CONSENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cleanup_expired_consents_locked(store: &mut HashMap<String, PendingConsent>) {
    let now = Utc::now();
    store.retain(|_, consent| consent.expires_at > now);
}

pub async fn mcp_status(
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

pub async fn mcp_config(
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

pub async fn mcp_update_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    state.mcp.update_config(&payload).await?;
    Ok(Json(json!({"success": true})))
}

pub async fn mcp_store(
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
                .map(|pkg: &crate::mcp::registry::McpRegistryPackage| {
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

pub async fn mcp_install_preview(
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

pub async fn mcp_install_confirm(
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

pub async fn mcp_approve_server(
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

pub async fn mcp_revoke_server(
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

pub async fn mcp_enable_server(
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

pub async fn mcp_disable_server(
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

pub async fn mcp_delete_server(
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

pub async fn mcp_policy(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let policy = state.mcp.load_policy()?;
    Ok(Json(policy))
}

pub async fn mcp_update_policy(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    require_api_key(&headers, &state.session_token)?;
    let policy = state.mcp.update_policy(&payload)?;
    Ok(Json(json!({"success": true, "policy": policy})))
}
