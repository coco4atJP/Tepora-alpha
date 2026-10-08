//! Shared, content-free accounting for completed model dispatches.
//! Hosts own clocks, IDs, transport lifecycle and the one durable state owner.
use crate::{invalid, json_codec, parse, CoreResult, NativeState};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub const RECEIPT_LIMIT: usize = 512;
pub const DAY_LIMIT: usize = 90;

fn count(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite() && *n >= 0.)
}
fn bounded(v: &Value, limit: usize) -> Value {
    v.as_str()
        .map(|s| {
            // The core transport encodes lone UTF-16 surrogates/private-use
            // markers internally. Bound logical characters without splitting
            // those escapes or a valid surrogate pair at the metadata edge.
            let units = json_codec::utf16_units(s);
            let mut end = 0;
            for _ in 0..limit {
                let Some(&unit) = units.get(end) else { break };
                end += 1;
                if (0xd800..=0xdbff).contains(&unit)
                    && units
                        .get(end)
                        .is_some_and(|next| (0xdc00..=0xdfff).contains(next))
                {
                    end += 1;
                }
            }
            json!(json_codec::from_utf16_units(&units[..end]))
        })
        .unwrap_or(Value::Null)
}
/// Catalog estimates only. Missing rates are never replaced with assumed prices.
/// Canonical input includes cache tokens, unless the decoder says uncachedOnly.
pub fn estimate(
    usage: &Value,
    status: &Value,
    price: Option<&Value>,
) -> (Option<f64>, &'static str) {
    if status["status"] != "complete" {
        return (None, "unknown-usage");
    }
    let Some(input) = count(&usage["input"]) else {
        return (None, "unknown-usage");
    };
    let Some(output) = count(&usage["output"]) else {
        return (None, "unknown-usage");
    };
    for key in ["cacheRead", "cacheWrite"] {
        if usage.get(key).is_some_and(|v| count(v).is_none()) {
            return (None, "unknown-usage");
        }
    }
    let read = count(&usage["cacheRead"]).unwrap_or(0.);
    let write = count(&usage["cacheWrite"]).unwrap_or(0.);
    if usage["uncachedOnly"] != true && read + write > input {
        return (None, "unknown-usage");
    }
    let uncached = if usage["uncachedOnly"] == true {
        input
    } else {
        input - read - write
    };
    let Some(price) = price else {
        return (None, "unknown-price");
    };
    let mut total = 0.;
    for (tokens, field) in [
        (uncached, "input"),
        (output, "output"),
        (read, "cache_read"),
        (write, "cache_write"),
    ] {
        if tokens == 0. {
            continue;
        }
        let Some(rate) = count(&price[field]) else {
            return (None, "unknown-price");
        };
        total += tokens * rate / 1_000_000.;
    }
    if !total.is_finite() {
        return (None, "unknown-price");
    }
    (Some(total), "estimated")
}

/// Known subtotals plus explicit unknown counts. Legacy budget fields are separate.
pub fn aggregate(previous: &Value, receipt: &Value) -> Value {
    let mut out = previous
        .as_object()
        .cloned()
        .map(Value::Object)
        .unwrap_or_else(|| json!({}));
    let mut add = |key: &str, value: f64| {
        out[key] = json!(count(&out[key]).unwrap_or(0.) + value);
    };
    add("calls", 1.);
    for key in ["input", "output", "cacheRead", "cacheWrite"] {
        add(key, count(&receipt["usage"][key]).unwrap_or(0.));
    }
    add("cost", count(&receipt["cost"]).unwrap_or(0.));
    add(
        "unknownCostCalls",
        if receipt["cost"].is_null() { 1. } else { 0. },
    );
    add(
        "unknownUsageCalls",
        if receipt["usageStatus"]["status"] != "complete"
            || receipt["costStatus"] == "unknown-usage"
        {
            1.
        } else {
            0.
        },
    );
    add(
        "failedCalls",
        if receipt["outcome"] == "completed" {
            0.
        } else {
            1.
        },
    );
    add("retryCalls", if receipt["retry"] == true { 1. } else { 0. });
    add("modelMs", count(&receipt["elapsedMs"]).unwrap_or(0.));
    out["costStatus"] = json!(if count(&out["unknownCostCalls"]).unwrap_or(0.) > 0. {
        "incomplete"
    } else {
        "estimated"
    });
    out["coverage"] = json!("provider-and-typed-decision-dispatches");
    if out["since"].is_null() {
        out["since"] = receipt["at"].clone();
    }
    let purpose = receipt["purpose"].as_str().unwrap_or("normal");
    if !out["byPurpose"].is_object() {
        out["byPurpose"] = json!({});
    }
    out["byPurpose"][purpose] = json!(count(&out["byPurpose"][purpose]).unwrap_or(0.) + 1.);
    out
}

/// Allow only the decoder's bounded provenance fields. Upstream error text and
/// arbitrary extensions must never enter durable accounting metadata.
fn usage_status(value: &Value, outcome: &str) -> Value {
    let status = match value["status"].as_str() {
        Some("complete") if outcome == "completed" => "complete",
        Some("complete" | "partial") => "partial",
        _ => "missing",
    };
    json!({
        "status":status,
        "input":if value["input"] == "reported" { "reported" } else { "missing" },
        "output":if value["output"] == "reported" { "reported" } else { "missing" },
    })
}

/// Pure receipt shaping shared by both hosts. Only hosts supply completion time,
/// an opaque ID and elapsed duration; no prompt, output, endpoint or key survives.
pub fn receipt(payload: &Value) -> Value {
    let profile = &payload["profile"];
    let outcome = match payload["outcome"].as_str() {
        Some("completed") => "completed",
        Some("error") => "error",
        Some("cancelled") => "cancelled",
        _ => "unknown",
    };
    let purpose = match payload["purpose"].as_str() {
        Some("summary") => "summary",
        Some("decision") => "decision",
        Some("probe") => "probe",
        _ => "normal",
    };
    let attempt = payload["attempt"].as_u64().unwrap_or(1);
    let answer = &payload["answer"];
    let status = usage_status(&answer["usageStatus"], outcome);
    let usage = &answer["usage"];
    let (cost, cost_status) = estimate(
        usage,
        &status,
        payload.get("price").filter(|v| !v.is_null()),
    );
    let mut safe_usage = json!({});
    for key in ["input", "output", "cacheRead", "cacheWrite"] {
        safe_usage[key] = count(&usage[key]).map(|n| json!(n)).unwrap_or(Value::Null);
    }
    if usage["uncachedOnly"] == true {
        safe_usage["uncachedOnly"] = json!(true);
    }
    json!({
        "schema":1,
        "id":bounded(&payload["id"],128),
        "sessionId":bounded(&payload["sessionId"],128),
        "profileId":bounded(&profile["id"],128),
        "model":bounded(&profile["model"],256),
        "protocol":bounded(&profile["protocol"],40),
        "purpose":purpose,
        "attempt":attempt,
        "retry":attempt > 1,
        "usage":safe_usage,
        "usageStatus":status,
        "cost":cost,
        "costStatus":cost_status,
        "outcome":outcome,
        "elapsedMs":payload["elapsedMs"].as_u64().unwrap_or(0),
        "at":bounded(&payload["at"],64),
    })
}

/// Exact catalog IDs win over suffix aliases. Conflicting reseller entries are
/// deliberately unknown; catalog row order cannot change a receipt's estimate.
pub fn price(route: &Value, entries: &Value) -> Option<Value> {
    if route["domain"] != "cloud" {
        return None;
    }
    let model = route["model"].as_str().filter(|s| !s.is_empty())?;
    let entries = entries.as_array()?;
    let exact: Vec<_> = entries
        .iter()
        .filter(|e| !e["cost"].is_null() && e["modelId"] == model)
        .collect();
    let hits: Vec<_> = if exact.is_empty() {
        entries
            .iter()
            .filter(|e| {
                let id = e["modelId"].as_str().unwrap_or("");
                !e["cost"].is_null()
                    && !id.is_empty()
                    && (id.ends_with(&format!("/{model}")) || model.ends_with(&format!("/{id}")))
            })
            .collect()
    } else {
        exact
    };
    let first = hits.first()?;
    (hits.iter().all(|e| e["cost"] == first["cost"]) && count(&first["cost"]["input"]).is_some())
        .then(|| first["cost"].clone())
}

pub(crate) fn call(operation: &str, payload: &Value) -> CoreResult<Value> {
    match operation {
        "model.estimate" => {
            let (cost, status) = estimate(
                &payload["usage"],
                &payload["status"],
                payload.get("price").filter(|v| !v.is_null()),
            );
            Ok(json!({"cost":cost,"costStatus":status}))
        }
        "model.receipt" => Ok(receipt(payload)),
        "model.price" => Ok(price(&payload["route"], &payload["entries"]).unwrap_or(Value::Null)),
        _ => Err(invalid("Unknown model compute operation")),
    }
}

// SQLite derives the UTC bucket, so no clock or date dependency is needed in
// the pure core. Reject non-RFC3339 inputs before invoking its permissive parser.
fn valid_timestamp(at: &str) -> bool {
    static FORMAT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let regex = FORMAT.get_or_init(|| regex::Regex::new(
        r"(?i)^([0-9]{4})-([0-9]{2})-([0-9]{2})T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9]|60)(?:\.[0-9]+)?(?:Z|[+-]([01][0-9]|2[0-3]):([0-5][0-9]))$"
    ).expect("model receipt timestamp pattern"));
    let Some(parts) = regex.captures(at) else {
        return false;
    };
    let year: u32 = parts[1].parse().unwrap_or(0);
    let month: u32 = parts[2].parse().unwrap_or(0);
    let day: u32 = parts[3].parse().unwrap_or(0);
    let max = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    };
    day > 0 && day <= max
}

impl NativeState {
    /// One savepoint on the existing owner covers deduplication, every aggregate
    /// and pruning. It composes with outer transactions without committing them.
    pub(crate) fn record_model_call(&self, receipt: &Value) -> CoreResult<Value> {
        let id = receipt["id"]
            .as_str()
            .ok_or_else(|| invalid("Missing model receipt ID"))?;
        let at = receipt["at"]
            .as_str()
            .ok_or_else(|| invalid("Missing model receipt time"))?;
        let encoded = json_codec::stringify_js(receipt)?;
        if encoded.len() > 4096 || json_codec::sql_text(id).len() > 128 {
            return Err(invalid("Model receipt exceeds metadata bound"));
        }
        if !valid_timestamp(at) {
            return Err(invalid("Invalid model receipt time"));
        }
        // Drop fractions before SQLite can round .9999 across midnight. Leap
        // seconds stay in their containing minute, as in RFC3339/chrono. Apply
        // the numeric offset as a modifier to support the full RFC3339 range.
        let mut whole_seconds = at[..19].to_ascii_uppercase();
        if &whole_seconds[17..19] == "60" {
            whole_seconds.replace_range(17..19, "59");
        }
        let offset_minutes = if at.ends_with(['Z', 'z']) {
            0
        } else {
            let offset = &at[at.len() - 6..];
            let hours: i32 = offset[1..3].parse().unwrap_or(0);
            let minutes: i32 = offset[4..6].parse().unwrap_or(0);
            (hours * 60 + minutes) * if offset.starts_with('+') { -1 } else { 1 }
        };
        let date: Option<String> = self.db()?.query_row(
            "SELECT strftime('%Y-%m-%d', ?, ?)",
            params![whole_seconds, format!("{offset_minutes:+} minutes")],
            |row| row.get(0),
        )?;
        let date = date.ok_or_else(|| invalid("Invalid model receipt time"))?;
        self.atomic(|| {
            let db = self.db()?;
            db.execute_batch("CREATE TABLE IF NOT EXISTS native_model_receipts (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, receipt TEXT NOT NULL)")?;
            let inserted = db.execute(
                "INSERT INTO native_model_receipts(id,receipt) VALUES (?,?) ON CONFLICT(id) DO NOTHING",
                params![json_codec::sql_text(id), encoded],
            )?;
            if inserted == 0 {
                return Ok(json!({"duplicate":true}));
            }
            for key in [format!("model-usage:{date}"), "model-usage-total".to_owned()] {
                let previous: Option<String> = db.query_row("SELECT value FROM kv WHERE key=?", [&key], |row| row.get(0)).optional()?;
                let previous = previous.map(parse).transpose()?.unwrap_or(Value::Null);
                let value = aggregate(&previous, receipt);
                db.execute("INSERT INTO kv(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    params![key, json_codec::stringify_js(&value)?])?;
            }
            if let Some(session_id) = receipt["sessionId"].as_str().filter(|s| !s.is_empty()) {
                let mut session = self.document("session", session_id)?;
                if session.is_object() {
                    if !session["stats"].is_object() {
                        session["stats"] = json!({});
                    }
                    session["stats"]["modelUsage"] = aggregate(&session["stats"]["modelUsage"], receipt);
                    db.execute("UPDATE documents SET body=? WHERE kind='session' AND id=?",
                        params![json_codec::stringify_js(&session)?, json_codec::sql_text(session_id)])?;
                }
            }
            db.execute("DELETE FROM native_model_receipts WHERE seq IN (SELECT seq FROM native_model_receipts ORDER BY seq DESC LIMIT -1 OFFSET ?)", [RECEIPT_LIMIT as i64])?;
            // The independent legacy agent-usage namespace is never pruned.
            db.execute("DELETE FROM kv WHERE key IN (SELECT key FROM kv WHERE key GLOB 'model-usage:????-??-??' ORDER BY key DESC LIMIT -1 OFFSET ?)", [DAY_LIMIT as i64])?;
            Ok(json!({"duplicate":false}))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn complete() -> Value {
        json!({"status":"complete","input":"reported","output":"reported"})
    }
    fn fixture(id: &str, session: &Value, at: &str) -> Value {
        receipt(&json!({
            "profile":{"id":"p","model":"m","protocol":"chat-completions"},
            "id":id,"sessionId":session,"purpose":"normal","attempt":1,"at":at,"elapsedMs":5,
            "answer":{"usage":{"input":100,"output":10,"cacheRead":20,"cacheWrite":5},"usageStatus":complete()},
            "outcome":"completed","price":{"input":2,"output":8,"cache_read":0.5,"cache_write":3},
        }))
    }
    fn compute(op: &str, payload: &Value) -> Value {
        serde_json::from_str(&crate::compute_json(op, &payload.to_string()).unwrap()).unwrap()
    }
    fn record(state: &mut NativeState, value: &Value) -> CoreResult<Value> {
        state.call("model.record", json!({"receipt":value}))
    }
    fn get(state: &mut NativeState, key: &str) -> Value {
        state.call("kv.get", json!({"key":key})).unwrap()
    }
    fn rows(state: &NativeState, table: &str) -> i64 {
        state
            .db()
            .unwrap()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn estimates_cache_subsets_once_and_preserves_unknown_usage_and_prices() {
        let usage = json!({"input":100,"output":20,"cacheRead":30,"cacheWrite":10});
        let price = json!({"input":2,"output":8,"cache_read":0.5,"cache_write":3});
        let (cost, status) = estimate(&usage, &complete(), Some(&price));
        assert_eq!(status, "estimated");
        assert!((cost.unwrap() - 0.000325).abs() < 1e-12);
        assert_eq!(estimate(&usage, &complete(), None), (None, "unknown-price"));
        assert_eq!(
            estimate(&usage, &complete(), Some(&json!({"input":2,"output":8}))),
            (None, "unknown-price")
        );
        assert_eq!(
            estimate(&usage, &json!({"status":"partial"}), Some(&price)),
            (None, "unknown-usage")
        );
        for usage in [
            json!({"input":1,"output":0,"cacheRead":2}),
            json!({"input":-1,"output":0}),
            json!({"input":0,"output":0,"cacheWrite":null}),
        ] {
            assert_eq!(
                estimate(&usage, &complete(), Some(&price)),
                (None, "unknown-usage")
            );
        }
        assert_eq!(
            estimate(
                &json!({"input":0,"output":0}),
                &complete(),
                Some(&json!({"input":0,"output":0}))
            ),
            (Some(0.), "estimated")
        );
        assert_eq!(
            estimate(&json!({"input":0,"output":0}), &complete(), None),
            (None, "unknown-price")
        );
        let uncached =
            json!({"input":60,"output":20,"cacheRead":30,"cacheWrite":10,"uncachedOnly":true});
        assert_eq!(
            estimate(&uncached, &complete(), Some(&price)),
            (cost, "estimated")
        );
        assert_eq!(
            compute(
                "model.estimate",
                &json!({"usage":usage,"status":complete(),"price":price})
            ),
            json!({"cost":cost,"costStatus":status})
        );
    }

    #[test]
    fn receipt_compute_matches_native_shaping_and_discards_private_extensions() {
        let mut payload = json!({
            "profile":{"id":"p","model":"m","protocol":"chat-completions","apiKey":"private-key","baseUrl":"https://private.invalid"},
            "sessionId":"s","purpose":"summary","attempt":2,"id":"call-1","at":"2026-10-08T12:00:00.000Z","elapsedMs":5,
            "answer":{"usage":{"input":10,"output":2,"secret":"private-usage"},"usageStatus":{"status":"complete","input":"reported","output":"reported","secret":"private-status"},"content":"private-output"},
            "outcome":"completed","price":{"input":2,"output":8},"prompt":"private-prompt",
        });
        let direct = receipt(&payload);
        assert_eq!(compute("model.receipt", &payload), direct);
        assert_eq!(direct["schema"], 1);
        assert_eq!(direct["retry"], true);
        assert_eq!(direct["usageStatus"], complete());
        assert_eq!(direct["costStatus"], "estimated");
        assert_eq!(
            direct["cost"],
            compute(
                "model.estimate",
                &json!({"usage":payload["answer"]["usage"],"status":complete(),"price":payload["price"]})
            )["cost"]
        );
        assert!(!direct.to_string().contains("private"));
        assert_eq!(direct.as_object().unwrap().len(), 16);
        payload["outcome"] = json!("cancelled");
        let cancelled = receipt(&payload);
        assert_eq!(cancelled["usageStatus"]["status"], "partial");
        assert_eq!(cancelled["costStatus"], "unknown-usage");
        assert!(cancelled["cost"].is_null());
        payload["answer"]["usageStatus"] =
            json!({"status":"private-status","input":"private-input","output":{}});
        assert_eq!(
            receipt(&payload)["usageStatus"],
            json!({"status":"missing","input":"missing","output":"missing"})
        );
        payload["profile"]["model"] = json!("m".repeat(5000));
        payload["profile"]["protocol"] = json!("p".repeat(5000));
        payload["sessionId"] = json!("s".repeat(5000));
        let bounded = receipt(&payload);
        assert_eq!(bounded["model"].as_str().unwrap().len(), 256);
        assert_eq!(bounded["protocol"].as_str().unwrap().len(), 40);
        assert_eq!(bounded["sessionId"].as_str().unwrap().len(), 128);
        assert!(bounded.to_string().len() <= 4096);
    }

    #[test]
    fn receipt_bounds_preserve_internal_unicode_escapes_and_scalar_boundaries() {
        let input = format!(
            r#"{{"profile":{{"id":"{}\ud800x","model":"{}\ud83d\ude00x","protocol":"{}\ue000x"}}}}"#,
            "\\ue000".repeat(127),
            "\\ue000".repeat(255),
            "p".repeat(39),
        );
        let encoded = crate::compute_json("model.receipt", &input).unwrap();
        let shaped = json_codec::parse(&encoded).unwrap();
        let id = json_codec::utf16_units(shaped["profileId"].as_str().unwrap());
        assert_eq!(id.len(), 128);
        assert_eq!(id[127], 0xd800);
        assert!(id[..127].iter().all(|unit| *unit == 0xe000));
        let model = json_codec::utf16_units(shaped["model"].as_str().unwrap());
        assert_eq!(model.len(), 257);
        assert_eq!(&model[255..], &[0xd83d, 0xde00]);
        let protocol = json_codec::utf16_units(shaped["protocol"].as_str().unwrap());
        assert_eq!(protocol.len(), 40);
        assert_eq!(protocol[39], 0xe000);
    }

    #[test]
    fn catalog_matching_prefers_exact_and_rejects_conflicting_resellers() {
        let mut route = json!({"domain":"cloud","model":"m"});
        let entries = json!([
            {"modelId":"reseller/m","cost":{"input":10,"output":20}},
            {"modelId":"m","cost":{"input":1,"output":2}},
            {"modelId":"m","cost":{"input":1,"output":2}}
        ]);
        assert_eq!(price(&route, &entries), Some(json!({"input":1,"output":2})));
        assert_eq!(
            compute("model.price", &json!({"route":route,"entries":entries})),
            json!({"input":1,"output":2})
        );
        assert!(price(
            &route,
            &json!([{"modelId":"a/m","cost":{"input":1}},{"modelId":"b/m","cost":{"input":2}}])
        )
        .is_none());
        assert!(price(&route, &json!([{"modelId":"m","cost":{"input":-1}}])).is_none());
        route["domain"] = json!("local");
        assert!(price(&route, &entries).is_none());
        route = json!({"domain":"cloud","model":"provider/m"});
        assert_eq!(price(&route, &entries), Some(json!({"input":1,"output":2})));
        route["model"] = json!("");
        assert!(price(&route, &entries).is_none());
    }

    #[test]
    fn receipts_deduplicate_aggregate_and_bound_only_their_own_retention() {
        let mut state = NativeState::open(":memory:").unwrap();
        state.call("document.put", json!({"kind":"session","doc":{"id":"s","stats":{"steps":7,"cost":9},"futureField":"keep"}})).unwrap();
        state
            .call(
                "kv.set",
                json!({"key":"agent-usage:2026-01-01","value":{"cost":42}}),
            )
            .unwrap();
        let first = fixture("first", &json!("s"), "2026-10-08T12:00:00Z");
        assert_eq!(
            record(&mut state, &first).unwrap(),
            json!({"duplicate":false})
        );
        assert_eq!(
            record(&mut state, &first).unwrap(),
            json!({"duplicate":true})
        );
        let mut second = fixture("second", &json!("s"), "2026-10-08T12:00:00Z");
        second["purpose"] = json!("summary");
        second["retry"] = json!(true);
        second["cost"] = Value::Null;
        second["usageStatus"]["status"] = json!("partial");
        second["outcome"] = json!("cancelled");
        record(&mut state, &second).unwrap();
        let daily = get(&mut state, "model-usage:2026-10-08");
        assert_eq!(daily["calls"], 2.);
        assert_eq!(daily["input"], 200.);
        assert_eq!(daily["cacheWrite"], 10.);
        assert_eq!(daily["cost"], first["cost"]);
        assert_eq!(daily["unknownCostCalls"], 1.);
        assert_eq!(daily["unknownUsageCalls"], 1.);
        assert_eq!(daily["failedCalls"], 1.);
        assert_eq!(daily["retryCalls"], 1.);
        assert_eq!(daily["byPurpose"]["summary"], 1.);
        assert_eq!(daily["coverage"], "provider-and-typed-decision-dispatches");
        let session = state
            .call("document.get", json!({"kind":"session","id":"s"}))
            .unwrap();
        assert_eq!(session["stats"]["modelUsage"]["calls"], 2.);
        assert_eq!(session["stats"]["steps"], 7);
        assert_eq!(session["stats"]["cost"], 9);
        assert_eq!(session["futureField"], "keep");
        for i in 0..RECEIPT_LIMIT + 2 {
            let day: String = state
                .db()
                .unwrap()
                .query_row(
                    "SELECT date('2026-01-01', ?)",
                    [format!("+{i} days")],
                    |row| row.get(0),
                )
                .unwrap();
            record(
                &mut state,
                &fixture(
                    &format!("call-{i}"),
                    &Value::Null,
                    &format!("{day}T12:00:00Z"),
                ),
            )
            .unwrap();
        }
        assert_eq!(rows(&state, "native_model_receipts"), RECEIPT_LIMIT as i64);
        let days: i64 = state
            .db()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM kv WHERE key GLOB 'model-usage:????-??-??'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(days, DAY_LIMIT as i64);
        assert_eq!(
            get(&mut state, "model-usage-total")["calls"],
            (RECEIPT_LIMIT + 4) as f64
        );
        assert_eq!(
            get(&mut state, "agent-usage:2026-01-01"),
            json!({"cost":42})
        );
    }

    #[test]
    fn failure_rolls_back_receipt_daily_total_and_session_then_allows_retry() {
        let mut state = NativeState::open(":memory:").unwrap();
        state
            .call(
                "document.put",
                json!({"kind":"session","doc":{"id":"s","stats":{"steps":7}}}),
            )
            .unwrap();
        let first = fixture("first", &json!("s"), "2026-10-08T12:00:00Z");
        record(&mut state, &first).unwrap();
        let before_daily = get(&mut state, "model-usage:2026-10-08");
        let before_total = get(&mut state, "model-usage-total");
        let before_session = state.document("session", "s").unwrap();
        state.db().unwrap().execute_batch("CREATE TRIGGER reject_model_session BEFORE UPDATE ON documents WHEN NEW.kind='session' BEGIN SELECT RAISE(ABORT,'fixture failure'); END").unwrap();
        let second = fixture("second", &json!("s"), "2026-10-08T12:01:00Z");
        assert!(record(&mut state, &second).is_err());
        assert_eq!(rows(&state, "native_model_receipts"), 1);
        assert_eq!(get(&mut state, "model-usage:2026-10-08"), before_daily);
        assert_eq!(get(&mut state, "model-usage-total"), before_total);
        assert_eq!(state.document("session", "s").unwrap(), before_session);
        state
            .db()
            .unwrap()
            .execute_batch("DROP TRIGGER reject_model_session")
            .unwrap();
        assert_eq!(
            record(&mut state, &second).unwrap(),
            json!({"duplicate":false})
        );
        assert_eq!(
            record(&mut state, &second).unwrap(),
            json!({"duplicate":true})
        );
        assert_eq!(get(&mut state, "model-usage-total")["calls"], 2.);
        // Releasing the operation's savepoint must never commit an outer batch.
        state.db().unwrap().execute_batch("BEGIN").unwrap();
        record(
            &mut state,
            &fixture("outer", &json!("s"), "2026-10-08T12:02:00Z"),
        )
        .unwrap();
        state.db().unwrap().execute_batch("ROLLBACK").unwrap();
        assert_eq!(rows(&state, "native_model_receipts"), 2);
        assert_eq!(get(&mut state, "model-usage-total")["calls"], 2.);
        assert_eq!(
            state.document("session", "s").unwrap()["stats"]["modelUsage"]["calls"],
            2.
        );
    }

    #[test]
    fn validates_bounds_and_uses_utc_completion_day() {
        let mut state = NativeState::open(":memory:").unwrap();
        let value = fixture("offset", &Value::Null, "2026-10-08T23:30:00-02:00");
        record(&mut state, &value).unwrap();
        assert!(get(&mut state, "model-usage:2026-10-08").is_null());
        assert_eq!(get(&mut state, "model-usage:2026-10-09")["calls"], 1.);
        for at in [
            "2026-10-08",
            "not a time",
            "2026-02-30T12:00:00Z",
            "2026-10-08T12:00:00",
            "2026-10-08T25:00:00Z",
        ] {
            let mut invalid_receipt = value.clone();
            invalid_receipt["id"] = json!("invalid");
            invalid_receipt["at"] = json!(at);
            assert!(record(&mut state, &invalid_receipt).is_err(), "{at}");
        }
        let mut large = value.clone();
        large["id"] = json!("x".repeat(129));
        assert!(record(&mut state, &large).is_err());
        large["id"] = json!("large");
        large["extra"] = json!("x".repeat(4096));
        assert!(record(&mut state, &large).is_err());
        assert_eq!(rows(&state, "native_model_receipts"), 1);
        for (id, at) in [
            ("fraction", "2026-10-08T23:59:59.9999Z"),
            ("fraction-offset", "2026-10-09T00:59:59.9999+01:00"),
            ("lowercase", "2026-10-08t23:59:59.9999z"),
            ("leap", "2026-10-08T23:59:60Z"),
            ("large-offset", "2026-10-09T14:59:59+15:00"),
        ] {
            record(&mut state, &fixture(id, &Value::Null, at)).unwrap();
        }
        assert_eq!(get(&mut state, "model-usage:2026-10-08")["calls"], 5.);
        assert_eq!(get(&mut state, "model-usage:2026-10-09")["calls"], 1.);
    }
}
