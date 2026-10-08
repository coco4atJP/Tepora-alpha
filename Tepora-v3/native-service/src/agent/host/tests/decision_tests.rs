//! Real actor + Workspace + shared Capabilities + checked SystemOne protocol.
use super::*;
fn score(p: f64) -> Response {
    Response::Json(json!({"answers":{"q":{"type":"noul","noul":p}}}))
}
fn gate() -> Arc<tokio::sync::Semaphore> {
    Arc::new(tokio::sync::Semaphore::new(0))
}
fn wait_response(gate: &Arc<tokio::sync::Semaphore>, response: Response) -> Response {
    Response::Wait(gate.clone(), Box::new(response))
}
fn decisions(f: &Fixture, id: &str) -> Vec<Value> {
    f.entries(id)
        .into_iter()
        .filter(|e| e["event"] == "decision")
        .collect()
}
#[test]
fn route_before_chat_releases_low_probability_reply_and_records_label() {
    let chat = gate();
    let g = chat.clone();
    let mut f = Fixture::new_decisions(move |model, _, _| {
        if model == "decision" {
            score(0.1)
        } else {
            wait_response(&g, sse_answer(&["ordinary answer"]))
        }
    });
    let id = f.input("hello")["sessionId"].as_str().unwrap().to_owned();
    f.transport.wait_requests(2);
    f.wait("verdict settled", || {
        f.host.decision_host.decisions.health()["active"] == 0
    });
    chat.add_permits(1);
    f.idle(&id);
    let entries = f.entries(&id);
    assert!(entries.iter().any(|e| e["type"] == "assistant"
        && e["content"] == "ordinary answer"
        && e["withdrawn"] != true));
    assert_eq!(decisions(&f, &id).len(), 1);
    assert_eq!(decisions(&f, &id)[0]["action"], 0);
    assert!(entries
        .iter()
        .any(|e| e["event"] == "decision-label" && e["source"] == "answered" && e["label"] == 0));
    assert_eq!(f.state("session.list", json!({"kind":"worker"})), json!([]));
    f.close();
}
#[test]
fn late_high_verdict_holds_reply_then_delegates_once_with_origin() {
    let decision = gate();
    let g = decision.clone();
    let mut f = Fixture::new_decisions(move |model, index, _| match model {
        "decision" => wait_response(&g, score(0.95)),
        "main" if index == 0 => sse_answer(&["premature ", "answer"]),
        "main" => answer("NO_REPLY"),
        _ => Response::Block,
    });
    let mut events = f
        .workspace
        .subscribe(EventRequest {
            since: 0,
            reconnect: false,
        })
        .unwrap();
    let id = f.input("Build a verified report")["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    f.wait("held main turn", || {
        f.entries(&id).iter().any(|e| e["type"] == "assistant")
    });
    while let Ok(e) = events.receiver.try_recv() {
        if e.event_type == "agent.delta" {
            assert_eq!(e.data["text"], "", "A held delta leaked before the verdict");
        }
        assert_ne!(e.event_type, "agent.reply");
    }
    decision.add_permits(1);
    f.wait("worker admitted", || {
        !array(&f.state("session.list", json!({"kind":"worker"}))).is_empty()
    });
    f.idle(&id);
    let entries = f.entries(&id);
    assert!(entries
        .iter()
        .any(|e| e["content"] == "premature answer" && e["withdrawn"] == true));
    let episodes = decisions(&f, &id);
    assert_eq!(episodes.len(), 1);
    assert_eq!(episodes[0]["action"], 1);
    let workers = f.state("session.list", json!({"kind":"worker"}));
    assert_eq!(workers.as_array().unwrap().len(), 1);
    assert_eq!(
        workers[0]["origin"],
        json!({"sessionId":id,"episode":episodes[0]["seq"]})
    );
    assert!(entries.iter().any(|e| e["event"] == "auto-delegated"));
    f.close();
}
#[test]
fn failed_decision_releases_chat_without_an_episode() {
    let mut f = Fixture::new_decisions(|model, _, _| {
        if model == "decision" {
            Response::Json(json!({"invalid":true}))
        } else {
            sse_answer(&["fallback reply"])
        }
    });
    let id = f.input("hello")["sessionId"].as_str().unwrap().to_owned();
    f.idle(&id);
    assert!(f
        .entries(&id)
        .iter()
        .any(|e| e["content"] == "fallback reply" && e["withdrawn"] != true));
    assert!(decisions(&f, &id).is_empty());
    f.close();
}
#[test]
fn pending_decision_does_not_delay_tool_execution_or_duplicate_manual_spawn() {
    let decision = gate();
    let g = decision.clone();
    let mut f = Fixture::new_decisions(move |model, index, _| match model {
        "decision" => wait_response(&g, score(0.99)),
        "main" if index == 0 => calls(vec![call(
            "spawn",
            "sessions_spawn",
            json!({"task":"explicit work"}),
        )]),
        "main" => answer("I started it"),
        _ => Response::Block,
    });
    let id = f.input("do work")["sessionId"].as_str().unwrap().to_owned();
    f.wait("tool committed before decision", || {
        f.entries(&id)
            .iter()
            .any(|e| e["type"] == "tool" && e["name"] == "sessions_spawn")
    });
    assert_eq!(
        array(&f.state("session.list", json!({"kind":"worker"}))).len(),
        1
    );
    decision.add_permits(1);
    f.idle(&id);
    assert_eq!(
        array(&f.state("session.list", json!({"kind":"worker"}))).len(),
        1
    );
    assert!(f
        .entries(&id)
        .iter()
        .any(|e| e["event"] == "decision-label" && e["source"] == "character" && e["label"] == 1));
    f.close();
}
#[test]
fn stop_while_verdict_held_rejects_old_epoch_and_new_input_routes_fresh() {
    let old = gate();
    let g = old.clone();
    let mut f = Fixture::new_decisions(move |model, index, _| {
        if model == "decision" {
            if index == 0 {
                wait_response(&g, score(0.99))
            } else {
                score(0.0)
            }
        } else {
            answer("current answer")
        }
    });
    let id = f.input("old task")["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    f.wait("first assistant", || {
        f.entries(&id).iter().any(|e| e["type"] == "assistant")
    });
    f.handle
        .request(AgentRequest::Stop {
            id: id.clone(),
            reason: "stop held".into(),
            rearm_main: true,
        })
        .unwrap();
    f.idle(&id);
    old.add_permits(1);
    f.input("new message");
    f.idle(&id);
    assert_eq!(
        array(&f.state("session.list", json!({"kind":"worker"}))).len(),
        0
    );
    let episodes = decisions(&f, &id);
    assert_eq!(episodes.len(), 1);
    assert!(episodes[0]["state"]
        .as_str()
        .unwrap()
        .contains("new message"));
    f.close();
}
#[test]
fn shared_capability_revocation_releases_held_reply_without_delegation() {
    let decision = gate();
    let g = decision.clone();
    let mut f = Fixture::new_decisions(move |model, _, _| {
        if model == "decision" {
            wait_response(&g, score(0.99))
        } else {
            answer("answer survives revocation")
        }
    });
    let id = f.input("task")["sessionId"].as_str().unwrap().to_owned();
    f.transport.wait_requests(2);
    f.capabilities
        .as_ref()
        .unwrap()
        .save(&json!({"profiles":[],"routes":{}}), 1)
        .unwrap();
    f.idle(&id);
    assert!(decisions(&f, &id).is_empty());
    assert_eq!(f.host.decision_host.decisions.health()["failures"], 0);
    f.close();
}
#[test]
fn worker_completion_uses_shared_typed_decision_and_records_episode() {
    let mut f = Fixture::new_decisions(|model, index, _| match model {
        "decision" => score(if index == 0 { 0.1 } else { 0.9 }),
        "worker" if index == 0 => calls(vec![call("evidence", "sessions_list", json!({}))]),
        "worker" => answer(if index == 1 {
            "unchecked claim"
        } else {
            "verified result"
        }),
        _ => answer("NO_REPLY"),
    });
    let child = f
        .handle
        .request(AgentRequest::Spawn {
            body: json!({"task":"do work"}),
        })
        .unwrap();
    let id = child["id"].as_str().unwrap();
    f.idle(id);
    let episodes = decisions(&f, id);
    assert_eq!(episodes.len(), 1);
    assert_eq!(episodes[0]["kind"], "completion");
    assert_eq!(episodes[0]["action"], 0);
    assert!(f
        .entries(id)
        .iter()
        .any(|e| e["event"] == "completion-check" && e["method"] == "decision"));
    assert_eq!(
        f.state("session.get", json!({"id":id}))["result"],
        "verified result"
    );
    f.close();
}

#[test]
fn newer_input_in_same_run_invalidates_old_route_version() {
    let first_chat = gate();
    let chat = first_chat.clone();
    let old_decision = gate();
    let old = old_decision.clone();
    let mut f = Fixture::new_decisions(move |model, index, _| match model {
        "decision" if index == 0 => wait_response(&old, score(0.99)),
        "decision" => score(0.0),
        "main" if index == 0 => {
            wait_response(&chat, calls(vec![call("list", "sessions_list", json!({}))]))
        }
        _ => answer("latest answer"),
    });
    let id = f.input("old request")["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    f.transport.wait_requests(2);
    f.input("new request");
    first_chat.add_permits(1);
    f.idle(&id);
    old_decision.add_permits(1);
    let episodes = decisions(&f, &id);
    assert_eq!(episodes.len(), 1);
    assert!(episodes[0]["state"]
        .as_str()
        .unwrap()
        .contains("new request"));
    assert_eq!(
        array(&f.state("session.list", json!({"kind":"worker"}))).len(),
        0
    );
    f.close();
}
#[test]
fn close_during_held_verdict_cancels_transport_and_never_spawns() {
    let mut f = Fixture::new_decisions(|model, _, _| {
        if model == "decision" {
            Response::Block
        } else {
            sse_answer(&["held"])
        }
    });
    let id = f.input("close this pending task")["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    f.wait("held assistant", || {
        f.entries(&id).iter().any(|e| e["type"] == "assistant")
    });
    let close = f.handle.begin_close();
    f.wait("close drained", || close.is_complete());
    close.wait().unwrap();
    assert!(decisions(&f, &id).is_empty());
    assert_eq!(
        array(&f.state("session.list", json!({"kind":"worker"}))).len(),
        0
    );
    assert_eq!(f.host.network.active_count(), 0);
    f.close();
}

#[test]
fn live_capability_save_switches_the_next_route_without_a_second_registry() {
    let mut f = Fixture::new_decisions(|model, _, _| {
        if model.starts_with("decision") {
            score(0.05)
        } else {
            answer("answer")
        }
    });
    let id = f.input("first message")["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    f.idle(&id);
    let cap = f.capabilities.as_ref().unwrap();
    let config = json!({"profiles":[{"id":"decision-fixture","protocol":"system-one","baseUrl":"http://127.0.0.1:17777/v1","model":"decision-rotated","domain":"device","resource":"decision-fixture"}],"routes":{"decision":"decision-fixture"}});
    cap.save(&config, 1).unwrap();
    f.input("second message");
    f.idle(&id);
    let requests = f.transport.requests.lock().unwrap();
    assert_eq!(
        requests.iter().filter(|r| r["model"] == "decision").count(),
        1
    );
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["model"] == "decision-rotated")
            .count(),
        1
    );
    drop(requests);
    assert_eq!(decisions(&f, &id).len(), 2);
    f.close();
}

#[test]
fn settled_high_score_cannot_delegate_after_shared_owner_change() {
    for change in ["removed", "endpoint", "route", "key-replaced", "key-removed"] {
        let chat = gate();
        let g = chat.clone();
        let mut f = Fixture::new_decisions(move |model, _, _| {
            if model == "decision" { score(0.99) } else { wait_response(&g, answer("current reply")) }
        });
        let cap = f.capabilities.as_ref().unwrap().clone();
        let p = cap.pin("decision").unwrap();
        cap.set_key("decision-fixture", &json!("initial-secret"), &p["identity"]).unwrap();
        let id = f.input("hold chat until owner changes")["sessionId"].as_str().unwrap().to_owned();
        f.transport.wait_requests(2);
        f.wait("high decision settled", || f.host.decision_host.decisions.health()["active"] == 0);
        let binding = f.host.decision_host.decisions.binding();
        match change {
            "key-replaced" | "key-removed" => {
                cap.set_key("decision-fixture", &json!(if change == "key-replaced" { "replacement-secret" } else { "" }), &p["identity"]).unwrap();
                assert_eq!(cap.get().unwrap()["revision"], 1);
            }
            _ => {
                let mut registry = json!({"profiles":[{"id":"decision-fixture","protocol":"system-one","baseUrl":"http://127.0.0.1:17777/v1","model":"decision","domain":"device","resource":"decision-fixture"}],"routes":{"decision":"decision-fixture"}});
                if change == "endpoint" { registry["profiles"][0]["baseUrl"] = json!("http://127.0.0.1:18888/v1"); }
                if change == "route" { registry["routes"] = json!({}); }
                if change == "removed" { registry = json!({"profiles":[],"routes":{}}); }
                cap.save(&registry, 1).unwrap();
            }
        }
        assert_ne!(binding, f.host.decision_host.decisions.binding(), "{change}");
        assert!(!binding.to_string().contains("secret"));
        chat.add_permits(1);
        f.idle(&id);
        assert!(decisions(&f, &id).is_empty(), "{change}");
        assert!(array(&f.state("session.list", json!({"kind":"worker"}))).is_empty(), "{change}");
        f.close();
    }
}

#[test]
fn host_close_drains_retained_routes_and_rejects_later_decision_work() {
    let mut f = Fixture::new_decisions(|model, _, _| {
        if model == "decision" { Response::Block } else { answer("held answer") }
    });
    let id = f.input("pending route")["sessionId"].as_str().unwrap().to_owned();
    f.transport.wait_requests(2);
    assert!(f.host.decision_host.held(&id));
    f.host.close().unwrap();
    assert!(!f.host.decision_host.held(&id));
    assert_eq!(f.host.decision_host.decisions.health()["closed"], true);
    assert!(!f.host.decision_host.decisions.available());
    let result = f.runtime.as_ref().unwrap().block_on(f.host.decision_host.decisions.decide(
        &json!({}), &json!([]), &RequestCancellation::new()));
    assert!(result.unwrap_err().invalidated);
    f.close();
}

#[test]
fn legacy_constructor_keeps_configured_decision_unavailable_without_shared_owner() {
    let f = Fixture::new(|_, _, _| panic!("Preflight must not call a model"));
    f.state("kv.set", json!({"key":"capabilities","value":{"schema":1,"revision":0,"profiles":[],"routes":{"decision":"configured"}}}));
    let error = f.host.preflight().unwrap_err();
    assert_eq!(error.status, 503);
    assert!(error.message.contains("shared native Capabilities decision owner"));
    assert!(!f.host.decision_host.decisions.available());
    assert!(f.transport.requests.lock().unwrap().is_empty());
}
