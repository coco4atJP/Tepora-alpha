use super::*;
fn png(w: u32, h: u32) -> Vec<u8> {
    let mut b = vec![0; 40];
    b[..8].copy_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
    b[12..16].copy_from_slice(b"IHDR");
    b[16..20].copy_from_slice(&w.to_be_bytes());
    b[20..24].copy_from_slice(&h.to_be_bytes());
    b
}
fn reply(w: &Workspace, op: Operation) -> Value {
    match w.execute(op).unwrap() {
        Reply::Json(v) => v,
        _ => panic!("JSON expected"),
    }
}
fn add(w: &Workspace, n: u32) -> Value {
    reply(
        w,
        Operation::AvatarAssetAdd {
            kind: "image".into(),
            bytes: png(n, 40),
            filename: "/folder/test.png".into(),
        },
    )
}
fn events(w: &Workspace) -> Vec<Value> {
    w.lock()
        .unwrap()
        .call("event.replay", json!({"since":0}))
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["type"] == "avatar.assets" || e["type"] == "avatar.updated")
        .cloned()
        .collect()
}
#[test]
fn avatar_assets_persist_dedupe_and_delete_worn_asset_with_history() {
    let dir = env::temp_dir().join(format!("tepora-avatar-{}", Uuid::new_v4()));
    let w = Workspace::open(&dir).unwrap();
    let first = add(&w, 40);
    let id = first["asset"]["id"].as_str().unwrap().to_owned();
    assert_eq!(first["asset"]["name"], "test");
    assert_eq!(
        first["asset"]["meta"],
        json!({"mime":"image/png","width":40,"height":40})
    );
    assert!(first["asset"].get("sha256").is_none());
    assert!(first["asset"]["files"][0].get("store").is_none());
    assert_eq!(add(&w, 40)["existing"], true);
    assert_eq!(events(&w).len(), 1);
    let selected = reply(
        &w,
        Operation::Avatar {
            action: VisualAction::Change,
            body: json!({"expectedRevision":0,"patch":{"body":"image","asset":id}}),
        },
    );
    assert_eq!(selected["revision"], 1);
    w.shutdown().unwrap();
    drop(w);
    let w = Workspace::open(&dir).unwrap();
    assert_eq!(
        reply(&w, Operation::AvatarAssets)["assets"],
        first["assets"]
    );
    match w
        .execute(Operation::AvatarAssetRead {
            id: id.clone(),
            path: "file".into(),
        })
        .unwrap()
    {
        Reply::AvatarFile { bytes, mime } => {
            assert_eq!(bytes, png(40, 40));
            assert_eq!(mime, "image/png");
        }
        _ => panic!(),
    }
    let deleted = reply(&w, Operation::AvatarAssetDelete { id: id.clone() });
    assert_eq!(deleted["removed"], id);
    assert_eq!(deleted["assets"], json!([]));
    assert!(!dir.join("avatar").join(&id).exists());
    let current = reply(
        &w,
        Operation::Avatar {
            action: VisualAction::Get,
            body: json!({}),
        },
    );
    assert_eq!(current["body"], "shiro");
    assert_eq!(current["revision"], 2);
    let e = events(&w);
    assert_eq!(e[e.len() - 2]["type"], "avatar.assets");
    assert_eq!(e[e.len() - 1]["type"], "avatar.updated");
    let undo = reply(
        &w,
        Operation::Avatar {
            action: VisualAction::Undo,
            body: json!({"expectedRevision":2}),
        },
    );
    assert_eq!(undo["body"], "shiro");
    assert_eq!(undo["revision"], 3);
    assert_eq!(
        w.execute(Operation::AvatarAssetDelete { id })
            .unwrap_err()
            .status,
        404
    );
    w.shutdown().unwrap();
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn avatar_assets_quota_and_serialized_duplicate_imports() {
    let dir = env::temp_dir().join(format!("tepora-avatar-quota-{}", Uuid::new_v4()));
    let w = Arc::new(Workspace::open(&dir).unwrap());
    let workers = (0..8)
        .map(|_| {
            let w = w.clone();
            std::thread::spawn(move || add(&w, 40))
        })
        .collect::<Vec<_>>();
    let results = workers
        .into_iter()
        .map(|t| t.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|r| r["existing"] != true).count(), 1);
    for n in 41..64 {
        add(&w, n);
    }
    assert_eq!(
        reply(&w, Operation::AvatarAssets)["assets"]
            .as_array()
            .unwrap()
            .len(),
        24
    );
    assert_eq!(add(&w, 40)["existing"], true);
    assert_eq!(
        w.execute(Operation::AvatarAssetAdd {
            kind: "image".into(),
            bytes: png(99, 40),
            filename: "".into()
        })
        .unwrap_err()
        .status,
        413
    );
    assert_eq!(fs::read_dir(dir.join("avatar")).unwrap().count(), 24);
    assert_eq!(events(&w).len(), 24);
    let list = {
        let mut s = w.lock().unwrap();
        let mut a = s
            .value("avatar-assets")
            .unwrap()
            .as_array()
            .unwrap()
            .clone();
        a.truncate(1);
        a[0]["bytes"] = json!(MAX_LIBRARY_BYTES);
        s.set_value("avatar-assets", json!(a)).unwrap();
        a
    };
    assert_eq!(
        w.execute(Operation::AvatarAssetAdd {
            kind: "image".into(),
            bytes: png(100, 40),
            filename: "".into()
        })
        .unwrap_err()
        .status,
        413
    );
    assert_eq!(
        reply(&w, Operation::AvatarAssets)["assets"],
        json!(list.iter().map(public).collect::<Vec<_>>())
    );
    w.shutdown().unwrap();
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn avatar_assets_missing_file_and_failed_directory_write_preserve_metadata() {
    let dir = env::temp_dir().join(format!("tepora-avatar-files-{}", Uuid::new_v4()));
    let w = Workspace::open(&dir).unwrap();
    fs::write(
        dir.join("avatar"),
        b"ordinary file blocks directory creation",
    )
    .unwrap();
    assert_eq!(
        w.execute(Operation::AvatarAssetAdd {
            kind: "image".into(),
            bytes: png(40, 40),
            filename: "".into()
        })
        .unwrap_err()
        .status,
        500
    );
    assert_eq!(reply(&w, Operation::AvatarAssets)["assets"], json!([]));
    fs::remove_file(dir.join("avatar")).unwrap();
    let added = add(&w, 40);
    let id = added["asset"]["id"].as_str().unwrap().to_owned();
    fs::remove_file(dir.join("avatar").join(&id).join("0")).unwrap();
    assert_eq!(
        w.execute(Operation::AvatarAssetRead {
            id: id.clone(),
            path: "file".into()
        })
        .unwrap_err()
        .status,
        404
    );
    assert_eq!(
        w.execute(Operation::AvatarAssetRead {
            id: id.clone(),
            path: "missing".into()
        })
        .unwrap_err()
        .status,
        404
    );
    reply(&w, Operation::AvatarAssetDelete { id });
    assert_eq!(fs::read_dir(dir.join("avatar")).unwrap().count(), 0);
    // fs.rm(recursive, force) also removes an ordinary file in place of the directory.
    let added = add(&w, 41);
    let id = added["asset"]["id"].as_str().unwrap().to_owned();
    let asset_path = dir.join("avatar").join(&id);
    fs::remove_dir_all(&asset_path).unwrap();
    fs::write(&asset_path, b"ordinary file").unwrap();
    reply(&w, Operation::AvatarAssetDelete { id });
    assert!(!asset_path.exists());
    w.shutdown().unwrap();
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn avatar_assets_filename_basename_extension_and_utf16() {
    assert_eq!(filename_for(" /dir/file\0.png ", false), "file ");
    assert_eq!(filename_for(".png", false), "");
    assert_eq!(filename_for("name.", false), "name.");
    assert_eq!(filename_for("C:\\dir\\name.png", true), "name");
    assert_eq!(filename_for("C:name.png", true), "name");
    assert_eq!(filename_for("C:\\dir\\name.png", false), "C:\\dir\\name");
    assert_eq!(
        json_codec::utf16_units(&filename_for(&format!("{}😀.png", "a".repeat(79)), false)).len(),
        80
    );
}
#[test]
fn avatar_assets_shutdown_drains_admitted_metadata_commit() {
    let dir = env::temp_dir().join(format!("tepora-avatar-drain-{}", Uuid::new_v4()));
    let w = Arc::new(Workspace::open(&dir).unwrap());
    let added = add(&w, 40);
    let id = added["asset"]["id"].as_str().unwrap().to_owned();
    let lease = w.avatar_asset_changes.lock().unwrap();
    fs::remove_dir_all(dir.join("avatar").join(&id)).unwrap();
    w.begin_shutdown().unwrap();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let closer = w.clone();
    let thread = std::thread::spawn(move || {
        closer.shutdown().unwrap();
        done_tx.send(()).unwrap();
    });
    assert!(done_rx
        .recv_timeout(std::time::Duration::from_millis(50))
        .is_err());
    assert_eq!(
        w.commit_avatar_assets(vec![], Some(&id)).unwrap()["assets"],
        json!([])
    );
    drop(lease);
    done_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    thread.join().unwrap();
    assert_eq!(w.execute(Operation::AvatarAssets).unwrap_err().status, 503);
    drop(w);
    let w = Workspace::open(&dir).unwrap();
    assert_eq!(reply(&w, Operation::AvatarAssets)["assets"], json!([]));
    w.shutdown().unwrap();
    fs::remove_dir_all(dir).unwrap();
}
