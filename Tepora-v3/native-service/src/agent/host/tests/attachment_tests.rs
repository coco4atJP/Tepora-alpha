use super::*;
use crate::{Operation, Reply};
use base64::{engine::general_purpose::STANDARD, Engine};

fn stage(f: &Fixture, files: Value) -> Vec<Value> {
    match f
        .workspace
        .execute(Operation::InputsStage {
            body: json!({"files":files}),
        })
        .unwrap()
    {
        Reply::Json(value) => value["files"].as_array().unwrap().clone(),
        _ => panic!("staging did not return JSON"),
    }
}
fn png() -> String {
    let mut bytes = vec![
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
    ];
    bytes.extend(2u32.to_be_bytes());
    bytes.extend(3u32.to_be_bytes());
    bytes.push(0);
    STANDARD.encode(bytes)
}
fn request(f: &Fixture, body: Value) -> Value {
    f.handle.request(AgentRequest::Input { body }).unwrap()
}

#[test]
fn selected_text_and_image_are_delivered_with_local_receipts() {
    let mut f = Fixture::new(|_, _, _| answer("ATTACHMENTS_RECEIVED"));
    let text = json_codec::from_utf16_units(&[97, 0xd800, 0xe000]);
    let picture = png();
    let files = stage(
        &f,
        json!([{"name":"note?.txt","content":text},{"name":"picture.png","base64":picture}]),
    );
    let id = f.main()["id"].as_str().unwrap().to_owned();
    let body = json!({"text":"  Read these selected files  ","requestId":"attachment-request","source":"voice","attachmentIds":files.iter().map(|v|v["id"].clone()).collect::<Vec<_>>()});
    let accepted = request(&f, body.clone());
    assert_eq!(accepted["sessionId"], id);
    f.transport.wait_requests(1);
    f.idle(&id);
    let entries = f.entries(&id);
    let input = entries.iter().find(|e| e["type"] == "input").unwrap();
    assert_eq!(input["source"], "voice");
    assert_eq!(input["from"], "user");
    assert!(input["header"].as_str().unwrap().contains("user via voice"));
    assert_eq!(input["attachments"].as_array().unwrap().len(), 2);
    assert_eq!(input["attachments"][0]["name"], "note?.txt");
    let path = input["attachments"][0]["path"].as_str().unwrap();
    assert!(path.ends_with("note_.txt"));
    assert_eq!(
        fs::read(json_codec::sql_text(path)).unwrap(),
        json_codec::sql_text(&text).as_bytes()
    );
    assert_eq!(
        input["text"],
        format!(
            "Read these selected files\n\n[添付ファイル（このPCに保存済み）: {}, {}]",
            path,
            input["attachments"][1]["path"].as_str().unwrap()
        )
    );
    assert_eq!(input["images"].as_array().unwrap().len(), 1);
    assert_eq!(input["images"][0]["base64"], picture);
    let wire = f.transport.requests.lock().unwrap()[0].clone();
    let content = wire["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|m| {
            m["content"]
                .as_array()
                .filter(|parts| parts.iter().any(|p| p["type"] == "image_url"))
        })
        .unwrap();
    let image = content
        .iter()
        .find(|part| part["type"] == "image_url")
        .unwrap();
    assert_eq!(
        image["image_url"]["url"],
        format!("data:image/png;base64,{picture}")
    );
    assert_eq!(request(&f, body), accepted);
    assert_eq!(
        f.entries(&id)
            .iter()
            .filter(|e| e["type"] == "input")
            .count(),
        1
    );
    f.close();
}

#[test]
fn concurrent_same_request_id_copies_and_enqueues_once() {
    let mut f = Fixture::new(|_, _, _| answer("deduplicated"));
    let staged = stage(&f, json!([{"name":"once.txt","content":"once"}]));
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let mut requests = Vec::new();
    for _ in 0..2 {
        let handle = f.handle.clone();
        let wait = barrier.clone();
        let file = staged[0]["id"].clone();
        requests.push(thread::spawn(move || {
            wait.wait();
            handle.request(AgentRequest::Input {
                body: json!({"text":"once","requestId":"same-file-request","attachmentIds":[file]}),
            })
        }));
    }
    barrier.wait();
    let values = requests
        .into_iter()
        .map(|t| t.join().unwrap().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(values[0], values[1]);
    let id = f.main()["id"].as_str().unwrap().to_owned();
    f.transport.wait_requests(1);
    f.idle(&id);
    let inputs = f
        .entries(&id)
        .into_iter()
        .filter(|e| e["type"] == "input")
        .collect::<Vec<_>>();
    assert_eq!(inputs.len(), 1);
    let path = PathBuf::from(json_codec::sql_text(
        inputs[0]["attachments"][0]["path"].as_str().unwrap(),
    ));
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    f.close();
}

#[cfg(unix)]
#[test]
fn repeated_attachment_selection_gets_collision_suffix_without_overwrite() {
    let mut f = Fixture::new(|_, _, _| answer("saved"));
    let files = stage(&f, json!([{"name":"copy.md","content":"source"}]));
    let id = f.main()["id"].as_str().unwrap().to_owned();
    for n in 0..2 {
        request(
            &f,
            json!({"text":"copy selected document","requestId":format!("copy-request-{n}"),"attachmentIds":[files[0]["id"]]}),
        );
    }
    f.wait("two attachment inputs", || {
        f.entries(&id)
            .iter()
            .filter(|e| e["type"] == "input")
            .count()
            == 2
    });
    f.idle(&id);
    let paths = f
        .entries(&id)
        .into_iter()
        .filter(|e| e["type"] == "input")
        .map(|e| e["attachments"][0]["path"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert!(paths[0].ends_with("copy.md"));
    assert!(paths[1].ends_with("copy-1.md"));
    for path in paths {
        assert_eq!(
            fs::read_to_string(json_codec::sql_text(&path)).unwrap(),
            "source"
        );
    }
    f.close();
}

#[test]
fn concurrent_synchronous_http_style_inputs_finish_with_one_blocking_worker() {
    let dir = std::env::temp_dir().join(format!("tepora-attachment-pool-{}", uuid::Uuid::new_v4()));
    let mut f =
        Fixture::open_with_blocking(dir, ScriptedTransport::new(|_, _, _| answer("saved")), 1);
    let staged = stage(
        &f,
        json!([{"name":"bounded.txt","content":"filesystem worker finished"}]),
    );
    let runtime = f.runtime.as_ref().unwrap();
    let mut tasks = Vec::new();
    for index in 0..4 {
        let handle = f.handle.clone();
        let attachment = staged[0]["id"].clone();
        tasks.push(runtime.spawn_blocking(move||handle.request(AgentRequest::Input{body:json!({"text":"save this attachment","attachmentIds":[attachment],"requestId":format!("pool-request-{index}")})})));
    }
    let answers = runtime
        .block_on(async {
            tokio::time::timeout(
                Duration::from_secs(5),
                futures_util::future::join_all(tasks),
            )
            .await
        })
        .expect("Synchronous HTTP waiters starved attachment preparation");
    for answer in answers {
        assert_eq!(answer.unwrap().unwrap()["accepted"], true);
    }
    let id = f.main()["id"].as_str().unwrap().to_owned();
    f.wait("four materialized inputs", || {
        f.entries(&id)
            .iter()
            .filter(|e| e["type"] == "input")
            .count()
            == 4
    });
    f.idle(&id);
    let inputs = f
        .entries(&id)
        .into_iter()
        .filter(|e| e["type"] == "input")
        .collect::<Vec<_>>();
    let mut paths = std::collections::HashSet::new();
    for input in inputs {
        let path = input["attachments"][0]["path"].as_str().unwrap();
        assert!(paths.insert(path.to_owned()));
        assert_eq!(
            fs::read_to_string(json_codec::sql_text(path)).unwrap(),
            "filesystem worker finished"
        );
    }
    f.close();
}

// Provenance: staged synthetic PNG header bytes, real Workspace/actor/context,
// loopback-only scripted transport. No external vision service is permitted.
#[test]
fn nonvision_profile_keeps_attachment_receipt_without_calling_a_vision_bridge() {
    let mut f = Fixture::new(|_, _, body| {
        assert!(!json_codec::stringify_js(body).unwrap().contains("data:image/"));
        answer("TEXT_ONLY_ATTACHMENT")
    });
    let profiles = f.host.provider.get().unwrap()["profiles"].as_array().unwrap().clone();
    for profile in profiles { f.host.provider.learn_no_vision(&profile).unwrap(); }
    let files = stage(&f, json!([{"name":"local.png","base64":png()}]));
    let id = f.main()["id"].as_str().unwrap().to_owned();
    request(&f, json!({"text":"Handle my selected image","attachmentIds":[files[0]["id"]]}));
    f.transport.wait_requests(1);
    f.idle(&id);
    let entries = f.entries(&id);
    let input = entries.iter().find(|e|e["type"]=="input").unwrap();
    assert_eq!(input["attachments"].as_array().unwrap().len(), 1);
    assert_eq!(input["images"].as_array().unwrap().len(), 1);
    assert_eq!(f.transport.requests.lock().unwrap().len(), 1);
    f.close();
}
