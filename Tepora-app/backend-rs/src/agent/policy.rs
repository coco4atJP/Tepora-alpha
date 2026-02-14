use std::collections::HashSet;
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct CustomToolPolicy {
    pub allow_all: bool,
    pub allowed_tools: HashSet<String>,
    pub denied_tools: HashSet<String>,
    pub require_confirmation: HashSet<String>,
}

impl CustomToolPolicy {
    pub fn allow_all_policy() -> Self {
        Self {
            allow_all: true,
            allowed_tools: HashSet::new(),
            denied_tools: HashSet::new(),
            require_confirmation: HashSet::new(),
        }
    }

    pub fn from_agent_config(agent: &Value) -> Self {
        let policy = agent
            .get("tool_policy")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();

        let allow_defined = policy.contains_key("allowed_tools") || policy.contains_key("allow");
        let allowed_raw =
            parse_string_set(policy.get("allowed_tools").or_else(|| policy.get("allow")));
        let allow_all = !allow_defined || allowed_raw.contains("*");

        let allowed_tools = allowed_raw
            .into_iter()
            .filter(|tool| tool != "*")
            .collect::<HashSet<_>>();
        let denied_tools =
            parse_string_set(policy.get("denied_tools").or_else(|| policy.get("deny")));
        let require_confirmation = parse_string_set(policy.get("require_confirmation"));

        Self {
            allow_all,
            allowed_tools,
            denied_tools,
            require_confirmation,
        }
    }

    pub fn is_tool_allowed(&self, tool_name: &str) -> bool {
        if self.denied_tools.contains(tool_name) {
            return false;
        }
        if self.allow_all {
            return true;
        }
        self.allowed_tools.contains(tool_name)
    }

    pub fn requires_confirmation(&self, tool_name: &str) -> bool {
        self.require_confirmation.contains(tool_name)
    }
}

fn parse_string_set(value: Option<&Value>) -> HashSet<String> {
    let mut out = HashSet::new();
    let Some(list) = value.and_then(|v| v.as_array()) else {
        return out;
    };
    for item in list {
        if let Some(value) = item.as_str().map(str::trim).filter(|v| !v.is_empty()) {
            out.insert(value.to_string());
        }
    }
    out
}
