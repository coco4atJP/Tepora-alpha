//! Actor-owned approval lifecycle for core/agent/policy.mjs.
//!
//! Only synchronous actor methods touch Workspace. Returned futures merely wait
//! for a decision/cancellation and return an opaque completion proposal. The
//! actor must call finish only for a still-current authorizeTool effect, and
//! cancel/cancel_all from stopResources/closeResources before acknowledging Stop.
use super::{
    policy::{CompiledPolicy, PolicyAction},
    EffectError, EffectResult, EffectTask,
};
use crate::{network::RequestCancellation, workspace::WorkspaceAccess, ApiError};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, MutexGuard},
};
use tepora_core::js_value::truthy;
use tokio::sync::oneshot;
use uuid::Uuid;

const COMPLETION_FACT: &str = "_nativeApprovalCompletion";
#[derive(Clone)]
struct Restore {
    session_id: String,
    epoch: u64,
    before: Value,
    waiting: Value,
    cancellation: RequestCancellation,
}
struct Pending {
    /// The exact checked proposal is immutable even if callers mutate their own
    /// arguments or a persisted document is replaced while the question is open.
    doc: Value,
    restore: Restore,
    answer: oneshot::Sender<bool>,
}
#[derive(Default)]
struct State {
    pending: HashMap<String, Pending>,
    settled: HashMap<String, Restore>,
    epochs: HashMap<String, u64>,
}
impl State {
    fn advance(&mut self, session: &str) -> u64 {
        let epoch = self.epochs.entry(session.to_owned()).or_default();
        *epoch = epoch.wrapping_add(1);
        *epoch
    }
    fn decline(&mut self, ids: &[String]) {
        for id in ids {
            if let Some(p) = self.pending.remove(id) {
                let _ = p.answer.send(false);
            }
        }
    }
}
pub struct Approvals {
    workspace: WorkspaceAccess,
    state: Mutex<State>,
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn conflict() -> ApiError {
    ApiError::new(409, "この承認はもう待っていません。")
}
fn put(doc: Value) -> (String, Value) {
    ("document.put".into(), json!({"kind":"approval","doc":doc}))
}
fn emit(doc: Value) -> (String, Value) {
    (
        "event.emit".into(),
        json!({"type":"approval.updated","data":doc}),
    )
}
fn note(session: &str, note: Value) -> (String, Value) {
    (
        "session.update".into(),
        json!({"id":session,"patch":{"note":note}}),
    )
}
impl Approvals {
    /// Call on the actor during initialization. No live waiter survives restart;
    /// retain proposal history, withdraw only pending documents, and never grant.
    pub fn new(workspace: WorkspaceAccess) -> Result<Self, ApiError> {
        let docs = workspace.agent_state("document.list", json!({"kind":"approval"}))?;
        let at = now();
        let mut operations = Vec::new();
        for doc in docs.as_array().into_iter().flatten() {
            if doc["status"] == "pending" {
                let mut doc = doc.clone();
                doc["status"] = json!("withdrawn");
                doc["decidedAt"] = json!(at);
                operations.push(put(doc));
            }
        }
        if !operations.is_empty() {
            workspace.agent_batch(&operations)?;
        }
        Ok(Self {
            workspace,
            state: Mutex::new(State::default()),
        })
    }
    fn lock(&self) -> Result<MutexGuard<'_, State>, ApiError> {
        self.state
            .lock()
            .map_err(|_| ApiError::new(500, "Approval state owner unavailable"))
    }
    pub fn pending_count(&self) -> usize {
        self.state.lock().map(|s| s.pending.len()).unwrap_or(0)
    }
    /// Snapshot matching is synchronous. No database or approval-map guard is
    /// captured by the future, and the decision always covers these exact args.
    pub fn check(
        &self,
        session: &Value,
        name: &str,
        args: &Value,
        cancel: &RequestCancellation,
    ) -> Result<EffectTask, EffectError> {
        let settings = self.workspace.agent_state("settings", json!({}))?;
        let empty = json!([]);
        let rules = settings["policy"]
            .get("rules")
            .filter(|v| truthy(v))
            .unwrap_or(&empty);
        let decision = CompiledPolicy::validate(rules)?.evaluate(name, args)?;
        match decision.action {
            PolicyAction::Allow => return Ok(EffectTask::ready(json!("allow"))),
            PolicyAction::Deny => return Ok(EffectTask::ready(json!("deny"))),
            PolicyAction::Ask => {}
        }
        // Source precedence: an allow/deny rule is returned before inspecting an
        // aborted signal. An ask on an already stopped session creates no doc.
        if cancel.is_cancelled() {
            return Ok(EffectTask::ready(json!("declined")));
        }
        let session_id = session["id"]
            .as_str()
            .ok_or_else(|| ApiError::bad_request("Approval session id is required"))?
            .to_owned();
        let current = self
            .workspace
            .agent_state("session.get", json!({"id":session_id}))?;
        let mut before = current
            .get("note")
            .filter(|v| truthy(v))
            .cloned()
            .unwrap_or_else(|| json!(""));
        let id = Uuid::new_v4().to_string();
        let waiting = json!(format!("承認待ち: {name}"));
        let doc = json!({"id":id,"sessionId":session_id,"sessionTitle":session.get("title").cloned().unwrap_or(Value::Null),"tool":name,"args":args.clone(),"note":decision.note,"status":"pending","createdAt":now()});
        let (answer, receiver) = oneshot::channel();
        {
            let mut state = self.lock()?;
            // Concurrent replacements inherit the original note, never another
            // approval's transient label. Older completions lose note ownership.
            if let Some(restore) = state
                .pending
                .values()
                .map(|p| &p.restore)
                .chain(state.settled.values())
                .find(|r| r.session_id == session_id && r.waiting == before)
            {
                before = restore.before.clone();
            }
            let epoch = state.advance(&session_id);
            state.pending.insert(
                id.clone(),
                Pending {
                    doc: doc.clone(),
                    restore: Restore {
                        session_id: session_id.clone(),
                        epoch,
                        before,
                        waiting: waiting.clone(),
                        cancellation: cancel.clone(),
                    },
                    answer,
                },
            );
            // Register the waiter BEFORE any broadcast. Persistence, source event
            // and session note commit as one short Workspace-owned transaction.
            let result = self.workspace.agent_batch(&[
                put(doc.clone()),
                emit(doc),
                note(&session_id, waiting),
            ]);
            if let Err(error) = result {
                state.decline(std::slice::from_ref(&id));
                state.advance(&session_id);
                return Err(error.into());
            }
            // Cancellation can arrive from a different thread during the batch.
            // Withdraw on this actor before handing back a waiting future.
            if cancel.is_cancelled() {
                self.withdraw_locked(&mut state, &HashSet::from([session_id]))?;
            }
        }
        let cancellation = cancel.clone();
        Ok(EffectTask::Async(Box::pin(async move {
            let allowed = tokio::select! {
                biased;
                _=cancellation.cancelled()=>false,
                answer=receiver=>answer.unwrap_or(false),
            };
            let mut result = EffectResult::new(json!(if allowed { "allow" } else { "declined" }));
            result.facts = json!({COMPLETION_FACT:id});
            Ok(result)
        })))
    }
    /// Actor-only. A decision becomes durable before its waiter is woken.
    pub fn decide(&self, id: &str, allow: bool) -> Result<Value, ApiError> {
        let mut state = self.lock()?;
        let Some(pending) = state.pending.get(id) else {
            return Err(conflict());
        };
        let session_id = pending.restore.session_id.clone();
        if pending.answer.is_closed() || pending.restore.cancellation.is_cancelled() {
            self.withdraw_locked(&mut state, &HashSet::from([session_id]))?;
            return Err(conflict());
        }
        let doc = match self
            .workspace
            .agent_state("document.get", json!({"kind":"approval","id":id}))
        {
            Ok(doc) => doc,
            Err(error) => {
                state.decline(&[id.to_owned()]);
                state.advance(&session_id);
                return Err(error);
            }
        };
        let original = &state
            .pending
            .get(id)
            .expect("actor owns pending approval")
            .doc;
        if doc["status"] != "pending"
            || doc["id"] != original["id"]
            || doc["sessionId"] != original["sessionId"]
            || doc["tool"] != original["tool"]
            || doc["args"] != original["args"]
        {
            self.withdraw_locked(&mut state, &HashSet::from([session_id]))?;
            return Err(conflict());
        }
        let mut next = doc;
        next["status"] = json!(if allow { "approved" } else { "denied" });
        next["decidedAt"] = json!(now());
        if let Err(error) = self
            .workspace
            .agent_batch(&[put(next.clone()), emit(next.clone())])
        {
            state.decline(&[id.to_owned()]);
            state.advance(&session_id);
            return Err(error);
        }
        let pending = state
            .pending
            .remove(id)
            .expect("actor owns pending approval");
        state.settled.insert(id.to_owned(), pending.restore);
        let _ = pending.answer.send(allow);
        Ok(next)
    }
    pub fn list(&self) -> Result<Value, ApiError> {
        self.workspace
            .agent_state("document.list", json!({"kind":"approval","limit":200}))
    }
    /// Apply a completion proposal only inside AgentHost::complete_effect for
    /// authorizeTool. Canceled/replaced operations cannot restore an older note.
    pub fn finish(
        &self,
        mut result: EffectResult,
        cancel: &RequestCancellation,
    ) -> Result<EffectResult, EffectError> {
        let id = result
            .facts
            .as_object_mut()
            .and_then(|facts| facts.remove(COMPLETION_FACT))
            .and_then(|v| v.as_str().map(str::to_owned));
        let Some(id) = id else {
            return Ok(result);
        };
        let mut state = self.lock()?;
        if let Some(pending) = state.pending.get(&id) {
            if cancel.is_cancelled() || pending.restore.cancellation.is_cancelled() {
                let session = pending.restore.session_id.clone();
                self.withdraw_locked(&mut state, &HashSet::from([session]))?;
            }
        }
        let Some(restore) = state.settled.remove(&id) else {
            return Ok(result);
        };
        if cancel.is_cancelled()
            || restore.cancellation.is_cancelled()
            || state.epochs.get(&restore.session_id) != Some(&restore.epoch)
        {
            return Ok(result);
        }
        let current = self
            .workspace
            .agent_state("session.get", json!({"id":restore.session_id}))?;
        // A newer actor update owns the note even if no new approval was created.
        if current.is_null() || current["note"] != restore.waiting {
            return Ok(result);
        }
        self.workspace
            .agent_batch(&[note(&restore.session_id, restore.before)])?;
        Ok(result)
    }
    pub fn cancel(&self, session_id: &str) -> Result<(), ApiError> {
        let mut state = self.lock()?;
        self.withdraw_locked(&mut state, &HashSet::from([session_id.to_owned()]))
    }
    pub fn cancel_all(&self) -> Result<(), ApiError> {
        let mut state = self.lock()?;
        let sessions = state
            .pending
            .values()
            .map(|p| p.restore.session_id.clone())
            .chain(state.settled.values().map(|r| r.session_id.clone()))
            .collect();
        self.withdraw_locked(&mut state, &sessions)
    }
    fn withdraw_locked(
        &self,
        state: &mut State,
        sessions: &HashSet<String>,
    ) -> Result<(), ApiError> {
        for session in sessions {
            state.advance(session);
        }
        state
            .settled
            .retain(|_, r| !sessions.contains(&r.session_id));
        let ids: Vec<_> = state
            .pending
            .iter()
            .filter(|(_, p)| sessions.contains(&p.restore.session_id))
            .map(|(id, _)| id.clone())
            .collect();
        if ids.is_empty() {
            return Ok(());
        }
        let reads: Vec<_> = ids
            .iter()
            .map(|id| ("document.get".into(), json!({"kind":"approval","id":id})))
            .collect();
        let persisted = self.workspace.agent_batch(&reads).and_then(|docs| {
            let mut writes = Vec::new();
            for mut doc in docs {
                if !doc.is_null() {
                    doc["status"] = json!("withdrawn");
                    writes.push(put(doc.clone()));
                    writes.push(emit(doc));
                }
            }
            if writes.is_empty() {
                Ok(())
            } else {
                self.workspace.agent_batch(&writes).map(|_| ())
            }
        });
        // No database failure may leave an in-memory permission or hung waiter.
        // The caller still receives the failure; restart will withdraw old docs.
        state.decline(&ids);
        persisted
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{workspace::Workspace, Backend, EventRequest};
    use std::{env, fs, path::PathBuf};

    struct Fixture {
        workspace: Workspace,
        dir: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = env::temp_dir().join(format!("tepora-approvals-{}", Uuid::new_v4()));
            let workspace = Workspace::open(&dir).unwrap();
            Self { workspace, dir }
        }
        fn access(&self) -> WorkspaceAccess {
            self.workspace.access()
        }
        fn rules(&self, rules: Value) {
            self.access()
                .agent_state(
                    "kv.set",
                    json!({"key":"agent-settings","value":{"policy":{"rules":rules}}}),
                )
                .unwrap();
        }
        fn session(&self) -> Value {
            self.access().agent_state("main", json!({})).unwrap()
        }
        fn note(&self, id: &str, text: &str) {
            self.access().agent_batch(&[note(id, json!(text))]).unwrap();
        }
        fn saved_note(&self, id: &str) -> Value {
            self.access()
                .agent_state("session.get", json!({"id":id}))
                .unwrap()["note"]
                .clone()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.workspace.shutdown();
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
    async fn answer(task: EffectTask) -> EffectResult {
        match task {
            EffectTask::ReadyWithAuxiliary(_, _) => {
                panic!("Unexpected auxiliary task in isolated effect test")
            }
            EffectTask::Ready(result) => result,
            EffectTask::Async(future) => future.await.unwrap(),
        }
    }
    fn first(approvals: &Approvals) -> Value {
        approvals.list().unwrap()[0].clone()
    }

    #[tokio::test]
    async fn default_allow_deny_and_already_cancelled_ask_create_no_documents() {
        let f = Fixture::new();
        let approvals = Approvals::new(f.access()).unwrap();
        let session = f.session();
        let cancel = RequestCancellation::new();
        cancel.cancel();
        assert_eq!(
            answer(
                approvals
                    .check(&session, "write", &json!({}), &cancel)
                    .unwrap()
            )
            .await
            .value,
            "allow"
        );
        f.rules(json!([{"tool":"write","action":"deny"}]));
        assert_eq!(
            answer(
                approvals
                    .check(&session, "write", &json!({}), &cancel)
                    .unwrap()
            )
            .await
            .value,
            "deny"
        );
        f.rules(json!([{"tool":"write","action":"ask"}]));
        assert_eq!(
            answer(
                approvals
                    .check(&session, "write", &json!({}), &cancel)
                    .unwrap()
            )
            .await
            .value,
            "declined"
        );
        assert_eq!(approvals.list().unwrap(), json!([]));
        assert_eq!(approvals.pending_count(), 0);
    }
    #[tokio::test]
    async fn ask_persists_exact_arguments_and_restores_note_only_in_actor_finish() {
        let f = Fixture::new();
        f.rules(json!([{"tool":"write","action":"ask","note":"Please check"}]));
        let approvals = Approvals::new(f.access()).unwrap();
        let session = f.session();
        let id = session["id"].as_str().unwrap();
        f.note(id, "Prior note");
        let mut events = f
            .workspace
            .subscribe(EventRequest {
                since: crate::MAX_SAFE_INTEGER,
                reconnect: false,
            })
            .unwrap();
        let cancel = RequestCancellation::new();
        let mut args = json!({"path":"before","content":"one"});
        let task = approvals.check(&session, "write", &args, &cancel).unwrap();
        args["path"] = json!("after");
        let doc = first(&approvals);
        assert_eq!(doc["args"]["path"], "before");
        assert_eq!(doc["note"], "Please check");
        assert_eq!(doc["status"], "pending");
        assert_eq!(approvals.pending_count(), 1);
        assert_eq!(f.saved_note(id), "承認待ち: write");
        let mut kinds = Vec::new();
        while let Ok(event) = events.receiver.try_recv() {
            kinds.push(event.event_type);
        }
        assert!(kinds.contains(&"approval.updated".to_owned()));
        assert!(kinds.contains(&"session.updated".to_owned()));
        let approved = approvals.decide(doc["id"].as_str().unwrap(), true).unwrap();
        assert_eq!(approved["status"], "approved");
        assert!(approved["decidedAt"].is_string());
        assert_eq!(approvals.pending_count(), 0);
        let result = answer(task).await;
        assert_eq!(result.value, "allow");
        assert_eq!(f.saved_note(id), "承認待ち: write");
        let result = approvals.finish(result, &cancel).unwrap();
        assert_eq!(result.value, "allow");
        assert!(result.facts.get(COMPLETION_FACT).is_none());
        assert_eq!(f.saved_note(id), "Prior note");
        assert_eq!(
            approvals
                .decide(doc["id"].as_str().unwrap(), true)
                .unwrap_err()
                .status,
            409
        );
        f.workspace.unsubscribe(events.id);
    }
    #[tokio::test]
    async fn decline_does_not_block_other_sessions_and_cancel_withdraws_only_target() {
        let f = Fixture::new();
        f.rules(json!([{"tool":"write","action":"ask"}]));
        let approvals = Approvals::new(f.access()).unwrap();
        let main = f.session();
        let worker = f
            .access()
            .agent_state(
                "session.create",
                json!({"fields":{"kind":"worker","title":"Worker"}}),
            )
            .unwrap();
        let c = RequestCancellation::new();
        let a = approvals
            .check(&main, "write", &json!({"path":"a"}), &c)
            .unwrap();
        let b = approvals
            .check(&worker, "write", &json!({"path":"b"}), &c)
            .unwrap();
        assert_eq!(
            answer(approvals.check(&worker, "read", &json!({}), &c).unwrap())
                .await
                .value,
            "allow"
        );
        approvals.cancel(main["id"].as_str().unwrap()).unwrap();
        assert_eq!(answer(a).await.value, "declined");
        assert_eq!(approvals.pending_count(), 1);
        let doc = approvals
            .list()
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["sessionId"] == worker["id"])
            .unwrap()
            .clone();
        approvals
            .decide(doc["id"].as_str().unwrap(), false)
            .unwrap();
        let result = answer(b).await;
        assert_eq!(result.value, "declined");
        approvals.finish(result, &c).unwrap();
        assert_eq!(f.saved_note(worker["id"].as_str().unwrap()), "");
    }
    #[tokio::test]
    async fn cancellation_and_late_decisions_never_restore_prior_notes() {
        let f = Fixture::new();
        f.rules(json!([{"tool":"write","action":"ask"}]));
        let approvals = Approvals::new(f.access()).unwrap();
        let session = f.session();
        let sid = session["id"].as_str().unwrap();
        f.note(sid, "before");
        let c = RequestCancellation::new();
        let task = approvals.check(&session, "write", &json!({}), &c).unwrap();
        let doc = first(&approvals);
        c.cancel();
        approvals.cancel(sid).unwrap();
        f.note(sid, "Stopped");
        let result = answer(task).await;
        approvals.finish(result, &c).unwrap();
        assert_eq!(f.saved_note(sid), "Stopped");
        assert_eq!(first(&approvals)["status"], "withdrawn");
        assert!(first(&approvals).get("decidedAt").is_none());
        assert_eq!(
            approvals
                .decide(doc["id"].as_str().unwrap(), true)
                .unwrap_err()
                .status,
            409
        );
    }
    #[tokio::test]
    async fn decision_then_stop_or_new_note_cannot_restore_an_old_note() {
        for stop in [false, true] {
            let f = Fixture::new();
            f.rules(json!([{"tool":"write","action":"ask"}]));
            let approvals = Approvals::new(f.access()).unwrap();
            let session = f.session();
            let sid = session["id"].as_str().unwrap();
            f.note(sid, "before");
            let c = RequestCancellation::new();
            let task = approvals.check(&session, "write", &json!({}), &c).unwrap();
            let doc = first(&approvals);
            approvals.decide(doc["id"].as_str().unwrap(), true).unwrap();
            let result = answer(task).await;
            if stop {
                approvals.cancel(sid).unwrap();
            }
            f.note(sid, "new actor note");
            approvals.finish(result, &c).unwrap();
            assert_eq!(f.saved_note(sid), "new actor note");
        }
    }
    #[tokio::test]
    async fn replacing_same_session_approval_invalidates_old_completion() {
        let f = Fixture::new();
        f.rules(json!([{"tool":"*","action":"ask"}]));
        let approvals = Approvals::new(f.access()).unwrap();
        let session = f.session();
        let sid = session["id"].as_str().unwrap();
        f.note(sid, "baseline");
        let c = RequestCancellation::new();
        let a = approvals.check(&session, "write", &json!({}), &c).unwrap();
        let aid = first(&approvals)["id"].as_str().unwrap().to_owned();
        approvals.decide(&aid, true).unwrap();
        let old = answer(a).await;
        let b = approvals.check(&session, "edit", &json!({}), &c).unwrap();
        let bid = first(&approvals)["id"].as_str().unwrap().to_owned();
        approvals.finish(old, &c).unwrap();
        assert_eq!(f.saved_note(sid), "承認待ち: edit");
        approvals.decide(&bid, false).unwrap();
        approvals.finish(answer(b).await, &c).unwrap();
        assert_eq!(f.saved_note(sid), "baseline");
    }
    #[tokio::test]
    async fn modified_persisted_arguments_cannot_grant_the_original_waiter() {
        let f = Fixture::new();
        f.rules(json!([{"tool":"*","action":"ask"}]));
        let approvals = Approvals::new(f.access()).unwrap();
        let session = f.session();
        let c = RequestCancellation::new();
        let task = approvals
            .check(&session, "write", &json!({"path":"approved-target"}), &c)
            .unwrap();
        let mut doc = first(&approvals);
        let id = doc["id"].as_str().unwrap().to_owned();
        doc["args"]["path"] = json!("replaced-target");
        f.access().agent_batch(&[put(doc)]).unwrap();
        assert_eq!(approvals.decide(&id, true).unwrap_err().status, 409);
        assert_eq!(answer(task).await.value, "declined");
        assert_eq!(first(&approvals)["status"], "withdrawn");
    }
    #[tokio::test]
    async fn initial_batch_failure_rolls_back_doc_and_releases_waiter() {
        let f = Fixture::new();
        f.rules(json!([{"tool":"*","action":"ask"}]));
        let approvals = Approvals::new(f.access()).unwrap();
        assert!(approvals
            .check(
                &json!({"id":"missing","title":"No session"}),
                "write",
                &json!({}),
                &RequestCancellation::new()
            )
            .is_err());
        assert_eq!(approvals.pending_count(), 0);
        assert_eq!(approvals.list().unwrap(), json!([]));
    }
    #[tokio::test]
    async fn decision_and_cancel_database_errors_still_release_waiters() {
        for decide in [false, true] {
            let f = Fixture::new();
            f.rules(json!([{"tool":"*","action":"ask"}]));
            let approvals = Approvals::new(f.access()).unwrap();
            let session = f.session();
            let c = RequestCancellation::new();
            let task = approvals.check(&session, "write", &json!({}), &c).unwrap();
            let id = first(&approvals)["id"].as_str().unwrap().to_owned();
            f.workspace.shutdown().unwrap();
            if decide {
                assert!(approvals.decide(&id, true).is_err());
            } else {
                assert!(approvals.cancel_all().is_err());
            }
            assert_eq!(approvals.pending_count(), 0);
            assert_eq!(answer(task).await.value, "declined");
        }
    }
    #[tokio::test]
    async fn dropped_waiter_is_withdrawn_and_cannot_be_approved() {
        let f = Fixture::new();
        f.rules(json!([{"tool":"*","action":"ask"}]));
        let approvals = Approvals::new(f.access()).unwrap();
        let session = f.session();
        let task = approvals
            .check(&session, "write", &json!({}), &RequestCancellation::new())
            .unwrap();
        let id = first(&approvals)["id"].as_str().unwrap().to_owned();
        drop(task);
        assert_eq!(approvals.decide(&id, true).unwrap_err().status, 409);
        assert_eq!(first(&approvals)["status"], "withdrawn");
        assert_eq!(approvals.pending_count(), 0);
    }
    #[test]
    fn startup_withdraws_pending_history_without_granting_or_emitting() {
        let f = Fixture::new();
        f.access().agent_batch(&[put(json!({"id":"old","sessionId":"old-session","tool":"write","args":{"path":"old"},"status":"pending","createdAt":"old"})),put(json!({"id":"decided","status":"approved"}))]).unwrap();
        let approvals = Approvals::new(f.access()).unwrap();
        let docs = approvals.list().unwrap();
        let old = docs
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["id"] == "old")
            .unwrap();
        assert_eq!(old["status"], "withdrawn");
        assert!(old["decidedAt"].is_string());
        assert_eq!(old["args"]["path"], "old");
        assert_eq!(approvals.pending_count(), 0);
        assert_eq!(approvals.decide("old", true).unwrap_err().status, 409);
    }
}
