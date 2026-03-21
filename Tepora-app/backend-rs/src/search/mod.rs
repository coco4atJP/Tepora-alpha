use serde::{Deserialize, Serialize};

use crate::tools::search::SearchResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SearchMode {
    #[default]
    Quick,
    Deep,
}

impl SearchMode {
    pub fn from_str(value: Option<&str>) -> Self {
        match value
            .map(|item| item.trim().to_lowercase())
            .unwrap_or_else(|| "quick".to_string())
            .as_str()
        {
            "deep" | "search_agentic" | "agentic" => SearchMode::Deep,
            _ => SearchMode::Quick,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            SearchMode::Quick => "quick",
            SearchMode::Deep => "deep",
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct EvidenceClaim {
    pub topic: String,
    pub summary: String,
    pub citations: Vec<String>,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct EvidenceGap {
    pub topic: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SearchEvidenceState {
    pub strategy: SearchMode,
    pub query_plan: Vec<String>,
    pub explored_sources: Vec<String>,
    pub results: Vec<SearchResult>,
    pub claims: Vec<EvidenceClaim>,
    pub gaps: Vec<EvidenceGap>,
}
