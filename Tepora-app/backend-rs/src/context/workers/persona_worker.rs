//! PersonaWorker — Injects persona / character configuration from active_agent_profile.

use std::sync::Arc;

use async_trait::async_trait;

use crate::context::pipeline_context::{PersonaConfig, PipelineContext};
use crate::context::worker::{ContextWorker, WorkerError};
use crate::state::AppState;

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
        _state: &Arc<AppState>,
    ) -> Result<(), WorkerError> {
        if !ctx.mode.has_persona() {
            return Err(WorkerError::skipped("persona", "mode does not use persona"));
        }

        let config = ctx.config();
        let active_character = config
            .get("active_agent_profile")
            .and_then(|value| value.as_str())
            .unwrap_or("bunny_girl");

        let Some(character) = config
            .get("characters")
            .and_then(|characters| characters.get(active_character))
        else {
            return Err(WorkerError::skipped(
                "persona",
                "no active character config found",
            ));
        };

        let name = character
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("Tepora")
            .to_string();

        let description = character
            .get("description")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();

        let traits = character
            .get("traits")
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();

        ctx.persona = Some(PersonaConfig {
            name,
            description,
            traits,
        });

        Ok(())
    }
}
