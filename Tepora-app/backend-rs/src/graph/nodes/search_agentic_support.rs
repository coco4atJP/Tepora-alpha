use std::collections::HashSet;

use serde_json::{json, Value};

use crate::context::pipeline_context::PipelineArtifact;
use crate::graph::state::Artifact;
use crate::llm::types::StructuredResponseSpec;
use crate::tools::search::SearchResult;

#[derive(Debug, Clone)]
pub(super) struct RagArtifactChunk {
    pub(super) chunk_id: String,
    pub(super) source: String,
    pub(super) content: String,
    pub(super) score: f32,
}

#[derive(Debug, Clone)]
pub(super) struct SelectedChunkBrief {
    pub(super) source: String,
    pub(super) chunk_id: String,
    pub(super) claim: String,
    pub(super) evidence_strength: f32,
}

#[derive(Debug, Clone)]
pub(super) struct ReportBrief {
    pub(super) answer_outline: String,
    pub(super) key_findings: Vec<String>,
    pub(super) open_uncertainties: Vec<String>,
    pub(super) citation_map: Vec<String>,
}

pub(super) fn parse_json_payload<T>(output: &str) -> Option<T>
where
    T: serde::de::DeserializeOwned,
{
    if let Ok(parsed) = serde_json::from_str::<T>(output) {
        return Some(parsed);
    }

    let trimmed = output.trim();
    let start = trimmed.find(['[', '{'])?;
    let end = trimmed.rfind([']', '}'])?;
    if end < start {
        return None;
    }

    serde_json::from_str::<T>(&trimmed[start..=end]).ok()
}

pub(super) fn sub_query_structured_spec() -> StructuredResponseSpec {
    StructuredResponseSpec {
        name: "search_sub_queries".to_string(),
        description: Some("Focused search sub-query list".to_string()),
        schema: json!({
            "type": "array",
            "items": {
                "type": "string"
            },
            "minItems": 1,
            "maxItems": 4
        }),
    }
}

pub(super) fn truncate_text(text: &str, max_len: usize) -> String {
    if text.chars().count() <= max_len {
        return text.to_string();
    }
    let mut out = text.chars().take(max_len).collect::<String>();
    out.push_str("...");
    out
}

pub(super) fn dedupe_search_results(
    mut web_results: Vec<SearchResult>,
    mut rag_results: Vec<SearchResult>,
) -> Vec<SearchResult> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();

    for item in web_results.drain(..) {
        if seen.insert(item.url.clone()) {
            out.push(item);
        }
    }

    for item in rag_results.drain(..) {
        if seen.insert(item.url.clone()) {
            out.push(item);
        }
    }

    out
}

pub(super) fn build_explored_sources(attachments: &[Value], web_enabled: bool) -> Vec<String> {
    let mut sources = vec!["session_rag".to_string(), "local_knowledge".to_string()];
    if !attachments.is_empty() {
        sources.insert(0, "attachments".to_string());
    }
    if web_enabled {
        sources.push("web".to_string());
    }
    sources
}

pub(super) fn build_selected_chunk_briefs(chunks: &[RagArtifactChunk]) -> Vec<SelectedChunkBrief> {
    chunks
        .iter()
        .take(6)
        .map(|chunk| SelectedChunkBrief {
            source: chunk.source.clone(),
            chunk_id: chunk.chunk_id.clone(),
            claim: truncate_text(first_meaningful_line(&chunk.content), 180),
            evidence_strength: (chunk.score * 100.0).round() / 100.0,
        })
        .collect()
}

pub(super) fn render_selected_chunk_briefs(briefs: &[SelectedChunkBrief]) -> String {
    briefs
        .iter()
        .enumerate()
        .map(|(index, brief)| {
            format!(
                "[{}] chunk_id={} source={} strength={:.2}\n{}",
                index + 1,
                brief.chunk_id,
                brief.source,
                brief.evidence_strength,
                brief.claim
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub(super) fn render_query_plan_brief(sub_queries: &[String]) -> String {
    let lines = sub_queries
        .iter()
        .take(5)
        .enumerate()
        .map(|(index, query)| format!("- Query {}: {}", index + 1, query.trim()))
        .collect::<Vec<_>>()
        .join("\n");
    format!("[Query Plan Brief]\n{}", lines)
}

pub(super) fn build_report_brief(report: &str, chunk_briefs: &[SelectedChunkBrief]) -> ReportBrief {
    let lines = report
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let answer_outline = lines
        .first()
        .map(|line| truncate_text(line, 180))
        .unwrap_or_else(|| {
            "Summarize the strongest findings and cite the supporting chunks.".to_string()
        });

    let mut key_findings = lines
        .iter()
        .filter(|line| {
            line.starts_with("- ")
                || line.starts_with("* ")
                || line.starts_with("1.")
                || line.starts_with("2.")
        })
        .take(4)
        .map(|line| truncate_text(line.trim_start_matches(['-', '*', ' ']).trim(), 160))
        .collect::<Vec<_>>();
    if key_findings.is_empty() {
        key_findings = chunk_briefs
            .iter()
            .take(4)
            .map(|brief| brief.claim.clone())
            .collect();
    }

    let open_uncertainties = lines
        .iter()
        .filter(|line| {
            let lowered = line.to_lowercase();
            lowered.contains("uncertain")
                || lowered.contains("unknown")
                || lowered.contains("may ")
                || lowered.contains("might ")
                || line.contains("不明")
                || line.contains("不確実")
                || line.contains("追加確認")
        })
        .take(3)
        .map(|line| truncate_text(line, 160))
        .collect::<Vec<_>>();

    let citation_map = chunk_briefs
        .iter()
        .take(6)
        .map(|brief| format!("{} -> {}", brief.chunk_id, brief.source))
        .collect::<Vec<_>>();

    ReportBrief {
        answer_outline,
        key_findings,
        open_uncertainties,
        citation_map,
    }
}

pub(super) fn render_report_brief(brief: &ReportBrief) -> String {
    let mut sections = vec![format!("[Answer Outline]\n{}", brief.answer_outline)];
    if !brief.key_findings.is_empty() {
        sections.push(format!(
            "[Key Findings]\n{}",
            brief
                .key_findings
                .iter()
                .map(|item| format!("- {}", item))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if !brief.open_uncertainties.is_empty() {
        sections.push(format!(
            "[Open Uncertainties]\n{}",
            brief
                .open_uncertainties
                .iter()
                .map(|item| format!("- {}", item))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if !brief.citation_map.is_empty() {
        sections.push(format!(
            "[Citation Map]\n{}",
            brief
                .citation_map
                .iter()
                .map(|item| format!("- {}", item))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    sections.join("\n\n")
}

pub(super) fn build_final_constraints(user_input: &str) -> String {
    format!(
        "[Final Constraints]\n- Answer the user's request directly.\n- Preserve the user's language.\n- Cite chunk IDs or source URLs when possible.\n- User request: {}",
        truncate_text(user_input.trim(), 180)
    )
}

pub(super) fn shared_artifacts_to_pipeline(artifacts: &[Artifact]) -> Vec<PipelineArtifact> {
    artifacts
        .iter()
        .map(|artifact| PipelineArtifact {
            artifact_type: artifact.artifact_type.clone(),
            content: artifact.content.clone(),
            metadata: artifact.metadata.clone(),
        })
        .collect()
}

fn first_meaningful_line(text: &str) -> &str {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or(text.trim())
}
