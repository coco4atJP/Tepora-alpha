//! Actual process tools through the shared Workspace, engines, approvals and
//! ordered receipt path. Scripts are fixed local fixtures with bounded timeout.
use super::*;

fn alias(id: &str, name: &str, args: Value) -> Value {
    call(id, "tools_call", json!({"name":name,"arguments":args}))
}
fn work(f: &Fixture) -> PathBuf {
    PathBuf::from(json_codec::sql_text(f.main()["cwd"].as_str().unwrap()))
}

#[test]
fn main_discovers_process_tools_and_commits_custom_and_alias_error_receipts() {
    let mut f = Fixture::new(|_, index, _| {
        if index == 0 {
            calls(vec![
                call("search", "tools_search", json!({"query":"shell command"})),
                alias(
                    "exec",
                    "exec",
                    json!({"command":"printf 'native bytes\\n' > process-result.txt; printf '%s' \"$TEPORA_SESSION\"","yield":2}),
                ),
                alias("invalid", "process", json!({"action":"invalid"})),
                alias("list", "process", json!({"action":"list"})),
            ])
        } else {
            answer("Created and verified the command result")
        }
    });
    let id = f.main()["id"].as_str().unwrap().to_owned();
    f.input("Run the local process fixture and show its registered tools");
    f.transport.wait_requests(2);
    f.idle(&id);
    assert_eq!(
        fs::read_to_string(work(&f).join("process-result.txt")).unwrap(),
        "native bytes\n"
    );
    let receipts = f
        .entries(&id)
        .into_iter()
        .filter(|e| e["type"] == "tool")
        .collect::<Vec<_>>();
    assert_eq!(
        receipts
            .iter()
            .map(|e| e["callId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["search", "exec", "invalid", "list"]
    );
    assert!(receipts[0]["content"]
        .as_str()
        .unwrap()
        .contains("## exec (builtin)"));
    assert_eq!(receipts[1]["error"], false);
    assert!(receipts[1]["stub"].as_str().unwrap().ends_with(" → exit 0"));
    assert!(receipts[1]["content"].as_str().unwrap().contains(&id));
    assert_eq!(receipts[2]["error"], true);
    assert_eq!(receipts[2]["ephemeralKey"], "process:list");
    assert_eq!(receipts[3]["ephemeralKey"], "process:list");
    assert_eq!(f.host.processes(&id)[0]["status"], "exited");
    assert_eq!(f.host.processes("unrelated"), json!([]));
    assert_eq!(f.host.process_host.descriptor_count(), 0);
    assert!(f.host.approved.lock().unwrap().is_empty());
    f.close();
}

#[test]
fn worker_prompt_has_source_tool_order_and_exec_completion_reports_to_parent() {
    let mut f = Fixture::new(|model, index, wire| {
        if model == "main" {
            return answer("PARENT_ACK");
        }
        if index == 0 {
            let names = wire["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|d| d["function"]["name"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(&names[..5], ["exec", "process", "read", "write", "edit"]);
            calls(vec![call(
                "worker-exec",
                "exec",
                json!({"command":"printf 'verified\\n' > worker-result.txt; cat worker-result.txt","yield":2}),
            )])
        } else {
            answer("PROCESS_WORKER_DONE: verified worker-result.txt")
        }
    });
    let parent = f.main()["id"].as_str().unwrap().to_owned();
    let worker = f.handle.request(AgentRequest::Spawn { body:json!({"task":"Create worker-result.txt and verify its actual bytes","title":"Process worker"}) }).unwrap();
    let id = worker["id"].as_str().unwrap().to_owned();
    f.wait("worker completion", || {
        f.state("session.get", json!({"id":id}))["status"] == "done"
    });
    f.wait("parent report", || {
        f.entries(&parent)
            .iter()
            .any(|e| e["type"] == "input" && e["kind"] == "report" && e["sessionId"] == id)
    });
    f.idle(&id);
    let cwd = PathBuf::from(json_codec::sql_text(worker["cwd"].as_str().unwrap()));
    assert_eq!(
        fs::read_to_string(cwd.join("worker-result.txt")).unwrap(),
        "verified\n"
    );
    let receipts = f
        .entries(&id)
        .into_iter()
        .filter(|e| e["type"] == "tool")
        .collect::<Vec<_>>();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0]["callId"], "worker-exec");
    assert_eq!(receipts[0]["error"], false);
    assert_eq!(&f.host.toolset("lean")[..2], ["exec", "read"]);
    assert!(!f
        .host
        .toolset("main")
        .iter()
        .any(|n| n == "exec" || n == "process"));
    assert!(f.host.approved.lock().unwrap().is_empty());
    f.close();
}

#[test]
fn process_approval_uses_exact_final_alias_args_and_stop_prevents_dispatch() {
    for allow in [true, false] {
        let args = json!({"command":"printf approved > process-approved.txt","yield":2});
        let captured = args.clone();
        let mut f = Fixture::new(move |_, index, _| {
            if index == 0 {
                calls(vec![alias("approved-exec", "exec", captured.clone())])
            } else {
                answer("Approval fixture ended")
            }
        });
        let id = f.main()["id"].as_str().unwrap().to_owned();
        f.handle
            .request(AgentRequest::Configure {
                patch: json!({"policy":{"rules":[{"tool":"exec","action":"ask"}]}}),
            })
            .unwrap();
        f.input("Execute after approval");
        f.wait("exec approval", || {
            f.state("document.list", json!({"kind":"approval"}))
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a["status"] == "pending")
        });
        let approval = f.state("document.list", json!({"kind":"approval"}))[0].clone();
        assert_eq!(approval["tool"], "exec");
        assert_eq!(approval["args"], args);
        assert_eq!(f.host.processes(&id), json!([]));
        assert!(!work(&f).join("process-approved.txt").exists());
        if allow {
            f.handle
                .request(AgentRequest::DecideApproval {
                    id: approval["id"].as_str().unwrap().into(),
                    allow: true,
                })
                .unwrap();
            f.transport.wait_requests(2);
        } else {
            f.handle
                .request(AgentRequest::Stop {
                    id: id.clone(),
                    reason: "withdraw process approval".into(),
                    rearm_main: true,
                })
                .unwrap();
        }
        f.idle(&id);
        let receipt = f
            .entries(&id)
            .into_iter()
            .find(|e| e["callId"] == "approved-exec")
            .unwrap();
        if allow {
            assert_eq!(
                fs::read_to_string(work(&f).join("process-approved.txt")).unwrap(),
                "approved"
            );
            assert_eq!(receipt["error"], false);
        } else {
            assert_eq!(receipt["notExecuted"], true);
            assert_eq!(f.host.processes(&id), json!([]));
            assert!(!work(&f).join("process-approved.txt").exists());
        }
        assert!(f.host.approved.lock().unwrap().is_empty());
        assert_eq!(f.host.process_host.descriptor_count(), 0);
        f.close();
    }
}

#[test]
fn stopped_background_process_blocks_fresh_model_request_until_actual_drain() {
    let mut f = Fixture::new(|_, index, _| match index {
        0 => calls(vec![alias(
            "background",
            "exec",
            json!({"command":"trap '' TERM; printf ready > barrier-ready.txt; /bin/sleep 60","background":true,"timeout":15}),
        )]),
        1 => Response::Block,
        _ => answer("RESUMED_AFTER_DRAIN"),
    });
    let id = f.main()["id"].as_str().unwrap().to_owned();
    f.input("Start a background process");
    f.transport.wait_requests(2);
    assert!(work(&f).join("barrier-ready.txt").exists());
    assert_eq!(f.host.processes(&id)[0]["status"], "running");
    f.handle
        .request(AgentRequest::Stop {
            id: id.clone(),
            reason: "stop background".into(),
            rearm_main: true,
        })
        .unwrap();
    f.idle(&id);
    f.input("New input after stop");
    thread::sleep(Duration::from_millis(200));
    assert_eq!(
        f.transport.requests.lock().unwrap().len(),
        2,
        "A new model request escaped the stopped-resource barrier"
    );
    assert_eq!(f.host.processes(&id)[0]["status"], "running");
    let started = Instant::now();
    assert!(f.handle.state(&id).is_ok());
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "Readiness blocked the FIFO actor"
    );
    f.transport.wait_requests(3);
    f.idle(&id);
    assert_eq!(f.host.processes(&id)[0]["status"], "killed");
    assert!(f
        .entries(&id)
        .iter()
        .any(|e| e["content"] == "RESUMED_AFTER_DRAIN"));
    f.close();
}

#[test]
fn close_waits_for_dispatched_exec_receipt_and_marks_queued_exec_not_executed() {
    let mut f = Fixture::new(|_, _, _| {
        calls(vec![
            alias(
                "held-exec",
                "exec",
                json!({"command":"trap '' TERM; printf ready > close-ready.txt; /bin/sleep 60","yield":600,"timeout":15}),
            ),
            alias(
                "queued-exec",
                "exec",
                json!({"command":"printf wrong > forbidden-result.txt","yield":2}),
            ),
        ])
    });
    let id = f.main()["id"].as_str().unwrap().to_owned();
    f.input("Run the close fixture");
    f.wait("dispatched process", || {
        work(&f).join("close-ready.txt").exists()
    });
    let close = f.handle.begin_close();
    thread::sleep(Duration::from_millis(100));
    assert!(!close.is_complete());
    assert!(matches!(
        Workspace::open(&f.dir),
        Err(ApiError { status: 409, .. })
    ));
    f.wait("process and receipt close drain", || close.is_complete());
    close.wait().unwrap();
    let receipts = f
        .entries(&id)
        .into_iter()
        .filter(|e| e["type"] == "tool")
        .collect::<Vec<_>>();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0]["callId"], "held-exec");
    assert_eq!(receipts[0]["interrupted"], true);
    assert_ne!(receipts[0]["notExecuted"], true);
    assert!(receipts[0]["stub"].as_str().unwrap().contains(" → exit "));
    assert_eq!(receipts[1]["callId"], "queued-exec");
    assert_eq!(receipts[1]["notExecuted"], true);
    assert!(!work(&f).join("forbidden-result.txt").exists());
    assert_eq!(f.host.processes(&id)[0]["status"], "killed");
    assert!(f.host.approved.lock().unwrap().is_empty());
    assert_eq!(f.host.process_host.descriptor_count(), 0);
    f.close();
}

#[test]
fn process_poll_log_and_kill_keep_the_same_owned_process_receipt_key() {
    let mut f = Fixture::new(|_, index, wire| {
        if index == 0 {
            return calls(vec![alias(
                "start",
                "exec",
                json!({"command":"printf output; /bin/sleep 10","background":true,"timeout":15}),
            )]);
        }
        if index == 1 {
            let content = wire["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|m| m["role"] == "tool")
                .find_map(|m| {
                    m["content"]
                        .as_str()
                        .filter(|t| t.contains("still running as process "))
                })
                .expect("Background receipt was not sent to the next model request");
            let id = content
                .split("as process ")
                .nth(1)
                .unwrap()
                .split_whitespace()
                .next()
                .unwrap();
            return calls(vec![
                alias("poll", "process", json!({"action":"poll","id":id,"wait":0})),
                alias("log", "process", json!({"action":"log","id":id,"offset":0})),
                alias("kill", "process", json!({"action":"kill","id":id})),
            ]);
        }
        answer("BACKGROUND_DRAINED")
    });
    let id = f.main()["id"].as_str().unwrap().to_owned();
    f.input("Run the background polling fixture");
    f.transport.wait_requests(3);
    f.idle(&id);
    let processes = f.host.processes(&id);
    assert_eq!(processes.as_array().unwrap().len(), 1);
    assert_eq!(processes[0]["status"], "killed");
    let pid = processes[0]["id"].as_str().unwrap();
    let receipts = f
        .entries(&id)
        .into_iter()
        .filter(|e| e["type"] == "tool")
        .collect::<Vec<_>>();
    assert_eq!(
        receipts
            .iter()
            .map(|e| e["callId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["start", "poll", "log", "kill"]
    );
    assert!(receipts.iter().all(|e| e["error"] == false), "{receipts:?}");
    assert!(receipts[0]["stub"]
        .as_str()
        .unwrap()
        .ends_with(&format!(" → running {pid}")));
    for receipt in &receipts[1..] {
        assert_eq!(receipt["ephemeralKey"], format!("process:{pid}"));
    }
    assert!(receipts[2]["content"].as_str().unwrap().contains("output"));
    assert!(f.host.approved.lock().unwrap().is_empty());
    assert_eq!(f.host.process_host.descriptor_count(), 0);
    f.close();
}
