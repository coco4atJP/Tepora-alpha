//! One atomic receipt + aggregates commit using the existing SQLite owner.
use super::*;
#[cfg(test)]
use crate::model_usage::{DAY_LIMIT, RECEIPT_LIMIT};

impl WorkspaceAccess {
    pub(crate) fn record_model_call(&self, receipt: Value) -> Result<(), ApiError> {
        self.lock()?.record_model_call(&receipt).map(|_| ())
    }
}
impl State {
    pub(super) fn record_model_call(&mut self, receipt: &Value) -> Result<Value, ApiError> {
        self.call("model.record", json!({"receipt":receipt}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(id: &str, session: &Value, day: &str) -> Value {
        json!({"schema":1,"id":id,"sessionId":session,"purpose":"normal","attempt":1,"retry":false,"at":format!("{day}T12:00:00Z"),"usage":{"input":100,"output":10,"cacheRead":20,"cacheWrite":5},"usageStatus":{"status":"complete","input":"reported","output":"reported"},"cost":0.01,"costStatus":"estimated","elapsedMs":5,"outcome":"completed"})
    }
    #[test]
    fn model_receipts_deduplicate_aggregate_and_bound_retention() {
        let dir = env::temp_dir().join(format!("tepora-model-usage-{}", Uuid::new_v4()));
        let workspace = Workspace::open(&dir).unwrap();
        let access = workspace.access();
        let session = access.agent_state("main", json!({})).unwrap();
        let receipt = fixture("first", &session["id"], "2026-10-08");
        access.record_model_call(receipt.clone()).unwrap();
        access.record_model_call(receipt.clone()).unwrap();
        let mut summary = fixture("second", &session["id"], "2026-10-08");
        summary["purpose"] = json!("summary");
        summary["retry"] = json!(true);
        summary["cost"] = Value::Null;
        summary["usageStatus"]["status"] = json!("partial");
        summary["outcome"] = json!("cancelled");
        access.record_model_call(summary).unwrap();
        let mut decision = fixture("third", &Value::Null, "2026-10-09");
        decision["purpose"] = json!("decision");
        access.record_model_call(decision).unwrap();
        {
            let mut state = access.lock().unwrap();
            let daily = state.value("model-usage:2026-10-08").unwrap();
            assert_eq!(daily["calls"], 2.);
            assert_eq!(daily["input"], 200.);
            assert_eq!(daily["cacheWrite"], 10.);
            assert_eq!(daily["cost"], 0.01);
            assert_eq!(daily["unknownCostCalls"], 1.);
            let stored = state
                .get("session", session["id"].as_str().unwrap())
                .unwrap();
            assert_eq!(stored["stats"]["modelUsage"]["calls"], 2.);
            assert_eq!(stored["stats"]["steps"], 0);
            assert!(stored["stats"]["cost"].is_null());
            assert!(state.value("agent-usage:2026-10-08").unwrap().is_null());
            assert_eq!(state.value("model-usage-total").unwrap()["calls"], 3.);
        }
        for i in 0..RECEIPT_LIMIT + 2 {
            let day = (chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap()
                + chrono::Duration::days(i as i64))
            .format("%Y-%m-%d")
            .to_string();
            access
                .record_model_call(fixture(&format!("call-{i}"), &Value::Null, &day))
                .unwrap();
        }
        {
            let mut state = access.lock().unwrap();
            let rows = state
                .call(
                    "sql",
                    json!({"mode":"get","sql":"SELECT COUNT(*) AS n FROM native_model_receipts"}),
                )
                .unwrap();
            assert_eq!(rows["n"], RECEIPT_LIMIT);
            let days = state.call("sql",json!({"mode":"get","sql":"SELECT COUNT(*) AS n FROM kv WHERE key GLOB 'model-usage:????-??-??'"})).unwrap();
            assert_eq!(days["n"], DAY_LIMIT);
            assert_eq!(
                state.value("model-usage-total").unwrap()["calls"],
                (RECEIPT_LIMIT + 5) as f64
            );
        }
        drop(access);
        drop(workspace);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn model_receipt_aggregate_failure_rolls_back_deduplication_and_retries_safely() {
        let dir = env::temp_dir().join(format!("tepora-model-atomic-{}", Uuid::new_v4()));
        let workspace = Workspace::open(&dir).unwrap();
        let access = workspace.access();
        access.lock().unwrap().call("exec",json!({"sql":"CREATE TRIGGER reject_model_usage BEFORE INSERT ON kv WHEN NEW.key='model-usage:2026-10-08' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;"})).unwrap();
        let receipt = fixture("same-id", &Value::Null, "2026-10-08");
        assert!(access.record_model_call(receipt.clone()).is_err());
        access
            .lock()
            .unwrap()
            .call("exec", json!({"sql":"DROP TRIGGER reject_model_usage"}))
            .unwrap();
        access.record_model_call(receipt.clone()).unwrap();
        access.record_model_call(receipt).unwrap();
        assert_eq!(
            access.lock().unwrap().value("model-usage-total").unwrap()["calls"],
            1.
        );
        drop(access);
        drop(workspace);
        fs::remove_dir_all(dir).unwrap();
    }
}
