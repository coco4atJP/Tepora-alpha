use super::*;
fn outcome(result: Result<Value, ApiError>) -> Value {
    match result {
        Ok(value) => {
            json!({"wire":json_codec::encode_text(&json_codec::stringify_js(&value).unwrap())})
        }
        Err(error) => json!({"status":error.status,"message":error.message}),
    }
}
fn action(method: &str) -> VisualAction {
    match method {
        "get" => VisualAction::Get,
        "change" => VisualAction::Change,
        "undo" => VisualAction::Undo,
        "reset" => VisualAction::Reset,
        "export" => VisualAction::Export,
        "import" => VisualAction::Import,
        _ => panic!("unknown visual method"),
    }
}
fn request(method: &str, args: &[Value]) -> Value {
    let first = args.first().cloned().unwrap_or(Value::Null);
    let expected = args.get(1).cloned().unwrap_or(Value::Null);
    match method {
        "change" => json!({"patch":first,"expectedRevision":expected}),
        "import" => json!({"preset":first,"expectedRevision":expected}),
        "undo" | "reset" => json!({"expectedRevision":first}),
        _ => json!({}),
    }
}
#[test]
fn frozen_display_avatar_values_errors_order_history_and_metadata_match_source() {
    let fixtures = json_codec::parse(include_str!("fixtures/source.json")).unwrap();
    for case in fixtures["cases"].as_array().unwrap() {
        let kind = if case["kind"] == "display" {
            Kind::Display
        } else {
            Kind::Avatar
        };
        match case["op"].as_str().unwrap() {
            "validate" => {
                let result = outcome(match kind {
                    Kind::Display => validate_display(&case["input"], &case["previous"]),
                    Kind::Avatar => validate_avatar(&case["input"], &case["previous"]),
                });
                assert_eq!(
                    json_codec::stringify_js(&result).unwrap(),
                    json_codec::stringify_js(&case["expected"]).unwrap(),
                    "{}",
                    case["name"]
                );
            }
            "default" => assert_eq!(
                json_codec::stringify_js(&outcome(Ok(default_avatar(&case["body"])))).unwrap(),
                json_codec::stringify_js(&case["expected"]).unwrap(),
                "{}",
                case["name"]
            ),
            "state" => {
                let mut values = case["initial"].as_object().unwrap().clone();
                let mut events = Vec::new();
                let mut results = Vec::new();
                for step in case["steps"].as_array().unwrap() {
                    let method = step["method"].as_str().unwrap();
                    let args = step["args"]
                        .as_array()
                        .map(Vec::as_slice)
                        .unwrap_or_default();
                    let history_key = format!("{}-history", kind.key());
                    let raw = values.get(kind.key()).unwrap_or(&Value::Null);
                    let current = if truth(raw) {
                        raw.clone()
                    } else {
                        default_config(kind)
                    };
                    let result = plan(
                        kind,
                        action(method),
                        &request(method, args),
                        &current,
                        values.get(&history_key).unwrap_or(&Value::Null),
                        &case["assets"],
                    );
                    results.push(outcome(result.map(|planned| {
                        if let Some((next, history)) = planned.mutation {
                            values.insert(history_key, history);
                            values.insert(kind.key().into(), next.clone());
                            events
                                .push(json!({"type":format!("{}.updated",kind.key()),"data":next}));
                        }
                        planned.value
                    })));
                }
                assert_eq!(
                    json_codec::stringify_js(&json!(results)).unwrap(),
                    json_codec::stringify_js(&case["expected"]).unwrap(),
                    "{}",
                    case["name"]
                );
                assert_eq!(
                    Value::Object(values),
                    case["final"]["values"],
                    "{}",
                    case["name"]
                );
                assert_eq!(json!(events), case["final"]["events"], "{}", case["name"]);
            }
            _ => panic!("unknown fixture"),
        }
    }
}
struct Fixture {
    workspace: Workspace,
    dir: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = env::temp_dir().join(format!("tepora-visual-config-{}", Uuid::new_v4()));
        Self {
            workspace: Workspace::open(&dir).unwrap(),
            dir,
        }
    }
    fn run(&self, kind: Kind, action: VisualAction, body: Value) -> Result<Value, ApiError> {
        let op = if kind == Kind::Display {
            Operation::Display { action, body }
        } else {
            Operation::Avatar { action, body }
        };
        match self.workspace.execute_visual(&op)?.unwrap() {
            Reply::Json(value) => Ok(value),
            _ => panic!("visual operation returned non-JSON"),
        }
    }
    fn events(&self) -> Vec<Value> {
        self.workspace
            .lock()
            .unwrap()
            .call("event.replay", json!({"since":0}))
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| {
                matches!(
                    e["type"].as_str(),
                    Some("display.updated" | "avatar.updated")
                )
            })
            .cloned()
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.workspace.shutdown();
        let _ = fs::remove_dir_all(&self.dir);
    }
}
#[test]
fn actual_workspace_visual_config_history_events_and_cas_are_atomic() {
    for kind in [Kind::Display, Kind::Avatar] {
        let f = Fixture::new();
        let old = f.run(kind, VisualAction::Get, json!({})).unwrap();
        let patch = if kind == Kind::Display {
            json!({"theme":"dark"})
        } else {
            json!({"body":"kokedama"})
        };
        let next = f
            .run(
                kind,
                VisualAction::Change,
                json!({"patch":patch,"expectedRevision":0.0}),
            )
            .unwrap();
        assert_eq!(next["revision"], 1);
        assert_eq!(
            f.run(
                kind,
                VisualAction::Change,
                json!({"patch":patch,"expectedRevision":0})
            )
            .unwrap_err()
            .status,
            409
        );
        assert_eq!(
            f.workspace
                .lock()
                .unwrap()
                .value(&format!("{}-history", kind.key()))
                .unwrap(),
            json!([old])
        );
        assert_eq!(f.events().len(), 1);
        assert_eq!(f.events()[0]["data"], next);
        let undone = f
            .run(kind, VisualAction::Undo, json!({"expectedRevision":1}))
            .unwrap();
        assert_eq!(undone["revision"], 2);
        let mut expected = old;
        expected["revision"] = json!(2);
        assert_eq!(undone, expected);
        assert_eq!(f.events().len(), 2);
        f.workspace.shutdown().unwrap();
        let reopened = Workspace::open(&f.dir).unwrap();
        assert_eq!(reopened.lock().unwrap().value(kind.key()).unwrap(), undone);
        reopened.shutdown().unwrap();
    }
}
#[test]
fn visual_event_write_failure_rolls_back_history_config_and_live_publication() {
    for kind in [Kind::Display, Kind::Avatar] {
        let f = Fixture::new();
        let mut subscriber = f
            .workspace
            .subscribe(EventRequest {
                since: 0,
                reconnect: false,
            })
            .unwrap();
        let sql=format!("CREATE TRIGGER reject_visual BEFORE INSERT ON events WHEN NEW.type='{}.updated' BEGIN SELECT RAISE(ABORT,'fixture rejects visual event'); END",kind.key());
        f.workspace
            .lock()
            .unwrap()
            .call("exec", json!({"sql":sql}))
            .unwrap();
        let patch = if kind == Kind::Display {
            json!({"theme":"dark"})
        } else {
            json!({"body":"andon"})
        };
        assert!(f
            .run(
                kind,
                VisualAction::Change,
                json!({"patch":patch,"expectedRevision":0})
            )
            .is_err());
        assert!(f
            .workspace
            .lock()
            .unwrap()
            .value(kind.key())
            .unwrap()
            .is_null());
        assert!(f
            .workspace
            .lock()
            .unwrap()
            .value(&format!("{}-history", kind.key()))
            .unwrap()
            .is_null());
        assert!(f.events().is_empty());
        assert!(subscriber.receiver.try_recv().is_err());
        f.workspace
            .lock()
            .unwrap()
            .call("exec", json!({"sql":"DROP TRIGGER reject_visual"}))
            .unwrap();
        assert_eq!(
            f.run(kind, VisualAction::Reset, json!({"expectedRevision":0}))
                .unwrap()["revision"],
            1
        );
        let event = subscriber.receiver.try_recv().unwrap();
        assert_eq!(event.event_type, format!("{}.updated", kind.key()));
        f.workspace.unsubscribe(subscriber.id);
    }
}
#[test]
fn avatar_metadata_only_selection_and_missing_asset_undo_keep_import_authority_local() {
    let f = Fixture::new();
    let id = "a".repeat(36);
    f.workspace
        .lock()
        .unwrap()
        .set_value("avatar-assets", json!([{"id":id,"kind":"image"}]))
        .unwrap();
    let selected=f.run(Kind::Avatar,VisualAction::Import,json!({"expectedRevision":0,"preset":{"format":"tepora-avatar","version":1,"settings":{"body":"image"}}})).unwrap();
    assert_eq!(selected["asset"], id);
    let export = f
        .run(Kind::Avatar, VisualAction::Export, json!({}))
        .unwrap();
    assert!(export["settings"].get("asset").is_none());
    f.run(
        Kind::Avatar,
        VisualAction::Change,
        json!({"expectedRevision":1,"patch":{"body":"shiro"}}),
    )
    .unwrap();
    f.workspace
        .lock()
        .unwrap()
        .set_value("avatar-assets", json!([]))
        .unwrap();
    let undone = f
        .run(
            Kind::Avatar,
            VisualAction::Undo,
            json!({"expectedRevision":2}),
        )
        .unwrap();
    assert_eq!(undone["body"], "shiro");
    assert!(undone["asset"].is_null());
    assert_eq!(undone["revision"], 3);
    assert_eq!(f.run(Kind::Avatar,VisualAction::Import,json!({"expectedRevision":3,"preset":{"format":"tepora-avatar","version":1,"settings":{"body":"image","asset":id}}})).unwrap_err().status,400);
    assert_eq!(f.run(Kind::Avatar,VisualAction::Import,json!({"expectedRevision":3,"preset":{"format":"tepora-avatar","version":1,"settings":{"body":"image"}}})).unwrap_err().status,409);
}
#[test]
fn visual_presets_cannot_modify_personas_or_permissions() {
    let f = Fixture::new();
    let settings = f.workspace.lock().unwrap().settings().unwrap();
    let personas = f.workspace.lock().unwrap().personas().unwrap();
    for kind in [Kind::Display, Kind::Avatar] {
        for body in [
            json!({"expectedRevision":0,"patch":{"allowNetwork":true}}),
            json!({"expectedRevision":0,"patch":{"persona":{"name":"changed"}}}),
        ] {
            assert_eq!(
                f.run(kind, VisualAction::Change, body).unwrap_err().status,
                400
            );
        }
        assert_eq!(f.run(kind,VisualAction::Import,json!({"expectedRevision":0,"preset":{"format":format!("tepora-{}",kind.key()),"version":1,"settings":{},"capabilities":{"allow":true}}})).unwrap_err().status,400);
    }
    assert_eq!(f.workspace.lock().unwrap().settings().unwrap(), settings);
    assert_eq!(f.workspace.lock().unwrap().personas().unwrap(), personas);
    assert!(f.events().is_empty());
}
