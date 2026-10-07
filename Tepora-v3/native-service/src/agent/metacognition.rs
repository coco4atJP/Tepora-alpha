//! Live post-tool metacognition integration. The coordinator calls this once
//! after ordered receipts have committed. All storage calls are synchronous;
//! scheduling notifications are returned to the actor, never dispatched here.
use super::{Admission, EffectError};
use crate::ApiError;
use chrono::{DateTime, NaiveDate};
use serde_json::{json, Value};
use tepora_core::{
    js_value::{js_string, truthy},
    json_codec,
};

/// Implement on the existing host using its single Workspace state owner.
/// `send_parent` must use ordinary runtime send semantics (passive notify,
/// headers, inbox and waiter handling) and return its queued runtime events.
pub trait MetacogHost {
    fn state(&self, operation: &str, args: Value) -> Result<Value, ApiError>;
    fn event(&self, id: &str, name: &str, data: Value) -> Result<(), ApiError>;
    fn has_route(&self, role: &str) -> Result<bool, ApiError>;
    fn first_model(&self, role: &str) -> Result<Option<String>, ApiError>;
    fn send_parent(&self, id: &str, body: Value) -> Result<Admission, ApiError>;
}
#[derive(Clone, Debug)]
pub struct AfterToolsContext {
    pub built: Value,
    pub budget: Value,
    pub now_ms: i64,
    /// None derives the ISO creation time from the freshly read session;
    /// Some(None) preserves an invalid Date.parse result; Some(Some(ms)) is an
    /// exact injected parse for a legacy date representation.
    pub created_at_ms: Option<Option<i64>>,
}
#[derive(Clone, Debug)]
pub struct AfterToolsResult {
    /// Publish to the host's per-session memory only after this call succeeds.
    pub mem: Value,
    /// Queue these runtime notifications only after the whole effect batch.
    pub events: Vec<Value>,
}
fn compute(op: &str, payload: Value) -> Result<Value, EffectError> {
    let input = json_codec::stringify_js(&payload).map_err(|e| EffectError::new(e.to_string()))?;
    let out = tepora_core::compute_json(&format!("harness.{op}"), &input)
        .map_err(|e| EffectError::new(e.to_string()))?;
    json_codec::parse(&out).map_err(|e| EffectError::new(e.to_string()))
}
fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}
fn text(value: &Value, key: &str) -> String {
    js_string(value.get(key))
}
fn session(host: &dyn MetacogHost, id: &str) -> Result<Value, EffectError> {
    Ok(host.state("session.get", json!({"id":id}))?)
}
fn append(host: &dyn MetacogHost, id: &str, body: Value) -> Result<(), EffectError> {
    host.state(
        "session.append",
        json!({"id":id,"type":"notice","body":body}),
    )?;
    Ok(())
}
fn update(host: &dyn MetacogHost, id: &str, patch: Value) -> Result<(), EffectError> {
    host.state("session.update", json!({"id":id,"patch":patch}))?;
    Ok(())
}
fn notice(name: &str, args: Value) -> Result<Value, EffectError> {
    compute("prompts.notice", json!({"name":name,"args":args}))
}
fn warned(mem: &Value, key: &str) -> bool {
    array(&mem["warned"])
        .iter()
        .any(|v| v.as_str() == Some(key))
}
fn mark_warned(mem: &mut Value, key: String) {
    let mut values = array(&mem["warned"]).to_vec();
    if !values.iter().any(|v| v.as_str() == Some(&key)) {
        values.push(json!(key));
    }
    mem["warned"] = json!(values);
}
fn strict_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        _ => false,
    }
}
/// Runtime.escalate resets healthy inside watch, before watch's final healthy
/// increment. Recompute that one post-reset value instead of guessing role.
fn healthy_after_new_escalation(mem: &Value) -> u8 {
    let calls = array(&mem["calls"]);
    let Some(last) = calls.last() else { return 0 };
    let same = calls
        .iter()
        .filter(|c| {
            strict_equal(c.get("sig"), last.get("sig"))
                && strict_equal(c.get("outcome"), last.get("outcome"))
        })
        .count();
    u8::from(!truthy(&last["error"]) && same < 2)
}
fn escalate(
    host: &dyn MetacogHost,
    id: &str,
    reason: &str,
    mem: &mut Value,
    events: &mut Vec<Value>,
) -> Result<(), EffectError> {
    let current = session(host, id)?;
    if current.is_null() {
        return Err(EffectError::new("Session disappeared during escalation"));
    }
    if current["role"] != "escalation" && host.has_route("escalation")? {
        let model = host
            .first_model("escalation")?
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "escalation".into());
        update(
            host,
            id,
            json!({"role":"escalation","baseRole":current["role"]}),
        )?;
        append(
            host,
            id,
            json!({"text":notice("escalated",json!([model]))?}),
        )?;
        host.event(id, "escalated", json!({"reason":reason}))?;
        mem["healthy"] = json!(healthy_after_new_escalation(mem));
        return Ok(());
    }
    let key = format!("parent:{reason}");
    if truthy(&current["parentId"]) && !warned(mem, &key) {
        let title = text(&current, "title");
        let body = json!({"text":format!("Work agent \"{title}\" seems stuck ({reason}). It keeps trying; you may want to give it guidance with sessions_send or stop it."),"from":format!("child:{id}"),"kind":"report","mode":"notify","source":format!("status of \"{title}\" ({id})"),"meta":{"sessionId":id,"title":current["title"],"status":"stuck"}});
        let sent = host.send_parent(&text(&current, "parentId"), body)?;
        events.extend(sent.events);
        mark_warned(mem, key);
    }
    Ok(())
}
fn deescalate(host: &dyn MetacogHost, id: &str) -> Result<(), EffectError> {
    let current = session(host, id)?;
    if current["role"] != "escalation" || !truthy(&current["baseRole"]) {
        return Ok(());
    }
    update(
        host,
        id,
        json!({"role":current["baseRole"],"baseRole":null}),
    )?;
    append(host, id, json!({"text":notice("deescalated",json!([]))?}))?;
    host.event(id, "deescalated", json!({}))?;
    Ok(())
}
fn apply(
    host: &dyn MetacogHost,
    id: &str,
    actions: &[Value],
    mem: &mut Value,
    events: &mut Vec<Value>,
) -> Result<(), EffectError> {
    for action in actions {
        match action["kind"].as_str().unwrap_or("") {
            "notice" => {
                let mut body = json!({"text":action["text"]});
                if let Some(check) = action.get("selfCheck") {
                    body["selfCheck"] = check.clone();
                }
                append(host, id, body)?;
            }
            "event" => host.event(
                id,
                action["event"].as_str().unwrap_or(""),
                action["data"].clone(),
            )?,
            "escalate" => escalate(host, id, &text(action, "reason"), mem, events)?,
            "deescalate" => deescalate(host, id)?,
            other => {
                return Err(EffectError::new(format!(
                    "Unknown metacognition action {other}"
                )))
            }
        }
    }
    Ok(())
}
fn creation_ms(session: &Value, now_ms: i64) -> Option<i64> {
    let value = session
        .get("createdAt")
        .filter(|v| truthy(v))
        .or_else(|| session.get("created").filter(|v| truthy(v)));
    let Some(value) = value else {
        return Some(now_ms);
    };
    let raw = js_string(Some(value));
    DateTime::parse_from_rfc3339(&json_codec::sql_text(&raw))
        .ok()
        .map(|d| d.timestamp_millis())
        .or_else(|| {
            NaiveDate::parse_from_str(&raw, "%Y-%m-%d")
                .ok()
                .and_then(|d| d.and_hms_opt(0, 0, 0))
                .map(|d| d.and_utc().timestamp_millis())
        })
}

/// Apply watch using current state, then read current role/settings/team again
/// before calculating self-check facts. Caller input memory is never mutated;
/// successful output memory represents effects that have actually committed.
pub fn after_tools(
    host: &dyn MetacogHost,
    id: &str,
    mem: &Value,
    ctx: &AfterToolsContext,
) -> Result<AfterToolsResult, EffectError> {
    let initial = session(host, id)?;
    if initial.is_null() {
        return Err(EffectError::new("Session not found"));
    }
    let watch = compute("metacog.watch", json!({"session":initial,"mem":mem}))?;
    let mut next = watch["mem"].clone();
    let mut events = Vec::new();
    apply(host, id, array(&watch["actions"]), &mut next, &mut events)?;
    let current = session(host, id)?;
    if current.is_null() {
        return Ok(AfterToolsResult { mem: next, events });
    }
    let settings = host.state("settings", json!({}))?;
    if settings["metacognition"] == false {
        return Ok(AfterToolsResult { mem: next, events });
    }
    let team = if current["kind"] == "main" {
        host.state("session.list", json!({"parentId":id}))?
    } else {
        json!([])
    };
    let created = ctx
        .created_at_ms
        .unwrap_or_else(|| creation_ms(&current, ctx.now_ms));
    let check = compute(
        "metacog.selfCheck",
        json!({"session":current,"mem":next,"built":ctx.built,"B":ctx.budget["B"],"ratio":ctx.budget["ratio"],"profile":ctx.budget["profile"],"team":team,"nowMs":ctx.now_ms,"createdAtMs":created,"metacognition":settings["metacognition"]}),
    )?;
    // self-check memory becomes visible only after its transcript and event.
    let mut checked = check["mem"].clone();
    apply(
        host,
        id,
        array(&check["actions"]),
        &mut checked,
        &mut events,
    )?;
    Ok(AfterToolsResult {
        mem: checked,
        events,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::HashMap};
    struct Host {
        sessions: RefCell<HashMap<String, Value>>,
        log: RefCell<Vec<Value>>,
        settings: Value,
        route: bool,
        model: Option<String>,
        fail: Option<&'static str>,
    }
    impl Host {
        fn new(session: Value) -> Self {
            Self {
                sessions: RefCell::new(HashMap::from([("s".into(), session)])),
                log: RefCell::new(vec![]),
                settings: json!({"metacognition":true}),
                route: true,
                model: Some("strong-model".into()),
                fail: None,
            }
        }
        fn log(&self) -> Vec<Value> {
            self.log.borrow().clone()
        }
    }
    impl MetacogHost for Host {
        fn state(&self, operation: &str, args: Value) -> Result<Value, ApiError> {
            self.log
                .borrow_mut()
                .push(json!({"kind":"state","op":operation,"args":args}));
            if self.fail == Some(operation) {
                return Err(ApiError::new(500, "fixture commit failure"));
            }
            match operation {
                "session.get" => Ok(self
                    .sessions
                    .borrow()
                    .get(args["id"].as_str().unwrap())
                    .cloned()
                    .unwrap_or(Value::Null)),
                "session.update" => {
                    let mut sessions = self.sessions.borrow_mut();
                    let s = sessions.get_mut(args["id"].as_str().unwrap()).unwrap();
                    s.as_object_mut()
                        .unwrap()
                        .extend(args["patch"].as_object().unwrap().clone());
                    Ok(s.clone())
                }
                "session.append" => Ok(args["body"].clone()),
                "settings" => Ok(self.settings.clone()),
                "session.list" => Ok(json!(self
                    .sessions
                    .borrow()
                    .values()
                    .filter(|s| s["parentId"] == args["parentId"])
                    .cloned()
                    .collect::<Vec<_>>())),
                _ => panic!("unexpected state operation {operation}"),
            }
        }
        fn event(&self, id: &str, name: &str, data: Value) -> Result<(), ApiError> {
            self.log
                .borrow_mut()
                .push(json!({"kind":"event","id":id,"name":name,"data":data}));
            if self.fail == Some("event") {
                Err(ApiError::new(500, "event failure"))
            } else {
                Ok(())
            }
        }
        fn has_route(&self, role: &str) -> Result<bool, ApiError> {
            assert_eq!(role, "escalation");
            Ok(self.route)
        }
        fn first_model(&self, role: &str) -> Result<Option<String>, ApiError> {
            assert_eq!(role, "escalation");
            Ok(self.model.clone())
        }
        fn send_parent(&self, id: &str, body: Value) -> Result<Admission, ApiError> {
            self.log
                .borrow_mut()
                .push(json!({"kind":"send","id":id,"body":body}));
            if self.fail == Some("send") {
                return Err(ApiError::new(500, "send failure"));
            }
            Ok(Admission {
                value: json!({"queued":true}),
                events: vec![json!({"type":"fixtureNotification","sessionId":id})],
            })
        }
    }
    fn session() -> Value {
        json!({"id":"s","kind":"worker","title":"作業 🦊","parentId":"parent","role":"work","createdAt":"2026-10-07T00:00:00.000Z","stats":{"steps":15,"toolCalls":6,"toolErrors":0}})
    }
    fn context() -> AfterToolsContext {
        AfterToolsContext {
            built: json!({"tokens":100}),
            budget: json!({"B":1000,"ratio":1,"profile":{"model":"ordinary-model"}}),
            now_ms: 1791332100000,
            created_at_ms: None,
        }
    }
    fn repeated(n: usize) -> Value {
        json!({"calls":vec![json!({"sig":"sig","outcome":"out","label":"read(path=\"a\")","error":false});n],"warned":[],"errorStreak":0,"healthy":0})
    }
    fn notices(log: &[Value]) -> Vec<&Value> {
        log.iter()
            .filter(|x| x["op"] == "session.append")
            .map(|x| &x["args"]["body"])
            .collect()
    }
    #[test]
    fn escalates_before_fresh_self_check_and_returns_committed_memory() {
        let host = Host::new(session());
        let mem = repeated(6);
        let result = after_tools(&host, "s", &mem, &context()).unwrap();
        let log = host.log();
        assert_eq!(host.sessions.borrow()["s"]["role"], "escalation");
        assert_eq!(host.sessions.borrow()["s"]["baseRole"], "work");
        assert_eq!(result.mem["healthy"], 0);
        assert_eq!(mem["warned"], json!([]));
        assert_eq!(result.mem["warned"], json!(["sigout"]));
        let notes = notices(&log);
        assert!(notes[0]["text"].as_str().unwrap().contains("6 times"));
        assert!(notes[1]["text"].as_str().unwrap().contains("strong-model"));
        assert!(notes[2]["text"]
            .as_str()
            .unwrap()
            .contains("stronger model, after stalling"));
        let escalated = log.iter().position(|e| e["name"] == "escalated").unwrap();
        let self_check = log.iter().position(|e| e["name"] == "self-check").unwrap();
        assert!(escalated < self_check);
        assert_eq!(result.mem["selfCheckStep"], 15);
        assert!(result.events.is_empty());
    }
    #[test]
    fn missing_route_sends_exact_passive_parent_report_and_deduplicates() {
        let mut host = Host::new(session());
        host.route = false;
        let result = after_tools(&host, "s", &repeated(6), &context()).unwrap();
        assert_eq!(
            result.events,
            json!([{"type":"fixtureNotification","sessionId":"parent"}])
                .as_array()
                .unwrap()
                .clone()
        );
        let log = host.log();
        let sent = log.iter().find(|e| e["kind"] == "send").unwrap();
        assert_eq!(sent["body"]["mode"], "notify");
        assert_eq!(sent["body"]["from"], "child:s");
        assert_eq!(sent["body"]["source"], "status of \"作業 🦊\" (s)");
        assert_eq!(
            sent["body"]["meta"],
            json!({"sessionId":"s","title":"作業 🦊","status":"stuck"})
        );
        assert!(result.mem["warned"]
            .as_array()
            .unwrap()
            .contains(&json!("parent:repetition")));
        let again = after_tools(&host, "s", &result.mem, &context()).unwrap();
        assert!(again.events.is_empty());
        assert_eq!(host.log().iter().filter(|e| e["kind"] == "send").count(), 1);
        assert_eq!(host.sessions.borrow()["s"]["role"], "work");
    }
    #[test]
    fn already_escalated_reports_parent_and_reason_keys_are_independent() {
        let mut s = session();
        s["role"] = json!("escalation");
        s["baseRole"] = json!("work");
        let host = Host::new(s);
        let first = after_tools(&host, "s", &repeated(6), &context()).unwrap();
        let mut mem = first.mem;
        mem["errorStreak"] = json!(10);
        mem["calls"][5]["error"] = json!(true);
        let second = after_tools(&host, "s", &mem, &context()).unwrap();
        assert!(second.mem["warned"]
            .as_array()
            .unwrap()
            .contains(&json!("parent:repetition")));
        assert!(second.mem["warned"]
            .as_array()
            .unwrap()
            .contains(&json!("parent:repeated errors")));
        assert_eq!(host.log().iter().filter(|e| e["kind"] == "send").count(), 2);
    }
    #[test]
    fn healthy_deescalation_precedes_check_and_requires_base_role() {
        let mut s = session();
        s["role"] = json!("escalation");
        s["baseRole"] = json!("work");
        let host = Host::new(s.clone());
        let mut mem = repeated(1);
        mem["healthy"] = json!(7);
        let result = after_tools(&host, "s", &mem, &context()).unwrap();
        assert_eq!(result.mem["healthy"], 0);
        assert_eq!(host.sessions.borrow()["s"]["role"], "work");
        assert_eq!(host.sessions.borrow()["s"]["baseRole"], Value::Null);
        let log = host.log();
        assert!(notices(&log).last().unwrap()["text"]
            .as_str()
            .unwrap()
            .contains("ordinary-model"));
        assert!(!notices(&log).last().unwrap()["text"]
            .as_str()
            .unwrap()
            .contains("stronger model"));
        s["baseRole"] = Value::Null;
        let blocked = Host::new(s);
        after_tools(&blocked, "s", &mem, &context()).unwrap();
        assert_eq!(blocked.sessions.borrow()["s"]["role"], "escalation");
        assert!(!blocked.log().iter().any(|x| x["name"] == "deescalated"));
    }
    #[test]
    fn disabling_metacognition_keeps_watch_but_suppresses_self_check() {
        let mut host = Host::new(session());
        host.settings["metacognition"] = json!(false);
        let result = after_tools(&host, "s", &repeated(3), &context()).unwrap();
        assert!(result.mem.get("selfCheckStep").is_none());
        assert_eq!(notices(&host.log()).len(), 1);
    }
    #[test]
    fn failed_commit_or_parent_send_never_publishes_new_memory() {
        let mut host = Host::new(session());
        host.fail = Some("session.append");
        let mem = repeated(3);
        let original = mem.clone();
        assert!(after_tools(&host, "s", &mem, &context()).is_err());
        assert_eq!(mem, original);
        let mut host = Host::new(session());
        host.route = false;
        host.fail = Some("send");
        let mem = repeated(6);
        assert!(after_tools(&host, "s", &mem, &context()).is_err());
        assert!(!warned(&mem, "parent:repetition"));
    }
    #[test]
    fn main_checks_include_current_children_and_creation_override() {
        let mut s = session();
        s["kind"] = json!("main");
        s["stats"]["steps"] = json!(1);
        let host = Host::new(s);
        host.sessions.borrow_mut().insert(
            "child".into(),
            json!({"id":"child","parentId":"s","title":"child job","status":"running"}),
        );
        let mut ctx = context();
        ctx.built = json!({"tokens":650});
        ctx.created_at_ms = Some(Some(ctx.now_ms - 120000));
        let result = after_tools(&host, "s", &repeated(1), &ctx).unwrap();
        assert_eq!(result.mem["selfCheckContext"], true);
        let log = host.log();
        let text = notices(&log).last().unwrap()["text"].as_str().unwrap();
        assert!(text.contains("2 min"));
        assert!(text.contains("Work agents running: \"child job\" running."));
    }
}
