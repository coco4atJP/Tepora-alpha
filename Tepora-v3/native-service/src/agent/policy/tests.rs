use super::*;
use tepora_core::json_codec;

#[test]
fn frozen_node_rule_and_regex_differential() {
    let fixtures = json_codec::parse(include_str!("source-fixtures.json")).unwrap();
    let mut differences = Vec::new();
    for case in fixtures.as_array().unwrap() {
        let compiled = CompiledPolicy::validate(&case["rules"]);
        if case["error"] == true {
            if compiled.is_ok() {
                differences.push(format!("{}: accepted invalid source rule", case["label"]));
            }
            continue;
        }
        let policy = match compiled {
            Ok(p) => p,
            Err(e) => {
                differences.push(format!("{}: compile: {}", case["label"], e.message));
                continue;
            }
        };
        if policy.normalized_rules() != case["normalized"] {
            differences.push(format!("{}: normalized rules differ", case["label"]));
        }
        let actual = policy
            .evaluate(case["name"].as_str().unwrap(), &case["args"])
            .unwrap();
        let actual = json!({"action":actual.action.as_str(),"note":actual.note,"rule":actual.rule});
        if actual != case["decision"] {
            differences.push(format!(
                "{}: expected {}, got {}",
                case["label"], case["decision"], actual
            ));
        }
    }
    assert!(
        differences.is_empty(),
        "{} differential failures:\n{}",
        differences.len(),
        differences.join("\n")
    );
}
#[test]
fn all_rules_compile_upfront_and_default_is_allow() {
    assert!(CompiledPolicy::validate(
        &json!([{"tool":"*","action":"allow"},{"tool":"never","action":"deny","match":"["}])
    )
    .is_err());
    assert_eq!(
        CompiledPolicy::default()
            .evaluate("write", &json!({}))
            .unwrap()
            .action,
        PolicyAction::Allow
    );
    assert!(
        CompiledPolicy::validate(&json!(vec![json!({"tool":"*","action":"ask"}); 101])).is_err()
    );
    assert!(CompiledPolicy::validate(
        &json!([{"tool":"*","action":"ask","match":"a".repeat(501)}])
    )
    .is_err());
}
#[test]
fn first_match_is_not_most_specific_and_wildcard_is_suffix_only() {
    let p = CompiledPolicy::validate(&json!([{"tool":"sess*","action":"ask","note":"approve"},{"tool":"sessions_send","action":"deny"}])).unwrap();
    let d = p.evaluate("sessions_send", &json!({})).unwrap();
    assert_eq!(d.action, PolicyAction::Ask);
    assert_eq!(d.rule_index, Some(0));
    assert_eq!(d.note, "approve");
    let p = CompiledPolicy::validate(&json!([{"tool":"ses*s","action":"deny"}])).unwrap();
    assert_eq!(
        p.evaluate("sessions", &json!({})).unwrap().action,
        PolicyAction::Allow
    );
    assert_eq!(
        p.evaluate("ses*s", &json!({})).unwrap().action,
        PolicyAction::Deny
    );
}
