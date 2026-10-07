//! Synchronous Rust-owned agent-step controller. The host executes correlated
//! commands and returns events. This module never opens a database or replays an
//! outstanding external effect. The N-API binding is an optional compatibility host.
use serde_json::{json, Value};
use std::collections::HashMap;

// Evaluate payloads before taking the mutable run reborrow.
macro_rules! emit {
    ($run:expr,$pending:expr,$kind:expr,$fields:expr) => {{
        let fields = $fields;
        let pending = $pending;
        emit($run, pending, $kind, fields)
    }};
}
macro_rules! commit {
    ($run:expr,$actions:expr,$next:expr) => {{
        let actions = $actions;
        let next = $next;
        commit($run, actions, next)
    }};
}
macro_rules! finish {
    ($id:expr,$run:expr,$outcome:expr) => {{
        let outcome = $outcome;
        finish($id, $run, outcome)
    }};
}

#[derive(Default, Debug)]
struct Memory {
    overflows: u64,
    bad_requests: u64,
    empties: u64,
    force_compact: bool,
}
#[derive(Clone, Debug)]
enum Pending {
    Prompt,
    Budget { overflow: bool },
    Context { planned: bool, overflow: bool },
    Clear,
    Compact { overflow: bool },
    BeforeRequest,
    Invoke,
    Account,
    Catalog,
    Prepare(usize),
    BeforeTool(usize),
    Authorize(usize),
    Execute(usize),
    AfterTool(usize),
    Record,
    AfterTools,
    Commit(Next),
}
#[derive(Clone, Debug)]
enum Next {
    Budget,
    OverflowBudget,
    HandleAnswer,
    Catalog,
    Finish(Value),
}
#[derive(Debug)]
struct Run {
    generation: u64,
    next_operation: u64,
    session: Value,
    budget: Value,
    built: Value,
    answer: Value,
    messages: Value,
    pending: HashMap<String, Pending>,
    calls: Vec<Value>,
    prepared: Vec<Option<Value>>,
    outputs: Vec<Option<Value>>,
    groups: Vec<(usize, usize)>,
    group: usize,
    finished: bool,
    aborted: bool,
    abort_reason: String,
    elapsed_ms: f64,
    tools_only: bool,
}
#[derive(Default, Debug)]
struct Entry {
    generation: u64,
    memory: Memory,
    run: Option<Run>,
}
#[derive(Default, Debug)]
pub struct ExecutionEngine {
    entries: HashMap<String, Entry>,
    next_generation: u64,
}
fn string(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
}
fn number(v: &Value, key: &str, fallback: f64) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(fallback)
}
fn truth(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().unwrap_or(0.0) != 0.0,
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn js_whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn slice(text: &str, max: usize) -> String {
    let units = crate::json_codec::utf16_units(text);
    crate::json_codec::from_utf16_units(&units[..units.len().min(max)])
}
fn one_line(text: &str, max: usize) -> String {
    let value = text
        .split(js_whitespace)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if crate::json_codec::utf16_units(&value).len() <= max {
        value
    } else {
        format!("{}…", slice(&value, max.saturating_sub(1)))
    }
}
fn emit(run: &mut Run, pending: Pending, kind: &str, fields: Value) -> Value {
    run.next_operation += 1;
    let operation = format!("{}:{}", run.generation, run.next_operation);
    run.pending.insert(operation.clone(), pending);
    let mut out = fields.as_object().cloned().unwrap_or_default();
    out.insert("kind".into(), json!(kind));
    out.insert("operationId".into(), json!(operation));
    Value::Object(out)
}
fn reply(id: &str, run: &Run, commands: Vec<Value>, outcome: Option<Value>) -> Value {
    let mut out = json!({"status":if run.finished{"finished"}else{"running"},"sessionId":id,"generation":run.generation,"commands":commands});
    if run.aborted {
        out["aborting"] = json!(true);
    }
    if let Some(value) = outcome {
        out["outcome"] = value;
    }
    out
}
fn finish(id: &str, run: &mut Run, outcome: Value) -> Value {
    run.finished = true;
    run.pending.clear();
    let response = reply(id, run, vec![], Some(outcome));
    // Keep only counters and generation after completion, not whole image/context copies.
    run.session = json!({"id":id});
    run.budget = Value::Null;
    run.built = Value::Null;
    run.answer = Value::Null;
    run.messages = Value::Null;
    run.calls.clear();
    run.prepared.clear();
    run.outputs.clear();
    run.groups.clear();
    response
}
fn stale(id: &str, generation: u64) -> Value {
    json!({"status":"stale","sessionId":id,"generation":generation,"commands":[]})
}
fn commit(run: &mut Run, actions: Vec<Value>, next: Next) -> Value {
    emit!(
        run,
        Pending::Commit(next),
        "commit",
        json!({"actions":actions})
    )
}
fn budget(run: &mut Run, overflow: bool) -> Value {
    // Lean fallback must obtain fresh definitions. Only overflow retains the exact
    // request's original tool definitions, chain and vision selection.
    emit!(
        run,
        Pending::Budget { overflow },
        "budget",
        json!({"session":run.session,"toolDefs":if overflow{run.budget.get("toolDefs")}else{None},"overflow":overflow})
    )
}
fn context(run: &mut Run, planned: bool, overflow: bool, force: bool) -> Value {
    emit!(
        run,
        Pending::Context { planned, overflow },
        "context",
        json!({"session":run.session,"budget":run.budget,"vision":run.budget.get("vision").cloned().unwrap_or(json!(false)),"plan":planned,"force":force})
    )
}
fn before_request(run: &mut Run) -> Value {
    emit!(
        run,
        Pending::BeforeRequest,
        "beforeRequest",
        json!({"session":run.session,"messages":run.built["messages"]})
    )
}
fn compact(run: &mut Run, overflow: bool, overflows: u64) -> Value {
    let mut fields = json!({"session":run.session,"budget":run.budget,"built":run.built,"reason":if overflow{"overflow"}else{"budget"},"overflow":overflow});
    if overflow {
        fields["tailShare"] = json!(if overflows > 1 { 0.1 } else { 0.15 });
    }
    emit!(run, Pending::Compact { overflow }, "compact", fields)
}
fn append(kind: &str, body: Value) -> Value {
    json!({"kind":"append","type":kind,"body":body})
}
fn notice(name: &str, args: Value) -> Value {
    json!({"kind":"notice","notice":name,"args":args})
}
fn event(name: &str, data: Value) -> Value {
    json!({"kind":"event","event":name,"data":data})
}

impl ExecutionEngine {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn begin(&mut self, session: Value, _facts: Value) -> Result<Value, String> {
        let id = string(&session, "id");
        if id.is_empty() {
            return Err("session.id is required".into());
        }
        let entry = self.entries.entry(id.clone()).or_default();
        if entry.run.as_ref().is_some_and(|r| !r.finished) {
            return Err("An execution step is already active".into());
        }
        self.next_generation += 1;
        entry.generation = self.next_generation;
        let mut run = Run {
            generation: entry.generation,
            next_operation: 0,
            session,
            budget: Value::Null,
            built: Value::Null,
            answer: Value::Null,
            messages: Value::Null,
            pending: HashMap::new(),
            calls: vec![],
            prepared: vec![],
            outputs: vec![],
            groups: vec![],
            group: 0,
            finished: false,
            aborted: false,
            abort_reason: "The session was stopped".into(),
            elapsed_ms: 0.0,
            tools_only: false,
        };
        let command = emit!(
            &mut run,
            Pending::Prompt,
            "prompt",
            json!({"session":run.session,"refresh":false})
        );
        let out = reply(&id, &run, vec![command], None);
        entry.run = Some(run);
        Ok(out)
    }
    pub fn begin_tools(
        &mut self,
        session: Value,
        calls: Value,
        facts: Value,
    ) -> Result<Value, String> {
        if !calls.is_array() {
            return Err("calls must be an array".into());
        }
        let id = string(&session, "id");
        let _ = self.begin(session, facts.clone())?;
        let run = self.entries.get_mut(&id).unwrap().run.as_mut().unwrap();
        run.pending.clear();
        run.tools_only = true;
        run.calls = calls.as_array().unwrap().clone();
        run.budget = json!({"B":facts.get("B").cloned().unwrap_or(json!(0))});
        if run.calls.is_empty() {
            return Ok(finish!(&id, run, json!({"toolsCompleted":true})));
        }
        let command = emit!(
            run,
            Pending::Catalog,
            "toolCatalog",
            json!({"calls":run.calls})
        );
        Ok(reply(&id, run, vec![command], None))
    }
    pub fn advance(&mut self, event_: Value, facts: Value) -> Result<Value, String> {
        let id = string(&event_, "sessionId");
        let generation = event_["generation"]
            .as_u64()
            .ok_or("event.generation is required")?;
        let operation = string(&event_, "operationId");
        let Some(entry) = self.entries.get_mut(&id) else {
            return Ok(stale(&id, generation));
        };
        let Some(run) = entry.run.as_mut() else {
            return Ok(stale(&id, generation));
        };
        if run.finished || generation != run.generation {
            return Ok(stale(&id, generation));
        }
        let Some(pending) = run.pending.remove(&operation) else {
            return Ok(stale(&id, generation));
        };
        let rejected = string(&event_, "type") == "rejected";
        if !rejected && string(&event_, "type") != "resolved" {
            run.pending.insert(operation, pending);
            return Err("event.type must be resolved or rejected".into());
        }
        let mut value = event_.get("value").cloned().unwrap_or(Value::Null);
        if let Some(ms) = facts.get("toolMs").or_else(|| facts.get("elapsedMs")) {
            if matches!(
                pending,
                Pending::Prepare(_)
                    | Pending::BeforeTool(_)
                    | Pending::Authorize(_)
                    | Pending::Execute(_)
                    | Pending::AfterTool(_)
            ) {
                if !value.is_object() {
                    value = json!({});
                }
                value["ms"] = ms.clone();
            }
        }
        let error = event_
            .get("error")
            .cloned()
            .unwrap_or(json!({"message":"Host effect failed"}));
        if event_["aborted"] == true {
            run.aborted = true;
            run.abort_reason = string(&error, "message");
        }
        transition(
            &id,
            &mut entry.memory,
            run,
            pending,
            value,
            if rejected { Some(error) } else { None },
            facts,
        )
    }
    /// Stop invalidates non-tool effects immediately. Active tool groups drain and
    /// record their actual outcomes before reporting abort. The host aborts I/O too.
    pub fn stop(&mut self, event_: Value) -> Result<Value, String> {
        let id = string(&event_, "sessionId");
        let generation = event_["generation"]
            .as_u64()
            .ok_or("stop.generation is required")?;
        let Some(entry) = self.entries.get_mut(&id) else {
            return Ok(stale(&id, generation));
        };
        let Some(run) = entry.run.as_mut() else {
            return Ok(stale(&id, generation));
        };
        if run.finished || run.generation != generation {
            return Ok(stale(&id, generation));
        }
        run.aborted = true;
        if let Some(reason) = event_["reason"].as_str() {
            run.abort_reason = reason.into();
        }
        if !run.calls.is_empty() && !run.groups.is_empty() {
            return Ok(reply(&id, run, vec![], None));
        }
        Ok(finish!(
            &id,
            run,
            json!({"aborted":true,"reason":run.abort_reason})
        ))
    }
    pub fn state(&self, id: &str) -> Value {
        self.entries.get(id).map(|entry|json!({"generation":entry.generation,"overflows":entry.memory.overflows,"badRequests":entry.memory.bad_requests,"empties":entry.memory.empties,"forceCompact":entry.memory.force_compact,"active":entry.run.as_ref().is_some_and(|r|!r.finished)})).unwrap_or(Value::Null)
    }
    pub fn forget(&mut self, id: &str) -> Result<(), String> {
        if self
            .entries
            .get(id)
            .and_then(|e| e.run.as_ref())
            .is_some_and(|r| !r.finished)
        {
            return Err("Cannot forget an active execution step".into());
        }
        self.entries.remove(id);
        Ok(())
    }
}

fn transition(
    id: &str,
    mem: &mut Memory,
    run: &mut Run,
    pending: Pending,
    value: Value,
    error: Option<Value>,
    facts: Value,
) -> Result<Value, String> {
    if let Pending::Prepare(index)
    | Pending::BeforeTool(index)
    | Pending::Authorize(index)
    | Pending::Execute(index)
    | Pending::AfterTool(index) = pending
    {
        return tool_transition(id, run, pending, index, value, error);
    }
    if run.aborted && !matches!(pending, Pending::Record) {
        return Ok(finish!(
            id,
            run,
            json!({"aborted":true,"reason":run.abort_reason})
        ));
    }
    if let Some(error) = error {
        if matches!(pending, Pending::Invoke) {
            return model_failure(id, mem, run, error);
        }
        return Ok(finish!(id, run, json!({"error":error})));
    }
    let command = match pending {
        Pending::Prompt => {
            run.session = value;
            budget(run, false)
        }
        Pending::Budget { overflow } => {
            if overflow {
                run.budget["B"] = value["B"].clone();
                run.budget["ratio"] = value["ratio"].clone();
            } else {
                run.budget = value;
            }
            if overflow {
                context(run, false, true, false)
            } else if !run.budget["chain"]
                .as_array()
                .is_some_and(|c| !c.is_empty())
            {
                return Ok(finish!(
                    id,
                    run,
                    json!({"wait":60000,"note":"会話・作業に使うモデルを「AIとの接続」で登録してください。"})
                ));
            } else if number(&run.budget, "B", 0.0) < 1200.0 {
                if run.session["toolset"] == "worker" {
                    run.session["toolset"] = json!("lean");
                    commit!(
                        run,
                        vec![json!({"kind":"lean","context":run.budget["limits"]["context"]})],
                        Next::Budget
                    )
                } else {
                    let note=format!("モデルの文脈の窓（{}トークン）が小さすぎて作業できません。サーバーの文脈長（llama.cppの-c、Ollamaのnum_ctxなど）を増やしてください。",run.budget["limits"]["context"]);
                    return Ok(finish!(id, run, json!({"wait":300000,"note":note})));
                }
            } else {
                let force = mem.force_compact;
                mem.force_compact = false;
                context(run, true, false, force)
            }
        }
        Pending::Context { planned, overflow } => {
            run.built = value["built"].clone();
            if overflow {
                compact(run, true, mem.overflows)
            } else if planned && value["plan"]["action"] == "clear" {
                emit!(
                    run,
                    Pending::Clear,
                    "clear",
                    json!({"session":run.session,"upTo":value["plan"]["upTo"]})
                )
            } else if planned && value["plan"]["action"] == "compact" {
                compact(run, false, mem.overflows)
            } else {
                before_request(run)
            }
        }
        Pending::Clear => context(run, false, false, false),
        Pending::Compact { overflow } => {
            if let Some(session) = value.get("session") {
                run.session = session.clone();
            }
            if let Some(defs) = value.get("toolDefs") {
                run.budget["toolDefs"] = defs.clone();
            }
            if overflow {
                return Ok(finish!(
                    id,
                    run,
                    if mem.overflows > 3 {
                        json!({"wait":60000,"note":"文脈の溢れが続いています。"})
                    } else {
                        json!({"continue":true})
                    }
                ));
            }
            context(run, false, false, false)
        }
        Pending::BeforeRequest => {
            run.messages = value
                .get("messages")
                .filter(|v| truth(v))
                .cloned()
                .unwrap_or_else(|| run.built["messages"].clone());
            emit!(
                run,
                Pending::Invoke,
                "invoke",
                json!({"session":run.session,"chain":run.budget["chain"],"messages":run.messages,"toolDefs":run.budget["toolDefs"],"cacheKey":id,"slotKey":id,"priority":if run.session["kind"]=="main"{10}else{0}})
            )
        }
        Pending::Invoke => {
            mem.overflows = 0;
            mem.bad_requests = 0;
            run.answer = value;
            run.elapsed_ms = number(&facts, "elapsedMs", 0.0);
            if run.answer["usage"]["uncachedOnly"] == true {
                let whole = ((number(&run.built, "tokens", 0.0)
                    + number(&run.budget, "toolsTokens", 0.0))
                    * number(&run.budget, "ratio", 1.0))
                .round();
                let fresh = number(&run.answer["usage"], "input", 0.0);
                run.answer["usage"]["input"] = json!(whole.max(fresh));
                run.answer["usage"]["cacheRead"] = json!((whole - fresh).max(0.0));
                run.answer["usage"]["estimated"] = json!(true);
            }
            emit!(
                run,
                Pending::Account,
                "account",
                json!({"session":run.session,"answer":run.answer,"elapsedMs":run.elapsed_ms})
            )
        }
        Pending::Account => {
            let sent = number(&run.built, "tokens", 0.0) + number(&run.budget, "toolsTokens", 0.0);
            let estimated = sent * number(&run.budget, "ratio", 1.0);
            let uncached = run.answer["usage"]["uncachedOnly"] == true;
            let reported = if uncached {
                0.0
            } else {
                number(&run.answer["usage"], "input", 0.0)
            };
            let anomaly =
                reported > 0.0 && !uncached && estimated > 4000.0 && reported < estimated * 0.5;
            let source = string(&run.budget["limits"], "source");
            if anomaly
                && (source == "default" || source == "guess")
                && run.answer["route"]["identity"] == run.budget["profile"]["identity"]
            {
                mem.force_compact = true;
                commit!(
                    run,
                    vec![
                        json!({"kind":"streamEnd","discard":true}),
                        json!({"kind":"learnLimit","profile":run.budget["profile"],"limit":(reported*1.02).round().max(2048.0)}),
                        event(
                            "input-truncated",
                            json!({"reported":reported,"estimated":estimated.round(),"assumedContext":run.budget["limits"]["context"]})
                        )
                    ],
                    Next::Finish(json!({"continue":true}))
                )
            } else {
                let mut actions = vec![];
                if !anomaly && !uncached {
                    actions.push(json!({"kind":"calibrate","identity":run.answer["route"]["identity"],"sentRaw":sent,"reported":reported}));
                }
                actions.push(json!({"kind":"streamEnd","discard":false}));
                commit!(run, actions, Next::HandleAnswer)
            }
        }
        Pending::Commit(next) => {
            if let Some(session) = value.get("session") {
                run.session = session.clone();
            }
            match next {
                Next::Budget => budget(run, false),
                Next::OverflowBudget => budget(run, true),
                Next::HandleAnswer => return handle_answer(id, mem, run),
                Next::Catalog => emit!(
                    run,
                    Pending::Catalog,
                    "toolCatalog",
                    json!({"calls":run.calls})
                ),
                Next::Finish(outcome) => return Ok(finish!(id, run, outcome)),
            }
        }
        Pending::Catalog => {
            if let Some(session) = value.get("session") {
                run.session = session.clone();
            }
            let tools = value.get("tools").unwrap_or(&value);
            let mut last_ro = false;
            for (i, call) in run.calls.iter().enumerate() {
                let ro = tools
                    .get(string(call, "name"))
                    .is_some_and(|d| d["readOnly"] == true);
                if ro && last_ro {
                    run.groups.last_mut().unwrap().1 = i + 1;
                } else {
                    run.groups.push((i, i + 1));
                }
                last_ro = ro;
            }
            run.prepared = vec![None; run.calls.len()];
            run.outputs = vec![None; run.calls.len()];
            return start_group(id, run);
        }
        Pending::Record => {
            if run.aborted {
                return Ok(finish!(
                    id,
                    run,
                    json!({"aborted":true,"reason":run.abort_reason})
                ));
            }
            run.group += 1;
            if run.group < run.groups.len() {
                return start_group(id, run);
            }
            if run.tools_only {
                return Ok(finish!(id, run, json!({"toolsCompleted":true})));
            }
            emit!(
                run,
                Pending::AfterTools,
                "afterTools",
                json!({"session":run.session,"built":run.built,"budget":run.budget})
            )
        }
        Pending::AfterTools => return Ok(finish!(id, run, json!({"continue":true}))),
        _ => unreachable!(),
    };
    Ok(reply(id, run, vec![command], None))
}

fn handle_answer(id: &str, mem: &mut Memory, run: &mut Run) -> Result<Value, String> {
    let answer = &run.answer;
    let content = answer
        .get("content")
        .filter(|v| truth(v))
        .cloned()
        .unwrap_or(json!(""));
    let raw_calls = answer["tool_calls"].as_array().cloned().unwrap_or_default();
    let mut body = json!({"content":content,"toolCalls":[]});
    for key in ["usage", "route"] {
        if let Some(value) = answer.get(key) {
            body[key] = value.clone();
        }
    }
    let finish_reason = string(answer, "finish");
    let (actions, next) = if finish_reason == "length" {
        body["reasoning"] = answer
            .get("reasoning")
            .filter(|v| truth(v))
            .cloned()
            .unwrap_or(Value::Null);
        body["truncated"] = json!(true);
        if !raw_calls.is_empty() {
            body["droppedCalls"] = json!(raw_calls
                .iter()
                .map(|c| c["function"]["name"].clone())
                .collect::<Vec<_>>());
        }
        let key = if raw_calls.is_empty() {
            "truncatedText"
        } else {
            "truncatedCall"
        };
        (
            vec![
                append("assistant", body),
                notice(key, json!([answer["route"]["maxTokens"]])),
            ],
            Next::Finish(json!({"continue":true})),
        )
    } else if finish_reason == "refusal" && raw_calls.is_empty() {
        body["refused"] = json!(true);
        let again = mem.empties < 1;
        mem.empties += 1;
        let mut actions = vec![append("assistant", body)];
        if again {
            actions.push(notice("refusal", json!([])));
        }
        (
            actions,
            Next::Finish(if again {
                json!({"continue":true})
            } else {
                json!({"turnEnded":true,"text":if truth(&content){content.clone()}else{json!("（応答が提供元に止められました）")}})
            }),
        )
    } else {
        run.calls=raw_calls.iter().map(|c|json!({"id":c["id"],"name":c["function"]["name"],"arguments":c["function"].get("arguments").filter(|v|truth(v)).cloned().unwrap_or(json!("{}"))})).collect();
        body["toolCalls"] = json!(run.calls);
        body["reasoning"] = answer
            .get("reasoning")
            .filter(|v| truth(v))
            .cloned()
            .unwrap_or(Value::Null);
        body["native"] = answer
            .get("_native")
            .filter(|v| truth(v))
            .cloned()
            .unwrap_or(Value::Null);
        if let Some(value) = answer.get("finish") {
            body["finish"] = value.clone();
        }
        let mut actions = vec![append("assistant", body)];
        let next = if run.calls.is_empty() {
            if content
                .as_str()
                .unwrap_or("")
                .trim_matches(js_whitespace)
                .is_empty()
            {
                let again = mem.empties < 2;
                mem.empties += 1;
                if again {
                    actions.push(notice("empty", json!([])));
                }
                Next::Finish(if again {
                    json!({"continue":true})
                } else {
                    json!({"turnEnded":true,"text":""})
                })
            } else {
                mem.empties = 0;
                Next::Finish(json!({"turnEnded":true,"text":content}))
            }
        } else {
            mem.empties = 0;
            Next::Catalog
        };
        (actions, next)
    };
    let command = commit!(run, actions, next);
    Ok(reply(id, run, vec![command], None))
}
fn has_images(messages: &Value) -> bool {
    messages.as_array().is_some_and(|messages| {
        messages.iter().any(|m| {
            m["content"]
                .as_array()
                .is_some_and(|parts| parts.iter().any(|p| p["type"] == "image_url"))
        })
    })
}
fn model_failure(id: &str, mem: &mut Memory, run: &mut Run, error: Value) -> Result<Value, String> {
    let kind = string(&error, "kind");
    let message = string(&error, "message");
    let mut actions = vec![json!({"kind":"streamEnd","discard":true})];
    let next = if kind == "overflow" {
        mem.overflows += 1;
        actions.push(event(
            "overflow",
            json!({"limit":error["limit"],"message":one_line(&message,200)}),
        ));
        Next::OverflowBudget
    } else if kind == "auth" {
        Next::Finish(json!({"wait":300000,"note":message}))
    } else if kind == "bad-request"
        && run.budget["vision"] == true
        && has_images(&run.built["messages"])
        && {
            let text = format!("{} {}", message, string(&error, "body")).to_lowercase();
            ["image", "vision", "multimodal", "modalit"]
                .iter()
                .any(|word| text.contains(word))
        }
    {
        actions.push(json!({"kind":"learnNoVision","profile":run.budget["profile"]}));
        actions.push(event(
            "no-vision",
            json!({"model":run.budget["profile"]["model"]}),
        ));
        Next::Finish(json!({"continue":true}))
    } else if kind == "bad-request" {
        mem.bad_requests += 1;
        actions.push(event(
            "bad-request",
            json!({"message":one_line(&message,300)}),
        ));
        Next::Finish(
            json!({"wait":(15000_u64*2_u64.pow(mem.bad_requests.min(5)as u32)).min(600000),"note":format!("モデルが依頼を受け付けませんでした: {}",one_line(&message,160))}),
        )
    } else {
        Next::Finish(
            json!({"wait":if number(&error,"retryAfterMs",0.0)!=0.0{number(&error,"retryAfterMs",30000.0)}else{30000.0},"note":if message.is_empty(){"モデルに接続できません。".to_owned()}else{message}}),
        )
    };
    let command = commit!(run, actions, next);
    Ok(reply(id, run, vec![command], None))
}
fn start_group(id: &str, run: &mut Run) -> Result<Value, String> {
    let (start, end) = run.groups[run.group];
    let mut commands = vec![];
    for index in start..end {
        commands.push(emit!(
            run,
            Pending::Prepare(index),
            "prepareTool",
            json!({"session":run.session,"call":run.calls[index],"index":index})
        ));
    }
    Ok(reply(id, run, commands, None))
}
fn timing(prepared: &mut Value, value: &Value) {
    if let Some(ms) = value.get("ms").filter(|v| v.is_number()) {
        prepared["ms"] = ms.clone();
    }
}
fn output(prepared: &Value) -> Value {
    let mut out = json!({});
    for key in ["name", "args", "definitionKey", "ms"] {
        if let Some(value) = prepared.get(key) {
            out[key] = value.clone();
        }
    }
    if out.get("ms").is_none() {
        out["ms"] = json!(0);
    }
    out
}
fn settle(id: &str, run: &mut Run, index: usize, mut out: Value) -> Result<Value, String> {
    if run.aborted {
        out["interrupted"] = json!(true);
    }
    run.outputs[index] = Some(out);
    let (start, end) = run.groups[run.group];
    if !(start..end).all(|i| run.outputs[i].is_some()) {
        return Ok(reply(id, run, vec![], None));
    }
    let record_end = if run.aborted {
        for i in end..run.calls.len() {
            run.outputs[i] = Some(
                json!({"error":format!("{}; this call was not executed",run.abort_reason),"ms":0,"name":run.calls[i]["name"],"interrupted":true,"notExecuted":true}),
            );
        }
        run.calls.len()
    } else {
        end
    };
    let outputs = (start..record_end)
        .map(|i| {
            let mut out = run.outputs[i].clone().unwrap();
            if run.aborted {
                out["interrupted"] = json!(true);
            }
            out
        })
        .collect::<Vec<_>>();
    let command = emit!(
        run,
        Pending::Record,
        "recordTools",
        json!({"session":run.session,"calls":run.calls[start..record_end],"outputs":outputs,"B":run.budget["B"]})
    );
    Ok(reply(id, run, vec![command], None))
}
fn tool_transition(
    id: &str,
    run: &mut Run,
    pending: Pending,
    index: usize,
    value: Value,
    error: Option<Value>,
) -> Result<Value, String> {
    if matches!(pending, Pending::Prepare(_)) {
        let mut prepared = if error.is_none() && value.is_object() {
            value.clone()
        } else {
            json!({})
        };
        // Parser/schema errors do not invent arguments or a resolved identity.
        if error.is_none() && !truth(&value["error"]) {
            if prepared.get("name").is_none() {
                prepared["name"] = run.calls[index]["name"].clone();
            }
            if prepared.get("args").is_none() {
                prepared["args"] = json!({});
            }
        }
        if prepared.get("ms").is_none() {
            prepared["ms"] = json!(0);
        }
        run.prepared[index] = Some(prepared);
    }
    let prepared = run.prepared[index]
        .as_mut()
        .ok_or("Tool preparation state is missing")?;
    timing(prepared, &value);
    if let Some(error) = error {
        let mut out = output(prepared);
        out["error"] = json!(slice(&string(&error, "message"), 2000));
        if error["notExecuted"] == true
            || !matches!(pending, Pending::Execute(_) | Pending::AfterTool(_))
        {
            out["notExecuted"] = json!(true);
        }
        return settle(id, run, index, out);
    }
    if run.aborted
        && matches!(
            pending,
            Pending::Prepare(_) | Pending::BeforeTool(_) | Pending::Authorize(_)
        )
    {
        let mut out = output(prepared);
        out["error"] = json!(format!("{}; this call was not executed", run.abort_reason));
        out["notExecuted"] = json!(true);
        return settle(id, run, index, out);
    }
    let command = match pending {
        Pending::Prepare(_) => {
            if truth(&value["error"]) {
                let mut out = output(prepared);
                out["error"] = value["error"].clone();
                return settle(id, run, index, out);
            }
            emit!(
                run,
                Pending::BeforeTool(index),
                "beforeTool",
                json!({"session":run.session,"prepared":run.prepared[index],"index":index})
            )
        }
        Pending::BeforeTool(_) => {
            if truth(&value["block"]) {
                let mut out = output(prepared);
                out["error"] = json!(format!(
                    "A plugin refused this call: {}",
                    one_line(&crate::js_value::js_string(value.get("block")), 300)
                ));
                return settle(id, run, index, out);
            }
            if value["args"].is_object() || value["args"].is_array() {
                prepared["args"] = value["args"].clone();
            }
            emit!(
                run,
                Pending::Authorize(index),
                "authorizeTool",
                json!({"session":run.session,"prepared":run.prepared[index],"index":index})
            )
        }
        Pending::Authorize(_) => {
            let decision = string(&value, "decision");
            if decision != "allow" {
                let mut out = output(prepared);
                out["error"] = json!(if decision == "deny" {
                    format!(
                        "The user's rules do not allow {} here.",
                        string(prepared, "name")
                    )
                } else {
                    format!("The user declined this {} call.", string(prepared, "name"))
                });
                return settle(id, run, index, out);
            }
            // This exact final prepared identity/argument handle was approved. The host
            // must not execute an earlier captured argument object, especially for MCP.
            emit!(
                run,
                Pending::Execute(index),
                "executeTool",
                json!({"session":run.session,"prepared":run.prepared[index],"index":index})
            )
        }
        Pending::Execute(_) => {
            prepared["rawResult"] = value.get("result").cloned().unwrap_or(Value::Null);
            emit!(
                run,
                Pending::AfterTool(index),
                "afterTool",
                json!({"session":run.session,"prepared":run.prepared[index],"result":value.get("result"),"index":index})
            )
        }
        Pending::AfterTool(_) => {
            let mut out = output(prepared);
            out["result"] = value
                .get("result")
                .cloned()
                .unwrap_or_else(|| prepared["rawResult"].clone());
            if truth(&prepared["repaired"]) {
                out["repaired"] = prepared["repaired"].clone();
            }
            return settle(id, run, index, out);
        }
        _ => unreachable!(),
    };
    Ok(reply(id, run, vec![command], None))
}

#[cfg(feature = "node")]
mod binding {
    use super::*;
    use napi_derive::napi;
    fn err(error: impl ToString) -> napi::Error {
        napi::Error::from_reason(error.to_string())
    }
    fn parse(value: &str) -> napi::Result<Value> {
        crate::json_codec::parse(value).map_err(err)
    }
    fn encode(value: Value) -> napi::Result<String> {
        crate::json_codec::stringify(&value).map_err(err)
    }
    #[napi]
    pub struct ExecutionCore {
        engine: ExecutionEngine,
    }
    #[napi]
    impl ExecutionCore {
        #[napi(constructor)]
        pub fn new() -> Self {
            Self {
                engine: ExecutionEngine::new(),
            }
        }
        #[napi]
        pub fn begin(&mut self, session_json: String, facts_json: String) -> napi::Result<String> {
            encode(
                self.engine
                    .begin(parse(&session_json)?, parse(&facts_json)?)
                    .map_err(err)?,
            )
        }
        #[napi]
        pub fn begin_tools(
            &mut self,
            session_json: String,
            calls_json: String,
            facts_json: String,
        ) -> napi::Result<String> {
            encode(
                self.engine
                    .begin_tools(
                        parse(&session_json)?,
                        parse(&calls_json)?,
                        parse(&facts_json)?,
                    )
                    .map_err(err)?,
            )
        }
        #[napi]
        pub fn advance(&mut self, event_json: String, facts_json: String) -> napi::Result<String> {
            encode(
                self.engine
                    .advance(parse(&event_json)?, parse(&facts_json)?)
                    .map_err(err)?,
            )
        }
        #[napi]
        pub fn stop(&mut self, event_json: String) -> napi::Result<String> {
            encode(self.engine.stop(parse(&event_json)?).map_err(err)?)
        }
        #[napi]
        pub fn state(&self, session_id: String) -> napi::Result<String> {
            encode(self.engine.state(&session_id))
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
    fn session(id: &str) -> Value {
        json!({"id":id,"kind":"worker","toolset":"worker","system":"fixed","tools":["read","write"]})
    }
    fn limits() -> Value {
        json!({"chain":[{"identity":"p","model":"m"}],"profile":{"identity":"p","model":"m"},"limits":{"context":16000,"source":"config"},"ratio":1,"B":10000,"toolDefs":[],"toolsTokens":0,"vision":false})
    }
    fn built() -> Value {
        json!({"messages":[{"role":"system","content":"fixed"}],"tokens":100})
    }
    fn command(reply: &Value) -> Value {
        reply["commands"][0].clone()
    }
    fn resolve(e: &mut ExecutionEngine, id: &str, g: u64, c: &Value, value: Value) -> Value {
        e.advance(json!({"sessionId":id,"generation":g,"operationId":c["operationId"],"type":"resolved","value":value}),json!({})).unwrap()
    }
    fn reject(e: &mut ExecutionEngine, id: &str, g: u64, c: &Value, error: Value) -> Value {
        e.advance(json!({"sessionId":id,"generation":g,"operationId":c["operationId"],"type":"rejected","error":error}),json!({})).unwrap()
    }
    fn invoke(e: &mut ExecutionEngine, id: &str, budget_: Value, built_: Value) -> (u64, Value) {
        let r = e.begin(session(id), json!({})).unwrap();
        let g = r["generation"].as_u64().unwrap();
        let r = resolve(e, id, g, &command(&r), session(id));
        let r = resolve(e, id, g, &command(&r), budget_);
        assert_eq!(command(&r)["kind"], "context");
        let r = resolve(
            e,
            id,
            g,
            &command(&r),
            json!({"built":built_,"plan":{"action":"none"}}),
        );
        let r = resolve(e, id, g, &command(&r), json!({}));
        assert_eq!(command(&r)["kind"], "invoke");
        (g, command(&r))
    }
    fn accept(e: &mut ExecutionEngine, id: &str, g: u64, c: &Value, answer: Value) -> Value {
        let r = resolve(e, id, g, c, answer);
        assert_eq!(command(&r)["kind"], "account");
        let r = resolve(e, id, g, &command(&r), Value::Null);
        assert_eq!(command(&r)["kind"], "commit");
        resolve(e, id, g, &command(&r), Value::Null)
    }
    fn tool_to_execute(e: &mut ExecutionEngine, g: u64, c: &Value, changed: Value) -> Value {
        let r = resolve(
            e,
            "s",
            g,
            c,
            json!({"name":"mcp:server/read","args":{"path":"old"},"definitionKey":"d","ms":1}),
        );
        let r = resolve(e, "s", g, &command(&r), json!({"args":changed,"ms":2}));
        assert_eq!(command(&r)["kind"], "authorizeTool");
        let approved = command(&r)["prepared"]["args"].clone();
        let r = resolve(e, "s", g, &command(&r), json!({"decision":"allow","ms":3}));
        assert_eq!(command(&r)["kind"], "executeTool");
        assert_eq!(command(&r)["prepared"]["args"], approved);
        command(&r)
    }
    fn complete_tool(e: &mut ExecutionEngine, g: u64, c: &Value, result: Value) -> Value {
        let r = resolve(e, "s", g, c, json!({"result":result,"ms":4}));
        assert_eq!(command(&r)["kind"], "afterTool");
        resolve(
            e,
            "s",
            g,
            &command(&r),
            json!({"result":{"text":"redacted"},"ms":5}),
        )
    }
    #[test]
    fn generations_reject_stale_duplicate_events_and_busy_begin() {
        let mut e = ExecutionEngine::new();
        let r = e.begin(session("s"), json!({})).unwrap();
        let c = command(&r);
        assert!(e.begin(session("s"), json!({})).is_err());
        assert_eq!(
            e.stop(json!({"sessionId":"s","generation":1,"reason":"stop"}))
                .unwrap()["outcome"]["aborted"],
            true
        );
        assert_eq!(resolve(&mut e, "s", 1, &c, json!({}))["status"], "stale");
        let r = e.begin(session("s"), json!({})).unwrap();
        assert_eq!(r["generation"], 2);
        assert_eq!(resolve(&mut e, "s", 1, &c, json!({}))["status"], "stale");
        let c = command(&r);
        resolve(&mut e, "s", 2, &c, session("s"));
        assert_eq!(resolve(&mut e, "s", 2, &c, session("s"))["status"], "stale");
    }
    #[test]
    fn truncated_calls_are_dropped_before_any_execution() {
        let mut e = ExecutionEngine::new();
        let (g, c) = invoke(&mut e, "s", limits(), built());
        let r = accept(
            &mut e,
            "s",
            g,
            &c,
            json!({"content":"partial","finish":"length","tool_calls":[{"id":"x","function":{"name":"write","arguments":"{"}}]}),
        );
        let a = &command(&r)["actions"];
        assert_eq!(a[0]["body"]["toolCalls"], json!([]));
        assert_eq!(a[0]["body"]["droppedCalls"], json!(["write"]));
        assert_eq!(a[1]["notice"], "truncatedCall");
        assert_eq!(
            resolve(&mut e, "s", g, &command(&r), Value::Null)["outcome"],
            json!({"continue":true})
        );
    }
    #[test]
    fn empty_counter_survives_steps_and_refusal_uses_same_counter() {
        let mut e = ExecutionEngine::new();
        for n in 0..3 {
            let (g, c) = invoke(&mut e, "s", limits(), built());
            let r = accept(&mut e, "s", g, &c, json!({"content":"","finish":"stop"}));
            let r = resolve(&mut e, "s", g, &command(&r), Value::Null);
            assert_eq!(
                r["outcome"],
                if n < 2 {
                    json!({"continue":true})
                } else {
                    json!({"turnEnded":true,"text":""})
                }
            );
        }
        let (g, c) = invoke(&mut e, "s", limits(), built());
        let r = accept(
            &mut e,
            "s",
            g,
            &c,
            json!({"content":"no","finish":"refusal"}),
        );
        assert_eq!(command(&r)["actions"].as_array().unwrap().len(), 1);
        let r = resolve(&mut e, "s", g, &command(&r), Value::Null);
        assert_eq!(r["outcome"]["turnEnded"], true);
        e.forget("s").unwrap();
        assert_eq!(e.state("s"), Value::Null);
    }
    #[test]
    fn overflow_rebudgets_compacts_and_waits_after_fourth_failure() {
        let mut e = ExecutionEngine::new();
        for n in 1..=4 {
            let (g, c) = invoke(&mut e, "s", limits(), built());
            let r = reject(
                &mut e,
                "s",
                g,
                &c,
                json!({"kind":"overflow","message":"too much","limit":4096}),
            );
            let r = resolve(&mut e, "s", g, &command(&r), Value::Null);
            assert_eq!(command(&r)["kind"], "budget");
            assert_eq!(command(&r)["overflow"], true);
            let r = resolve(&mut e, "s", g, &command(&r), limits());
            let r = resolve(&mut e, "s", g, &command(&r), json!({"built":built()}));
            assert_eq!(command(&r)["kind"], "compact");
            assert_eq!(command(&r)["overflow"], true);
            assert_eq!(
                command(&r)["tailShare"],
                json!(if n == 1 { 0.15 } else { 0.1 })
            );
            let r = resolve(&mut e, "s", g, &command(&r), json!({}));
            assert_eq!(
                r["outcome"],
                if n > 3 {
                    json!({"wait":60000,"note":"文脈の溢れが続いています。"})
                } else {
                    json!({"continue":true})
                }
            );
        }
    }
    #[test]
    fn bad_request_backoff_and_vision_learning_are_separate() {
        let mut e = ExecutionEngine::new();
        for wait in [30000, 60000] {
            let (g, c) = invoke(&mut e, "s", limits(), built());
            let r = reject(
                &mut e,
                "s",
                g,
                &c,
                json!({"kind":"bad-request","message":"bad"}),
            );
            assert_eq!(
                resolve(&mut e, "s", g, &command(&r), Value::Null)["outcome"]["wait"],
                wait
            );
        }
        let mut l = limits();
        l["vision"] = json!(true);
        let mut b = built();
        b["messages"] = json!([{"content":[{"type":"image_url"}]}]);
        let (g, c) = invoke(&mut e, "s", l, b);
        let r = reject(
            &mut e,
            "s",
            g,
            &c,
            json!({"kind":"bad-request","message":"no images"}),
        );
        assert_eq!(command(&r)["actions"][1]["kind"], "learnNoVision");
        assert_eq!(
            resolve(&mut e, "s", g, &command(&r), Value::Null)["outcome"]["continue"],
            true
        );
        assert_eq!(e.state("s")["badRequests"], 2);
    }
    #[test]
    fn silent_truncation_accounts_then_discards_and_forces_next_compaction() {
        let mut e = ExecutionEngine::new();
        let mut l = limits();
        l["limits"]["source"] = json!("guess");
        let mut b = built();
        b["tokens"] = json!(6000);
        let (g, c) = invoke(&mut e, "s", l, b);
        let r = resolve(
            &mut e,
            "s",
            g,
            &c,
            json!({"content":"discard","usage":{"input":1000},"route":{"identity":"p"}}),
        );
        assert_eq!(command(&r)["kind"], "account");
        let r = resolve(&mut e, "s", g, &command(&r), Value::Null);
        assert_eq!(
            command(&r)["actions"][0],
            json!({"kind":"streamEnd","discard":true})
        );
        resolve(&mut e, "s", g, &command(&r), Value::Null);
        assert_eq!(e.state("s")["forceCompact"], true);
        let r = e.begin(session("s"), json!({})).unwrap();
        let g = r["generation"].as_u64().unwrap();
        let r = resolve(&mut e, "s", g, &command(&r), session("s"));
        let r = resolve(&mut e, "s", g, &command(&r), limits());
        assert_eq!(command(&r)["force"], true);
        assert_eq!(e.state("s")["forceCompact"], false);
    }
    #[test]
    fn uncached_usage_estimate_is_corrected_before_accounting() {
        let mut e = ExecutionEngine::new();
        let mut l = limits();
        l["toolsTokens"] = json!(10);
        l["ratio"] = json!(2);
        let (g, c) = invoke(&mut e, "s", l, built());
        let r = resolve(
            &mut e,
            "s",
            g,
            &c,
            json!({"content":"ok","usage":{"input":20,"uncachedOnly":true}}),
        );
        assert_eq!(
            command(&r)["answer"]["usage"],
            json!({"input":220.0,"uncachedOnly":true,"cacheRead":200.0,"estimated":true})
        );
    }
    #[test]
    fn tools_group_only_consecutive_original_readonly_names() {
        let mut e = ExecutionEngine::new();
        let r=e.begin_tools(session("s"),json!([{"id":"a","name":"read"},{"id":"b","name":"read"},{"id":"c","name":"tools_call"},{"id":"d","name":"read"}]),json!({"B":10000})).unwrap();
        let g = r["generation"].as_u64().unwrap();
        let r = resolve(
            &mut e,
            "s",
            g,
            &command(&r),
            json!({"tools":{"read":{"readOnly":true},"tools_call":{"readOnly":false}}}),
        );
        assert_eq!(r["commands"].as_array().unwrap().len(), 2);
        let first = tool_to_execute(&mut e, g, &r["commands"][0], json!({"path":"first"}));
        let second = tool_to_execute(&mut e, g, &r["commands"][1], json!({"path":"second"}));
        let r = complete_tool(&mut e, g, &second, json!({"text":"second"}));
        assert!(r["commands"].as_array().unwrap().is_empty());
        let r = complete_tool(&mut e, g, &first, json!({"text":"first"}));
        let c = command(&r);
        assert_eq!(c["kind"], "recordTools");
        assert_eq!(c["calls"][0]["id"], "a");
        assert_eq!(c["calls"][1]["id"], "b");
        assert_eq!(c["outputs"][0]["args"]["path"], "first");
        assert_eq!(c["outputs"][1]["args"]["path"], "second");
        assert_eq!(c["outputs"][0]["ms"], 5);
        assert_eq!(c["outputs"][0]["result"]["text"], "redacted");
        let r = resolve(&mut e, "s", g, &c, Value::Null);
        assert_eq!(r["commands"].as_array().unwrap().len(), 1);
        assert_eq!(command(&r)["index"], 2);
    }
    #[test]
    fn abort_drains_parallel_receipts_and_does_not_execute_next_group() {
        let mut e = ExecutionEngine::new();
        let r=e.begin_tools(session("s"),json!([{"id":"a","name":"read"},{"id":"b","name":"read"},{"id":"c","name":"write"}]),json!({"B":10000})).unwrap();
        let g = r["generation"].as_u64().unwrap();
        let r = resolve(
            &mut e,
            "s",
            g,
            &command(&r),
            json!({"tools":{"read":{"readOnly":true}}}),
        );
        let first = tool_to_execute(&mut e, g, &r["commands"][0], json!({"path":"a"}));
        let second = tool_to_execute(&mut e, g, &r["commands"][1], json!({"path":"b"}));
        assert_eq!(
            complete_tool(&mut e, g, &second, json!({"text":"already done"}))["status"],
            "running"
        );
        assert_eq!(
            e.stop(json!({"sessionId":"s","generation":g,"reason":"stopped"}))
                .unwrap()["status"],
            "running"
        );
        let r = reject(
            &mut e,
            "s",
            g,
            &first,
            json!({"name":"AbortError","message":"aborted"}),
        );
        let c = command(&r);
        assert_eq!(c["kind"], "recordTools");
        assert_eq!(c["outputs"].as_array().unwrap().len(), 3);
        assert_eq!(c["outputs"][1]["result"]["text"], "redacted");
        assert_eq!(c["outputs"][1]["interrupted"], true);
        assert_eq!(c["outputs"][2]["notExecuted"], true);
        assert_eq!(
            resolve(&mut e, "s", g, &c, Value::Null)["outcome"]["aborted"],
            true
        );
    }
    #[test]
    fn declined_approval_never_dispatches_an_effect() {
        let mut e = ExecutionEngine::new();
        let r = e
            .begin_tools(
                session("s"),
                json!([{"id":"a","name":"tools_call"}]),
                json!({"B":5000}),
            )
            .unwrap();
        let g = r["generation"].as_u64().unwrap();
        let r = resolve(&mut e, "s", g, &command(&r), json!({"tools":{}}));
        let r = resolve(
            &mut e,
            "s",
            g,
            &command(&r),
            json!({"name":"mcp:s/write","args":{"target":"original"}}),
        );
        let r = resolve(
            &mut e,
            "s",
            g,
            &command(&r),
            json!({"args":{"target":"approved"}}),
        );
        let r = resolve(&mut e, "s", g, &command(&r), json!({"decision":"declined"}));
        let c = command(&r);
        assert_eq!(c["kind"], "recordTools");
        assert_eq!(c["outputs"][0]["args"]["target"], "approved");
        assert_eq!(
            resolve(&mut e, "s", g, &c, Value::Null)["outcome"],
            json!({"toolsCompleted":true})
        );
    }
    #[test]
    fn cancelled_approval_cannot_dispatch_after_late_allow() {
        let mut e = ExecutionEngine::new();
        let r = e
            .begin_tools(
                session("s"),
                json!([{"id":"a","name":"write"}]),
                json!({"B":5000}),
            )
            .unwrap();
        let g = r["generation"].as_u64().unwrap();
        let r = resolve(&mut e, "s", g, &command(&r), json!({"tools":{}}));
        let r = resolve(
            &mut e,
            "s",
            g,
            &command(&r),
            json!({"name":"write","args":{"path":"x"}}),
        );
        let r = resolve(&mut e, "s", g, &command(&r), json!({}));
        e.stop(json!({"sessionId":"s","generation":g})).unwrap();
        let r = resolve(&mut e, "s", g, &command(&r), json!({"decision":"allow"}));
        assert_eq!(command(&r)["kind"], "recordTools");
        assert_eq!(command(&r)["outputs"][0]["notExecuted"], true);
    }
    #[test]
    fn aborted_queued_dispatch_preserves_known_not_executed_status() {
        let mut e = ExecutionEngine::new();
        let r = e
            .begin_tools(
                session("s"),
                json!([{"id":"a","name":"write"}]),
                json!({"B":5000}),
            )
            .unwrap();
        let g = r["generation"].as_u64().unwrap();
        let r = resolve(&mut e, "s", g, &command(&r), json!({"tools":{}}));
        let c = tool_to_execute(&mut e, g, &command(&r), json!({"path":"approved"}));
        e.stop(json!({"sessionId":"s","generation":g})).unwrap();
        let r = reject(
            &mut e,
            "s",
            g,
            &c,
            json!({"name":"AbortError","message":"dispatch cancelled","notExecuted":true}),
        );
        assert_eq!(command(&r)["outputs"][0]["notExecuted"], true);
        assert_eq!(command(&r)["outputs"][0]["interrupted"], true);
    }
    #[test]
    fn forgetting_counters_cannot_revalidate_old_effects() {
        let mut e = ExecutionEngine::new();
        let old = e.begin(session("s"), json!({})).unwrap();
        e.stop(json!({"sessionId":"s","generation":old["generation"]}))
            .unwrap();
        e.forget("s").unwrap();
        let new = e.begin(session("s"), json!({})).unwrap();
        assert_ne!(old["generation"], new["generation"]);
        assert_eq!(
            resolve(
                &mut e,
                "s",
                old["generation"].as_u64().unwrap(),
                &command(&old),
                session("s")
            )["status"],
            "stale"
        );
        assert_eq!(e.state("s")["empties"], 0);
    }
    #[test]
    fn parsing_failures_do_not_invent_arguments_or_prepared_identity() {
        let mut e = ExecutionEngine::new();
        let r = e
            .begin_tools(
                session("s"),
                json!([{"id":"a","name":"write","arguments":"bad"}]),
                json!({"B":5000}),
            )
            .unwrap();
        let g = r["generation"].as_u64().unwrap();
        let r = resolve(&mut e, "s", g, &command(&r), json!({"tools":{}}));
        let r = resolve(
            &mut e,
            "s",
            g,
            &command(&r),
            json!({"error":"invalid JSON","ms":0}),
        );
        let c = command(&r);
        assert_eq!(c["kind"], "recordTools");
        assert!(c["outputs"][0].get("args").is_none());
        assert!(c["outputs"][0].get("name").is_none());
    }
    #[test]
    fn js_whitespace_and_utf16_error_slicing_are_preserved() {
        assert_eq!(one_line("\u{feff} x \n y ", 100), "x y");
        assert_eq!(one_line("a\u{0085}b", 100), "a\u{0085}b");
        assert_eq!(
            crate::json_codec::utf16_units(&slice("x😀z", 2)),
            vec![b'x' as u16, 0xd83d]
        );
    }
    #[test]
    fn lean_rebudget_requires_fresh_definitions() {
        let mut e = ExecutionEngine::new();
        let r = e.begin(session("s"), json!({})).unwrap();
        let g = r["generation"].as_u64().unwrap();
        let r = resolve(&mut e, "s", g, &command(&r), session("s"));
        let mut l = limits();
        l["B"] = json!(900);
        l["toolDefs"] = json!([{"large":"worker set"}]);
        let r = resolve(&mut e, "s", g, &command(&r), l);
        assert_eq!(command(&r)["actions"][0]["kind"], "lean");
        let mut lean = session("s");
        lean["toolset"] = json!("lean");
        let r = resolve(&mut e, "s", g, &command(&r), json!({"session":lean}));
        assert_eq!(command(&r)["kind"], "budget");
        assert_eq!(command(&r)["overflow"], false);
        assert_eq!(command(&r)["toolDefs"], Value::Null);
    }
}
