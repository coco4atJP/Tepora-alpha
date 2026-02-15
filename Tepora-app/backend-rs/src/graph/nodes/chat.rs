// Chat Node
// Direct conversation with character model.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;

use crate::context::pipeline::ContextPipeline;
use crate::context::pipeline_context::PipelineMode;
use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::AgentState;
use crate::llm::ChatRequest;
use crate::server::ws::handler::send_json;

pub struct ChatNode;

impl ChatNode {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ChatNode {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Node for ChatNode {
    fn id(&self) -> &'static str {
        "chat"
    }

    fn name(&self) -> &'static str {
        "Chat Node"
    }

    async fn execute(
        &self,
        state: &mut AgentState,
        ctx: &mut NodeContext<'_>,
    ) -> Result<NodeOutput, GraphError> {
        let should_rebuild = state
            .pipeline_context
            .as_ref()
            .map(|pipeline| pipeline.mode != PipelineMode::Chat)
            .unwrap_or(true);
        if should_rebuild {
            let app_state = Arc::new(ctx.app_state.clone());
            let pipeline_ctx = ContextPipeline::build_v4(
                &app_state,
                &state.session_id,
                &state.input,
                PipelineMode::Chat,
                state.skip_web_search,
            )
            .await
            .map_err(|err| GraphError::new(self.id(), err.to_string()))?;
            state.pipeline_context = Some(pipeline_ctx);
        }

        let mut messages = if let Some(pipeline_ctx) = state.pipeline_context.as_ref() {
            ContextPipeline::pipeline_to_context_result(pipeline_ctx).messages
        } else {
            state.chat_history.clone()
        };

        if let Some(thought) = &state.thought_process {
            messages.push(crate::llm::ChatMessage {
                role: "system".to_string(),
                content: format!(
                    "Your reasoning process (use this to inform your response):\n{}",
                    thought
                ),
            });
        }

        let model_id = {
            let registry = ctx
                .app_state
                .models
                .get_registry()
                .map_err(|err| GraphError::new(self.id(), err.to_string()))?;
            registry
                .role_assignments
                .get("character")
                .cloned()
                .unwrap_or_else(|| "default".to_string())
        };

        let request = ChatRequest::new(messages).with_config(ctx.config);

        let mut stream = ctx
            .app_state
            .llm
            .stream_chat(request, &model_id)
            .await
            .map_err(|err| GraphError::new(self.id(), err.to_string()))?;

        let mut full_response = String::new();

        while let Some(chunk_result) = stream.recv().await {
            match chunk_result {
                Ok(chunk) => {
                    if chunk.is_empty() {
                        continue;
                    }
                    full_response.push_str(&chunk);
                    let _ = send_json(
                        ctx.sender,
                        json!({
                            "type": "chunk",
                            "message": chunk,
                            "mode": "chat",
                        }),
                    )
                    .await;
                }
                Err(err) => {
                    let _ = send_json(
                        ctx.sender,
                        json!({"type": "error", "message": format!("{}", err)}),
                    )
                    .await;
                    return Err(GraphError::new(self.id(), err.to_string()));
                }
            }
        }

        let _ = send_json(ctx.sender, json!({"type": "done"})).await;

        state.output = Some(full_response);
        Ok(NodeOutput::Final)
    }
}
