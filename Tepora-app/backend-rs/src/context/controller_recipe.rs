use std::collections::HashMap;

use serde_json::{Map, Value};

use super::controller::{ContextBlockKind, WindowRecipe};
use super::pipeline_context::{PipelineMode, PipelineStage};

#[derive(Debug, Clone)]
struct RecipeControls {
    drop_order: Vec<ContextBlockKind>,
    compression_order: Vec<ContextBlockKind>,
    evidence_limit: usize,
    artifact_limit: usize,
    include_app_thinking_digest: bool,
    include_model_thinking_digest: bool,
    include_scratchpad: bool,
}

pub(super) fn window_recipe_for_mode(
    mode: PipelineMode,
    stage: PipelineStage,
    config: &Value,
) -> WindowRecipe {
    let mut recipe = match (mode, stage) {
        (PipelineMode::Chat, _) => recipe(
            stage,
            &[
                (ContextBlockKind::System, 20),
                (ContextBlockKind::Memory, 45),
                (ContextBlockKind::LocalContext, 20),
                (ContextBlockKind::InteractionTail, 5),
                (ContextBlockKind::UserInput, 10),
            ],
            controls(
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
            controls(
                default_drop_order(),
                default_compression_order(),
                2,
                1,
                false,
                false,
                false,
            ),
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
            controls(
                default_drop_order(),
                default_compression_order(),
                4,
                2,
                true,
                false,
                false,
            ),
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
            controls(
                default_drop_order(),
                default_compression_order(),
                1,
                1,
                false,
                false,
                false,
            ),
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
            controls(
                default_drop_order(),
                default_compression_order(),
                5,
                2,
                false,
                false,
                false,
            ),
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
            controls(
                default_drop_order(),
                default_compression_order(),
                5,
                3,
                true,
                false,
                false,
            ),
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
            controls(
                default_drop_order(),
                default_compression_order(),
                4,
                4,
                true,
                false,
                false,
            ),
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
            controls(
                default_drop_order(),
                default_compression_order(),
                1,
                2,
                false,
                false,
                false,
            ),
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
            controls(
                default_drop_order(),
                default_compression_order(),
                2,
                5,
                true,
                false,
                false,
            ),
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
            controls(
                default_drop_order(),
                default_compression_order(),
                2,
                5,
                false,
                false,
                false,
            ),
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
                controls(
                    default_drop_order(),
                    default_compression_order(),
                    3,
                    4,
                    true,
                    false,
                    true,
                ),
            )
        }
    };
    apply_context_window_overrides(config, mode, stage, &mut recipe);
    recipe
}

fn recipe(
    stage: PipelineStage,
    caps: &[(ContextBlockKind, usize)],
    controls: RecipeControls,
) -> WindowRecipe {
    WindowRecipe {
        stage,
        caps: caps.iter().copied().collect::<HashMap<_, _>>(),
        drop_order: controls.drop_order,
        compression_order: controls.compression_order,
        evidence_limit: controls.evidence_limit,
        artifact_limit: controls.artifact_limit,
        include_app_thinking_digest: controls.include_app_thinking_digest,
        include_model_thinking_digest: controls.include_model_thinking_digest,
        include_scratchpad: controls.include_scratchpad,
    }
}

fn controls(
    drop_order: Vec<ContextBlockKind>,
    compression_order: Vec<ContextBlockKind>,
    evidence_limit: usize,
    artifact_limit: usize,
    include_app_thinking_digest: bool,
    include_model_thinking_digest: bool,
    include_scratchpad: bool,
) -> RecipeControls {
    RecipeControls {
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

fn apply_context_window_overrides(
    config: &Value,
    mode: PipelineMode,
    stage: PipelineStage,
    recipe: &mut WindowRecipe,
) {
    let Some(overrides) = context_window_recipe_config(config, mode, stage) else {
        return;
    };

    apply_cap_override(overrides, "system_cap", ContextBlockKind::System, recipe);
    apply_cap_override(overrides, "memory_cap", ContextBlockKind::Memory, recipe);
    apply_cap_override(
        overrides,
        "local_context_cap",
        ContextBlockKind::LocalContext,
        recipe,
    );
    apply_cap_override(
        overrides,
        "interaction_tail_cap",
        ContextBlockKind::InteractionTail,
        recipe,
    );
    apply_cap_override(
        overrides,
        "evidence_cap",
        ContextBlockKind::Evidence,
        recipe,
    );
    apply_cap_override(
        overrides,
        "artifact_summary_cap",
        ContextBlockKind::ArtifactSummary,
        recipe,
    );
    apply_cap_override(
        overrides,
        "app_thinking_digest_cap",
        ContextBlockKind::AppThinkingDigest,
        recipe,
    );
    apply_cap_override(
        overrides,
        "model_thinking_digest_cap",
        ContextBlockKind::ModelThinkingDigest,
        recipe,
    );
    apply_cap_override(
        overrides,
        "user_input_cap",
        ContextBlockKind::UserInput,
        recipe,
    );

    if let Some(limit) = overrides.get("evidence_limit").and_then(|v| v.as_u64()) {
        recipe.evidence_limit = limit as usize;
    }
    if let Some(limit) = overrides.get("artifact_limit").and_then(|v| v.as_u64()) {
        recipe.artifact_limit = limit as usize;
    }
}

fn apply_cap_override(
    overrides: &Map<String, Value>,
    key: &str,
    block_kind: ContextBlockKind,
    recipe: &mut WindowRecipe,
) {
    if let Some(share) = overrides.get(key).and_then(|v| v.as_u64()) {
        recipe.caps.insert(block_kind, share as usize);
    }
}

fn context_window_recipe_config(
    config: &Value,
    mode: PipelineMode,
    stage: PipelineStage,
) -> Option<&Map<String, Value>> {
    let context_window = config.get("context_window")?.as_object()?;
    let mode_entry = context_window
        .get(context_window_mode_key(mode))?
        .as_object()?;
    if is_context_window_recipe_object(mode_entry) {
        return Some(mode_entry);
    }
    mode_entry
        .get(context_window_stage_key(stage))
        .or_else(|| mode_entry.get("default"))
        .and_then(|value| value.as_object())
}

fn context_window_mode_key(mode: PipelineMode) -> &'static str {
    match mode {
        PipelineMode::Chat => "chat",
        PipelineMode::SearchFast => "search_fast",
        PipelineMode::SearchAgentic => "search_agentic",
        PipelineMode::AgentHigh => "agent_high",
        PipelineMode::AgentLow => "agent_low",
        PipelineMode::AgentDirect => "agent_direct",
    }
}

fn context_window_stage_key(stage: PipelineStage) -> &'static str {
    match stage {
        PipelineStage::Main => "main",
        PipelineStage::SearchQueryGenerate => "search_query_generate",
        PipelineStage::SearchChunkSelect => "search_chunk_select",
        PipelineStage::SearchReportBuild => "search_report_build",
        PipelineStage::SearchFinalSynthesis => "search_final_synthesis",
        PipelineStage::AgentPlanner => "agent_planner",
        PipelineStage::AgentExecutor => "agent_executor",
        PipelineStage::AgentSynthesizer => "agent_synthesizer",
    }
}

fn is_context_window_recipe_object(section: &Map<String, Value>) -> bool {
    section.keys().any(|key| {
        matches!(
            key.as_str(),
            "system_cap"
                | "memory_cap"
                | "local_context_cap"
                | "interaction_tail_cap"
                | "evidence_cap"
                | "artifact_summary_cap"
                | "app_thinking_digest_cap"
                | "model_thinking_digest_cap"
                | "user_input_cap"
                | "evidence_limit"
                | "artifact_limit"
        )
    })
}
