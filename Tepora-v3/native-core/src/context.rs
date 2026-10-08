//! Pure request-context assembly over preloaded append-only session entries.
//!
//! The caller owns log retrieval; this module owns every byte of message
//! rendering, batch clear/checkpoint behavior, sequence repair and cache marks.
//! No persisted transcript entry is rewritten by a clear or a repair.
use super::{invalid, js_value::js_string, json_codec, tokens, truthy, CoreResult};
use serde_json::{json, Map, Value};

const LONG_ARG_CHARS: usize = 400;

fn array_field<'a>(value: &'a Value, key: &str) -> CoreResult<&'a Vec<Value>> {
    value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid(format!("{key} must be an array")))
}
fn text(value: &Value, key: &str) -> String {
    js_string(value.get(key))
}
fn present(value: &Value, key: &str) -> bool {
    value.get(key).is_some_and(truthy)
}
fn kind(value: &Value) -> &str {
    value.get("type").and_then(Value::as_str).unwrap_or("")
}
fn number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(value)) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(value)) => value.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() {
                0.0
            } else {
                value.parse().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}
fn images(entry: &Value) -> &[Value] {
    entry
        .get("images")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}
fn role_message(role: &str, content: Option<Value>) -> Value {
    let mut message = Map::new();
    message.insert("role".into(), json!(role));
    if let Some(content) = content {
        message.insert("content".into(), content);
    }
    Value::Object(message)
}
fn header(entry: &Value, separator: &str) -> String {
    if present(entry, "header") {
        format!("{}{separator}", text(entry, "header"))
    } else {
        String::new()
    }
}
fn grouped(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}
fn whitespace(ch: char) -> bool {
    // ECMAScript \s, deliberately excluding Rust's U+0085 whitespace.
    matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' |
        '\u{3000}' | '\u{feff}')
}
fn one_line(value: Option<&Value>, max: usize) -> String {
    let text = value
        .filter(|value| !value.is_null())
        .map(|value| js_string(Some(value)))
        .unwrap_or_default();
    let mut out = String::new();
    let mut space = false;
    for ch in text.chars() {
        if whitespace(ch) {
            if !out.is_empty() {
                space = true;
            }
        } else {
            if space {
                out.push(' ');
                space = false;
            }
            out.push(ch);
        }
    }
    let units = json_codec::utf16_units(&out);
    if units.len() > max {
        format!(
            "{}…",
            json_codec::from_utf16_units(&units[..max.saturating_sub(1)])
        )
    } else {
        out
    }
}

pub(crate) fn stub_text(entry: &Value) -> String {
    let name = if present(entry, "stub") {
        text(entry, "stub")
    } else {
        text(entry, "name")
    };
    let n = images(entry).len();
    let suffix = if n > 0 {
        format!(" ({n} image{})", if n > 1 { "s" } else { "" })
    } else {
        String::new()
    };
    format!(
        "[result cleared to save context: {name}{suffix} — recall(\"#{}\") reads it in full]",
        text(entry, "seq")
    )
}
pub(crate) fn report_stub(entry: &Value) -> String {
    let title = if present(entry, "title") {
        text(entry, "title")
    } else if present(entry, "from") {
        text(entry, "from")
    } else {
        String::new()
    };
    format!("{}[report from \"{title}\" cleared to save context. It began: {} — recall(\"#{}\") reads it in full]",
        header(entry, "\n"), one_line(entry.get("text"), 200), text(entry, "seq"))
}

pub(crate) fn shrink_value(value: &Value, reference: &str) -> Value {
    match value {
        Value::String(value) => {
            let units = json_codec::utf16_units(value);
            if units.len() > LONG_ARG_CHARS {
                json!(format!("{}… [{} characters omitted from this old call; recall(\"{reference}\") shows it]",
                    json_codec::from_utf16_units(&units[..120]), grouped(units.len())))
            } else {
                Value::String(value.clone())
            }
        }
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| shrink_value(value, reference))
                .collect(),
        ),
        Value::Object(values) => {
            let mut result = Map::new();
            for (key, value) in values {
                // In the source `const o={}; o[k]=...`, __proto__ uses the
                // inherited setter and never becomes an own enumerable key.
                if key != "__proto__" {
                    result.insert(key.clone(), shrink_value(value, reference));
                }
            }
            Value::Object(result)
        }
        _ => value.clone(),
    }
}
pub(crate) fn shrink_args(value: &Value, reference: &str) -> Value {
    let Some(text) = value.as_str() else {
        return value.clone();
    };
    if json_codec::utf16_units(text).len() <= LONG_ARG_CHARS {
        return value.clone();
    }
    // text itself is an encoded JavaScript string containing JSON. Decode the
    // marker through the codec, without replacing isolated UTF-16 units. Those
    // units are legal in JSON string contents and must survive a parse/stringify.
    match json_codec::parse_js_text(text) {
        Ok(value) if value.is_object() || value.is_array() => {
            match json_codec::stringify_js(&shrink_value(&value, reference)) {
                Ok(text) => Value::String(json_codec::encode_text(&text)),
                Err(_) => Value::String(text.into()),
            }
        }
        _ => Value::String(text.into()),
    }
}

fn shrink_native(native: &Value, reference: &str) -> CoreResult<Value> {
    let mut out = native.clone();
    let items = array_field(native, "items")?;
    let mut shrunk = Vec::with_capacity(items.len());
    for item in items {
        let mut next = item.clone();
        if kind(item) == "tool_use" && present(item, "input") {
            next["input"] = shrink_value(&item["input"], reference);
        } else if kind(item) == "function_call"
            && item.get("arguments").is_some_and(Value::is_string)
        {
            next["arguments"] = shrink_args(&item["arguments"], reference);
        } else if item
            .get("functionCall")
            .is_some_and(|call| present(call, "args"))
        {
            next["functionCall"]["args"] = shrink_value(&item["functionCall"]["args"], reference);
        }
        shrunk.push(next);
    }
    out["items"] = Value::Array(shrunk);
    Ok(out)
}

fn image_part(image: &Value) -> Value {
    json!({"type":"image_url","image_url":{"url":format!("data:{};base64,{}", text(image,"mime"), text(image,"base64"))}})
}
fn image_note(images: &[Value], why: &str) -> String {
    let names = images
        .iter()
        .map(|image| {
            if present(image, "name") {
                text(image, "name")
            } else {
                format!("{}×{}", text(image, "width"), text(image, "height"))
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "[{} image{} ({names}) not shown: {why}]",
        images.len(),
        if images.len() > 1 { "s" } else { "" }
    )
}
fn input_message(entry: &Value, vision: bool) -> Value {
    let content = if present(entry, "header") {
        Some(json!(format!(
            "{}{}",
            header(entry, "\n"),
            text(entry, "text")
        )))
    } else {
        entry.get("text").cloned()
    };
    let pictures = images(entry);
    if pictures.is_empty() {
        return role_message("user", content);
    }
    if !vision {
        return role_message(
            "user",
            Some(json!(format!(
                "{}\n{}",
                js_string(content.as_ref()),
                image_note(
                    pictures,
                    "this model cannot see images; a work agent can describe them"
                )
            ))),
        );
    }
    let mut part = Map::new();
    part.insert("type".into(), json!("text"));
    if let Some(content) = content {
        part.insert("text".into(), content);
    }
    let mut parts = vec![Value::Object(part)];
    parts.extend(pictures.iter().map(image_part));
    role_message("user", Some(Value::Array(parts)))
}

pub(crate) fn view(checkpoint: Option<&Value>, all: &[Value]) -> Value {
    let checkpoint = checkpoint.filter(|value| truthy(value));
    let from = checkpoint
        .map(|value| number(value.get("upTo")) + 1.0)
        .unwrap_or(1.0);
    let after = checkpoint
        .and_then(|value| value.get("upTo"))
        .filter(|value| truthy(value))
        .map(|value| number(Some(value)))
        .unwrap_or(0.0);
    let live: Vec<_> = all
        .iter()
        .filter(|entry| number(entry.get("seq")) >= from)
        .collect();
    let clear_up_to =
        live.iter()
            .filter(|entry| kind(entry) == "clear")
            .fold(0.0_f64, |n, entry| {
                let next = number(entry.get("upTo"));
                if n.is_nan() || next.is_nan() {
                    f64::NAN
                } else {
                    n.max(next)
                }
            });
    let entries: Vec<_> = live
        .into_iter()
        .filter(|entry| {
            matches!(kind(entry), "input" | "notice" | "assistant" | "tool")
                && number(entry.get("seq")) > after
        })
        .cloned()
        .collect();
    json!({"checkpoint":checkpoint.cloned().unwrap_or(Value::Null),"entries":entries,"clearUpTo":clear_up_to})
}

fn latest_ephemeral(entries: &[Value]) -> Vec<(Value, Value)> {
    let mut latest: Vec<(Value, Value)> = Vec::new();
    for entry in entries {
        if kind(entry) == "tool" && present(entry, "ephemeralKey") {
            let key = &entry["ephemeralKey"];
            if let Some(previous) = latest.iter_mut().find(|(k, _)| k == key) {
                previous.1 = entry.get("seq").cloned().unwrap_or(Value::Null);
            } else {
                latest.push((
                    key.clone(),
                    entry.get("seq").cloned().unwrap_or(Value::Null),
                ));
            }
        }
    }
    latest
}
fn is_cleared(entry: &Value, clear_up_to: f64, latest: &[(Value, Value)]) -> bool {
    let old = number(entry.get("seq")) <= clear_up_to;
    if kind(entry) == "input"
        && matches!(
            entry.get("kind").and_then(Value::as_str),
            Some("report" | "heartbeat")
        )
    {
        return old;
    }
    if kind(entry) != "tool" {
        return false;
    }
    let ephemeral = present(entry, "ephemeralKey");
    let superseded = ephemeral
        && latest
            .iter()
            .find(|(key, _)| Some(key) == entry.get("ephemeralKey"))
            .map(|(_, seq)| Some(seq) != entry.get("seq"))
            .unwrap_or(true);
    if ephemeral && !superseded {
        return false;
    }
    old && (superseded || !present(entry, "keep"))
}
fn rendered(entry: &Value, message: Value, estimator: tokens::Estimator) -> Value {
    let tokens = estimator.message_tokens(&message);
    json!({"entry":entry,"message":message,"tokens":tokens})
}
fn flush_images(pending: &mut Vec<Value>, out: &mut Vec<Value>, estimator: tokens::Estimator) {
    for entry in pending.drain(..) {
        let pictures = images(&entry);
        let mut parts = vec![
            json!({"type":"text","text":format!("[image{} returned by {} #{}]",
            if pictures.len() > 1 { "s" } else { "" }, text(&entry,"name"), text(&entry,"seq"))}),
        ];
        parts.extend(pictures.iter().map(image_part));
        out.push(rendered(
            &entry,
            role_message("user", Some(Value::Array(parts))),
            estimator,
        ));
    }
}

fn render_entries_with(
    view: &Value,
    clear_up_to: Option<&Value>,
    vision: bool,
    estimator: tokens::Estimator,
) -> CoreResult<Vec<Value>> {
    let entries = array_field(view, "entries")?;
    let latest = latest_ephemeral(entries);
    let clear_up_to = number(clear_up_to.or_else(|| view.get("clearUpTo")));
    let mut out = Vec::new();
    let mut pending = Vec::new();
    for entry in entries {
        if kind(entry) != "tool" {
            flush_images(&mut pending, &mut out, estimator);
        }
        let message = match kind(entry) {
            "input" => {
                if is_cleared(entry, clear_up_to, &latest) {
                    role_message(
                        "user",
                        Some(json!(
                            if entry.get("kind").and_then(Value::as_str) == Some("report") {
                                report_stub(entry)
                            } else {
                                format!("{}[check-in cleared]", header(entry, " "))
                            }
                        )),
                    )
                } else {
                    input_message(entry, vision)
                }
            }
            "notice" => role_message("user", entry.get("text").cloned()),
            "assistant" => {
                let old = number(entry.get("seq")) <= clear_up_to;
                let reference = format!("#{}", text(entry, "seq"));
                let mut message = role_message(
                    "assistant",
                    Some(
                        entry
                            .get("content")
                            .filter(|value| truthy(value))
                            .cloned()
                            .unwrap_or(Value::Null),
                    ),
                );
                if let Some(calls) = entry
                    .get("toolCalls")
                    .and_then(Value::as_array)
                    .filter(|calls| !calls.is_empty())
                {
                    let mut tools = Vec::new();
                    for call in calls {
                        let mut function = Map::new();
                        if let Some(name) = call.get("name") {
                            function.insert("name".into(), name.clone());
                        }
                        if let Some(args) = call.get("arguments") {
                            function.insert(
                                "arguments".into(),
                                if old {
                                    shrink_args(args, &reference)
                                } else {
                                    args.clone()
                                },
                            );
                        }
                        let mut tool = Map::new();
                        if let Some(id) = call.get("id") {
                            tool.insert("id".into(), id.clone());
                        }
                        tool.insert("type".into(), json!("function"));
                        tool.insert("function".into(), Value::Object(function));
                        tools.push(Value::Object(tool));
                    }
                    message["tool_calls"] = Value::Array(tools);
                }
                if let Some(native) = entry.get("native").filter(|value| truthy(value)) {
                    message["_native"] = if old {
                        shrink_native(native, &reference)?
                    } else {
                        native.clone()
                    };
                }
                message
            }
            _ => {
                let cleared = is_cleared(entry, clear_up_to, &latest);
                let mut message = Map::new();
                message.insert("role".into(), json!("tool"));
                if let Some(id) = entry.get("callId") {
                    message.insert("tool_call_id".into(), id.clone());
                }
                if cleared {
                    message.insert("content".into(), json!(stub_text(entry)));
                } else if !images(entry).is_empty() && !vision {
                    message.insert(
                        "content".into(),
                        json!(format!(
                            "{}\n{}",
                            text(entry, "content"),
                            image_note(images(entry), "this model cannot see images")
                        )),
                    );
                } else if let Some(content) = entry.get("content") {
                    message.insert("content".into(), content.clone());
                }
                if !cleared && vision && !images(entry).is_empty() {
                    pending.push(entry.clone());
                }
                Value::Object(message)
            }
        };
        out.push(rendered(entry, message, estimator));
    }
    flush_images(&mut pending, &mut out, estimator);
    Ok(out)
}

pub(crate) fn repair_sequence(messages: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    // Option distinguishes an absent JS field from a present null ID.
    let mut open: Vec<Option<Value>> = Vec::new();
    let close = |out: &mut Vec<Value>, open: &mut Vec<Option<Value>>| {
        for id in open.drain(..) {
            let mut message = Map::new();
            message.insert("role".into(), json!("tool"));
            if let Some(id) = id {
                message.insert("tool_call_id".into(), id);
            }
            message.insert(
                "content".into(),
                json!("(no result was recorded for this call)"),
            );
            out.push(Value::Object(message));
        }
    };
    for message in messages {
        let role = message.get("role").and_then(Value::as_str);
        if role == Some("tool") {
            if let Some(index) = open
                .iter()
                .position(|id| id.as_ref() == message.get("tool_call_id"))
            {
                open.remove(index);
                out.push(message.clone());
            }
            continue;
        }
        close(&mut out, &mut open);
        out.push(message.clone());
        if role == Some("assistant") {
            if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let id = call.get("id").cloned();
                    if !open.contains(&id) {
                        open.push(id);
                    }
                }
            }
        }
    }
    close(&mut out, &mut open);
    out
}

pub(crate) fn build(payload: &Value) -> CoreResult<Value> {
    let view = payload
        .get("view")
        .ok_or_else(|| invalid("view is required"))?;
    let vision = payload.get("vision").map(truthy).unwrap_or(true);
    let estimator = tokens::Estimator::from_payload(payload);
    let rendered = render_entries_with(view, payload.get("clearUpTo"), vision, estimator)?;
    let mut messages = vec![role_message("system", payload.get("system").cloned())];
    let checkpoint = view.get("checkpoint").filter(|value| truthy(value));
    if let Some(checkpoint) = checkpoint {
        let mut message = role_message("user", checkpoint.get("text").cloned());
        message["cache"] = json!(true);
        messages.push(message);
    }
    let first = messages.len();
    messages.extend(repair_sequence(
        &rendered
            .iter()
            .map(|r| r["message"].clone())
            .collect::<Vec<_>>(),
    ));
    if let Some(last_assistant) = messages
        .iter()
        .rposition(|m| m.get("role").and_then(Value::as_str) == Some("assistant"))
    {
        if last_assistant > first
            && messages[last_assistant - 1]
                .get("role")
                .and_then(Value::as_str)
                != Some("assistant")
        {
            messages[last_assistant - 1]["cache"] = json!(true);
        }
    }
    if messages.len() > 1 {
        messages.last_mut().unwrap()["cache"] = json!(true);
    }
    let count = estimator.messages_tokens(&messages);
    let checkpoint_tokens = checkpoint
        .map(|c| estimator.raw_tokens(c.get("text")))
        .unwrap_or(0);
    Ok(
        json!({"messages":messages,"tokens":count,"view":view,"rendered":rendered,"vision":payload.get("vision").cloned().unwrap_or(json!(true)),"checkpointTokens":checkpoint_tokens}),
    )
}

pub(crate) fn call(op: &str, payload: Value) -> CoreResult<Value> {
    Ok(match op {
        "context.view" => view(payload.get("checkpoint"), array_field(&payload, "entries")?),
        "context.renderEntries" => Value::Array(render_entries_with(
            payload
                .get("view")
                .ok_or_else(|| invalid("view is required"))?,
            payload.get("clearUpTo"),
            payload.get("vision").map(truthy).unwrap_or(true),
            tokens::Estimator::from_payload(&payload),
        )?),
        "context.build" => return build(&payload),
        "context.repairSequence" => {
            Value::Array(repair_sequence(array_field(&payload, "messages")?))
        }
        "context.shrinkValue" => shrink_value(
            payload.get("value").unwrap_or(&Value::Null),
            &text(&payload, "ref"),
        ),
        "context.shrinkArgs" => shrink_args(
            payload.get("json").unwrap_or(&Value::Null),
            &text(&payload, "ref"),
        ),
        "context.stubText" => json!(stub_text(
            payload
                .get("entry")
                .ok_or_else(|| invalid("entry is required"))?
        )),
        "context.reportStub" => json!(report_stub(
            payload
                .get("entry")
                .ok_or_else(|| invalid("entry is required"))?
        )),
        "context.isCleared" => {
            let entry = payload
                .get("entry")
                .ok_or_else(|| invalid("entry is required"))?;
            let view = payload
                .get("view")
                .ok_or_else(|| invalid("view is required"))?;
            let latest = if let Some(values) = payload.get("latest").and_then(Value::as_array) {
                values
                    .iter()
                    .filter_map(|pair| Some((pair.get(0)?.clone(), pair.get(1)?.clone())))
                    .collect()
            } else {
                latest_ephemeral(array_field(view, "entries")?)
            };
            json!(is_cleared(entry, number(view.get("clearUpTo")), &latest))
        }
        _ => return Err(invalid(format!("unknown context operation: {op}"))),
    })
}

#[cfg(test)]
fn render_entries(
    view: &Value,
    clear_up_to: Option<&Value>,
    vision: bool,
) -> CoreResult<Vec<Value>> {
    render_entries_with(view, clear_up_to, vision, tokens::Estimator::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(entries: Vec<Value>, clear: u64) -> Value {
        json!({"checkpoint":null,"entries":entries,"clearUpTo":clear})
    }
    fn messages(rendered: &[Value]) -> Vec<Value> {
        rendered.iter().map(|r| r["message"].clone()).collect()
    }
    fn picture() -> Value {
        json!({"name":"pic.png","mime":"image/png","width":1,"height":1,
            "base64":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"})
    }

    #[test]
    fn repair_closes_missing_results_and_discards_orphans_and_duplicates() {
        let input = json!([
            {"role":"tool","tool_call_id":"orphan","content":"not sent"},
            {"role":"assistant","content":null,"tool_calls":[{"id":"b"},{"id":"a"},{"id":"b"}]},
            {"role":"tool","tool_call_id":"a","content":"ok"},
            {"role":"tool","tool_call_id":"a","content":"duplicate"},
            {"role":"user","content":"continue"},
            {"role":"tool","tool_call_id":"b","content":"too late"},
            {"role":"assistant","content":null,"tool_calls":[{"id":"c"}]}
        ]);
        let result = repair_sequence(input.as_array().unwrap());
        assert_eq!(result.len(), 6);
        assert_eq!(result[1]["content"], "ok");
        assert_eq!(
            result[2],
            json!({"role":"tool","tool_call_id":"b","content":"(no result was recorded for this call)"})
        );
        assert_eq!(result[3]["role"], "user");
        assert_eq!(result[5]["tool_call_id"], "c");
        assert_eq!(
            input[0]["content"], "not sent",
            "repair never mutates stored entries"
        );
    }

    #[test]
    fn view_starts_after_checkpoint_and_applies_only_live_clear_watermarks() {
        let checkpoint = json!({"seq":11,"type":"checkpoint","upTo":7,"text":"summary"});
        let result = view(
            Some(&checkpoint),
            &[
                json!({"seq":1,"type":"clear","upTo":100}),
                json!({"seq":7,"type":"input","text":"old"}),
                json!({"seq":8,"type":"input","text":"new"}),
                json!({"seq":9,"type":"clear","upTo":8}),
                json!({"seq":10,"type":"event"}),
                checkpoint.clone(),
                json!({"seq":12,"type":"notice","text":"notice"}),
            ],
        );
        assert_eq!(result["checkpoint"], checkpoint);
        assert_eq!(result["clearUpTo"].as_f64(), Some(8.0));
        assert_eq!(
            result["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e["seq"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            [8, 12]
        );
    }

    #[test]
    fn clear_batches_keep_small_results_and_current_ephemeral_state() {
        let view = live(
            vec![
                json!({"seq":1,"type":"input","kind":"task","text":"original task"}),
                json!({"seq":2,"type":"tool","callId":"a","name":"read","content":"small","keep":true}),
                json!({"seq":3,"type":"tool","callId":"b","name":"todo","content":"old state","ephemeralKey":"todo","keep":true}),
                json!({"seq":4,"type":"tool","callId":"c","name":"todo","content":"new state","ephemeralKey":"todo"}),
                json!({"seq":5,"type":"tool","callId":"d","name":"read","content":"large","stub":"read notes"}),
                json!({"seq":6,"type":"input","kind":"heartbeat","header":"[idle]","text":"wake"}),
                json!({"seq":7,"type":"input","kind":"report","header":"[worker]","title":"Review","text":"  ready\n now\t! "}),
                json!({"seq":8,"type":"input","kind":"message","text":"new instruction"}),
            ],
            8,
        );
        let result = messages(&render_entries(&view, None, true).unwrap());
        assert_eq!(result[0]["content"], "original task");
        assert_eq!(result[1]["content"], "small");
        assert_eq!(
            result[2]["content"],
            "[result cleared to save context: todo — recall(\"#3\") reads it in full]"
        );
        assert_eq!(result[3]["content"], "new state");
        assert!(result[4]["content"]
            .as_str()
            .unwrap()
            .contains("read notes"));
        assert_eq!(result[5]["content"], "[idle] [check-in cleared]");
        assert_eq!(result[6]["content"], "[worker]\n[report from \"Review\" cleared to save context. It began: ready now ! — recall(\"#7\") reads it in full]");
        assert_eq!(result[7]["content"], "new instruction");
        let original = render_entries(&view, Some(&json!(0)), true).unwrap();
        assert_eq!(original[2]["message"]["content"], "old state");
    }

    #[test]
    fn images_follow_every_tool_result_and_have_blind_model_notes() {
        let view = live(
            vec![
                json!({"seq":1,"type":"input","header":"[user]","text":"Look","images":[picture()]}),
                json!({"seq":2,"type":"assistant","toolCalls":[{"id":"a","name":"read","arguments":"{}"},{"id":"b","name":"read","arguments":"{}"}]}),
                json!({"seq":3,"type":"tool","callId":"a","name":"read","content":"picture","images":[picture()]}),
                json!({"seq":4,"type":"tool","callId":"b","name":"read","content":"notes"}),
                json!({"seq":5,"type":"notice","text":"next"}),
            ],
            0,
        );
        let rendered = render_entries(&view, None, true).unwrap();
        let result = messages(&rendered);
        assert_eq!(
            result
                .iter()
                .map(|m| m["role"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["user", "assistant", "tool", "tool", "user", "user"]
        );
        assert_eq!(result[0]["content"][0]["text"], "[user]\nLook");
        assert_eq!(
            result[4]["content"][0]["text"],
            "[image returned by read #3]"
        );
        assert_eq!(rendered[4]["entry"]["seq"], 3);
        assert_eq!(
            rendered[4]["tokens"].as_u64().unwrap(),
            4 + tokens::raw_text_tokens("[image returned by read #3]") + 85
        );
        let blind = messages(&render_entries(&view, None, false).unwrap());
        assert_eq!(blind.len(), 5);
        assert_eq!(blind[0]["content"], "[user]\nLook\n[1 image (pic.png) not shown: this model cannot see images; a work agent can describe them]");
        assert_eq!(
            blind[2]["content"],
            "picture\n[1 image (pic.png) not shown: this model cannot see images]"
        );
        let cleared = messages(&render_entries(&view, Some(&json!(4)), true).unwrap());
        assert_eq!(cleared.len(), 5);
        assert!(cleared[2]["content"]
            .as_str()
            .unwrap()
            .contains("(1 image)"));
    }

    #[test]
    fn old_arguments_shrink_recursively_preserving_provider_native_identity() {
        let long = "x".repeat(1201);
        let args =
            json!({"path":"/tmp/result","content":long,"nested":[{"body":long}],"short":"ok"});
        let native = json!({"provider":"anthropic","identity":"route/model","responseId":"resp_12","items":[
            {"type":"thinking","signature":"sig","thinking":long},
            {"type":"tool_use","id":"a","name":"write","input":args},
            {"type":"function_call","id":"fc_12","call_id":"b","arguments":json_codec::stringify_js(&args).unwrap()},
            {"functionCall":{"name":"write","args":args},"thoughtSignature":"untouched"},
            {"type":"message","id":"msg_12","content":[{"text":long}]}
        ]});
        let entry = json!({"seq":9,"type":"assistant","content":"","toolCalls":[
            {"id":"a","name":"write","arguments":json_codec::stringify_js(&args).unwrap()}],"native":native});
        let view = live(vec![entry.clone()], 9);
        let result = render_entries(&view, None, true).unwrap();
        let message = &result[0]["message"];
        assert_eq!(message["content"], Value::Null);
        let reduced = json_codec::parse_js_text(
            message["tool_calls"][0]["function"]["arguments"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert!(reduced["content"]
            .as_str()
            .unwrap()
            .contains("1,201 characters omitted"));
        assert!(reduced["nested"][0]["body"]
            .as_str()
            .unwrap()
            .contains("recall(\"#9\")"));
        assert_eq!(reduced["path"], "/tmp/result");
        let replay = &message["_native"];
        assert_eq!(replay["identity"], native["identity"]);
        assert_eq!(replay["responseId"], "resp_12");
        assert_eq!(replay["items"][0], native["items"][0]);
        assert_eq!(replay["items"][1]["id"], "a");
        assert_eq!(replay["items"][1]["input"], reduced);
        assert_eq!(replay["items"][2]["id"], "fc_12");
        assert_eq!(replay["items"][2]["call_id"], "b");
        assert_eq!(replay["items"][3]["thoughtSignature"], "untouched");
        assert_eq!(replay["items"][3]["functionCall"]["args"], reduced);
        assert_eq!(replay["items"][4], native["items"][4]);
        assert_eq!(result[0]["entry"], entry);
    }

    #[test]
    fn shrinking_uses_utf16_and_does_not_repair_invalid_or_scalar_json() {
        let value = json_codec::parse(&format!(
            "\"{}😀{}\\udfff\\ue000\"",
            "a".repeat(119),
            "b".repeat(300)
        ))
        .unwrap();
        let shrunk = shrink_value(&value, "#2");
        let wire = json_codec::stringify_js(&shrunk).unwrap();
        assert!(wire.contains("\\ud83d… [423 characters omitted"), "{wire}");
        for value in [
            json!("{".repeat(401)),
            json!(format!("\"{}\"", "a".repeat(401))),
            json!(false),
            json!(null),
        ] {
            assert_eq!(shrink_args(&value, "#3"), value);
        }
        let payload = json_codec::parse(&format!(
            "{{\"text\":\"{}\\ue000\\ud800\",\"short\":\"\\ue000\\udc00\"}}",
            "a".repeat(500)
        ))
        .unwrap();
        let source = json!(json_codec::encode_text(
            &json_codec::stringify_js(&payload).unwrap()
        ));
        let shrunk = shrink_args(&source, "#3");
        let parsed = json_codec::parse_js_text(shrunk.as_str().unwrap()).unwrap();
        assert_eq!(parsed["short"], payload["short"]);
        assert!(parsed["text"]
            .as_str()
            .unwrap()
            .contains("502 characters omitted"));
        let proto = json_codec::parse(r#"{"__proto__":{"secret":1},"normal":"yes"}"#).unwrap();
        assert_eq!(shrink_value(&proto, "#3"), json!({"normal":"yes"}));
    }

    #[test]
    fn request_and_entry_costs_use_the_same_explicit_unicode_version() {
        let text = "\u{323b0}".repeat(4);
        let mut view = live(vec![json!({"seq":1,"type":"input","text":text})], 0);
        view["checkpoint"] = json!({"upTo":0,"text":text});
        let old = build(&json!({"view":view,"system":text,"unicodeVersion":"16.0"})).unwrap();
        let new = build(&json!({"view":view,"system":text,"unicodeVersion":"17.0"})).unwrap();
        assert_eq!(old["tokens"], 21);
        assert_eq!(new["tokens"], 30);
        assert_eq!(old["rendered"][0]["tokens"], 7);
        assert_eq!(new["rendered"][0]["tokens"], 10);
        assert_eq!(old["checkpointTokens"], 3);
        assert_eq!(new["checkpointTokens"], 6);
        assert_eq!(old["messages"], new["messages"]);
    }

    #[test]
    fn checkpoint_and_previous_request_cache_breakpoints_remain_stable() {
        let mut view = live(
            vec![
                json!({"seq":6,"type":"input","text":"task"}),
                json!({"seq":7,"type":"assistant","content":"first","toolCalls":[{"id":"a","name":"read","arguments":"{}"}]}),
                json!({"seq":8,"type":"tool","callId":"a","name":"read","content":"result"}),
                json!({"seq":9,"type":"assistant","content":"second","toolCalls":[{"id":"b","name":"read","arguments":"{}"}]}),
            ],
            0,
        );
        view["checkpoint"] = json!({"upTo":5,"text":"summary","nativeIdentity":"retained"});
        let built = build(&json!({"view":view,"system":"system"})).unwrap();
        let msgs = built["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 7);
        assert_eq!(msgs[0], json!({"role":"system","content":"system"}));
        assert_eq!(
            msgs[1],
            json!({"role":"user","content":"summary","cache":true})
        );
        assert_eq!(msgs[4]["content"], "result");
        assert_eq!(msgs[4]["cache"], true);
        assert_eq!(msgs[6]["tool_call_id"], "b");
        assert_eq!(msgs[6]["cache"], true);
        assert!(msgs[2].get("cache").is_none());
        assert_eq!(
            built["checkpointTokens"],
            tokens::raw_text_tokens("summary")
        );
        assert_eq!(built["tokens"], tokens::messages_tokens(msgs));
        assert_eq!(built["view"], view);
        assert_eq!(built["rendered"].as_array().unwrap().len(), 4);
        assert!(built["rendered"][2]["message"].get("cache").is_none());
        let empty = build(&json!({"view":live(vec![],0),"system":"only"})).unwrap();
        assert!(empty["messages"][0].get("cache").is_none());
    }
}
