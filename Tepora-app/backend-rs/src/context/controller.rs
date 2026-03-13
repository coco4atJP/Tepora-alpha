use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use crate::em_llm::types::MemoryLayer;
use crate::llm::ChatMessage;
use tokenizers::Tokenizer;

use super::pipeline_context::{
    LocalContext, MemoryChunk, ModelTokenizerSpec, PipelineContext, PipelineMode, PipelineStage,
    TokenBudget,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ContextBlockKind {
    System,
    Memory,
    LocalContext,
    InteractionTail,
    Evidence,
    ArtifactSummary,
    AppThinkingDigest,
    ModelThinkingDigest,
    UserInput,
}

#[derive(Debug, Clone)]
pub struct ContextBlock {
    pub kind: ContextBlockKind,
    pub role: String,
    pub content: String,
    pub source_key: String,
    pub required: bool,
    pub score: f32,
}

/// `caps` are per-kind upper bounds expressed as a share of the current input
/// budget. They are not a normalized partition of the full prompt budget.
#[derive(Debug, Clone)]
pub struct WindowRecipe {
    pub stage: PipelineStage,
    pub caps: HashMap<ContextBlockKind, usize>,
    pub drop_order: Vec<ContextBlockKind>,
    pub compression_order: Vec<ContextBlockKind>,
    pub evidence_limit: usize,
    pub artifact_limit: usize,
    pub include_app_thinking_digest: bool,
    pub include_model_thinking_digest: bool,
    pub include_scratchpad: bool,
}

#[derive(Debug, Clone, Copy)]
pub enum TokenEstimateSource {
    Runtime,
    Tokenizer,
    Heuristic,
}

#[derive(Debug, Clone, Copy)]
pub struct TokenEstimate {
    pub tokens: usize,
    pub source: TokenEstimateSource,
}

#[derive(Debug, Clone, Copy)]
struct TokenCountBreakdown {
    total_tokens: usize,
    source: TokenEstimateSource,
}

#[derive(Debug, Clone)]
pub struct TokenEstimator {
    tokenizer_spec: ModelTokenizerSpec,
}

impl TokenEstimator {
    pub fn new(tokenizer_spec: ModelTokenizerSpec) -> Self {
        Self { tokenizer_spec }
    }

    pub fn count_text(&self, text: &str) -> TokenEstimate {
        if let Some(tokens) = self.count_with_tokenizer(text) {
            return TokenEstimate {
                tokens,
                source: TokenEstimateSource::Tokenizer,
            };
        }

        TokenEstimate {
            tokens: estimate_tokens(text),
            source: TokenEstimateSource::Heuristic,
        }
    }

    fn count_with_tokenizer(&self, text: &str) -> Option<usize> {
        if text.trim().is_empty() {
            return Some(0);
        }

        let path = self.tokenizer_spec.tokenizer_path.as_deref()?;
        let tokenizer = load_tokenizer(path)?;
        tokenizer
            .encode(text, true)
            .ok()
            .map(|encoding| encoding.len())
    }
}

#[derive(Debug, Default)]
struct ContextRenderDiagnostics {
    input_tokens_estimated: usize,
    estimation_source: String,
    dropped_blocks: Vec<String>,
    compressed_blocks: Vec<String>,
}

pub struct ContextController {
    recipe: WindowRecipe,
    budget: TokenBudget,
    estimator: TokenEstimator,
}

impl ContextController {
    pub fn new(ctx: &PipelineContext) -> Self {
        Self {
            recipe: WindowRecipe::for_mode(ctx.mode, ctx.stage),
            budget: ctx.token_budget.clone(),
            estimator: TokenEstimator::new(ctx.tokenizer_spec.clone()),
        }
    }

    pub fn render(&self, ctx: &PipelineContext) -> Vec<ChatMessage> {
        let mut blocks = self.collect_blocks(ctx);
        let mut diagnostics = ContextRenderDiagnostics::default();
        self.dedupe_blocks(&mut blocks);
        self.compress_blocks(&mut blocks, &mut diagnostics);
        self.drop_blocks(&mut blocks, &mut diagnostics);
        let token_breakdown = total_tokens(&blocks, &self.estimator);
        diagnostics.input_tokens_estimated = token_breakdown.total_tokens;
        diagnostics.estimation_source = estimation_source_label(token_breakdown.source).to_string();
        self.trace_diagnostics(&blocks, &diagnostics);
        self.render_blocks(blocks)
    }

    fn collect_blocks(&self, ctx: &PipelineContext) -> Vec<ContextBlock> {
        let mut blocks = Vec::new();

        if let Some(system_text) = self.system_message(ctx) {
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
                content: format!("[Memory] {}", render_memory_card(&chunk, &self.estimator)),
                required: false,
                score: prompt_score(&chunk, ctx),
            });
        }

        if !ctx.local_context.is_empty() {
            let rendered = render_local_context(&ctx.local_context, 160, &self.estimator);
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
            .take(self.recipe.evidence_limit)
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
                    trim_to_tokens(result.snippet.trim(), 96, &self.estimator)
                ),
                required: false,
                score: 260.0 - index as f32,
            });
        }

        for (index, chunk) in ctx
            .rag_chunks
            .iter()
            .take(self.recipe.evidence_limit)
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
                    trim_to_tokens(chunk.content.trim(), 144, &self.estimator)
                ),
                required: false,
                score: 320.0 + chunk.score,
            });
        }

        for (index, artifact) in ctx
            .artifacts
            .iter()
            .rev()
            .take(self.recipe.artifact_limit)
            .enumerate()
        {
            let summary = summarize_artifact(
                artifact.artifact_type.as_str(),
                artifact.content.as_str(),
                &self.estimator,
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

        if self.recipe.include_app_thinking_digest {
            if let Some(digest) = ctx.reasoning.app_thinking_digest.as_deref() {
                if !digest.trim().is_empty() {
                    blocks.push(ContextBlock {
                        kind: ContextBlockKind::AppThinkingDigest,
                        role: "system".to_string(),
                        source_key: "app_thinking".to_string(),
                        content: format!(
                            "[App Thinking Digest]\n{}",
                            trim_to_tokens(digest, 96, &self.estimator)
                        ),
                        required: false,
                        score: 120.0,
                    });
                }
            }
        }

        if self.recipe.include_model_thinking_digest {
            if let Some(digest) = ctx.reasoning.model_thinking_digest.as_deref() {
                if !digest.trim().is_empty() {
                    blocks.push(ContextBlock {
                        kind: ContextBlockKind::ModelThinkingDigest,
                        role: "system".to_string(),
                        source_key: "model_thinking".to_string(),
                        content: format!(
                            "[Model Thinking Digest]\n{}",
                            trim_to_tokens(digest, 96, &self.estimator)
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
                    content: trim_to_tokens(&message.content, 96, &self.estimator),
                    required: false,
                    score: 180.0 + index as f32,
                });
            }
        }

        if self.recipe.include_scratchpad {
            for (index, message) in ctx.scratchpad_messages().into_iter().enumerate() {
                if message.content.trim().is_empty() {
                    continue;
                }
                blocks.push(ContextBlock {
                    kind: ContextBlockKind::ArtifactSummary,
                    role: message.role,
                    source_key: format!("scratch:{}", index),
                    content: trim_to_tokens(&message.content, 72, &self.estimator),
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

    fn dedupe_blocks(&self, blocks: &mut Vec<ContextBlock>) {
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

    fn compress_blocks(
        &self,
        blocks: &mut Vec<ContextBlock>,
        diagnostics: &mut ContextRenderDiagnostics,
    ) {
        let available = self.budget.available_input_budget();
        for kind in &self.recipe.compression_order {
            let cap = available.saturating_mul(self.cap_for(*kind)) / 100;
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
                .map(|index| self.estimator.count_text(&blocks[*index].content).tokens)
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
                let body =
                    trim_to_tokens(&blocks[index].content, target_each.max(32), &self.estimator);
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

    fn drop_blocks(
        &self,
        blocks: &mut Vec<ContextBlock>,
        diagnostics: &mut ContextRenderDiagnostics,
    ) {
        let available = self.budget.available_input_budget();
        self.enforce_per_kind_caps(blocks, available, diagnostics);

        while total_tokens(blocks, &self.estimator).total_tokens > available {
            let Some(index) = self.find_drop_candidate(blocks) else {
                break;
            };
            let removed = blocks.remove(index);
            diagnostics
                .dropped_blocks
                .push(format!("{:?}:{}", removed.kind, removed.source_key));
        }
    }

    fn enforce_per_kind_caps(
        &self,
        blocks: &mut Vec<ContextBlock>,
        available: usize,
        diagnostics: &mut ContextRenderDiagnostics,
    ) {
        for (kind, share) in &self.recipe.caps {
            let cap = available.saturating_mul(*share) / 100;
            if cap == 0 {
                continue;
            }
            loop {
                let current = blocks
                    .iter()
                    .filter(|block| block.kind == *kind)
                    .map(|block| self.estimator.count_text(&block.content).tokens)
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

    fn find_drop_candidate(&self, blocks: &[ContextBlock]) -> Option<usize> {
        for kind in &self.recipe.drop_order {
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

    fn render_blocks(&self, mut blocks: Vec<ContextBlock>) -> Vec<ChatMessage> {
        blocks.sort_by_key(|block| render_priority(block.kind));
        blocks
            .into_iter()
            .filter(|block| !block.content.trim().is_empty())
            .map(|block| ChatMessage {
                role: block.role,
                content: block.content,
            })
            .collect()
    }

    fn system_message(&self, ctx: &PipelineContext) -> Option<String> {
        let system_text = ctx.build_system_prompt();
        if system_text.trim().is_empty() {
            None
        } else {
            Some(system_text)
        }
    }

    fn cap_for(&self, kind: ContextBlockKind) -> usize {
        *self.recipe.caps.get(&kind).unwrap_or(&0)
    }

    fn trace_diagnostics(&self, blocks: &[ContextBlock], diagnostics: &ContextRenderDiagnostics) {
        if !tracing::enabled!(tracing::Level::DEBUG) {
            return;
        }
        tracing::debug!(
            stage = ?self.recipe.stage,
            input_tokens_estimated = diagnostics.input_tokens_estimated,
            context_budget = self.budget.available_input_budget(),
            estimation_source = %diagnostics.estimation_source,
            blocks = blocks.len(),
            dropped_blocks = ?diagnostics.dropped_blocks,
            compressed_blocks = ?diagnostics.compressed_blocks,
            "context controller render"
        );
    }
}

impl WindowRecipe {
    pub fn for_mode(mode: PipelineMode, stage: PipelineStage) -> Self {
        match (mode, stage) {
            (PipelineMode::Chat, _) => recipe(
                stage,
                &[
                    (ContextBlockKind::System, 20),
                    (ContextBlockKind::Memory, 45),
                    (ContextBlockKind::LocalContext, 20),
                    (ContextBlockKind::InteractionTail, 5),
                    (ContextBlockKind::UserInput, 10),
                ],
                vec![
                    ContextBlockKind::ModelThinkingDigest,
                    ContextBlockKind::ArtifactSummary,
                    ContextBlockKind::InteractionTail,
                    ContextBlockKind::LocalContext,
                    ContextBlockKind::Memory,
                    ContextBlockKind::Evidence,
                ],
                vec![
                    ContextBlockKind::ArtifactSummary,
                    ContextBlockKind::InteractionTail,
                    ContextBlockKind::LocalContext,
                    ContextBlockKind::Memory,
                ],
                0,
                0,
                false,
                false,
                false,
            ),
            (PipelineMode::SearchFast, PipelineStage::SearchQueryGenerate) => recipe(
                stage,
                &[
                    (ContextBlockKind::System, 15),
                    (ContextBlockKind::Memory, 40),
                    (ContextBlockKind::LocalContext, 15),
                    (ContextBlockKind::InteractionTail, 5),
                    (ContextBlockKind::UserInput, 25),
                ],
                default_drop_order(),
                default_compression_order(),
                2,
                1,
                false,
                false,
                false,
            ),
            (PipelineMode::SearchFast, _) => recipe(
                stage,
                &[
                    (ContextBlockKind::System, 15),
                    (ContextBlockKind::Memory, 20),
                    (ContextBlockKind::LocalContext, 10),
                    (ContextBlockKind::Evidence, 45),
                    (ContextBlockKind::InteractionTail, 5),
                    (ContextBlockKind::AppThinkingDigest, 5),
                    (ContextBlockKind::UserInput, 10),
                ],
                default_drop_order(),
                default_compression_order(),
                4,
                2,
                true,
                false,
                false,
            ),
            (PipelineMode::SearchAgentic, PipelineStage::SearchQueryGenerate) => recipe(
                stage,
                &[
                    (ContextBlockKind::System, 18),
                    (ContextBlockKind::Memory, 35),
                    (ContextBlockKind::LocalContext, 20),
                    (ContextBlockKind::InteractionTail, 7),
                    (ContextBlockKind::UserInput, 20),
                ],
                default_drop_order(),
                default_compression_order(),
                1,
                1,
                false,
                false,
                false,
            ),
            (PipelineMode::SearchAgentic, PipelineStage::SearchChunkSelect) => recipe(
                stage,
                &[
                    (ContextBlockKind::System, 15),
                    (ContextBlockKind::Memory, 20),
                    (ContextBlockKind::LocalContext, 15),
                    (ContextBlockKind::Evidence, 35),
                    (ContextBlockKind::ArtifactSummary, 10),
                    (ContextBlockKind::UserInput, 5),
                ],
                default_drop_order(),
                default_compression_order(),
                5,
                2,
                false,
                false,
                false,
            ),
            (PipelineMode::SearchAgentic, PipelineStage::SearchReportBuild) => recipe(
                stage,
                &[
                    (ContextBlockKind::System, 15),
                    (ContextBlockKind::Memory, 15),
                    (ContextBlockKind::LocalContext, 10),
                    (ContextBlockKind::Evidence, 35),
                    (ContextBlockKind::ArtifactSummary, 15),
                    (ContextBlockKind::AppThinkingDigest, 5),
                    (ContextBlockKind::UserInput, 5),
                ],
                default_drop_order(),
                default_compression_order(),
                5,
                3,
                true,
                false,
                false,
            ),
            (PipelineMode::SearchAgentic, _) => recipe(
                stage,
                &[
                    (ContextBlockKind::System, 15),
                    (ContextBlockKind::Memory, 15),
                    (ContextBlockKind::LocalContext, 10),
                    (ContextBlockKind::Evidence, 30),
                    (ContextBlockKind::ArtifactSummary, 20),
                    (ContextBlockKind::AppThinkingDigest, 5),
                    (ContextBlockKind::UserInput, 5),
                ],
                default_drop_order(),
                default_compression_order(),
                4,
                4,
                true,
                false,
                false,
            ),
            (
                PipelineMode::AgentHigh | PipelineMode::AgentLow | PipelineMode::AgentDirect,
                PipelineStage::AgentPlanner,
            ) => recipe(
                stage,
                &[
                    (ContextBlockKind::System, 18),
                    (ContextBlockKind::Memory, 30),
                    (ContextBlockKind::LocalContext, 20),
                    (ContextBlockKind::InteractionTail, 7),
                    (ContextBlockKind::ArtifactSummary, 10),
                    (ContextBlockKind::UserInput, 15),
                ],
                default_drop_order(),
                default_compression_order(),
                1,
                2,
                false,
                false,
                false,
            ),
            (
                PipelineMode::AgentHigh | PipelineMode::AgentLow | PipelineMode::AgentDirect,
                PipelineStage::AgentExecutor,
            ) => recipe(
                stage,
                &[
                    (ContextBlockKind::System, 15),
                    (ContextBlockKind::ArtifactSummary, 30),
                    (ContextBlockKind::LocalContext, 15),
                    (ContextBlockKind::Memory, 15),
                    (ContextBlockKind::InteractionTail, 5),
                    (ContextBlockKind::UserInput, 20),
                ],
                default_drop_order(),
                default_compression_order(),
                2,
                5,
                true,
                false,
                false,
            ),
            (
                PipelineMode::AgentHigh | PipelineMode::AgentLow | PipelineMode::AgentDirect,
                PipelineStage::AgentSynthesizer,
            ) => recipe(
                stage,
                &[
                    (ContextBlockKind::System, 18),
                    (ContextBlockKind::Memory, 25),
                    (ContextBlockKind::LocalContext, 20),
                    (ContextBlockKind::ArtifactSummary, 25),
                    (ContextBlockKind::UserInput, 12),
                ],
                default_drop_order(),
                default_compression_order(),
                2,
                5,
                false,
                false,
                false,
            ),
            (PipelineMode::AgentHigh | PipelineMode::AgentLow | PipelineMode::AgentDirect, _) => {
                recipe(
                    stage,
                    &[
                        (ContextBlockKind::System, 15),
                        (ContextBlockKind::Memory, 25),
                        (ContextBlockKind::LocalContext, 20),
                        (ContextBlockKind::Evidence, 20),
                        (ContextBlockKind::ArtifactSummary, 15),
                        (ContextBlockKind::InteractionTail, 5),
                    ],
                    default_drop_order(),
                    default_compression_order(),
                    3,
                    4,
                    true,
                    false,
                    true,
                )
            }
        }
    }
}

fn recipe(
    stage: PipelineStage,
    caps: &[(ContextBlockKind, usize)],
    drop_order: Vec<ContextBlockKind>,
    compression_order: Vec<ContextBlockKind>,
    evidence_limit: usize,
    artifact_limit: usize,
    include_app_thinking_digest: bool,
    include_model_thinking_digest: bool,
    include_scratchpad: bool,
) -> WindowRecipe {
    WindowRecipe {
        stage,
        caps: caps.iter().copied().collect(),
        drop_order,
        compression_order,
        evidence_limit,
        artifact_limit,
        include_app_thinking_digest,
        include_model_thinking_digest,
        include_scratchpad,
    }
}

fn default_drop_order() -> Vec<ContextBlockKind> {
    vec![
        ContextBlockKind::ModelThinkingDigest,
        ContextBlockKind::ArtifactSummary,
        ContextBlockKind::InteractionTail,
        ContextBlockKind::LocalContext,
        ContextBlockKind::Memory,
        ContextBlockKind::Evidence,
    ]
}

fn default_compression_order() -> Vec<ContextBlockKind> {
    vec![
        ContextBlockKind::ArtifactSummary,
        ContextBlockKind::InteractionTail,
        ContextBlockKind::LocalContext,
        ContextBlockKind::Memory,
        ContextBlockKind::Evidence,
    ]
}

fn total_tokens(blocks: &[ContextBlock], estimator: &TokenEstimator) -> TokenCountBreakdown {
    let mut total_tokens = 0usize;
    let mut source = TokenEstimateSource::Heuristic;

    for block in blocks {
        let estimate = estimator.count_text(&block.content);
        total_tokens = total_tokens.saturating_add(estimate.tokens);
        source = preferred_estimation_source(source, estimate.source);
    }

    TokenCountBreakdown {
        total_tokens,
        source,
    }
}

fn estimation_source_label(source: TokenEstimateSource) -> &'static str {
    match source {
        TokenEstimateSource::Runtime => "runtime",
        TokenEstimateSource::Tokenizer => "tokenizer",
        TokenEstimateSource::Heuristic => "heuristic",
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

fn prompt_score(chunk: &MemoryChunk, ctx: &PipelineContext) -> f32 {
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

fn resolve_character_id(ctx: &PipelineContext) -> Option<String> {
    ctx.config()
        .get("active_agent_profile")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
}

fn render_memory_card(chunk: &MemoryChunk, estimator: &TokenEstimator) -> String {
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

fn summarize_artifact(kind: &str, content: &str, estimator: &TokenEstimator) -> String {
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

fn render_local_context(
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

fn trim_to_tokens(text: &str, max_tokens: usize, estimator: &TokenEstimator) -> String {
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

fn normalize_key(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn estimate_tokens(text: &str) -> usize {
    let mut ascii = 0usize;
    let mut non_ascii = 0usize;
    for ch in text.chars() {
        if ch.is_ascii() {
            ascii += 1;
        } else {
            non_ascii += 1;
        }
    }
    let base = ascii.div_ceil(4) + non_ascii.div_ceil(2);
    (base.saturating_mul(135)).div_ceil(100)
}

fn preferred_estimation_source(
    current: TokenEstimateSource,
    candidate: TokenEstimateSource,
) -> TokenEstimateSource {
    match (current, candidate) {
        (TokenEstimateSource::Tokenizer, _) | (_, TokenEstimateSource::Tokenizer) => {
            TokenEstimateSource::Tokenizer
        }
        (TokenEstimateSource::Runtime, _) | (_, TokenEstimateSource::Runtime) => {
            TokenEstimateSource::Runtime
        }
        _ => TokenEstimateSource::Heuristic,
    }
}

type TokenizerCache = Mutex<HashMap<String, Arc<Tokenizer>>>;

fn tokenizer_cache() -> &'static TokenizerCache {
    static CACHE: OnceLock<TokenizerCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn load_tokenizer(path: &str) -> Option<Arc<Tokenizer>> {
    if path.trim().is_empty() || !Path::new(path).exists() {
        return None;
    }

    if let Some(existing) = tokenizer_cache().lock().ok()?.get(path).cloned() {
        return Some(existing);
    }

    let tokenizer = Tokenizer::from_file(path).ok()?;
    let tokenizer = Arc::new(tokenizer);
    if let Ok(mut cache) = tokenizer_cache().lock() {
        cache.insert(path.to_string(), tokenizer.clone());
    }
    Some(tokenizer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_to_tokens_respects_multibyte_budget() {
        let estimator = TokenEstimator::new(ModelTokenizerSpec::default());
        let text = "日本語の文章を長めに書いて、トークン上限に収まるように切り詰めます。";
        let trimmed = trim_to_tokens(text, 12, &estimator);

        assert!(estimator.count_text(&trimmed).tokens <= 12);
        assert!(trimmed.chars().count() < text.chars().count());
    }

    #[test]
    fn estimate_tokens_penalizes_non_ascii_more_than_ascii() {
        let ascii = estimate_tokens("abcdefghijklmnop");
        let japanese = estimate_tokens("あいうえおかきくけこさしすせそ");

        assert!(japanese > ascii);
    }
}
