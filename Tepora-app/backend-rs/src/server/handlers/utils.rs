use serde_json::{Value, Map};

pub fn ensure_object_path(config: &mut Value, path: &[&str], value: Value) {
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


use std::path::PathBuf;
use crate::core::config::AppPaths;

pub fn absolutize_mcp_path(config: &mut Value, paths: &AppPaths) {
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

pub fn resolve_model_path(raw: &str, paths: &AppPaths) -> PathBuf {
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
