//! Native outer runtime: admission, timer identity, lifecycle and turn choices.
//! The host owns async handles and effects, not scheduling authority. No database
//! connection, OS timer, plugin callback or network request is created here.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Default, Debug)]
struct Observation {
    session: Value,
    tail: Value,
    pending: u64,
    last_at: Option<f64>,
}
#[derive(Default, Debug)]
struct Control {
    epoch: u64,
    nudges: u64,
    claims: u64,
    verified: bool,
}
#[derive(Clone, Debug)]
struct Timer {
    token: u64,
    deadline: f64,
    reason: String,
}
#[derive(Clone, Debug)]
enum Await {
    Deliver,
    Step,
    ProbeFiles,
    TurnEnd,
    CompletionContext,
    CompletionDecision,
    MainTurn,
    Yield,
    Auxiliary,
}
#[derive(Debug)]
struct Run {
    epoch: u64,
    session_kind: String,
    auxiliary: bool,
    draining: bool,
    resume: bool,
    wake_after: bool,
    pending: HashMap<String, Await>,
    turn: Value,
    report: String,
    completion: Value,
    decision: bool,
}
#[derive(Default)]
struct Response {
    actions: Vec<Value>,
    commands: Vec<Value>,
}
#[derive(Default)]
pub struct RuntimeEngine {
    observed: HashMap<String, Observation>,
    order: Vec<String>,
    controls: HashMap<String, Control>,
    runs: HashMap<String, Run>,
    timers: HashMap<String, Timer>,
    settings: Value,
    now: f64,
    daily_cost: f64,
    decision_available: bool,
    has_hooks: bool,
    sequence: u64,
    closed: bool,
    resources_closed: bool,
}
fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
}
fn num(v: &Value, key: &str, default: f64) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(default)
}
fn whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn one_line(value: &str, max: usize) -> String {
    let value = value
        .split(whitespace)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let units = crate::json_codec::utf16_units(&value);
    if units.len() <= max {
        value
    } else {
        format!(
            "{}…",
            crate::json_codec::from_utf16_units(&units[..max.saturating_sub(1)])
        )
    }
}
fn action(out: &mut Response, id: Option<&str>, epoch: Option<u64>, kind: &str, fields: Value) {
    let mut value = fields.as_object().cloned().unwrap_or_default();
    value.insert("kind".into(), json!(kind));
    if let Some(id) = id {
        value.insert("sessionId".into(), json!(id));
    }
    if let Some(epoch) = epoch {
        value.insert("runEpoch".into(), json!(epoch));
    }
    out.actions.push(Value::Object(value));
}
pub fn needs_step(tail: &Value) -> bool {
    let Some(tail) = tail.as_array() else {
        return false;
    };
    for e in tail.iter().rev().take(12) {
        match e["type"].as_str().unwrap_or("") {
            "event" | "clear" | "checkpoint" => continue,
            "input" if crate::js_value::truthy(&e["passive"]) => continue,
            "assistant" => {
                let calls = &e["toolCalls"];
                let has_length = match calls {
                    Value::Array(calls) => !calls.is_empty(),
                    Value::String(calls) => !calls.is_empty(),
                    Value::Object(calls) => {
                        calls.get("length").is_some_and(crate::js_value::truthy)
                    }
                    _ => false,
                };
                return has_length || crate::js_value::truthy(&e["truncated"]);
            }
            _ => return true,
        }
    }
    false
}
pub fn over_budget(session: &Value, settings: &Value, daily_cost: f64) -> Value {
    let budget = &settings["budget"];
    let per = num(budget, "sessionUsd", 0.0);
    let daily = num(budget, "dailyUsd", 0.0);
    if per > 0.0 && num(&session["stats"], "cost", 0.0) >= per {
        return json!(format!(
            "この仕事の費用が上限（${}）に達しました。設定で上限を上げると続きます。",
            crate::js_value::js_string(budget.get("sessionUsd"))
        ));
    }
    if daily > 0.0 && daily_cost >= daily {
        return json!(format!(
            "今日の費用が上限（${}）に達しました。設定で上限を上げると続きます。",
            crate::js_value::js_string(budget.get("dailyUsd"))
        ));
    }
    Value::Null
}
pub fn completion_plan(session: &Value, settings: &Value, decision: bool, verified: bool) -> Value {
    // A missing setting gets the default. A persisted non-string setting is
    // retained by the JS settings spread and must not become an implicit auto.
    let mode = match settings.get("verifyCompletion") {
        None => "auto",
        Some(value) => value.as_str().unwrap_or(""),
    };
    let unsure = num(&session["reflection"], "confidence", 1.0) < 0.5;
    let eligible = mode != "off"
        && session["kind"] != "main"
        && !verified
        && num(&session["stats"], "toolCalls", 0.0) >= if decision || unsure { 1.0 } else { 3.0 };
    let method = if !eligible {
        Value::Null
    } else if decision {
        json!("decision")
    } else if mode == "auto" || mode == "self" {
        json!("self")
    } else {
        Value::Null
    };
    json!({"eligible":eligible,"decision":decision,"method":method})
}
pub fn completion_verdict(raw: &Value, q: &Value) -> Value {
    let Some(p) = raw.as_f64() else {
        return json!({"probability":null,"accepted":null});
    };
    let p = if q["invert"] == true { 1.0 - p } else { p };
    json!({"probability":p,"accepted":p>=num(q,"threshold",0.5)})
}
impl RuntimeEngine {
    pub fn new() -> Self {
        Self::default()
    }
    fn token(&mut self) -> u64 {
        self.sequence += 1;
        self.sequence
    }
    fn ingest(&mut self, facts: &Value) {
        if let Some(v) = facts.get("nowMs").and_then(Value::as_f64) {
            self.now = v;
        }
        if let Some(v) = facts.get("settings") {
            self.settings = v.clone();
        }
        if let Some(v) = facts.get("dailyCost").and_then(Value::as_f64) {
            self.daily_cost = v;
        }
        if let Some(v) = facts.get("decisionAvailable").and_then(Value::as_bool) {
            self.decision_available = v;
        }
        if let Some(v) = facts.get("hasHooks").and_then(Value::as_bool) {
            self.has_hooks = v;
        }
        if let Some(list) = facts.get("sessions").and_then(Value::as_array) {
            self.order = list
                .iter()
                .map(|o| text(&o["session"], "id"))
                .filter(|id| !id.is_empty())
                .collect();
            let present = self.order.iter().cloned().collect::<HashSet<_>>();
            self.observed.retain(|id, _| present.contains(id));
            for observation in list {
                let session = &observation["session"];
                let id = text(session, "id");
                if id.is_empty() {
                    continue;
                }
                self.controls.entry(id.clone()).or_default();
                self.observed.insert(
                    id,
                    Observation {
                        session: session.clone(),
                        tail: observation.get("tail").cloned().unwrap_or(json!([])),
                        pending: observation["pending"].as_u64().unwrap_or_else(|| {
                            observation["pending"]
                                .as_array()
                                .map(|a| a.len() as u64)
                                .unwrap_or(0)
                        }),
                        last_at: observation.get("lastAtMs").and_then(Value::as_f64),
                    },
                );
            }
        }
    }
    fn output(&self, out: Response) -> Value {
        json!({"actions":out.actions,"commands":out.commands,"closed":self.closed,"draining":self.runs.values().filter(|r|r.draining).count(),"complete":self.closed&&self.resources_closed})
    }
    fn snapshot(&self, id: &str) -> Value {
        self.observed
            .get(id)
            .map(|o| o.session.clone())
            .unwrap_or(Value::Null)
    }
    fn patch(
        &mut self,
        id: &str,
        epoch: Option<u64>,
        patch: Value,
        retry_at: Option<f64>,
        out: &mut Response,
    ) {
        if let Some(o) = self.observed.get_mut(id) {
            if let (Some(s), Some(p)) = (o.session.as_object_mut(), patch.as_object()) {
                for (k, v) in p {
                    s.insert(k.clone(), v.clone());
                }
            }
        }
        let mut fields = json!({"patch":patch});
        if let Some(deadline) = retry_at {
            fields["retryAtMs"] = json!(deadline);
        }
        action(out, Some(id), epoch, "updateSession", fields);
    }
    fn issue(
        &mut self,
        id: &str,
        run: &mut Run,
        awaiting: Await,
        kind: &str,
        fields: Value,
        out: &mut Response,
    ) {
        let op = format!("{}:{}", run.epoch, self.token());
        run.pending.insert(op.clone(), awaiting);
        let mut fields = fields.as_object().cloned().unwrap_or_default();
        fields.insert("kind".into(), json!(kind));
        fields.insert("sessionId".into(), json!(id));
        fields.insert("runEpoch".into(), json!(run.epoch));
        fields.insert("operationId".into(), json!(op));
        out.commands.push(Value::Object(fields));
    }
    fn notice(&self, id: &str, run: &Run, name: &str, args: Value, out: &mut Response) {
        action(
            out,
            Some(id),
            Some(run.epoch),
            "notice",
            json!({"notice":name,"args":args}),
        );
    }
    fn emit_event(
        &self,
        id: &str,
        epoch: Option<u64>,
        name: &str,
        data: Value,
        out: &mut Response,
    ) {
        action(
            out,
            Some(id),
            epoch,
            "event",
            json!({"event":name,"data":data}),
        );
    }
    fn cancel_timer(&mut self, id: &str, out: &mut Response) {
        if let Some(t) = self.timers.remove(id) {
            action(
                out,
                Some(id),
                None,
                "cancelTimer",
                json!({"timerToken":t.token}),
            );
        }
    }
    fn arm_timer(
        &mut self,
        id: &str,
        epoch: Option<u64>,
        ms: f64,
        reason: &str,
        out: &mut Response,
    ) {
        self.cancel_timer(id, out);
        let token = self.token();
        let deadline = self.now + ms;
        self.timers.insert(
            id.into(),
            Timer {
                token,
                deadline,
                reason: reason.into(),
            },
        );
        action(
            out,
            Some(id),
            epoch,
            "armTimer",
            json!({"timerToken":token,"deadlineMs":deadline}),
        );
    }
    fn active_workers(&self) -> usize {
        self.runs
            .values()
            .filter(|r| r.session_kind != "main")
            .count()
    }
    fn admit(&mut self, id: &str, auxiliary: bool, out: &mut Response) {
        if self.closed {
            return;
        }
        let Some(observed) = self.observed.get(id).cloned() else {
            return;
        };
        if observed.session["status"] == "stopped" {
            return;
        }
        if let Some(run) = self.runs.get_mut(id) {
            if !auxiliary && (run.draining || run.auxiliary) {
                run.wake_after = true;
            }
            return;
        }
        if !auxiliary {
            self.cancel_timer(id, out);
        }
        let kind = if auxiliary {
            "main".to_owned()
        } else {
            text(&observed.session, "kind")
        };
        if kind != "main" && self.active_workers() as f64 >= num(&self.settings, "concurrency", 8.0)
        {
            if observed.session["status"] != "waiting" {
                self.patch(
                    id,
                    None,
                    json!({"status":"waiting","note":"ほかの作業の空きを待っています"}),
                    None,
                    out,
                );
            }
            return;
        }
        let epoch = self.token();
        self.controls.entry(id.into()).or_default().epoch = epoch;
        let mut run = Run {
            epoch,
            session_kind: kind.clone(),
            auxiliary,
            draining: false,
            resume: false,
            wake_after: false,
            pending: HashMap::new(),
            turn: Value::Null,
            report: String::new(),
            completion: Value::Null,
            decision: false,
        };
        action(
            out,
            Some(id),
            Some(epoch),
            "createRun",
            json!({"sessionKind":kind,"leaseKind":if auxiliary{"idleCompaction"}else{"work"}}),
        );
        self.issue(
            id,
            &mut run,
            if auxiliary {
                Await::Auxiliary
            } else {
                Await::Deliver
            },
            if auxiliary { "idleCompact" } else { "deliver" },
            json!({}),
            out,
        );
        self.runs.insert(id.into(), run);
    }
    fn deferred(&mut self, out: &mut Response) {
        if self.closed {
            return;
        }
        for id in self.order.clone() {
            if self.runs.contains_key(&id) || self.timers.contains_key(&id) {
                continue;
            }
            let Some(o) = self.observed.get(&id) else {
                continue;
            };
            if o.session["status"] == "waiting" && (o.pending > 0 || needs_step(&o.tail)) {
                self.admit(&id, false, out);
            }
        }
    }
    fn close_ready(&mut self, out: &mut Response) {
        if self.closed && self.runs.is_empty() && !self.resources_closed {
            self.resources_closed = true;
            action(out, None, None, "closeResources", json!({}));
        }
    }
    fn release(&mut self, id: &str, run: Run, out: &mut Response) {
        action(out, Some(id), Some(run.epoch), "releaseRun", json!({}));
        let wanted = run.resume
            || run.wake_after
            || (run.auxiliary && self.observed.get(id).is_some_and(|o| o.pending > 0));
        if wanted && !self.closed && self.snapshot(id)["status"] != "stopped" {
            self.admit(id, false, out);
        }
        self.deferred(out);
        self.close_ready(out);
    }
    fn next_cycle(&mut self, id: &str, run: &mut Run, out: &mut Response) {
        self.issue(id, run, Await::Deliver, "deliver", json!({}), out);
    }
    fn stop_one(&mut self, id: &str, reason: &str, out: &mut Response) {
        self.cancel_timer(id, out);
        let epoch = self.token();
        self.controls.entry(id.into()).or_default().epoch = epoch;
        if let Some(run) = self.runs.get_mut(id) {
            run.draining = true;
            run.resume = false;
            run.wake_after = false;
            action(
                out,
                Some(id),
                Some(run.epoch),
                "abortRun",
                json!({"reason":reason}),
            );
        }
        action(
            out,
            Some(id),
            None,
            "stopResources",
            json!({"reason":reason}),
        );
        self.patch(
            id,
            None,
            json!({"status":"stopped","note":one_line(reason,120)}),
            None,
            out,
        );
    }
    pub fn dispatch(&mut self, event: Value, facts: Value) -> Result<Value, String> {
        self.ingest(&facts);
        let id = text(&event, "sessionId");
        let mut out = Response::default();
        for missing in self
            .timers
            .keys()
            .filter(|id| !self.observed.contains_key(*id))
            .cloned()
            .collect::<Vec<_>>()
        {
            self.cancel_timer(&missing, &mut out);
        }
        for missing in self
            .runs
            .keys()
            .filter(|id| !self.observed.contains_key(*id))
            .cloned()
            .collect::<Vec<_>>()
        {
            let invalid = self.token();
            self.controls.entry(missing.clone()).or_default().epoch = invalid;
            let run = self.runs.get_mut(&missing).unwrap();
            run.draining = true;
            run.resume = false;
            run.wake_after = false;
            action(
                &mut out,
                Some(&missing),
                Some(run.epoch),
                "abortRun",
                json!({"reason":"Session removed"}),
            );
        }
        match text(&event, "type").as_str() {
            "initialize" => {
                if !self.closed {
                    for id in self.order.clone() {
                        let o = self.observed.get(&id).unwrap();
                        if matches!(o.session["status"].as_str(), Some("running" | "waiting"))
                            || o.pending > 0
                            || (o.session["status"] == "idle" && needs_step(&o.tail))
                        {
                            self.admit(&id, false, &mut out);
                        }
                    }
                }
            }
            "wakeDeferred" => self.deferred(&mut out),
            "wake" => {
                if !self.closed
                    && self.snapshot(&id)["status"] == "stopped"
                    && matches!(
                        event.get("from").and_then(Value::as_str),
                        Some("user" | "parent" | "system")
                    )
                {
                    self.patch(
                        &id,
                        None,
                        json!({"status":"idle","result":null}),
                        None,
                        &mut out,
                    );
                    action(&mut out, Some(&id), None, "refreshPrompt", json!({}));
                }
                self.admit(&id, false, &mut out);
            }
            "later" => {
                if !self.closed {
                    self.arm_timer(
                        &id,
                        None,
                        num(&event, "ms", 0.0),
                        event
                            .get("reason")
                            .and_then(Value::as_str)
                            .unwrap_or("manual"),
                        &mut out,
                    );
                }
            }
            "resume" => {
                if !self.closed && self.observed.contains_key(&id) {
                    if self.snapshot(&id)["status"] == "stopped" {
                        self.patch(&id, None, json!({"status":"idle"}), None, &mut out);
                    }
                    if text(&event, "mode") == "rearm" {
                        if let Some(run) = self.runs.get_mut(&id) {
                            run.resume = false;
                            run.wake_after = false;
                        }
                    } else if let Some(run) = self.runs.get_mut(&id) {
                        if run.draining {
                            run.resume = true;
                        }
                    } else {
                        self.admit(&id, false, &mut out);
                    }
                }
            }
            "stop" => {
                if !self.observed.contains_key(&id) {
                    return Err("[404] Session not found".into());
                }
                let reason = event
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("stopped");
                let mut todo = vec![(id.clone(), reason.to_owned())];
                let mut seen = HashSet::new();
                while let Some((target, reason)) = todo.pop() {
                    if !seen.insert(target.clone()) {
                        continue;
                    }
                    self.stop_one(&target, &reason, &mut out);
                    for child in self.order.clone() {
                        let s = self.snapshot(&child);
                        if s["parentId"] == target
                            && s["kind"] == "worker"
                            && matches!(s["status"].as_str(), Some("running" | "waiting" | "idle"))
                        {
                            todo.push((child, "parent stopped".into()));
                        }
                    }
                }
            }
            "settingsChanged" => {
                if !self.closed {
                    let budget_ids = self
                        .timers
                        .iter()
                        .filter(|(_, t)| event["budgetChanged"] == true && t.reason == "budget")
                        .map(|(id, _)| id.clone())
                        .collect::<Vec<_>>();
                    for id in budget_ids {
                        self.cancel_timer(&id, &mut out);
                        self.admit(&id, false, &mut out);
                    }
                    self.deferred(&mut out);
                }
            }
            "timerFired" => {
                if !self.closed {
                    if let Some(timer) = self.timers.get(&id).cloned() {
                        if event["timerToken"].as_u64() == Some(timer.token) {
                            if self.now < timer.deadline {
                                action(
                                    &mut out,
                                    Some(&id),
                                    None,
                                    "armTimer",
                                    json!({"timerToken":timer.token,"deadlineMs":timer.deadline}),
                                );
                            } else {
                                self.cancel_timer(&id, &mut out);
                                self.admit(&id, false, &mut out);
                            }
                        }
                    }
                }
            }
            "auxiliary" => {
                if let Some(o) = self.observed.get(&id) {
                    let last = event.get("lastAtMs").and_then(Value::as_f64).or(o.last_at);
                    let eligible = !self.closed
                        && !self.runs.contains_key(&id)
                        && o.session["status"] == "idle"
                        && o.pending == 0
                        && o.tail.as_array().is_some_and(|tail| !tail.is_empty())
                        && last.is_some_and(|last| {
                            self.now - last
                                >= num(&self.settings, "idleCompactSeconds", 20.0) * 1000.0
                        });
                    if eligible {
                        self.admit(&id, true, &mut out);
                    }
                }
            }
            "markVerified" => {
                self.controls.entry(id.clone()).or_default().verified = true;
            }
            "resolved" | "rejected" => self.settled(&event, &mut out)?,
            "leaseDrained" => {
                if self
                    .runs
                    .get(&id)
                    .is_some_and(|r| r.draining && event["runEpoch"].as_u64() == Some(r.epoch))
                {
                    let run = self.runs.remove(&id).unwrap();
                    self.release(&id, run, &mut out);
                }
            }
            "close" => {
                if !self.closed {
                    self.closed = true;
                    action(&mut out, None, None, "shutdownSchedulers", json!({}));
                    for id in self.timers.keys().cloned().collect::<Vec<_>>() {
                        self.cancel_timer(&id, &mut out);
                    }
                    action(&mut out, None, None, "cancelAllApprovals", json!({}));
                    for id in self.runs.keys().cloned().collect::<Vec<_>>() {
                        let invalid = self.token();
                        self.controls.entry(id.clone()).or_default().epoch = invalid;
                        let run = self.runs.get_mut(&id).unwrap();
                        run.draining = true;
                        run.resume = false;
                        run.wake_after = false;
                        action(
                            &mut out,
                            Some(&id),
                            Some(run.epoch),
                            "abortRun",
                            json!({"reason":"Service closing"}),
                        );
                    }
                }
                self.close_ready(&mut out);
            }
            _ => return Err("Unknown runtime event".into()),
        }
        Ok(self.output(out))
    }
    fn settled(&mut self, event: &Value, out: &mut Response) -> Result<(), String> {
        let id = text(event, "sessionId");
        let epoch = event["runEpoch"].as_u64();
        if !self.runs.get(&id).is_some_and(|r| Some(r.epoch) == epoch) {
            return Ok(());
        }
        let mut run = self.runs.remove(&id).unwrap();
        let op = text(event, "operationId");
        let Some(awaiting) = run.pending.remove(&op) else {
            self.runs.insert(id, run);
            return Ok(());
        };
        if run.draining || event["aborted"] == true {
            self.release(&id, run, out);
            return Ok(());
        }
        if event["type"] == "rejected" {
            let error = &event["error"];
            let message = error
                .get("stack")
                .and_then(Value::as_str)
                .unwrap_or_else(|| {
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Runtime effect failed")
                });
            self.emit_event(
                &id,
                Some(run.epoch),
                "crash",
                json!({"message":one_line(message,600)}),
                out,
            );
            self.release(&id, run, out);
            return Ok(());
        }
        let value = event.get("value").cloned().unwrap_or(Value::Null);
        let mut release = false;
        match awaiting {
            Await::Deliver => {
                let o = self.observed.get(&id).cloned().unwrap_or_default();
                let delivered = num(&value, "delivered", 0.0);
                if delivered == 0.0 && !needs_step(&o.tail) {
                    if matches!(o.session["status"].as_str(), Some("running" | "waiting")) {
                        let done = o.session["kind"] == "worker"
                            && o.session.get("result").is_some_and(|v| !v.is_null());
                        self.patch(
                            &id,
                            Some(run.epoch),
                            json!({"status":if done{"done"}else{"idle"},"note":""}),
                            None,
                            out,
                        );
                    }
                    release = true;
                } else {
                    let over = over_budget(&o.session, &self.settings, self.daily_cost);
                    if !over.is_null() {
                        self.patch(
                            &id,
                            Some(run.epoch),
                            json!({"status":"waiting","note":over,"retryAt":null}),
                            None,
                            out,
                        );
                        self.arm_timer(&id, Some(run.epoch), 600000.0, "budget", out);
                        self.emit_event(&id, Some(run.epoch), "budget", json!({"note":over}), out);
                        release = true;
                    } else {
                        self.patch(
                            &id,
                            Some(run.epoch),
                            json!({"status":"running","note":"考えています","retryAt":null}),
                            None,
                            out,
                        );
                        self.issue(&id, &mut run, Await::Step, "step", json!({}), out);
                    }
                }
            }
            Await::Step => {
                run.turn = self.snapshot(&id);
                run.report = text(&value, "text");
                if num(&value, "wait", 0.0) != 0.0 {
                    let ms = num(&value, "wait", 0.0);
                    self.patch(
                        &id,
                        Some(run.epoch),
                        json!({"status":"waiting","note":text(&value,"note")}),
                        Some(self.now + ms),
                        out,
                    );
                    self.arm_timer(&id, Some(run.epoch), ms, "provider", out);
                    self.emit_event(
                        &id,
                        Some(run.epoch),
                        "waiting",
                        json!({"note":value.get("note"),"ms":ms}),
                        out,
                    );
                    release = true;
                } else if value["turnEnded"] == true {
                    if run.turn["kind"] == "main" {
                        let fields = json!({"session":run.turn,"text":run.report});
                        self.issue(&id, &mut run, Await::MainTurn, "mainTurn", fields, out);
                    } else {
                        self.worker_turn(&id, &mut run, out);
                    }
                } else {
                    let every = num(&self.settings, "progressEvery", 50.0);
                    let total = num(&run.turn["stats"], "steps", 0.0);
                    if run
                        .turn
                        .get("parentId")
                        .is_some_and(|v| v.is_string() && !v.as_str().unwrap_or("").is_empty())
                        && every != 0.0
                        && total % every == 0.0
                    {
                        action(out, Some(&id), Some(run.epoch), "progress", json!({}));
                    }
                    let max = num(&self.settings, "maxSteps", 0.0);
                    if max != 0.0 && run.turn["kind"] != "main" && total >= max {
                        let mut report = format!(
                            "（ステップ上限 {} に達したため、ここで報告します）\n",
                            crate::js_value::js_string(self.settings.get("maxSteps"))
                        );
                        if let Some(todo) = run.turn["todo"].as_array().filter(|v| !v.is_empty()) {
                            report.push_str("残り:\n");
                            report.push_str(
                                &todo
                                    .iter()
                                    .filter(|v| v["status"] != "done")
                                    .map(|v| format!("- {}", text(v, "text")))
                                    .collect::<Vec<_>>()
                                    .join("\n"),
                            );
                        }
                        self.finish_action(&id, &run, &report, out);
                        release = true;
                    } else {
                        self.issue(&id, &mut run, Await::Yield, "yield", json!({}), out);
                    }
                }
            }
            Await::ProbeFiles => {
                let paths = value.as_array().cloned().unwrap_or_default();
                if !paths.is_empty() {
                    self.controls.entry(id.clone()).or_default().claims += 1;
                    self.emit_event(
                        &id,
                        Some(run.epoch),
                        "missing-files",
                        json!({"paths":paths}),
                        out,
                    );
                    self.notice(
                        &id,
                        &run,
                        "missingFiles",
                        json!([paths, num(&run.turn["stats"], "toolCalls", 0.0) == 0.0]),
                        out,
                    );
                    self.next_cycle(&id, &mut run, out);
                } else {
                    self.after_files(&id, &mut run, out);
                }
            }
            Await::TurnEnd => {
                let continuation = value.get("continue").and_then(Value::as_str).unwrap_or("");
                let control = self.controls.entry(id.clone()).or_default();
                if !continuation.trim_matches(whitespace).is_empty() && control.nudges < 3 {
                    control.nudges += 1;
                    action(
                        out,
                        Some(&id),
                        Some(run.epoch),
                        "appendNotice",
                        json!({"text":continuation}),
                    );
                    self.next_cycle(&id, &mut run, out);
                } else {
                    self.completion(&id, &mut run, out);
                }
            }
            Await::CompletionContext => {
                run.completion = value;
                if run.decision {
                    let fields = json!({"state":run.completion["state"],"q":run.completion["q"]});
                    self.issue(
                        &id,
                        &mut run,
                        Await::CompletionDecision,
                        "completionDecision",
                        fields,
                        out,
                    );
                } else {
                    self.emit_event(
                        &id,
                        Some(run.epoch),
                        "completion-check",
                        json!({"method":"self"}),
                        out,
                    );
                    self.notice(
                        &id,
                        &run,
                        "verify",
                        json!([run.completion["brief"], null]),
                        out,
                    );
                    self.next_cycle(&id, &mut run, out);
                }
            }
            Await::CompletionDecision => {
                let q = &run.completion["q"];
                let verdict = completion_verdict(&value, q);
                self.emit_event(&id,Some(run.epoch),"completion-check",json!({"method":"decision","probability":verdict["probability"],"question":q["id"]}),out);
                if !verdict["probability"].is_null() {
                    action(
                        out,
                        Some(&id),
                        Some(run.epoch),
                        "dreamRecord",
                        json!({"recordKind":"completion","data":{"question":q["id"],"p":value,"threshold":q["threshold"],"action":if verdict["accepted"]==true{1}else{0},"state":run.completion["state"]}}),
                    );
                }
                if verdict["accepted"] == false {
                    self.notice(
                        &id,
                        &run,
                        "verify",
                        json!([
                            run.completion["brief"],
                            "the report does not clearly show that every part is done"
                        ]),
                        out,
                    );
                    self.next_cycle(&id, &mut run, out);
                } else {
                    self.finish_turn(&id, &mut run, out);
                }
            }
            Await::MainTurn => {
                if value["delegated"] != true {
                    action(
                        out,
                        Some(&id),
                        Some(run.epoch),
                        "reply",
                        json!({"text":run.report}),
                    );
                }
                self.next_cycle(&id, &mut run, out);
            }
            Await::Yield => self.next_cycle(&id, &mut run, out),
            Await::Auxiliary => {
                release = true;
            }
        }
        if release {
            self.release(&id, run, out);
        } else {
            self.runs.insert(id, run);
        }
        Ok(())
    }
    fn worker_turn(&mut self, id: &str, run: &mut Run, out: &mut Response) {
        let open = run.turn["todo"]
            .as_array()
            .map(|todo| {
                todo.iter()
                    .filter(|t| t["status"] != "done" && t["status"] != "blocked")
                    .map(|t| format!("- {}", text(t, "text")))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let control = self.controls.entry(id.into()).or_default();
        if !open.is_empty() && control.nudges < 2 {
            control.nudges += 1;
            self.notice(id, run, "unfinished", json!([open.join("\n")]), out);
            self.next_cycle(id, run, out);
        } else if run.turn["kind"] == "worker" && control.claims < 2 {
            let fields = json!({"session":run.turn,"report":run.report});
            self.issue(id, run, Await::ProbeFiles, "probeFiles", fields, out);
        } else {
            self.after_files(id, run, out);
        }
    }
    fn after_files(&mut self, id: &str, run: &mut Run, out: &mut Response) {
        let control = self.controls.entry(id.into()).or_default();
        if num(&run.turn["stats"], "toolCalls", 0.0) == 0.0
            && run.turn["kind"] == "worker"
            && control.nudges < 1
            && run.turn["toolset"] != "lean"
        {
            control.nudges += 1;
            self.notice(id, run, "noWork", json!([]), out);
            self.next_cycle(id, run, out);
        } else if self.has_hooks {
            let fields = json!({"session":run.turn,"text":run.report});
            self.issue(id, run, Await::TurnEnd, "turnEndHook", fields, out);
        } else {
            self.completion(id, run, out);
        }
    }
    fn completion(&mut self, id: &str, run: &mut Run, out: &mut Response) {
        let control = self.controls.entry(id.into()).or_default();
        let plan = completion_plan(
            &run.turn,
            &self.settings,
            self.decision_available,
            control.verified,
        );
        if plan["eligible"] != true {
            self.finish_turn(id, run, out);
            return;
        }
        control.verified = true;
        run.decision = plan["decision"] == true;
        if plan["method"].is_null() {
            self.finish_turn(id, run, out);
            return;
        }
        let fields = json!({"session":run.turn,"report":run.report});
        self.issue(
            id,
            run,
            Await::CompletionContext,
            "completionContext",
            fields,
            out,
        );
    }
    fn finish_action(&mut self, id: &str, run: &Run, report: &str, out: &mut Response) {
        let status = if self.snapshot(id)["kind"] == "specialist" {
            "idle"
        } else {
            "done"
        };
        if let Some(o) = self.observed.get_mut(id) {
            o.session["status"] = json!(status);
            o.session["result"] = json!(report);
            o.session["note"] = json!("");
        }
        action(
            out,
            Some(id),
            Some(run.epoch),
            "finish",
            json!({"text":report,"status":status,"atMs":self.now}),
        );
    }
    fn finish_turn(&mut self, id: &str, run: &mut Run, out: &mut Response) {
        self.controls.entry(id.into()).or_default().nudges = 0;
        self.finish_action(id, run, &run.report, out);
        self.next_cycle(id, run, out);
    }
    pub fn state(&self, id: &str) -> Value {
        let c = self.controls.get(id);
        let run = self.runs.get(id);
        let timer = self.timers.get(id);
        let epoch = c.map(|c| c.epoch).unwrap_or(0);
        json!({"epoch":epoch,"runEpoch":run.map(|r|r.epoch),"active":run.is_some(),"draining":run.is_some_and(|r|r.draining),"status":if run.is_some_and(|r|r.draining){json!("draining")}else{self.snapshot(id)["status"].clone()},"nudges":c.map(|c|c.nudges).unwrap_or(0),"claims":c.map(|c|c.claims).unwrap_or(0),"verified":c.is_some_and(|c|c.verified),"timer":timer.map(|t|json!({"timerToken":t.token,"deadlineMs":t.deadline,"reason":t.reason})),"counters":{"nudges":c.map(|c|c.nudges).unwrap_or(0),"claims":c.map(|c|c.claims).unwrap_or(0),"verified":c.is_some_and(|c|c.verified)}})
    }
    pub fn query(&self, operation: &str, payload: Value) -> Result<Value, String> {
        match operation {
            "needsStep" => Ok(json!(needs_step(&payload["tail"]))),
            "overBudget" => Ok(over_budget(
                &payload["session"],
                &payload["settings"],
                num(&payload, "dailyCost", 0.0),
            )),
            "completionPlan" => Ok(completion_plan(
                &payload["session"],
                &payload["settings"],
                payload["decisionAvailable"] == true,
                payload["verified"] == true,
            )),
            "completionVerdict" => Ok(completion_verdict(&payload["raw"], &payload["q"])),
            _ => Err("Unknown runtime query".into()),
        }
    }
    pub fn forget(&mut self, id: &str) -> Result<(), String> {
        if self.runs.contains_key(id) || self.timers.contains_key(id) {
            return Err("Cannot forget a runtime session with a lease or timer".into());
        }
        self.controls.remove(id);
        self.observed.remove(id);
        self.order.retain(|x| x != id);
        Ok(())
    }
}

#[cfg(feature = "node")]
mod binding {
    use super::*;
    use napi_derive::napi;
    fn err(error: impl ToString) -> napi::Error {
        napi::Error::from_reason(error.to_string())
    }
    fn parse(raw: &str) -> napi::Result<Value> {
        crate::json_codec::parse(raw).map_err(err)
    }
    fn encode(value: Value) -> napi::Result<String> {
        crate::json_codec::stringify_js(&value).map_err(err)
    }
    #[napi]
    pub struct RuntimeCore {
        engine: RuntimeEngine,
    }
    #[napi]
    impl RuntimeCore {
        #[napi(constructor)]
        pub fn new() -> Self {
            Self {
                engine: RuntimeEngine::new(),
            }
        }
        #[napi]
        pub fn dispatch(&mut self, event_json: String, facts_json: String) -> napi::Result<String> {
            encode(
                self.engine
                    .dispatch(parse(&event_json)?, parse(&facts_json)?)
                    .map_err(err)?,
            )
        }
        #[napi]
        pub fn state(&self, session_id: String) -> napi::Result<String> {
            encode(self.engine.state(&session_id))
        }
        #[napi]
        pub fn query(&self, operation: String, payload_json: String) -> napi::Result<String> {
            encode(
                self.engine
                    .query(&operation, parse(&payload_json)?)
                    .map_err(err)?,
            )
        }
        #[napi]
        pub fn forget(&mut self, session_id: String) -> napi::Result<()> {
            self.engine.forget(&session_id).map_err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn observation(id: &str, kind: &str) -> Value {
        json!({"session":{"id":id,"kind":kind,"status":"idle","toolset":"lean","stats":{"steps":0,"toolCalls":0,"cost":0},"result":null},"tail":[{"type":"input","text":"task"}],"pending":[],"lastAtMs":0})
    }
    struct Harness {
        engine: RuntimeEngine,
        facts: Value,
    }
    impl Harness {
        fn new(sessions: Vec<Value>) -> Self {
            Self {
                engine: RuntimeEngine::new(),
                facts: json!({"nowMs":1000000,"settings":{"concurrency":1,"verifyCompletion":"off","progressEvery":50,"maxSteps":0,"budget":{},"idleCompactSeconds":20},"dailyCost":0,"hasHooks":false,"decisionAvailable":false,"sessions":sessions}),
            }
        }
        fn observed(&mut self, id: &str) -> &mut Value {
            self.facts["sessions"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|o| o["session"]["id"] == id)
                .unwrap()
        }
        fn send(&mut self, event: Value) -> Value {
            let result = self.engine.dispatch(event, self.facts.clone()).unwrap();
            for a in result["actions"].as_array().unwrap() {
                let id = text(a, "sessionId");
                match a["kind"].as_str().unwrap() {
                    "updateSession" => {
                        let s = &mut self.observed(&id)["session"];
                        for (k, v) in a["patch"].as_object().unwrap() {
                            s[k] = v.clone();
                        }
                    }
                    "finish" => {
                        let s = &mut self.observed(&id)["session"];
                        s["status"] = a["status"].clone();
                        s["result"] = a["text"].clone();
                    }
                    "notice" | "appendNotice" => {
                        self.observed(&id)["tail"]
                            .as_array_mut()
                            .unwrap()
                            .push(json!({"type":"notice","text":"continue"}));
                    }
                    _ => {}
                }
            }
            result
        }
        fn resolve(&mut self, c: &Value, value: Value) -> Value {
            if c["kind"] == "step" && value["turnEnded"] == true {
                self.observed(c["sessionId"].as_str().unwrap())["tail"] =
                    json!([{"type":"assistant","content":value["text"],"toolCalls":[]}]);
            }
            self.send(json!({"type":"resolved","sessionId":c["sessionId"],"runEpoch":c["runEpoch"],"operationId":c["operationId"],"value":value}))
        }
        fn step(&mut self, id: &str) -> Value {
            let r = self.send(json!({"type":"wake","sessionId":id}));
            let r = self.resolve(&cmd(&r), json!({"delivered":1}));
            assert_eq!(cmd(&r)["kind"], "step");
            cmd(&r)
        }
    }
    fn cmd(r: &Value) -> Value {
        r["commands"][0].clone()
    }
    fn actions<'a>(r: &'a Value, kind: &str) -> Vec<&'a Value> {
        r["actions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|a| a["kind"] == kind)
            .collect()
    }
    #[test]
    fn pure_queries_match_tail_budget_and_completion_contracts() {
        assert!(!needs_step(&json!([])));
        assert!(needs_step(&json!([{"type":"assistant","truncated":true}])));
        assert!(!needs_step(
            &json!([{"type":"assistant"},{"type":"input","passive":true}])
        ));
        let mut tail = vec![json!({"type":"input"})];
        tail.extend((0..12).map(|_| json!({"type":"event"})));
        assert!(!needs_step(&json!(tail)));
        assert!(!over_budget(
            &json!({"stats":{"cost":1}}),
            &json!({"budget":{"sessionUsd":1}}),
            0.0
        )
        .is_null());
        assert_eq!(
            completion_plan(
                &json!({"kind":"worker","stats":{"toolCalls":1}}),
                &json!({"verifyCompletion":"auto"}),
                true,
                false
            )["eligible"],
            true
        );
        assert_eq!(
            completion_plan(
                &json!({"kind":"worker","stats":{"toolCalls":2}}),
                &json!({}),
                false,
                false
            )["eligible"],
            false
        );
        assert_eq!(
            completion_verdict(&json!(0.2), &json!({"invert":true,"threshold":0.7})),
            json!({"probability":0.8,"accepted":true})
        );
    }
    #[test]
    fn admission_reserves_once_and_preserves_main_lane() {
        let mut h = Harness::new(vec![
            observation("a", "worker"),
            observation("b", "worker"),
            observation("m", "main"),
        ]);
        let a = h.send(json!({"type":"wake","sessionId":"a"}));
        assert_eq!(actions(&a, "createRun").len(), 1);
        assert!(h.send(json!({"type":"wake","sessionId":"a"}))["commands"]
            .as_array()
            .unwrap()
            .is_empty());
        let b = h.send(json!({"type":"wake","sessionId":"b"}));
        assert_eq!(
            actions(&b, "updateSession")[0]["patch"]["status"],
            "waiting"
        );
        assert!(b["commands"].as_array().unwrap().is_empty());
        let m = h.send(json!({"type":"wake","sessionId":"m"}));
        assert_eq!(actions(&m, "createRun").len(), 1);
        assert_eq!(h.engine.active_workers(), 1);
    }
    #[test]
    fn completion_releases_slot_then_admits_catalog_waiter() {
        let mut h = Harness::new(vec![observation("a", "worker"), observation("b", "worker")]);
        let a = h.step("a");
        h.send(json!({"type":"wake","sessionId":"b"}));
        let r = h.resolve(&a, json!({"turnEnded":true,"text":"done"}));
        assert_eq!(cmd(&r)["kind"], "probeFiles");
        let r = h.resolve(&cmd(&r), json!([]));
        assert_eq!(actions(&r, "finish").len(), 1);
        let r = h.resolve(&cmd(&r), json!({"delivered":0}));
        assert_eq!(actions(&r, "releaseRun").len(), 1);
        assert_eq!(actions(&r, "createRun")[0]["sessionId"], "b");
    }
    #[test]
    fn replacing_timers_rejects_stale_and_early_callbacks() {
        let mut h = Harness::new(vec![observation("a", "worker")]);
        let first = h.send(json!({"type":"later","sessionId":"a","ms":1000}));
        let t1 = actions(&first, "armTimer")[0]["timerToken"].clone();
        let second = h.send(json!({"type":"later","sessionId":"a","ms":2000}));
        let t2 = actions(&second, "armTimer")[0]["timerToken"].clone();
        assert_ne!(t1, t2);
        assert_eq!(actions(&second, "cancelTimer").len(), 1);
        h.facts["nowMs"] = json!(1001000);
        assert!(
            h.send(json!({"type":"timerFired","sessionId":"a","timerToken":t1}))["commands"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let early = h.send(json!({"type":"timerFired","sessionId":"a","timerToken":t2}));
        assert_eq!(actions(&early, "armTimer").len(), 1);
        h.facts["nowMs"] = json!(1002000);
        assert_eq!(
            actions(
                &h.send(json!({"type":"timerFired","sessionId":"a","timerToken":t2})),
                "createRun"
            )
            .len(),
            1
        );
    }
    #[test]
    fn budget_pause_releases_and_only_budget_settings_wake_its_timer() {
        let mut h = Harness::new(vec![observation("a", "worker")]);
        h.observed("a")["session"]["stats"]["cost"] = json!(2);
        h.facts["settings"]["budget"] = json!({"sessionUsd":1});
        let r = h.send(json!({"type":"wake","sessionId":"a"}));
        let r = h.resolve(&cmd(&r), json!({"delivered":1}));
        assert_eq!(actions(&r, "releaseRun").len(), 1);
        assert_eq!(actions(&r, "armTimer")[0]["deadlineMs"], 1600000.0);
        let unchanged = h.send(json!({"type":"settingsChanged","budgetChanged":false}));
        assert!(actions(&unchanged, "cancelTimer").is_empty());
        h.facts["settings"]["budget"]["sessionUsd"] = json!(3);
        let raised = h.send(json!({"type":"settingsChanged","budgetChanged":true}));
        assert_eq!(actions(&raised, "cancelTimer").len(), 1);
        assert_eq!(actions(&raised, "createRun").len(), 1);
    }
    #[test]
    fn stop_resume_drains_old_epoch_before_creating_exactly_one_new_run() {
        let mut h = Harness::new(vec![observation("a", "worker")]);
        let old = h.step("a");
        let stopped = h.send(json!({"type":"stop","sessionId":"a","reason":"user"}));
        assert_eq!(actions(&stopped, "abortRun").len(), 1);
        assert_ne!(h.engine.state("a")["epoch"], old["runEpoch"]);
        h.send(json!({"type":"resume","sessionId":"a","mode":"continue"}));
        assert_eq!(h.engine.state("a")["draining"], true);
        let late = h.resolve(&old, json!({"turnEnded":true,"text":"must not finish"}));
        assert!(actions(&late, "finish").is_empty());
        assert_eq!(actions(&late, "releaseRun").len(), 1);
        assert_eq!(actions(&late, "createRun").len(), 1);
        let new = cmd(&late);
        assert_ne!(new["runEpoch"], old["runEpoch"]);
        let duplicate = h.resolve(&old, json!({"wait":1234}));
        assert!(duplicate["actions"].as_array().unwrap().is_empty());
        assert_eq!(h.engine.state("a")["runEpoch"], new["runEpoch"]);
    }
    #[test]
    fn main_rearm_does_not_restart_the_cancelled_turn() {
        let mut h = Harness::new(vec![observation("m", "main")]);
        let old = h.step("m");
        h.send(json!({"type":"stop","sessionId":"m"}));
        h.send(json!({"type":"resume","sessionId":"m","mode":"rearm"}));
        let r = h.resolve(&old, json!({"turnEnded":true,"text":"stale"}));
        assert!(actions(&r, "reply").is_empty());
        assert!(actions(&r, "createRun").is_empty());
        assert_eq!(h.engine.state("m")["active"], false);
        h.observed("m")["pending"] = json!([{"text":"new user input"}]);
        let r = h.send(json!({"type":"wake","sessionId":"m"}));
        assert_eq!(actions(&r, "createRun").len(), 1);
    }
    #[test]
    fn close_cancels_approvals_before_drain_and_never_admits_again() {
        let mut h = Harness::new(vec![observation("a", "worker"), observation("m", "main")]);
        let a = h.step("a");
        let m = h.step("m");
        let r = h.send(json!({"type":"close"}));
        assert_eq!(r["closed"], true);
        assert_eq!(r["draining"], 2);
        assert_eq!(actions(&r, "cancelAllApprovals").len(), 1);
        assert!(actions(&r, "closeResources").is_empty());
        assert!(h.send(json!({"type":"wake","sessionId":"a"}))["commands"]
            .as_array()
            .unwrap()
            .is_empty());
        let r = h.resolve(&a, json!({"continue":true}));
        assert!(actions(&r, "closeResources").is_empty());
        let r = h.resolve(&m, json!({"turnEnded":true,"text":"late"}));
        assert_eq!(actions(&r, "closeResources").len(), 1);
        assert!(actions(&r, "reply").is_empty());
        assert_eq!(r["complete"], true);
    }
    #[test]
    fn auxiliary_reserves_before_async_work_and_wakes_input_after_drain() {
        let mut h = Harness::new(vec![observation("m", "main")]);
        let r = h.send(json!({"type":"auxiliary","sessionId":"m"}));
        assert_eq!(cmd(&r)["kind"], "idleCompact");
        assert_eq!(actions(&r, "createRun")[0]["leaseKind"], "idleCompaction");
        assert!(
            h.send(json!({"type":"auxiliary","sessionId":"m"}))["commands"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        h.observed("m")["pending"] = json!([{"text":"new"}]);
        h.send(json!({"type":"wake","sessionId":"m"}));
        let r = h.resolve(&cmd(&r), Value::Null);
        assert_eq!(actions(&r, "releaseRun").len(), 1);
        assert_eq!(cmd(&r)["kind"], "deliver");
    }
    #[test]
    fn worker_completion_order_and_counters_are_native() {
        let mut o = observation("a", "worker");
        o["session"]["todo"] = json!([{"text":"unfinished","status":"pending"}]);
        let mut h = Harness::new(vec![o]);
        let mut step = h.step("a");
        for n in 1..=2 {
            let r = h.resolve(&step, json!({"turnEnded":true,"text":"done"}));
            assert_eq!(actions(&r, "notice")[0]["notice"], "unfinished");
            assert_eq!(h.engine.state("a")["nudges"], n);
            let r = h.resolve(&cmd(&r), json!({"delivered":0}));
            step = cmd(&r);
        }
        let r = h.resolve(&step, json!({"turnEnded":true,"text":"done"}));
        assert_eq!(cmd(&r)["kind"], "probeFiles");
        let r = h.resolve(&cmd(&r), json!(["missing.txt"]));
        assert_eq!(actions(&r, "notice")[0]["notice"], "missingFiles");
        assert_eq!(h.engine.state("a")["claims"], 1);
    }
    #[test]
    fn completion_probability_and_once_only_claim_control_finish() {
        let mut o = observation("a", "worker");
        o["session"]["stats"]["toolCalls"] = json!(1);
        let mut h = Harness::new(vec![o]);
        h.facts["settings"]["verifyCompletion"] = json!("auto");
        h.facts["decisionAvailable"] = json!(true);
        let step = h.step("a");
        let r = h.resolve(&step, json!({"turnEnded":true,"text":"done"}));
        let r = h.resolve(&cmd(&r), json!([]));
        assert_eq!(cmd(&r)["kind"], "completionContext");
        assert_eq!(h.engine.state("a")["verified"], true);
        let r=h.resolve(&cmd(&r),json!({"brief":"task","state":"evidence","q":{"id":"q","text":"done?","threshold":0.7,"invert":true}}));
        assert_eq!(cmd(&r)["kind"], "completionDecision");
        let r = h.resolve(&cmd(&r), json!(0.8));
        assert_eq!(actions(&r, "dreamRecord")[0]["data"]["action"], 0);
        assert_eq!(actions(&r, "notice")[0]["notice"], "verify");
        assert!(actions(&r, "finish").is_empty());
    }
    #[test]
    fn deleted_catalog_sessions_cancel_timers_and_never_reappear() {
        let mut h = Harness::new(vec![observation("a", "worker")]);
        let r = h.send(json!({"type":"later","sessionId":"a","ms":1000}));
        let token = actions(&r, "armTimer")[0]["timerToken"].clone();
        h.facts["sessions"] = json!([]);
        h.facts["nowMs"] = json!(1002000);
        let r = h.send(json!({"type":"timerFired","sessionId":"a","timerToken":token}));
        assert_eq!(actions(&r, "cancelTimer").len(), 1);
        assert!(r["commands"].as_array().unwrap().is_empty());
    }
    #[test]
    fn auxiliary_requires_history_and_uses_main_lease_accounting() {
        let mut o = observation("worker", "worker");
        o["tail"] = json!([]);
        let mut h = Harness::new(vec![o]);
        h.facts["settings"]["concurrency"] = json!(0);
        let empty = h.send(json!({"type":"auxiliary","sessionId":"worker","lastAtMs":0}));
        assert!(empty["commands"].as_array().unwrap().is_empty());
        h.observed("worker")["tail"] = json!([{"type":"input","text":"old work"}]);
        let compact = h.send(json!({"type":"auxiliary","sessionId":"worker","lastAtMs":0}));
        assert_eq!(cmd(&compact)["kind"], "idleCompact");
        assert_eq!(actions(&compact, "createRun")[0]["sessionKind"], "main");
        assert_eq!(h.engine.active_workers(), 0);
    }
    #[test]
    fn explicit_sender_wake_can_revive_after_stop_without_replaying_old_epoch() {
        for from in ["user", "parent", "system"] {
            let mut h = Harness::new(vec![observation("a", "worker")]);
            let old = h.step("a");
            h.send(json!({"type":"stop","sessionId":"a","reason":"old turn stopped"}));
            h.observed("a")["pending"] = json!([{"from":from,"text":"new request"}]);
            let wake = h.send(json!({"type":"wake","sessionId":"a","from":from}));
            assert_eq!(
                actions(&wake, "updateSession")[0]["patch"],
                json!({"status":"idle","result":null})
            );
            assert_eq!(actions(&wake, "refreshPrompt").len(), 1);
            assert!(wake["commands"].as_array().unwrap().is_empty());
            let drained = h.resolve(&old, json!({"turnEnded":true,"text":"stale report"}));
            assert!(actions(&drained, "finish").is_empty());
            assert_eq!(actions(&drained, "createRun").len(), 1);
            assert_ne!(cmd(&drained)["runEpoch"], old["runEpoch"]);
        }
        for from in ["child:worker", "voice:microphone", ""] {
            let mut h = Harness::new(vec![observation("a", "worker")]);
            h.send(json!({"type":"stop","sessionId":"a"}));
            let wake = h.send(json!({"type":"wake","sessionId":"a","from":from}));
            assert!(wake["commands"].as_array().unwrap().is_empty());
            assert!(actions(&wake, "updateSession").is_empty());
            assert_eq!(h.engine.state("a")["status"], "stopped");
        }
    }
    #[test]
    fn legacy_truthy_log_fields_and_unknown_completion_mode_keep_their_semantics() {
        assert!(needs_step(&json!([{"type":"assistant","truncated":"yes"}])));
        assert!(needs_step(
            &json!([{"type":"assistant","toolCalls":{"length":"0"}}])
        ));
        assert!(needs_step(&json!([{"type":"assistant","toolCalls":"[]"}])));
        assert!(!needs_step(
            &json!([{"type":"assistant","toolCalls":[]},{"type":"input","passive":"yes"}])
        ));
        let mut o = observation("a", "worker");
        o["session"]["stats"]["toolCalls"] = json!(3);
        assert_eq!(
            completion_plan(&o["session"], &json!({}), false, false)["method"],
            "self"
        );
        for mode in [
            json!("legacy-custom"),
            Value::Null,
            json!(17),
            json!({"legacy":true}),
            json!(["auto"]),
        ] {
            let settings = json!({"verifyCompletion":mode});
            let plan = completion_plan(&o["session"], &settings, false, false);
            assert_eq!(plan["eligible"], true);
            assert_eq!(plan["method"], Value::Null);
            assert_eq!(
                completion_plan(&o["session"], &settings, true, false)["method"],
                "decision"
            );
            let mut h = Harness::new(vec![o.clone()]);
            h.facts["settings"]["verifyCompletion"] = mode;
            let step = h.step("a");
            let r = h.resolve(&step, json!({"turnEnded":true,"text":"done"}));
            let r = h.resolve(&cmd(&r), json!([]));
            assert_eq!(actions(&r, "finish").len(), 1);
            assert_eq!(h.engine.state("a")["verified"], true);
            assert!(actions(&r, "notice").is_empty());
        }
    }
    #[test]
    fn runtime_transport_preserves_literal_markers_and_lone_utf16() {
        let payload =
            crate::json_codec::parse(r#"{"tail":[{"type":"input","text":"\ud800\ue000\ue100"}]}"#)
                .unwrap();
        let e = RuntimeEngine::new();
        assert_eq!(e.query("needsStep", payload).unwrap(), true);
        let payload=crate::json_codec::parse(r#"{"session":{"id":"\ue000\ue100","kind":"worker","stats":{"toolCalls":3}},"settings":{}}"#).unwrap();
        assert_eq!(
            e.query("completionPlan", payload).unwrap()["eligible"],
            true
        );
    }
}
