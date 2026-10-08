use super::*;
use std::time::Duration;
use tepora_core::json_codec::{encode_value, parse};

struct Fixture {
    root: PathBuf,
    context: FileContext,
}
impl Fixture {
    fn new() -> Self {
        // Outside the universally writable /tmp root, so confinement fixtures
        // can actually distinguish workspace from external paths.
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("native-file-fixtures")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let context = FileContext::new(root.join("work"));
        fs::create_dir_all(&context.cwd).unwrap();
        Self { root, context }
    }
    async fn run(&self, name: &str, args: Value) -> Result<Value, EffectError> {
        FileTools
            .execute(
                name,
                encode_value(args),
                self.context.clone(),
                RequestCancellation::new(),
            )
            .await
    }
    fn file(&self, name: &str) -> PathBuf {
        // PathBuf::join keeps caller-provided '/' separators on Windows. Build
        // expected fixture paths from platform components without canonicalizing
        // the filesystem or reusing the production path resolver.
        self.context.cwd.join(name).components().collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn status(e: &EffectError) -> u64 {
    e.error["status"].as_u64().unwrap()
}

#[test]
fn fixture_paths_use_native_separators_without_changing_filename_units() {
    let f = Fixture::new();
    let expected = f.context.cwd.join("sub").join("notes.md");
    assert_eq!(f.file("sub/notes.md").as_os_str(), expected.as_os_str());
    assert_eq!(
        f.file("\u{e000}\u{e100}�.txt").file_name().unwrap(),
        std::ffi::OsStr::new("\u{e000}\u{e100}�.txt")
    );
    #[cfg(windows)]
    {
        assert!(!f.root.to_string_lossy().contains('/'));
        assert!(!f.context.cwd.to_string_lossy().contains('/'));
        assert!(!f.file("sub/notes.md").to_string_lossy().contains('/'));
    }
    #[cfg(unix)]
    assert_eq!(
        f.file(r"sub\notes.md").file_name().unwrap(),
        std::ffi::OsStr::new(r"sub\notes.md")
    );
}

#[tokio::test]
async fn write_append_edit_results_and_real_bytes() {
    let f = Fixture::new();
    let path = f.file("sub/notes.md").to_string_lossy().into_owned();
    let out = f
        .run("write", json!({"path":"sub/notes.md","content":"A😀\nB"}))
        .await
        .unwrap();
    assert_eq!(
        out,
        json!({"text":format!("Wrote 5 characters to {path} (now 2 lines, 7 bytes, sha {})",sha("A😀\nB")),"data":{"path":path,"op":"write","bytes":7,"sha":sha("A😀\nB")}})
    );
    let out = f
        .run(
            "write",
            json!({"path":"sub/notes.md","content":"\nC","append":true}),
        )
        .await
        .unwrap();
    assert_eq!(out["data"]["op"], "append");
    assert_eq!(out["data"]["bytes"], 9);
    let out = f
        .run(
            "edit",
            json!({"path":"sub/notes.md","old_string":"B","new_string":"$&new$1"}),
        )
        .await
        .unwrap();
    assert!(out["text"].as_str().unwrap().contains("line 2"));
    assert_eq!(
        fs::read_to_string(f.file("sub/notes.md")).unwrap(),
        "A😀\n$&new$1\nC"
    );
    assert_eq!(out["data"]["sha"], sha("A😀\n$&new$1\nC"));
}
#[tokio::test]
async fn text_lines_limits_and_retained_read_receipts() {
    let f = Fixture::new();
    fs::write(f.file("a"), "one\ntwo\nthree\n").unwrap();
    let out = f
        .run("read", json!({"path":"a","offset":2,"limit":1}))
        .await
        .unwrap();
    let path = f.file("a").to_string_lossy().into_owned();
    assert_eq!(
        out["text"],
        format!("{path} (4 lines)\n    2\ttwo\n… 2 more lines (read with offset=3)")
    );
    f.context.memory.lock().unwrap().record_read(11, &out);
    assert_eq!(
        f.run("read", json!({"path":"a","offset":2,"limit":1}))
            .await
            .unwrap()["data"]["unchanged"],
        true
    );
    let mut hidden = f.context.clone();
    hidden.read_visible_after = 11;
    let out = FileTools
        .execute(
            "read",
            json!({"path":"a","offset":2,"limit":1}),
            hidden,
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(out["data"]["readKey"].is_string());
    fs::write(f.file("a"), "modified text").unwrap();
    assert!(f
        .run("read", json!({"path":"a","offset":2,"limit":1}))
        .await
        .unwrap()["data"]["readKey"]
        .is_string());
    let beyond = f
        .run("read", json!({"path":"a","offset":9999}))
        .await
        .unwrap();
    assert_eq!(beyond["text"], format!("{path} (1 lines)\n"));
}
#[tokio::test]
async fn utf16_line_slice_and_os_replacement_are_lossless_at_right_boundary() {
    let f = Fixture::new();
    let args =
        parse(r#"{"path":"\ue000\ue100\ud800.txt","content":"\ue000\ue100\ud800😀"}"#).unwrap();
    let out = FileTools
        .execute("write", args, f.context.clone(), RequestCancellation::new())
        .await
        .unwrap();
    let path = f.file("\u{e000}\u{e100}�.txt");
    assert_eq!(fs::read_to_string(&path).unwrap(), "\u{e000}\u{e100}�😀");
    assert!(out["text"]
        .as_str()
        .unwrap()
        .starts_with("Wrote 5 characters"));
    assert_eq!(
        sql_text(out["data"]["path"].as_str().unwrap()),
        path.to_string_lossy()
    );
    fs::write(f.file("long"), format!("{}😀tail", "a".repeat(1999))).unwrap();
    let out = f.run("read", json!({"path":"long"})).await.unwrap();
    let units = utf16_units(out["text"].as_str().unwrap());
    assert_eq!(&units[units.len() - 2..], &[0xd83d, 0x2026]);
    let args = parse(r#"{"path":"long","old_string":"\ud83d","new_string":"X"}"#).unwrap();
    FileTools
        .execute("edit", args, f.context.clone(), RequestCancellation::new())
        .await
        .unwrap();
    assert!(fs::read_to_string(f.file("long"))
        .unwrap()
        .ends_with("X�tail"));
}
#[tokio::test]
async fn binary_directory_images_and_fifty_megabytes() {
    let f = Fixture::new();
    fs::write(f.file("binary"), [1, 0, 255]).unwrap();
    let out = f.run("read", json!({"path":"binary"})).await.unwrap();
    assert!(out["text"]
        .as_str()
        .unwrap()
        .contains("binary file (3 bytes)"));
    fs::write(f.file("fake.PNG"), b"fake image").unwrap();
    let error = f.run("read", json!({"path":"fake.PNG"})).await.unwrap_err();
    assert_eq!(status(&error), 503);
    assert!(error.error["message"]
        .as_str()
        .unwrap()
        .contains("not implemented"));
    fs::create_dir_all(f.file("listing/sub")).unwrap();
    fs::write(f.file("listing/a"), b"a").unwrap();
    for i in 0..505 {
        fs::write(f.file(&format!("listing/b{i:03}")), b"").unwrap();
    }
    let listing = f.run("read", json!({"path":"listing"})).await.unwrap();
    let lines: Vec<_> = listing["text"].as_str().unwrap().lines().collect();
    assert_eq!(lines.len(), 501);
    assert_eq!(lines[1], "a");
    let mut big = File::create(f.file("big")).unwrap();
    big.write_all(&[b'a'; 8000]).unwrap();
    big.set_len(50_000_001).unwrap();
    assert_eq!(
        status(&f.run("read", json!({"path":"big"})).await.unwrap_err()),
        413
    );
}
#[tokio::test]
async fn unseen_overwrite_freshness_append_and_edit_contract() {
    let f = Fixture::new();
    fs::write(f.file("old"), "old content").unwrap();
    assert_eq!(
        status(
            &f.run("write", json!({"path":"old","content":"new"}))
                .await
                .unwrap_err()
        ),
        409
    );
    // Edit and append do not require read-before-write in the source.
    f.run(
        "edit",
        json!({"path":"old","old_string":"old","new_string":"first"}),
    )
    .await
    .unwrap();
    fs::write(f.file("old"), "another person's longer content").unwrap();
    assert_eq!(
        status(
            &f.run("write", json!({"path":"old","content":"overwrite"}))
                .await
                .unwrap_err()
        ),
        409
    );
    assert_eq!(
        status(
            &f.run(
                "edit",
                json!({"path":"old","old_string":"another","new_string":"bad"})
            )
            .await
            .unwrap_err()
        ),
        409
    );
    f.run(
        "write",
        json!({"path":"old","content":"\nappend","append":true}),
    )
    .await
    .unwrap();
    f.run("write", json!({"path":"old","content":"seen now"}))
        .await
        .unwrap();
    assert_eq!(fs::read_to_string(f.file("old")).unwrap(), "seen now");
    fs::write(f.file("newly-born"), "initial").unwrap();
    let mut c = f.context.clone();
    c.session_created_at_ms = Some(epoch_ms(SystemTime::now()));
    FileTools
        .execute(
            "write",
            json!({"path":"newly-born","content":"per source"}),
            c,
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        status(
            &f.run("write", json!({"path":".","content":"bad"}))
                .await
                .unwrap_err()
        ),
        400
    );
}
#[tokio::test]
async fn edit_exact_match_uniqueness_and_near_lines() {
    let f = Fixture::new();
    fs::write(f.file("a"), "hello there\nhello there\nlast").unwrap();
    let error = f
        .run(
            "edit",
            json!({"path":"a","old_string":"hello","new_string":"HI"}),
        )
        .await
        .unwrap_err();
    assert!(error.error["message"]
        .as_str()
        .unwrap()
        .contains("occurs 2 times"));
    let error = f
        .run(
            "edit",
            json!({"path":"a","old_string":"hello there\nwrong","new_string":"X"}),
        )
        .await
        .unwrap_err();
    assert!(error.error["message"]
        .as_str()
        .unwrap()
        .contains("Similar lines:\n1: hello there\n2: hello there"));
    let out = f
        .run(
            "edit",
            json!({"path":"a","old_string":"hello","new_string":"HI","replace_all":true}),
        )
        .await
        .unwrap();
    assert!(out["text"].as_str().unwrap().contains("2 replacements"));
    assert_eq!(
        fs::read_to_string(f.file("a")).unwrap(),
        "HI there\nHI there\nlast"
    );
    for old in ["", "HI"] {
        assert_eq!(
            status(
                &f.run(
                    "edit",
                    json!({"path":"a","old_string":old,"new_string":old})
                )
                .await
                .unwrap_err()
            ),
            400
        );
    }
}
#[test]
fn resolve_relative_home_utf16_and_validation() {
    let f = Fixture::new();
    let mut c = f.context.clone();
    c.home = f.root.join("home");
    assert_eq!(resolve_path(&c, &json!("a/../b")).unwrap(), f.file("b"));
    assert_eq!(resolve_path(&c, &json!("~")).unwrap(), c.home);
    assert_eq!(
        resolve_path(&c, &json!("~//a/../b")).unwrap(),
        c.home.join("b")
    );
    for bad in [
        json!(null),
        json!(""),
        json!("x\0y"),
        json!("a".repeat(4097)),
        json!("😀".repeat(2049)),
    ] {
        assert_eq!(status(&resolve_path(&c, &bad).unwrap_err()), 400);
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn process_wide_file_lock_serializes_sessions_and_cancels_waiters() {
    let f = Fixture::new();
    let file = f.file("parallel");
    let lock = file_lock(&file);
    let held = lock.lock_owned().await;
    let cancel = RequestCancellation::new();
    let token = cancel.clone();
    let c = f.context.clone();
    let waiting = tokio::spawn(async move {
        FileTools
            .execute(
                "write",
                json!({"path":"parallel","content":"never"}),
                c,
                token,
            )
            .await
    });
    tokio::task::yield_now().await;
    cancel.cancel();
    let err = waiting.await.unwrap().unwrap_err();
    assert!(err.aborted);
    assert_eq!(err.error["notExecuted"], true);
    assert!(!file.exists());
    drop(held);
    let mut tasks = Vec::new();
    for _ in 0..24 {
        let c = FileContext::new(f.context.cwd.clone());
        tasks.push(tokio::spawn(async move {
            FileTools
                .execute(
                    "write",
                    json!({"path":"parallel","content":"x","append":true}),
                    c,
                    RequestCancellation::new(),
                )
                .await
                .unwrap()
        }));
    }
    let mut sizes = Vec::new();
    for task in tasks {
        sizes.push(task.await.unwrap()["data"]["bytes"].as_u64().unwrap());
    }
    sizes.sort_unstable();
    assert_eq!(sizes, (1..=24).collect::<Vec<_>>());
    assert_eq!(fs::read_to_string(&file).unwrap(), "x".repeat(24));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatched_file_job_settles_actual_result_after_cancellation() {
    let f = Fixture::new();
    let file = f.file("settled");
    let destination = file.clone();
    let cancel = RequestCancellation::new();
    let token = cancel.clone();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let release = Arc::new(std::sync::Barrier::new(2));
    let barrier = release.clone();
    let job = tokio::spawn(async move {
        settle_blocking(token, move || {
            started_tx.send(()).unwrap();
            barrier.wait();
            fs::write(destination, b"committed after Stop").unwrap();
            Ok(json!({"text":"actual success"}))
        })
        .await
    });
    started_rx.await.unwrap();
    cancel.cancel();
    assert!(!job.is_finished());
    release.wait();
    let result = job.await.unwrap().unwrap();
    assert_eq!(result["text"], "actual success");
    assert_eq!(fs::read_to_string(file).unwrap(), "committed after Stop");
}
#[test]
fn sandbox_default_and_roots_preserve_source_guards() {
    let f = Fixture::new();
    let outside = f.root.join("outside");
    fs::create_dir(&outside).unwrap();
    assert_eq!(SandboxPolicy::default().mode, SandboxMode::Off);
    assert!(assert_writable(
        &SandboxPolicy::default(),
        &f.context.cwd,
        &outside.join("a")
    )
    .is_ok());
    let mut policy = SandboxPolicy {
        mode: SandboxMode::Readonly,
        writable: vec![],
    };
    assert_eq!(
        status(&assert_writable(&policy, &f.context.cwd, &f.file("a")).unwrap_err()),
        403
    );
    assert!(assert_writable(
        &policy,
        &f.context.cwd,
        &std::env::temp_dir().join("not-created-fixture")
    )
    .is_ok());
    policy.mode = SandboxMode::Workspace;
    assert!(assert_writable(&policy, &f.context.cwd, &f.file("a")).is_ok());
    assert_eq!(
        status(&assert_writable(&policy, &f.context.cwd, &outside.join("a")).unwrap_err()),
        403
    );
    policy.writable.push(outside.clone());
    assert!(assert_writable(&policy, &f.context.cwd, &outside.join("a")).is_ok());
    assert!(SandboxPolicy::from_value(&json!({"mode":"mystery"})).is_err());
}
#[cfg(unix)]
#[tokio::test]
async fn deliberate_symlink_security_correction_never_broadens_writes() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = f.root.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("real"), b"protected").unwrap();
    symlink(outside.join("real"), f.file("final-link")).unwrap();
    symlink(&outside, f.file("ancestor-link")).unwrap();
    let mut c = f.context.clone();
    c.sandbox.mode = SandboxMode::Workspace;
    for path in ["final-link", "ancestor-link/missing/a"] {
        let err = FileTools
            .execute(
                "write",
                json!({"path":path,"content":"bad","append":true}),
                c.clone(),
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(status(&err), 403);
    }
    assert_eq!(
        fs::read_to_string(outside.join("real")).unwrap(),
        "protected"
    );
    assert!(!outside.join("missing").exists());
    fs::write(f.file("inside"), b"inside").unwrap();
    symlink(f.file("inside"), f.file("inside-link")).unwrap();
    assert_eq!(
        status(
            &FileTools
                .execute(
                    "write",
                    json!({"path":"inside-link","content":"x","append":true}),
                    c,
                    RequestCancellation::new()
                )
                .await
                .unwrap_err()
        ),
        403
    );
    // Default-off retains intentional host access and follows source symlinks.
    f.run(
        "write",
        json!({"path":"final-link","content":" allowed","append":true}),
    )
    .await
    .unwrap();
    assert_eq!(
        fs::read_to_string(outside.join("real")).unwrap(),
        "protected allowed"
    );
}
#[test]
fn read_reference_cache_is_insertion_order_bounded() {
    let mut m = FileMemory::default();
    for i in 0..301 {
        m.record_read(
            i,
            &json!({"data":{"readKey":format!("k{i}"),"mtimeMs":1.5,"size":2}}),
        );
    }
    assert_eq!(m.reads.len(), 300);
    assert!(!m.reads.contains_key("k0"));
    m.record_read(
        999,
        &json!({"data":{"readKey":"k1","mtimeMs":1.5,"size":2}}),
    );
    m.record_read(
        1000,
        &json!({"data":{"readKey":"k301","mtimeMs":1.5,"size":2}}),
    );
    assert!(!m.reads.contains_key("k1"));
}
#[tokio::test]
async fn local_mutations_invalidate_same_stamp_read_receipts() {
    for tool in ["write", "edit"] {
        let f = Fixture::new();
        fs::write(f.file("a"), "old\nline").unwrap();
        fs::write(f.file("b"), "other").unwrap();
        let original = fs::metadata(f.file("a")).unwrap();
        for (seq, args) in [
            json!({"path":"a","limit":1}),
            json!({"path":"a","offset":2,"limit":1}),
            json!({"path":"b"}),
        ]
        .into_iter()
        .enumerate()
        {
            let out = f.run("read", args).await.unwrap();
            f.context
                .memory
                .lock()
                .unwrap()
                .record_read(seq as u64 + 1, &out);
        }
        let args = if tool == "write" {
            json!({"path":"a","content":"new\nline"})
        } else {
            json!({"path":"a","old_string":"old","new_string":"new"})
        };
        f.run(tool, args).await.unwrap();
        // Force the metadata collision, independent of filesystem clock speed.
        let file = OpenOptions::new().write(true).open(f.file("a")).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(original.modified().unwrap()))
            .unwrap();
        drop(file);
        assert_eq!(
            FileStamp::of(&original),
            FileStamp::of(&fs::metadata(f.file("a")).unwrap())
        );
        {
            let memory = f.context.memory.lock().unwrap();
            assert_eq!(memory.reads.len(), 1);
            assert_eq!(memory.read_order.len(), 1);
        }
        let fresh = f.run("read", json!({"path":"a","limit":1})).await.unwrap();
        assert!(fresh["text"].as_str().unwrap().contains("\tnew"), "{tool}");
        assert!(fresh["data"]["readKey"].is_string());
        assert!(f
            .run("read", json!({"path":"a","offset":2,"limit":1}))
            .await
            .unwrap()["data"]["readKey"]
            .is_string());
        assert_eq!(
            f.run("read", json!({"path":"b"})).await.unwrap()["data"]["unchanged"],
            true
        );
    }
}

#[test]
fn read_invalidation_removes_ranges_and_conservative_colon_prefixes() {
    let mut memory = FileMemory::default();
    for (seq, key) in ["a:1:1", "a:2:1", "a:extra:1:1", "ab:1:1"]
        .into_iter()
        .enumerate()
    {
        memory.record_read(
            seq as u64,
            &json!({"data":{"readKey":key,"mtimeMs":1.5,"size":2}}),
        );
    }
    memory.invalidate_reads("a");
    assert_eq!(memory.reads.len(), 1);
    assert!(memory.reads.contains_key("ab:1:1"));
    assert_eq!(memory.read_order, VecDeque::from(["ab:1:1".to_string()]));
    memory.record_read(
        10,
        &json!({"data":{"readKey":"a:1:1","mtimeMs":1.5,"size":2}}),
    );
    assert_eq!(memory.read_order.back().unwrap(), "a:1:1");
}

#[tokio::test]
async fn same_size_mtime_change_requires_a_fresh_read() {
    let f = Fixture::new();
    fs::write(f.file("a"), "same").unwrap();
    f.run("read", json!({"path":"a"})).await.unwrap();
    // Windows SetFileTime requires a write-attributes-capable handle.
    let file = OpenOptions::new().write(true).open(f.file("a")).unwrap();
    file.set_times(fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(20)))
        .unwrap();
    drop(file);
    assert_eq!(
        status(
            &f.run("write", json!({"path":"a","content":"same"}))
                .await
                .unwrap_err()
        ),
        409
    );
    f.run("read", json!({"path":"a"})).await.unwrap();
    f.run("write", json!({"path":"a","content":"okay"}))
        .await
        .unwrap();
}

#[tokio::test]
async fn frozen_node_file_tool_differential() {
    fn setup(root: &Path, value: &Value) {
        let path = root.join(sql_text(value["path"].as_str().unwrap()));
        if value["directory"] == true {
            fs::create_dir_all(path).unwrap();
            return;
        }
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let bytes = if let Some(bytes) = value["bytes"].as_array() {
            bytes
                .iter()
                .map(|v| v.as_u64().unwrap() as u8)
                .collect::<Vec<_>>()
        } else {
            sql_text(value["content"].as_str().unwrap()).into_bytes()
        };
        fs::write(path, bytes).unwrap();
    }
    let cases = parse(include_str!("source-fixtures.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let f = Fixture::new();
        let mut context = f.context.clone();
        context.session_created_at_ms = Some(4_102_444_800_000.0);
        let paths = fixture_path_normalizations(&context, case);
        for entry in case["setup"].as_array().unwrap() {
            setup(&context.cwd, entry);
        }
        for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let tool = step["tool"].as_str().unwrap();
            match tool {
                "external" => {
                    setup(&context.cwd, &step["args"]);
                    continue;
                }
                "clear" => {
                    context.read_visible_after = index as u64;
                    continue;
                }
                _ => {}
            }
            let out = FileTools
                .execute(
                    tool,
                    step["args"].clone(),
                    context.clone(),
                    RequestCancellation::new(),
                )
                .await;
            let actual = match out {
                Ok(value) => {
                    context
                        .memory
                        .lock()
                        .unwrap()
                        .record_read((index + 1) as u64, &value);
                    json!({"value":value})
                }
                Err(e) => {
                    json!({"error":{"message":e.error["message"],"status":e.error["status"]}})
                }
            };
            assert_eq!(
                normalize_fixture_paths(&actual, &paths),
                step["expected"],
                "scenario {}, step {}: {tool}",
                case["label"],
                index
            );
        }
        for expected in case["files"].as_array().unwrap() {
            let bytes: Vec<_> = expected["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u8)
                .collect();
            assert_eq!(
                fs::read(
                    context
                        .cwd
                        .join(sql_text(expected["path"].as_str().unwrap()))
                )
                .unwrap(),
                bytes,
                "{} final file {}",
                case["label"],
                expected["path"]
            );
        }
    }
}

/// The oracle was recorded on Linux. Normalize only known fixture paths, not
/// arbitrary backslashes in result payload text or JSON arguments. Prefixes are
/// replaced longest first so nested paths keep exact relative components.
fn normalize_fixture_paths(value: &Value, paths: &[(String, String)]) -> Value {
    match value {
        Value::String(s) => {
            let mut s = s.clone();
            for (actual, expected) in paths {
                s = s.replace(actual, expected);
            }
            Value::String(s)
        }
        Value::Array(a) => Value::Array(
            a.iter()
                .map(|v| normalize_fixture_paths(v, paths))
                .collect(),
        ),
        Value::Object(o) => Value::Object(
            o.iter()
                .filter(|(k, _)| *k != "mtimeMs")
                .map(|(k, v)| (k.clone(), normalize_fixture_paths(v, paths)))
                .collect(),
        ),
        _ => value.clone(),
    }
}
fn fixture_path_normalizations(context: &FileContext, case: &Value) -> Vec<(String, String)> {
    let root = resolve_file(context, &json!(".")).unwrap();
    let mut paths = vec![json!(".")];
    paths.extend(
        case["setup"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.get("path").cloned()),
    );
    paths.extend(
        case["steps"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v["args"].get("path").cloned()),
    );
    let mut result = Vec::new();
    for path in paths {
        let path = resolve_file(context, &path).unwrap();
        for path in [path.clone(), path.join("notes.md")] {
            let relative = path
                .logical
                .strip_prefix(&root.logical)
                .expect("fixture paths stay inside root");
            let parts = relative
                .components()
                .map(|p| p.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            let normalized = if parts.is_empty() {
                "<ROOT>".to_owned()
            } else {
                format!("<ROOT>/{}", parts.join("/"))
            };
            result.push((path.text(), normalized));
        }
    }
    result.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then(a.0.cmp(&b.0)));
    result.dedup();
    result
}
#[test]
fn path_fixture_normalization_preserves_non_path_backslashes_and_utf16() {
    let paths = vec![
        (
            r"C:\fixture\dir\notes.md".into(),
            "<ROOT>/dir/notes.md".into(),
        ),
        (r"C:\fixture\dir".into(), "<ROOT>/dir".into()),
        (r"C:\fixture".into(), "<ROOT>".into()),
    ];
    let value = json!({"text":r"C:\fixture\dir is a folder; use C:\fixture\dir\notes.md. Payload \n and other\text are literal.",
        "data":{"readKey":r"C:\fixture\dir:1:800"},"lone":from_utf16_units(&[0xd800])});
    let actual = normalize_fixture_paths(&value, &paths);
    assert_eq!(
        actual["text"],
        r"<ROOT>/dir is a folder; use <ROOT>/dir/notes.md. Payload \n and other\text are literal."
    );
    assert_eq!(actual["data"]["readKey"], "<ROOT>/dir:1:800");
    assert_eq!(utf16_units(actual["lone"].as_str().unwrap()), [0xd800]);
}
