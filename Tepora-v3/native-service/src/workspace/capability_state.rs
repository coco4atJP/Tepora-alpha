//! Atomic capability registry CAS and event persistence on Workspace's single
//! existing connection. Explicit capability keys never enter this interface.
use super::*;

impl crate::capabilities::CapabilityState for WorkspaceAccess {
    fn record_model_call(&self, receipt: Value) -> Result<(), ApiError> {
        WorkspaceAccess::record_model_call(self, receipt)
    }
    fn value(&self, key: &str) -> Result<Option<Value>, ApiError> {
        let value = self.lock()?.value(key)?;
        Ok((!value.is_null()).then_some(value))
    }

    fn commit_registry(
        &self,
        expected_revision: u64,
        next: Value,
        public_snapshot: Value,
    ) -> Result<(), ApiError> {
        let mut state = self.lock()?;
        // The comparison, registry replacement and durable event use this same
        // existing State/NativeState connection and savepoint. Never call the
        // public facade recursively while its lock is held.
        state.call(
            "exec",
            json!({"sql":"SAVEPOINT native_capability_registry"}),
        )?;
        let committed = (|| -> Result<Value, ApiError> {
            let previous = state.value("capabilities")?;
            let revision = if truth(&previous) {
                previous["revision"].as_u64()
            } else {
                Some(0)
            };
            require(
                revision == Some(expected_revision),
                409,
                "Capability settings changed. Reload before saving.",
            )?;
            let following = expected_revision
                .checked_add(1)
                .ok_or_else(|| ApiError::bad_request("Capability revision cannot advance"))?;
            require(
                next["schema"] == 1
                    && next["revision"].as_u64() == Some(following)
                    && next["profiles"].is_array()
                    && next["routes"].is_object(),
                400,
                "Invalid capability registry commit",
            )?;
            // `next` comes from Capabilities::save validation. Explicit keys are
            // never an argument to this interface and must never be added here.
            state.set_value("capabilities", next)?;
            let event = state.call(
                "event.append",
                json!({"type":"capabilities.updated","data":public_snapshot,"at":now()}),
            )?;
            state.call("exec", json!({"sql":"RELEASE native_capability_registry"}))?;
            Ok(event)
        })();
        match committed {
            Ok(event) => {
                // Same event projection/subscription boundary as agent_batch.
                // Durable state is already committed before any listener sees it.
                state.publish_value(event)
            }
            Err(error) => {
                let _ = state.call(
                    "exec",
                    json!({"sql":"ROLLBACK TO native_capability_registry; RELEASE native_capability_registry"}),
                );
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capabilities::{Capabilities, CapabilityState};
    use crate::network::{NativeNetwork, NetworkMode, NetworkPolicy};
    use std::sync::Barrier;

    struct Fixture {
        workspace: Workspace,
        dir: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = env::temp_dir().join(format!("tepora-capability-state-{}", Uuid::new_v4()));
            Self {
                workspace: Workspace::open(&dir).unwrap(),
                dir,
            }
        }
        fn capabilities(&self) -> Capabilities {
            // These persistence fixtures never dispatch a request. Offline is
            // explicit so accidental transport use cannot reach a cloud model.
            Capabilities::new(
                Arc::new(self.workspace.access()),
                NativeNetwork::new(NetworkPolicy {
                    mode: NetworkMode::Offline,
                    internet_tools: false,
                    ..Default::default()
                }),
            )
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
                .filter(|e| e["type"] == "capabilities.updated")
                .cloned()
                .collect()
        }
        fn sql(&self, sql: &str) {
            self.workspace
                .lock()
                .unwrap()
                .call("exec", json!({"sql":sql}))
                .unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.workspace.shutdown();
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
    fn registry() -> Value {
        json!({"profiles":[{"id":"decision","protocol":"system-one","baseUrl":"http://127.0.0.1:8123/v1","model":"fixture","domain":"device"}],"routes":{"decision":"decision"}})
    }
    fn drain(receiver: &mut mpsc::Receiver<ServiceEvent>) -> Vec<ServiceEvent> {
        let mut result = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            result.push(event);
        }
        result
    }

    #[test]
    fn capability_registry_commits_before_live_event_and_preserves_internal_codec() {
        let f = Fixture::new();
        let capabilities = f.capabilities();
        let mut subscription = f
            .workspace
            .subscribe(EventRequest {
                since: 0,
                reconnect: false,
            })
            .unwrap();
        let mut input = registry();
        input["profiles"][0]["name"] =
            json_codec::parse(r#""name \ud800 literal \ue000""#).unwrap();
        let public = capabilities.save(&input, 0).unwrap();
        let saved = CapabilityState::value(&f.workspace.access(), "capabilities")
            .unwrap()
            .unwrap();
        assert_eq!(saved["revision"], 1);
        assert_eq!(saved["profiles"][0]["name"], input["profiles"][0]["name"]);
        assert!(saved["profiles"][0].get("keyPresent").is_none());
        let live = drain(&mut subscription.receiver)
            .into_iter()
            .filter(|e| e.event_type == "capabilities.updated")
            .collect::<Vec<_>>();
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].data, public);
        assert_eq!(f.events()[0]["data"], public);
        assert_eq!(f.events()[0]["seq"].as_u64(), live[0].seq);
        assert_eq!(
            json_codec::parse(&json_codec::stringify_js(&live[0].data).unwrap()).unwrap(),
            public
        );
        f.workspace.unsubscribe(subscription.id);
        capabilities.close();
    }

    #[test]
    fn capability_registry_and_event_failures_roll_back_without_live_publication() {
        for (create, remove) in [
            ("CREATE TRIGGER capability_fail BEFORE INSERT ON kv WHEN NEW.key='capabilities' BEGIN SELECT RAISE(ABORT,'fixture rejects registry'); END", "DROP TRIGGER capability_fail"),
            ("CREATE TRIGGER capability_fail BEFORE INSERT ON events WHEN NEW.type='capabilities.updated' BEGIN SELECT RAISE(ABORT,'fixture rejects event'); END", "DROP TRIGGER capability_fail"),
        ] {
            let f = Fixture::new();
            let capabilities = f.capabilities();
            capabilities.save(&registry(), 0).unwrap();
            let before = CapabilityState::value(&f.workspace.access(), "capabilities").unwrap();
            let events_before = f.events();
            let mut subscription = f.workspace.subscribe(EventRequest { since:0, reconnect:false }).unwrap();
            f.sql(create);
            let mut next = registry();
            next["profiles"][0]["model"] = json!("must-roll-back");
            assert!(capabilities.save(&next, 1).is_err());
            assert_eq!(CapabilityState::value(&f.workspace.access(), "capabilities").unwrap(), before);
            assert_eq!(f.events(), events_before);
            assert!(drain(&mut subscription.receiver).is_empty());
            f.sql(remove);
            assert_eq!(capabilities.save(&next, 1).unwrap()["revision"], 2);
            assert_eq!(f.events().len(), 2);
            assert_eq!(drain(&mut subscription.receiver).iter().filter(|e| e.event_type == "capabilities.updated").count(), 1);
            f.workspace.unsubscribe(subscription.id);
            capabilities.close();
        }
    }

    #[test]
    fn capability_registry_cas_on_one_workspace_connection_has_one_winner() {
        let f = Fixture::new();
        let barrier = Arc::new(Barrier::new(3));
        let mut threads = Vec::new();
        for _ in 0..2 {
            let access = f.workspace.access();
            let barrier = barrier.clone();
            threads.push(std::thread::spawn(move || {
                let next = json!({"schema":1,"revision":1,"profiles":[],"routes":{}});
                barrier.wait();
                access.commit_registry(0, next.clone(), next)
            }));
        }
        barrier.wait();
        let results = threads
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter_map(|r| r.as_ref().err())
                .map(|e| e.status)
                .collect::<Vec<_>>(),
            vec![409]
        );
        assert_eq!(
            CapabilityState::value(&f.workspace.access(), "capabilities")
                .unwrap()
                .unwrap()["revision"],
            1
        );
        assert_eq!(f.events().len(), 1);
    }

    #[test]
    fn capability_keys_never_persist_and_restart_retains_only_the_registry() {
        let f = Fixture::new();
        let capabilities = f.capabilities();
        capabilities.save(&registry(), 0).unwrap();
        let pinned = capabilities.pin("decision").unwrap();
        capabilities
            .set_key(
                "decision",
                &json!("synthetic-capability-memory-secret"),
                &pinned["identity"],
            )
            .unwrap();
        let mut next = registry();
        next["profiles"][0]["name"] = json!("renamed endpoint");
        let saved = capabilities.save(&next, 1).unwrap();
        assert_eq!(saved["profiles"][0]["keyPresent"], true);
        let persisted = f.workspace.lock().unwrap().call("sql", json!({"mode":"all","sql":"SELECT key,value FROM kv UNION ALL SELECT type,body FROM events"})).unwrap();
        let persisted = json_codec::stringify_js(&persisted).unwrap();
        assert!(!persisted.contains("synthetic-capability-memory-secret"));
        assert!(!persisted.contains("capability-keys"));
        capabilities.close();
        f.workspace.shutdown().unwrap();
        let restarted = Workspace::open(&f.dir).unwrap();
        let restored = Capabilities::new(
            Arc::new(restarted.access()),
            NativeNetwork::new(NetworkPolicy::default()),
        );
        assert_eq!(restored.snapshot().unwrap()["revision"], 2);
        assert!(!restored
            .key_present(&restored.pin("decision").unwrap())
            .unwrap());
        assert_eq!(
            restored.get().unwrap()["profiles"][0]["identity"],
            saved["profiles"][0]["identity"]
        );
        restored.close();
        restarted.shutdown().unwrap();
    }

    #[test]
    fn malformed_capability_commit_does_not_poison_transaction_or_create_an_event() {
        let f = Fixture::new();
        let access = f.workspace.access();
        for next in [
            json!({"schema":2,"revision":1,"profiles":[],"routes":{}}),
            json!({"schema":1,"revision":0,"profiles":[],"routes":{}}),
            json!({"schema":1,"revision":1,"profiles":null,"routes":{}}),
            json!({"schema":1,"revision":1,"profiles":[],"routes":[]}),
        ] {
            assert_eq!(
                access
                    .commit_registry(0, next.clone(), next)
                    .unwrap_err()
                    .status,
                400
            );
            assert!(CapabilityState::value(&access, "capabilities")
                .unwrap()
                .is_none());
            assert!(f.events().is_empty());
        }
        let next = json!({"schema":1,"revision":1,"profiles":[],"routes":{}});
        access.commit_registry(0, next.clone(), next).unwrap();
        assert_eq!(f.events().len(), 1);
    }
}
