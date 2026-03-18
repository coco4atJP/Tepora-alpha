use std::sync::Arc;

use serde_json::Value;

use crate::core::config::{AppPaths, ConfigService};
use crate::core::errors::ApiError;
use crate::core::security_controls::PermissionRiskLevel;
use crate::tools::dispatcher::ToolExecution;

use super::runner::execute_cli_profile;
use super::types::{cli_tool_input_schema, CliProfilesConfig, CliToolInfo, CliToolInput};

#[derive(Clone)]
pub struct CliProfileManager {
    #[allow(dead_code)]
    paths: Arc<AppPaths>,
    config_service: ConfigService,
}

impl CliProfileManager {
    pub fn new(paths: Arc<AppPaths>, config_service: ConfigService) -> Self {
        Self {
            paths,
            config_service,
        }
    }

    pub async fn list_tools(&self) -> Vec<CliToolInfo> {
        self.load_profiles()
            .map(|profiles| {
                profiles
                    .cli_profiles
                    .into_iter()
                    .filter(|(_, profile)| profile.enabled)
                    .map(|(profile_name, profile)| CliToolInfo {
                        name: format!("cli:{}", profile_name),
                        description: profile.description,
                        input_schema: cli_tool_input_schema(),
                        risk_level: profile.risk_level,
                        profile_name,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub async fn risk_level_for_tool(&self, tool_name: &str) -> Option<PermissionRiskLevel> {
        let profile_name = tool_name.strip_prefix("cli:")?;
        let profiles = self.load_profiles().ok()?;
        profiles
            .cli_profiles
            .get(profile_name)
            .filter(|profile| profile.enabled)
            .map(|profile| profile.risk_level)
    }

    pub async fn execute_tool(
        &self,
        tool_name: &str,
        args: &Value,
    ) -> Result<ToolExecution, ApiError> {
        let profile_name = tool_name
            .strip_prefix("cli:")
            .ok_or_else(|| ApiError::BadRequest(format!("Unknown CLI tool `{}`", tool_name)))?;
        let profiles = self.load_profiles()?;
        let profile = profiles
            .cli_profiles
            .get(profile_name)
            .filter(|profile| profile.enabled)
            .cloned()
            .ok_or_else(|| ApiError::NotFound(format!("CLI profile `{}`", profile_name)))?;
        let input: CliToolInput = serde_json::from_value(args.clone())
            .map_err(|err| ApiError::BadRequest(format!("Invalid CLI tool input: {}", err)))?;
        execute_cli_profile(&self.paths.project_root, profile_name, &profile, input).await
    }

    fn load_profiles(&self) -> Result<CliProfilesConfig, ApiError> {
        let config = self.config_service.load_config()?;
        let cli_profiles = config
            .get("cli_profiles")
            .cloned()
            .unwrap_or_else(|| Value::Object(Default::default()));
        serde_json::from_value::<std::collections::HashMap<String, super::types::CliProfileConfig>>(
            cli_profiles,
        )
        .map(|cli_profiles| CliProfilesConfig { cli_profiles })
        .map_err(|err| ApiError::BadRequest(format!("Invalid cli_profiles config: {}", err)))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;

    use tempfile::tempdir;

    use super::*;

    #[tokio::test]
    async fn lists_enabled_cli_profiles_as_tools() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path()).unwrap();
        fs::write(
            dir.path().join("config.yml"),
            r#"
cli_profiles:
  github_search:
    enabled: true
    bin: gh
    description: Search GitHub
    allowed_prefixes:
      - ["search", "issues"]
"#,
        )
        .unwrap();

        let paths = Arc::new(AppPaths {
            project_root: dir.path().to_path_buf(),
            user_data_dir: dir.path().join("data"),
            log_dir: dir.path().join("logs"),
            db_path: dir.path().join("db.sqlite"),
            secrets_path: dir.path().join("secrets.yaml"),
        });
        let manager = CliProfileManager::new(paths.clone(), ConfigService::new(paths));

        let tools = manager.list_tools().await;
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "cli:github_search");
        assert_eq!(tools[0].profile_name, "github_search");
    }
}
