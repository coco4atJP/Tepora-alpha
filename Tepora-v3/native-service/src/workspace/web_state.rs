//! Atomic read of the web settings and selected credential on the existing
//! Workspace connection. This module never exposes secret events or public JSON.
use super::*;
use crate::agent::{
    web::{SecretSnapshot, WebConfig},
    web_host::{WebSnapshot, WebState},
};
impl WebState for WorkspaceAccess {
    fn web_snapshot(&self) -> Result<WebSnapshot, ApiError> {
        let mut state = self.lock()?;
        require(!state.closed && !state.closing, 503, "Service closing")?;
        let settings = state.agent_settings()?;
        let keys = state.value("search-keys")?;
        let config = WebConfig::from_value(&settings["webSearch"]).map_err(|e| {
            ApiError::new(
                e.error["status"].as_u64().unwrap_or(400) as u16,
                e.error["message"]
                    .as_str()
                    .unwrap_or("Invalid web search settings"),
            )
        })?;
        let saved = keys
            .get("brave")
            .filter(|key| tepora_core::js_value::truthy(key))
            .map(|key| tepora_core::js_value::js_string(Some(key)));
        let key = saved.unwrap_or_else(|| {
            std::env::var(json_codec::sql_text(&config.brave_key_env))
                .ok()
                .map(|s| json_codec::encode_text(&s))
                .unwrap_or_default()
        });
        let mut selected = SecretSnapshot::new(key);
        let provider = config.provider.as_str();
        if ["tavily", "exa", "serper", "serpapi"].contains(&provider) {
            let key = keys
                .get(provider)
                .filter(|key| tepora_core::js_value::truthy(key))
                .map(|key| tepora_core::js_value::js_string(Some(key)))
                .unwrap_or_else(|| {
                    std::env::var(json_codec::sql_text(config.key_env(provider)))
                        .ok()
                        .map(|s| json_codec::encode_text(&s))
                        .unwrap_or_default()
                });
            selected = selected.with_key(provider, key);
        }
        Ok(WebSnapshot::with_keys(config, selected))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_and_selected_saved_key_share_the_existing_connection_snapshot() {
        let dir = env::temp_dir().join(format!("tepora-web-state-{}", Uuid::new_v4()));
        let workspace = Workspace::open(&dir).unwrap();
        let access = workspace.access();
        // A unique absent variable keeps this test independent of real secrets,
        // and avoids mutating the process environment during parallel tests.
        let env_name = format!("TEPORA_WEB_FIXTURE_{}", Uuid::new_v4().simple());
        let config = WebConfig {
            provider: "searxng".into(),
            searxng_url: "https://fixture.test/".into(),
            brave_key_env: env_name.clone(),
            ..WebConfig::default()
        };
        {
            let mut state = workspace.lock().unwrap();
            state.set_value("agent-settings", json!({"webSearch":{"provider":"searxng","searxngUrl":"https://fixture.test/","braveKeyEnv":env_name}})).unwrap();
            state
                .set_value(
                    "search-keys",
                    json!({"brave":"fixture-saved-key","unrelated":"fixture-never-selected"}),
                )
                .unwrap();
        }
        assert!(
            access.web_snapshot().unwrap()
                == WebSnapshot::new(config.clone(), "fixture-saved-key".into())
        );
        workspace
            .lock()
            .unwrap()
            .set_value("search-keys", json!({"brave":""}))
            .unwrap();
        assert!(access.web_snapshot().unwrap() == WebSnapshot::new(config, String::new()));
        workspace.shutdown().unwrap();
        assert_eq!(access.web_snapshot().err().unwrap().status, 503);
        drop(access);
        drop(workspace);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn only_selected_additional_key_is_snapshotted_and_rotation_changes_binding() {
        let dir = env::temp_dir().join(format!("tepora-web-key-state-{}", Uuid::new_v4()));
        let workspace = Workspace::open(&dir).unwrap();
        let access = workspace.access();
        let absent = format!("TEPORA_WEB_ABSENT_{}", Uuid::new_v4().simple());
        for provider in ["tavily", "exa", "serper", "serpapi"] {
            let config =
                WebConfig::from_value(&json!({"provider":provider,"braveKeyEnv":absent})).unwrap();
            {
                let mut state = workspace.lock().unwrap();
                state
                    .set_value(
                        "agent-settings",
                        json!({"webSearch":{"provider":provider,"braveKeyEnv":absent}}),
                    )
                    .unwrap();
                state
                    .set_value(
                        "search-keys",
                        json!({(provider):"fixture-selected-key","unrelated":"fixture-hidden-key"}),
                    )
                    .unwrap();
            }
            assert!(
                access.web_snapshot().unwrap()
                    == WebSnapshot::with_keys(
                        config.clone(),
                        SecretSnapshot::default().with_key(provider, "fixture-selected-key".into())
                    )
            );
            workspace
                .lock()
                .unwrap()
                .set_value("search-keys", json!({(provider):"fixture-rotated-key"}))
                .unwrap();
            assert!(
                access.web_snapshot().unwrap()
                    == WebSnapshot::with_keys(
                        config,
                        SecretSnapshot::default().with_key(provider, "fixture-rotated-key".into())
                    )
            );
        }
        workspace.shutdown().unwrap();
        drop(access);
        drop(workspace);
        fs::remove_dir_all(dir).unwrap();
    }
}
