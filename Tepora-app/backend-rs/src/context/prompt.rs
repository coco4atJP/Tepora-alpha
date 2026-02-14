use serde_json::Value;

pub fn extract_system_prompt(config: &Value) -> Option<String> {
    let active = config
        .get("active_agent_profile")
        .and_then(|v| v.as_str())
        .unwrap_or("bunny_girl");
    config
        .get("characters")
        .and_then(|v| v.get(active))
        .and_then(|v| v.get("system_prompt"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

pub fn extract_history_limit(config: &Value) -> i64 {
    config
        .get("chat_history")
        .and_then(|v| v.get("default_limit"))
        .and_then(|v| v.as_i64())
        .unwrap_or(40)
}
