//! Process effect adapter for NativeAgentHost. It owns external process resources
//! and immutable receipt descriptors, never Workspace, a database, or an agent
//! step loop. RuntimeEngine/ExecutionEngine still own all model admission.
use super::{
    processes::{self, DrainTicket, ManagerOptions, ProcessContext, ProcessManager},
    EffectContext, EffectError, EffectNamespace, EffectResult, EffectScope, EffectTask,
};
use crate::{network::RequestCancellation, sandbox::SandboxConfig, ApiError};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tepora_core::{
    js_value::{js_string, truthy},
    json_codec,
};

/// An owned dispatch snapshot. `approved_args_json` is the exact JSON string
/// retrieved from the parent's scope+definition-key approval table; constructing
/// this value does not grant permission and cannot replace the parent's policy.
pub struct ProcessInvocation {
    pub scope: EffectScope,
    pub cancellation: RequestCancellation,
    pub prepared: Value,
    pub approved_args_json: String,
    pub session: Value,
    pub settings: Value,
    /// Lossless internal-codec fallback path, from Workspace's workRoot facade.
    pub work_root: String,
}
impl ProcessInvocation {
    pub fn from_effect(
        context: &EffectContext,
        prepared: Value,
        approved_args_json: String,
        session: Value,
        settings: Value,
        work_root: String,
    ) -> Self {
        Self {
            scope: context.scope.clone(),
            cancellation: context.cancellation.clone(),
            prepared,
            approved_args_json,
            session,
            settings,
            work_root,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct DefinitionScope {
    service: u64,
    session: String,
    run: u64,
    generation: u64,
    key: String,
}
impl DefinitionScope {
    fn new(scope: &EffectScope, key: &str) -> Result<Self, EffectError> {
        if scope.namespace != EffectNamespace::Execution
            || scope.generation.is_none()
            || key.is_empty()
        {
            return Err(not_executed(
                "A process tool requires an immutable execution definition",
            ));
        }
        Ok(Self {
            service: scope.service_id,
            session: scope.session_id.clone(),
            run: scope.run_epoch,
            generation: scope.generation.unwrap(),
            key: key.into(),
        })
    }
}
struct Owned {
    definitions: Mutex<HashMap<DefinitionScope, Value>>,
    /// A resumed request or new exec can await previously stopped background
    /// resources without adding any independent model-run scheduling policy.
    stopped: Mutex<HashMap<String, DrainTicket>>,
}
#[derive(Clone)]
pub struct ProcessHost {
    manager: ProcessManager,
    owned: Arc<Owned>,
}
impl Default for ProcessHost {
    fn default() -> Self {
        Self::new()
    }
}
impl ProcessHost {
    pub fn new() -> Self {
        Self::with_options(ManagerOptions::default())
    }
    pub fn with_options(options: ManagerOptions) -> Self {
        Self {
            manager: ProcessManager::with_options(options),
            owned: Arc::new(Owned {
                definitions: Mutex::new(HashMap::new()),
                stopped: Mutex::new(HashMap::new()),
            }),
        }
    }
    pub fn manager(&self) -> &ProcessManager {
        &self.manager
    }
    pub fn catalog(&self) -> Vec<Value> {
        processes::catalog(&self.manager.facts().shell)
    }
    pub fn definition(&self, name: &str) -> Option<Value> {
        self.catalog().into_iter().find(|d| d["name"] == name)
    }
    pub fn summarize(&self, name: &str, args: &Value) -> Result<Option<String>, EffectError> {
        if self.definition(name).is_none() {
            return Ok(None);
        }
        processes::summarize(name, args).map(Some)
    }
    /// Await stopped resources before a resumed request uses its owned input
    /// snapshot. Run in an async effect, never block the FIFO actor or hold a
    /// Workspace guard. A failed drain remains a failed readiness barrier.
    pub async fn ready_session(
        &self,
        session: &str,
        cancellation: &RequestCancellation,
    ) -> Result<(), EffectError> {
        if cancellation.is_cancelled() {
            return Err(EffectError::cancelled(true));
        }
        let wait = self
            .owned
            .stopped
            .lock()
            .map_err(|_| not_executed("Process cleanup owner unavailable"))?
            .get(session)
            .cloned();
        if let Some(wait) = wait {
            tokio::select! {biased;
                _ = cancellation.cancelled() => return Err(EffectError::cancelled(true)),
                result = wait.wait_async() => result.map_err(|e| {
                    let mut error = EffectError::from(e);
                    error.error["notExecuted"] = json!(true);
                    error
                })?,
            }
        }
        if cancellation.is_cancelled() {
            return Err(EffectError::cancelled(true));
        }
        Ok(())
    }
    /// Call during prepareTool, before schema validation, just as the source
    /// captures a handle before checkArgs. Alias errors still need that metadata.
    pub fn freeze_definition(
        &self,
        scope: &EffectScope,
        key: &str,
        final_name: &str,
    ) -> Result<Option<Value>, EffectError> {
        let Some(definition) = self.definition(final_name) else {
            return Ok(None);
        };
        let key = DefinitionScope::new(scope, key)?;
        let mut definitions = self
            .owned
            .definitions
            .lock()
            .map_err(|_| EffectError::new("Process descriptor owner unavailable"))?;
        if let Some(existing) = definitions.get(&key) {
            if existing != &definition {
                return Err(not_executed(
                    "Prepared process definition changed before execution",
                ));
            }
            return Ok(Some(existing.clone()));
        }
        definitions.insert(key, definition.clone());
        Ok(Some(definition))
    }
    pub fn start_effect(&self, call: ProcessInvocation) -> Result<Option<EffectTask>, EffectError> {
        let name = call.prepared["name"].as_str().unwrap_or("");
        if !matches!(name, "exec" | "process") {
            return Ok(None);
        }
        if call.cancellation.is_cancelled() {
            return Err(EffectError::cancelled(true));
        }
        if call.session["id"].as_str() != Some(call.scope.session_id.as_str()) {
            return Err(not_executed(
                "Process session does not match its execution scope",
            ));
        }
        let key = call.prepared["definitionKey"].as_str().unwrap_or("");
        self.freeze_definition(&call.scope, key, name)?;
        let args = call.prepared.get("args").cloned().unwrap_or(Value::Null);
        let encoded = json_codec::stringify_js(&args)
            .map_err(|_| not_executed("Process arguments cannot be serialized"))?;
        if encoded != call.approved_args_json {
            return Err(not_executed(
                "Approved process arguments changed before dispatch",
            ));
        }
        let cwd = call.session["cwd"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(&call.work_root);
        if cwd.is_empty() {
            return Err(not_executed("The process working directory is missing"));
        }
        let raw = call
            .settings
            .get("sandbox")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| json!({}));
        let policy =
            SandboxConfig::parse(&raw, None, &self.manager.facts().platform).map_err(|e| {
                let mut e = EffectError::from(e);
                e.error["notExecuted"] = json!(true);
                e
            })?;
        let context = ProcessContext {
            session_id: call.scope.session_id.clone(),
            cwd: PathBuf::from(json_codec::sql_text(cwd)),
            cwd_text: Some(cwd.into()),
            sandbox: policy,
            cancellation: call.cancellation,
        };
        let host = self.clone();
        let manager = self.manager.clone();
        let name = name.to_owned();
        Ok(Some(EffectTask::Async(Box::pin(async move {
            if name == "exec" {
                host.ready_session(&context.session_id, &context.cancellation)
                    .await?;
            }
            if context.cancellation.is_cancelled() {
                return Err(EffectError::cancelled(true));
            }
            let result = if name == "exec" {
                manager.execute_exec(args, context).await?
            } else {
                manager.execute_process(args, context).await?
            };
            Ok(EffectResult::new(json!({"result":result})))
        }))))
    }
    /// Return metadata for a pure ordered receipt batch. `base` is the ordinary
    /// catalog map. Custom callback results are stored under each immutable key,
    /// never under a shared process name which could collapse different IDs.
    pub fn definitions_for_receipts(
        &self,
        scope: &EffectScope,
        base: &Value,
        calls: &[Value],
        outputs: &[Value],
    ) -> Result<Value, EffectError> {
        if calls.len() != outputs.len() {
            return Err(EffectError::new(
                "Process receipt call/output counts do not match",
            ));
        }
        let mut definitions = base
            .as_object()
            .cloned()
            .ok_or_else(|| EffectError::new("Receipt definitions must be an object"))?;
        let frozen = self
            .owned
            .definitions
            .lock()
            .map_err(|_| EffectError::new("Process descriptor owner unavailable"))?;
        for (call, out) in calls.iter().zip(outputs) {
            let key = out["definitionKey"].as_str().filter(|s| !s.is_empty());
            let final_name = out
                .get("name")
                .filter(|v| truthy(v))
                .or_else(|| call.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let scoped = key
                .map(|key| DefinitionScope::new(scope, key))
                .transpose()?;
            let mut def = if let Some(def) = scoped.as_ref().and_then(|key| frozen.get(key)) {
                def.clone()
            } else if let Some(def) = self.definition(final_name) {
                def
            } else {
                continue;
            };
            let name = def["name"].as_str().unwrap_or("");
            let args = out
                .get("args")
                .filter(|v| truthy(v))
                .cloned()
                .unwrap_or_else(|| json!({}));
            match name {
                "exec" if !out.get("error").is_some_and(truthy) => {
                    def["stub"] = json!(processes::exec_stub(&args, &out["result"])?)
                }
                "process" => def["ephemeralKey"] = json!(processes::ephemeral_key(&args)),
                _ => {}
            }
            definitions.insert(key.unwrap_or(final_name).to_owned(), def);
        }
        Ok(Value::Object(definitions))
    }
    /// Normal step completion releases descriptor handles even when a long
    /// worker keeps its runtime lease. Call only after ordered receipts commit.
    pub fn release_step(&self, session: &str, run: u64, generation: u64) {
        self.owned
            .definitions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|key, _| {
                !(key.session == session && key.run == run && key.generation == generation)
            });
    }
    pub fn release_run(&self, session: &str, run: u64) {
        self.owned
            .definitions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|key, _| !(key.session == session && key.run == run));
        let mut stopped = self.owned.stopped.lock().unwrap_or_else(|p| p.into_inner());
        if stopped
            .get(session)
            .is_some_and(|ticket| matches!(ticket.completion_result(), Some(Ok(()))))
        {
            stopped.remove(session);
        }
    }
    pub fn stop_session(&self, session: &str) -> DrainTicket {
        let ticket = self.manager.cancel_session(session);
        self.owned
            .stopped
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(session.into(), ticket.clone());
        ticket
    }
    pub fn begin_close(&self) -> DrainTicket {
        self.manager.begin_close()
    }
    /// Safe only on the dedicated coordinator owner, with no Workspace guard.
    pub fn close_and_drain(&self) -> Result<(), ApiError> {
        let result = self.manager.begin_close().wait();
        self.owned
            .definitions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
        self.owned
            .stopped
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
        result
    }
    pub fn list(&self, session: &str) -> Value {
        json!(self.manager.list(Some(session)))
    }
    pub fn live(&self, session: &str) -> Value {
        let mut live = serde_json::Map::new();
        for process in self.manager.list(Some(session)) {
            let status = if process["exitCode"].is_null() {
                js_string(process.get("status"))
            } else {
                format!(
                    "{} {}",
                    js_string(process.get("status")),
                    js_string(process.get("exitCode"))
                )
            };
            if let Some(id) = process["id"].as_str() {
                live.insert(id.into(), json!(status));
            }
        }
        Value::Object(live)
    }
    pub fn sandbox_available(&self) -> Value {
        self.manager
            .facts()
            .available
            .value(&self.manager.facts().platform)
    }
    #[cfg(test)]
    pub(crate) fn descriptor_count(&self) -> usize {
        self.owned.definitions.lock().unwrap().len()
    }
}
fn not_executed(message: &str) -> EffectError {
    let mut error = EffectError::new(message);
    error.error["notExecuted"] = json!(true);
    error
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::receipts,
        sandbox::{Available, Platform, Shell, SpawnFacts},
    };
    use std::{fs, time::Duration};
    struct Fixture {
        root: PathBuf,
        host: ProcessHost,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("tepora-process-host-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let facts = SpawnFacts {
                platform: Platform::current(),
                shell: Shell {
                    file: "/bin/sh".into(),
                    name: "sh".into(),
                    windows: false,
                },
                available: Available::default(),
                temp_dir: std::env::temp_dir(),
            };
            let host = ProcessHost::with_options(ManagerOptions {
                facts,
                environment: Some(vec![("PATH".into(), "/usr/bin:/bin".into())]),
                login_path: Some("/usr/bin:/bin".into()),
                clock: Arc::new(|| chrono::Utc::now().timestamp_millis()),
            });
            Self { root, host }
        }
        fn scope(&self, generation: u64) -> EffectScope {
            EffectScope {
                service_id: 8,
                session_id: "owner".into(),
                run_epoch: 11,
                generation: Some(generation),
                namespace: EffectNamespace::Execution,
                operation_id: format!("{generation}:7"),
            }
        }
        fn call(&self, generation: u64, name: &str, args: Value) -> ProcessInvocation {
            ProcessInvocation {
                scope: self.scope(generation),
                cancellation: RequestCancellation::new(),
                prepared: json!({"name":name,"args":args,"definitionKey":format!("{generation}:tool:0")}),
                approved_args_json: json_codec::stringify_js(&args).unwrap(),
                session: json!({"id":"owner","cwd":json_codec::encode_text(&self.root.to_string_lossy())}),
                settings: json!({"sandbox":{"mode":"off"}}),
                work_root: json_codec::encode_text(&self.root.to_string_lossy()),
            }
        }
        async fn run(&self, call: ProcessInvocation) -> Result<EffectResult, EffectError> {
            match self
                .host
                .start_effect(call)?
                .expect("process effect was not recognized")
            {
                EffectTask::ReadyWithAuxiliary(_, _) => {
                    panic!("Unexpected auxiliary task in isolated effect test")
                }
                EffectTask::Ready(result) => Ok(result),
                EffectTask::Async(future) => future.await,
            }
        }
        async fn close(&self) {
            self.host.begin_close().wait_async().await.unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.host.begin_close();
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn exact_approval_and_session_scope_are_checked_before_dispatch() {
        let f = Fixture::new();
        let mut call = f.call(
            3,
            "exec",
            json!({"command":"printf changed > should-not-exist"}),
        );
        call.approved_args_json =
            json_codec::stringify_js(&json!({"command":"printf approved"})).unwrap();
        let error = match f.host.start_effect(call) {
            Err(error) => error,
            _ => panic!("changed args were accepted"),
        };
        assert_eq!(error.error["notExecuted"], true);
        assert!(!f.root.join("should-not-exist").exists());
        assert_eq!(f.host.list("owner"), json!([]));
        let mut call = f.call(3, "exec", json!({"command":"true"}));
        call.session["id"] = json!("different");
        assert!(f.host.start_effect(call).is_err());
        let mut call = f.call(3, "exec", json!({"command":"true"}));
        call.scope.namespace = EffectNamespace::Runtime;
        assert!(f.host.start_effect(call).is_err());
    }
    #[test]
    fn descriptors_are_immutable_and_released_per_step_and_run() {
        let f = Fixture::new();
        for generation in 1..=500 {
            let scope = f.scope(generation);
            f.host
                .freeze_definition(&scope, "definition", "exec")
                .unwrap();
            assert!(f
                .host
                .freeze_definition(&scope, "definition", "process")
                .is_err());
            assert_eq!(f.host.descriptor_count(), 1);
            f.host.release_step("owner", 11, generation);
            assert_eq!(f.host.descriptor_count(), 0);
        }
        f.host
            .freeze_definition(&f.scope(501), "a", "exec")
            .unwrap();
        f.host
            .freeze_definition(&f.scope(502), "b", "process")
            .unwrap();
        f.host.release_run("owner", 11);
        assert_eq!(f.host.descriptor_count(), 0);
    }
    #[test]
    fn frozen_alias_errors_and_each_process_id_keep_source_receipt_metadata() {
        let f = Fixture::new();
        let scope = f.scope(3);
        for (key, name) in [
            ("3:tool:0", "process"),
            ("3:tool:1", "process"),
            ("3:tool:2", "exec"),
            ("3:tool:3", "process"),
        ] {
            f.host.freeze_definition(&scope, key, name).unwrap();
        }
        let calls = vec![
            json!({"id":"a","name":"process"}),
            json!({"id":"b","name":"process"}),
            json!({"id":"c","name":"exec"}),
            json!({"id":"d","name":"tools_call"}),
        ];
        let outputs = vec![
            json!({"name":"process","args":{"action":"poll","id":"p-one"},"definitionKey":"3:tool:0","result":{"text":"one"}}),
            json!({"name":"process","args":{"action":"poll","id":"p-two"},"definitionKey":"3:tool:1","result":{"text":"two"}}),
            json!({"name":"exec","args":{"command":"printf hello"},"definitionKey":"3:tool:2","result":{"text":"running","data":{"processId":"p-three","exitCode":null}}}),
            json!({"definitionKey":"3:tool:3","error":"Invalid process arguments"}),
        ];
        let definitions = f
            .host
            .definitions_for_receipts(&scope, &json!({}), &calls, &outputs)
            .unwrap();
        assert_eq!(definitions["3:tool:0"]["ephemeralKey"], "process:p-one");
        assert_eq!(definitions["3:tool:1"]["ephemeralKey"], "process:p-two");
        assert_eq!(
            definitions["3:tool:2"]["stub"],
            "exec \"printf hello\" → running p-three"
        );
        assert_eq!(definitions["3:tool:3"]["ephemeralKey"], "process:list");
        let planned = receipts::plan_receipts_with_unicode(
            &json!({"id":"owner","stats":{}}),
            &calls,
            &outputs,
            5000.0,
            &definitions,
            &json!({"calls":[]}),
            1,
            17,
        )
        .unwrap();
        assert_eq!(planned.receipts[0].body["ephemeralKey"], "process:p-one");
        assert_eq!(planned.receipts[1].body["ephemeralKey"], "process:p-two");
        assert_eq!(
            planned.receipts[2].body["stub"],
            "exec \"printf hello\" → running p-three"
        );
        assert_eq!(planned.receipts[3].body["ephemeralKey"], "process:list");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn adapter_uses_snapshot_environment_root_and_real_effect_result() {
        let f = Fixture::new();
        let physical_root = fs::canonicalize(&f.root).unwrap();
        let mut call = f.call(
            3,
            "exec",
            json!({"command":"printf '%s:%s' \"$TEPORA_SESSION\" \"$PWD\"","yield":2}),
        );
        call.session["cwd"] = Value::Null;
        let result = f.run(call).await.unwrap();
        let result = &result.value["result"];
        assert_eq!(result["data"]["exitCode"], 0);
        assert!(result["text"]
            .as_str()
            .unwrap()
            .contains(&format!("owner:{}", physical_root.display())));
        assert_eq!(f.host.list("different"), json!([]));
        let list = f.host.list("owner");
        assert_eq!(list.as_array().unwrap().len(), 1);
        let id = list[0]["id"].as_str().unwrap();
        assert_eq!(f.host.live("owner")[id], "exited 0");
        f.close().await;
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn stopped_background_process_is_a_resource_barrier_and_cancelled_new_exec_never_starts()
    {
        let f = Fixture::new();
        let old = f
            .run(f.call(
                3,
                "exec",
                json!({"command":"trap '' TERM; /bin/sleep 60","background":true}),
            ))
            .await
            .unwrap();
        assert!(old.value["result"]["data"]["processId"].is_string());
        let stopping = f.host.stop_session("owner");
        let next = f.call(
            4,
            "exec",
            json!({"command":"printf should-not-run > resumed.txt","yield":1}),
        );
        let cancel = next.cancellation.clone();
        let future = match f.host.start_effect(next).unwrap().unwrap() {
            EffectTask::Async(future) => future,
            _ => panic!("exec must be an actual asynchronous effect"),
        };
        let task = tokio::spawn(future);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!f.root.join("resumed.txt").exists());
        cancel.cancel();
        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error.error["notExecuted"], true);
        stopping.wait_async().await.unwrap();
        assert!(!f.root.join("resumed.txt").exists());
        f.host.release_step("owner", 11, 3);
        f.host.release_step("owner", 11, 4);
        assert_eq!(f.host.descriptor_count(), 0);
        assert_eq!(f.host.list("owner").as_array().unwrap().len(), 1);
        f.close().await;
    }
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn synchronous_close_hook_drains_background_resources_off_the_state_lock() {
        let f = Fixture::new();
        f.run(f.call(
            3,
            "exec",
            json!({"command":"/bin/sleep 60","background":true}),
        ))
        .await
        .unwrap();
        let host = f.host.clone();
        tokio::task::spawn_blocking(move || host.close_and_drain())
            .await
            .unwrap()
            .unwrap();
        assert!(f
            .host
            .list("owner")
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["status"] != "running"));
        assert_eq!(f.host.descriptor_count(), 0);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn ready_session_waits_without_blocking_other_sessions_and_can_be_cancelled() {
        let f = Fixture::new();
        f.run(f.call(
            3,
            "exec",
            json!({"command":"trap '' TERM; /bin/sleep 60","background":true}),
        ))
        .await
        .unwrap();
        let stopping = f.host.stop_session("owner");
        let cancellation = RequestCancellation::new();
        let cancelled_host = f.host.clone();
        let cancelled_token = cancellation.clone();
        let cancelled = tokio::spawn(async move {
            cancelled_host
                .ready_session("owner", &cancelled_token)
                .await
        });
        let resumed_host = f.host.clone();
        let resumed = tokio::spawn(async move {
            resumed_host
                .ready_session("owner", &RequestCancellation::new())
                .await
        });
        // This single-thread executor can still serve unrelated work while
        // both resumed requests await the actual TERM/KILL resource drain.
        tokio::time::timeout(
            Duration::from_millis(100),
            f.host
                .ready_session("unrelated", &RequestCancellation::new()),
        )
        .await
        .unwrap()
        .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!stopping.is_complete());
        assert!(!resumed.is_finished());
        cancellation.cancel();
        let error = tokio::time::timeout(Duration::from_millis(100), cancelled)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(error.error["notExecuted"], true);
        assert!(!resumed.is_finished());
        assert!(!stopping.is_complete());
        tokio::time::timeout(Duration::from_secs(5), resumed)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(stopping.is_complete());
        f.host
            .ready_session("owner", &RequestCancellation::new())
            .await
            .unwrap();
        let already_cancelled = RequestCancellation::new();
        already_cancelled.cancel();
        assert!(f
            .host
            .ready_session("unrelated", &already_cancelled)
            .await
            .is_err());
        f.close().await;
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn ready_session_preserves_uncertain_escaped_pipe_drain_as_error() {
        let f = Fixture::new();
        let Some(setsid) = crate::sandbox::which(
            "setsid",
            std::ffi::OsStr::new("/usr/bin:/bin"),
            &Platform::Linux,
        ) else {
            return;
        };
        fn child_identity(pid: i32) -> Option<(String, String)> {
            let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
            let fields = stat
                .rsplit_once(')')?
                .1
                .split_whitespace()
                .collect::<Vec<_>>();
            Some((fields.get(19)?.to_string(), fields.first()?.to_string()))
        }
        struct FixtureChild(i32, String);
        impl Drop for FixtureChild {
            fn drop(&mut self) {
                // Only signal the child emitted by this fixed test command,
                // after checking its kernel start time against PID reuse.
                if child_identity(self.0)
                    .is_some_and(|(start, state)| start == self.1 && state != "Z")
                {
                    unsafe {
                        libc::kill(self.0, libc::SIGKILL);
                    }
                }
            }
        }
        let command = format!(
            "{} /bin/sleep 10 & printf '%s' \"$!\" > readiness-holder.pid",
            setsid.display()
        );
        f.run(f.call(3, "exec", json!({"command":command,"background":true})))
            .await
            .unwrap();
        let child = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(text) = fs::read_to_string(f.root.join("readiness-holder.pid")) {
                    if let Ok(pid) = text.trim().parse::<i32>() {
                        if let Some((start, _)) = child_identity(pid) {
                            break FixtureChild(pid, start);
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("Controlled fixture did not identify its own child");
        f.host.stop_session("owner");
        let error = tokio::time::timeout(
            Duration::from_secs(6),
            f.host.ready_session("owner", &RequestCancellation::new()),
        )
        .await
        .expect("Readiness waited forever on escaped pipe EOF")
        .unwrap_err();
        assert_eq!(error.error["notExecuted"], true);
        assert!(error.error["message"]
            .as_str()
            .unwrap()
            .contains("uncertain"));
        let repeated = f
            .host
            .ready_session("owner", &RequestCancellation::new())
            .await;
        assert!(
            repeated.is_err(),
            "Uncertain cleanup must not become readiness success"
        );
        assert_eq!(f.host.list("owner")[0]["cleanupUncertain"], true);
        drop(child);
        assert!(f.host.begin_close().wait_async().await.is_err());
    }
}
