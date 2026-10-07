use super::*;
fn embedding(wire: &Value) -> Response {
    let vectors=wire["input"].as_array().unwrap().iter().enumerate().map(|(index,v)|{let t=v.as_str().unwrap();json!({"index":index,"embedding":if t.contains("coffee")||t.contains("珈琲"){vec![1.0,0.0]}else{vec![0.0,1.0]}})}).collect::<Vec<_>>();
    Response::Json(json!({"data":vectors}))
}
#[test]
fn actor_memory_search_uses_shared_semantic_space_and_commits_normal_tool_receipt() {
    let mut f = Fixture::new_semantic(|model, index, wire| {
        if model == "embedding" {
            return embedding(wire);
        }
        if index == 0 {
            calls(vec![call(
                "recall-concept",
                "memory_search",
                json!({"query":"珈琲"}),
            )])
        } else {
            assert!(json_codec::stringify_js(&wire["messages"])
                .unwrap()
                .contains("I enjoy coffee"));
            answer("remembered")
        }
    });
    f.state("document.put",json!({"kind":"memory","doc":{"id":"concept-fixture","content":"I enjoy coffee","title":"Preference","confirmed":true,"scope":"private"}}));
    f.runtime
        .as_ref()
        .unwrap()
        .block_on(f.semantic.as_ref().unwrap().index(
            crate::semantic::Access::default(),
            &RequestCancellation::new(),
        ))
        .unwrap();
    let id = f.input("Remember my preference")["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    f.idle(&id);
    let entries = f.entries(&id);
    let receipt = entries
        .iter()
        .find(|e| e["type"] == "tool" && e["name"] == "memory_search")
        .unwrap();
    assert_eq!(receipt["error"], false);
    assert!(receipt["content"]
        .as_str()
        .unwrap()
        .contains("I enjoy coffee"));
    assert_eq!(
        f.transport
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r["model"] == "embedding")
            .count(),
        2
    );
    f.close();
}
#[test]
fn memory_write_receipt_does_not_wait_for_bounded_index_and_normal_run_release_keeps_it() {
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let g = gate.clone();
    let mut f = Fixture::new_semantic(move |model, index, wire| {
        if model == "embedding" {
            return Response::Wait(g.clone(), Box::new(embedding(wire)));
        }
        if index == 0 {
            calls(vec![call(
                "remember",
                "memory_write",
                json!({"content":"I enjoy coffee","title":"Preference"}),
            )])
        } else {
            answer("saved")
        }
    });
    let id = f.input("Remember coffee")["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    f.idle(&id);
    f.wait("background index started", || {
        f.semantic.as_ref().unwrap().active_count() == 1
    });
    assert!(f
        .entries(&id)
        .iter()
        .any(|e| e["type"] == "tool" && e["name"] == "memory_write" && e["error"] == false));
    let memories = f.state("document.list", json!({"kind":"memory"}));
    assert_eq!(memories.as_array().unwrap().len(), 1);
    assert!(f
        .state(
            "document.get",
            json!({"kind":"memory-vector","id":memories[0]["id"]})
        )
        .is_null());
    gate.add_permits(1);
    f.wait("background publication after run release", || {
        !f.state(
            "document.get",
            json!({"kind":"memory-vector","id":memories[0]["id"]}),
        )
        .is_null()
    });
    f.close();
}
#[test]
fn failed_background_index_does_not_turn_saved_memory_into_a_failed_receipt() {
    let mut f = Fixture::new_semantic(|model, index, _| {
        if model == "embedding" {
            Response::Json(json!({"data":[]}))
        } else if index == 0 {
            calls(vec![call(
                "remember",
                "memory_write",
                json!({"content":"I enjoy tea"}),
            )])
        } else {
            answer("saved")
        }
    });
    let id = f.input("Remember tea")["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    f.idle(&id);
    assert!(f
        .entries(&id)
        .iter()
        .any(|e| e["type"] == "tool" && e["name"] == "memory_write" && e["error"] == false));
    assert_eq!(
        f.state("document.list", json!({"kind":"memory"}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
    f.close();
}

#[test]
fn model_arguments_cannot_grant_external_embedding_consent() {
    let mut f = Fixture::new_semantic(|model, index, _| {
        assert_ne!(
            model, "embedding",
            "Tool JSON cannot opt private queries into external embeddings"
        );
        if index == 0 {
            calls(vec![call(
                "recall",
                "memory_search",
                json!({"query":"coffee","consent":true,"allowExternal":true}),
            )])
        } else if index == 1 {
            calls(vec![call(
                "safe-recall",
                "memory_search",
                json!({"query":"coffee"}),
            )])
        } else {
            answer("recalled locally")
        }
    });
    f.capabilities.as_ref().unwrap().save(&json!({"profiles":[{"id":"embedding-fixture","protocol":"openai-embeddings","baseUrl":"http://10.0.0.2:17777/v1","model":"embedding","domain":"lan","pinnedAddress":"10.0.0.2","allowPlainHttp":true}],"routes":{"embedding":"embedding-fixture"}}),1).unwrap();
    f.state("document.put",json!({"kind":"memory","doc":{"id":"private-fixture","content":"private coffee preference","confirmed":true,"scope":"private"}}));
    let id = f.input("Recall my preference")["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    f.idle(&id);
    let entries = f.entries(&id);
    assert!(entries
        .iter()
        .any(|e| e["name"] == "memory_search" && e["error"] == true));
    assert!(entries.iter().any(|e| e["name"] == "memory_search"
        && e["error"] == false
        && e["content"]
            .as_str()
            .is_some_and(|s| s.contains("private coffee"))));
    assert!(f
        .transport
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(|r| r["model"] != "embedding"));
    f.close();
}
#[test]
fn fractional_tool_limit_is_rejected_without_embedding_egress() {
    let mut f = Fixture::new_semantic(|model, index, _| {
        assert_ne!(
            model, "embedding",
            "Invalid semantic limits must fail before inference"
        );
        if index == 0 {
            calls(vec![call(
                "recall",
                "memory_search",
                json!({"query":"coffee","limit":1.5}),
            )])
        } else {
            answer("local fallback")
        }
    });
    f.state("document.put",json!({"kind":"memory","doc":{"id":"private-fixture","content":"private coffee preference","confirmed":true,"scope":"private"}}));
    let id = f.input("Recall my preference")["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    f.idle(&id);
    assert!(f
        .entries(&id)
        .iter()
        .any(|e| e["name"] == "memory_search" && e["error"] == true));
    assert!(f
        .transport
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(|r| r["model"] != "embedding"));
    f.close();
}

#[test]
fn stop_cancels_background_index_without_retracting_saved_memory_receipt() {
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let g = gate.clone();
    let mut f = Fixture::new_semantic(move |model, index, wire| {
        if model == "embedding" {
            Response::Wait(g.clone(), Box::new(embedding(wire)))
        } else if index == 0 {
            calls(vec![call(
                "remember",
                "memory_write",
                json!({"content":"I enjoy coffee"}),
            )])
        } else {
            answer("saved")
        }
    });
    let id = f.input("Remember coffee")["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    f.idle(&id);
    f.wait("background embedding request", || {
        f.transport
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r["model"] == "embedding")
    });
    assert_eq!(f.semantic.as_ref().unwrap().active_count(), 1);
    f.handle
        .request(AgentRequest::Stop {
            id: id.clone(),
            reason: "test stop".into(),
            rearm_main: false,
        })
        .unwrap();
    f.wait("background cancellation", || {
        f.semantic.as_ref().unwrap().active_count() == 0
    });
    gate.add_permits(1);
    let memories = f.state("document.list", json!({"kind":"memory"}));
    assert_eq!(memories.as_array().unwrap().len(), 1);
    assert!(f
        .state(
            "document.get",
            json!({"kind":"memory-vector","id":memories[0]["id"]})
        )
        .is_null());
    assert!(f
        .entries(&id)
        .iter()
        .any(|e| e["name"] == "memory_write" && e["error"] == false));
    f.close();
}
