//! First-match native approval rules. This is only the pure matcher; the single
//! state owner persists approvals and owns decisions, cancellation and notes.
//!
//! Patterns are ECMAScript non-Unicode RegExp strings, not Rust regex syntax.
//! regress is fed UTF-16 *code units* both when parsing and when searching its
//! UCS-2 API, so astral/lone-surrogate behavior matches new RegExp(pattern,'i').
//! Every rule is compiled at admission, including rules after an unconditional
//! allow. Invalid/unsupported syntax is an error, never a skipped/no-match rule.
use crate::ApiError;
use regress::{Flags, Regex};
use serde_json::{json, Value};
use tepora_core::{
    js_value::{js_string, truthy},
    json_codec::{from_utf16_units, stringify_js, utf16_units},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PolicyAction {
    #[default]
    Allow,
    Ask,
    Deny,
}
impl PolicyAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Ask => "ask",
            Self::Deny => "deny",
        }
    }
}
#[derive(Clone, Debug)]
pub struct PolicyDecision {
    pub action: PolicyAction,
    /// Internal-codec string, safe to copy into the approval document.
    pub note: String,
    pub rule: Option<Value>,
    pub rule_index: Option<usize>,
}
#[derive(Clone, Debug)]
struct CompiledRule {
    tool: String,
    action: PolicyAction,
    pattern: Option<Regex>,
    normalized: Value,
}
#[derive(Clone, Debug, Default)]
pub struct CompiledPolicy {
    rules: Vec<CompiledRule>,
}
impl CompiledPolicy {
    pub fn validate(rules: &Value) -> Result<Self, ApiError> {
        let rules = rules
            .as_array()
            .filter(|r| r.len() <= 100)
            .ok_or_else(|| ApiError::bad_request("At most 100 rules"))?;
        let mut compiled = Vec::with_capacity(rules.len());
        for (index, rule) in rules.iter().enumerate() {
            let tool = rule
                .get("tool")
                .and_then(Value::as_str)
                .filter(|t| {
                    !t.is_empty()
                        && t.len() <= 120
                        && t.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_:*/.-".contains(&b))
                })
                .ok_or_else(|| ApiError::bad_request("Each rule needs a tool name or \"*\""))?;
            let action = match rule.get("action").and_then(Value::as_str) {
                Some("allow") => PolicyAction::Allow,
                Some("ask") => PolicyAction::Ask,
                Some("deny") => PolicyAction::Deny,
                _ => {
                    return Err(ApiError::bad_request(
                        "Rule action must be allow, ask or deny",
                    ))
                }
            };
            let mut normalized = json!({"tool":tool,"action":action.as_str()});
            let pattern = if let Some(value) = rule.get("match") {
                let pattern = value
                    .as_str()
                    .filter(|p| utf16_units(p).len() <= 500)
                    .ok_or_else(|| ApiError::bad_request("Invalid match"))?;
                let units = utf16_units(pattern);
                // Source validates without flags and evaluates with 'i'. Both
                // compilations must succeed before the settings can be admitted.
                compile(&units, false, index)?;
                let compiled = compile(&units, true, index)?;
                if !pattern.is_empty() {
                    normalized["match"] = value.clone();
                    Some(compiled)
                } else {
                    None
                }
            } else {
                None
            };
            if let Some(note) = rule.get("note").filter(|n| truthy(n)) {
                let units = utf16_units(&js_string(Some(note)));
                normalized["note"] =
                    Value::String(from_utf16_units(&units[..units.len().min(200)]));
            }
            compiled.push(CompiledRule {
                tool: tool.into(),
                action,
                pattern,
                normalized,
            });
        }
        Ok(Self { rules: compiled })
    }
    pub fn normalized_rules(&self) -> Value {
        Value::Array(self.rules.iter().map(|r| r.normalized.clone()).collect())
    }
    pub fn evaluate(&self, name: &str, args: &Value) -> Result<PolicyDecision, ApiError> {
        let empty = json!({});
        let args = if truthy(args) { args } else { &empty };
        // stringify_js yields external JSON text. Do not decode that text as an
        // internal marker stream: literal private-use characters remain literal.
        let text = stringify_js(args).map_err(|e| {
            ApiError::bad_request(format!("Cannot serialize approval arguments: {e}"))
        })?;
        let units: Vec<u16> = text.encode_utf16().collect();
        for (index, rule) in self.rules.iter().enumerate() {
            let name_matches = rule.tool == "*"
                || rule.tool == name
                || rule
                    .tool
                    .strip_suffix('*')
                    .is_some_and(|prefix| name.starts_with(prefix));
            if !name_matches {
                continue;
            }
            if rule
                .pattern
                .as_ref()
                .is_some_and(|pattern| pattern.find_from_ucs2(&units, 0).next().is_none())
            {
                continue;
            }
            return Ok(PolicyDecision {
                action: rule.action,
                note: rule.normalized["note"].as_str().unwrap_or("").into(),
                rule: Some(rule.normalized.clone()),
                rule_index: Some(index),
            });
        }
        Ok(PolicyDecision {
            action: PolicyAction::Allow,
            note: String::new(),
            rule: None,
            rule_index: None,
        })
    }
}
fn compile(pattern: &[u16], icase: bool, index: usize) -> Result<Regex, ApiError> {
    Regex::from_unicode(
        pattern.iter().copied().map(u32::from),
        Flags {
            icase,
            unicode: false,
            ..Flags::default()
        },
    )
    .map_err(|e| {
        ApiError::bad_request(format!(
            "Invalid or unsupported ECMAScript match in rule {}: {e}",
            index + 1
        ))
    })
}

#[cfg(test)]
mod tests;
