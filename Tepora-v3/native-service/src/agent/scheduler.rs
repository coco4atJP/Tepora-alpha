//! Existing saved schedules and change-sensitive check-ins. This module makes
//! owned plans; the FIFO host alone commits documents and delivers ordinary
//! inputs. It never invokes a model or owns a database connection.
use crate::ApiError;
use chrono::{Datelike, Local, LocalResult, NaiveDateTime, TimeZone, Timelike, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tepora_core::{
    js_value::{js_string, truthy},
    json_codec,
};
mod dates;
pub(super) mod timer;
pub use dates::parse_when;

pub const SCHEDULE_PERIOD_MS: u64 = 15_000;
pub const HEARTBEAT_QUESTION:&str="Is there anything here the user should hear about now, or that the assistant must act on (a finished result to pass on, a question, a failure, an approval)? Plain progress needs nothing.";
const DEFAULT_HEARTBEAT:&str="Check-in. Look at the work below and tell the user anything they should hear about now. Reply NO_REPLY if nothing needs attention.";

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
    fn local(&self, at: i64) -> Option<NaiveDateTime>;
    fn instant(&self, local: NaiveDateTime) -> Option<i64>;
}
pub struct SystemClock;
impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        Utc::now().timestamp_millis()
    }
    fn local(&self, at: i64) -> Option<NaiveDateTime> {
        Local
            .timestamp_millis_opt(at)
            .single()
            .map(|t| t.naive_local())
    }
    fn instant(&self, local: NaiveDateTime) -> Option<i64> {
        match Local.from_local_datetime(&local) {
            LocalResult::Single(t) => Some(t.timestamp_millis()),
            LocalResult::Ambiguous(a, b) => Some(a.timestamp_millis().min(b.timestamp_millis())),
            LocalResult::None => {
                // JavaScript's compatible disambiguation moves a nonexistent
                // wall time forward by the timezone transition's actual gap.
                let mut before = None;
                let mut after = None;
                for hour in 1..=48 {
                    if before.is_none() {
                        before = local
                            .checked_sub_signed(chrono::Duration::hours(hour))
                            .and_then(|t| Local.from_local_datetime(&t).earliest())
                            .map(|t| t.offset().local_minus_utc());
                    }
                    if after.is_none() {
                        after = local
                            .checked_add_signed(chrono::Duration::hours(hour))
                            .and_then(|t| Local.from_local_datetime(&t).earliest())
                            .map(|t| t.offset().local_minus_utc());
                    }
                    if let (Some(before), Some(after)) = (before, after) {
                        let adjusted = local.checked_add_signed(chrono::Duration::seconds(
                            i64::from(after - before),
                        ))?;
                        return Local
                            .from_local_datetime(&adjusted)
                            .earliest()
                            .map(|t| t.timestamp_millis());
                    }
                }
                None
            }
        }
    }
}
pub struct Scheduler {
    clock: Arc<dyn Clock>,
    last_heartbeat: Option<String>,
}
impl Default for Scheduler {
    fn default() -> Self {
        Self::new(Arc::new(SystemClock))
    }
}
#[derive(Clone, Debug)]
pub struct Due {
    pub document: Value,
    pub next: Option<Value>,
    pub event: Value,
    pub task: bool,
    pub text: String,
    pub title: String,
    pub source: String,
}
#[derive(Clone, Debug)]
pub struct Heartbeat {
    pub state_text: String,
    pub message: String,
    pub infer: bool,
}
impl Scheduler {
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            last_heartbeat: None,
        }
    }
    pub fn now_ms(&self) -> i64 {
        self.clock.now_ms()
    }
    pub fn add(&self, args: &Value, created_by: &str, existing: usize) -> Result<Value, ApiError> {
        let text = args["text"]
            .as_str()
            .filter(|s| !trim(s).is_empty() && json_codec::utf16_units(s).len() <= 4000)
            .ok_or_else(|| bad("text is required (at most 4000 characters)"))?;
        let mode = args.get("mode").cloned().unwrap_or_else(|| json!("remind"));
        if !matches!(mode.as_str(), Some("remind" | "task")) {
            return Err(bad("mode must be \"remind\" or \"task\""));
        }
        let now = self.clock.now_ms();
        let when = if let Some(minutes) = args.get("in_minutes").filter(|v| !v.is_null()) {
            let minutes = minutes
                .as_f64()
                .filter(|n| n.is_finite() && (0.0..=525600.0).contains(n))
                .ok_or_else(|| bad("in_minutes must be between 0 and 525600"))?;
            let value = now as f64 + minutes * 60_000.0;
            if !value.is_finite() || value.abs() > 8.64e15 {
                return Err(bad("Invalid scheduled time"));
            }
            value.trunc() as i64
        } else {
            let at = args["at"]
                .as_str()
                .filter(|s| !trim(s).is_empty())
                .ok_or_else(|| {
                    bad("Give at (for example \"15:00\" or \"2026-10-06T15:00\") or in_minutes")
                })?;
            parse_when(at, now, self.clock.as_ref())
                .ok_or_else(|| bad(&format!("Could not read the time \"{at}\"")))?
        };
        if let Some(every) = args.get("every_minutes").filter(|v| !v.is_null()) {
            if !every
                .as_f64()
                .is_some_and(|n| n.is_finite() && n.fract() == 0.0 && (5.0..=525600.0).contains(&n))
            {
                return Err(bad("every_minutes must be a whole number of at least 5"));
            }
        }
        if existing >= 200 {
            return Err(bad("At most 200 scheduled items"));
        }
        Ok(
            json!({"id":format!("sch_{}",&uuid::Uuid::new_v4().to_string()[..8]),"text":trim(text),"mode":mode,"at":iso(when)?,"every":args.get("every_minutes").filter(|v|truthy(v)).cloned().unwrap_or(Value::Null),"createdBy":created_by,"createdAt":iso(now)?,"fired":0}),
        )
    }
    pub fn list(&self, documents: &[Value]) -> Vec<Value> {
        let mut list = documents.to_vec();
        list.sort_by(|a, b| s(a, "at").cmp(s(b, "at")));
        list
    }
    pub fn show(&self, doc: &Value) -> Result<String, ApiError> {
        let at = dates::parse_instant(s(doc, "at"), self.clock.as_ref())
            .and_then(|ms| self.clock.local(ms))
            .ok_or_else(|| bad("Saved schedule has an invalid time"))?;
        let date = format!(
            "{:04}-{:02}-{:02} {:02}:{:02}",
            at.year(),
            at.month(),
            at.day(),
            at.hour(),
            at.minute()
        );
        Ok(format!(
            "{} {} at {}{}: {}",
            s(doc, "id"),
            s(doc, "mode"),
            date,
            if truthy(&doc["every"]) {
                format!(" every {} min", js_string(doc.get("every")))
            } else {
                String::new()
            },
            one_line(&doc["text"], 120)?
        ))
    }
    pub fn due(&self, documents: &[Value]) -> Result<Vec<Due>, ApiError> {
        let now = self.clock.now_ms();
        let mut due = Vec::new();
        for doc in self.list(documents) {
            let at = dates::parse_instant(s(&doc, "at"), self.clock.as_ref())
                .ok_or_else(|| bad("Saved schedule has an invalid time"))?;
            if at > now {
                continue;
            }
            let task = doc["mode"] == "task";
            let repeat = truthy(&doc["every"]);
            let fired = doc["fired"].as_u64().unwrap_or(0).saturating_add(1);
            let next = if repeat {
                let step = number(&doc["every"]) * 60_000.0;
                if !step.is_finite() || step <= 0.0 {
                    return Err(bad("Saved recurring schedule has an invalid period"));
                }
                let mut next = at as f64 + step;
                if next <= now as f64 {
                    next = now as f64 + step;
                }
                let mut update = doc.clone();
                update["at"] = json!(iso(next.trunc() as i64)?);
                update["fired"] = json!(fired);
                update["lastFiredAt"] = json!(iso(now)?);
                Some(update)
            } else {
                None
            };
            let mut event = doc.clone();
            event["fired"] = json!(fired);
            let source = format!(
                "scheduled {} {}{}",
                if task { "task" } else { "reminder" },
                s(&doc, "id"),
                if repeat {
                    format!(" (every {} min)", js_string(doc.get("every")))
                } else {
                    String::new()
                }
            );
            due.push(Due {
                text: s(&doc, "text").into(),
                title: one_line(&doc["text"], 40)?,
                source,
                task,
                document: doc,
                next,
                event,
            });
        }
        Ok(due)
    }
    pub fn heartbeat(
        &mut self,
        settings: &Value,
        sessions: &[Value],
        approvals: &[Value],
        busy: bool,
        pending: bool,
        decision: bool,
    ) -> Result<Option<Heartbeat>, ApiError> {
        if busy || pending {
            return Ok(None);
        }
        let state = heartbeat_state(sessions, approvals)?;
        let key = s(&state, "key").to_owned();
        let custom = truthy(&settings["heartbeat"]["text"]);
        if self.last_heartbeat.as_ref() == Some(&key) || state["empty"] == true && !custom {
            self.last_heartbeat = Some(key);
            return Ok(None);
        }
        self.last_heartbeat = Some(key);
        let state_text = s(&state, "text").to_owned();
        Ok(Some(Heartbeat {
            message: format!(
                "{}\n\nCurrent work:\n{}",
                if custom {
                    js_string(settings["heartbeat"].get("text"))
                } else {
                    DEFAULT_HEARTBEAT.into()
                },
                if state_text.is_empty() {
                    "(nothing running)"
                } else {
                    &state_text
                }
            ),
            state_text,
            infer: decision && !custom,
        }))
    }
}
pub fn heartbeat_period(settings: &Value) -> Option<u64> {
    let h = &settings["heartbeat"];
    let minutes = number(&h["minutes"]);
    if !truthy(&h["enabled"]) || !(minutes > 0.0) {
        return None;
    }
    let millis = minutes * 60_000.0;
    // Node setInterval clamps non-finite, sub-millisecond and overflowing
    // positive delays to one millisecond; configuration currently allows them.
    Some(
        if !millis.is_finite() || millis < 1.0 || millis > 2_147_483_647.0 {
            1
        } else {
            millis.floor() as u64
        },
    )
}
pub fn heartbeat_state(sessions: &[Value], approvals: &[Value]) -> Result<Value, ApiError> {
    let work = sessions
        .iter()
        .filter(|s| {
            s["kind"] != "main"
                && (matches!(s["status"].as_str(), Some("running" | "waiting"))
                    || s["status"] == "done" && !truthy(&s["accepted"]))
        })
        .collect::<Vec<_>>();
    let approvals = approvals
        .iter()
        .filter(|a| a["status"] == "pending")
        .collect::<Vec<_>>();
    let mut lines = Vec::new();
    for entry in &work {
        let id = json_codec::utf16_units(s(entry, "id"));
        let id = json_codec::from_utf16_units(&id[..id.len().min(8)]);
        lines.push(format!(
            "- \"{}\" ({id}) {}{} · {} steps",
            js_string(entry.get("title")),
            s(entry, "status"),
            if truthy(&entry["note"]) {
                format!(": {}", one_line(&entry["note"], 80)?)
            } else {
                String::new()
            },
            if truthy(&entry["stats"]["steps"]) {
                js_string(entry["stats"].get("steps"))
            } else {
                "0".into()
            }
        ));
    }
    if !approvals.is_empty() {
        lines.push(format!(
            "- {} approval request{} waiting for the user",
            approvals.len(),
            if approvals.len() > 1 { "s" } else { "" }
        ));
    }
    let identity = json!([
        work.iter()
            .map(|s| json!([
                s["id"],
                s["status"],
                if s["status"] == "waiting" {
                    s.get("note").cloned().unwrap_or(Value::Null)
                } else {
                    json!("")
                }
            ]))
            .collect::<Vec<_>>(),
        approvals
            .iter()
            .map(|a| a["id"].clone())
            .collect::<Vec<_>>()
    ]);
    let encoded = json_codec::stringify_js(&identity).map_err(|e| bad(&e.to_string()))?;
    Ok(
        json!({"text":lines.join("\n"),"key":format!("{:x}",Sha256::digest(encoded.as_bytes())),"empty":lines.is_empty()}),
    )
}
pub fn summarize(args: &Value) -> Result<String, ApiError> {
    Ok(format!(
        "schedule {}{}",
        js_string(args.get("action")),
        if truthy(&args["text"]) {
            format!(
                " {}",
                json_codec::encode_text(
                    &json_codec::stringify_js(&json!(one_line(&args["text"], 40)?))
                        .map_err(|e| bad(&e.to_string()))?
                )
            )
        } else {
            String::new()
        }
    ))
}
pub fn definition() -> Value {
    json_codec::parse(include_str!("scheduler/catalog.json")).expect("frozen schedule tool")
}
fn one_line(value: &Value, max: usize) -> Result<String, ApiError> {
    let raw = json_codec::stringify_js(&json!({"value":value,"max":max}))
        .map_err(|e| bad(&e.to_string()))?;
    let result = tepora_core::compute_json("harness.format.oneLine", &raw)
        .map_err(|e| bad(&e.to_string()))?;
    Ok(json_codec::parse(&result)
        .map_err(|e| bad(&e.to_string()))?
        .as_str()
        .unwrap_or("")
        .to_owned())
}
fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn bad(message: &str) -> ApiError {
    ApiError::bad_request(message)
}
fn iso(ms: i64) -> Result<String, ApiError> {
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|d| {
            let year = if (0..=9999).contains(&d.year()) {
                format!("{:04}", d.year())
            } else {
                format!("{:+07}", d.year())
            };
            format!(
                "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
                d.month(),
                d.day(),
                d.hour(),
                d.minute(),
                d.second(),
                d.timestamp_subsec_millis()
            )
        })
        .ok_or_else(|| bad("Invalid scheduled time"))
}
fn trim(value: &str) -> &str {
    value.trim_matches(|c:char|matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
fn number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(v) => {
            if *v {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(v) => v.as_f64().unwrap_or(f64::NAN),
        Value::Object(_) => f64::NAN,
        _ => {
            let text = js_string(Some(value));
            let text = trim(&text);
            if text.is_empty() {
                return 0.0;
            }
            for (prefix, base) in [
                ("0x", 16),
                ("0X", 16),
                ("0o", 8),
                ("0O", 8),
                ("0b", 2),
                ("0B", 2),
            ] {
                if let Some(digits) = text.strip_prefix(prefix) {
                    return u64::from_str_radix(digits, base)
                        .map(|v| v as f64)
                        .unwrap_or(f64::NAN);
                }
            }
            text.parse().unwrap_or(f64::NAN)
        }
    }
}
#[cfg(test)]
mod tests;
