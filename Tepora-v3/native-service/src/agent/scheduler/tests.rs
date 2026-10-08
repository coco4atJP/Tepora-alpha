use super::*;
use std::sync::atomic::{AtomicI64, Ordering};
struct FixedClock {
    now: AtomicI64,
    offset: i32,
}
impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn local(&self, ms: i64) -> Option<NaiveDateTime> {
        Utc.timestamp_millis_opt(ms + i64::from(self.offset) * 1000)
            .single()
            .map(|t| t.naive_utc())
    }
    fn instant(&self, local: NaiveDateTime) -> Option<i64> {
        Some(local.and_utc().timestamp_millis() - i64::from(self.offset) * 1000)
    }
}
fn fixture() -> Value {
    json_codec::parse(include_str!("fixtures.json")).unwrap()
}
fn clock(now: i64) -> Arc<FixedClock> {
    Arc::new(FixedClock {
        now: AtomicI64::new(now),
        offset: 0,
    })
}
#[test]
fn frozen_source_date_parsing_and_add_validation() {
    let fixture = fixture();
    let clock = clock(fixture["now"].as_i64().unwrap());
    let scheduler = Scheduler::new(clock.clone());
    for case in fixture["dates"].as_array().unwrap() {
        assert_eq!(
            json!(parse_when(
                case["input"].as_str().unwrap(),
                clock.now_ms(),
                clock.as_ref()
            )),
            case["ms"],
            "{}",
            case["input"]
        );
    }
    for case in fixture["additions"].as_array().unwrap() {
        match scheduler.add(&case["args"], "worker", 0) {
            Ok(mut value) => {
                value["id"] = json!("<id>");
                assert_eq!(value, case["value"], "{}", case["args"]);
            }
            Err(error) => {
                assert_eq!(
                    error.status,
                    case["error"]["status"].as_u64().unwrap() as u16
                );
                assert_eq!(error.message, case["error"]["message"]);
            }
        }
    }
    assert!(scheduler
        .add(&json!({"text":"fixture","in_minutes":0}), "worker", 200)
        .is_err());
}
#[test]
fn frozen_source_due_once_repeat_and_task_plans() {
    let fixture = fixture();
    let scheduler = Scheduler::new(clock(fixture["now"].as_i64().unwrap()));
    let before = fixture["tick"]["before"].as_array().unwrap();
    let plans = scheduler.due(before).unwrap();
    let mut docs = before
        .iter()
        .map(|v| (s(v, "id").to_owned(), v.clone()))
        .collect::<std::collections::HashMap<_, _>>();
    let mut events = Vec::new();
    let mut sent = Vec::new();
    let mut spawned = Vec::new();
    for due in plans {
        if due.task {
            spawned.push(json!({"parent":"main","body":{"task":due.text,"title":due.title,"from":"schedule"}}));
        } else {
            sent.push(json!({"id":"main","body":{"text":due.text,"from":"schedule","kind":"reminder","source":due.source}}));
        }
        let id = s(&due.document, "id").to_owned();
        if let Some(next) = due.next {
            docs.insert(id, next);
        } else {
            docs.remove(&id);
        }
        events.push(json!({"type":"schedule.updated","data":due.event}));
    }
    let remaining = scheduler.list(&docs.into_values().collect::<Vec<_>>());
    assert_eq!(
        json!({"remaining":remaining,"events":events,"sent":sent,"spawned":spawned}),
        fixture["tick"]["first"]
    );
    assert!(scheduler.due(&remaining).unwrap().is_empty());
    let restarted = Scheduler::new(clock(fixture["now"].as_i64().unwrap()));
    assert!(restarted.due(&remaining).unwrap().is_empty());
}
#[test]
fn frozen_heartbeat_text_and_meaningful_change_hashes() {
    let fixture = fixture();
    let cases = fixture["heartbeat"].as_array().unwrap();
    for case in cases {
        assert_eq!(
            heartbeat_state(
                case["sessions"].as_array().unwrap(),
                case["approvals"].as_array().unwrap()
            )
            .unwrap(),
            case["value"]
        );
    }
    assert_eq!(cases[1]["value"]["key"], cases[2]["value"]["key"]);
    assert_ne!(cases[1]["value"]["text"], cases[2]["value"]["text"]);
    let mut scheduler = Scheduler::new(clock(0));
    let settings = json!({"heartbeat":{"enabled":true,"minutes":60,"text":""}});
    assert!(scheduler
        .heartbeat(&settings, &[], &[], false, false, true)
        .unwrap()
        .is_none());
    let work = cases[1]["sessions"].as_array().unwrap();
    assert!(scheduler
        .heartbeat(&settings, work, &[], true, false, true)
        .unwrap()
        .is_none());
    assert!(scheduler
        .heartbeat(&settings, work, &[], false, true, true)
        .unwrap()
        .is_none());
    let plan = scheduler
        .heartbeat(&settings, work, &[], false, false, true)
        .unwrap()
        .unwrap();
    assert!(plan.infer);
    assert!(plan.message.starts_with(DEFAULT_HEARTBEAT));
    assert!(scheduler
        .heartbeat(
            &settings,
            cases[2]["sessions"].as_array().unwrap(),
            &[],
            false,
            false,
            true
        )
        .unwrap()
        .is_none());
    let mut custom = Scheduler::new(clock(0));
    let plan = custom
        .heartbeat(
            &json!({"heartbeat":{"text":"Custom fixture"}}),
            &[],
            &[],
            false,
            false,
            true,
        )
        .unwrap()
        .unwrap();
    assert!(!plan.infer);
    assert_eq!(
        plan.message,
        "Custom fixture\n\nCurrent work:\n(nothing running)"
    );
    assert!(custom
        .heartbeat(
            &json!({"heartbeat":{"text":"Different custom text"}}),
            &[],
            &[],
            false,
            false,
            true
        )
        .unwrap()
        .is_none());
}
#[test]
fn local_time_roll_forward_and_date_only_use_injected_zone() {
    let clock = FixedClock {
        now: AtomicI64::new(1_791_376_496_789),
        offset: 9 * 3600,
    };
    let now = clock.now_ms();
    assert_eq!(
        iso(parse_when("15:00", now, &clock).unwrap()).unwrap(),
        "2026-10-08T06:00:00.000Z"
    );
    assert_eq!(
        iso(parse_when("2026-10-08", now, &clock).unwrap()).unwrap(),
        "2026-10-08T00:00:00.000Z"
    );
    assert_eq!(
        iso(parse_when("2026-10-08T15:00Z", now, &clock).unwrap()).unwrap(),
        "2026-10-08T15:00:00.000Z"
    );
}
#[test]
fn heartbeat_timer_keeps_source_default_and_node_delay_conversion() {
    assert_eq!(
        heartbeat_period(&json!({"heartbeat":{"enabled":false,"minutes":30}})),
        None
    );
    assert_eq!(
        heartbeat_period(&json!({"heartbeat":{"enabled":true,"minutes":0}})),
        None
    );
    assert_eq!(
        heartbeat_period(&json!({"heartbeat":{"enabled":true,"minutes":30}})),
        Some(1_800_000)
    );
    assert_eq!(
        heartbeat_period(&json!({"heartbeat":{"enabled":true,"minutes":"0.5"}})),
        Some(30_000)
    );
    assert_eq!(
        heartbeat_period(&json!({"heartbeat":{"enabled":true,"minutes":0.000001}})),
        Some(1)
    );
    assert_eq!(
        heartbeat_period(&json!({"heartbeat":{"enabled":true,"minutes":100000}})),
        Some(1)
    );
}

#[test]
#[cfg(unix)] // Chrono's Windows Local zone follows the OS, not the TZ variable.
fn system_clock_matches_source_dst_and_local_date_shorthand() {
    const CHILD: &str = "TEPORA_SCHEDULER_ZONE_FIXTURE";
    if let Ok(index) = std::env::var(CHILD) {
        let index = index.parse::<usize>().unwrap();
        let fixture = fixture();
        let case = &fixture["zones"][index];
        assert_eq!(
            parse_when(
                case["at"].as_str().unwrap(),
                case["now"].as_i64().unwrap(),
                &SystemClock
            ),
            case["ms"].as_i64(),
            "{case}",
        );
        return;
    }
    for (index, case) in fixture()["zones"].as_array().unwrap().iter().enumerate() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "agent::scheduler::tests::system_clock_matches_source_dst_and_local_date_shorthand",
                "--nocapture",
            ])
            .env(CHILD, index.to_string())
            .env("TZ", case["zone"].as_str().unwrap())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{case}\n{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
