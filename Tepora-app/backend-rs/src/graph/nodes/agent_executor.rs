// Agent Executor Node
// ReAct loop for tool-using agents

use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashSet;

use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::AgentState;
use crate::llama::ChatMessage;
use crate::tools::execute_tool;
use crate::server::ws::handler::send_json;

pub struct AgentExecutorNode {
    max_steps: usize,
}

impl AgentExecutorNode {
    pub fn new() -> Self {
        Self { max_steps: 6 }
    }

    pub fn with_max_steps(mut self, max_steps: usize) -> Self {
        self.max_steps = max_steps;
        self
    }
}

impl Default for AgentExecutorNode {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Node for AgentExecutorNode {
    fn id(&self) -> &'static str {
        "agent_executor"
    }

    fn name(&self) -> &'static str {
        "Agent Executor"
    }

    async fn execute(
        &self,
        state: &mut AgentState,
        ctx: &mut NodeContext<'_>,
    ) -> Result<NodeOutput, GraphError> {
        let agent_name = state
            .selected_agent_id
            .clone()
            .unwrap_or_else(|| "Professional Agent".to_string());

        // Build tool list
        let mut tool_list: Vec<String> =
            vec!["native_web_fetch".to_string(), "native_search".to_string()];
        let mcp_tools = ctx.app_state.mcp.list_tools().await;
        let mcp_tool_set: HashSet<String> = mcp_tools.iter().map(|t| t.name.clone()).collect();
        for tool in mcp_tools {
            tool_list.push(tool.name);
        }
        tool_list.sort();
        tool_list.dedup();

        // Build messages
        let mut messages = state.chat_history.clone();

        // Add agent instructions
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: build_agent_instructions(&tool_list, state.agent_mode, state.thinking_enabled),
        });

        // Add plan if available
        if let Some(plan) = &state.shared_context.current_plan {
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: format!(
                    "Planner output (follow this unless strong evidence requires adjustment):\n{}",
                    plan
                ),
            });
        }

        // Add user input
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: state.input.clone(),
        });

        // ReAct loop
        for step in 0..self.max_steps {
            let step_message = format!("Reasoning step {}/{}", step + 1, self.max_steps);
            let _ = send_json(
                ctx.sender,
                json!({
                    "type": "activity",
                    "data": {
                        "id": "agent_reasoning",
                        "status": "processing",
                        "message": step_message,
                        "agentName": &agent_name
                    }
                }),
            )
            .await;

            // Get LLM response
            let response = ctx
                .app_state
                .llama
                .chat(ctx.config, messages.clone())
                .await
                .map_err(|e| GraphError::new(self.id(), e.to_string()))?;

            // Parse decision
            let decision = parse_agent_decision(&response);

            match decision {
                AgentDecision::Final(content) => {
                    state.output = Some(content.clone());
                    state.agent_outcome = Some("final".to_string());

                    let _ = send_json(
                        ctx.sender,
                        json!({
                            "type": "activity",
                            "data": {
                                "id": "synthesize_final_response",
                                "status": "done",
                                "message": "Final response prepared",
                                "agentName": &agent_name
                            }
                        }),
                    )
                    .await;

                    let _ = send_json(
                        ctx.sender,
                        json!({
                            "type": "chunk",
                            "message": content,
                            "mode": "agent",
                            "agentName": agent_name,
                            "nodeId": "synthesize_final_response"
                        }),
                    )
                    .await;

                    let _ = send_json(ctx.sender, json!({"type": "done"})).await;

                    return Ok(NodeOutput::Final);
                }
                AgentDecision::ToolCall { name, args } => {
                    let _ = send_json(
                        ctx.sender,
                        json!({
                            "type": "activity",
                            "data": {
                                "id": "tool_node",
                                "status": "processing",
                                "message": format!("Executing tool `{}`", name),
                                "agentName": "Tool Handler"
                            }
                        }),
                    )
                    .await;

                    // Execute tool
                    let execution = match execute_tool(
                        ctx.config,
                        Some(&ctx.app_state.mcp),
                        &name,
                        &args,
                    )
                    .await
                    {
                        Ok(value) => value,
                        Err(err) => {
                            let failure = format!("Tool `{}` failed: {}", name, err);
                            let _ = send_json(
                                ctx.sender,
                                json!({
                                    "type": "activity",
                                    "data": {
                                        "id": "tool_node",
                                        "status": "error",
                                        "message": &failure,
                                        "agentName": "Tool Handler"
                                    }
                                }),
                            )
                            .await;
                            messages.push(ChatMessage {
                                role: "system".to_string(),
                                content: failure,
                            });
                            continue;
                        }
                    };

                    // Send search results if available
                    if let Some(results) = &execution.search_results {
                        let _ = send_json(
                            ctx.sender,
                            json!({ "type": "search_results", "data": results }),
                        )
                        .await;
                    }

                    let tool_result = format!("Tool `{}` result:\n{}", name, execution.output);
                    messages.push(ChatMessage {
                        role: "system".to_string(),
                        content: tool_result,
                    });

                    let _ = send_json(
                        ctx.sender,
                        json!({
                            "type": "activity",
                            "data": {
                                "id": "tool_node",
                                "status": "done",
                                "message": format!("Tool `{}` finished", name),
                                "agentName": "Tool Handler"
                            }
                        }),
                    )
                    .await;

                    let _ = send_json(
                        ctx.sender,
                        json!({
                            "type": "status",
                            "message": format!("Executed tool {} (step {}/{})", name, step + 1, self.max_steps),
                        }),
                    )
                    .await;
                }
            }
        }

        // Max steps reached
        let fallback =
            "Agent reached the maximum number of steps without a final answer.".to_string();
        state.output = Some(fallback.clone());

        let _ = send_json(
            ctx.sender,
            json!({
                "type": "activity",
                "data": {
                    "id": "synthesize_final_response",
                    "status": "error",
                    "message": &fallback,
                    "agentName": &agent_name
                }
            }),
        )
        .await;

        let _ = send_json(
            ctx.sender,
            json!({
                "type": "chunk",
                "message": fallback,
                "mode": "agent",
                "agentName": agent_name,
                "nodeId": "synthesize_final_response"
            }),
        )
        .await;

        let _ = send_json(ctx.sender, json!({"type": "done"})).await;

        Ok(NodeOutput::Final)
    }
}

enum AgentDecision {
    Final(String),
    ToolCall { name: String, args: Value },
}

fn parse_agent_decision(text: &str) -> AgentDecision {
    if let Some(json_value) = parse_json_from_text(text) {
        if let Some(decision) = parse_decision_from_value(&json_value) {
            return decision;
        }
    }
    AgentDecision::Final(text.trim().to_string())
}

fn parse_json_from_text(text: &str) -> Option<Value> {
    // Try to find JSON in the text
    let trimmed = text.trim();

    // Direct JSON parse
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return Some(v);
    }

    // Look for JSON block
    if let Some(start) = trimmed.find('{') {
        if let Some(end) = trimmed.rfind('}') {
            if let Ok(v) = serde_json::from_str::<Value>(&trimmed[start..=end]) {
                return Some(v);
            }
        }
    }

    None
}

fn parse_decision_from_value(value: &Value) -> Option<AgentDecision> {
    let action_type = value
        .get("type")
        .or_else(|| value.get("action"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if action_type == "tool_call" {
        let name = value
            .get("tool_name")
            .or_else(|| value.get("name"))
            .or_else(|| value.get("tool"))
            .and_then(|v| v.as_str())?;
        let args = value
            .get("tool_args")
            .or_else(|| value.get("args"))
            .cloned()
            .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
        return Some(AgentDecision::ToolCall {
            name: name.to_string(),
            args,
        });
    }

    if action_type == "final" {
        let content = value
            .get("content")
            .or_else(|| value.get("message"))
            .or_else(|| value.get("response"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        return Some(AgentDecision::Final(content));
    }

    None
}

fn build_agent_instructions(
    tool_names: &[String],
    mode: crate::graph::state::AgentMode,
    thinking_mode: bool,
) -> String {
    let tools = if tool_names.is_empty() {
        "None (you must solve without tools unless the user asks to change policy)".to_string()
    } else {
        tool_names.join(", ")
    };

    let thinking_note = if thinking_mode {
        "Thinking mode is enabled. Reason step-by-step before each tool call."
    } else {
        "Thinking mode is disabled. Keep reasoning concise."
    };

    format!(
        r#"You are operating in agent mode ({mode}).
{thinking_note}
You have access to the following tools: {tools}.
When you need to use a tool, respond ONLY with JSON in this format:
{{"type":"tool_call","tool_name":"<tool>","tool_args":{{...}}}}
When you have the final answer, respond ONLY with JSON in this format:
{{"type":"final","content":"..."}}
Do not include any extra text outside the JSON."#,
        mode = mode.as_str()
    )
}
