//! Pure ordered tool-receipt planning. This ports AgentLoop.record, not its loop
//! or durable state owner. The actor applies evidence, entries, stats and memory
//! together; a plan alone must not advance ephemeral memory or read references.
use super::EffectError;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tepora_core::{
    js_value::{js_string, truthy},
    json_codec::{self, from_utf16_units, sql_text, stringify_js, utf16_units},
};

#[derive(Clone, Debug)]
pub struct ReceiptPlan {
    pub seq: u64,
    /// Append with type="tool". Owner supplies the session and timestamp.
    pub body: Value,
    /// evidence.put document, without its owner-supplied timestamp.
    pub evidence: Option<Value>,
    /// After commit: FileMemory::record_read(seq, read_result). This is the
    /// actual read's data, including results that settled during cancellation.
    pub read_result: Option<Value>,
}
#[derive(Clone, Debug)]
pub struct ReceiptBatch {
    pub receipts: Vec<ReceiptPlan>,
    pub stats: Value,
    /// Copy of the input loop/metacognition memory with only record's fields
    /// changed. File/read-reference memory is separately owned by FileMemory.
    pub memory: Value,
}

/// `definitions` maps immutable definitionKey or final tool name to metadata.
/// Supported builtin metadata uses ephemeral/ephemeralKey. A future host may pass
/// a precomputed `stub` string; callbacks are never executed by this pure helper.
/// Calls/outputs must already be in original model order (ExecutionEngine owns
/// that ordering). `first_seq` is the owner's next transcript sequence.
pub fn plan_receipts(
    session: &Value,
    calls: &[Value],
    outputs: &[Value],
    budget: f64,
    definitions: &Value,
    memory: &Value,
    first_seq: u64,
) -> Result<ReceiptBatch, EffectError> {
    plan_receipts_with_unicode(
        session,
        calls,
        outputs,
        budget,
        definitions,
        memory,
        first_seq,
        16,
    )
}

/// Version-aware host entry point. Use the same Unicode version as the host's
/// context/budget estimator. The compatibility wrapper above keeps Node 22's
/// Unicode 16 default for frozen source fixtures and existing callers.
pub fn plan_receipts_with_unicode(
    session: &Value,
    calls: &[Value],
    outputs: &[Value],
    budget: f64,
    definitions: &Value,
    memory: &Value,
    first_seq: u64,
    unicode_version: u32,
) -> Result<ReceiptBatch, EffectError> {
    if calls.len() != outputs.len() {
        return Err(EffectError::new(
            "Tool receipt call/output counts do not match",
        ));
    }
    let mut stats = session
        .get("stats")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or(json!({}));
    let mut memory = memory
        .as_object()
        .cloned()
        .map(Value::Object)
        .unwrap_or(json!({}));
    if !memory["calls"].is_array() {
        memory["calls"] = json!([]);
    }
    if memory.get("errorStreak").is_none() {
        memory["errorStreak"] = json!(0);
    }
    let mut receipts = Vec::with_capacity(calls.len());
    let id = js_string(session.get("id"));
    for (index, (call, out)) in calls.iter().zip(outputs).enumerate() {
        let seq = first_seq
            .checked_add(index as u64)
            .ok_or_else(|| EffectError::new("Tool receipt sequence overflow"))?;
        let reference = format!("#{seq}");
        let name_value = out
            .get("name")
            .filter(|v| truthy(v))
            .or_else(|| call.get("name"));
        let name = js_string(name_value);
        let args = out.get("args");
        let result = out.get("result");
        let has_error = out.get("error").is_some_and(truthy);
        let def = out
            .get("definitionKey")
            .and_then(Value::as_str)
            .and_then(|key| definitions.get(key))
            .or_else(|| definitions.get(&name));
        let mut text = if has_error {
            format!("Error: {}", js_string(out.get("error")))
        } else {
            let value = result
                .and_then(|r| r.get("text"))
                .filter(|v| !v.is_null())
                .or(result);
            let payload = value.map(|v| json!({"result":v})).unwrap_or(json!({}));
            string_result(compute("harness.format.toText", payload)?)?
        };
        let images = if !has_error {
            result
                .and_then(|r| r.get("images"))
                .and_then(Value::as_array)
                .filter(|a| !a.is_empty())
                .map(|images| {
                    Value::Array(
                        images
                            .iter()
                            .take(8)
                            .map(|image| {
                                let mut object = Map::new();
                                for k in ["mime", "base64"] {
                                    if let Some(v) = image.get(k) {
                                        object.insert(k.into(), v.clone());
                                    }
                                }
                                for k in ["width", "height"] {
                                    object.insert(
                                        k.into(),
                                        image
                                            .get(k)
                                            .filter(|v| truthy(v))
                                            .cloned()
                                            .unwrap_or(json!(0)),
                                    );
                                }
                                object.insert(
                                    "name".into(),
                                    image
                                        .get("name")
                                        .filter(|v| truthy(v))
                                        .cloned()
                                        .unwrap_or(json!("")),
                                );
                                Value::Object(object)
                            })
                            .collect(),
                    )
                })
        } else {
            None
        };
        if out.get("repaired").is_some_and(truthy) {
            text=format!("(note: your arguments were not valid JSON and were repaired automatically)\n{text}");
        }
        if out.get("notExecuted").is_some_and(truthy) {
            text = format!("[not executed: this call was not dispatched.]\n{text}");
        } else if out.get("interrupted").is_some_and(truthy) {
            text=format!("[interrupted: the session was stopped or the service shut down while this ran, so it was terminated early. Check the actual state before retrying.]\n{text}");
        }
        let result_budget = (budget * 0.1).max(600.0).min(10000.0).round();
        let fitted = compute(
            "harness.format.fitTokens",
            json!({"text":text,"maxTokens":result_budget,"ref":reference,"unicodeVersion":unicode_version}),
        )?;
        let evidence_id = if fitted["truncated"] == true {
            Some(format!("{id}#{seq}"))
        } else {
            None
        };
        let evidence=evidence_id.as_ref().map(|evidence_id|json!({"id":evidence_id,"sessionId":id,"seq":seq,"tool":name,"content":text}));
        let fallback_args = args.filter(|v| truthy(v)).cloned().unwrap_or(json!({}));
        let stub = if !has_error {
            def.and_then(|d| d.get("stub"))
                .filter(|v| !v.is_null())
                .cloned()
        } else {
            None
        };
        let stub = if let Some(stub) = stub {
            stub
        } else {
            let mut payload = json!({"name":name,"args":if has_error {args.cloned().unwrap_or(Value::Null)} else {fallback_args},"text":text});
            if has_error {
                payload["error"] = out["error"].clone();
            }
            compute("harness.format.defaultStub", payload)?
        };
        let ephemeral_key = if def.and_then(|d| d.get("ephemeral")).is_some_and(truthy) {
            def.and_then(|d| d.get("ephemeralKey"))
                .cloned()
                .unwrap_or_else(|| json!(name))
        } else {
            Value::Null
        };
        let raw = compute(
            "tokens.raw",
            json!({"text":fitted["text"],"unicodeVersion":unicode_version}),
        )?
        .as_f64()
        .unwrap_or(f64::INFINITY);
        let mut body = json!({
            "name":name,"content":fitted["text"],"stub":compute("harness.format.oneLine",json!({"value":stub,"max":200}))?,
            "error":has_error,"ephemeralKey":ephemeral_key,"keep":images.is_none()&&raw<300.0&&!truthy(&ephemeral_key),
            "evidenceId":evidence_id,"chars":utf16_units(&text).len(),
        });
        if let Some(v) = call.get("id") {
            body["callId"] = v.clone();
        }
        if let Some(args) = args {
            body["args"] = bounded_args(args);
        }
        if has_error {
            body["errorText"] = compute(
                "harness.format.oneLine",
                json!({"value":out["error"],"max":300}),
            )?;
        }
        if let Some(data) = result.and_then(|r| r.get("data")) {
            body["data"] = data.clone();
        }
        for key in ["notExecuted", "interrupted"] {
            if out.get(key).is_some_and(truthy) {
                body[key] = json!(true);
            }
        }
        if let Some(images) = images {
            body["images"] = images;
        }
        if let Some(ms) = out.get("ms") {
            body["ms"] = ms.clone();
        }
        let signature = hash(
            &stringify_js(&json!([name, args.cloned().unwrap_or(Value::Null)]))
                .map_err(core_error)?,
        );
        let outcome = hash(&sql_text(&text));
        let label = string_result(compute(
            "harness.format.argsLabel",
            json!({"args":args.cloned().unwrap_or(Value::Null)}),
        )?)?;
        let recorded = json!({"sig":signature,"outcome":outcome,"label":format!("{name}({label})"),"error":has_error});
        let calls = memory["calls"].as_array_mut().unwrap();
        calls.push(recorded);
        if calls.len() > 12 {
            calls.remove(0);
        }
        memory["errorStreak"] = if has_error {
            add_number(memory.get("errorStreak"), 1)
        } else {
            json!(0)
        };
        if name == "todo" && !has_error {
            memory["todoStep"] = stats
                .get("steps")
                .filter(|v| truthy(v))
                .cloned()
                .unwrap_or(json!(0));
        }
        stats["toolCalls"] = add_number(stats.get("toolCalls"), 1);
        stats["toolErrors"] = add_number(stats.get("toolErrors"), u8::from(has_error));
        let read_result = if name == "read"
            && result
                .and_then(|r| r.get("data"))
                .and_then(|d| d.get("readKey"))
                .is_some_and(truthy)
        {
            result.cloned()
        } else {
            None
        };
        receipts.push(ReceiptPlan {
            seq,
            body,
            evidence,
            read_result,
        });
    }
    Ok(ReceiptBatch {
        receipts,
        stats,
        memory,
    })
}
fn bounded_args(args: &Value) -> Value {
    fn bound(value: &Value) -> Value {
        match value {
            Value::String(s) if utf16_units(s).len() > 600 => {
                let u = utf16_units(s);
                Value::String(format!("{}…", from_utf16_units(&u[..600])))
            }
            _ => value.clone(),
        }
    }
    match args {
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), bound(v))).collect()),
        Value::Array(a) => Value::Object(
            a.iter()
                .enumerate()
                .map(|(i, v)| (i.to_string(), bound(v)))
                .collect(),
        ),
        _ => args.clone(),
    }
}
fn add_number(value: Option<&Value>, delta: u8) -> Value {
    let default = json!(0);
    let value = value.filter(|v| truthy(v)).unwrap_or(&default);
    match value {
        Value::String(_) | Value::Object(_) | Value::Array(_) => {
            json!(format!("{}{delta}", js_string(Some(value))))
        }
        Value::Bool(v) => json!(u8::from(*v) + delta),
        _ => json!(value.as_f64().unwrap_or(0.0) + f64::from(delta)),
    }
}
fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))[..16].into()
}
fn string_result(value: Value) -> Result<String, EffectError> {
    value
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| EffectError::new("Native receipt formatter did not return text"))
}
fn core_error(e: impl std::fmt::Display) -> EffectError {
    EffectError::new(format!("Native receipt formatting failed: {e}"))
}
fn compute(operation: &str, payload: Value) -> Result<Value, EffectError> {
    let input = stringify_js(&payload).map_err(core_error)?;
    let output = tepora_core::compute_json(operation, &input).map_err(core_error)?;
    json_codec::parse(&output).map_err(core_error)
}
#[cfg(test)]
mod tests;
