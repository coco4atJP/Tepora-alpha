use axum::http::{header, HeaderValue, Method};
use axum::routing::{delete, get, post};
use axum::Router;
use serde_json::Value;
use std::sync::Arc;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::server::handlers::{agents, config, health, logs, mcp, sessions, setup, tools};
use crate::server::ws::handler::ws_handler;
use crate::state::AppState;

/// Creates the main application router with all routes and middleware.
///
/// This function sets up:
/// - CORS middleware
/// - Health check endpoints
/// - API endpoints (config, logs, sessions, custom agents, tools, setup, mcp)
/// - WebSocket handler
///
/// # Arguments
///
/// * `state` - Shared application state
pub fn router(state: Arc<AppState>) -> Router {
    let cors_layer = build_cors_layer(&state);
    Router::new()
        .route("/health", get(health::health))
        .route("/api/status", get(health::get_status))
        .route("/api/shutdown", post(health::shutdown))
        .route(
            "/api/config",
            get(config::get_config)
                .post(config::update_config)
                .patch(config::patch_config),
        )
        .route("/api/logs", get(logs::get_logs))
        .route("/api/logs/:filename", get(logs::get_log_content))
        .route(
            "/api/sessions",
            get(sessions::list_sessions).post(sessions::create_session),
        )
        .route(
            "/api/sessions/:session_id",
            get(sessions::get_session)
                .patch(sessions::update_session)
                .delete(sessions::delete_session),
        )
        .route(
            "/api/sessions/:session_id/messages",
            get(sessions::get_session_messages),
        )
        .route(
            "/api/custom-agents",
            get(agents::list_custom_agents).post(agents::create_custom_agent),
        )
        .route(
            "/api/custom-agents/:agent_id",
            get(agents::get_custom_agent)
                .put(agents::update_custom_agent)
                .delete(agents::delete_custom_agent),
        )
        .route("/api/tools", get(tools::list_tools))
        .route("/api/setup/requirements", get(setup::setup_requirements))
        .route(
            "/api/setup/default-models",
            get(setup::setup_default_models),
        )
        .route("/api/setup/init", post(setup::setup_init))
        .route("/api/setup/preflight", post(setup::setup_preflight))
        .route("/api/setup/run", post(setup::setup_run))
        .route("/api/setup/progress", get(setup::setup_progress))
        .route("/api/setup/finish", post(setup::setup_finish))
        .route("/api/setup/models", get(setup::setup_models))
        .route("/api/setup/model/roles", get(setup::setup_model_roles))
        .route(
            "/api/setup/model/roles/character",
            post(setup::setup_set_character_role),
        )
        .route(
            "/api/setup/model/roles/character/:character_id",
            post(setup::setup_set_character_specific_role)
                .delete(setup::setup_delete_character_specific_role),
        )
        .route(
            "/api/setup/model/roles/agent/:agent_id",
            post(setup::setup_set_agent_role).delete(setup::setup_delete_agent_role),
        )
        .route(
            "/api/setup/model/roles/professional",
            post(setup::setup_set_professional_role),
        )
        .route(
            "/api/setup/model/roles/professional/:task_type",
            delete(setup::setup_delete_professional_role),
        )
        .route(
            "/api/setup/model/active",
            post(setup::setup_set_active_model),
        )
        .route(
            "/api/setup/model/reorder",
            post(setup::setup_reorder_models),
        )
        .route("/api/setup/model/check", post(setup::setup_check_model))
        .route(
            "/api/setup/model/download",
            post(setup::setup_download_model),
        )
        .route(
            "/api/setup/model/local",
            post(setup::setup_register_local_model),
        )
        .route(
            "/api/setup/model/:model_id",
            delete(setup::setup_delete_model),
        )
        .route(
            "/api/setup/models/ollama/refresh",
            post(setup::setup_refresh_ollama_models),
        )
        .route(
            "/api/setup/models/lmstudio/refresh",
            post(setup::setup_refresh_lmstudio_models),
        )
        .route(
            "/api/setup/model/update-check",
            get(setup::setup_model_update_check),
        )
        .route(
            "/api/setup/binary/update-info",
            get(setup::setup_binary_update_info),
        )
        .route("/api/setup/binary/update", post(setup::setup_binary_update))
        .route("/api/mcp/status", get(mcp::mcp_status))
        .route(
            "/api/mcp/config",
            get(mcp::mcp_config).post(mcp::mcp_update_config),
        )
        .route("/api/mcp/store", get(mcp::mcp_store))
        .route("/api/mcp/install/preview", post(mcp::mcp_install_preview))
        .route("/api/mcp/install/confirm", post(mcp::mcp_install_confirm))
        .route(
            "/api/mcp/servers/:server_name/approve",
            post(mcp::mcp_approve_server),
        )
        .route(
            "/api/mcp/servers/:server_name/revoke",
            post(mcp::mcp_revoke_server),
        )
        .route(
            "/api/mcp/servers/:server_name/enable",
            post(mcp::mcp_enable_server),
        )
        .route(
            "/api/mcp/servers/:server_name/disable",
            post(mcp::mcp_disable_server),
        )
        .route(
            "/api/mcp/servers/:server_name",
            delete(mcp::mcp_delete_server),
        )
        .route(
            "/api/mcp/policy",
            get(mcp::mcp_policy).patch(mcp::mcp_update_policy),
        )
        .route("/ws", get(ws_handler))
        .with_state(state)
        .layer(cors_layer)
        .layer(TraceLayer::new_for_http())
}

fn build_cors_layer(state: &Arc<AppState>) -> CorsLayer {
    let config = match state.config.load_config() {
        Ok(value) => value,
        Err(err) => {
            tracing::warn!(
                "Failed to load config while building CORS layer: {}; using local defaults",
                err
            );
            Value::Null
        }
    };
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
