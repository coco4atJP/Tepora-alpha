//! The shared Node worker process (`core/pi-worker.mjs`). One JSON object per line;
//! empty environment; stdin close ends the worker; killed on drop.
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::Stdio,
    time::Duration,
};
use tepora_core::json_codec;

/// Largest accepted worker line (a 16 MiB request body is ~21 MiB as base64).
pub const MAX_LINE: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct WorkerCommand {
    pub node: PathBuf,
    pub script: PathBuf,
}
impl WorkerCommand {
    /// `TEPORA_NODE` / `TEPORA_PI_WORKER` override the Node binary and worker script.
    /// Defaults: `node` from PATH and this checkout's `core/pi-worker.mjs`.
    pub fn discover() -> Self {
        let node = std::env::var_os("TEPORA_NODE")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| which("node"))
            .unwrap_or_else(|| PathBuf::from("node"));
        let script = std::env::var_os("TEPORA_PI_WORKER")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../core/pi-worker.mjs"));
        Self { node, script }
    }
    fn configure(&self, command: &mut std::process::Command) {
        command
            .arg("--max-old-space-size=256")
            .arg(&self.script)
            // No ambient credentials, proxy variables or OAuth host overrides.
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            if let Some(root) = std::env::var_os("SystemRoot") {
                command.env("SystemRoot", root);
            }
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
    }
    pub fn spawn(&self) -> std::io::Result<tokio::process::Child> {
        let mut command = std::process::Command::new(&self.node);
        self.configure(&mut command);
        let mut command = tokio::process::Command::from(command);
        command.kill_on_drop(true);
        command.spawn()
    }
    /// Synchronous one-shot operation without fetches or credential calls (the catalog).
    pub fn oneshot(&self, data: Value, timeout: Duration) -> Result<Value, String> {
        let mut command = std::process::Command::new(&self.node);
        self.configure(&mut command);
        let mut child = command.spawn().map_err(|_| "pi-ai Workerを起動できません。Node.jsと依存パッケージを確認してください。".to_owned())?;
        let mut stdin = child.stdin.take().ok_or("pi-ai Worker stdin is unavailable")?;
        let stdout = child.stdout.take().ok_or("pi-ai Worker stdout is unavailable")?;
        let line = json_codec::stringify_js(&json!({"type":"start","data":data})).map_err(|e| e.to_string())?;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let result = (|| {
                let mut buffer = Vec::new();
                loop {
                    buffer.clear();
                    let read = reader.by_ref().take(MAX_LINE as u64 + 1).read_until(b'\n', &mut buffer).map_err(|e| e.to_string())?;
                    if read == 0 || buffer.len() > MAX_LINE {
                        return Err("pi-ai Workerが終了しました。".to_owned());
                    }
                    let text = std::str::from_utf8(&buffer).map_err(|_| "Invalid pi-ai worker output")?;
                    let message = json_codec::parse(text.trim_end()).map_err(|_| "Invalid pi-ai worker output")?;
                    match message["type"].as_str() {
                        Some("result") => return Ok(message["value"].clone()),
                        Some("failure") => return Err("pi-ai Workerが失敗しました。".to_owned()),
                        _ => {}
                    }
                }
            })();
            let _ = tx.send(result);
        });
        // stdin stays open until the answer: closing it ends the worker.
        let written = stdin.write_all(format!("{line}\n").as_bytes()).and_then(|_| stdin.flush());
        let result = match written {
            Ok(()) => rx.recv_timeout(timeout).unwrap_or_else(|_| Err("pi-ai Workerが応答しません。".to_owned())),
            Err(_) => Err("pi-ai Workerを起動できません。".to_owned()),
        };
        let _ = child.kill();
        let _ = child.wait();
        result
    }
}
fn which(name: &str) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe")]
    } else {
        vec![name.to_owned()]
    };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|p| p.is_file())
}
