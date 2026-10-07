use super::*;
use crate::sandbox::{Available, SandboxMode, Shell};
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, fs, path::Path};
use tepora_core::json_codec::{encode_text, utf16_units};
struct Fixture {
    root: PathBuf,
    manager: ProcessManager,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("tepora-process-stage7-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let facts = SpawnFacts {
            platform: Platform::current(),
            shell: Shell {
                file: "/bin/sh".into(),
                name: "sh".into(),
                windows: false,
            },
            available: Available::default(),
            temp_dir: std::env::temp_dir(),
        };
        let manager = ProcessManager::with_options(ManagerOptions {
            facts,
            environment: Some(vec![("PATH".into(), "/usr/bin:/bin".into())]),
            login_path: Some("/usr/bin:/bin".into()),
            clock: Arc::new(now_ms),
        });
        Self { root, manager }
    }
    fn context(&self, session: &str) -> ProcessContext {
        ProcessContext {
            session_id: session.into(),
            cwd: self.root.clone(),
            cwd_text: Some(sandbox::encode_path(&self.root)),
            sandbox: SandboxConfig::default(),
            cancellation: RequestCancellation::new(),
        }
    }
    async fn exec(&self, args: Value) -> Value {
        self.manager
            .execute_exec(args, self.context("s"))
            .await
            .unwrap()
    }
    async fn process(&self, args: Value) -> Value {
        self.manager
            .execute_process(args, self.context("s"))
            .await
            .unwrap()
    }
    async fn close(&self) {
        self.manager.begin_close().wait_async().await.unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.begin_close();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn fixture() -> Value {
    json_codec::parse(include_str!("fixtures/source.json")).unwrap()
}
#[test]
fn frozen_source_terminal_output_metadata_and_config_differential() {
    let fixture = fixture();
    for case in fixture["terminal"].as_array().unwrap() {
        assert_eq!(
            terminal_text(case["input"].as_str().unwrap()),
            case["expected"],
            "terminal input={:?}",
            case["input"]
        );
    }
    for case in fixture["output"].as_array().unwrap() {
        let mut output = Output::default();
        let mut out = Utf8Decoder::default();
        let mut err = Utf8Decoder::default();
        for chunk in case["chunks"].as_array().unwrap() {
            let bytes = if let Some(bytes) = chunk["bytes"].as_array() {
                bytes.iter().map(|b| b.as_u64().unwrap() as u8).collect()
            } else if let Some(repeat) = chunk["repeat"].as_str() {
                sql_text(repeat)
                    .repeat(chunk["count"].as_u64().unwrap() as usize)
                    .into_bytes()
            } else {
                sql_text(chunk["text"].as_str().unwrap()).into_bytes()
            };
            let decoded = if chunk["stream"] == "err" {
                err.push(&bytes)
            } else {
                out.push(&bytes)
            };
            output.take(&decoded);
        }
        output.take(&(out.finish() + &err.finish()));
        assert_eq!(output.total, case["total"].as_u64().unwrap());
        assert_eq!(output.dropped, case["dropped"].as_u64().unwrap());
        for read in case["reads"].as_array().unwrap() {
            let actual = output.read(read["from"].as_u64().unwrap());
            let units = utf16_units(&actual);
            let bytes = units
                .iter()
                .flat_map(|n| n.to_le_bytes())
                .collect::<Vec<_>>();
            assert_eq!(units.len() as u64, read["length"].as_u64().unwrap());
            assert_eq!(format!("{:x}", Sha256::digest(bytes)), read["hash"]);
            assert_eq!(json!(&units[..units.len().min(24)]), read["first"]);
            assert_eq!(
                json!(&units[units.len().saturating_sub(24)..]),
                read["last"]
            );
        }
    }
    for case in fixture["config"].as_array().unwrap() {
        match SandboxConfig::parse(&case["raw"], None, &Platform::Linux) {
            Ok(config) => assert_eq!(config.value(), case["expected"]),
            Err(error) => {
                assert_eq!(error.message, case["error"]);
                assert_eq!(error.status as u64, case["status"].as_u64().unwrap());
            }
        }
    }
    for case in fixture["metadata"].as_array().unwrap() {
        assert_eq!(summarize("exec", &case["args"]).unwrap(), case["summary"]);
        assert_eq!(
            exec_stub(
                &case["args"],
                &json!({"data":{"processId":"p123","exitCode":null}})
            )
            .unwrap(),
            case["stub"]
        );
        assert_eq!(
            exec_stub(&case["args"], &json!({"data":{"exitCode":7}})).unwrap(),
            case["exitStub"]
        );
        assert_eq!(ephemeral_key(&case["args"]), case["ephemeral"]);
    }
}
#[test]
fn frozen_source_sandbox_plan_differential() {
    for case in fixture()["plans"].as_array().unwrap() {
        let raw = &case["facts"];
        let platform = match raw["platform"].as_str().unwrap() {
            "linux" => Platform::Linux,
            "darwin" => Platform::Macos,
            "win32" => Platform::Windows,
            x => Platform::Other(x.into()),
        };
        let facts = SpawnFacts {
            platform: platform.clone(),
            shell: Shell {
                file: raw["shell"].as_str().unwrap().into(),
                name: Path::new(raw["shell"].as_str().unwrap())
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into(),
                windows: platform == Platform::Windows,
            },
            available: Available {
                seatbelt: raw["seatbelt"] == true,
                bwrap: raw["bwrap"].as_str().map(PathBuf::from),
                docker: raw["docker"].as_str().map(PathBuf::from),
                podman: raw["podman"].as_str().map(PathBuf::from),
            },
            temp_dir: "/tmp".into(),
        };
        let policy = SandboxConfig::parse(&case["policy"], None, &platform).unwrap();
        // The frozen oracle disables realpath and uses absolute POSIX fixture paths.
        // Do not resolve these synthetic paths against the machine running the test.
        match sandbox::wrap_command_with_resolver(
            case["command"].as_str().unwrap(),
            Path::new(case["cwd"].as_str().unwrap()),
            &policy,
            case["name"].as_str(),
            &facts,
            &Path::to_path_buf,
        ) {
            Ok(plan) => {
                let mut expected = case["expected"].clone();
                if expected["container"].is_null() {
                    expected.as_object_mut().unwrap().remove("container");
                }
                assert_eq!(plan.value(), expected);
            }
            Err(error) => {
                assert_eq!(error.message, case["error"]);
                assert_eq!(error.status as u64, case["status"].as_u64().unwrap());
            }
        }
    }
}
#[test]
fn exact_approval_metadata_keeps_unicode_final_args_and_definition_identity() {
    let args = json_codec::parse(r#"{"command":"echo \ud800 🌱","cwd":"/tmp"}"#).unwrap();
    let metadata = approval_metadata("exec", &args, "7:tool:3").unwrap();
    assert_eq!(metadata["args"], args);
    assert_eq!(metadata["definitionKey"], "7:tool:3");
    assert_eq!(
        metadata["argsJSON"],
        encode_text(&json_codec::stringify_js(&args).unwrap())
    );
    assert_eq!(
        catalog(&Shell {
            file: "/bin/zsh".into(),
            name: "zsh".into(),
            windows: false
        })[0]["parameters"]["properties"]["command"]["description"],
        "Shell command line (zsh)."
    );
}

#[cfg(unix)]
#[tokio::test]
async fn real_exec_is_native_without_node_python_or_path_and_preserves_environment() {
    let f = Fixture::new();
    let mut context = f.context("owner-session");
    context.cwd = f.root.join("nested");
    let result=f.manager.execute_exec(json!({"command":"PATH=; printf 'session=%s cwd=%s' \"$TEPORA_SESSION\" \"$PWD\"","yield":2}),context).await.unwrap();
    assert!(result["text"].as_str().unwrap().starts_with("exit 0"));
    assert!(result["text"]
        .as_str()
        .unwrap()
        .contains("session=owner-session"));
    assert!(result["text"].as_str().unwrap().contains("nested"));
    assert!(result["data"]["processId"].is_null());
    f.close().await;
}
#[cfg(unix)]
#[tokio::test]
async fn stdout_stderr_split_utf8_ansi_and_invalid_tail_are_drained() {
    let f = Fixture::new();
    let result=f.exec(json!({"command":"printf '\\360\\237'; /bin/sleep 0.03; printf '\\214\\261'; printf '\\033[31mERR\\033[0m' >&2; printf '\\342\\202' >&2","yield":2})).await;
    let text = result["text"].as_str().unwrap();
    assert!(text.contains("🌱"));
    assert!(text.contains("ERR�"));
    assert!(!text.contains('\u{1b}'));
    f.close().await;
}
#[cfg(unix)]
#[tokio::test]
async fn real_large_output_has_head_tail_gap_and_counts() {
    let f = Fixture::new();
    let text = format!("{}{}END", "A".repeat(210000), "B".repeat(900000));
    fs::write(f.root.join("large.txt"), &text).unwrap();
    let result = f
        .exec(json!({"command":"/bin/cat large.txt","yield":2}))
        .await;
    let result = result["text"].as_str().unwrap();
    assert!(result.contains("…[110003 characters dropped]…"));
    assert!(result.ends_with("END"));
    let list = f.manager.list(Some("s"));
    assert_eq!(list[0]["outputChars"], 1110003);
    f.close().await;
}
#[cfg(unix)]
#[tokio::test]
async fn ordinary_stdin_closes_but_background_write_and_poll_keep_cursor() {
    let f = Fixture::new();
    let result = f
        .exec(json!({"command":"read line; printf 'got:%s' \"$line\"","stdin":"hello\n","yield":2}))
        .await;
    assert!(result["text"].as_str().unwrap().ends_with("got:hello"));
    let running=f.exec(json!({"command":"while IFS= read -r line; do printf '[%s]\\n' \"$line\"; done","background":true})).await;
    let id = running["data"]["processId"].as_str().unwrap();
    assert!(f.manager.get(id, Some("other-session")).is_err());
    let first = f
        .process(json!({"action":"write","id":id,"input":"one\n"}))
        .await;
    assert!(first["text"].as_str().unwrap().contains("[one]"));
    let poll = f.process(json!({"action":"poll","id":id,"wait":0})).await;
    assert!(!poll["text"].as_str().unwrap().contains("[one]"));
    let log = f.process(json!({"action":"log","id":id,"offset":0})).await;
    assert!(log["text"].as_str().unwrap().contains("after NaN s"));
    assert!(log["text"].as_str().unwrap().contains("[one]"));
    let last = f
        .process(json!({"action":"write","id":id,"input":"two\n","close":true}))
        .await;
    assert!(last["text"].as_str().unwrap().contains("[two]"));
    assert!(last["text"].as_str().unwrap().starts_with("exit 0"));
    assert_eq!(
        f.manager
            .execute_process(
                json!({"action":"write","id":id,"input":"late"}),
                f.context("s")
            )
            .await
            .unwrap_err()
            .error["status"],
        409
    );
    f.close().await;
}
#[cfg(unix)]
#[tokio::test]
async fn selected_unavailable_sandbox_and_spawn_failure_never_run_unconfined() {
    let f = Fixture::new();
    let mut context = f.context("s");
    context.sandbox.mode = SandboxMode::Workspace;
    let error = f
        .manager
        .execute_exec(
            json!({"command":"printf unsafe > escaped.txt","yield":1}),
            context,
        )
        .await
        .unwrap_err();
    assert_eq!(error.error["status"], 409);
    assert_eq!(error.error["notExecuted"], true);
    assert!(!f.root.join("escaped.txt").exists());
    assert!(f.manager.list(None).is_empty());
    let facts = SpawnFacts {
        platform: Platform::Linux,
        shell: Shell {
            file: "/bin/sh".into(),
            name: "sh".into(),
            windows: false,
        },
        available: Available {
            bwrap: Some(f.root.join("missing-bwrap")),
            ..Default::default()
        },
        temp_dir: std::env::temp_dir(),
    };
    let manager = ProcessManager::with_options(ManagerOptions {
        facts,
        environment: Some(vec![]),
        login_path: Some("".into()),
        clock: Arc::new(now_ms),
    });
    let mut context = f.context("s");
    context.sandbox.mode = SandboxMode::Workspace;
    let result = manager
        .execute_exec(
            json!({"command":"printf unsafe > escaped.txt","yield":1}),
            context,
        )
        .await
        .unwrap();
    assert_eq!(result["data"]["exitCode"], 127);
    assert!(result["text"].as_str().unwrap().contains("sandbox bwrap"));
    assert!(!f.root.join("escaped.txt").exists());
    manager.begin_close().wait_async().await.unwrap();
    f.close().await;
}
#[cfg(unix)]
#[tokio::test]
async fn cancelled_before_dispatch_is_not_executed_and_running_cancel_waits_for_exit() {
    let f = Fixture::new();
    let context = f.context("s");
    context.cancellation.cancel();
    let error = f
        .manager
        .execute_exec(json!({"command":"printf no > canceled.txt"}), context)
        .await
        .unwrap_err();
    assert_eq!(error.error["notExecuted"], true);
    assert!(!f.root.join("canceled.txt").exists());
    let manager = f.manager.clone();
    let context = f.context("s");
    let cancel = context.cancellation.clone();
    let task = tokio::spawn(async move {
        manager
            .execute_exec(
                json!({"command":"printf start; /bin/sleep 60","yield":600}),
                context,
            )
            .await
    });
    for _ in 0..200 {
        if !f.manager.list(Some("s")).is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    cancel.cancel();
    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result["text"].as_str().unwrap().contains("(killed)"));
    assert!(result["data"]["processId"].is_null());
    assert!(f
        .manager
        .list(None)
        .iter()
        .all(|p| p["status"] != "running"));
    f.close().await;
}
#[cfg(unix)]
#[tokio::test]
async fn timeout_and_close_terminate_whole_process_groups_then_reject_new_starts() {
    let f = Fixture::new();
    let mut request = StartRequest::new("trap '' TERM; (/bin/sleep 60) & wait", "s", &f.root);
    request.timeout = Some(Duration::from_millis(40));
    let handle = f
        .manager
        .start(request, &RequestCancellation::new())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), f.manager.drain_process(&handle))
        .await
        .unwrap();
    let snapshot = handle.snapshot();
    assert_eq!(snapshot.status, "killed");
    assert_eq!(snapshot.signal.as_deref(), Some("SIGKILL"));
    let background = f
        .exec(json!({"command":"/bin/sleep 60","background":true}))
        .await;
    assert!(background["data"]["processId"].is_string());
    let close = f.manager.begin_close();
    close.wait_async().await.unwrap();
    assert!(close.is_complete());
    let error = f
        .manager
        .start(
            StartRequest::new("echo no", "s", &f.root),
            &RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.error["notExecuted"], true);
}
#[cfg(unix)]
#[tokio::test]
async fn session_cancel_does_not_kill_another_sessions_background_process() {
    let f = Fixture::new();
    let a = f
        .manager
        .start(
            StartRequest::new("/bin/sleep 60", "a", &f.root),
            &RequestCancellation::new(),
        )
        .await
        .unwrap();
    let b = f
        .manager
        .start(
            StartRequest::new("/bin/sleep 60", "b", &f.root),
            &RequestCancellation::new(),
        )
        .await
        .unwrap();
    f.manager.cancel_session("a").wait_async().await.unwrap();
    assert_eq!(a.snapshot().status, "killed");
    assert_eq!(b.snapshot().status, "running");
    f.close().await;
}
#[cfg(unix)]
#[tokio::test]
async fn every_container_fallback_has_a_name_and_engine_cleanup_drains() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let engine = f.root.join("fake-docker");
    let args = f.root.join("args");
    let killed = f.root.join("killed");
    fs::write(&engine,format!("#!/bin/sh\nif [ \"$1\" = kill ]; then printf '%s' \"$2\" > '{}'; /bin/sleep 0.08; printf done >> '{}'; exit 0; fi\nprintf '%s\\n' \"$@\" > '{}'\ntrap 'exit 0' TERM\n/bin/sleep 60 & wait\n",killed.display(),killed.display(),args.display())).unwrap();
    fs::set_permissions(&engine, fs::Permissions::from_mode(0o755)).unwrap();
    let mut options = ManagerOptions::default();
    options.facts = f.manager.facts().clone();
    options.facts.available.docker = Some(engine);
    options.login_path = Some("/usr/bin:/bin".into());
    let manager = ProcessManager::with_options(options);
    let mut request = StartRequest::new("printf should-not-run", "s", &f.root);
    request.policy.mode = SandboxMode::Readonly;
    request.policy.network = false;
    let handle = manager
        .start(request, &RequestCancellation::new())
        .await
        .unwrap();
    for _ in 0..100 {
        if args.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let name = handle.snapshot().container_name.unwrap();
    assert!(name.starts_with("tepora-p"));
    let argv = fs::read_to_string(&args).unwrap();
    assert!(argv.contains(&format!("--name\n{name}\n")));
    assert!(argv.contains(":/workspace:ro"));
    assert!(argv.contains("--network\nnone"));
    manager.begin_close().wait_async().await.unwrap();
    assert_eq!(fs::read_to_string(killed).unwrap(), format!("{name}done"));
    f.close().await;
}
#[cfg(unix)]
#[tokio::test]
async fn source_tty_adapter_allocates_a_terminal_when_dependency_is_available() {
    let f = Fixture::new();
    if sandbox::which("python3", OsStr::new("/usr/bin:/bin"), &Platform::current()).is_none()
        && sandbox::which("script", OsStr::new("/usr/bin:/bin"), &Platform::current()).is_none()
    {
        return;
    }
    let result = f
        .exec(json!({"command":"test -t 0 && printf TTY_OK","tty":true,"yield":0}))
        .await;
    // `yield` only bounds the initial response. In particular, a cold platform
    // Python/PTY startup is not required to finish within two seconds.
    let processes = f.manager.list(Some("s"));
    let handle = f
        .manager
        .get(processes[0]["id"].as_str().unwrap(), Some("s"))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(15), f.manager.drain_process(&handle))
        .await
        .unwrap_or_else(|_| {
            panic!(
                "PTY did not finish: {result:?}; {:?}; {}",
                handle.snapshot(),
                handle.output(0)
            )
        });
    let snapshot = handle.snapshot();
    assert_eq!(
        snapshot.exit_code,
        Some(0),
        "{snapshot:?}; {}",
        handle.output(0)
    );
    assert_eq!(snapshot.status, "exited");
    assert!(!snapshot.cleanup_uncertain && !snapshot.output_truncated);
    assert!(handle.output(0).contains("TTY_OK"));
    f.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn fractional_json_spelling_of_integer_and_logical_cwd_codec_survive() {
    let f = Fixture::new();
    let args =
        json_codec::parse(r#"{"command":"printf ok","cwd":"folder\ud800","yield":2.0}"#).unwrap();
    let result = f.exec(args).await;
    assert_eq!(result["data"]["exitCode"], 0);
    let list = f.manager.list(Some("s"));
    let cwd = list[0]["cwd"].as_str().unwrap();
    assert!(json_codec::stringify_js(&json!(cwd))
        .unwrap()
        .contains("\\ud800"));
    assert!(Path::new(&sql_text(cwd)).is_dir());
    assert_eq!(unsigned(&json!(3.0), 99), 3);
    f.close().await;
}

#[cfg(unix)]
fn login_fixture(f: &Fixture) -> (ProcessManager, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let shell = f.root.join("login-shell");
    let log = f.root.join("login-count");
    fs::write(&shell,format!("#!/bin/sh\nif [ \"$1\" = -l ]; then printf x >> '{}'; /bin/sleep 0.15; printf '__P__/opt/tool:/usr/bin:/opt/tool__P__'; exit 0; fi\nexec /bin/sh \"$@\"\n",log.display())).unwrap();
    fs::set_permissions(&shell, fs::Permissions::from_mode(0o755)).unwrap();
    let mut facts = f.manager.facts().clone();
    facts.shell = Shell {
        file: shell,
        name: "login-shell".into(),
        windows: false,
    };
    let manager = ProcessManager::with_options(ManagerOptions {
        facts,
        environment: Some(vec![("PATH".into(), "/bin:/usr/bin".into())]),
        login_path: None,
        clock: Arc::new(now_ms),
    });
    (manager, log)
}
#[cfg(unix)]
#[tokio::test]
async fn login_shell_path_is_merged_once_and_close_cancels_reserved_dispatch() {
    let f = Fixture::new();
    let (manager, log) = login_fixture(&f);
    let one = manager
        .execute_exec(
            json!({"command":"printf '%s' \"$PATH\"","yield":2}),
            f.context("s"),
        )
        .await
        .unwrap();
    assert!(one["text"]
        .as_str()
        .unwrap()
        .ends_with("/opt/tool:/usr/bin:/bin"));
    manager
        .execute_exec(
            json!({"command":"printf '%s' \"$PATH\"","yield":2}),
            f.context("s"),
        )
        .await
        .unwrap();
    assert_eq!(fs::read_to_string(&log).unwrap(), "x");
    manager.begin_close().wait_async().await.unwrap();
    fs::remove_file(&log).unwrap();
    let (manager, log) = login_fixture(&f);
    let starter = manager.clone();
    let cwd = f.root.clone();
    let task = tokio::spawn(async move {
        starter
            .start(
                StartRequest::new("printf bad > would-run", "s", cwd),
                &RequestCancellation::new(),
            )
            .await
    });
    for _ in 0..100 {
        if log.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert!(log.exists());
    let close = manager.begin_close();
    assert!(!close.is_complete());
    let error = task.await.unwrap().unwrap_err();
    assert_eq!(error.error["notExecuted"], true);
    close.wait_async().await.unwrap();
    assert!(!f.root.join("would-run").exists());
    assert!(manager.list(None).is_empty());
    f.close().await;
}
#[cfg(unix)]
#[tokio::test]
async fn session_stop_cancels_its_pending_start_without_blocking_other_owner() {
    let f = Fixture::new();
    let (manager, log) = login_fixture(&f);
    let a = manager.clone();
    let b = manager.clone();
    let root_a = f.root.clone();
    let root_b = f.root.clone();
    let first = tokio::spawn(async move {
        a.start(
            StartRequest::new("printf no > owner-a", "a", root_a),
            &RequestCancellation::new(),
        )
        .await
    });
    for _ in 0..100 {
        if log.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    let second = tokio::spawn(async move {
        b.start(
            StartRequest::new("/bin/sleep 60", "b", root_b),
            &RequestCancellation::new(),
        )
        .await
    });
    tokio::task::yield_now().await;
    let stopped = manager.cancel_session("a");
    assert_eq!(first.await.unwrap().unwrap_err().error["notExecuted"], true);
    let running = second.await.unwrap().unwrap();
    stopped.wait_async().await.unwrap();
    assert_eq!(running.snapshot().status, "running");
    assert!(!f.root.join("owner-a").exists());
    manager.begin_close().wait_async().await.unwrap();
    f.close().await;
}

#[cfg(target_os = "linux")]
struct OwnedFixtureChild {
    pid: i32,
    start: String,
}
#[cfg(target_os = "linux")]
fn fixture_child_identity(pid: i32) -> Option<(String, String)> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields = stat
        .rsplit_once(')')?
        .1
        .split_whitespace()
        .collect::<Vec<_>>();
    Some((fields.get(19)?.to_string(), fields.first()?.to_string()))
}
#[cfg(target_os = "linux")]
impl OwnedFixtureChild {
    async fn read(path: &Path) -> Self {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            if let Ok(text) = fs::read_to_string(path) {
                if let Ok(pid) = text.trim().parse::<i32>() {
                    if let Some((start, _)) = fixture_child_identity(pid) {
                        return Self { pid, start };
                    }
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "Controlled fixture did not identify its own child"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
    async fn wait_for_death(&self) {
        // Pipe EOF can be observed while the kernel is still completing exit.
        // Keep asserting death of this exact child, with a finite settling bound.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while fixture_child_identity(self.pid)
            .is_some_and(|(start, state)| start == self.start && state != "Z")
        {
            assert!(
                tokio::time::Instant::now() < deadline,
                "Owned fixture child remained alive after group cleanup"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}
#[cfg(target_os = "linux")]
impl Drop for OwnedFixtureChild {
    fn drop(&mut self) {
        // This is only the PID emitted by our own fixed test script. Validate
        // the kernel start time before cleanup; never signal a reused PID.
        if fixture_child_identity(self.pid)
            .is_some_and(|(start, state)| start == self.start && state != "Z")
        {
            unsafe {
                libc::kill(self.pid, libc::SIGKILL);
            }
        }
    }
}
#[cfg(target_os = "linux")]
#[tokio::test]
async fn escaped_holder_has_bounded_uncertain_pipe_drain_and_no_unrelated_kill() {
    let f = Fixture::new();
    let Some(setsid) = sandbox::which("setsid", OsStr::new("/usr/bin:/bin"), &Platform::Linux)
    else {
        return;
    };
    // The known holder has an independent ten-second maximum even if the test
    // fails before reading its identity. It retains stdout/stderr but does no IO.
    // Publish from inside the new session, only after setsid has escaped.
    let command = format!(
        "{} /bin/sh -c 'printf \"%s\" \"$$\" > escaped.pid; exec /bin/sleep 10' &",
        setsid.display()
    );
    let handle = f
        .manager
        .start(
            StartRequest::new(command, "s", &f.root),
            &RequestCancellation::new(),
        )
        .await
        .unwrap();
    let holder = OwnedFixtureChild::read(&f.root.join("escaped.pid")).await;
    let started = tokio::time::Instant::now();
    let close = f.manager.begin_close();
    let error = tokio::time::timeout(Duration::from_secs(6), close.wait_async())
        .await
        .expect("close waited forever for escaped pipe EOF")
        .unwrap_err();
    assert!(
        started.elapsed() >= Duration::from_secs(3),
        "The normal TERM→KILL escalation must run before truncation"
    );
    assert!(error.message.contains("uncertain"));
    let snapshot = handle.snapshot();
    assert_eq!(snapshot.status, "unknown");
    assert!(snapshot.output_truncated && snapshot.cleanup_uncertain);
    assert!(handle.output(0).contains("descendant outcome unknown"));
    assert_eq!(uncertain_effect(&snapshot).error["notExecuted"], false);
    assert!(
        fixture_child_identity(holder.pid)
            .is_some_and(|(start, state)| start == holder.start && state != "Z"),
        "Uncontained escaped child should be reported, not claimed killed"
    );
    drop(holder);
}
#[cfg(target_os = "linux")]
#[tokio::test]
async fn retained_owned_pid_allows_group_kill_after_shell_exit_without_truncation() {
    let f = Fixture::new();
    // Publish only after TERM is ignored, so cleanup must exercise escalation.
    let command =
        "/bin/sh -c 'trap \"\" TERM; printf \"%s\" \"$$\" > grouped.pid; exec /bin/sleep 10' &";
    let handle = f
        .manager
        .start(
            StartRequest::new(command, "s", &f.root),
            &RequestCancellation::new(),
        )
        .await
        .unwrap();
    let child = OwnedFixtureChild::read(&f.root.join("grouped.pid")).await;
    let pid = handle.snapshot().pid.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while !peek_owned_exit(pid).unwrap() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "Fixture leader did not exit"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(!handle.item.child_reaped.load(Ordering::Acquire));
    let started = tokio::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(6), f.manager.begin_close().wait_async())
        .await
        .unwrap()
        .unwrap();
    let snapshot = handle.snapshot();
    assert_eq!(snapshot.status, "killed");
    assert!(!snapshot.cleanup_uncertain && !snapshot.output_truncated);
    assert!(started.elapsed() >= Duration::from_secs(3));
    child.wait_for_death().await;
    drop(child);
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[tokio::test]
async fn exited_leader_stays_owned_until_term_resistant_descendant_pipes_drain() {
    let f = Fixture::new();
    // The descendant announces readiness only after ignoring TERM. Its finite
    // lifetime bounds test cleanup even when an assertion fails.
    let command = "/bin/sh -c 'trap \"\" TERM; printf ready > child-ready; exec /bin/sleep 10' &";
    let handle = f
        .manager
        .start(
            StartRequest::new(command, "s", &f.root),
            &RequestCancellation::new(),
        )
        .await
        .unwrap();
    let pid = handle.snapshot().pid.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        if f.root.join("child-ready").exists() && peek_owned_exit(pid).unwrap() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Fixture leader did not exit"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    // Observing exit repeatedly must not reap the leader or release its PID.
    assert!(peek_owned_exit(pid).unwrap());
    assert!(!handle.item.child_reaped.load(Ordering::Acquire));
    let started = tokio::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(6), f.manager.begin_close().wait_async())
        .await
        .expect("Same-group descendant pipes did not drain")
        .unwrap();
    assert!(started.elapsed() >= Duration::from_secs(3));
    let snapshot = handle.snapshot();
    assert_eq!(snapshot.status, "killed");
    assert_eq!(snapshot.exit_code, Some(0));
    assert!(!snapshot.cleanup_uncertain && !snapshot.output_truncated);
    assert!(handle.item.child_reaped.load(Ordering::Acquire));
}
#[cfg(unix)]
#[tokio::test]
async fn a_completed_stop_ticket_never_waits_for_new_same_session_work() {
    let f = Fixture::new();
    let first = f
        .manager
        .start(
            StartRequest::new("/bin/sleep 10", "same", &f.root),
            &RequestCancellation::new(),
        )
        .await
        .unwrap();
    let old = f.manager.cancel_session("same");
    old.wait_async().await.unwrap();
    assert_eq!(first.snapshot().status, "killed");
    let second = f
        .manager
        .start(
            StartRequest::new("/bin/sleep 10", "same", &f.root),
            &RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(second.snapshot().status, "running");
    assert!(matches!(old.completion_result(), Some(Ok(()))));
    f.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn signal_reports_use_the_source_posix_signal_name() {
    let f = Fixture::new();
    let result = f.exec(json!({"command":"kill -USR1 $$","yield":2})).await;
    assert!(result["text"]
        .as_str()
        .unwrap()
        .contains("exit ? (SIGUSR1)"));
    assert!(result["data"]["exitCode"].is_null());
    f.close().await;
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn cancelled_exec_with_escaped_pipes_returns_unknown_outcome_not_success() {
    let f = Fixture::new();
    let Some(setsid) = sandbox::which("setsid", OsStr::new("/usr/bin:/bin"), &Platform::Linux)
    else {
        return;
    };
    let context = f.context("s");
    let cancel = context.cancellation.clone();
    let manager = f.manager.clone();
    // A parent-written $! can precede setsid and accidentally test a grouped child.
    let command = format!(
        "{} /bin/sh -c 'printf \"%s\" \"$$\" > cancelled-escaped.pid; exec /bin/sleep 10' &",
        setsid.display()
    );
    let task = tokio::spawn(async move {
        manager
            .execute_exec(json!({"command":command,"yield":600}), context)
            .await
    });
    let child = OwnedFixtureChild::read(&f.root.join("cancelled-escaped.pid")).await;
    cancel.cancel();
    let error = tokio::time::timeout(Duration::from_secs(6), task)
        .await
        .expect("Canceled exec waited forever on escaped pipes")
        .unwrap()
        .unwrap_err();
    assert_eq!(error.error["notExecuted"], false);
    assert_eq!(error.error["outcomeUnknown"], true);
    assert_eq!(error.error["outputTruncated"], true);
    assert!(f.manager.begin_close().wait_async().await.is_err());
    drop(child);
}
