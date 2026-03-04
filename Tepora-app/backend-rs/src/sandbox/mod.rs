use std::collections::HashMap;
use std::path::{Path, PathBuf};

use wasmtime::{Config, Engine, Module};

/// Launch specification for running a Wasm-based MCP stdio server in a sandboxed runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WasmLaunchSpec {
    pub executable: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub clear_env: bool,
}

impl WasmLaunchSpec {
    pub fn module_path(&self) -> Option<&str> {
        // `wasmtime run <module> ...` => module path is second arg
        self.args.get(1).map(|s| s.as_str())
    }
}

/// Parse and resolve Wasm module path from MCP command text.
pub fn resolve_wasm_module_path(command: &str) -> Option<PathBuf> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(path) = trimmed.strip_prefix("wasm:") {
        let normalized = path.trim();
        if normalized.is_empty() {
            return None;
        }
        return Some(PathBuf::from(normalized));
    }

    let path = PathBuf::from(trimmed);
    let is_wasm = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("wasm"))
        .unwrap_or(false);
    if is_wasm {
        Some(path)
    } else {
        None
    }
}

/// Build a sandboxed launch spec for Wasm MCP stdio server.
///
/// This uses `wasmtime run` as the default host runtime and enforces:
/// - no inherited parent environment (`clear_env = true`)
/// - only explicitly configured MCP environment variables
/// - module bytecode validation before launch
pub fn build_wasm_launch_spec(
    raw_command: &str,
    module_args: &[String],
    env: &HashMap<String, String>,
) -> Result<WasmLaunchSpec, String> {
    let module_path = resolve_wasm_module_path(raw_command)
        .ok_or_else(|| format!("Not a Wasm MCP command: '{}'", raw_command))?;
    validate_wasm_module(&module_path)?;

    let runtime = std::env::var("TEPORA_WASM_RUNTIME")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "wasmtime".to_string());

    // Keep runtime arguments minimal:
    // - no preopened dirs (filesystem isolation)
    // - no networking flags (network isolation by default)
    let mut args = vec!["run".to_string(), module_path.to_string_lossy().to_string()];
    if !module_args.is_empty() {
        args.push("--".to_string());
        args.extend(module_args.iter().cloned());
    }

    Ok(WasmLaunchSpec {
        executable: runtime,
        args,
        env: env.clone(),
        clear_env: true,
    })
}

fn validate_wasm_module(module_path: &Path) -> Result<(), String> {
    if !module_path.exists() {
        return Err(format!(
            "Wasm module not found: {}",
            module_path.to_string_lossy()
        ));
    }

    let mut config = Config::new();
    // Conservative defaults for sandbox execution.
    config.max_wasm_stack(1024 * 512);
    config.wasm_memory64(false);

    let engine = Engine::new(&config).map_err(|e| format!("Failed to create Wasm engine: {e}"))?;
    Module::from_file(&engine, module_path).map_err(|e| {
        format!(
            "Invalid Wasm module '{}': {e}",
            module_path.to_string_lossy()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn resolve_module_path_from_plain_wasm_command() {
        let path = resolve_wasm_module_path("tools/server.wasm");
        assert_eq!(path, Some(PathBuf::from("tools/server.wasm")));
    }

    #[test]
    fn resolve_module_path_from_prefixed_wasm_command() {
        let path = resolve_wasm_module_path("wasm:tools/server.wasm");
        assert_eq!(path, Some(PathBuf::from("tools/server.wasm")));
    }

    #[test]
    fn rejects_non_wasm_command() {
        assert_eq!(resolve_wasm_module_path(""), None);
        assert_eq!(resolve_wasm_module_path("npx"), None);
    }

    #[test]
    fn build_launch_spec_rejects_missing_file() {
        let result = build_wasm_launch_spec(
            "wasm:does-not-exist.wasm",
            &[],
            &HashMap::<String, String>::new(),
        );
        assert!(result.is_err());
    }
}
