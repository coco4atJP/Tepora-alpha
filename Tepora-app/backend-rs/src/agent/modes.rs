#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestedAgentMode {
    Low,
    High,
    Direct,
}

impl RequestedAgentMode {
    pub fn parse(value: Option<&str>) -> Self {
        match value
            .map(|v| v.trim().to_lowercase())
            .unwrap_or_else(|| "low".to_string())
            .as_str()
        {
            "high" => RequestedAgentMode::High,
            "direct" => RequestedAgentMode::Direct,
            // "fast" accepted as legacy alias
            _ => RequestedAgentMode::Low,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            RequestedAgentMode::Low => "low",
            RequestedAgentMode::High => "high",
            RequestedAgentMode::Direct => "direct",
        }
    }
}
