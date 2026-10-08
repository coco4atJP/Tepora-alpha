//! Bounded metadata for completed model dispatches; never prompts, outputs or keys.
use crate::ApiError;
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

pub use tepora_core::model_usage::{estimate, DAY_LIMIT, RECEIPT_LIMIT};
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
        Self {
            receipt: Some(json!({
                "id":uuid::Uuid::new_v4().to_string(),
                "profile":{"id":profile["id"],"model":profile["model"],"protocol":profile["protocol"]},
                "sessionId":session,"purpose":purpose,"attempt":attempt,
            })),
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
        receipt["answer"] = answer
            .map(|answer| json!({"usage":answer["usage"],"usageStatus":answer["usageStatus"]}))
            .unwrap_or(Value::Null);
        receipt["price"] = self.price.take().unwrap_or(Value::Null);
        receipt["outcome"] = json!(outcome);
        receipt["elapsedMs"] = json!(started.elapsed().as_millis().min(u64::MAX as u128) as u64);
        receipt["at"] =
            json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        let receipt = tepora_core::model_usage::receipt(&receipt);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tepora_core::model_usage::aggregate;
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
