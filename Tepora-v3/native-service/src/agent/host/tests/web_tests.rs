//! Actual web tools through actor permission, dynamic aliases and receipt commit.
//! The only web URL has a synthetic transport branch; no socket is opened.
use super::*;
pub(super) const FIXTURE_URL: &str = "http://127.0.0.1:17777/web-fixture";
pub(super) const FIXTURE_TEXT: &str =
    "Native web fixture article. This content is untrusted page evidence.";
fn fetch_call() -> Value {
    call(
        "fetch-fixture",
        "tools_call",
        json!({"name":"web_fetch","arguments":{"url":FIXTURE_URL}}),
    )
}
fn receipts(f: &Fixture, id: &str) -> Vec<Value> {
    f.entries(id)
        .into_iter()
        .filter(|e| e["type"] == "tool")
        .collect()
}

#[test]
fn dynamic_alias_web_approval_uses_final_name_and_commits_one_exact_receipt() {
    for allow in [true, false] {
        let mut f = Fixture::new(|_, index, wire| {
            if index == 0 {
                calls(vec![fetch_call()])
            } else {
                assert!(wire["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|m| m["role"] == "tool"));
                answer("Web fixture finished")
            }
        });
        let id = f.main()["id"].as_str().unwrap().to_owned();
        f.handle
            .request(AgentRequest::Configure {
                patch: json!({"policy":{"rules":[{"tool":"web_fetch","action":"ask"}]}}),
            })
            .unwrap();
        f.input("Read the synthetic web fixture after approval");
        f.wait("web approval", || {
            f.state("document.list", json!({"kind":"approval"}))
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a["status"] == "pending")
        });
        let approval = f.state("document.list", json!({"kind":"approval"}))[0].clone();
        assert_eq!(approval["tool"], "web_fetch");
        assert_eq!(approval["args"], json!({"url":FIXTURE_URL}));
        assert!(f.transport.web_requests.lock().unwrap().is_empty());
        f.handle
            .request(AgentRequest::DecideApproval {
                id: approval["id"].as_str().unwrap().into(),
                allow,
            })
            .unwrap();
        f.transport.wait_requests(2);
        f.idle(&id);
        let rows = receipts(&f, &id);
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row["callId"], "fetch-fixture");
        assert_eq!(row["name"], "web_fetch");
        assert_eq!(row["error"], !allow);
        if allow {
            assert_eq!(*f.transport.web_requests.lock().unwrap(), vec![FIXTURE_URL]);
            assert!(row["content"].as_str().unwrap().contains(FIXTURE_TEXT));
            assert_eq!(row["data"]["url"], FIXTURE_URL);
        } else {
            assert!(f.transport.web_requests.lock().unwrap().is_empty());
            assert_eq!(
                row["content"],
                "Error: The user declined this web_fetch call."
            );
            assert!(row.get("notExecuted").is_none());
        }
        assert_eq!(f.host.web.active_count(), 0);
        assert_eq!(f.host.network.active_count(), 0);
        f.close();
    }
}

#[test]
fn stop_inflight_web_request_drains_error_receipt_without_replay_or_success() {
    let mut f = Fixture::new(|_, index, _| {
        assert_eq!(index, 0, "Stopped web input must not replay");
        calls(vec![fetch_call()])
    });
    f.transport.web_block.store(true, Ordering::SeqCst);
    let id = f.main()["id"].as_str().unwrap().to_owned();
    f.input("Read the blocked synthetic web fixture");
    f.wait("blocked web request", || {
        f.transport.web_requests.lock().unwrap().len() == 1
    });
    assert_eq!(f.host.web.active_count(), 1);
    f.handle
        .request(AgentRequest::Stop {
            id: id.clone(),
            reason: "stop web fixture".into(),
            rearm_main: false,
        })
        .unwrap();
    f.idle(&id);
    let rows = receipts(&f, &id);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["callId"], "fetch-fixture");
    assert_eq!(rows[0]["error"], true);
    assert_ne!(
        rows[0]["notExecuted"], true,
        "A dispatched read must not claim it was never executed"
    );
    assert_eq!(f.host.web.active_count(), 0);
    assert_eq!(f.host.network.active_count(), 0);
    assert_eq!(f.transport.requests.lock().unwrap().len(), 1);
    assert_eq!(f.transport.web_requests.lock().unwrap().len(), 1);
    f.close();
}

#[test]
fn web_tool_search_metadata_and_offline_cache_flow_through_actor_receipts() {
    let mut f = Fixture::new(|_, index, _| match index {
        0 => calls(vec![
            call("search-web", "tools_search", json!({"query":"web fetch"})),
            fetch_call(),
        ]),
        1 => answer("First page read"),
        2 => calls(vec![fetch_call()]),
        _ => answer("Cached page read"),
    });
    let id = f.main()["id"].as_str().unwrap().to_owned();
    f.input("Find and read the synthetic page");
    f.transport.wait_requests(2);
    f.idle(&id);
    let rows = receipts(&f, &id);
    assert_eq!(rows.len(), 2);
    // Main now exposes its source fixed web tools directly. Registry search
    // excludes those already-present definitions, just as the source does.
    assert!(!rows[0]["content"]
        .as_str()
        .unwrap()
        .contains("## web_fetch (builtin)"));
    assert!(f.transport.requests.lock().unwrap()[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["function"]["name"] == "web_fetch"));
    f.host.network.update_policy(crate::network::NetworkPolicy {
        revision: 1,
        mode: crate::network::NetworkMode::Offline,
        internet_tools: true,
    });
    f.input("Read the cached synthetic page again");
    f.transport.wait_requests(4);
    f.idle(&id);
    let rows = receipts(&f, &id);
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[2]["error"], false);
    assert!(rows[2]["content"].as_str().unwrap().contains(FIXTURE_TEXT));
    assert_eq!(f.transport.web_requests.lock().unwrap().len(), 1);
    f.close();
}

#[test]
fn source_fixed_toolset_order_and_catalog_registration_are_preserved() {
    let f = Fixture::new(|_, _, _| answer("unused"));
    let fixture = json_codec::parse(include_str!("toolsets-source.json")).unwrap();
    for kind in ["main", "worker", "lean", "unknown"] {
        let source = &fixture["toolsets"][if kind == "unknown" { "worker" } else { kind }];
        let expected = source
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .filter(|name| f.host.tool_definition(name).is_some())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        assert_eq!(f.host.toolset(kind), expected, "{kind}");
    }
    let names = f
        .host
        .tool_catalog()
        .iter()
        .map(|d| d["name"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let position = |name| names.iter().position(|n| n == name).unwrap();
    assert!(position("edit") < position("web_search"));
    assert!(position("web_fetch") < position("todo"));
    assert!(position("tools_call") < position("reflect"));
}
