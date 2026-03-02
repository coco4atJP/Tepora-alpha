#![cfg(feature = "redesign_sandbox")]

use serde_json::json;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tempfile::tempdir;
use tepora_backend::core::config::{AppPaths, ConfigService};
use tepora_backend::mcp::McpManager;

static ENV_LOCK: Mutex<()> = Mutex::new(());

struct EnvGuard {
    originals: Vec<(String, Option<String>)>,
}

impl EnvGuard {
    fn new() -> Self {
        Self {
            originals: Vec::new(),
        }
    }

    fn set_var(&mut self, key: &str, value: impl AsRef<str>) {
        let key_string = key.to_string();
        if !self.originals.iter().any(|(k, _)| k == &key_string) {
            self.originals.push((key_string.clone(), env::var(&key_string).ok()));
        }
        env::set_var(key, value.as_ref());
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, old) in self.originals.iter().rev() {
            match old {
                Some(value) => env::set_var(key, value),
                None => env::remove_var(key),
            }
        }
    }
}

#[tokio::test]
async fn wasm_mcp_server_can_list_and_execute_tool() {
    let _lock = ENV_LOCK.lock().expect("failed to acquire env lock");
    let _ = tracing_subscriber::fmt()
        .with_env_filter("info,mcp=debug,rmcp=debug")
        .try_init();
    eprintln!("[wasm_mcp_e2e] start");

    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let wasm_path = resolve_wasm_fixture_path(&repo_root);
    let runtime_path = resolve_runtime_shim_path(&repo_root);
    eprintln!(
        "[wasm_mcp_e2e] artifacts runtime={} wasm={}",
        runtime_path.display(),
        wasm_path.display()
    );

    let sandbox = tempdir().expect("failed to create tempdir");
    let project_root = sandbox.path().join("project");
    let data_dir = sandbox.path().join("data");
    fs::create_dir_all(&project_root).expect("failed to create project root");
    fs::create_dir_all(&data_dir).expect("failed to create data dir");

    let config_path = project_root.join("config.yml");
    fs::write(
        &config_path,
        r#"
features:
  redesign:
    sandbox_mcp: true
"#,
    )
    .expect("failed to write config.yml");

    let mut env_guard = EnvGuard::new();
    env_guard.set_var("TEPORA_ROOT", project_root.to_string_lossy());
    env_guard.set_var("TEPORA_DATA_DIR", data_dir.to_string_lossy());
    env_guard.set_var("TEPORA_CONFIG_PATH", config_path.to_string_lossy());
    env_guard.set_var("TEPORA_WASM_RUNTIME", runtime_path.to_string_lossy());
    eprintln!("[wasm_mcp_e2e] environment configured");

    let paths = Arc::new(AppPaths::new());
    let config_service = ConfigService::new(paths.clone());
    let manager = McpManager::new(paths, config_service);
    eprintln!("[wasm_mcp_e2e] manager created");

    let payload = json!({
        "mcpServers": {
            "wasm_echo": {
                "command": format!("wasm:{}", wasm_path.to_string_lossy()),
                "args": [],
                "env": {},
                "enabled": true,
                "transport": "stdio"
            }
        }
    });

    tokio::time::timeout(
        std::time::Duration::from_secs(20),
        manager.update_config(&payload),
    )
    .await
    .expect("timed out while updating MCP config with wasm server")
    .expect("failed to update MCP config with wasm server");
    eprintln!("[wasm_mcp_e2e] update_config done");

    let tools = tokio::time::timeout(std::time::Duration::from_secs(20), manager.list_tools())
        .await
        .expect("timed out while listing tools");
    eprintln!("[wasm_mcp_e2e] list_tools done: {} tools", tools.len());
    assert!(
        tools.iter().any(|t| t.name == "wasm_echo_echo"),
        "wasm tool should be discoverable, tools={tools:?}"
    );

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        manager.execute_tool("wasm_echo_echo", &json!({ "text": "hello-wasm" })),
    )
    .await
    .expect("timed out while executing wasm MCP tool")
    .expect("failed to execute wasm MCP tool");
    eprintln!("[wasm_mcp_e2e] execute_tool done output={output}");
    assert_eq!(output, "echo:hello-wasm");
    eprintln!("[wasm_mcp_e2e] success");
}

fn resolve_wasm_fixture_path(repo_root: &Path) -> PathBuf {
    if let Ok(path) = env::var("TEPORA_WASM_MCP_FIXTURE") {
        let candidate = PathBuf::from(path);
        assert!(
            candidate.exists(),
            "TEPORA_WASM_MCP_FIXTURE does not exist: {:?}",
            candidate
        );
        return candidate;
    }

    let wasm_path = repo_root.join(
        "tests/fixtures/wasm-mcp-echo/target/wasm32-wasip1/release/wasm-mcp-echo.wasm",
    );
    assert!(
        wasm_path.exists(),
        "Wasm fixture not found: {:?}. Build it first with: \
         cargo build --release --target wasm32-wasip1 --manifest-path tests/fixtures/wasm-mcp-echo/Cargo.toml --target-dir tests/fixtures/wasm-mcp-echo/target",
        wasm_path
    );
    wasm_path
}

fn resolve_runtime_shim_path(repo_root: &Path) -> PathBuf {
    if let Ok(path) = env::var("TEPORA_WASM_RUNTIME") {
        let candidate = PathBuf::from(path);
        assert!(
            candidate.exists(),
            "TEPORA_WASM_RUNTIME does not exist: {:?}",
            candidate
        );
        return candidate;
    }

    let candidates = vec![
        repo_root.join("target/debug/wasm_runtime_shim"),
        repo_root.join("target/debug/wasm_runtime_shim.exe"),
    ];
    if let Some(runtime) = candidates.iter().find(|candidate| candidate.exists()) {
        return runtime.clone();
    }

    panic!(
        "runtime shim not found. checked: {:?}, {:?}. Build it first with: cargo build --features redesign_sandbox --bin wasm_runtime_shim",
        candidates[0],
        candidates[1]
    );
}
