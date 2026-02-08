// Thinking Node
// Chain of Thought (CoT) reasoning

use async_trait::async_trait;
use serde_json::json;

use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::AgentState;
use crate::llama::ChatMessage;
use crate::ws::send_json;

pub struct ThinkingNode;

impl ThinkingNode {
    pub fn new() -> Self {
        Self
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
        if !state.thinking_enabled {
            // Skip directly to chat if thinking is disabled
            return Ok(NodeOutput::Continue(Some("chat".to_string())));
        }

        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "thinking",
                    "status": "processing",
                    "message": "Reasoning step by step...",
                    "agentName": "Thinking"
                }
            }),
        )
        .await;

        // Build thinking prompt
        let thinking_messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: THINKING_SYSTEM_PROMPT.to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: state.input.clone(),
            },
        ];

        // Generate thinking process
        let thought = ctx
            .app_state
            .llama
            .chat(ctx.config, thinking_messages)
            .await
            .map_err(|e| GraphError::new(self.id(), e.to_string()))?;

        state.thought_process = Some(thought.clone());

        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "thinking",
                    "status": "done",
                    "message": "Reasoning complete",
                    "agentName": "Thinking"
                }
            }),
        )
        .await;

        // Send thought process to client (optional, can be hidden)
        let _ = send_json(
            ctx.sender,
            json!({
                "type": "thought",
                "content": thought
            }),
        )
        .await;

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
