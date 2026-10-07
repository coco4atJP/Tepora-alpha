use super::super::files::FileMemory;
use super::*;

fn canonical(value: &Value) -> Value {
    json_codec::parse(&stringify_js(value).unwrap()).unwrap()
}
#[test]
fn frozen_node_record_tools_differential() {
    let fixtures = json_codec::parse(include_str!("source-fixtures.json")).unwrap();
    for case in fixtures.as_array().unwrap() {
        let plan = plan_receipts(
            &case["session"],
            case["calls"].as_array().unwrap(),
            case["outputs"].as_array().unwrap(),
            case["budget"].as_f64().unwrap(),
            &case["definitions"],
            &case["memory"],
            case["firstSeq"].as_u64().unwrap(),
        )
        .unwrap();
        let receipts=plan.receipts.iter().map(|r|json!({"seq":r.seq,"body":r.body,"evidence":r.evidence,"read_result":r.read_result})).collect::<Vec<_>>();
        assert_eq!(
            canonical(&json!({"receipts":receipts,"stats":plan.stats,"memory":plan.memory})),
            case["expected"],
            "{}",
            case["label"]
        );
        let mut files = FileMemory::default();
        for r in &plan.receipts {
            if let Some(read) = &r.read_result {
                files.record_read(r.seq, read);
            }
        }
    }
}
#[test]
fn planning_does_not_mutate_input_and_rejects_unpairable_outputs() {
    let session = json!({"id":"s","stats":{"toolCalls":1,"toolErrors":0}});
    let memory = json!({"calls":[],"errorStreak":0,"private":{"unchanged":true}});
    let old = (session.clone(), memory.clone());
    let calls = [json!({"id":"c","name":"read"})];
    let outputs = [
        json!({"args":{"path":"a"},"result":{"text":"okay","data":{"readKey":"a:1:800","mtimeMs":1.25,"size":4}},"ms":2}),
    ];
    let result = plan_receipts(&session, &calls, &outputs, 8000.0, &json!({}), &memory, 9).unwrap();
    assert_eq!((session, memory), old);
    assert_eq!(result.receipts[0].seq, 9);
    assert!(result.receipts[0].read_result.is_some());
    assert_eq!(result.memory["private"], json!({"unchanged":true}));
    assert!(plan_receipts(&json!({}), &calls, &[], 0.0, &json!({}), &json!({}), 1).is_err());
    assert!(plan_receipts(
        &json!({}),
        &[calls[0].clone(), calls[0].clone()],
        &[outputs[0].clone(), outputs[0].clone()],
        0.0,
        &json!({}),
        &json!({}),
        u64::MAX
    )
    .is_err());
}
#[test]
fn cancelled_success_remains_success_and_not_executed_prefix_wins() {
    let calls = [
        json!({"id":"1","name":"write"}),
        json!({"id":"2","name":"write"}),
    ];
    let outputs = [
        json!({"args":{},"result":{"text":"Wrote 2 bytes"},"interrupted":true}),
        json!({"args":{},"error":"stopped","interrupted":true,"notExecuted":true,"repaired":true}),
    ];
    let plan = plan_receipts(
        &json!({"id":"s","stats":{}}),
        &calls,
        &outputs,
        5000.0,
        &json!({}),
        &json!({}),
        1,
    )
    .unwrap();
    assert_eq!(plan.receipts[0].body["error"], false);
    assert!(plan.receipts[0].body["content"]
        .as_str()
        .unwrap()
        .ends_with("Wrote 2 bytes"));
    let text = plan.receipts[1].body["content"].as_str().unwrap();
    assert!(text.starts_with("[not executed: this call was not dispatched.]\n(note:"));
    assert!(!text.contains("terminated early"));
    assert_eq!(plan.receipts[1].body["interrupted"], true);
}
#[test]
fn minimum_evidence_budget_and_exact_utf16_arguments() {
    let args = json_codec::parse(&format!(r#"{{"content":"{}😀tail"}}"#, "a".repeat(599))).unwrap();
    let result = plan_receipts(
        &json!({"id":"s","stats":{}}),
        &[json!({"id":"c","name":"write"})],
        &[json!({"args":args,"result":{"text":"large result\n".repeat(2000)}})],
        0.0,
        &json!({}),
        &json!({}),
        5,
    )
    .unwrap();
    let r = &result.receipts[0];
    let bounded = utf16_units(r.body["args"]["content"].as_str().unwrap());
    assert_eq!(bounded.len(), 601);
    assert_eq!(&bounded[599..], &[0xd83d, 0x2026]);
    assert_eq!(r.body["evidenceId"], "s#5");
    assert!(r.body["content"]
        .as_str()
        .unwrap()
        .contains("recall(\"#5\""));
    assert_eq!(
        r.evidence.as_ref().unwrap()["content"],
        "large result\n".repeat(2000)
    );
}

#[test]
fn explicit_unicode_version_controls_small_result_keep_and_evidence_fit() {
    let session = json!({"id":"s","stats":{}});
    let calls = [json!({"id":"c","name":"read"})];
    let definitions = json!({});
    let memory = json!({});
    let plan = |text: String, version: u32| {
        plan_receipts_with_unicode(
            &session,
            &calls,
            &[json!({"args":{},"result":{"text":text}})],
            0.0,
            &definitions,
            &memory,
            1,
            version,
        )
        .unwrap()
    };
    // CJK extension J was unassigned in Unicode 16. Its existing 2 UTF-16
    // units cost 250 tokens here; Unicode 17's wide-script estimate is 525.
    let text = "\u{323b0}".repeat(400);
    let old = plan(text.clone(), 16);
    let current = plan(text.clone(), 17);
    assert_eq!(old.receipts[0].body["keep"], true);
    assert_eq!(current.receipts[0].body["keep"], false);
    assert!(old.receipts[0].evidence.is_none());
    assert!(current.receipts[0].evidence.is_none());
    let compatibility = plan_receipts(
        &session,
        &calls,
        &[json!({"args":{},"result":{"text":text}})],
        0.0,
        &definitions,
        &memory,
        1,
    )
    .unwrap();
    assert_eq!(compatibility.receipts[0].body, old.receipts[0].body);
    // The same selected version must also reach fitTokens: at the minimum
    // 600-token receipt budget only Unicode 17 truncates this 700-char result.
    let old = plan("\u{323b0}".repeat(700), 16);
    let current = plan("\u{323b0}".repeat(700), 17);
    assert!(old.receipts[0].evidence.is_none());
    assert!(current.receipts[0].evidence.is_some());
    assert!(current.receipts[0].body["content"]
        .as_str()
        .unwrap()
        .contains("recall(\"#1\""));
}
