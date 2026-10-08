//! Ordinary saved work and timer lifecycle through the real actor/Workspace.
//! Providers are deterministic in-memory fixtures; no external request is made.
use super::*;
use crate::agent::SchedulerKind;

fn tick(f: &Fixture, kind: SchedulerKind) -> Value {
    f.handle
        .request(AgentRequest::SchedulerTick { kind })
        .unwrap()
}
fn work(f: &Fixture) -> Value {
    let session = f.state(
        "session.create",
        json!({"fields":{"kind":"worker","title":"Completed research"}}),
    );
    f.state(
        "session.update",
        json!({"id":session["id"],"patch":{"status":"done","accepted":false}}),
    )
}
fn inputs(f: &Fixture, id: &str, kind: &str) -> Vec<Value> {
    f.entries(id)
        .into_iter()
        .filter(|e| e["type"] == "input" && e["kind"] == kind)
        .collect()
}

#[test]
fn saved_once_repeat_and_worker_tasks_deliver_once_through_actor() {
    let mut f = Fixture::new(|_, _, _| answer("NO_REPLY"));
    let main = f.main();
    let mut ids = Vec::new();
    for (text, mode, every) in [
        ("once reminder", "remind", Value::Null),
        ("recurring reminder", "remind", json!(5)),
        ("scheduled worker", "task", Value::Null),
    ] {
        let added = f.host.scheduler_tool(&main, &json!({"action":"add","text":text,"at":"2026-01-01T00:00:00Z","mode":mode,"every_minutes":every})).unwrap();
        ids.push(added["data"]["id"].as_str().unwrap().to_owned());
    }
    tick(&f, SchedulerKind::Schedules);
    let id = main["id"].as_str().unwrap();
    f.wait("reminders delivered", || {
        inputs(&f, id, "reminder").len() == 2
    });
    let workers = array(&f.state("session.list", json!({"kind":"worker"})));
    assert_eq!(workers.len(), 1);
    let worker = workers[0]["id"].as_str().unwrap();
    f.wait("task delivered", || inputs(&f, worker, "task").len() == 1);
    assert_eq!(inputs(&f, worker, "task")[0]["from"], "schedule");
    let remaining = array(&f.state("document.list", json!({"kind":"schedule"})));
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0]["id"], ids[1]);
    assert_eq!(remaining[0]["fired"], 1);
    tick(&f, SchedulerKind::Schedules);
    assert_eq!(inputs(&f, id, "reminder").len(), 2);
    assert_eq!(
        f.state("session.list", json!({"kind":"worker"}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
    f.close();
}

#[test]
fn persisted_future_cancel_and_startup_due_tick_preserve_documents() {
    let mut f = Fixture::new(|_, _, _| answer("NO_REPLY"));
    let main = f.main();
    let added = f
        .host
        .scheduler_tool(
            &main,
            &json!({"action":"add","text":"cancelled future","in_minutes":10}),
        )
        .unwrap();
    let cancelled = f
        .host
        .scheduler_tool(&main, &json!({"action":"cancel","id":added["data"]["id"]}))
        .unwrap();
    assert!(cancelled["text"]
        .as_str()
        .unwrap()
        .starts_with("Cancelled sch_"));
    f.host
        .scheduler_tool(
            &main,
            &json!({"action":"add","text":"startup reminder","at":"2026-01-01T00:00:00Z"}),
        )
        .unwrap();
    f.handle.request(AgentRequest::Initialize).unwrap();
    let id = main["id"].as_str().unwrap();
    f.wait("startup schedule delivered", || {
        inputs(&f, id, "reminder").len() == 1
    });
    assert_eq!(
        f.state("document.list", json!({"kind":"schedule"})),
        json!([])
    );
    assert_eq!(inputs(&f, id, "reminder")[0]["text"], "startup reminder");
    f.close();
}

#[test]
fn heartbeat_ignores_empty_and_progress_only_state() {
    let mut f = Fixture::new(|_, _, _| answer("NO_REPLY"));
    let id = f.main()["id"].as_str().unwrap().to_owned();
    assert_eq!(tick(&f, SchedulerKind::Heartbeat), false);
    assert_eq!(f.transport.requests.lock().unwrap().len(), 0);
    let worker = work(&f);
    assert_eq!(tick(&f, SchedulerKind::Heartbeat), true);
    f.wait("check-in delivered", || {
        inputs(&f, &id, "heartbeat").len() == 1
    });
    f.idle(&id);
    f.state(
        "session.update",
        json!({"id":worker["id"],"patch":{"stats":{"steps":999},"note":"more progress"}}),
    );
    assert_eq!(tick(&f, SchedulerKind::Heartbeat), false);
    assert_eq!(inputs(&f, &id, "heartbeat").len(), 1);
    f.close();
}

#[test]
fn heartbeat_low_decision_score_suppresses_main_inference() {
    let mut f = Fixture::new_decisions(|model, _, _| {
        assert_eq!(model, "decision");
        Response::Json(json!({"answers":{"q":{"type":"noul","noul":0.1}}}))
    });
    work(&f);
    assert_eq!(tick(&f, SchedulerKind::Heartbeat), false);
    assert_eq!(f.transport.requests.lock().unwrap().len(), 1);
    let id = f.main()["id"].as_str().unwrap().to_owned();
    assert!(inputs(&f, &id, "heartbeat").is_empty());
    f.close();
}

#[test]
fn enabled_custom_heartbeat_timer_starts_and_configuration_stops_it() {
    let mut f = Fixture::new(|_, _, _| answer("NO_REPLY"));
    let id = f.main()["id"].as_str().unwrap().to_owned();
    f.handle
        .request(AgentRequest::Configure {
            patch: json!({"heartbeat":{"enabled":true,"minutes":0.001,"text":"Custom check-in"}}),
        })
        .unwrap();
    f.wait("configured heartbeat timer", || {
        inputs(&f, &id, "heartbeat").len() == 1
    });
    f.idle(&id);
    assert!(inputs(&f, &id, "heartbeat")[0]["text"]
        .as_str()
        .unwrap()
        .starts_with("Custom check-in"));
    f.handle
        .request(AgentRequest::Configure {
            patch: json!({"heartbeat":{"enabled":false}}),
        })
        .unwrap();
    work(&f); // A changed state would produce a second check-in if still armed.
    thread::sleep(Duration::from_millis(150));
    assert_eq!(inputs(&f, &id, "heartbeat").len(), 1);
    f.close();
}

#[test]
fn configuration_cancels_inflight_heartbeat_before_delivery() {
    let mut f = Fixture::new_decisions(|model, _, _| {
        assert_eq!(model, "decision");
        Response::Block
    });
    work(&f);
    let handle = f.handle.clone();
    let request = thread::spawn(move || {
        handle.request(AgentRequest::SchedulerTick {
            kind: SchedulerKind::Heartbeat,
        })
    });
    f.transport.wait_requests(1);
    f.handle
        .request(AgentRequest::Configure {
            patch: json!({"heartbeat":{"enabled":false}}),
        })
        .unwrap();
    assert_eq!(request.join().unwrap().unwrap_err().status, 409);
    let id = f.main()["id"].as_str().unwrap().to_owned();
    assert!(inputs(&f, &id, "heartbeat").is_empty());
    assert_eq!(f.state("inbox.pending", json!({"id":id})), json!([]));
    f.close();
}

#[test]
fn shutdown_drains_heartbeat_decision_without_late_delivery() {
    let mut f = Fixture::new_decisions(|model, _, _| {
        assert_eq!(model, "decision");
        Response::Block
    });
    work(&f);
    let handle = f.handle.clone();
    let request = thread::spawn(move || {
        handle.request(AgentRequest::SchedulerTick {
            kind: SchedulerKind::Heartbeat,
        })
    });
    f.transport.wait_requests(1);
    let close = f.handle.begin_close();
    f.wait("heartbeat close drain", || close.is_complete());
    close.wait().unwrap();
    assert_eq!(request.join().unwrap().unwrap_err().status, 503);
    let id = f.main()["id"].as_str().unwrap().to_owned();
    assert!(inputs(&f, &id, "heartbeat").is_empty());
    assert_eq!(f.transport.live.load(Ordering::SeqCst), 0);
    f.close();
}

#[test]
fn failed_saved_task_is_consumed_once_with_failure_event() {
    let mut f = Fixture::new(|_, _, _| panic!("Failed task must not invoke a model"));
    let main = f.main();
    f.state("document.put", json!({"kind":"schedule","doc":{"id":"bad-task","mode":"task","text":"   ","at":"2026-01-01T00:00:00Z","every":null,"fired":0}}));
    tick(&f, SchedulerKind::Schedules);
    assert_eq!(
        f.state("document.list", json!({"kind":"schedule"})),
        json!([])
    );
    assert!(f
        .entries(main["id"].as_str().unwrap())
        .iter()
        .any(|e| e["event"] == "schedule-failed"));
    tick(&f, SchedulerKind::Schedules);
    assert_eq!(
        f.entries(main["id"].as_str().unwrap())
            .iter()
            .filter(|e| e["event"] == "schedule-failed")
            .count(),
        1
    );
    f.close();
}

#[test]
fn cancelled_heartbeat_rechecks_unchanged_work_after_configuration() {
    for patch in [
        json!({"maxParallel":2}),
        json!({"heartbeat":{"enabled":false}}),
    ] {
        let mut f = Fixture::new_decisions(|model, index, _| {
            assert_eq!(model, "decision");
            if index == 0 {
                Response::Block
            } else {
                Response::Json(json!({"answers":{"q":{"type":"noul","noul":0.1}}}))
            }
        });
        work(&f);
        let handle = f.handle.clone();
        let request = thread::spawn(move || {
            handle.request(AgentRequest::SchedulerTick {
                kind: SchedulerKind::Heartbeat,
            })
        });
        f.transport.wait_requests(1);
        f.handle.request(AgentRequest::Configure { patch }).unwrap();
        assert_eq!(request.join().unwrap().unwrap_err().status, 409);
        // Rearming must preserve the need to examine this still-undelivered work.
        f.handle
            .request(AgentRequest::Configure {
                patch: json!({"heartbeat":{"enabled":true,"minutes":60}}),
            })
            .unwrap();
        assert_eq!(tick(&f, SchedulerKind::Heartbeat), false);
        assert_eq!(f.transport.requests.lock().unwrap().len(), 2);
        assert_eq!(tick(&f, SchedulerKind::Heartbeat), false);
        assert_eq!(
            f.transport.requests.lock().unwrap().len(),
            2,
            "Settled verdict still deduplicates"
        );
        f.close();
    }
}
