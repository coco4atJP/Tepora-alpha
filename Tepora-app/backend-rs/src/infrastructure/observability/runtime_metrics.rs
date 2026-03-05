use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
pub struct SessionBusyMetric {
    pub session_id: String,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeMetricsSnapshot {
    pub dispatch_total: u64,
    pub session_busy_total: u64,
    pub too_many_sessions_total: u64,
    pub internal_error_total: u64,
    pub session_busy_top: Vec<SessionBusyMetric>,
}

#[derive(Debug, Default)]
pub struct RuntimeMetrics {
    dispatch_total: AtomicU64,
    session_busy_total: AtomicU64,
    too_many_sessions_total: AtomicU64,
    internal_error_total: AtomicU64,
    session_busy_by_session: Mutex<HashMap<String, u64>>,
}

impl RuntimeMetrics {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_dispatch(&self) {
        self.dispatch_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_session_busy(&self, session_id: &str) {
        self.session_busy_total.fetch_add(1, Ordering::Relaxed);
        self.record_session_hotspot(session_id);
    }

    pub fn record_too_many_sessions(&self, session_id: &str) {
        self.too_many_sessions_total.fetch_add(1, Ordering::Relaxed);
        self.record_session_hotspot(session_id);
    }

    pub fn record_internal_error(&self) {
        self.internal_error_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self, top_n: usize) -> RuntimeMetricsSnapshot {
        let mut session_busy_top = self
            .session_busy_by_session
            .lock()
            .map(|guard| {
                let mut entries = guard
                    .iter()
                    .map(|(session_id, count)| SessionBusyMetric {
                        session_id: session_id.clone(),
                        count: *count,
                    })
                    .collect::<Vec<_>>();

                entries.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.session_id.cmp(&b.session_id)));
                entries
            })
            .unwrap_or_default();

        if top_n > 0 {
            session_busy_top.truncate(top_n);
        }

        RuntimeMetricsSnapshot {
            dispatch_total: self.dispatch_total.load(Ordering::Relaxed),
            session_busy_total: self.session_busy_total.load(Ordering::Relaxed),
            too_many_sessions_total: self.too_many_sessions_total.load(Ordering::Relaxed),
            internal_error_total: self.internal_error_total.load(Ordering::Relaxed),
            session_busy_top,
        }
    }

    fn record_session_hotspot(&self, session_id: &str) {
        if let Ok(mut guard) = self.session_busy_by_session.lock() {
            *guard.entry(session_id.to_string()).or_insert(0) += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::RuntimeMetrics;

    #[test]
    fn runtime_metrics_snapshot_contains_totals_and_top_sessions() {
        let metrics = RuntimeMetrics::new();
        metrics.record_dispatch();
        metrics.record_dispatch();
        metrics.record_session_busy("s1");
        metrics.record_session_busy("s1");
        metrics.record_too_many_sessions("s2");
        metrics.record_internal_error();

        let snapshot = metrics.snapshot(10);
        assert_eq!(snapshot.dispatch_total, 2);
        assert_eq!(snapshot.session_busy_total, 2);
        assert_eq!(snapshot.too_many_sessions_total, 1);
        assert_eq!(snapshot.internal_error_total, 1);
        assert_eq!(snapshot.session_busy_top.len(), 2);
        assert_eq!(snapshot.session_busy_top[0].session_id, "s1");
        assert_eq!(snapshot.session_busy_top[0].count, 2);
    }
}
