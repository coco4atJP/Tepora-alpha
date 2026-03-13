use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;

use crate::agent::execution::{
    build_agent_chat_config, resolve_execution_model_id, resolve_selected_agent,
};
use crate::context::pipeline::ContextPipeline;
use crate::context::pipeline_context::{PipelineArtifact, PipelineMode, PipelineStage};
use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::{AgentMode, AgentState};
use crate::llm::{ChatMessage, ChatRequest};

pub struct SynthesizerNode;

impl SynthesizerNode {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SynthesizerNode {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Node for SynthesizerNode {
    fn id(&self) -> &'static str {
        "synthesizer"
    }

    fn name(&self) -> &'static str {
        "Response Synthesizer"
    }

    async fn execute(
        &self,
        state: &mut AgentState,
        ctx: &mut NodeContext<'_>,
    ) -> Result<NodeOutput, GraphError> {
        let agent_name = state
            .selected_agent_id
            .clone()
            .unwrap_or_else(|| "Assistant".to_string());

        let _ = ctx
            .sender
            .send_json(json!({
                "type": "activity",
                "data": {
                    "id": "synthesize_final_response",
                    "status": "processing",
                    "message": "Synthesizing final response",
                    "agentName": &agent_name
                }
            }))
            .await;

        let pipeline_mode = match state.agent_mode {
            AgentMode::High => PipelineMode::AgentHigh,
            AgentMode::Low => PipelineMode::AgentLow,
            AgentMode::Direct => PipelineMode::AgentDirect,
        };

        let should_rebuild = state
            .pipeline_context
            .as_ref()
            .map(|pipeline| pipeline.mode != pipeline_mode)
            .unwrap_or(true);
        if should_rebuild {
            let app_state = Arc::new(ctx.app_state.clone());
            let pipeline_ctx = ContextPipeline::build_v4(
                &app_state,
                &state.session_id,
                &state.input,
                pipeline_mode,
                state.skip_web_search,
            )
            .await
            .map_err(|err| GraphError::new(self.id(), err.to_string()))?;
            state.pipeline_context = Some(pipeline_ctx);
        }

        let selected_agent =
            resolve_selected_agent(ctx.app_state, state.selected_agent_id.as_deref());
        let agent_chat_config =
            build_agent_chat_config(ctx.app_state, ctx.config, selected_agent.as_ref());
        let model_id =
            resolve_execution_model_id(ctx.app_state, ctx.config, selected_agent.as_ref());

        let mut messages = if let Some(pipeline_ctx) = state.pipeline_context.as_ref() {
            let mut staged = pipeline_ctx.clone();
            staged.stage = PipelineStage::AgentSynthesizer;
            staged.artifacts.extend(
                state
                    .shared_context
                    .artifacts
                    .iter()
                    .rev()
                    .take(5)
                    .map(|artifact| PipelineArtifact {
                        artifact_type: artifact.artifact_type.clone(),
                        content: artifact.content.clone(),
                        metadata: artifact.metadata.clone(),
                    })
                    .collect::<Vec<_>>(),
            );
            staged.to_messages()
        } else {
            state.chat_history.clone()
        };

        if let Some(last) = messages.last() {
            if last.role == "user" && last.content.trim() == state.input.trim() {
                messages.pop();
            }
        }

        messages.push(ChatMessage {
            role: "system".to_string(),
            content: "Use only summarized artifacts, stable memory, and local context to produce the final user-facing answer. Do not rely on raw tool output or scratchpad text.".to_string(),
        });
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: state.input.clone(),
        });

        let request = ChatRequest::new(messages).with_config(&agent_chat_config);
        let mut stream = ctx
            .app_state
            .llm
            .stream_chat_normalized(request, &model_id)
            .await
            .map_err(|e| GraphError::new(self.id(), e.to_string()))?;

        let mut full_response = String::new();

        while let Some(chunk_result) = stream.recv().await {
            match chunk_result {
                Ok(chunk) => {
                    if !chunk.model_thinking.is_empty() {
                        let _ = ctx
                            .sender
                            .send_json(json!({
                                "type": "thought",
                                "content": chunk.model_thinking,
                                "mode": "agent",
                                "agentName": &agent_name,
                                "nodeId": "synthesize_final_response"
                            }))
                            .await;
                    }

                    if chunk.visible_text.is_empty() {
                        continue;
                    }
                    full_response.push_str(&chunk.visible_text);
                    let _ = ctx
                        .sender
                        .send_json(json!({
                            "type": "chunk",
                            "message": chunk.visible_text,
                            "mode": "agent",
                            "agentName": &agent_name,
                            "nodeId": "synthesize_final_response"
                        }))
                        .await;
                }
                Err(err) => {
                    return Err(GraphError::new(self.id(), err.to_string()));
                }
            }
        }

        let _ = ctx
            .sender
            .send_json(json!({
                "type": "activity",
                "data": {
                    "id": "synthesize_final_response",
                    "status": "done",
                    "message": "Response complete",
                    "agentName": &agent_name
                }
            }))
            .await;

        let _ = ctx.sender.send_json(json!({"type": "done"})).await;

        state.output = Some(full_response);
        Ok(NodeOutput::Final)
    }
}
