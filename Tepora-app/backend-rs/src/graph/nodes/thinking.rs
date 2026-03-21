// Thinking Node
// Chain of Thought (CoT) reasoning

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;

use crate::context::pipeline::ContextPipeline;
use crate::context::pipeline_context::{PipelineContext, PipelineMode};
use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::AgentState;
use crate::llm::ChatRequest;
use crate::models::event::{AgentEvent, AgentEventType};

pub struct ThinkingNode;

impl ThinkingNode {
    pub fn new() -> Self {
        Self
    }

    async fn base_context(
        &self,
        state: &AgentState,
        ctx: &NodeContext<'_>,
    ) -> Result<PipelineContext, GraphError> {
        if let Some(existing) = state.pipeline_context.as_ref() {
            let mut staged = existing.clone();
            staged.user_input = state.input.clone();
            return Ok(staged);
        }

        let app_state = Arc::new(ctx.app_state.clone());
        ContextPipeline::build_v4(
            &app_state,
            &state.session_id,
            &state.input,
            PipelineMode::Chat,
            state.skip_web_search,
        )
        .await
        .map_err(|err| GraphError::new(self.id(), err.to_string()))
    }

    fn thinking_messages(
        &self,
        base_ctx: &PipelineContext,
        user_input: &str,
        extra_instruction: Option<&str>,
    ) -> Vec<crate::llm::types::ChatMessage> {
        let mut staged = base_ctx.clone();
        staged.user_input = user_input.to_string();
        staged.add_system_part("thinking_instruction", THINKING_SYSTEM_PROMPT, 130);
        if let Some(extra_instruction) = extra_instruction.filter(|value| !value.trim().is_empty()) {
            staged.add_system_part("thinking_variant", extra_instruction, 125);
        }
        staged.to_messages()
    }
}

impl Default for ThinkingNode {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Node for ThinkingNode {
    fn id(&self) -> &'static str {
        "thinking"
    }

    fn name(&self) -> &'static str {
        "Thinking Node"
    }

    async fn execute(
        &self,
        state: &mut AgentState,
        ctx: &mut NodeContext<'_>,
    ) -> Result<NodeOutput, GraphError> {
        if state.thinking_budget == 0 {
            // Skip directly to chat if thinking is disabled
            return Ok(NodeOutput::Continue(Some("chat".to_string())));
        }

        if let Err(e) = ctx
            .app_state
            .history
            .save_agent_event(&AgentEvent {
                id: uuid::Uuid::new_v4().to_string(),
                session_id: state.session_id.clone(),
                node_name: self.id().to_string(),
                event_type: AgentEventType::NodeStarted,
                metadata: json!({"budget": state.thinking_budget}),
                created_at: chrono::Utc::now(),
            })
            .await
        {
            tracing::warn!(error = %e, "Failed to save agent event");
        }

        let num_paths = state.thinking_budget;

        let _ = ctx.sender.send_json(
            json!({
                "type": "activity",
                "data": {
                    "id": "thinking",
                    "status": "processing",
                    "message": if num_paths > 1 { format!("Generating {} parallel reasoning paths...", num_paths) } else { "Reasoning step by step...".to_string() },
                    "agentName": "Deep Thinker"
                }
            }),
        )
        .await;

        // Resolve model ID
        let active_character = ctx
            .config
            .get("active_character")
            .or_else(|| ctx.config.get("active_agent_profile"))
            .and_then(|v| v.as_str());
        let model_id = ctx
            .app_state
            .models
            .resolve_character_model_id(active_character)
            .map_err(|e| GraphError::new(self.id(), e.to_string()))?
            .unwrap_or_else(|| "default".to_string());
        let base_ctx = self.base_context(state, ctx).await?;

        let final_thought = if num_paths == 1 {
            // Standard CoT (Level 1)
            let thinking_messages = self.thinking_messages(&base_ctx, &state.input, None);
            let request = ChatRequest::new(thinking_messages).with_config(ctx.config);
            let response = ctx.app_state.llm.chat(request, &model_id).await.map_err(
                |e: crate::core::errors::ApiError| GraphError::new(self.id(), e.to_string()),
            )?;

            if let Err(e) = ctx.app_state.history.save_agent_event(&AgentEvent {
                id: uuid::Uuid::new_v4().to_string(),
                session_id: state.session_id.clone(),
                node_name: self.id().to_string(),
                event_type: AgentEventType::PromptGenerated,
                metadata: json!({"type": "cot", "model_id": model_id, "length": response.len()}),
                created_at: chrono::Utc::now(),
            }).await {
                tracing::warn!(error = %e, "Failed to save agent event");
            }

            response
        } else {
            // Parallel Thinking (Level 2 or 3)
            let mut futures = Vec::new();

            // Define slightly different perspectives to encourage diversity
            let perspectives = [
                "Focus on a strict, logical, step-by-step breakdown.",
                "Take a critical approach, looking for edge cases or potential flaws in obvious answers.",
                "Focus on creative, out-of-the-box solutions while remaining grounded in the facts.",
            ];

            for i in 0..num_paths {
                let perspective = perspectives[(i as usize) % perspectives.len()];
                let prompt = format!(
                    "Approach constraint: {}\n\nVERY IMPORTANT: Keep your output under 500 words. Output ONLY the reasoning process.",
                    perspective
                );
                let messages = self.thinking_messages(&base_ctx, &state.input, Some(&prompt));

                // Allow slightly higher temperature for diversity, if supported by the LLM implementation config
                // We pass the same config for now, but rely on the distinct system prompts for diversity.
                let request = ChatRequest::new(messages).with_config(ctx.config);
                let llm = ctx.app_state.llm.clone();
                let m_id = model_id.clone();

                futures.push(async move { llm.chat(request, &m_id).await });
            }

            // Await all parallel paths
            let results = futures_util::future::join_all(futures).await;

            let mut valid_paths = Vec::new();
            for (i, res) in results.into_iter().enumerate() {
                match res {
                    Ok(thought) => valid_paths.push(format!("### Path {}\n{}\n", i + 1, thought)),
                    _ => tracing::warn!("Failed to generate thinking path {}", i + 1),
                }
            }

            if valid_paths.is_empty() {
                return Err(GraphError::new(
                    self.id(),
                    "All parallel thinking paths failed.",
                ));
            }

            // Synthesis Step
            let _ = ctx
                .sender
                .send_json(json!({
                    "type": "activity",
                    "data": {
                        "id": "thinking_synthesis",
                        "status": "processing",
                        "message": "Synthesizing parallel reasoning paths...",
                        "agentName": "Deep Thinker"
                    }
                }))
                .await;

            let synthesis_prompt = format!(
                "You are an expert evaluator. The user asked: '{}'\n\nBelow are {} independent reasoning paths. Compare them critically, identify flaws or strengths in each, synthesize the best insights, and output a single, highly refined, final reasoning process. \n\nOutput ONLY the final, unified thought process, keeping it concise but comprehensive. Do not output the final answer to the user, only the reasoning.\n\n{}",
                state.input,
                valid_paths.len(),
                valid_paths.join("\n---\n")
            );

            let synthesis_messages = self.thinking_messages(
                &base_ctx,
                &synthesis_prompt,
                Some(
                    "Synthesize the strongest reasoning into a single unified thought process. Output only the reasoning.",
                ),
            );
            let synthesis_request =
                ChatRequest::new(synthesis_messages).with_config(ctx.config);
            let synthesized = ctx
                .app_state
                .llm
                .chat(synthesis_request, &model_id)
                .await
                .map_err(|e: crate::core::errors::ApiError| {
                    GraphError::new(self.id(), format!("Synthesis failed: {}", e))
                })?;

            if let Err(e) = ctx.app_state.history.save_agent_event(&AgentEvent {
                id: uuid::Uuid::new_v4().to_string(),
                session_id: state.session_id.clone(),
                node_name: self.id().to_string(),
                event_type: AgentEventType::PromptGenerated,
                metadata: json!({"type": "synthesis", "paths": valid_paths.len(), "model_id": model_id, "length": synthesized.len()}),
                created_at: chrono::Utc::now(),
            }).await {
                tracing::warn!(error = %e, "Failed to save agent event");
            }

            synthesized
        };

        state.thought_process = Some(final_thought.clone());

        let _ = ctx
            .sender
            .send_json(json!({
                "type": "activity",
                "data": {
                    "id": "thinking",
                    "status": "done",
                    "message": "Reasoning complete",
                    "agentName": "Deep Thinker"
                }
            }))
            .await;

        // Send thought process to client
        let _ = ctx
            .sender
            .send_json(json!({
                "type": "thought",
                "content": final_thought
            }))
            .await;

        if let Err(e) = ctx
            .app_state
            .history
            .save_agent_event(&AgentEvent {
                id: uuid::Uuid::new_v4().to_string(),
                session_id: state.session_id.clone(),
                node_name: self.id().to_string(),
                event_type: AgentEventType::NodeCompleted,
                metadata: json!({}),
                created_at: chrono::Utc::now(),
            })
            .await
        {
            tracing::warn!(error = %e, "Failed to save agent event");
        }

        // Continue to chat node
        Ok(NodeOutput::Continue(Some("chat".to_string())))
    }
}

const THINKING_SYSTEM_PROMPT: &str = r#"You are a reasoning assistant. Before answering, think through the problem step by step.

Output your thinking process in the following format:
1. First, understand what is being asked
2. Consider relevant information and context
3. Analyze potential approaches
4. Reason through the best approach
5. Formulate a clear conclusion

Keep your reasoning concise but thorough. Focus on the key aspects of the question.
Output only your thinking process, not the final answer."#;
