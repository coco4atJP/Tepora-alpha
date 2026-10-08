//! Bounded metadata for completed model dispatches; never prompts, outputs or keys.
use crate::ApiError;
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

pub const RECEIPT_LIMIT: usize = 512;
pub const DAY_LIMIT: usize = 90;
pub type Commit = Arc<dyn Fn(Value) -> Result<(), ApiError> + Send + Sync>;
/// Read-only observer of the existing transport boundary. No state writes or
/// admission authority; marking merely captures one in-memory start instant.
#[derive(Clone, Debug, Default)]
pub struct DispatchMarker(Arc<Mutex<Option<Instant>>>);
impl DispatchMarker {
    pub(crate) fn mark(&self) {
        let mut started = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if started.is_none() {
            *started = Some(Instant::now());
        }
    }
    fn take(&self) -> Option<Instant> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

fn count(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite() && *n >= 0.)
}
fn bounded(v: &Value, limit: usize) -> Value {
    v.as_str()
        .map(|s| json!(s.chars().take(limit).collect::<String>()))
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

/// Created before dispatch, armed only immediately before the network request.
/// Dropping an armed future records unknown outcome, including timeout/abort.
/// Explicit finish and Drop are mutually exclusive and perform one final write.
pub struct Dispatch {
    receipt: Option<Value>,
    price: Option<Value>,
    commit: Commit,
    started: DispatchMarker,
}
impl Dispatch {
    pub fn new(
        profile: &Value,
        session: &Value,
        purpose: &str,
        attempt: u64,
        price: Option<Value>,
        commit: Commit,
    ) -> Self {
        let purpose = match purpose {
            "summary" => "summary",
            "decision" => "decision",
            "probe" => "probe",
            _ => "normal",
        };
        Self {
            receipt: Some(
                json!({"schema":1,"id":uuid::Uuid::new_v4().to_string(),"sessionId":bounded(session,128),"profileId":bounded(&profile["id"],128),"model":bounded(&profile["model"],256),"protocol":bounded(&profile["protocol"],40),"purpose":purpose,"attempt":attempt,"retry":attempt>1}),
            ),
            price,
            commit,
            started: DispatchMarker::default(),
        }
    }
    pub fn start(&mut self) {
        self.started.mark();
    }
    pub fn marker(&self) -> DispatchMarker {
        self.started.clone()
    }
    pub fn finish(&mut self, answer: Option<&Value>, outcome: &str) -> Result<(), ApiError> {
        let Some(started) = self.started.take() else {
            return Ok(());
        };
        let Some(mut receipt) = self.receipt.take() else {
            return Ok(());
        };
        let mut status = answer
            .map(|a| a["usageStatus"].clone())
            .filter(|s| s.is_object())
            .unwrap_or_else(|| json!({"status":"missing","input":"missing","output":"missing"}));
        if outcome != "completed" && status["status"] == "complete" {
            status["status"] = json!("partial");
        }
        let usage = answer.map(|a| &a["usage"]).unwrap_or(&Value::Null);
        let (cost, cost_status) = estimate(usage, &status, self.price.as_ref());
        let mut safe_usage = json!({});
        for key in ["input", "output", "cacheRead", "cacheWrite"] {
            safe_usage[key] = count(&usage[key]).map(|n| json!(n)).unwrap_or(Value::Null);
        }
        if usage["uncachedOnly"] == true {
            safe_usage["uncachedOnly"] = json!(true);
        }
        receipt["usage"] = safe_usage;
        receipt["usageStatus"] = status;
        receipt["cost"] = json!(cost);
        receipt["costStatus"] = json!(cost_status);
        receipt["outcome"] = json!(match outcome {
            "completed" => "completed",
            "error" => "error",
            "cancelled" => "cancelled",
            _ => "unknown",
        });
        receipt["elapsedMs"] = json!(started.elapsed().as_millis().min(u64::MAX as u128) as u64);
        receipt["at"] =
            json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        (self.commit)(receipt)
    }
}
impl Drop for Dispatch {
    fn drop(&mut self) {
        if self.finish(None, "unknown").is_err() {
            // No upstream data or storage error body is logged.
            eprintln!("Model dispatch accounting could not be persisted");
        }
    }
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
        if receipt["usageStatus"]["status"] != "complete" || receipt["costStatus"] == "unknown-usage" {
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
    out["coverage"] = json!("native-provider-and-typed-decision-dispatches");
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    fn complete() -> Value {
        json!({"status":"complete","input":"reported","output":"reported"})
    }
    #[test]
    fn estimates_cache_subsets_once_and_requires_explicit_rates() {
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
        assert_eq!(
            estimate(
                &json!({"input":1,"output":0,"cacheRead":2}),
                &complete(),
                Some(&price)
            ),
            (None, "unknown-usage")
        );
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
        assert_eq!(
            estimate(&json!({"input":-1,"output":0}), &complete(), Some(&price)),
            (None, "unknown-usage")
        );
        let uncached =
            json!({"input":60,"output":20,"cacheRead":30,"cacheWrite":10,"uncachedOnly":true});
        assert_eq!(
            estimate(&uncached, &complete(), Some(&price)),
            (cost, "estimated")
        );
    }
    #[test]
    fn completion_drop_and_no_dispatch_write_once_without_private_content() {
        let saved = Arc::new(Mutex::new(Vec::new()));
        let sink = saved.clone();
        let commit: Commit = Arc::new(move |v| {
            sink.lock().unwrap().push(v);
            Ok(())
        });
        let profile = json!({"id":"p","model":"m","protocol":"chat-completions","baseUrl":"https://secret.invalid","apiKey":"private"});
        {
            let _unsent = Dispatch::new(&profile, &json!("s"), "normal", 1, None, commit.clone());
        }
        assert!(saved.lock().unwrap().is_empty());
        {
            let mut dispatch =
                Dispatch::new(&profile, &json!("s"), "normal", 1, None, commit.clone());
            dispatch.start();
            dispatch.finish(Some(&json!({"content":"private prompt and reply","usage":{"input":3,"output":2},"usageStatus":complete()})), "completed").unwrap();
            dispatch.finish(None, "error").unwrap();
        }
        {
            let mut dropped = Dispatch::new(&profile, &Value::Null, "decision", 1, None, commit);
            dropped.start();
        }
        let receipts = saved.lock().unwrap();
        assert_eq!(receipts.len(), 2);
        assert_eq!(receipts[0]["costStatus"], "unknown-price");
        assert!(receipts[0]["cost"].is_null());
        assert_eq!(receipts[1]["outcome"], "unknown");
        assert_eq!(receipts[1]["usageStatus"]["status"], "missing");
        assert_ne!(receipts[0]["id"], receipts[1]["id"]);
        let serialized = serde_json::to_string(&*receipts).unwrap();
        for secret in ["private", "secret.invalid", "content", "apiKey"] {
            assert!(!serialized.contains(secret));
        }
        assert!(receipts.iter().all(|r| r.to_string().len() <= 4096));
    }
    #[test]
    fn aggregate_distinguishes_zero_from_unknown_and_keeps_purposes() {
        let normal = json!({"purpose":"normal","usage":{"input":10,"output":0},"usageStatus":complete(),"cost":0,"outcome":"completed","elapsedMs":10});
        let summary = json!({"purpose":"summary","usage":{"input":4},"usageStatus":{"status":"partial"},"cost":null,"outcome":"cancelled","retry":true,"elapsedMs":3});
        let total = aggregate(&aggregate(&Value::Null, &normal), &summary);
        assert_eq!(total["calls"], 2.);
        assert_eq!(total["input"], 14.);
        assert_eq!(total["cost"], 0.);
        assert_eq!(total["unknownCostCalls"], 1.);
        assert_eq!(total["unknownUsageCalls"], 1.);
        assert_eq!(total["costStatus"], "incomplete");
        assert_eq!(total["retryCalls"], 1.);
        assert_eq!(total["byPurpose"]["summary"], 1.);
        assert_eq!(total["byPurpose"]["normal"], 1.);
    }
}
