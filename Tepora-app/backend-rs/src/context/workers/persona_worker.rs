//! PersonaWorker — Injects persona / character configuration.
//!
//! Only applies to user-facing agents (ChatMode, SearchFast, SynthesisAgent).
//! See §3 Persona 配置ルール in UPGRADE_PROPOSAL_v4.

use std::sync::Arc;

use async_trait::async_trait;

use crate::context::pipeline_context::{PersonaConfig, PipelineContext};
use crate::context::worker::{ContextWorker, WorkerError};
use crate::state::AppState;

/// Worker that injects persona configuration based on mode eligibility.
pub struct PersonaWorker;

impl PersonaWorker {
    pub fn new() -> Self {
        Self
    }
}

impl Default for PersonaWorker {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ContextWorker for PersonaWorker {
    fn name(&self) -> &str {
        "persona"
    }

    async fn execute(
        &self,
        ctx: &mut PipelineContext,
        state: &Arc<AppState>,
    ) -> Result<(), WorkerError> {
        // Only inject persona for user-facing modes
        if !ctx.mode.has_persona() {
            return Err(WorkerError::skipped(
                "persona",
                "mode does not use persona",
            ));
        }

        let config = state.config.load_config().unwrap_or_default();

        // Read persona config from application settings
        let persona_section = config.get("persona");

        if let Some(persona) = persona_section {
            let name = persona
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("Tepora")
                .to_string();

            let description = persona
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let traits: Vec<String> = persona
                .get("traits")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();

            let prompt_text = persona
                .get("prompt")
                .and_then(|v| v.as_str())
                .map(String::from);

            ctx.persona = Some(PersonaConfig {
                name,
                description,
                traits,
                prompt_text,
            });
        } else {
            return Err(WorkerError::skipped(
                "persona",
                "no persona config found",
            ));
        }

        Ok(())
    }
}
