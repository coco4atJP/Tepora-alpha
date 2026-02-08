// Synthesizer Node
// Generates final response from gathered context

use async_trait::async_trait;
use serde_json::json;

use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::AgentState;
use crate::llama::ChatMessage;
use crate::ws::send_json;

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

        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "synthesize_final_response",
                    "status": "processing",
                    "message": "Synthesizing final response",
                    "agentName": &agent_name
                }
            }),
        )
        .await;

        // Build synthesis prompt
        let mut messages = state.chat_history.clone();

        // Add context from shared context
        if !state.shared_context.artifacts.is_empty() {
            let artifacts_text: Vec<String> = state
                .shared_context
                .artifacts
                .iter()
                .map(|a| format!("[{}]: {}", a.artifact_type, a.content))
                .collect();
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: format!("Gathered artifacts:\n{}", artifacts_text.join("\n\n")),
            });
        }

        // Add scratchpad notes
        if !state.agent_scratchpad.is_empty() {
            for msg in &state.agent_scratchpad {
                messages.push(msg.clone());
            }
        }

        // Add synthesis instruction
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: "Based on the above context and tool results, provide a clear and helpful response to the user's request.".to_string(),
        });

        messages.push(ChatMessage {
            role: "user".to_string(),
            content: state.input.clone(),
        });

        // Stream response
        let mut stream = ctx
            .app_state
            .llama
            .stream_chat(ctx.config, messages)
            .await
            .map_err(|e| GraphError::new(self.id(), e.to_string()))?;

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
                            "mode": "agent",
                            "agentName": &agent_name,
                            "nodeId": "synthesize_final_response"
                        }),
                    )
                    .await;
                }
                Err(err) => {
                    return Err(GraphError::new(self.id(), err.to_string()));
                }
            }
        }

        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "synthesize_final_response",
                    "status": "done",
                    "message": "Response complete",
                    "agentName": &agent_name
                }
            }),
        )
        .await;

        let _ = send_json(ctx.sender, json!({"type": "done"})).await;

        state.output = Some(full_response);
        Ok(NodeOutput::Final)
    }
}
