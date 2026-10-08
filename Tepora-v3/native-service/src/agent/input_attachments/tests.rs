use super::*;
use tepora_core::json_codec;
struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("tepora-attachment-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn logical(&self) -> String {
        json_codec::encode_text(&self.0.to_string_lossy())
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn text_doc(name: &str, content: &str) -> Value {
    let bytes = sql_text(content).into_bytes();
    json!({"id":"staged","name":name,"content":content,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes))})
}
fn image_doc(name: &str, side: u32) -> Value {
    let mut bytes = vec![
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
    ];
    bytes.extend(side.to_be_bytes());
    bytes.extend(1u32.to_be_bytes());
    bytes.push(0);
    inspect_image(&STANDARD.encode(bytes), name).unwrap()
}
#[tokio::test]
async fn writes_actual_bytes_and_preserves_logical_utf16_paths_and_names() {
    let root = Root::new();
    let name = from_utf16_units(&[0xd800, 0xe000, 46, 116, 120, 116]);
    let content = from_utf16_units(&[0xdfff, 0xe000, 0xe100]);
    let value = materialize(
        root.logical(),
        "2026-10-07".into(),
        vec![text_doc(&name, &content)],
        RequestCancellation::new(),
    )
    .await
    .unwrap();
    let file = &value["files"][0];
    assert_eq!(file["name"], name);
    assert_eq!(file["kind"], "text");
    assert!(file["path"].as_str().unwrap().ends_with(&name));
    assert_eq!(
        fs::read(sql_text(file["path"].as_str().unwrap())).unwrap(),
        sql_text(&content).as_bytes()
    );
    assert_eq!(value["images"], json!([]));
    assert_eq!(
        file.as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["path", "name", "kind"]
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_copies_get_exclusive_collision_names_and_preserve_existing_file() {
    let root = Root::new();
    let folder = root.0.join("inbox/2026-10-07");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("note_.md"), "existing").unwrap();
    let futures = (0..6).map(|n| {
        materialize(
            root.logical(),
            "2026-10-07".into(),
            vec![text_doc("note?.md", &format!("content {n}"))],
            RequestCancellation::new(),
        )
    });
    let results = futures_util::future::join_all(futures).await;
    let mut paths = std::collections::HashSet::new();
    for (n, result) in results.into_iter().enumerate() {
        let result = result.unwrap();
        let path = result["files"][0]["path"].as_str().unwrap();
        assert!(paths.insert(path.to_owned()));
        assert_eq!(result["files"][0]["name"], "note?.md");
        assert_eq!(
            fs::read_to_string(sql_text(path)).unwrap(),
            format!("content {n}")
        );
    }
    assert_eq!(
        fs::read_to_string(folder.join("note_.md")).unwrap(),
        "existing"
    );
    for n in 1..=6 {
        assert!(folder.join(format!("note_-{n}.md")).exists());
    }
}
#[cfg(not(target_os = "macos"))]
#[tokio::test]
async fn first_four_image_candidates_are_selected_before_large_image_load_failures() {
    let root = Root::new();
    let docs = (0..6)
        .map(|n| image_doc(&format!("image-{n}.png"), if n == 0 { 1569 } else { 2 }))
        .collect();
    let result = materialize(
        root.logical(),
        "2026-10-07".into(),
        docs,
        RequestCancellation::new(),
    )
    .await
    .unwrap();
    assert_eq!(result["files"].as_array().unwrap().len(), 6);
    assert_eq!(result["images"].as_array().unwrap().len(), 3);
    assert_eq!(
        result["images"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["image-1.png", "image-2.png", "image-3.png"]
    );
    for image in result["images"].as_array().unwrap() {
        assert_eq!(image["mime"], "image/png");
        assert_eq!(image["width"], 2);
        assert_eq!(image["height"], 1);
        let bytes = STANDARD.decode(image["base64"].as_str().unwrap()).unwrap();
        assert_eq!(
            bytes,
            fs::read(
                root.0
                    .join("inbox/2026-10-07")
                    .join(image["name"].as_str().unwrap())
            )
            .unwrap()
        );
    }
}
#[tokio::test]
async fn queued_filesystem_preparation_can_cancel_without_starting_a_thread() {
    let permits = FILESYSTEM_WORKERS.acquire_many(4).await.unwrap();
    let cancel = RequestCancellation::new();
    let token = cancel.clone();
    let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = started.clone();
    let task = tokio::spawn(async move {
        filesystem_task(&token, move || {
            observed.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        })
        .await
    });
    tokio::task::yield_now().await;
    cancel.cancel();
    let error = tokio::time::timeout(std::time::Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.status, 503);
    assert!(!started.load(std::sync::atomic::Ordering::SeqCst));
    drop(permits);
}

#[test]
fn saturated_tokio_blocking_pool_does_not_starve_attachment_filesystem_work() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let root = Root::new();
    let root_text = root.logical();
    let handle = runtime.handle().clone();
    // This models synchronous native HTTP admission occupying the only blocking
    // worker while its async filesystem effect must still be able to finish.
    let request = runtime.spawn_blocking(move || {
        handle.block_on(materialize(
            root_text,
            "2026-10-07".into(),
            vec![text_doc("pool.txt", "prepared")],
            RequestCancellation::new(),
        ))
    });
    let result = runtime
        .block_on(async { tokio::time::timeout(std::time::Duration::from_secs(3), request).await })
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        fs::read_to_string(sql_text(result["files"][0]["path"].as_str().unwrap())).unwrap(),
        "prepared"
    );
}
