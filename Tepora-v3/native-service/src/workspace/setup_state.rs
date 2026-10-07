//! First-use effects use the existing Workspace connection and actor admission.
//! Registry configuration locks always precede State; committed events publish
//! only after the complete settings/registry/probe savepoint is released.
use super::*;
use crate::{
    agent::{AgentHandle, AgentRequest},
    provider::ProviderRuntime,
    setup::{SelectionCommit, SelectionContext, SetupState, SetupStored},
};

struct WorkspaceSetupState {
    access: WorkspaceAccess,
    agent: AgentHandle,
}
impl SetupState for WorkspaceSetupState {
    fn capture(&self) -> Result<SetupStored, ApiError> {
        self.access.lock()?.setup_stored()
    }
    fn selection_context(&self) -> Result<SelectionContext, ApiError> {
        let context = self.agent.request(AgentRequest::SetupContext)?;
        Ok(SelectionContext {
            settings: context["settings"].clone(),
            registry_revision: context["registryRevision"]
                .as_u64()
                .ok_or_else(|| ApiError::new(500, "Invalid provider revision"))?,
            registry_configured: truth(&context["registryConfigured"]),
            busy: truth(&context["busy"]),
        })
    }
    fn activate_selection(&self, commit: SelectionCommit) -> Result<(), ApiError> {
        self.agent
            .request(AgentRequest::ActivateSetup { commit })
            .map(|_| ())
    }
    fn save_transfer(&self, transfer: Value) -> Result<(), ApiError> {
        self.access
            .agent_batch(&[
                (
                    "kv.set".into(),
                    json!({"key":"setup-transfer","value":transfer}),
                ),
                (
                    "event.emit".into(),
                    json!({"type":"setup.transfer","data":transfer}),
                ),
            ])
            .map(|_| ())
    }
    fn dismiss(&self) -> Result<(), ApiError> {
        self.access
            .agent_state("kv.set", json!({"key":"setup-dismissed","value":true}))
            .map(|_| ())
    }
    fn emit_snapshot(&self, snapshot: Value) -> Result<(), ApiError> {
        self.access
            .agent_state(
                "event.emit",
                json!({"type":"setup.updated","data":snapshot}),
            )
            .map(|_| ())
    }
}
impl State {
    pub(super) fn setup_stored(&mut self) -> Result<SetupStored, ApiError> {
        let first = self
            .list("session")?
            .into_iter()
            .find(|s| {
                s["kind"] != "main"
                    && matches!(s["status"].as_str(), Some("done" | "idle"))
                    && truth(&s["result"])
            })
            .map(|s| pick(&s, &["id", "title"]));
        Ok(SetupStored {
            settings: self.settings()?,
            model_probe: self.value("model-probe")?,
            dismissed: truth(&self.value("setup-dismissed")?),
            transfer: self.value("setup-transfer")?,
            first_result: first,
        })
    }
}
impl WorkspaceAccess {
    pub fn setup_state(&self, agent: AgentHandle) -> Arc<dyn SetupState> {
        Arc::new(WorkspaceSetupState {
            access: self.clone(),
            agent,
        })
    }
    /// Only the FIFO actor supplies busy; persisted session status is not an
    /// exact substitute for its active run leases.
    pub fn setup_selection_context(&self, busy: bool) -> Result<Value, ApiError> {
        let mut state = self.lock()?;
        require(!state.closing, 503, "Service closing")?;
        let providers = state.providers()?;
        Ok(
            json!({"settings":state.settings()?,"registryRevision":providers["revision"],"registryConfigured":!providers["profiles"].as_array().unwrap().is_empty(),"busy":busy}),
        )
    }
    /// The coordinator already checks active leases on the same actor turn.
    /// This method rechecks all durable predicates and cancellation under the
    /// config -> State locks, then commits or rolls back the entire selection.
    pub fn activate_selection_on_actor(
        &self,
        provider: &ProviderRuntime,
        commit: &SelectionCommit,
    ) -> Result<(), ApiError> {
        provider.with_configuration_lock(|| {
            let mut state=self.lock()?;
            require(!state.closing,503,"Service closing")?;
            if let Some(error)=commit.cancellation.error(){return Err(error.into());}
            let previous=state.settings()?;
            require(crate::setup::configuration(&previous)?==commit.expected_configuration,409,"設定が変更されました。現在の設定を上書きしていません。")?;
            let old=state.providers()?;
            require(old["revision"].as_u64()==Some(commit.expected_registry_revision),409,"接続設定が変更されました。現在の経路を上書きしません。")?;
            require(old["profiles"].as_array().unwrap().is_empty(),409,"名前付きの接続が設定されています。")?;
            // Probe snapshots do not own unrelated preferences. Rebase only the
            // intended connection fields onto the current durable settings.
            let selected=pick(&commit.settings,&["provider","baseUrl","model","apiKeyEnv"]);
            let settings=validate_setup_settings(&selected,&previous)?;
            crate::runtime_discovery::local_endpoint(settings["baseUrl"].as_str().unwrap_or(""))?;
            require(settings["apiKeyEnv"]=="",400,"First-use candidates cannot inherit credentials")?;
            let mut registry=crate::provider::validate_registry(&commit.registry)?;
            let profiles=registry["profiles"].as_array().unwrap();
            require(profiles.len()==1&&profiles[0]["id"]=="local-default"&&profiles[0]["domain"]=="device"&&profiles[0]["protocol"]=="chat-completions"&&profiles[0]["enabled"]==true&&profiles[0]["apiKeyEnv"]==""&&profiles[0]["model"]==settings["model"]&&profiles[0]["baseUrl"]==settings["baseUrl"],400,"Invalid first-use provider preset")?;
            require(commit.report["passed"]==true&&commit.report["destination"]==crate::setup::destination(&settings)?&&commit.report["model"]==settings["model"],400,"Invalid first-use probe receipt")?;
            let profile=profiles[0].clone();registry["schema"]=json!(2);registry["revision"]=json!(commit.expected_registry_revision.checked_add(1).ok_or_else(||ApiError::bad_request("Invalid provider revision"))?);
            let mut receipt=commit.report.clone();receipt["id"]=profile["identity"].clone();receipt["profileId"]=profile["id"].clone();receipt["ok"]=json!(true);receipt["scope"]=json!("first-use safe tool roundtrip, not model quality");
            state.call("exec",json!({"sql":"SAVEPOINT native_setup_selection"}))?;
            let result=(|| {
                state.set_value("settings",settings.clone())?;
                state.set_value("model-probe",commit.report.clone())?;
                state.set_value("provider-keys",json!({}))?;
                state.set_value("provider-registry",registry)?;
                let mut first=state.providers()?;provider.decorate_snapshot(&mut first);
                let mut events=vec![state.call("event.append",json!({"type":"providers.updated","data":first,"at":now()}))?];
                state.put("provider-probe",receipt)?;
                events.push(state.call("event.append",json!({"type":"settings.updated","data":settings,"at":now()}))?);
                let mut last=state.providers()?;provider.decorate_snapshot(&mut last);
                events.push(state.call("event.append",json!({"type":"providers.updated","data":last,"at":now()}))?);
                if let Some(error)=commit.cancellation.error(){return Err(error.into());}
                state.call("exec",json!({"sql":"RELEASE native_setup_selection"}))?;
                Ok(events)
            })();
            match result {
                Ok(events)=>{for event in events {state.publish_value(event)?;}Ok(())},
                Err(error)=>{let _=state.call("exec",json!({"sql":"ROLLBACK TO native_setup_selection; RELEASE native_setup_selection"}));Err(error)}
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Workspace, ProviderRuntime, PathBuf) {
        let dir = env::temp_dir().join(format!("tepora-setup-atomic-{}", Uuid::new_v4()));
        let workspace = Workspace::open(&dir).unwrap();
        let provider = ProviderRuntime::new(
            Arc::new(workspace.access()),
            crate::network::NativeNetwork::new(crate::network::NetworkPolicy::default()),
        );
        (workspace, provider, dir)
    }
    fn commit(workspace: &Workspace) -> SelectionCommit {
        let previous = workspace.lock().unwrap().settings().unwrap();
        let mut settings = previous.clone();
        settings["provider"] = json!("ollama");
        settings["baseUrl"] = json!("http://127.0.0.1:11434/v1");
        settings["model"] = json!("fixture");
        let registry = json!({"profiles":[{"id":"local-default","model":"fixture","protocol":"chat-completions","baseUrl":settings["baseUrl"],"domain":"device","apiKeyEnv":""}],"routes":{"main":{"primary":"local-default","fallbacks":[]}}});
        let report = json!({"passed":true,"destination":crate::setup::destination(&settings).unwrap(),"model":"fixture","checkedAt":now(),"evidence":["fixture"]});
        SelectionCommit {
            cancellation: crate::network::RequestCancellation::new(),
            expected_configuration: crate::setup::configuration(&previous).unwrap(),
            expected_registry_revision: 0,
            settings,
            report,
            registry,
        }
    }
    #[test]
    fn setup_activation_commits_settings_registry_receipt_and_ordered_events_together() {
        let (workspace, provider, dir) = fixture();
        let c = commit(&workspace);
        let mut subscription = workspace
            .subscribe(EventRequest {
                since: 0,
                reconnect: false,
            })
            .unwrap();
        workspace
            .access()
            .activate_selection_on_actor(&provider, &c)
            .unwrap();
        let snapshot = provider.public_snapshot().unwrap();
        assert_eq!(snapshot["revision"], 1);
        assert_eq!(snapshot["profiles"][0]["probe"]["ok"], true);
        assert_eq!(
            workspace.lock().unwrap().settings().unwrap()["model"],
            "fixture"
        );
        let events = (0..3)
            .map(|_| subscription.receiver.try_recv().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            events
                .iter()
                .map(|e| e.event_type.as_str())
                .collect::<Vec<_>>(),
            ["providers.updated", "settings.updated", "providers.updated"]
        );
        assert!(events[0].seq < events[1].seq && events[1].seq < events[2].seq);
        assert!(events[0].data["profiles"][0]["probe"].is_null());
        assert_eq!(events[2].data["profiles"][0]["probe"]["ok"], true);
        workspace.unsubscribe(subscription.id);
        workspace.shutdown().unwrap();
        drop(provider);
        drop(workspace);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn setup_probe_write_failure_rolls_back_every_value_and_never_publishes() {
        let (workspace, provider, dir) = fixture();
        let c = commit(&workspace);
        let original = workspace.lock().unwrap().settings().unwrap();
        let mut subscription = workspace
            .subscribe(EventRequest {
                since: 0,
                reconnect: false,
            })
            .unwrap();
        workspace.lock().unwrap().call("exec",json!({"sql":"CREATE TRIGGER reject_setup_probe BEFORE INSERT ON documents WHEN NEW.kind='provider-probe' BEGIN SELECT RAISE(ABORT,'fixture rejects setup probe'); END"})).unwrap();
        let error = workspace
            .access()
            .activate_selection_on_actor(&provider, &c)
            .unwrap_err();
        assert!(
            error.message.contains("fixture rejects setup probe"),
            "{}",
            error.message
        );
        assert_eq!(workspace.lock().unwrap().settings().unwrap(), original);
        assert_eq!(provider.public_snapshot().unwrap()["revision"], 0);
        assert!(workspace
            .lock()
            .unwrap()
            .value("model-probe")
            .unwrap()
            .is_null());
        assert!(subscription.receiver.try_recv().is_err());
        assert_eq!(
            workspace
                .lock()
                .unwrap()
                .call("event.seq", json!({}))
                .unwrap(),
            0
        );
        workspace.unsubscribe(subscription.id);
        workspace.shutdown().unwrap();
        drop(provider);
        drop(workspace);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn cancelled_and_stale_setup_activation_leave_current_state_untouched() {
        for stale in [false, true] {
            let (workspace, provider, dir) = fixture();
            let c = commit(&workspace);
            if stale {
                workspace
                    .lock()
                    .unwrap()
                    .set_value("settings", json!({"model":"manual-choice"}))
                    .unwrap();
            } else {
                c.cancellation.cancel();
            }
            let previous = workspace.lock().unwrap().settings().unwrap();
            assert!(workspace
                .access()
                .activate_selection_on_actor(&provider, &c)
                .is_err());
            assert_eq!(workspace.lock().unwrap().settings().unwrap(), previous);
            assert_eq!(provider.public_snapshot().unwrap()["revision"], 0);
            workspace.shutdown().unwrap();
            drop(provider);
            drop(workspace);
            fs::remove_dir_all(dir).unwrap();
        }
    }
}
