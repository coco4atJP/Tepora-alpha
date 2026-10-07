// Included in http.rs's existing test module to exercise its real request/auth path.
#[tokio::test]
async fn visual_routes_are_state_operations_in_both_native_modes_with_exact_methods() {
    use crate::workspace::VisualAction;
    for agent in [false, true] {
        let fake = Arc::new(Fake::default());
        let state = if agent {
            agent_state(fake.clone())
        } else {
            state(fake.clone())
        };
        for kind in ["display", "avatar"] {
            for (method, suffix, action) in [
                ("GET", "", VisualAction::Get),
                ("PATCH", "", VisualAction::Change),
                ("POST", "/undo", VisualAction::Undo),
                ("POST", "/reset", VisualAction::Reset),
                ("GET", "/export", VisualAction::Export),
                ("POST", "/import", VisualAction::Import),
            ] {
                let path = format!("/api/{kind}{suffix}");
                let response = state.clone().handle(request(method, &path, "{}")).await;
                assert_eq!(response.status(), 200, "{method} {path}, agent={agent}");
                match fake.calls.lock().unwrap().last().unwrap() {
                    Operation::Display { action: actual, .. } if kind == "display" => {
                        assert_eq!(*actual, action)
                    }
                    Operation::Avatar { action: actual, .. } if kind == "avatar" => {
                        assert_eq!(*actual, action)
                    }
                    other => panic!("wrong visual operation {other:?}"),
                }
            }
        }
        let count = fake.calls.lock().unwrap().len();
        for (method, path, status) in [
            ("PUT", "/api/display", 404),
            ("POST", "/api/avatar", 404),
            ("PATCH", "/api/avatar/export", 404),
            ("GET", "/api/display/undo", 404),
            ("GET", "/api/avatar/assets", 503),
            ("PUT", "/api/avatar/assets", 503),
            ("GET", "/api/frame", 503),
            ("PUT", "/api/frame/photos", 503),
        ] {
            assert_eq!(
                state
                    .clone()
                    .handle(request(method, path, "{}"))
                    .await
                    .status(),
                status,
                "{method} {path}"
            );
        }
        let mut denied = request("PATCH", "/api/display", "{bad");
        denied.headers_mut().remove("x-tepora-csrf");
        assert_eq!(state.clone().handle(denied).await.status(), 403);
        let mut denied = request("GET", "/api/avatar", "");
        denied.headers_mut().remove("cookie");
        assert_eq!(state.clone().handle(denied).await.status(), 401);
        assert_eq!(fake.calls.lock().unwrap().len(), count);
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn visual_http_persists_cas_history_undo_and_rejects_permission_presets() {
    use crate::workspace::Workspace;
    use tepora_core::json_codec;
    async fn call(http: &Arc<HttpState>, method: &str, path: &str, body: Value) -> (u16, Value) {
        let response = http
            .clone()
            .handle(request(
                method,
                path,
                json_codec::stringify_js(&body).unwrap(),
            ))
            .await;
        let status = response.status().as_u16();
        let bytes = bytes(response).await;
        (
            status,
            json_codec::parse(std::str::from_utf8(&bytes).unwrap()).unwrap(),
        )
    }
    let dir = std::env::temp_dir().join(format!("tepora-visual-http-{}", uuid::Uuid::new_v4()));
    let workspace = Arc::new(Workspace::open(&dir).unwrap());
    let mut http = state(Arc::new(Fake::default()));
    Arc::get_mut(&mut http).unwrap().backend = workspace.clone();
    for kind in ["display", "avatar"] {
        let path = format!("/api/{kind}");
        let (status, initial) = call(&http, "GET", &path, json!({})).await;
        assert_eq!(status, 200);
        assert_eq!(initial["revision"], 0);
        let patch = if kind == "display" {
            json!({"theme":"dark","hiddenUntil":{"clock":"Jan 1 2030"}})
        } else {
            json!({"body":"kitsune","lamp":{"hue":"plum"}})
        };
        let (status, changed) = call(
            &http,
            "PATCH",
            &path,
            json!({"expectedRevision":0,"patch":patch}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(changed["revision"], 1);
        assert_eq!(
            call(
                &http,
                "PATCH",
                &path,
                json!({"expectedRevision":0,"patch":{}})
            )
            .await
            .0,
            409
        );
        let (status, export) = call(&http, "GET", &format!("{path}/export"), json!({})).await;
        assert_eq!(status, 200);
        assert_eq!(export["format"], format!("tepora-{kind}"));
        assert!(export["settings"].get("revision").is_none());
        let (status, undone) = call(
            &http,
            "POST",
            &format!("{path}/undo"),
            json!({"expectedRevision":1}),
        )
        .await;
        assert_eq!(status, 200);
        let mut expected = initial;
        expected["revision"] = json!(2);
        assert_eq!(undone, expected);
        assert_eq!(call(&http,"POST",&format!("{path}/import"),json!({"expectedRevision":2,"preset":{"format":format!("tepora-{kind}"),"version":1,"settings":{},"permissions":{"all":true}}})).await.0,400);
        let (status, imported) = call(
            &http,
            "POST",
            &format!("{path}/import"),
            json!({"expectedRevision":2,"preset":export}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(imported["revision"], 3);
    }
    workspace.shutdown().unwrap();
    drop(http);
    drop(workspace);
    let reopened = Arc::new(Workspace::open(&dir).unwrap());
    let mut http = state(Arc::new(Fake::default()));
    Arc::get_mut(&mut http).unwrap().backend = reopened.clone();
    assert_eq!(
        call(&http, "GET", "/api/display", json!({})).await.1["theme"],
        "dark"
    );
    assert_eq!(
        call(&http, "GET", "/api/avatar", json!({})).await.1["body"],
        "kitsune"
    );
    reopened.shutdown().unwrap();
    drop(http);
    drop(reopened);
    std::fs::remove_dir_all(dir).unwrap();
}
