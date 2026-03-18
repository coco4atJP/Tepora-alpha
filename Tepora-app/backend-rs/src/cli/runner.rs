use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::Value;
use tokio::process::Command;

use crate::core::errors::ApiError;
use crate::tools::dispatcher::ToolExecution;

use super::types::{CliJsonMode, CliProfileConfig, CliToolInput};

pub async fn execute_cli_profile(
    workspace_root: &Path,
    profile_name: &str,
    profile: &CliProfileConfig,
    input: CliToolInput,
) -> Result<ToolExecution, ApiError> {
    let reason = input.reason.clone();
    validate_prefix(profile_name, profile, &input.args)?;
    let cwd = resolve_cwd(workspace_root, profile_name, profile, input.cwd.as_deref())?;

    let resolved_bin = which::which(&profile.bin).unwrap_or_else(|_| PathBuf::from(&profile.bin));
    let mut command = Command::new(resolved_bin);
    command.args(&input.args);
    command.args(&profile.default_args);
    if let Some(json_mode) = profile.json_mode.as_ref() {
        append_json_flags(&mut command, json_mode);
    }
    command.current_dir(cwd);
    command.env_clear();
    for key in &profile.env_allowlist {
        if let Ok(value) = std::env::var(key) {
            command.env(key, value);
        }
    }

    let started = Instant::now();
    let output = tokio::time::timeout(
        std::time::Duration::from_millis(profile.timeout_ms),
        command.output(),
    )
    .await
    .map_err(|_| {
        ApiError::ServiceUnavailable(format!(
            "CLI profile `{}` timed out after {} ms",
            profile_name, profile.timeout_ms
        ))
    })?
    .map_err(ApiError::internal)?;

    let duration_ms = started.elapsed().as_millis() as u64;
    let stdout_raw = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr_raw = String::from_utf8_lossy(&output.stderr).to_string();
    let (stdout, stdout_truncated) = truncate_text(&stdout_raw, profile.max_output_bytes);
    let (stderr, stderr_truncated) = truncate_text(&stderr_raw, profile.max_output_bytes);
    let truncated = stdout_truncated || stderr_truncated;
    let structured_output = parse_structured_output(profile.json_mode.as_ref(), &stdout);
    let exit_code = output.status.code();

    if !output.status.success() {
        return Err(ApiError::BadRequest(format!(
            "CLI profile `{}` failed with exit code {:?}: {}",
            profile_name,
            exit_code,
            summarize_for_error(&stderr, &stdout)
        )));
    }

    let output_text = build_output_text(
        profile_name,
        duration_ms,
        exit_code,
        &stdout,
        &stderr,
        structured_output.as_ref(),
        truncated,
        reason.as_deref(),
    );

    Ok(ToolExecution::cli(
        output_text,
        stdout,
        stderr,
        exit_code,
        duration_ms,
        truncated,
        structured_output,
    ))
}

fn append_json_flags(command: &mut Command, json_mode: &CliJsonMode) {
    if json_mode.strategy == "append_flags" {
        command.args(&json_mode.flags);
    }
}

fn validate_prefix(
    profile_name: &str,
    profile: &CliProfileConfig,
    args: &[String],
) -> Result<(), ApiError> {
    if args.is_empty() {
        return Err(ApiError::BadRequest(format!(
            "CLI profile `{}` requires at least one argument",
            profile_name
        )));
    }
    let allowed = profile
        .allowed_prefixes
        .iter()
        .any(|prefix| !prefix.is_empty() && args.starts_with(prefix));
    if !allowed {
        return Err(ApiError::Forbidden);
    }
    Ok(())
}

fn resolve_cwd(
    workspace_root: &Path,
    profile_name: &str,
    profile: &CliProfileConfig,
    requested_cwd: Option<&str>,
) -> Result<PathBuf, ApiError> {
    match profile.cwd_policy.mode.as_str() {
        "workspace" => {
            let requested = requested_cwd.unwrap_or(".");
            let candidate = if Path::new(requested).is_absolute() {
                PathBuf::from(requested)
            } else {
                workspace_root.join(requested)
            };
            let canonical = candidate.canonicalize().map_err(|_| {
                ApiError::BadRequest(format!(
                    "CLI profile `{}` received an invalid cwd: {}",
                    profile_name, requested
                ))
            })?;
            let canonical_root = workspace_root.canonicalize().map_err(ApiError::internal)?;
            if !canonical.starts_with(&canonical_root) {
                return Err(ApiError::Forbidden);
            }
            Ok(canonical)
        }
        "fixed" => {
            let fixed_path = profile.cwd_policy.path.as_deref().ok_or_else(|| {
                ApiError::BadRequest(format!(
                    "CLI profile `{}` is missing cwd_policy.path for fixed mode",
                    profile_name
                ))
            })?;
            let fixed = PathBuf::from(fixed_path)
                .canonicalize()
                .map_err(ApiError::internal)?;
            if let Some(requested) = requested_cwd {
                let requested_path = PathBuf::from(requested)
                    .canonicalize()
                    .map_err(ApiError::internal)?;
                if requested_path != fixed {
                    return Err(ApiError::Forbidden);
                }
            }
            Ok(fixed)
        }
        other => Err(ApiError::BadRequest(format!(
            "CLI profile `{}` uses unsupported cwd policy `{}`",
            profile_name, other
        ))),
    }
}

fn truncate_text(text: &str, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text.to_string(), false);
    }
    let mut truncated = text[..limit].to_string();
    truncated.push_str("\n...[truncated]");
    (truncated, true)
}

fn parse_structured_output(json_mode: Option<&CliJsonMode>, stdout: &str) -> Option<Value> {
    let _ = json_mode?;
    serde_json::from_str(stdout).ok()
}

fn build_output_text(
    profile_name: &str,
    duration_ms: u64,
    exit_code: Option<i32>,
    stdout: &str,
    stderr: &str,
    structured_output: Option<&Value>,
    truncated: bool,
    reason: Option<&str>,
) -> String {
    let mut parts = vec![format!(
        "CLI profile `{}` completed in {} ms (exit code {:?}).",
        profile_name, duration_ms, exit_code
    )];
    if let Some(reason) = reason.filter(|value| !value.trim().is_empty()) {
        parts.push(format!("Reason: {}", reason.trim()));
    }
    if let Some(value) = structured_output {
        let pretty = serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string());
        parts.push(format!("Structured output:\n{}", pretty));
    } else if !stdout.trim().is_empty() {
        parts.push(format!("stdout:\n{}", stdout.trim()));
    }
    if !stderr.trim().is_empty() {
        parts.push(format!("stderr:\n{}", stderr.trim()));
    }
    if truncated {
        parts.push("Output was truncated to fit safety limits.".to_string());
    }
    parts.join("\n\n")
}

fn summarize_for_error(stderr: &str, stdout: &str) -> String {
    let preferred = if !stderr.trim().is_empty() {
        stderr
    } else {
        stdout
    };
    preferred
        .lines()
        .next()
        .unwrap_or("command returned no output")
        .to_string()
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use std::fs;
    use tempfile::tempdir;

    use super::*;

    fn test_profile(script_path: &str) -> CliProfileConfig {
        CliProfileConfig {
            enabled: true,
            bin: "/bin/sh".to_string(),
            description: "test".to_string(),
            allowed_prefixes: vec![vec![script_path.to_string(), "query".to_string()]],
            default_args: vec![],
            json_mode: Some(CliJsonMode {
                strategy: "append_flags".to_string(),
                flags: vec!["--json".to_string()],
            }),
            cwd_policy: super::super::types::CliCwdPolicy {
                mode: "workspace".to_string(),
                path: None,
            },
            env_allowlist: vec![],
            timeout_ms: 5_000,
            risk_level: crate::core::security_controls::PermissionRiskLevel::Medium,
            max_output_bytes: 2048,
        }
    }

    #[tokio::test]
    async fn executes_profile_and_parses_json_output() {
        let dir = tempdir().unwrap();
        let script_path = dir.path().join("echo-json.sh");
        fs::write(
            &script_path,
            "#!/bin/sh\nprintf '{\"ok\":true,\"args\":[\"%s\"]}' \"$1\"\n",
        )
        .unwrap();

        let mut perms = fs::metadata(&script_path).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            perms.set_mode(0o755);
            fs::set_permissions(&script_path, perms).unwrap();
        }

        let profile = test_profile(script_path.to_str().unwrap());
        let execution = execute_cli_profile(
            dir.path(),
            "test_profile",
            &profile,
            CliToolInput {
                args: vec![
                    script_path.to_string_lossy().to_string(),
                    "query".to_string(),
                ],
                cwd: Some(".".to_string()),
                reason: None,
            },
        )
        .await
        .unwrap();

        assert_eq!(
            execution.structured_output,
            Some(json!({"ok": true, "args": ["query"]}))
        );
    }

    #[tokio::test]
    async fn rejects_disallowed_prefix() {
        let profile = CliProfileConfig {
            enabled: true,
            bin: "/bin/echo".to_string(),
            description: "echo".to_string(),
            allowed_prefixes: vec![vec!["safe".to_string()]],
            default_args: vec![],
            json_mode: None,
            cwd_policy: super::super::types::CliCwdPolicy::default(),
            env_allowlist: vec![],
            timeout_ms: 1_000,
            risk_level: crate::core::security_controls::PermissionRiskLevel::Low,
            max_output_bytes: 2048,
        };

        let err = execute_cli_profile(
            Path::new("/tmp"),
            "echo_profile",
            &profile,
            CliToolInput {
                args: vec!["unsafe".to_string()],
                cwd: None,
                reason: None,
            },
        )
        .await
        .unwrap_err();

        assert!(matches!(err, ApiError::Forbidden));
    }
}
