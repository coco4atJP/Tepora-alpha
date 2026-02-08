use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use crate::errors::ApiError;
use crate::mcp::{McpServerConfig, McpServerMetadata};
use crate::mcp_registry::{McpEnvVar, McpRegistryPackage, McpRegistryServer};

pub fn normalize_server_key(raw: &str) -> String {
    if raw.trim().is_empty() {
        return "mcp_server".to_string();
    }

    let base = raw.split('/').last().unwrap_or(raw);
    let sanitized: String = base
        .chars()
        .map(|ch| if is_safe_key_char(ch) { ch } else { '_' })
        .collect();
    let trimmed = sanitized.trim_matches('_');
    if trimmed.is_empty() {
        "mcp_server".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn make_unique_key(base: &str, existing: &HashSet<String>) -> String {
    if !existing.contains(base) {
        return base.to_string();
    }
    let mut idx = 2;
    loop {
        let candidate = format!("{}_{}", base, idx);
        if !existing.contains(&candidate) {
            return candidate;
        }
        idx += 1;
    }
}

pub fn generate_consent_payload(
    server: &McpRegistryServer,
    runtime: Option<&str>,
    env_values: Option<&HashMap<String, String>>,
) -> Result<Value, ApiError> {
    let config = generate_config(server, runtime, env_values)?;

    let mut masked_env = HashMap::new();
    for (key, value) in config.env.iter() {
        let lower = key.to_lowercase();
        if lower.contains("key")
            || lower.contains("secret")
            || lower.contains("token")
            || lower.contains("password")
            || lower.contains("credential")
            || lower.contains("auth")
        {
            masked_env.insert(key.clone(), "***MASKED***".to_string());
        } else {
            masked_env.insert(key.clone(), value.clone());
        }
    }

    let full_command = preview_command(server, runtime, env_values)?;
    let warnings = generate_warnings(&config.command, &config.args);

    Ok(json!({
        "server_id": server.id,
        "server_name": server.name,
        "description": server.description,
        "command": config.command,
        "args": config.args,
        "env": masked_env,
        "full_command": full_command,
        "warnings": warnings,
        "requires_consent": true,
        "runtime": runtime.map(|v| v.to_string()).or_else(|| server.packages.first().and_then(|p| p.runtime_hint.clone()))
    }))
}

pub fn generate_config(
    server: &McpRegistryServer,
    runtime: Option<&str>,
    env_values: Option<&HashMap<String, String>>,
) -> Result<McpServerConfig, ApiError> {
    let package = find_package(&server.packages, runtime)
        .ok_or_else(|| ApiError::BadRequest("No suitable package found".to_string()))?;

    let (command, args) = generate_command(&package);

    let mut env = env_values.cloned().unwrap_or_default();
    for schema in &server.environment_variables {
        if !env.contains_key(&schema.name) {
            if let Some(default) = &schema.default {
                env.insert(schema.name.clone(), default.clone());
            }
        }
    }

    Ok(McpServerConfig {
        command,
        args,
        env,
        enabled: true,
        transport: "stdio".to_string(),
        url: None,
        metadata: Some(McpServerMetadata {
            name: Some(server.name.clone()),
            description: server.description.clone(),
            icon: server.icon.clone(),
        }),
    })
}

pub fn preview_command(
    server: &McpRegistryServer,
    runtime: Option<&str>,
    env_values: Option<&HashMap<String, String>>,
) -> Result<String, ApiError> {
    let config = generate_config(server, runtime, env_values)?;
    let mut parts = Vec::new();
    if !config.env.is_empty() {
        for (key, value) in &config.env {
            parts.push(format!("{}={}", key, value));
        }
    }
    parts.push(config.command);
    parts.extend(config.args);
    Ok(parts.join(" "))
}

#[allow(dead_code)]
pub fn extract_env_schema(server: &McpRegistryServer) -> Vec<McpEnvVar> {
    server.environment_variables.clone()
}

#[allow(dead_code)]
pub fn get_available_runtimes(server: &McpRegistryServer) -> Vec<String> {
    let mut runtimes = Vec::new();
    for pkg in &server.packages {
        if let Some(runtime) = &pkg.runtime_hint {
            if !runtimes.contains(runtime) {
                runtimes.push(runtime.clone());
            }
        }
    }
    runtimes
}

fn generate_warnings(command: &str, args: &[String]) -> Vec<String> {
    let mut warnings = Vec::new();
    let full_cmd = format!("{} {}", command, args.join(" ")).to_lowercase();

    if command.contains("docker") {
        warnings.push("Docker container execution - may have system access".to_string());
        if full_cmd.contains("--privileged") {
            warnings.push("WARNING: PRIVILEGED MODE - Full system access!".to_string());
        }
        if args.iter().any(|arg| arg == "-v") || full_cmd.contains("--volume") {
            warnings.push("Volume mount detected - filesystem access".to_string());
        }
    }

    if full_cmd.contains("npx -y") {
        warnings.push("External npm package download and execution".to_string());
    }

    if command.contains("uvx") {
        warnings.push("External Python package download and execution".to_string());
    }

    if full_cmd.contains("sudo") {
        warnings.push("WARNING: ROOT PRIVILEGES REQUESTED".to_string());
    }

    if full_cmd.contains("rm ") || full_cmd.contains("del ") {
        warnings.push("WARNING: Delete operation detected".to_string());
    }

    if warnings.is_empty() {
        warnings.push("Standard tool execution".to_string());
    }

    warnings
}

fn find_package(
    packages: &[McpRegistryPackage],
    preferred_runtime: Option<&str>,
) -> Option<McpRegistryPackage> {
    if packages.is_empty() {
        return None;
    }

    if let Some(runtime) = preferred_runtime {
        for pkg in packages {
            if pkg.runtime_hint.as_deref() == Some(runtime) {
                return Some(pkg.clone());
            }
        }
    }

    for pkg in packages {
        if pkg.runtime_hint.is_some() {
            return Some(pkg.clone());
        }
    }

    packages.first().cloned()
}

fn generate_command(package: &McpRegistryPackage) -> (String, Vec<String>) {
    let runtime = package
        .runtime_hint
        .clone()
        .unwrap_or_else(|| "npx".to_string());
    let pkg_name = package.package_name();

    match runtime.as_str() {
        "npx" => ("npx".to_string(), vec!["-y".to_string(), pkg_name]),
        "uvx" | "python" => ("uvx".to_string(), vec![pkg_name]),
        "docker" => (
            "docker".to_string(),
            vec![
                "run".to_string(),
                "-i".to_string(),
                "--rm".to_string(),
                pkg_name,
            ],
        ),
        other => (other.to_string(), vec![pkg_name]),
    }
}

fn is_safe_key_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'
}
