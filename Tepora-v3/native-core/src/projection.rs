//! Pure browser-facing projections of persisted agent sessions and live events.
//!
//! The host supplies ordered facts and publishes derived events synchronously
//! before their source event. This module owns no database, listener, clock,
//! network connection, or execution authority. All strings use the crate's
//! lossless JavaScript JSON representation until the public JSON boundary.

use crate::{
    invalid,
    js_value::{js_string, truthy},
    json_codec, CoreError, CoreResult,
};
use serde_json::{json, Map, Value};

/// Node-independent projection boundary, including legacy lone UTF-16 units.
pub fn project_json(operation: &str, payload_json: &str) -> Result<String, CoreError> {
    let payload = json_codec::parse(payload_json)?;
    json_codec::stringify_js(&call(operation, payload)?)
}

fn required<'a>(value: &'a Value, key: &str) -> CoreResult<&'a Value> {
    value
        .get(key)
        .ok_or_else(|| invalid(format!("{key} is required")))
}
fn accessible(value: &Value) -> CoreResult<()> {
    if value.is_null() {
        Err(invalid("Cannot read properties of null"))
    } else {
        Ok(())
    }
}
fn array<'a>(value: &'a Value, name: &str) -> CoreResult<&'a [Value]> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| invalid(format!("{name} must be an array")))
}
fn optional_array<'a>(value: &'a Value, name: &str) -> CoreResult<&'a [Value]> {
    match value.get(name) {
        Some(value) => array(value, name),
        None => Ok(&[]),
    }
}
fn is(value: &Value, key: &str, text: &str) -> bool {
    value.get(key).and_then(Value::as_str) == Some(text)
}
fn present(value: &Value, key: &str) -> bool {
    value.get(key).is_some_and(truthy)
}
fn or(value: Option<&Value>, fallback: Value) -> Value {
    value
        .filter(|value| truthy(value))
        .cloned()
        .unwrap_or(fallback)
}
fn copied(out: &mut Map<String, Value>, target: &str, source: Option<&Value>) {
    if let Some(value) = source {
        out.insert(target.into(), value.clone());
    }
}
fn fixed(out: &mut Map<String, Value>, key: &str, value: Value) {
    out.insert(key.into(), value);
}
fn scalar_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::Object(_) | Value::Array(_)), _)
        | (_, Some(Value::Object(_) | Value::Array(_))) => false,
        _ => a == b,
    }
}
fn whitespace(unit: u16) -> bool {
    matches!(unit,0x0009..=0x000d|0x0020|0x00a0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
}
fn trim(text: &str) -> String {
    let units = json_codec::utf16_units(text);
    let start = units
        .iter()
        .position(|&unit| !whitespace(unit))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|&unit| !whitespace(unit))
        .map_or(start, |i| i + 1);
    json_codec::from_utf16_units(&units[start..end])
}
fn silent(text: &str) -> bool {
    let units = json_codec::utf16_units(text);
    let lead = |unit| {
        whitespace(unit)
            || matches!(
                unit,
                0x22 | 0x27
                    | 0x60
                    | 0x2a
                    | 0x5f
                    | 0x7e
                    | 0x300c
                    | 0x300e
                    | 0xff08
                    | 0x28
                    | 0x5b
                    | 0x3010
                    | 0x3c
            )
    };
    let start = units
        .iter()
        .position(|&unit| !lead(unit))
        .unwrap_or(units.len());
    let rest = &units[start..];
    const MARKER: &[u8] = b"NO_REPLY";
    if rest.len() < MARKER.len()
        || !rest
            .iter()
            .zip(MARKER)
            .all(|(&a, &b)| a <= 127 && (a as u8).eq_ignore_ascii_case(&b))
    {
        return false;
    }
    rest.get(MARKER.len()).is_none_or(|&unit| {
        unit > 127 || !(unit as u8).is_ascii_alphanumeric() && unit != b'_' as u16
    })
}
fn number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(value) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(value) => value.as_f64().unwrap_or(f64::NAN),
        _ => {
            let text = trim(&js_string(Some(value)));
            if text.is_empty() {
                return 0.0;
            }
            for (prefix, radix) in [
                ("0x", 16),
                ("0X", 16),
                ("0b", 2),
                ("0B", 2),
                ("0o", 8),
                ("0O", 8),
            ] {
                if let Some(digits) = text.strip_prefix(prefix) {
                    return u64::from_str_radix(digits, radix)
                        .map(|n| n as f64)
                        .unwrap_or(f64::NAN);
                }
            }
            // Number() accepts Infinity, but not Rust's short inf spelling.
            if text == "Infinity" || text == "+Infinity" {
                return f64::INFINITY;
            }
            if text == "-Infinity" {
                return f64::NEG_INFINITY;
            }
            if text
                .bytes()
                .any(|c| c.is_ascii_alphabetic() && c != b'e' && c != b'E')
            {
                return f64::NAN;
            }
            text.parse::<f64>().unwrap_or(f64::NAN)
        }
    }
}
fn title(session: &Value) -> CoreResult<Value> {
    if let Some(value) = session.get("title").filter(|value| truthy(value)) {
        return Ok(value.clone());
    }
    let task = match session.get("task") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(value)) => {
            let units = json_codec::utf16_units(value);
            json!(json_codec::from_utf16_units(&units[..units.len().min(60)]))
        }
        Some(Value::Array(values)) => Value::Array(values.iter().take(60).cloned().collect()),
        _ => return Err(invalid("task.slice is not a function")),
    };
    Ok(if truthy(&task) { task } else { json!("仕事") })
}
fn status(session: &Value) -> Option<Value> {
    if is(session, "status", "waiting") {
        let note = js_string(Some(&or(session.get("note"), json!(""))));
        if note.contains("承認待ち") {
            return Some(json!("waiting_approval"));
        }
        if note.contains("空きを待って") {
            return Some(json!("queued"));
        }
    }
    if is(session, "status", "done") && present(session, "accepted") {
        return Some(json!("completed"));
    }
    let key = js_string(session.get("status"));
    match key.as_str() {
        "running" => Some(json!("running")),
        "waiting" => Some(json!("blocked")),
        "idle" => Some(json!("completed")),
        "done" => Some(json!("review")),
        "stopped" => Some(json!("paused")),
        // Ordinary inherited prototype data is observable after JSON encoding.
        "__proto__" => Some(json!({})),
        _ => session.get("status").cloned(),
    }
}
fn job(session: &Value, approvals: Value) -> CoreResult<Value> {
    accessible(session)?;
    let mut out = Map::new();
    copied(&mut out, "id", session.get("id"));
    fixed(&mut out, "title", title(session)?);
    fixed(&mut out, "kind", json!("work"));
    copied(&mut out, "status", status(session).as_ref());
    fixed(&mut out, "note", or(session.get("note"), json!("")));
    fixed(
        &mut out,
        "step",
        or(session.get("stats").and_then(|v| v.get("steps")), json!(0)),
    );
    fixed(&mut out, "output", or(session.get("result"), json!("")));
    copied(&mut out, "createdAt", session.get("createdAt"));
    fixed(
        &mut out,
        "endedAt",
        or(session.get("finishedAt"), Value::Null),
    );
    fixed(&mut out, "revision", json!(0));
    fixed(&mut out, "priority", json!(0));
    fixed(&mut out, "engine", json!("builtin"));
    copied(&mut out, "parentId", session.get("parentId"));
    copied(&mut out, "sessionKind", session.get("kind"));
    fixed(&mut out, "depth", or(session.get("depth"), json!(0)));
    fixed(&mut out, "todo", or(session.get("todo"), json!([])));
    copied(&mut out, "cwd", session.get("cwd"));
    fixed(&mut out, "retryAt", or(session.get("retryAt"), Value::Null));
    fixed(&mut out, "stats", or(session.get("stats"), json!({})));
    fixed(&mut out, "route", or(session.get("route"), Value::Null));
    let route = if let Some(route) = session.get("route").filter(|value| truthy(value)) {
        let mut out = Map::new();
        for key in ["profileId", "model", "domain"] {
            copied(&mut out, key, route.get(key));
        }
        Value::Object(out)
    } else {
        Value::Null
    };
    fixed(&mut out, "executionRoute", route);
    fixed(&mut out, "pendingApprovals", approvals);
    let verification = if present(session, "accepted") {
        json!("accepted-by-user")
    } else if is(session, "status", "done") {
        json!("needs-review")
    } else {
        Value::Null
    };
    fixed(&mut out, "verification", json!({"status":verification}));
    Ok(Value::Object(out))
}
fn approval(value: &Value) -> Value {
    let mut out = Map::new();
    copied(&mut out, "id", value.get("id"));
    copied(&mut out, "jobId", value.get("sessionId"));
    fixed(
        &mut out,
        "jobTitle",
        or(value.get("sessionTitle"), json!("")),
    );
    copied(&mut out, "name", value.get("tool"));
    copied(&mut out, "args", value.get("args"));
    copied(&mut out, "status", value.get("status"));
    copied(&mut out, "createdAt", value.get("createdAt"));
    fixed(
        &mut out,
        "decidedAt",
        or(value.get("decidedAt"), Value::Null),
    );
    fixed(&mut out, "note", or(value.get("note"), json!("")));
    fixed(&mut out, "mode", json!("live"));
    fixed(&mut out, "stacked", json!(false));
    Value::Object(out)
}
fn lookup_title(facts: &Value, id: Option<&Value>) -> Option<Value> {
    if let Some(titles) = facts.get("titles").and_then(Value::as_array) {
        return titles
            .iter()
            .rev()
            .find(|pair| scalar_eq(pair.get(0), id))
            .and_then(|pair| pair.get(1))
            .cloned();
    }
    facts
        .get("sessions")
        .and_then(Value::as_array)?
        .iter()
        .rev()
        .find(|session| scalar_eq(session.get("id"), id))
        .and_then(|session| session.get("title"))
        .cloned()
}
fn message(entry: &Value, main: &Value, facts: &Value) -> CoreResult<Value> {
    accessible(entry)?;
    let input = is(entry, "type", "input");
    let report = is(entry, "kind", "report");
    let mut sender = None;
    let mut text = None;
    let mut delegated = 0;
    if input {
        if present(entry, "passive") && !report {
            return Ok(Value::Null);
        }
        if !report {
            if ["heartbeat", "event", "reminder"]
                .iter()
                .any(|kind| is(entry, "kind", kind))
                || ["timer", "system", "schedule"]
                    .iter()
                    .any(|kind| is(entry, "from", kind))
            {
                return Ok(Value::Null);
            }
            if present(entry, "from") && !is(entry, "from", "user") {
                let from = entry["from"]
                    .as_str()
                    .ok_or_else(|| invalid("from.startsWith is not a function"))?;
                if !from.starts_with("voice") {
                    sender = Some(from.strip_prefix("child:").unwrap_or(from).to_owned());
                }
            }
        }
    } else if is(entry, "type", "assistant") {
        let content = trim(&js_string(Some(&or(entry.get("content"), json!("")))));
        if content.is_empty() || silent(&content) || present(entry, "withdrawn") {
            return Ok(Value::Null);
        }
        let calls = or(entry.get("toolCalls"), json!([]));
        for call in array(&calls, "toolCalls")? {
            if call.is_null() {
                return Err(invalid("Cannot read properties of null (reading name)"));
            }
            if is(call, "name", "sessions_spawn") {
                delegated += 1;
            }
        }
        text = Some(content);
    } else {
        return Ok(Value::Null);
    }

    accessible(main)?;
    let mut out = Map::new();
    fixed(
        &mut out,
        "id",
        json!(format!("m{}", js_string(entry.get("seq")))),
    );
    copied(&mut out, "sessionId", main.get("id"));
    fixed(
        &mut out,
        "role",
        json!(if !input {
            "assistant"
        } else if report || sender.is_some() {
            "tool"
        } else {
            "user"
        }),
    );
    fixed(
        &mut out,
        "kind",
        json!(if !input {
            "character"
        } else if report || sender.is_some() {
            "worker-report"
        } else {
            "utterance"
        }),
    );
    if let Some(text) = text {
        fixed(&mut out, "content", json!(text));
    } else {
        copied(&mut out, "content", entry.get("text"));
    }
    if input && report {
        fixed(&mut out, "jobId", or(entry.get("sessionId"), Value::Null));
        fixed(
            &mut out,
            "status",
            json!(if is(entry, "status", "done") {
                "review"
            } else if is(entry, "status", "stuck") {
                "blocked"
            } else {
                "running"
            }),
        );
        let title = lookup_title(facts, entry.get("sessionId"));
        fixed(
            &mut out,
            "sourceName",
            or(entry.get("title"), or(title.as_ref(), json!(""))),
        );
        fixed(&mut out, "source", json!("worker"));
        fixed(&mut out, "untrusted", json!(true));
    } else if let Some(sender) = sender {
        let id = json!(sender);
        let title = lookup_title(facts, Some(&id));
        fixed(&mut out, "jobId", id);
        fixed(&mut out, "status", json!("running"));
        fixed(&mut out, "sourceName", or(title.as_ref(), json!("")));
    } else if input {
        fixed(&mut out, "source", or(entry.get("source"), json!("text")));
    } else {
        fixed(&mut out, "truncated", json!(present(entry, "truncated")));
        fixed(&mut out, "delegated", json!(delegated));
    }
    copied(&mut out, "at", entry.get("at"));
    copied(&mut out, "seq", entry.get("seq"));
    Ok(Value::Object(out))
}

fn addition(a: Option<&Value>, b: Option<&Value>) -> Value {
    let string_primitive = |v: Option<&Value>| {
        matches!(
            v,
            Some(Value::String(_) | Value::Array(_) | Value::Object(_))
        )
    };
    if string_primitive(a) || string_primitive(b) {
        let joined = format!("{}{}", js_string(a), js_string(b));
        return json!(json_codec::from_utf16_units(&json_codec::utf16_units(
            &joined
        )));
    }
    let number = |v: Option<&Value>| match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(v)) => {
            if *v {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(v)) => v.as_f64().unwrap_or(f64::NAN),
        _ => f64::NAN,
    };
    serde_json::Number::from_f64(number(a) + number(b))
        .map(Value::Number)
        .unwrap_or(Value::Null)
}
fn merge_with_sources(messages: &[Value]) -> CoreResult<(Vec<Value>, Vec<(usize, usize)>)> {
    let mut out: Vec<Value> = Vec::new();
    let mut origins: Vec<(usize, usize)> = Vec::new();
    for (index, next) in messages.iter().enumerate() {
        if out
            .last()
            .is_some_and(|prev| is(prev, "role", "assistant") && present(prev, "truncated"))
            && next.is_null()
        {
            return Err(invalid("Cannot read properties of null (reading role)"));
        }
        if out
            .last()
            .is_some_and(|prev| is(prev, "role", "assistant") && present(prev, "truncated"))
            && is(next, "role", "assistant")
        {
            let previous = out.last_mut().unwrap();
            let content = addition(previous.get("content"), next.get("content"));
            let fields = previous.as_object_mut().unwrap();
            fields.insert("content".into(), content);
            for key in ["truncated", "id", "at"] {
                if let Some(value) = next.get(key) {
                    fields.insert(key.into(), value.clone());
                } else {
                    fields.shift_remove(key);
                }
            }
            origins.last_mut().unwrap().1 = index;
        } else {
            out.push(next.clone());
            origins.push((index, index));
        }
    }
    Ok((out, origins))
}
fn merge(messages: &[Value]) -> CoreResult<Vec<Value>> {
    Ok(merge_with_sources(messages)?.0)
}
fn pending(approvals: &[Value], session: &Value) -> usize {
    approvals
        .iter()
        .filter(|a| scalar_eq(a.get("sessionId"), session.get("id")) && is(a, "status", "pending"))
        .count()
}
fn jobs(sessions: &[Value], approvals: &[Value]) -> CoreResult<Value> {
    sessions
        .iter()
        .filter(|s| !is(s, "kind", "main"))
        .map(|s| job(s, json!(pending(approvals, s))))
        .collect::<CoreResult<Vec<_>>>()
        .map(Value::Array)
}
fn approval_list(approvals: &[Value]) -> CoreResult<Value> {
    approvals
        .iter()
        .map(|value| {
            accessible(value)?;
            Ok(approval(value))
        })
        .collect::<CoreResult<Vec<_>>>()
        .map(Value::Array)
}
fn dialogue(facts: &Value) -> CoreResult<Value> {
    let main = required(facts, "main")?;
    let personas = required(facts, "personas")?;
    let entries = optional_array(facts, "entries")?;
    let limit = facts.get("limit").map(number).unwrap_or(400.0);
    let mut shown = Vec::new();
    for entry in entries
        .iter()
        .filter(|e| is(e, "type", "input") || is(e, "type", "assistant"))
    {
        let value = message(entry, main, facts)?;
        if !value.is_null() {
            shown.push(value);
        }
    }
    let mut messages = merge(&shown)?;
    // Array.slice(-limit): ToIntegerOrInfinity truncates before choosing which
    // end to count from, so a fractional -0 must start at zero, not len.
    let start = (-limit).trunc();
    let start = if start.is_nan() || start == 0.0 {
        0
    } else if start < 0.0 {
        messages.len().saturating_sub((-start) as usize)
    } else {
        (start as usize).min(messages.len())
    };
    messages.drain(..start);
    let mut session = Map::new();
    copied(&mut session, "id", main.get("id"));
    copied(&mut session, "revision", personas.get("revision"));
    copied(&mut session, "character", personas.get("character"));
    let mut out = Map::new();
    fixed(&mut out, "session", Value::Object(session));
    fixed(&mut out, "personas", personas.clone());
    fixed(&mut out, "messages", Value::Array(messages));
    copied(&mut out, "status", main.get("status"));
    fixed(&mut out, "note", or(main.get("note"), json!("")));
    Ok(Value::Object(out))
}
fn event(facts: &Value) -> CoreResult<Value> {
    let event = required(facts, "event")?;
    let data = event.get("data").unwrap_or(&Value::Null);
    let sessions = optional_array(facts, "sessions")?;
    let approvals = optional_array(facts, "approvals")?;
    let main = sessions.iter().find(|s| is(s, "kind", "main"));
    let result = if is(event, "type", "session.updated") && !is(data, "kind", "main") {
        Some(("job.updated", job(data, json!(pending(approvals, data)))?))
    } else if is(event, "type", "session.entry") {
        if let Some(main) = main.filter(|main| scalar_eq(data.get("sessionId"), main.get("id"))) {
            let shown = message(required(data, "entry")?, main, facts)?;
            if shown.is_null() {
                None
            } else {
                Some(("dialogue.message", shown))
            }
        } else {
            None
        }
    } else if is(event, "type", "agent.delta") {
        let mut out = Map::new();
        let kind = if main.is_some_and(|main| scalar_eq(data.get("sessionId"), main.get("id"))) {
            copied(&mut out, "text", data.get("text"));
            "dialogue.delta"
        } else {
            copied(&mut out, "id", data.get("sessionId"));
            copied(&mut out, "output", data.get("text"));
            "job.output"
        };
        fixed(&mut out, "done", json!(present(data, "done")));
        Some((kind, Value::Object(out)))
    } else if is(event, "type", "approval.updated") {
        accessible(data)?;
        Some(("approval.view", approval(data)))
    } else {
        None
    };
    Ok(Value::Array(
        result
            .into_iter()
            .map(|(kind, data)| json!({"type":kind,"data":data}))
            .collect(),
    ))
}

pub(crate) fn call(operation: &str, payload: Value) -> CoreResult<Value> {
    let p = &payload;
    match operation {
        "ui.jobStatus" => {
            let session = required(p, "session")?;
            accessible(session)?;
            Ok(status(session).unwrap_or(Value::Null))
        }
        "ui.job" => {
            let session = required(p, "session")?;
            let approvals = if let Some(records) = p.get("approvalRecords") {
                json!(pending(array(records, "approvalRecords")?, session))
            } else {
                p.get("approvals").cloned().unwrap_or(json!(0))
            };
            job(session, approvals)
        }
        "ui.approval" => {
            let value = required(p, "approval")?;
            accessible(value)?;
            Ok(approval(value))
        }
        "ui.message" => message(required(p, "entry")?, required(p, "main")?, p),
        "ui.merge" => {
            let (messages, origins) =
                merge_with_sources(array(required(p, "messages")?, "messages")?)?;
            if present(p, "withSources") {
                Ok(json!({"messages":messages,"origins":origins}))
            } else {
                Ok(Value::Array(messages))
            }
        }
        "ui.dialogue" => dialogue(p),
        "ui.jobs" => jobs(
            optional_array(p, "sessions")?,
            optional_array(p, "approvals")?,
        ),
        "ui.approvals" => approval_list(optional_array(p, "approvals")?),
        "ui.snapshot" => {
            let mut agent = Map::new();
            for key in ["settings", "main", "usage"] {
                copied(&mut agent, key, p.get(key));
            }
            Ok(
                json!({"dialogue":dialogue(p)?,"jobs":jobs(optional_array(p,"sessions")?,optional_array(p,"approvals")?)?,"approvals":approval_list(optional_array(p,"approvals")?)?,"agent":agent}),
            )
        }
        "ui.event" => event(p),
        _ => Err(invalid(format!(
            "Unknown projection operation: {operation}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(op: &str, payload: Value) -> Value {
        call(op, json_codec::encode_value(payload)).unwrap()
    }
    #[test]
    fn status_precedence_and_missing_fields_are_stable() {
        assert_eq!(
            run(
                "ui.jobStatus",
                json!({"session":{"status":"waiting","note":"空きを待って 承認待ち"}})
            ),
            "waiting_approval"
        );
        assert_eq!(
            run(
                "ui.jobStatus",
                json!({"session":{"status":"done","accepted":[]}})
            ),
            "completed"
        );
        let result = run("ui.job", json!({"session":{}}));
        assert!(result.get("id").is_none());
        assert!(result.get("status").is_none());
        assert_eq!(result["endedAt"], Value::Null);
        assert_eq!(result["title"], "仕事");
    }
    #[test]
    fn title_slice_preserves_split_surrogate_and_marker_collisions() {
        let title = format!("{}🦀\u{e000}", "a".repeat(59));
        let wire = project_json("ui.job", &json!({"session":{"task":title}}).to_string()).unwrap();
        assert!(wire.contains("\\ud83e"));
        let result = json_codec::parse(&wire).unwrap();
        assert_eq!(
            json_codec::utf16_units(result["title"].as_str().unwrap()).len(),
            60
        );
    }
    #[test]
    fn conversation_silence_and_js_whitespace_are_exact() {
        for content in ["NO_REPLY", " \u{feff}「**no_reply!later", "NO_REPLY日"] {
            assert_eq!(
                run(
                    "ui.message",
                    json!({"entry":{"type":"assistant","content":content},"main":{"id":"m"}})
                ),
                Value::Null
            );
        }
        for content in ["NO_REPLYING", "NO_REPLY_1", "\u{85}NO_REPLY", "hello"] {
            assert!(!run(
                "ui.message",
                json!({"entry":{"type":"assistant","content":content},"main":{"id":"m"}})
            )
            .is_null());
        }
    }
    #[test]
    fn merged_continuations_keep_first_seq_and_other_fields() {
        let out = run(
            "ui.merge",
            json!({"messages":[{"id":"m1","seq":1,"role":"assistant","content":"one","truncated":true,"delegated":2,"at":"first"},{"id":"m2","seq":2,"role":"assistant","content":"two","truncated":false,"delegated":0,"at":"last"}]}),
        );
        assert_eq!(out[0]["id"], "m2");
        assert_eq!(out[0]["seq"], 1);
        assert_eq!(out[0]["delegated"], 2);
        assert_eq!(out[0]["content"], "onetwo");
    }
    #[test]
    fn live_projection_is_pure_and_drops_reasoning() {
        let out = run(
            "ui.event",
            json!({"event":{"type":"agent.delta","data":{"sessionId":"m","text":"visible","reasoning":"private","done":1}},"sessions":[{"id":"m","kind":"main"}]}),
        );
        assert_eq!(
            out,
            json!([{"type":"dialogue.delta","data":{"text":"visible","done":true}}])
        );
        let out = run(
            "ui.event",
            json!({"event":{"type":"session.updated","data":{"id":"w","kind":"worker","status":"waiting"}},"approvals":[{"sessionId":"w","status":"pending"},{"sessionId":"w","status":"denied"}]}),
        );
        assert_eq!(out[0]["data"]["pendingApprovals"], 1);
        assert!(out[0].get("seq").is_none());
    }
}
