//! Pure metacognition and post-tool planning. Time, the current session and its
//! children are explicit inputs; callers apply returned memory and actions.
use super::{arr, js, one_line, round, text, truth};
use crate::{invalid, js_value, json_codec, CoreResult};
use serde_json::{json, Map, Value};

const ERROR_WINDOW: usize = 6;
const MIN_GAP: f64 = 5.0;

pub(super) fn call(op: &str, p: &Value) -> CoreResult<Value> {
    let session = &p["session"];
    let mut mem = object(&p["mem"]);
    match op {
        "selfFacts" => Ok(self_facts(p, session, &mem)),
        "selfCheckDue" => {
            let why = self_check_due(session, &mut mem, &p["f"], p.get("every"));
            Ok(json!({"why":why,"mem":mem}))
        }
        "noteSelfCheck" => {
            note_self_check(&mut mem, &p["f"], arr(p, "why"));
            Ok(json!({"mem":mem}))
        }
        "renderSelfCheck" => Ok(Value::String(render_self_check(
            &p["f"],
            arr(p, "why"),
            p.get("kind").unwrap_or(&json!("worker")),
        )?)),
        "renderReflection" => Ok(Value::String(render_reflection(&p["reflection"]))),
        "reflect" => Ok(reflect(session, &p["args"], p.get("at"))),
        "watch" => {
            let actions = watch(session, &mut mem);
            Ok(json!({"mem":mem,"actions":actions}))
        }
        "selfCheck" => {
            let actions = self_check(p, session, &mut mem)?;
            Ok(json!({"mem":mem,"actions":actions}))
        }
        "afterTools" => {
            let mut actions = watch(session, &mut mem);
            // A host that applies watch effects first may inject its refreshed
            // session. Otherwise this is a plan against the supplied snapshot.
            let latest = p.get("afterWatchSession").unwrap_or(session);
            actions.extend(self_check(p, latest, &mut mem)?);
            Ok(json!({"mem":mem,"actions":actions}))
        }
        _ => Err(invalid(format!("Unknown metacognition operation: {op}"))),
    }
}

fn object(v: &Value) -> Value {
    let mut out = Map::new();
    spread(&mut out, v);
    Value::Object(out)
}

fn spread(out: &mut Map<String, Value>, v: &Value) {
    match v {
        Value::Object(values) => out.extend(values.clone()),
        Value::Array(values) => {
            for (i, value) in values.iter().enumerate() {
                out.insert(i.to_string(), value.clone());
            }
        }
        Value::String(value) => {
            for (i, unit) in json_codec::utf16_units(value).into_iter().enumerate() {
                out.insert(
                    i.to_string(),
                    Value::String(json_codec::from_utf16_units(&[unit])),
                );
            }
        }
        _ => {}
    }
}

fn or(v: Option<&Value>, fallback: Value) -> Value {
    v.filter(|v| js_value::truthy(v))
        .cloned()
        .unwrap_or(fallback)
}

fn nullish(v: Option<&Value>, fallback: Value) -> Value {
    v.filter(|v| !v.is_null()).cloned().unwrap_or(fallback)
}

fn number(v: Option<&Value>) -> f64 {
    match v {
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
        Some(Value::String(_)) | Some(Value::Array(_)) => {
            let s = js_value::js_string(v);
            let s = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
            if s.is_empty() {
                return 0.0;
            }
            for (prefixes, radix) in [(["0x", "0X"], 16), (["0b", "0B"], 2), (["0o", "0O"], 8)] {
                if let Some(body) = prefixes.iter().find_map(|prefix| s.strip_prefix(prefix)) {
                    return u128::from_str_radix(body, radix)
                        .map(|v| v as f64)
                        .unwrap_or(f64::NAN);
                }
            }
            match s {
                "Infinity" | "+Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                "inf" | "+inf" | "-inf" | "infinity" => f64::NAN,
                _ => s.parse().unwrap_or(f64::NAN),
            }
        }
        Some(Value::Object(_)) => f64::NAN,
    }
}

fn n(v: &Value, key: &str) -> f64 {
    number(v.get(key))
}

fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        (Some(a @ Value::Array(_)), Some(b @ Value::Array(_)))
        | (Some(a @ Value::Object(_)), Some(b @ Value::Object(_))) => std::ptr::eq(a, b),
        _ => false,
    }
}

fn property_len(v: Option<&Value>) -> Option<usize> {
    match v {
        Some(Value::Array(v)) => Some(v.len()),
        Some(Value::String(v)) => Some(json_codec::utf16_units(v).len()),
        _ => None,
    }
}

fn self_facts(p: &Value, session: &Value, mem: &Value) -> Value {
    let stats = &session["stats"];
    let steps = or(stats.get("steps"), json!(0));
    let todo = arr(session, "todo");
    let reflection = session.get("reflection").filter(|r| js_value::truthy(r));
    let calls = arr(mem, "calls");
    let recent = &calls[calls.len().saturating_sub(ERROR_WINDOW)..];
    let mut sigs: Vec<Option<&Value>> = Vec::new();
    for call in calls {
        let sig = call.get("sig");
        if !sigs.iter().any(|other| strict_eq(*other, sig)) {
            sigs.push(sig);
        }
    }
    let budget = &p["B"];
    let built = &p["built"];
    let used = if js_value::truthy(built) && js_value::truthy(budget) {
        round(n(built, "tokens") * number(Some(&or(p.get("ratio"), json!(1)))))
    } else {
        0.0
    };
    let now = p.get("nowMs").map(|v| number(Some(v))).unwrap_or(0.0);
    // Date.parse failures cross the JSON boundary as null, not as the epoch.
    let created = match p.get("createdAtMs") {
        None => now,
        Some(Value::Null) => f64::NAN,
        Some(v) => number(Some(v)),
    };
    let minutes = round((now - created) / 60_000.0);
    let minutes = if minutes.is_nan() {
        minutes
    } else {
        minutes.max(0.0)
    };
    let mut facts = json!({
        "steps":steps,
        "minutes":minutes,
        "context":if used != 0.0 && !used.is_nan() && js_value::truthy(budget) {
            json!({"used":used,"budget":budget,"share":used/number(Some(budget))})
        } else { Value::Null },
        "calls":or(stats.get("toolCalls"), json!(0)),
        "errors":or(stats.get("toolErrors"), json!(0)),
        "recentErrors":recent.iter().filter(|call| truth(call,"error")).count(),
        "recentCalls":recent.len(),
        "variety":if calls.is_empty() {1.0} else {sigs.len() as f64/calls.len() as f64},
        "todo":if todo.is_empty() {Value::Null} else {json!({
            "done":todo.iter().filter(|t| t["status"]=="done").count(),
            "total":todo.len(),
            "blocked":todo.iter().filter(|t| t["status"]=="blocked").count(),
            "open":todo.iter().filter(|t| t["status"]!="done" && t["status"]!="blocked").count(),
            "still":number(Some(&steps))-number(Some(&nullish(mem.get("todoStep"),steps.clone())))
        })},
        "reflection":Value::Null,
        "model":or(p["profile"].get("model"),or(session["route"].get("model"),Value::Null)),
        "escalated":session["role"]=="escalation",
        "cost":or(stats.get("cost"),json!(0)),
        "team":if session["kind"]=="main" {
            arr(p,"team").iter().filter(|s| s["status"]=="running" || s["status"]=="waiting")
                .map(|s| Value::String(format!("\"{}\" {}",one_line(s.get("title"),40),text(s,"status"))))
                .collect::<Vec<_>>()
        } else { Vec::new() }
    });
    if let Some(r) = reflection {
        let mut f = json!({
            "step":nullish(r.get("step"),json!(0)),
            "confidence":nullish(r.get("confidence"),Value::Null)
        });
        for (target, key) in [
            ("assumptions", "assumptions"),
            ("questions", "open_questions"),
        ] {
            let value = or(r.get(key), json!([]));
            if let Some(len) = property_len(Some(&value)) {
                f[target] = json!(len);
            } else if let Some(len) = value.get("length") {
                f[target] = len.clone();
            }
        }
        f["age"] = json!(number(Some(&steps)) - number(Some(&nullish(r.get("step"), steps))));
        facts["reflection"] = f;
    }
    facts
}

fn self_check_due(
    session: &Value,
    mem: &mut Value,
    f: &Value,
    every: Option<&Value>,
) -> Vec<Value> {
    let last = nullish(mem.get("selfCheckStep"), json!(0));
    let gap = n(f, "steps") - number(Some(&last));
    let mut why = Vec::new();
    if truth(f, "context") && n(&f["context"], "share") >= 0.6 && !truth(mem, "selfCheckContext") {
        mem["selfCheckContext"] = json!(true);
        why.push(json!("context"));
    }
    if gap < MIN_GAP && why.is_empty() {
        return why;
    }
    if n(f, "recentCalls") >= ERROR_WINDOW as f64
        && n(f, "recentErrors") >= 3.0
        && !strict_eq(mem.get("selfCheckErrors"), f.get("calls"))
    {
        why.push(json!("errors"));
    }
    if truth(&f["todo"], "open")
        && n(&f["todo"], "still") >= 12.0
        && !strict_eq(mem.get("selfCheckStalled"), mem.get("todoStep"))
    {
        why.push(json!("stalled"));
    }
    if session["kind"] != "main"
        && !truth(f, "reflection")
        && n(f, "calls") >= 10.0
        && !truth(mem, "selfCheckAskedReflect")
    {
        why.push(json!("unreflected"));
    }
    if truth(f, "reflection")
        && f["reflection"].get("confidence") != Some(&Value::Null)
        && n(&f["reflection"], "confidence") < 0.5
        && n(&f["reflection"], "age") >= MIN_GAP
        && !strict_eq(mem.get("selfCheckLowAt"), f["reflection"].get("step"))
    {
        why.push(json!("low-confidence"));
    }
    let every = every.cloned().unwrap_or(json!(15));
    if session["kind"] != "main" && js_value::truthy(&every) && gap >= number(Some(&every)) {
        why.push(json!("interval"));
    }
    why
}

fn copy_or_remove(mem: &mut Value, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        mem[key] = value;
    } else if let Some(object) = mem.as_object_mut() {
        object.remove(key);
    }
}

fn note_self_check(mem: &mut Value, f: &Value, why: &[Value]) {
    copy_or_remove(mem, "selfCheckStep", f.get("steps").cloned());
    for why in why.iter().filter_map(Value::as_str) {
        match why {
            "errors" => copy_or_remove(mem, "selfCheckErrors", f.get("calls").cloned()),
            "stalled" => copy_or_remove(mem, "selfCheckStalled", mem.get("todoStep").cloned()),
            "unreflected" => mem["selfCheckAskedReflect"] = json!(true),
            "low-confidence" => {
                copy_or_remove(mem, "selfCheckLowAt", f["reflection"].get("step").cloned())
            }
            _ => {}
        }
    }
}

fn pct(v: Option<&Value>) -> String {
    format!("{}%", js(&json!(round(number(v) * 100.0))))
}

// Number#toFixed rounds the exact binary value, unlike Rust's tie-to-even
// decimal formatter. Costs have four places and values >= 1e21 use ToString.
fn fixed4(value: &Value) -> CoreResult<String> {
    let v = value
        .as_f64()
        .ok_or_else(|| invalid("cost.toFixed is not a function"))?;
    if v.abs() >= 1e21 {
        return Ok(js(value));
    }
    let negative = v < 0.0;
    let bits = v.abs().to_bits();
    let exponent_bits = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = (bits & ((1u64 << 52) - 1)) | if exponent_bits == 0 { 0 } else { 1u64 << 52 };
    let exponent = if exponent_bits == 0 {
        -1074
    } else {
        exponent_bits - 1023 - 52
    };
    let product = mantissa as u128 * 10_000;
    let rounded = if exponent >= 0 {
        product << exponent
    } else if -exponent >= 128 {
        0
    } else {
        let shift = -exponent as u32;
        let integral = product >> shift;
        let remainder = product & ((1u128 << shift) - 1);
        integral + u128::from(remainder >= 1u128 << (shift - 1))
    };
    Ok(format!(
        "{}{}.{:04}",
        if negative { "-" } else { "" },
        rounded / 10_000,
        rounded % 10_000
    ))
}

// Default en-US Number#toLocaleString: decimal notation, grouping, and at most
// three fractional places. Intl rounds the shortest decimal representation.
fn locale(v: Option<&Value>) -> CoreResult<String> {
    let v =
        v.ok_or_else(|| invalid("Cannot read properties of undefined (reading 'toLocaleString')"))?;
    if v.is_null() {
        return Err(invalid(
            "Cannot read properties of null (reading 'toLocaleString')",
        ));
    }
    if !v.is_number() {
        return Ok(js(v));
    }
    let source = js(v);
    let negative = source.starts_with('-');
    let source = source.strip_prefix('-').unwrap_or(&source);
    let (significand, exponent) = source
        .split_once('e')
        .map(|(a, b)| (a, b.parse::<i32>().unwrap_or(0)))
        .unwrap_or((source, 0));
    let point = significand.find('.').unwrap_or(significand.len()) as i32 + exponent;
    let raw: Vec<u8> = significand.bytes().filter(|b| *b != b'.').collect();
    let integer_len = point.max(1) as usize;
    let mut digits = Vec::with_capacity(integer_len + 3);
    for position in -(integer_len as i32)..3 {
        let index = point + position;
        digits.push(if index >= 0 {
            raw.get(index as usize).copied().unwrap_or(b'0')
        } else {
            b'0'
        });
    }
    let rounding_index = point + 3;
    if rounding_index >= 0 && raw.get(rounding_index as usize).is_some_and(|b| *b >= b'5') {
        let mut carry = true;
        for digit in digits.iter_mut().rev() {
            if *digit == b'9' {
                *digit = b'0';
            } else {
                *digit += 1;
                carry = false;
                break;
            }
        }
        if carry {
            digits.insert(0, b'1');
        }
    }
    let integer_len = digits.len() - 3;
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    for (index, digit) in digits[..integer_len].iter().enumerate() {
        if index > 0 && (integer_len - index) % 3 == 0 {
            out.push(',');
        }
        out.push(*digit as char);
    }
    let fraction = &digits[integer_len..];
    if let Some(end) = fraction.iter().rposition(|b| *b != b'0') {
        out.push('.');
        for digit in &fraction[..=end] {
            out.push(*digit as char);
        }
    }
    Ok(out)
}

fn render_self_check(f: &Value, why: &[Value], kind: &Value) -> CoreResult<String> {
    let model = if truth(f, "model") {
        format!(
            ", model {}{}",
            text(f, "model"),
            if truth(f, "escalated") {
                " (stronger model, after stalling)"
            } else {
                ""
            }
        )
    } else {
        String::new()
    };
    let cost = if truth(f, "cost") {
        format!(", cost so far ${}", fixed4(&f["cost"])?)
    } else {
        String::new()
    };
    let mut lines = vec![format!(
        "- Run: {} steps, {} min{model}{cost}.",
        text(f, "steps"),
        text(f, "minutes")
    )];
    if truth(f, "context") {
        let c = &f["context"];
        lines.push(format!("- Context: {} of the working budget ({} of {} tokens). Old tool results are cleared at 72%; the conversation is compacted at 80%.",pct(c.get("share")),locale(c.get("used"))?,locale(c.get("budget"))?));
    }
    let recent = if truth(f, "recentCalls") {
        format!(
            " ({} of the last {})",
            text(f, "recentErrors"),
            text(f, "recentCalls")
        )
    } else {
        String::new()
    };
    let repeated = if n(f, "variety") < 0.5 && n(f, "recentCalls") >= 6.0 {
        "; many calls repeat earlier ones"
    } else {
        ""
    };
    lines.push(format!(
        "- Tools: {} calls, {} failed{recent}{repeated}.",
        text(f, "calls"),
        text(f, "errors")
    ));
    if truth(f, "todo") {
        let todo = &f["todo"];
        let blocked = if truth(todo, "blocked") {
            format!(", {} blocked", text(todo, "blocked"))
        } else {
            String::new()
        };
        let stalled = if truth(todo, "open") && n(todo, "still") >= 5.0 {
            format!("; unchanged for {} steps", text(todo, "still"))
        } else {
            String::new()
        };
        lines.push(format!(
            "- Checklist: {}/{} done{blocked}{stalled}.",
            text(todo, "done"),
            text(todo, "total")
        ));
    }
    if truth(f, "reflection") {
        let r = &f["reflection"];
        let confidence = nullish(r.get("confidence"), json!("not given"));
        let assumptions = if strict_eq(r.get("assumptions"), Some(&json!(1))) {
            ""
        } else {
            "s"
        };
        let questions = if strict_eq(r.get("questions"), Some(&json!(1))) {
            ""
        } else {
            "s"
        };
        lines.push(format!("- Your reflect notes: confidence {}, {} unverified assumption{assumptions}, {} open question{questions}; updated {} steps ago.",js(&confidence),text(r,"assumptions"),text(r,"questions"),text(r,"age")));
    } else {
        lines.push("- Your reflect notes: none yet.".into());
    }
    let team = arr(f, "team");
    if !team.is_empty() {
        lines.push(format!(
            "- Work agents running: {}.",
            team.iter()
                .map(|v| if v.is_null() { String::new() } else { js(v) })
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    let questions = why.iter().filter_map(|v| match v.as_str() {
        Some("context") => Some("Context is filling up. Make sure the checklist and your reflect notes hold everything you would need after compaction (goal, verified results, open points)."),
        Some("errors") => Some("Several recent calls failed. Is your picture of the environment wrong (path, version, permissions, API)? Check the assumption behind the failing calls before trying again."),
        Some("stalled") => Some("The checklist has not moved for a while. Are you making real progress or circling? If the current approach is not working, change it, or report what blocks you."),
        Some("unreflected") => Some("You have done substantial work without stating your understanding. Write reflect notes: the task as you understand it, your plan, what is verified, what is only assumed, and your confidence."),
        Some("low-confidence") => Some("Your confidence is low. Find the cheapest check that would raise or lower it (read, run, open, search), or ask your requester if the decision is theirs."),
        Some("interval") => Some("Step back for a moment: does the work still serve the goal, and is the remaining plan the shortest path to it?"),
        _ => None,
    }).collect::<Vec<_>>().join(" ");
    let final_line = if kind == "main" {
        "Do not mention this check to the user; carry on with the conversation."
    } else {
        "Update reflect if your understanding, plan or confidence changed, then go on. There is nothing to answer here: text without tool calls ends the task, so write text only when it is your final report."
    };
    Ok(format!("[harness] Self-check (measured by the harness, not a message from the user):\n{}\n\n{questions}\n{final_line}",lines.join("\n")))
}

pub(super) fn render_reflection(r: &Value) -> String {
    if !js_value::truthy(r) {
        return String::new();
    }
    let mut lines = Vec::new();
    for (key, title) in [("understanding", "Understanding"), ("plan", "Plan")] {
        if truth(r, key) {
            lines.push(format!("{title}: {}", text(r, key)));
        }
    }
    for (key, title) in [
        ("verified", "Verified"),
        ("assumptions", "Assumed, not yet verified"),
        ("open_questions", "Open questions"),
    ] {
        let list = arr(r, key);
        if !list.is_empty() {
            lines.push(format!(
                "{title}:\n{}",
                list.iter()
                    .map(|v| format!("- {}", js(v)))
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }
    }
    if let Some(confidence) = r.get("confidence").filter(|v| !v.is_null()) {
        lines.push(format!("Confidence: {}", js(confidence)));
    }
    if truth(r, "next") {
        lines.push(format!("Next: {}", text(r, "next")));
    }
    lines.join("\n")
}

fn reflect(session: &Value, args: &Value, at: Option<&Value>) -> Value {
    let mut next = Map::new();
    spread(&mut next, &or(session.get("reflection"), json!({})));
    let mut entries = Map::new();
    spread(&mut entries, args);
    for (key, value) in entries {
        let clean = match value {
            Value::Array(values) => Value::Array(
                values
                    .iter()
                    .map(|value| one_line(Some(value), 300))
                    .filter(|value| !value.is_empty())
                    .map(Value::String)
                    .collect(),
            ),
            Value::String(_) => Value::String(one_line(Some(&value), 600)),
            other => other,
        };
        next.insert(key, clean);
    }
    next.insert("step".into(), or(session["stats"].get("steps"), json!(0)));
    if let Some(at) = at {
        next.insert("at".into(), at.clone());
    } else {
        next.remove("at");
    }
    let next = Value::Object(next);
    json!({"text":format!("Reflect notes updated.\n{}",render_reflection(&next)),"data":{"reflection":next}})
}

fn watch(session: &Value, mem: &mut Value) -> Vec<Value> {
    let calls = arr(mem, "calls");
    let Some(last) = calls.last().cloned() else {
        return Vec::new();
    };
    let same = calls
        .iter()
        .filter(|c| {
            strict_eq(c.get("sig"), last.get("sig"))
                && strict_eq(c.get("outcome"), last.get("outcome"))
        })
        .count();
    let mut actions = Vec::new();
    let key = format!("{}{}", text(&last, "sig"), text(&last, "outcome"));
    if same >= 3 && !arr(mem, "warned").iter().any(|v| v.as_str() == Some(&key)) {
        let mut warned = arr(mem, "warned").to_vec();
        warned.push(Value::String(key));
        mem["warned"] = Value::Array(warned);
        actions.push(json!({"kind":"notice","text":format!("[harness] You have run {} {same} times with the same result. Stop repeating it: re-read the goal and the latest results, then try a different approach or report what is blocking you.",text(&last,"label"))}));
    }
    if strict_eq(mem.get("errorStreak"), Some(&json!(5))) {
        actions.push(json!({"kind":"notice","text":"[harness] The last 5 tool calls failed. Step back: check your assumptions (paths, names, versions, permissions), read the errors carefully, and change the approach instead of retrying variations."}));
    }
    if strict_eq(mem.get("errorStreak"), Some(&json!(10))) || same == 6 {
        actions.push(json!({"kind":"escalate","reason":if n(mem,"errorStreak")>=10.0 {"repeated errors"} else {"repetition"}}));
    }
    mem["healthy"] = if !truth(&last, "error") && same < 2 {
        json!(n(mem, "healthy") + 1.0)
    } else {
        json!(0)
    };
    if n(mem, "healthy") >= 8.0 && session["role"] == "escalation" {
        mem["healthy"] = json!(0);
        actions.push(json!({"kind":"deescalate"}));
    }
    actions
}

fn self_check(p: &Value, session: &Value, mem: &mut Value) -> CoreResult<Vec<Value>> {
    if !js_value::truthy(session) || p.get("metacognition") == Some(&json!(false)) {
        return Ok(Vec::new());
    }
    let f = self_facts(p, session, mem);
    let why = self_check_due(session, mem, &f, None);
    if why.is_empty() {
        return Ok(Vec::new());
    }
    note_self_check(mem, &f, &why);
    let kind = session.get("kind").cloned().unwrap_or(json!("worker"));
    Ok(vec![
        json!({"kind":"notice","text":render_self_check(&f,&why,&kind)?,"selfCheck":why}),
        json!({"kind":"event","event":"self-check","data":{
            "why":why,"steps":f["steps"],
            "context":if truth(&f,"context") {json!(round(n(&f["context"],"share")*100.0))} else {Value::Null},
            "confidence":nullish(f["reflection"].get("confidence"),Value::Null)
        }}),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_trigger_bypasses_the_gap_and_remembers_even_without_note() {
        let p = json!({"session":{"kind":"worker"},"mem":{"selfCheckStep":4},"f":{"steps":5,"context":{"share":0.6},"recentCalls":6,"recentErrors":3,"calls":6}});
        let result = call("selfCheckDue", &p).unwrap();
        assert_eq!(result["why"], json!(["context", "errors"]));
        assert_eq!(result["mem"]["selfCheckContext"], true);
        let mut next = p;
        next["mem"] = result["mem"].clone();
        assert_eq!(call("selfCheckDue", &next).unwrap()["why"], json!([]));
    }

    #[test]
    fn absent_todo_step_does_not_trigger_stalled() {
        let p =
            json!({"session":{},"mem":{},"every":0,"f":{"steps":20,"todo":{"open":1,"still":20}}});
        assert_eq!(call("selfCheckDue", &p).unwrap()["why"], json!([]));
    }

    #[test]
    fn reflect_cleans_given_fields_and_keeps_the_others() {
        let p = json!({"session":{"stats":{"steps":12},"reflection":{"understanding":"keep me","assumptions":["old"],"at":"old"}},"args":{"assumptions":[" \n a  b ",null,false,{},""],"confidence":0,"next":" x\ty "},"at":"2026-10-07T00:00:00.000Z"});
        let result = call("reflect", &p).unwrap();
        assert_eq!(
            result["data"]["reflection"]["assumptions"],
            json!(["a b", "false", "[object Object]"])
        );
        assert_eq!(result["data"]["reflection"]["understanding"], "keep me");
        assert_eq!(result["data"]["reflection"]["step"], 12);
        assert!(result["text"]
            .as_str()
            .unwrap()
            .contains("Confidence: 0\nNext: x y"));
    }

    #[test]
    fn fixed_and_locale_match_javascript_rounding() {
        for (value, expected) in [
            (0.03125, "0.0313"),
            (-0.03125, "-0.0313"),
            (1.23445, "1.2345"),
            (0.0, "0.0000"),
            (-0.00001, "-0.0000"),
        ] {
            assert_eq!(fixed4(&json!(value)).unwrap(), expected);
        }
        for (value, expected) in [
            (1234.5, "1,234.5"),
            (1.2345, "1.235"),
            (0.0005, "0.001"),
            (999.9999, "1,000"),
            (1e21, "1,000,000,000,000,000,000,000"),
            (-0.0001, "-0"),
        ] {
            assert_eq!(locale(Some(&json!(value))).unwrap(), expected);
        }
    }

    #[test]
    fn reflection_preserves_lone_surrogates_and_literal_markers() {
        let p = json_codec::parse(r#"{"session":{},"args":{"next":"\ue000\ud800"},"at":"now"}"#)
            .unwrap();
        let result = call("reflect", &p).unwrap();
        let wire = json_codec::stringify(&result).unwrap();
        assert!(wire.contains("\\ud800"));
        assert_eq!(
            json_codec::utf16_units(result["data"]["reflection"]["next"].as_str().unwrap()),
            [0xe000, 0xd800]
        );
    }

    #[test]
    fn watch_emits_each_repetition_notice_once_and_deescalates_after_eight() {
        let call_data = json!({"sig":"s","outcome":"o","label":"read()","error":false});
        let p = json!({"session":{},"mem":{"calls":[call_data.clone(),call_data.clone(),call_data.clone()],"warned":[],"healthy":3,"errorStreak":0}});
        let first = call("watch", &p).unwrap();
        assert_eq!(first["actions"].as_array().unwrap().len(), 1);
        let second = call("watch", &json!({"session":{},"mem":first["mem"]})).unwrap();
        assert_eq!(second["actions"], json!([]));
        let healthy = call("watch",&json!({"session":{"role":"escalation"},"mem":{"calls":[call_data],"healthy":7,"warned":[]}})).unwrap();
        assert_eq!(healthy["actions"], json!([{"kind":"deescalate"}]));
        assert_eq!(healthy["mem"]["healthy"], 0);
    }
}
