use std::collections::HashSet;

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
