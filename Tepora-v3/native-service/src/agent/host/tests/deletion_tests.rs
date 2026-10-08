use super::*;
fn worker(f: &Fixture, id: &str, parent: Value) -> Value {
    f.state("session.create",json!({"fields":{"id":id,"kind":"worker","title":"Deletion fixture","parentId":parent,"cwd":f.main()["cwd"]}}))
}
#[test]
fn deletion_rejects_main_and_active_session_then_removes_only_owned_storage() {
    let mut f = Fixture::new(|_, _, _| Response::Block);
    let main = f.main()["id"].as_str().unwrap().to_owned();
    assert_eq!(
        f.handle
            .request(AgentRequest::DeleteSession { id: main.clone() })
            .unwrap_err()
            .status,
        403
    );
    assert_eq!(
        f.handle
            .request(AgentRequest::DeleteSession {
                id: "missing".into()
            })
            .unwrap_err()
            .status,
        404
    );
    let busy = f
        .handle
        .request(AgentRequest::Spawn {
            body: json!({"task":"Wait for the controlled fixture","title":"Busy deletion target"}),
        })
        .unwrap();
    let busy_id = busy["id"].as_str().unwrap().to_owned();
    f.transport.wait_requests(1);
    assert_eq!(
        f.handle
            .request(AgentRequest::DeleteSession {
                id: busy_id.clone()
            })
            .unwrap_err()
            .status,
        409
    );
    f.handle
        .request(AgentRequest::Stop {
            id: busy_id.clone(),
            reason: "fixture stop".into(),
            rearm_main: false,
        })
        .unwrap();
    f.idle(&busy_id);
    let id = "delete-storage";
    worker(&f, id, json!(main));
    worker(&f, "child-retained", json!(id));
    f.state(
        "session.append",
        json!({"id":id,"type":"input","body":{"text":"searchable deletion evidence"}}),
    );
    f.state(
        "inbox.enqueue",
        json!({"id":id,"input":{"id":"delete-inbox","text":"pending"}}),
    );
    f.state(
        "evidence.put",
        json!({"id":"delete-evidence","sessionId":id,"seq":1,"tool":"read","content":"stored"}),
    );
    let file = PathBuf::from(json_codec::sql_text(f.main()["cwd"].as_str().unwrap()))
        .join("kept-result.txt");
    fs::write(&file, "keep actual files").unwrap();
    let mut events = f
        .workspace
        .subscribe(EventRequest {
            since: 0,
            reconnect: false,
        })
        .unwrap();
    assert_eq!(
        f.handle
            .request(AgentRequest::DeleteSession { id: id.into() })
            .unwrap(),
        json!({"deleted":true})
    );
    assert!(f.state("session.get", json!({"id":id})).is_null());
    assert_eq!(f.state("session.entries", json!({"id":id})), json!([]));
    assert_eq!(f.state("inbox.pending", json!({"id":id})), json!([]));
    assert!(f
        .state("evidence.get", json!({"id":"delete-evidence"}))
        .is_null());
    assert!(!f
        .state("session.get", json!({"id":"child-retained"}))
        .is_null());
    assert!(!f.state("session.get", json!({"id":main})).is_null());
    assert_eq!(fs::read_to_string(file).unwrap(), "keep actual files");
    let mut removed = Vec::new();
    while let Ok(event) = events.receiver.try_recv() {
        if event.event_type == "session.removed" {
            removed.push(event.data.clone());
        }
    }
    assert_eq!(removed, vec![json!({"id":id})]);
    f.close();
}
#[cfg(unix)]
#[test]
fn deletion_reserves_session_against_resume_send_and_global_admission_until_process_drain() {
    let mut f = Fixture::new(|_, _, _| panic!("Reserved deletion must not call a model"));
    let id = "delete-process";
    let session = worker(&f, id, Value::Null);
    let cwd = PathBuf::from(json_codec::sql_text(session["cwd"].as_str().unwrap()));
    let process = f
        .runtime
        .as_ref()
        .unwrap()
        .block_on(f.host.process_host.manager().start(
            super::super::super::processes::StartRequest::new(
                "trap '' TERM; printf ready > delete-ready.txt; /bin/sleep 10",
                id,
                &cwd,
            ),
            &RequestCancellation::new(),
        ))
        .unwrap();
    f.wait("process startup", || cwd.join("delete-ready.txt").exists());
    f.state(
        "session.append",
        json!({"id":id,"type":"input","body":{"text":"would run if not reserved"}}),
    );
    let handle = f.handle.clone();
    let deletion =
        thread::spawn(move || handle.request(AgentRequest::DeleteSession { id: id.into() }));
    f.wait("deletion reservation", || {
        f.handle.state(id).unwrap()["pending"] == 1
    });
    assert!(!deletion.is_finished());
    assert!(!f.state("session.get", json!({"id":id})).is_null());
    assert_eq!(
        f.handle
            .request(AgentRequest::Resume { id: id.into() })
            .unwrap_err()
            .status,
        409
    );
    assert_eq!(
        f.handle
            .request(AgentRequest::Send {
                id: id.into(),
                body: json!({"text":"race"})
            })
            .unwrap_err()
            .status,
        409
    );
    f.handle.request(AgentRequest::Initialize).unwrap();
    assert_eq!(f.transport.requests.lock().unwrap().len(), 0);
    assert_eq!(deletion.join().unwrap().unwrap(), json!({"deleted":true}));
    assert_eq!(process.snapshot().status, "killed");
    assert!(f.state("session.get", json!({"id":id})).is_null());
    f.close();
}
