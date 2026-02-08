// Chat Node
// Direct conversation with character

use async_trait::async_trait;
use serde_json::json;

use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::AgentState;
use crate::llama::ChatMessage;
use crate::ws::send_json;

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
        // Build messages for LLM
        let mut messages = state.chat_history.clone();

        // Add system prompt if available
        if let Some(system_prompt) = extract_system_prompt(ctx.config) {
            messages.insert(
                0,
                ChatMessage {
                    role: "system".to_string(),
                    content: system_prompt,
                },
            );
        }

        // Add thought process if available (from ThinkingNode)
        if let Some(thought) = &state.thought_process {
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: format!(
                    "Your reasoning process (use this to inform your response):\n{}",
                    thought
                ),
            });
        }

        // Add user input
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: state.input.clone(),
        });

        // Stream response from LLM
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

fn extract_system_prompt(config: &serde_json::Value) -> Option<String> {
    let active = config
        .get("active_agent_profile")
        .and_then(|v| v.as_str())
        .unwrap_or("bunny_girl");
    config
        .get("characters")
        .and_then(|v| v.get(active))
        .and_then(|v| v.get("system_prompt"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}
