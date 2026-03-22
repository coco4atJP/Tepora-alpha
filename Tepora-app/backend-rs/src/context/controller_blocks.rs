use std::collections::HashSet;

use super::controller::{
    ContextBlock, ContextBlockKind, ContextRenderDiagnostics, TokenCountBreakdown,
    TokenEstimateSource, TokenEstimator, WindowRecipe,
};
use super::controller_render::{
    normalize_key, prompt_score, render_blocks_static, render_local_context, render_memory_card,
    summarize_artifact, trim_to_tokens,
};
use super::controller_tokens::select_estimation_source as preferred_estimation_source;
use super::pipeline_context::{PipelineContext, TokenBudget};

pub(super) fn collect_blocks(
    recipe: &WindowRecipe,
    estimator: &TokenEstimator,
    ctx: &PipelineContext,
) -> Vec<ContextBlock> {
    let mut blocks = Vec::new();

    let system_text = ctx.build_system_prompt();
    if !system_text.trim().is_empty() {
        blocks.push(ContextBlock {
            kind: ContextBlockKind::System,
            role: "system".to_string(),
            source_key: "system".to_string(),
            content: system_text,
            required: true,
            score: 1_000.0,
        });
    }

    let mut memories = ctx.memory_chunks.clone();
    memories.sort_by(|a, b| prompt_score(b, ctx).total_cmp(&prompt_score(a, ctx)));
    for chunk in memories {
        blocks.push(ContextBlock {
            kind: ContextBlockKind::Memory,
            role: "system".to_string(),
            source_key: format!(
                "memory:{}:{}:{}",
                chunk.session_id,
                chunk.character_id.clone().unwrap_or_default(),
                normalize_key(&chunk.content)
            ),
            content: format!("[Memory] {}", render_memory_card(&chunk, estimator)),
            required: false,
            score: prompt_score(&chunk, ctx),
        });
    }

    if !ctx.local_context.is_empty() {
        let rendered = render_local_context(&ctx.local_context, 160, estimator);
        if !rendered.trim().is_empty() {
            blocks.push(ContextBlock {
                kind: ContextBlockKind::LocalContext,
                role: "system".to_string(),
                source_key: "local_context".to_string(),
                content: format!("[Local Context]\n{}", rendered),
                required: false,
                score: 400.0,
            });
        }
    }

    for (index, result) in ctx
        .search_results
        .iter()
        .take(recipe.evidence_limit)
        .enumerate()
    {
        blocks.push(ContextBlock {
            kind: ContextBlockKind::Evidence,
            role: "system".to_string(),
            source_key: format!("search:{}", result.url),
            content: format!(
                "[Search Result {}]\n{}\n{}\n{}",
                index + 1,
                result.title.trim(),
                result.url.trim(),
                trim_to_tokens(result.snippet.trim(), 96, estimator)
            ),
            required: false,
            score: 260.0 - index as f32,
        });
    }

    for (index, chunk) in ctx
        .rag_chunks
        .iter()
        .take(recipe.evidence_limit)
        .enumerate()
    {
        blocks.push(ContextBlock {
            kind: ContextBlockKind::Evidence,
            role: "system".to_string(),
            source_key: format!("rag:{}:{}", chunk.chunk_id, chunk.source),
            content: format!(
                "[Evidence {}]\nchunk_id={} source={} score={:.2}\n{}",
                index + 1,
                chunk.chunk_id,
                chunk.source,
                chunk.score,
                trim_to_tokens(chunk.content.trim(), 144, estimator)
            ),
            required: false,
            score: 320.0 + chunk.score,
        });
    }

    for (index, artifact) in ctx
        .artifacts
        .iter()
        .rev()
        .take(recipe.artifact_limit)
        .enumerate()
    {
        let summary = summarize_artifact(
            artifact.artifact_type.as_str(),
            artifact.content.as_str(),
            estimator,
        );
        if summary.trim().is_empty() {
            continue;
        }
        blocks.push(ContextBlock {
            kind: ContextBlockKind::ArtifactSummary,
            role: "system".to_string(),
            source_key: format!("artifact:{}:{}", artifact.artifact_type, index),
            content: format!(
                "[Artifact Summary: {}]\n{}",
                artifact.artifact_type, summary
            ),
            required: false,
            score: 220.0 - index as f32,
        });
    }

    if recipe.include_app_thinking_digest {
        if let Some(digest) = ctx.reasoning.app_thinking_digest.as_deref() {
            if !digest.trim().is_empty() {
                blocks.push(ContextBlock {
                    kind: ContextBlockKind::AppThinkingDigest,
                    role: "system".to_string(),
                    source_key: "app_thinking".to_string(),
                    content: format!(
                        "[App Thinking Digest]\n{}",
                        trim_to_tokens(digest, 96, estimator)
                    ),
                    required: false,
                    score: 120.0,
                });
            }
        }
    }

    if recipe.include_model_thinking_digest {
        if let Some(digest) = ctx.reasoning.model_thinking_digest.as_deref() {
            if !digest.trim().is_empty() {
                blocks.push(ContextBlock {
                    kind: ContextBlockKind::ModelThinkingDigest,
                    role: "system".to_string(),
                    source_key: "model_thinking".to_string(),
                    content: format!(
                        "[Model Thinking Digest]\n{}",
                        trim_to_tokens(digest, 96, estimator)
                    ),
                    required: false,
                    score: 80.0,
                });
            }
        }
    }

    if let Some(tail) = &ctx.interaction_tail {
        for (index, message) in tail.messages.iter().enumerate() {
            if message.content.trim().is_empty() {
                continue;
            }
            blocks.push(ContextBlock {
                kind: ContextBlockKind::InteractionTail,
                role: message.role.clone(),
                source_key: format!("tail:{}:{}", index, normalize_key(&message.content)),
                content: trim_to_tokens(&message.content, 96, estimator),
                required: false,
                score: 180.0 + index as f32,
            });
        }
    }

    if recipe.include_scratchpad {
        for (index, message) in ctx.scratchpad_messages().into_iter().enumerate() {
            if message.content.trim().is_empty() {
                continue;
            }
            blocks.push(ContextBlock {
                kind: ContextBlockKind::ArtifactSummary,
                role: message.role,
                source_key: format!("scratch:{}", index),
                content: trim_to_tokens(&message.content, 72, estimator),
                required: false,
                score: 100.0 - index as f32,
            });
        }
    }

    if !ctx.user_input.trim().is_empty() {
        blocks.push(ContextBlock {
            kind: ContextBlockKind::UserInput,
            role: "user".to_string(),
            source_key: "user_input".to_string(),
            content: ctx.user_input.clone(),
            required: true,
            score: 1_000.0,
        });
    }

    blocks
}

pub(super) fn dedupe_blocks(blocks: &mut Vec<ContextBlock>) {
    let mut seen = HashSet::new();
    blocks.retain(|block| {
        let key = format!(
            "{:?}:{}:{}",
            block.kind,
            block.source_key,
            normalize_key(&block.content)
        );
        seen.insert(key)
    });
}

pub(super) fn compress_blocks(
    recipe: &WindowRecipe,
    budget: &TokenBudget,
    estimator: &TokenEstimator,
    blocks: &mut [ContextBlock],
    diagnostics: &mut ContextRenderDiagnostics,
) {
    let available = budget.available_input_budget();
    for kind in &recipe.compression_order {
        let cap = available.saturating_mul(cap_for(recipe, *kind)) / 100;
        if cap == 0 {
            continue;
        }

        let kind_indices = blocks
            .iter()
            .enumerate()
            .filter(|(_, block)| block.kind == *kind)
            .map(|(index, _)| index)
            .collect::<Vec<_>>();

        let total_tokens: usize = kind_indices
            .iter()
            .map(|index| estimator.count_text(&blocks[*index].content).tokens)
            .sum();

        if total_tokens <= cap {
            continue;
        }

        let target_each = cap / kind_indices.len().max(1);
        for index in kind_indices {
            if blocks[index].required {
                continue;
            }
            let original = blocks[index].content.clone();
            let body = trim_to_tokens(&blocks[index].content, target_each.max(32), estimator);
            if body != original {
                diagnostics.compressed_blocks.push(format!(
                    "{:?}:{}",
                    blocks[index].kind, blocks[index].source_key
                ));
            }
            blocks[index].content = body;
        }
    }
}

pub(super) fn drop_blocks(
    recipe: &WindowRecipe,
    budget: &TokenBudget,
    estimator: &TokenEstimator,
    blocks: &mut Vec<ContextBlock>,
    diagnostics: &mut ContextRenderDiagnostics,
) {
    let available = budget.available_input_budget();
    enforce_per_kind_caps(recipe, estimator, blocks, available, diagnostics);

    while rendered_total_tokens(blocks, estimator).total_tokens > available {
        let Some(index) = find_drop_candidate(recipe, blocks) else {
            break;
        };
        let removed = blocks.remove(index);
        diagnostics
            .dropped_blocks
            .push(format!("{:?}:{}", removed.kind, removed.source_key));
    }
}

fn enforce_per_kind_caps(
    recipe: &WindowRecipe,
    estimator: &TokenEstimator,
    blocks: &mut Vec<ContextBlock>,
    available: usize,
    diagnostics: &mut ContextRenderDiagnostics,
) {
    for (kind, share) in &recipe.caps {
        let cap = available.saturating_mul(*share) / 100;
        if cap == 0 {
            remove_optional_blocks_of_kind(blocks, *kind, diagnostics, "disabled");
            continue;
        }
        loop {
            let current = blocks
                .iter()
                .filter(|block| block.kind == *kind)
                .map(|block| estimator.count_text(&block.content).tokens)
                .sum::<usize>();
            if current <= cap {
                break;
            }
            let Some(index) = blocks
                .iter()
                .enumerate()
                .filter(|(_, block)| block.kind == *kind && !block.required)
                .min_by(|a, b| a.1.score.total_cmp(&b.1.score))
                .map(|(index, _)| index)
            else {
                break;
            };
            let removed = blocks.remove(index);
            diagnostics
                .dropped_blocks
                .push(format!("cap:{:?}:{}", removed.kind, removed.source_key));
        }
    }
}

fn find_drop_candidate(recipe: &WindowRecipe, blocks: &[ContextBlock]) -> Option<usize> {
    for kind in &recipe.drop_order {
        if let Some(index) = blocks
            .iter()
            .enumerate()
            .filter(|(_, block)| block.kind == *kind && !block.required)
            .min_by(|a, b| a.1.score.total_cmp(&b.1.score))
            .map(|(index, _)| index)
        {
            return Some(index);
        }
    }
    None
}

fn rendered_total_tokens(
    blocks: &[ContextBlock],
    estimator: &TokenEstimator,
) -> TokenCountBreakdown {
    let rendered = render_blocks_static(blocks.to_vec());
    total_message_tokens(&rendered, estimator)
}

fn total_message_tokens(
    messages: &[crate::llm::ChatMessage],
    estimator: &TokenEstimator,
) -> TokenCountBreakdown {
    let mut total_tokens = 0usize;
    let mut source = TokenEstimateSource::Heuristic;

    for message in messages {
        let estimate = estimator.count_text(&message.content);
        total_tokens = total_tokens.saturating_add(estimate.tokens);
        source = preferred_estimation_source(source, estimate.source);
    }

    TokenCountBreakdown {
        total_tokens,
        source,
    }
}

fn remove_optional_blocks_of_kind(
    blocks: &mut Vec<ContextBlock>,
    kind: ContextBlockKind,
    diagnostics: &mut ContextRenderDiagnostics,
    reason: &str,
) {
    let mut index = 0;
    while index < blocks.len() {
        if blocks[index].kind == kind && !blocks[index].required {
            let removed = blocks.remove(index);
            diagnostics.dropped_blocks.push(format!(
                "{}:{:?}:{}",
                reason, removed.kind, removed.source_key
            ));
        } else {
            index += 1;
        }
    }
}

fn cap_for(recipe: &WindowRecipe, kind: ContextBlockKind) -> usize {
    *recipe.caps.get(&kind).unwrap_or(&0)
}
