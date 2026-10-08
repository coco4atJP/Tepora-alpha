use super::*;
fn png(w: u32, h: u32) -> Vec<u8> {
    let mut b = vec![0; 40];
    b[..8].copy_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
    b[12..16].copy_from_slice(b"IHDR");
    b[16..20].copy_from_slice(&w.to_be_bytes());
    b[20..24].copy_from_slice(&h.to_be_bytes());
    b
}
#[test]
fn dimensions_signatures_and_errors() {
    assert_eq!(
        inspect(&png(800, 600)).unwrap(),
        ("image/png", "png", 800, 600)
    );
    assert_eq!(inspect(&png(0, 10)).unwrap_err().status, 400);
    assert_eq!(inspect(&png(20000, 20000)).unwrap_err().status, 413);
    assert_eq!(inspect(&[0; 4]).unwrap_err().status, 400);
    assert_eq!(inspect(&[0; 20]).unwrap_err().status, 400);
    let mut avif = vec![0; 16];
    avif[4..12].copy_from_slice(b"ftypavif");
    assert_eq!(inspect(&avif).unwrap().2, 0);
    let mut webp = vec![0; 30];
    webp[..4].copy_from_slice(b"RIFF");
    webp[8..16].copy_from_slice(b"WEBPVP8X");
    webp[24] = 9;
    webp[27] = 19;
    assert_eq!(inspect(&webp).unwrap(), ("image/webp", "webp", 10, 20));
    assert_eq!(filename("/some/file\0.png"), "file .png");
}
fn json_reply(w: &Workspace, op: Operation) -> Value {
    match w.execute(op).unwrap() {
        Reply::Json(v) => v,
        _ => panic!("expected JSON"),
    }
}
#[test]
fn persistence_dedupe_bytes_cleanup_and_events() {
    let dir = std::env::temp_dir().join(format!("tepora-frame-{}", Uuid::new_v4()));
    let w = Workspace::open(&dir).unwrap();
    let b = png(800, 600);
    let first = json_reply(
        &w,
        Operation::FrameAdd {
            bytes: b.clone(),
            filename: "/tmp/猫.png".into(),
        },
    );
    assert_eq!(first["photos"][0]["name"], "猫.png");
    assert!(first["photos"][0].get("sha256").is_none());
    assert_eq!(
        first,
        json_reply(
            &w,
            Operation::FrameAdd {
                bytes: b.clone(),
                filename: "copy".into()
            }
        )
    );
    let id = first["photos"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(fs::read_dir(dir.join("frame")).unwrap().count(), 1);
    let events = w
        .lock()
        .unwrap()
        .call("event.replay", json!({"since":0}))
        .unwrap();
    assert_eq!(
        events
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == "frame.updated")
            .count(),
        1
    );
    w.shutdown().unwrap();
    drop(w);
    let w = Workspace::open(&dir).unwrap();
    assert_eq!(first, json_reply(&w, Operation::Frame));
    match w.execute(Operation::FrameRead { id: id.clone() }).unwrap() {
        Reply::Photo { bytes, mime } => {
            assert_eq!(bytes, b);
            assert_eq!(mime, "image/png");
        }
        _ => panic!(),
    }
    let second = json_reply(
        &w,
        Operation::FrameAdd {
            bytes: png(801, 600),
            filename: "".into(),
        },
    );
    assert_eq!(second["photos"][1]["name"], "写真");
    assert_eq!(
        json_reply(&w, Operation::FrameDelete { id: id.clone() })["photos"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        w.execute(Operation::FrameRead { id: id.clone() })
            .unwrap_err()
            .status,
        404
    );
    assert_eq!(
        w.execute(Operation::FrameDelete { id }).unwrap_err().status,
        404
    );
    w.shutdown().unwrap();
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn frozen_photo_signature_results_match_source() {
    let fixtures = json_codec::parse(include_str!("fixtures/source.json")).unwrap();
    for case in fixtures["cases"].as_array().unwrap() {
        let hex = case["hex"].as_str().unwrap();
        let b = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect::<Vec<_>>();
        let actual = match inspect(&b) {
            Ok((mime, ext, width, height)) => {
                json!({"value":{"mime":mime,"ext":ext,"width":width,"height":height}})
            }
            Err(e) => json!({"status":e.status,"message":e.message}),
        };
        assert_eq!(actual, case["expected"], "{}", case["name"]);
    }
}
#[test]
fn filename_platform_basename_and_utf16_clip_match_source() {
    let fixtures = json_codec::parse(include_str!("fixtures/source.json")).unwrap();
    for case in fixtures["names"].as_array().unwrap() {
        for windows in [false, true] {
            assert_eq!(
                filename_for(case["input"].as_str().unwrap(), windows),
                case[if windows { "windows" } else { "posix" }]
                    .as_str()
                    .unwrap(),
                "{case} windows={windows}"
            );
        }
    }
}
#[test]
fn concurrent_adds_are_deduplicated_and_ordered() {
    let dir = std::env::temp_dir().join(format!("tepora-frame-concurrent-{}", Uuid::new_v4()));
    let w = Arc::new(Workspace::open(&dir).unwrap());
    let threads = (0..12)
        .map(|_| {
            let w = w.clone();
            std::thread::spawn(move || {
                json_reply(
                    &w,
                    Operation::FrameAdd {
                        bytes: png(800, 600),
                        filename: "same.png".into(),
                    },
                )
            })
        })
        .collect::<Vec<_>>();
    for thread in threads {
        assert_eq!(
            thread.join().unwrap()["photos"].as_array().unwrap().len(),
            1
        );
    }
    assert_eq!(fs::read_dir(dir.join("frame")).unwrap().count(), 1);
    let events = w
        .lock()
        .unwrap()
        .call("event.replay", json!({"since":0}))
        .unwrap();
    assert_eq!(
        events
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == "frame.updated")
            .count(),
        1
    );
    w.shutdown().unwrap();
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn quotas_reject_before_writing_and_duplicate_at_limit_still_succeeds() {
    let dir = std::env::temp_dir().join(format!("tepora-frame-quota-{}", Uuid::new_v4()));
    let w = Workspace::open(&dir).unwrap();
    for width in 1..=300 {
        json_reply(
            &w,
            Operation::FrameAdd {
                bytes: png(width, 1),
                filename: "".into(),
            },
        );
    }
    assert_eq!(
        w.execute(Operation::FrameAdd {
            bytes: png(301, 1),
            filename: "".into()
        })
        .unwrap_err()
        .status,
        413
    );
    assert_eq!(
        json_reply(
            &w,
            Operation::FrameAdd {
                bytes: png(1, 1),
                filename: "".into()
            }
        )["photos"]
            .as_array()
            .unwrap()
            .len(),
        300
    );
    assert_eq!(fs::read_dir(dir.join("frame")).unwrap().count(), 300);
    w.lock()
        .unwrap()
        .set_value("frame-photos", json!([{"bytes":MAX_FRAME_BYTES}]))
        .unwrap();
    assert_eq!(
        w.execute(Operation::FrameAdd {
            bytes: png(400, 1),
            filename: "".into()
        })
        .unwrap_err()
        .message,
        "保存できる写真の合計サイズを超えます。"
    );
    assert_eq!(fs::read_dir(dir.join("frame")).unwrap().count(), 300);
    assert_eq!(
        inspect(&vec![0; MAX_PHOTO_BYTES + 1]).unwrap_err().status,
        413
    );
    w.shutdown().unwrap();
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn filesystem_failures_do_not_publish_a_changed_list() {
    let dir = std::env::temp_dir().join(format!("tepora-frame-errors-{}", Uuid::new_v4()));
    let w = Workspace::open(&dir).unwrap();
    fs::write(dir.join("frame"), b"synthetic ordinary file").unwrap();
    assert_eq!(
        w.execute(Operation::FrameAdd {
            bytes: png(800, 600),
            filename: "".into()
        })
        .unwrap_err()
        .status,
        500
    );
    assert_eq!(json_reply(&w, Operation::Frame)["photos"], json!([]));
    fs::remove_file(dir.join("frame")).unwrap();
    let saved = json_reply(
        &w,
        Operation::FrameAdd {
            bytes: png(800, 600),
            filename: "".into(),
        },
    );
    let id = saved["photos"][0]["id"].as_str().unwrap().to_string();
    let file = dir.join("frame").join(format!("{id}.png"));
    fs::remove_file(&file).unwrap();
    fs::create_dir(&file).unwrap();
    fs::write(file.join("fixture"), b"synthetic").unwrap();
    assert_eq!(
        w.execute(Operation::FrameDelete { id }).unwrap_err().status,
        500
    );
    assert_eq!(json_reply(&w, Operation::Frame), saved);
    let events = w
        .lock()
        .unwrap()
        .call("event.replay", json!({"since":0}))
        .unwrap();
    assert_eq!(
        events
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == "frame.updated")
            .count(),
        1
    );
    w.shutdown().unwrap();
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn shutdown_drains_admitted_file_metadata_commit_and_rejects_new_work() {
    for deleting in [false, true] {
        let dir = std::env::temp_dir().join(format!("tepora-frame-drain-{}", Uuid::new_v4()));
        let w = Arc::new(Workspace::open(&dir).unwrap());
        json_reply(
            &w,
            Operation::FrameAdd {
                bytes: png(800, 600),
                filename: "fixture".into(),
            },
        );
        // Pause precisely at the file-I/O/metadata boundary under the same lease
        // as execute_frame, without timing a disk write or adding runtime hooks.
        let lease = w.photo_changes.lock().unwrap();
        let mut list = w
            .lock()
            .unwrap()
            .value("frame-photos")
            .unwrap()
            .as_array()
            .unwrap()
            .clone();
        if deleting {
            let meta = list.pop().unwrap();
            fs::remove_file(
                dir.join("frame")
                    .join(format!("{}.png", meta["id"].as_str().unwrap())),
            )
            .unwrap();
        } else {
            let mut meta = list[0].clone();
            let id = Uuid::new_v4().to_string();
            meta["id"] = json!(id);
            meta["width"] = json!(801);
            fs::write(dir.join("frame").join(format!("{id}.png")), png(801, 600)).unwrap();
            list.push(meta);
        }
        w.begin_shutdown().unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let closer = w.clone();
        let thread = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            closer.shutdown().unwrap();
            done_tx.send(()).unwrap();
        });
        started_rx.recv().unwrap();
        assert!(done_rx
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());
        let expected = snapshot(&json!(list));
        match w.commit_frame(list).unwrap() {
            Reply::Json(v) => assert_eq!(v, expected),
            _ => panic!(),
        }
        drop(lease);
        done_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        thread.join().unwrap();
        assert_eq!(w.execute(Operation::Frame).unwrap_err().status, 503);
        drop(w);
        let restarted = Workspace::open(&dir).unwrap();
        assert_eq!(json_reply(&restarted, Operation::Frame), expected);
        assert_eq!(
            fs::read_dir(dir.join("frame")).unwrap().count(),
            if deleting { 0 } else { 2 }
        );
        restarted.shutdown().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
}
