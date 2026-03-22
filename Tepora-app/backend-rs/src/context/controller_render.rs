use crate::llm::ChatMessage;
use crate::memory::MemoryLayer;

use super::controller::{ContextBlock, ContextBlockKind, TokenEstimator};
use super::pipeline_context::{LocalContext, MemoryChunk, PipelineContext};

pub(super) fn render_blocks_static(mut blocks: Vec<ContextBlock>) -> Vec<ChatMessage> {
    blocks.sort_by_key(|block| render_priority(block.kind));
    let mut system_sections = Vec::new();
    let mut context_blocks = Vec::new();
    let mut final_user_input = None;

    for block in blocks
        .into_iter()
        .filter(|block| !block.content.trim().is_empty())
    {
        match block.kind {
            ContextBlockKind::System => system_sections.push(block.content),
            ContextBlockKind::UserInput => final_user_input = Some(block.content),
            _ => context_blocks.push(block),
        }
    }

    let mut rendered = Vec::new();
    if !system_sections.is_empty() {
        rendered.push(ChatMessage {
            role: "system".to_string(),
            content: system_sections.join("\n\n"),
        });
    }

    let context_bundle = render_context_bundle(&context_blocks);
    if !context_bundle.trim().is_empty() {
        rendered.push(ChatMessage {
            role: "user".to_string(),
            content: context_bundle,
        });
    }

    if let Some(user_input) = final_user_input.filter(|content| !content.trim().is_empty()) {
        rendered.push(ChatMessage {
            role: "user".to_string(),
            content: user_input,
        });
    }

    rendered
}

pub(super) fn prompt_score(chunk: &MemoryChunk, ctx: &PipelineContext) -> f32 {
    let layer_bonus = match chunk.memory_layer {
        MemoryLayer::LML => 0.10,
        MemoryLayer::SML => 0.05,
    };
    let session_bonus = if chunk.session_id == ctx.session_id {
        0.20
    } else {
        0.0
    };
    let character_bonus = if chunk
        .character_id
        .as_deref()
        .zip(resolve_character_id(ctx).as_deref())
        .map(|(a, b)| a == b)
        .unwrap_or(false)
    {
        0.15
    } else {
        0.0
    };

    (chunk.relevance_score * 0.40)
        + (chunk.strength as f32 * 0.20)
        + layer_bonus
        + session_bonus
        + character_bonus
}

pub(super) fn render_memory_card(chunk: &MemoryChunk, estimator: &TokenEstimator) -> String {
    let source = if chunk.source.trim().is_empty() {
        String::new()
    } else {
        format!("\nsource: {}", chunk.source.trim())
    };

    format!(
        "{}{}",
        trim_to_tokens(chunk.content.trim(), 96, estimator),
        source
    )
}

pub(super) fn summarize_artifact(kind: &str, content: &str, estimator: &TokenEstimator) -> String {
    if content.trim().is_empty() {
        return String::new();
    }

    let limit = match kind {
        "research_report" => 192,
        "search_chunks" => 128,
        "tool_summary" => 128,
        _ => 96,
    };

    trim_to_tokens(content.trim(), limit, estimator)
}

pub(super) fn render_local_context(
    local_context: &LocalContext,
    budget: usize,
    estimator: &TokenEstimator,
) -> String {
    let mut sections = Vec::new();

    if let Some(goal) = local_context
        .goal
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        sections.push(format!("Goal: {}", goal.trim()));
    }
    if let Some(topic) = local_context
        .current_topic
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        sections.push(format!("Current Topic: {}", topic.trim()));
    }
    if !local_context.constraints.is_empty() {
        sections.push(format!(
            "Constraints: {}",
            local_context.constraints.join(" | ")
        ));
    }
    if !local_context.resolved_points.is_empty() {
        sections.push(format!(
            "Resolved: {}",
            local_context.resolved_points.join(" | ")
        ));
    }
    if !local_context.open_questions.is_empty() {
        sections.push(format!(
            "Open Questions: {}",
            local_context.open_questions.join(" | ")
        ));
    }
    if !local_context.session_entities.is_empty() {
        sections.push(format!(
            "Entities: {}",
            local_context.session_entities.join(" | ")
        ));
    }

    trim_to_tokens(&sections.join("\n"), budget, estimator)
}

pub(super) fn trim_to_tokens(text: &str, max_tokens: usize, estimator: &TokenEstimator) -> String {
    if max_tokens == 0 || text.trim().is_empty() {
        return String::new();
    }

    if estimator.count_text(text).tokens <= max_tokens {
        return text.to_string();
    }

    let ellipsis = "...";
    if estimator.count_text(ellipsis).tokens >= max_tokens {
        return ellipsis.to_string();
    }

    let boundaries = text
        .char_indices()
        .map(|(index, _)| index)
        .chain(std::iter::once(text.len()))
        .collect::<Vec<_>>();

    let mut low = 0usize;
    let mut high = boundaries.len().saturating_sub(1);
    let mut best = ellipsis.to_string();

    while low <= high {
        let mid = (low + high) / 2;
        let end = boundaries[mid];
        let prefix = text[..end].trim_end();
        let candidate = if prefix.is_empty() {
            ellipsis.to_string()
        } else {
            format!("{prefix}{ellipsis}")
        };

        if estimator.count_text(&candidate).tokens <= max_tokens {
            best = candidate;
            low = mid.saturating_add(1);
        } else if mid == 0 {
            break;
        } else {
            high = mid - 1;
        }
    }

    best
}

pub(super) fn normalize_key(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub(crate) fn escape_xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub(crate) fn render_untrusted_xml_element(
    tag: &str,
    attrs: &[(&str, &str)],
    content: &str,
) -> String {
    let rendered_attrs = attrs
        .iter()
        .map(|(key, value)| format!(r#" {}="{}""#, key, escape_xml_text(value)))
        .collect::<String>();
    format!(
        "<{tag}{rendered_attrs}>\n{}\n</{tag}>",
        escape_xml_text(content)
    )
}

fn render_context_bundle(blocks: &[ContextBlock]) -> String {
    if blocks.is_empty() {
        return String::new();
    }

    let mut sections = Vec::new();
    for kind in [
        ContextBlockKind::Memory,
        ContextBlockKind::LocalContext,
        ContextBlockKind::Evidence,
        ContextBlockKind::ArtifactSummary,
        ContextBlockKind::AppThinkingDigest,
        ContextBlockKind::ModelThinkingDigest,
        ContextBlockKind::InteractionTail,
    ] {
        let rendered = render_context_section(kind, blocks);
        if !rendered.trim().is_empty() {
            sections.push(rendered);
        }
    }

    if sections.is_empty() {
        String::new()
    } else {
        format!(
            "<context_bundle>\n{}\n</context_bundle>",
            sections.join("\n")
        )
    }
}

fn render_context_section(kind: ContextBlockKind, blocks: &[ContextBlock]) -> String {
    let members = blocks
        .iter()
        .filter(|block| block.kind == kind)
        .collect::<Vec<_>>();
    if members.is_empty() {
        return String::new();
    }

    let tag = context_tag(kind);
    let body = if kind == ContextBlockKind::InteractionTail {
        members
            .iter()
            .map(|block| {
                render_untrusted_xml_element(
                    "message",
                    &[("role", block.role.as_str())],
                    &block.content,
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        members
            .iter()
            .map(|block| escape_xml_text(&block.content))
            .collect::<Vec<_>>()
            .join("\n")
    };

    format!("<{tag}>\n{body}\n</{tag}>")
}

fn context_tag(kind: ContextBlockKind) -> &'static str {
    match kind {
        ContextBlockKind::Memory => "memory_cards",
        ContextBlockKind::LocalContext => "local_context",
        ContextBlockKind::InteractionTail => "interaction_tail",
        ContextBlockKind::Evidence => "retrieved_evidence",
        ContextBlockKind::ArtifactSummary => "artifact_summaries",
        ContextBlockKind::AppThinkingDigest => "app_thinking_digest",
        ContextBlockKind::ModelThinkingDigest => "model_thinking_digest",
        ContextBlockKind::System | ContextBlockKind::UserInput => "context",
    }
}

fn render_priority(kind: ContextBlockKind) -> usize {
    match kind {
        ContextBlockKind::System => 0,
        ContextBlockKind::Memory => 1,
        ContextBlockKind::LocalContext => 2,
        ContextBlockKind::Evidence => 3,
        ContextBlockKind::ArtifactSummary => 4,
        ContextBlockKind::AppThinkingDigest => 5,
        ContextBlockKind::ModelThinkingDigest => 6,
        ContextBlockKind::InteractionTail => 7,
        ContextBlockKind::UserInput => 8,
    }
}

fn resolve_character_id(ctx: &PipelineContext) -> Option<String> {
    ctx.config()
        .get("active_character")
        .or_else(|| ctx.config().get("active_agent_profile"))
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
}
