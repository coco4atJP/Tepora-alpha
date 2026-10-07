use super::*;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static TEST_ID: AtomicU64 = AtomicU64::new(0);

struct DatabaseFile(PathBuf);
impl DatabaseFile {
    fn new() -> Self {
        let id = TEST_ID.fetch_add(1, Ordering::Relaxed);
        let tick = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        Self(std::env::temp_dir().join(format!(
            "tepora-rust-{}-{tick}-{id}.sqlite",
            std::process::id()
        )))
    }
    fn open(&self) -> NativeState {
        NativeState::open(self.0.to_str().unwrap()).unwrap()
    }
}
impl Drop for DatabaseFile {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
        }
    }
}
fn invoke(state: &mut NativeState, op: &str, payload: Value) -> Value {
    state.call(op, payload).unwrap()
}
fn append(state: &mut NativeState, id: &str, text: &str) -> Value {
    invoke(
        state,
        "session.append",
        json!({"id":id,"type":"input","body":{"text":text,"unknownField":{"keep":true}},"at":"2026-10-07T00:00:00.000Z","terms":text}),
    )
}
fn enqueue(state: &mut NativeState, id: &str, session: &str, at: &str) {
    invoke(
        state,
        "inbox.enqueue",
        json!({"sessionId":session,"item":{"id":id,"at":at,"text":"hello"}}),
    );
}

#[test]
fn reopen_preserves_documents_settings_and_transcripts() {
    let file = DatabaseFile::new();
    let mut state = file.open();
    invoke(
        &mut state,
        "kv.set",
        json!({"key":"settings","value":{"allowCloud":false,"future":{"field":"value"}}}),
    );
    invoke(
        &mut state,
        "document.put",
        json!({"kind":"memory","doc":{"id":"m","content":"日本語 mixed","unknown":{"v":1}},"terms":"日本 本語 mixed"}),
    );
    append(&mut state, "main", "hello");
    invoke(&mut state, "close", json!({}));
    let mut reopened = file.open();
    assert_eq!(
        invoke(&mut reopened, "kv.get", json!({"key":"settings"}))["future"]["field"],
        "value"
    );
    assert_eq!(
        invoke(
            &mut reopened,
            "document.get",
            json!({"kind":"memory","id":"m"})
        )["unknown"]["v"],
        1
    );
    assert_eq!(
        invoke(
            &mut reopened,
            "document.search",
            json!({"kind":"memory","expression":"\"日本\""})
        )
        .as_array()
        .unwrap()
        .len(),
        1
    );
    assert_eq!(
        invoke(&mut reopened, "session.entry", json!({"id":"main","seq":1}))["unknownField"]
            ["keep"],
        true
    );
    assert_eq!(append(&mut reopened, "main", "later")["seq"], 2);
}

#[test]
fn appends_allocate_sequence_on_database_not_per_handle_cache() {
    let file = DatabaseFile::new();
    let mut a = file.open();
    let mut b = file.open();
    assert_eq!(append(&mut a, "s", "one")["seq"], 1);
    assert_eq!(append(&mut b, "s", "two")["seq"], 2);
    assert_eq!(append(&mut a, "s", "three")["seq"], 3);
    assert_eq!(invoke(&mut a, "session.seq", json!({"id":"s"})), 4);
    assert_eq!(append(&mut a, "another", "one")["seq"], 1);
    let tail = invoke(&mut b, "session.tail", json!({"id":"s","limit":2}));
    assert_eq!(tail[0]["text"], "two");
    assert_eq!(tail[1]["text"], "three");
}

#[test]
fn parallel_connections_append_without_duplicate_sequences() {
    let file = DatabaseFile::new();
    drop(file.open());
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let path = file.0.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut state = NativeState::open(path.to_str().unwrap()).unwrap();
                barrier.wait();
                for _ in 0..25 {
                    append(&mut state, "shared", "entry");
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    let mut state = file.open();
    let entries = invoke(&mut state, "session.entries", json!({"id":"shared"}));
    assert_eq!(entries.as_array().unwrap().len(), 50);
    assert_eq!(entries[49]["seq"], 50);
}

#[test]
fn inbox_consumption_is_atomic_scoped_and_ordered() {
    let mut state = NativeState::open(":memory:").unwrap();
    enqueue(&mut state, "later", "s", "b");
    enqueue(&mut state, "first", "s", "a");
    enqueue(&mut state, "second", "s", "a");
    enqueue(&mut state, "other", "other-session", "a");
    assert_eq!(
        invoke(
            &mut state,
            "inbox.takeItem",
            json!({"id":"s","itemId":"other"})
        ),
        false
    );
    let taken = invoke(&mut state, "inbox.take", json!({"id":"s"}));
    assert_eq!(
        taken
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["first", "second", "later"]
    );
    assert_eq!(
        invoke(&mut state, "inbox.take", json!({"id":"s"})),
        json!([])
    );
    assert_eq!(
        invoke(&mut state, "inbox.sessions", json!({})),
        json!(["other-session"])
    );
}

#[test]
fn inbox_take_rolls_back_when_delete_fails() {
    let mut state = NativeState::open(":memory:").unwrap();
    enqueue(&mut state, "one", "s", "a");
    invoke(
        &mut state,
        "exec",
        json!({"sql":"CREATE TRIGGER deny_delete BEFORE DELETE ON session_inbox BEGIN SELECT RAISE(ABORT,'fixture rejection'); END;"}),
    );
    assert!(state.call("inbox.take", json!({"id":"s"})).is_err());
    assert_eq!(
        invoke(&mut state, "inbox.pending", json!({"id":"s"}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
    invoke(
        &mut state,
        "exec",
        json!({"sql":"DROP TRIGGER deny_delete;"}),
    );
    assert_eq!(
        invoke(&mut state, "inbox.take", json!({"id":"s"}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn forgetting_memory_erases_fts_vectors_and_legacy_event_copies() {
    let mut state = NativeState::open(":memory:").unwrap();
    let doc = json!({"id":"secret","content":"private-unique"});
    invoke(
        &mut state,
        "document.put",
        json!({"kind":"memory","doc":doc,"terms":"private unique"}),
    );
    invoke(
        &mut state,
        "document.put",
        json!({"kind":"memory-vector","doc":{"id":"secret","vector":[1,2]}}),
    );
    let emitted = invoke(
        &mut state,
        "event.append",
        json!({"type":"memory.updated","data":doc,"at":"now"}),
    );
    assert_eq!(emitted["data"]["content"], "private-unique");
    let stored = invoke(
        &mut state,
        "sql",
        json!({"sql":"SELECT body FROM events","mode":"get"}),
    );
    assert_eq!(
        serde_json::from_str::<Value>(stored["body"].as_str().unwrap()).unwrap(),
        json!({"id":"secret"})
    );
    invoke(
        &mut state,
        "sql",
        json!({"sql":"INSERT INTO events(type,body,at) VALUES(?,?,?)","args":["memory.updated",doc.to_string(),"now"],"mode":"run"}),
    );
    invoke(
        &mut state,
        "document.remove",
        json!({"kind":"memory","id":"secret"}),
    );
    assert_eq!(
        invoke(
            &mut state,
            "document.get",
            json!({"kind":"memory-vector","id":"secret"})
        ),
        Value::Null
    );
    assert_eq!(
        invoke(
            &mut state,
            "document.search",
            json!({"kind":"memory","expression":"\"private\""})
        ),
        json!([])
    );
    assert_eq!(invoke(&mut state, "event.replay", json!({})), json!([]));
    assert_eq!(invoke(&mut state, "event.seq", json!({})), 2);
}

#[test]
fn failed_index_update_does_not_leave_a_partial_document_write() {
    let mut state = NativeState::open(":memory:").unwrap();
    invoke(
        &mut state,
        "exec",
        json!({"sql":"DROP TABLE content_search"}),
    );
    assert!(state
        .call(
            "document.put",
            json!({"kind":"memory","doc":{"id":"m","content":"keep atomic"},"terms":"atomic"})
        )
        .is_err());
    assert_eq!(
        invoke(
            &mut state,
            "document.get",
            json!({"kind":"memory","id":"m"})
        ),
        Value::Null
    );
}

#[test]
fn artifact_cas_retains_revision_and_rejects_stale_or_partial_update() {
    let mut state = NativeState::open(":memory:").unwrap();
    let doc = json!({"id":"a","title":"Doc","content":"one","kind":"text","jobId":null,"updatedAt":"now"});
    assert_eq!(
        invoke(
            &mut state,
            "artifact.put",
            json!({"doc":doc,"expectedVersion":0})
        )["version"],
        1
    );
    let mut second = doc.clone();
    second["content"] = json!("two");
    assert_eq!(
        invoke(
            &mut state,
            "artifact.put",
            json!({"doc":second,"expectedVersion":1})
        )["version"],
        2
    );
    let error = state
        .call("artifact.put", json!({"doc":doc,"expectedVersion":1}))
        .unwrap_err();
    assert!(error.to_string().starts_with("[409] "));
    assert_eq!(
        invoke(
            &mut state,
            "document.get",
            json!({"kind":"artifact","id":"a"})
        )["content"],
        "two"
    );
    assert_eq!(
        invoke(
            &mut state,
            "document.get",
            json!({"kind":"revision","id":"a:1"})
        )["content"],
        "one"
    );
    invoke(
        &mut state,
        "exec",
        json!({"sql":"CREATE TRIGGER deny_artifact BEFORE UPDATE ON documents WHEN NEW.kind='artifact' BEGIN SELECT RAISE(ABORT,'fixture rejection'); END;"}),
    );
    assert!(state
        .call("artifact.put", json!({"doc":doc,"expectedVersion":2}))
        .is_err());
    assert_eq!(
        invoke(
            &mut state,
            "document.get",
            json!({"kind":"revision","id":"a:2"})
        ),
        Value::Null
    );
}

#[test]
fn domain_savepoints_preserve_an_outer_application_transaction() {
    let mut state = NativeState::open(":memory:").unwrap();
    invoke(&mut state, "exec", json!({"sql":"BEGIN IMMEDIATE"}));
    invoke(
        &mut state,
        "document.put",
        json!({"kind":"job","doc":{"id":"job","status":"queued"},"terms":"queued"}),
    );
    append(&mut state, "s", "temporary");
    invoke(&mut state, "exec", json!({"sql":"ROLLBACK"}));
    assert_eq!(
        invoke(&mut state, "document.get", json!({"kind":"job","id":"job"})),
        Value::Null
    );
    assert_eq!(
        invoke(&mut state, "session.entries", json!({"id":"s"})),
        json!([])
    );
    assert_eq!(append(&mut state, "s", "durable")["seq"], 1);
}

#[test]
fn session_body_merge_patch_evidence_and_removal_match_existing_contract() {
    let mut state = NativeState::open(":memory:").unwrap();
    let entry = invoke(
        &mut state,
        "session.append",
        json!({"id":"s","type":"notice","body":{"text":"needle","at":"body-at","future":3},"at":"row-at","terms":"needle"}),
    );
    assert_eq!(entry["at"], "body-at");
    invoke(
        &mut state,
        "session.patch",
        json!({"id":"s","seq":1,"fields":{"withdrawn":true}}),
    );
    let patched = invoke(&mut state, "session.entry", json!({"id":"s","seq":1}));
    assert_eq!(patched["at"], "row-at");
    assert_eq!(patched["future"], 3);
    assert_eq!(patched["withdrawn"], true);
    invoke(
        &mut state,
        "evidence.put",
        json!({"id":"e","sessionId":"s","seq":1,"tool":"read","content":"full result","at":"now"}),
    );
    assert_eq!(
        invoke(&mut state, "evidence.get", json!({"id":"e"}))["content"],
        "full result"
    );
    assert_eq!(
        invoke(
            &mut state,
            "session.search",
            json!({"expression":"\"needle\"","sessionIds":["other"]})
        ),
        json!([])
    );
    assert_eq!(
        invoke(
            &mut state,
            "session.search",
            json!({"expression":"\"needle\""})
        )[0]["sessionId"],
        "s"
    );
    enqueue(&mut state, "input", "s", "now");
    invoke(
        &mut state,
        "document.put",
        json!({"kind":"session","doc":{"id":"s","kind":"main"}}),
    );
    invoke(&mut state, "session.remove", json!({"id":"s"}));
    assert_eq!(
        invoke(&mut state, "session.entries", json!({"id":"s"})),
        json!([])
    );
    assert_eq!(
        invoke(
            &mut state,
            "session.search",
            json!({"expression":"\"needle\""})
        ),
        json!([])
    );
    assert_eq!(
        invoke(&mut state, "evidence.get", json!({"id":"e"})),
        Value::Null
    );
    assert_eq!(
        invoke(&mut state, "inbox.pending", json!({"id":"s"})),
        json!([])
    );
    assert_eq!(
        invoke(
            &mut state,
            "document.get",
            json!({"kind":"session","id":"s"})
        ),
        Value::Null
    );
}

#[test]
fn update_keeps_document_row_order_and_close_is_idempotent() {
    let mut state = NativeState::open(":memory:").unwrap();
    for id in ["first", "last", "first"] {
        invoke(
            &mut state,
            "document.put",
            json!({"kind":"note","doc":{"id":id}}),
        );
    }
    let docs = invoke(&mut state, "document.list", json!({"kind":"note"}));
    assert_eq!(docs[0]["id"], "last");
    assert_eq!(docs[1]["id"], "first");
    invoke(&mut state, "close", json!({}));
    invoke(&mut state, "close", json!({}));
    assert!(state
        .call("event.seq", json!({}))
        .unwrap_err()
        .to_string()
        .contains("closed"));
}

#[test]
fn javascript_json_roundtrips_lone_surrogates_in_values_keys_and_legacy_rows() {
    let file = DatabaseFile::new();
    let mut state = file.open();
    let payload = r#"{"kind":"note","doc":{"id":"legacy","title":"cut emoji \ud83e","\udc00":"key","escaped":"\\ud83e","literal":"\ue000\ue13e"}}"#;
    let written = state.call_json("document.put", payload).unwrap();
    assert!(written.contains(r#""title":"cut emoji \ud83e""#));
    assert!(written.contains(r#""\udc00":"key""#));
    invoke(&mut state, "close", json!({}));
    let mut reopened = file.open();
    let read = reopened
        .call_json("document.get", r#"{"kind":"note","id":"legacy"}"#)
        .unwrap();
    assert_eq!(read, written);
    // An older JS implementation writes these exact escaped UTF-16 units.
    invoke(
        &mut reopened,
        "sql",
        json!({"sql":"INSERT INTO kv(key,value) VALUES(?,?)","args":["legacy",r#"{"text":"\ud800"}"#],"mode":"run"}),
    );
    assert_eq!(
        reopened.call_json("kv.get", r#"{"key":"legacy"}"#).unwrap(),
        r#"{"text":"\ud800"}"#
    );
    let raw = invoke(
        &mut reopened,
        "sql",
        json!({"sql":"SELECT body FROM documents WHERE id='legacy'","mode":"get"}),
    );
    assert_eq!(raw["body"], written);
}

#[test]
fn json_marker_collisions_do_not_change_sql_keys_identifiers_or_plain_text() {
    let mut state = NativeState::open(":memory:").unwrap();
    let id = "\u{e000}\u{e13e}\u{e000}";
    invoke(
        &mut state,
        "document.put",
        json!({"kind":"note","doc":{"id":id,"content":id}}),
    );
    assert_eq!(
        invoke(&mut state, "document.get", json!({"kind":"note","id":id}))["content"],
        id
    );
    assert_eq!(
        invoke(
            &mut state,
            "sql",
            json!({"sql":"SELECT id FROM documents","mode":"get"})
        )["id"],
        id
    );
    invoke(&mut state, "kv.set", json!({"key":id,"value":id}));
    assert_eq!(invoke(&mut state, "kv.get", json!({"key":id})), id);
    append(&mut state, id, "entry");
    invoke(
        &mut state,
        "evidence.put",
        json!({"id":id,"sessionId":id,"seq":1,"tool":"read","content":id,"at":id}),
    );
    let evidence = invoke(&mut state, "evidence.get", json!({"id":id}));
    assert_eq!(evidence["id"], id);
    assert_eq!(evidence["content"], id);
    assert_eq!(evidence["at"], id);
    enqueue(&mut state, "item", id, id);
    assert_eq!(invoke(&mut state, "inbox.sessions", json!({})), json!([id]));
    assert_eq!(
        invoke(
            &mut state,
            "session.search",
            json!({"expression":"\"entry\"","sessionIds":[id]})
        )[0]["sessionId"],
        id
    );
}

#[test]
fn full_precision_floats_and_legacy_fts_real_sequences_are_preserved() {
    let mut state = NativeState::open(":memory:").unwrap();
    let numbers = json!([51.248178375505404, -93.31137037688033]);
    invoke(
        &mut state,
        "kv.set",
        json!({"key":"numbers","value":numbers}),
    );
    assert_eq!(
        invoke(&mut state, "kv.get", json!({"key":"numbers"})),
        numbers
    );
    append(&mut state, "legacy", "needle");
    invoke(
        &mut state,
        "exec",
        json!({"sql":"UPDATE session_search SET seq=1.0 WHERE session_id='legacy'"}),
    );
    assert_eq!(
        invoke(
            &mut state,
            "session.search",
            json!({"expression":"\"needle\""})
        )[0]["seq"],
        1
    );
}

#[test]
fn session_patch_can_remove_undefined_javascript_fields_from_durable_body() {
    let mut state = NativeState::open(":memory:").unwrap();
    append(&mut state, "s", "hello");
    invoke(
        &mut state,
        "session.patch",
        json!({"id":"s","seq":1,"fields":{"withdrawn":true},"removeKeys":["text"]}),
    );
    let entry = invoke(&mut state, "session.entry", json!({"id":"s","seq":1}));
    assert!(entry.get("text").is_none());
    assert_eq!(entry["withdrawn"], true);
    assert_eq!(entry["unknownField"]["keep"], true);
}

#[test]
fn memory_recall_scans_unconfirmed_imports_once_and_enforces_sharing_and_limit() {
    let mut state = NativeState::open(":memory:").unwrap();
    for i in 0..256 {
        invoke(
            &mut state,
            "document.put",
            json!({"kind":"memory","doc":{"id":format!("import-{i}"),"content":"needle","confirmed":false,"scope":"shared"},"terms":"needle"}),
        );
    }
    invoke(
        &mut state,
        "document.put",
        json!({"kind":"job","doc":{"id":"not-memory","content":"needle","confirmed":true,"scope":"shared"},"terms":"needle"}),
    );
    for (id, scope) in [
        ("private", "private"),
        ("shared-one", "shared"),
        ("shared-two", "shared"),
    ] {
        invoke(
            &mut state,
            "document.put",
            json!({"kind":"memory","doc":{"id":id,"content":"needle","confirmed":true,"scope":scope},"terms":"needle"}),
        );
    }
    let local = invoke(
        &mut state,
        "memory.recall",
        json!({"expression":"\"needle\""}),
    );
    assert_eq!(local.as_array().unwrap().len(), 3);
    assert_eq!(
        invoke(
            &mut state,
            "memory.recall",
            json!({"expression":"\"needle\"","limit":2})
        )
        .as_array()
        .unwrap()
        .len(),
        2
    );
    assert_eq!(
        invoke(
            &mut state,
            "memory.recall",
            json!({"expression":"\"needle\"","cloud":true})
        ),
        json!([])
    );
    let shared = invoke(
        &mut state,
        "memory.recall",
        json!({"expression":"\"needle\"","cloud":true,"share":true}),
    );
    assert_eq!(shared.as_array().unwrap().len(), 2);
    assert!(shared
        .as_array()
        .unwrap()
        .iter()
        .all(|memory| memory["scope"] == "shared"));
    assert_eq!(
        invoke(
            &mut state,
            "memory.recall",
            json!({"expression":"\"needle\"","cloud":true,"share":true,"limit":1})
        )
        .as_array()
        .unwrap()
        .len(),
        1
    );
    // The original loop exits on its first unconfirmed row for limit zero.
    assert_eq!(
        invoke(
            &mut state,
            "memory.recall",
            json!({"expression":"\"needle\"","limit":0})
        ),
        json!([])
    );
}

#[test]
fn memory_recall_preserves_legacy_javascript_confirmation_truthiness() {
    let mut state = NativeState::open(":memory:").unwrap();
    for (i, confirmed) in [
        Value::Null,
        json!(false),
        json!(0),
        json!(0.0),
        json!(""),
        json!(true),
        json!(1),
        json!(-1),
        json!("false"),
        json!([]),
        json!({}),
    ]
    .into_iter()
    .enumerate()
    {
        invoke(
            &mut state,
            "document.put",
            json!({"kind":"memory","doc":{"id":format!("truthy-{i}"),"content":"needle","confirmed":confirmed,"scope":"shared"},"terms":"needle"}),
        );
    }
    let memories = invoke(
        &mut state,
        "memory.recall",
        json!({"expression":"\"needle\"","cloud":true,"share":true,"limit":100}),
    );
    let ids = memories
        .as_array()
        .unwrap()
        .iter()
        .map(|memory| memory["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        vec![
            "truthy-5",
            "truthy-6",
            "truthy-7",
            "truthy-8",
            "truthy-9",
            "truthy-10"
        ]
    );
}

#[test]
fn standalone_compute_api_retains_wire_contracts_without_node() {
    assert_eq!(compute_json("tokens.raw", r#"{"text":""}"#).unwrap(), "0");
    assert_eq!(
        compute_json("context.repairSequence", r#"{"messages":[]}"#).unwrap(),
        "[]"
    );
    assert_eq!(
        compute_json(
            "ui.jobStatus",
            r#"{"session":{"status":"done","accepted":true}}"#
        )
        .unwrap(),
        "\"completed\""
    );
    assert!(compute_json("missing.operation", "{}")
        .unwrap_err()
        .to_string()
        .contains("Unknown compute"));
}
