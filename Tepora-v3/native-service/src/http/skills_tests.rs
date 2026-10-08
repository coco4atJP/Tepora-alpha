// Only ordinary, inert SQLite skill documents; no discovery or execution.
#[tokio::test]
async fn skills_routes_are_agent_only_and_keep_raw_ids_status_and_json_codec() {
    let fake = Arc::new(Fake::default());
    let active = agent_state(fake.clone());
    for (method, path, status, variant) in [
        ("POST", "/api/skills", 201, "SkillCreate"),
        ("PATCH", "/api/skills/synthetic%20id", 200, "SkillPatch"),
        ("DELETE", "/api/skills/synthetic%20id", 200, "SkillDelete"),
    ] {
        // Workspace-only admission happens before JSON consumption, as for
        // persona changes: it never persists a write without session refresh.
        assert_eq!(
            state(fake.clone())
                .handle(request(method, path, "{invalid"))
                .await
                .status(),
            503
        );
        let response = active
            .clone()
            .handle(request(
                method,
                path,
                r#"{"enabled":true,"content":"x\ud800\ue000"}"#,
            ))
            .await;
        assert_eq!(response.status(), status);
        let call = format!("{:?}", fake.calls.lock().unwrap().last().unwrap());
        assert!(call.starts_with(variant));
        if method != "POST" {
            assert!(call.contains("synthetic%20id"));
        }
        if method != "DELETE" {
            let body = bytes(response).await;
            let value =
                tepora_core::json_codec::parse(std::str::from_utf8(&body).unwrap()).unwrap();
            assert_eq!(
                value["content"],
                tepora_core::json_codec::parse(r#""x\ud800\ue000""#).unwrap()
            );
        }
    }
    let before = fake.calls.lock().unwrap().len();
    for (method, path) in [
        ("GET", "/api/skills"),
        ("PUT", "/api/skills"),
        ("POST", "/api/skills/id"),
        ("PATCH", "/api/skills/"),
        ("DELETE", "/api/skills/a/b"),
    ] {
        assert_eq!(
            active
                .clone()
                .handle(request(method, path, "{}"))
                .await
                .status(),
            404
        );
    }
    assert_eq!(fake.calls.lock().unwrap().len(), before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn skills_http_refreshes_real_actor_snapshots_and_preserves_cached_prefix() {
    use crate::workspace::Workspace;
    use tepora_core::json_codec;
    let dir = std::env::temp_dir().join(format!("tepora-skills-http-{}", uuid::Uuid::new_v4()));
    let workspace = Arc::new(Workspace::open(&dir).unwrap());
    workspace
        .enable_agent(tokio::runtime::Handle::current())
        .unwrap();
    let access = workspace.access();
    let main = access.agent_state("main", json!({})).unwrap();
    let id = main["id"].as_str().unwrap();
    // An old declared tool list makes the saved skill index visible in the
    // pure renderer. No skill tool dispatch is attempted or made available.
    access.agent_state("session.update",json!({"id":id,"patch":{"system":"stable cached prefix","tools":["skill"],"status":"idle"}})).unwrap();
    for (session, status, system) in [
        ("done-fixture", "done", "stable"),
        ("stopped-fixture", "stopped", "stable"),
        ("unprompted-fixture", "idle", ""),
    ] {
        access.agent_state("session.create",json!({"kind":"worker","id":session,"extra":{"status":status,"system":system,"tools":["skill"]}})).unwrap();
    }
    let mut sub = workspace
        .subscribe(EventRequest {
            since: 0,
            reconnect: false,
        })
        .unwrap();
    let mut http = agent_state(Arc::new(Fake::default()));
    Arc::get_mut(&mut http).unwrap().backend = workspace.clone();
    let response=http.clone().handle(request("POST","/api/skills",r#"{"name":"Synthetic active index","description":"Inert metadata","content":"This fixture is never loaded or executed."}"#)).await;
    assert_eq!(response.status(), 201);
    let body = bytes(response).await;
    let doc = json_codec::parse(std::str::from_utf8(&body).unwrap()).unwrap();
    let mut events = vec![];
    while let Ok(e) = sub.receiver.try_recv() {
        events.push(e);
    }
    let changed = events
        .iter()
        .position(|e| e.event_type == "skill.updated")
        .unwrap();
    let notice = events
        .iter()
        .position(|e| e.event_type == "session.entry" && e.data["entry"]["promptUpdate"] == true)
        .unwrap();
    assert!(changed < notice, "skill event precedes refresh notice");
    let snapshot = || access.agent_state("session.get", json!({"id":id})).unwrap();
    assert_eq!(snapshot()["system"], "stable cached prefix");
    assert_eq!(snapshot()["tools"], json!(["skill"]));
    assert_eq!(snapshot()["promptStale"], true);
    assert!(snapshot()["announced"]["system"]
        .as_str()
        .unwrap()
        .contains("Synthetic active index: Inert metadata"));
    assert!(!snapshot()["announced"]["system"]
        .as_str()
        .unwrap()
        .contains("This fixture is never loaded"));
    assert!(
        !snapshot()["announced"]["tools"]
            .as_array()
            .unwrap()
            .contains(&json!("skill")),
        "content loading stays unavailable"
    );
    let path = format!("/api/skills/{}", doc["id"].as_str().unwrap());
    for enabled in [false, true] {
        let body = format!(r#"{{"enabled":{enabled}}}"#);
        assert_eq!(
            http.clone()
                .handle(request("PATCH", &path, body))
                .await
                .status(),
            200
        );
        assert_eq!(
            snapshot()["announced"]["system"]
                .as_str()
                .unwrap()
                .contains("Synthetic active index"),
            enabled
        );
    }
    assert_eq!(
        http.clone()
            .handle(request("DELETE", &path, "{ignored"))
            .await
            .status(),
        200
    );
    assert!(!snapshot()["announced"]["system"]
        .as_str()
        .unwrap()
        .contains("Synthetic active index"));
    let entries = access
        .agent_state("session.tail", json!({"id":id,"limit":20}))
        .unwrap();
    assert_eq!(
        entries
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["promptUpdate"] == true)
            .count(),
        4
    );
    assert_eq!(
        http.clone()
            .handle(request("DELETE", &path, ""))
            .await
            .status(),
        200
    );
    assert_eq!(
        access
            .agent_state("session.tail", json!({"id":id,"limit":20}))
            .unwrap(),
        entries,
        "unchanged missing delete must not duplicate the instruction update"
    );
    for session in ["done-fixture", "stopped-fixture", "unprompted-fixture"] {
        assert_eq!(
            access
                .agent_state("session.tail", json!({"id":session,"limit":20}))
                .unwrap(),
            json!([])
        );
    }
    workspace.unsubscribe(sub.id);
    let closing = workspace.clone();
    tokio::task::spawn_blocking(move || closing.shutdown())
        .await
        .unwrap()
        .unwrap();
    drop(http);
    drop(access);
    drop(workspace);
    std::fs::remove_dir_all(dir).unwrap();
}
