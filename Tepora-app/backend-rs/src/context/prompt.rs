use serde_json::Value;

pub fn extract_system_prompt(config: &Value) -> Option<String> {
    let active = config
        .get("active_agent_profile")
        .and_then(|v| v.as_str())
        .unwrap_or("bunny_girl");
    config
        .get("characters")
        .and_then(|v| v.get(active))
        .and_then(|v| v.get("system_prompt").or_else(|| v.get("prompt")))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}
