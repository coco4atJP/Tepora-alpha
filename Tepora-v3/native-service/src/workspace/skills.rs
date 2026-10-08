//! Ordinary stored skill CRUD. Text is inert: this module does not discover,
//! read or execute skill files, and never creates a second SQLite owner.
use super::*;

fn text(value: &Value, name: &str, max: usize) -> Result<String, ApiError> {
    let value = value
        .as_str()
        .ok_or_else(|| ApiError::bad_request(format!("{name}: 1–{max} characters required")))?;
    let trimmed = preferences::trim_text(value);
    require(
        !trimmed.is_empty() && json_codec::utf16_units(value).len() <= max,
        400,
        &format!("{name}: 1–{max} characters required"),
    )?;
    Ok(trimmed)
}

impl Workspace {
    pub(super) fn change_skill(
        &self,
        operation: &Operation,
        refresh: impl FnOnce() -> Result<(), ApiError>,
    ) -> Result<Value, ApiError> {
        // Order CRUD + prompt refresh as one admission. State is released before
        // entering the existing session actor, which reads fresh owned snapshots.
        let _changes = self
            .skill_changes
            .lock()
            .map_err(|_| ApiError::new(500, "Skill owner unavailable"))?;
        let value = {
            let mut state = self.lock()?;
            require(!state.closed && !state.closing, 503, "Service closing")?;
            let (value, event_type, event_data) = match operation {
                Operation::SkillCreate { body } => {
                    require(
                        !body.is_null(),
                        500,
                        "Cannot read properties of null (reading 'name')",
                    )?;
                    let doc = json!({
                        "id": Uuid::new_v4().to_string(),
                        "name": text(&body["name"], "name", 100)?,
                        "description": text(&body["description"], "description", 1024)?,
                        "content": text(&body["content"], "SKILL.md", 32000)?,
                        "enabled": body["enabled"] != false,
                        "createdAt": now(),
                    });
                    state.put("skill", doc.clone())?;
                    (doc.clone(), "skill.updated", doc)
                }
                Operation::SkillPatch { id, body } => {
                    let mut doc = state.get("skill", id)?;
                    // The source short-circuits on a missing document before
                    // accessing body.enabled, including a JSON-null request.
                    require(!doc.is_null(), 400, "Unknown skill or invalid enabled flag")?;
                    require(
                        !body.is_null(),
                        500,
                        "Cannot read properties of null (reading 'enabled')",
                    )?;
                    require(
                        body["enabled"].is_boolean(),
                        400,
                        "Unknown skill or invalid enabled flag",
                    )?;
                    doc["enabled"] = body["enabled"].clone();
                    state.put("skill", doc.clone())?;
                    (doc.clone(), "skill.updated", doc)
                }
                Operation::SkillDelete { id } => {
                    state.call("document.remove", json!({"kind":"skill","id":id}))?;
                    (json!({"deleted":true}), "skill.deleted", json!({"id":id}))
                }
                _ => unreachable!("Only ordinary skill CRUD enters this owner"),
            };
            // Preserve source partial-failure semantics: the document and its
            // event are durable/published before refresh, even if refresh fails.
            let event = state.call(
                "event.append",
                json!({"type":event_type,"data":event_data,"at":now()}),
            )?;
            state.publish_value(event)?;
            value
        };
        refresh()?;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        workspace: Workspace,
        dir: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = env::temp_dir().join(format!("tepora-skills-{}", Uuid::new_v4()));
            Self {
                workspace: Workspace::open(&dir).unwrap(),
                dir,
            }
        }
        fn create(&self, name: &str) -> Value {
            self.workspace.change_skill(&Operation::SkillCreate { body:json!({"name":name,"description":"Synthetic description","content":"Inert fixture text"}) }, || Ok(())).unwrap()
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
                .filter(|e| e["type"].as_str().is_some_and(|s| s.starts_with("skill.")))
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
    fn skills_text_preserves_ecmascript_trim_and_utf16_bounds() {
        let raw = json_codec::parse(r#""\ufeff \ud800\ue000🌸 \u3000""#).unwrap();
        let expected = json_codec::parse(r#""\ud800\ue000🌸""#).unwrap();
        assert_eq!(
            json!(text(
                &raw,
                "name",
                raw.as_str().map(json_codec::utf16_units).unwrap().len()
            )
            .unwrap()),
            expected
        );
        assert_eq!(
            text(&json!("🌸".repeat(50)), "name", 100).unwrap(),
            "🌸".repeat(50)
        );
        for value in [
            json!("🌸".repeat(50) + "x"),
            json!("x".repeat(100) + " "),
            json!("\u{feff}\u{2029}"),
            json!(null),
            json!(42),
            json!([]),
        ] {
            let error = text(&value, "name", 100).unwrap_err();
            assert_eq!(
                (error.status, error.message),
                (400, "name: 1–100 characters required".into())
            );
        }
        assert_eq!(text(&json!("\u{85}"), "name", 100).unwrap(), "\u{85}");
    }

    #[test]
    fn skills_crud_preserves_fields_document_order_and_event_before_refresh() {
        let f = Fixture::new();
        let first = f.create("First");
        let second = f.create("Second");
        let id = first["id"].as_str().unwrap();
        let mut saved = first.clone();
        saved["extra"] = json!({"inert":"kept"});
        f.workspace
            .lock()
            .unwrap()
            .put("skill", saved.clone())
            .unwrap();
        let mut sub = f
            .workspace
            .subscribe(EventRequest {
                since: 0,
                reconnect: false,
            })
            .unwrap();
        let patched = f
            .workspace
            .change_skill(
                &Operation::SkillPatch {
                    id: id.into(),
                    body: json!({"enabled":false,"name":"ignored"}),
                },
                || {
                    let docs = f.workspace.lock()?.list("skill")?;
                    assert_eq!(docs[0]["id"], second["id"]);
                    assert_eq!(docs[1]["id"], first["id"]);
                    assert_eq!(docs[1]["enabled"], false);
                    assert_eq!(f.events().last().unwrap()["data"]["enabled"], false);
                    let event = sub.receiver.try_recv().unwrap();
                    assert_eq!(event.event_type, "skill.updated");
                    assert_eq!(event.data["id"], id);
                    Ok(())
                },
            )
            .unwrap();
        saved["enabled"] = json!(false);
        assert_eq!(patched, saved);
        assert_eq!(
            patched
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec![
                "id",
                "name",
                "description",
                "content",
                "enabled",
                "createdAt",
                "extra"
            ]
        );
        f.workspace.unsubscribe(sub.id);
        for _ in 0..2 {
            assert_eq!(
                f.workspace
                    .change_skill(&Operation::SkillDelete { id: id.into() }, || {
                        assert!(f.workspace.lock()?.get("skill", id)?.is_null());
                        assert_eq!(f.events().last().unwrap()["type"], "skill.deleted");
                        Ok(())
                    })
                    .unwrap(),
                json!({"deleted":true})
            );
        }
        assert_eq!(
            f.events()
                .iter()
                .map(|e| e["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "skill.updated",
                "skill.updated",
                "skill.updated",
                "skill.deleted",
                "skill.deleted"
            ]
        );
    }

    #[test]
    fn skills_validation_has_source_short_circuit_and_no_mutation_or_refresh() {
        let f = Fixture::new();
        let doc = f.create("Synthetic");
        let id = doc["id"].as_str().unwrap();
        let before = f.events();
        for (operation, status, message) in [
            (
                Operation::SkillPatch {
                    id: "missing".into(),
                    body: Value::Null,
                },
                400,
                "Unknown skill or invalid enabled flag",
            ),
            (
                Operation::SkillPatch {
                    id: id.into(),
                    body: Value::Null,
                },
                500,
                "Cannot read properties of null (reading 'enabled')",
            ),
            (
                Operation::SkillPatch {
                    id: id.into(),
                    body: json!({"enabled":1}),
                },
                400,
                "Unknown skill or invalid enabled flag",
            ),
            (
                Operation::SkillCreate { body: Value::Null },
                500,
                "Cannot read properties of null (reading 'name')",
            ),
            (
                Operation::SkillCreate {
                    body: json!({"name":" ","description":" ","content":" "}),
                },
                400,
                "name: 1–100 characters required",
            ),
            (
                Operation::SkillCreate {
                    body: json!({"name":"ok","description":" ","content":" "}),
                },
                400,
                "description: 1–1024 characters required",
            ),
            (
                Operation::SkillCreate {
                    body: json!({"name":"ok","description":"ok","content":" "}),
                },
                400,
                "SKILL.md: 1–32000 characters required",
            ),
        ] {
            let error = f
                .workspace
                .change_skill(&operation, || panic!("invalid mutation cannot refresh"))
                .unwrap_err();
            assert_eq!((error.status, error.message), (status, message.into()));
        }
        assert_eq!(f.events(), before);
        assert_eq!(f.workspace.lock().unwrap().get("skill", id).unwrap(), doc);
    }

    #[test]
    fn skills_refresh_failure_retains_committed_document_event_and_restart() {
        let f = Fixture::new();
        let err=f.workspace.change_skill(&Operation::SkillCreate{body:json!({"name":"Durable","description":"Synthetic","content":"Inert","enabled":null})},||Err(ApiError::unavailable("refresh unavailable"))).unwrap_err();
        assert_eq!(err.status, 503);
        let events = f.events();
        assert_eq!(events.len(), 1);
        let doc = &events[0]["data"];
        assert_eq!(doc["enabled"], true);
        f.workspace.shutdown().unwrap();
        let restarted = Workspace::open(&f.dir).unwrap();
        assert_eq!(
            restarted
                .lock()
                .unwrap()
                .get("skill", doc["id"].as_str().unwrap())
                .unwrap(),
            *doc
        );
        assert_eq!(
            restarted
                .lock()
                .unwrap()
                .call("event.replay", json!({"since":0}))
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .filter(|e| e["type"] == "skill.updated")
                .count(),
            1
        );
        restarted.shutdown().unwrap();
    }

    #[test]
    fn skills_backend_workspace_mode_rejects_before_mutation() {
        let f = Fixture::new();
        for operation in [
            Operation::SkillCreate { body: json!({}) },
            Operation::SkillPatch {
                id: "artifact-studio".into(),
                body: json!({"enabled":false}),
            },
            Operation::SkillDelete {
                id: "artifact-studio".into(),
            },
        ] {
            assert_eq!(f.workspace.execute(operation).unwrap_err().status, 503);
        }
        assert!(f.events().is_empty());
        assert_eq!(
            f.workspace
                .lock()
                .unwrap()
                .get("skill", "artifact-studio")
                .unwrap()["enabled"],
            true
        );
    }

    #[test]
    fn skills_overlap_serializes_second_mutation_behind_first_refresh() {
        use std::sync::mpsc;
        let f = Fixture::new();
        let (entered, refreshing) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        let (attempt, started) = mpsc::channel();
        let (done, result) = mpsc::channel();
        std::thread::scope(|scope| {
            let first = scope.spawn(|| {
                f.workspace.change_skill(
                    &Operation::SkillCreate {
                        body: json!({"name":"First","description":"Synthetic","content":"Inert"}),
                    },
                    move || {
                        entered.send(()).unwrap();
                        resume
                            .recv_timeout(std::time::Duration::from_secs(5))
                            .unwrap();
                        Ok(())
                    },
                )
            });
            refreshing
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            assert!(
                f.workspace.skill_changes.try_lock().is_err(),
                "first refresh still owns the CRUD admission"
            );
            let second = scope.spawn(|| {
                attempt.send(()).unwrap();
                done.send(f.workspace.change_skill(
                    &Operation::SkillDelete {
                        id: "missing".into(),
                    },
                    || Ok(()),
                ))
                .unwrap();
            });
            started
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            assert!(result.try_recv().is_err());
            assert_eq!(f.events().len(), 1);
            release.send(()).unwrap();
            assert!(first.join().unwrap().is_ok());
            second.join().unwrap();
            assert_eq!(result.recv().unwrap().unwrap(), json!({"deleted":true}));
        });
        assert_eq!(
            f.events()
                .iter()
                .map(|e| e["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["skill.updated", "skill.deleted"]
        );
    }

    #[test]
    fn skills_close_rejects_queued_mutation_without_an_extra_event() {
        use std::sync::mpsc;
        let f = Fixture::new();
        let (entered, refreshing) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        let (attempt, started) = mpsc::channel();
        std::thread::scope(|scope| {
            let first=scope.spawn(||f.workspace.change_skill(&Operation::SkillCreate{body:json!({"name":"Before close","description":"Synthetic","content":"Inert"})},move||{
                entered.send(()).unwrap();resume.recv_timeout(std::time::Duration::from_secs(5)).unwrap();Err(ApiError::unavailable("Actor is closing"))
            }));
            refreshing
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            assert!(f.workspace.skill_changes.try_lock().is_err());
            let second = scope.spawn(|| {
                attempt.send(()).unwrap();
                f.workspace.change_skill(
                    &Operation::SkillDelete {
                        id: "artifact-studio".into(),
                    },
                    || panic!("closed queued mutation cannot refresh"),
                )
            });
            started
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            f.workspace.begin_shutdown().unwrap();
            release.send(()).unwrap();
            assert_eq!(
                first.join().unwrap().unwrap_err().message,
                "Actor is closing"
            );
            let error = second.join().unwrap().unwrap_err();
            assert_eq!(
                (error.status, error.message),
                (503, "Service closing".into())
            );
        });
        assert_eq!(
            f.events().len(),
            1,
            "the accepted document/event is retained, but queued work never commits"
        );
        assert_eq!(f.events()[0]["data"]["name"], "Before close");
        let committed = f.events()[0]["data"].clone();
        assert_eq!(
            f.workspace
                .lock()
                .unwrap()
                .get("skill", committed["id"].as_str().unwrap())
                .unwrap(),
            committed
        );
        assert!(!f
            .workspace
            .lock()
            .unwrap()
            .get("skill", "artifact-studio")
            .unwrap()
            .is_null());
    }
}
