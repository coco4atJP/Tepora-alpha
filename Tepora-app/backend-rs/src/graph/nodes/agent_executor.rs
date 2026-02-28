// Agent Executor Node
// ReAct loop for tool-using agents with policy and confirmation flow.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;

use crate::agent::execution::{
    approval_timeout, build_agent_chat_config, build_allowed_tool_list, format_attachments,
    parse_agent_decision, resolve_execution_model_id,
    resolve_selected_agent, AgentDecision,
};
use crate::agent::instructions::build_agent_instructions;
use crate::agent::modes::RequestedAgentMode;
use crate::agent::policy::CustomToolPolicy;
use crate::context::pipeline::ContextPipeline;
use crate::context::pipeline_context::PipelineMode;
use crate::graph::node::{GraphError, Node, NodeContext, NodeOutput};
use crate::graph::state::{AgentMode, AgentState};
use crate::llm::{ChatMessage, ChatRequest};
use crate::models::event::{AgentEvent, AgentEventType};
use crate::tools::execute_tool;

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
        if let Err(e) = ctx.app_state.history.save_agent_event(&AgentEvent {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: state.session_id.clone(),
            node_name: self.id().to_string(),
            event_type: AgentEventType::NodeStarted,
            metadata: json!({"max_steps": self.max_steps}),
            created_at: chrono::Utc::now(),
        }).await {
            tracing::warn!(error = %e, "Failed to save agent event");
        }

        let selected_agent =
            resolve_selected_agent(ctx.app_state, state.selected_agent_id.as_deref());
        let active_policy = selected_agent
            .as_ref()
            .map(|agent| agent.tool_policy.clone())
            .unwrap_or_else(CustomToolPolicy::allow_all_policy);

        let (tool_list, mcp_tool_set) =
            build_allowed_tool_list(ctx.app_state, &active_policy).await;
        let agent_name = selected_agent
            .as_ref()
            .map(|agent| agent.name.clone())
            .unwrap_or_else(|| "Default Agent".to_string());

        let requested_mode = requested_mode_from_graph(state.agent_mode);
        let pipeline_mode = pipeline_mode_from_graph(state.agent_mode);

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

        let mut messages = if let Some(pipeline_ctx) = state.pipeline_context.as_ref() {
            ContextPipeline::pipeline_to_context_result(pipeline_ctx).messages
        } else {
            state.chat_history.clone()
        };

        if let Some(last) = messages.last() {
            if last.role == "user" && last.content.trim() == state.input.trim() {
                messages.pop();
            }
        }

        let agent_chat_config =
            build_agent_chat_config(ctx.app_state, ctx.config, selected_agent.as_ref());
        let model_id =
            resolve_execution_model_id(ctx.app_state, ctx.config, selected_agent.as_ref());
        let max_steps = agent_chat_config
            .get("app")
            .and_then(|v| v.get("graph_recursion_limit"))
            .and_then(|v| v.as_u64())
            .unwrap_or(self.max_steps as u64) as usize;

        if let Some(agent) = selected_agent.as_ref() {
            if !agent.system_prompt.trim().is_empty() {
                messages.push(ChatMessage {
                    role: "system".to_string(),
                    content: agent.system_prompt.clone(),
                });
            }
        }

        messages.push(ChatMessage {
            role: "system".to_string(),
            content: build_agent_instructions(
                &tool_list,
                requested_mode,
                state.thinking_budget > 0,
                selected_agent.as_ref(),
            ),
        });

        if let Some(attachment_text) = format_attachments(&state.search_attachments) {
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: attachment_text,
            });
        }

        if let Some(plan) = &state.shared_context.current_plan {
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: format!(
                    "Planner output (follow this unless strong evidence requires adjustment):\n{}",
                    plan
                ),
            });
        }

        messages.push(ChatMessage {
            role: "user".to_string(),
            content: state.input.clone(),
        });

        for step in 0..max_steps {
            let step_message = format!("Reasoning step {}/{}", step + 1, max_steps);
            ctx.sender.send_activity(
                "agent_reasoning",
                "processing",
                &step_message,
                &agent_name,
            )
            .await
            .map_err(|err| GraphError::new(self.id(), err.to_string()))?;

            let request = ChatRequest::new(messages.clone()).with_config(&agent_chat_config);
            let response = ctx
                .app_state
                .llm
                .chat(request, &model_id)
                .await
                .map_err(|err| GraphError::new(self.id(), err.to_string()))?;
            
            // Log prompting event (note: full token usage depends on extended LLM traits, keeping it simple for now)
            if let Err(e) = ctx.app_state.history.save_agent_event(&AgentEvent {
                id: uuid::Uuid::new_v4().to_string(),
                session_id: state.session_id.clone(),
                node_name: self.id().to_string(),
                event_type: AgentEventType::PromptGenerated,
                metadata: json!({
                    "step": step + 1,
                    "model_id": model_id,
                    "response_length": response.len(),
                }),
                created_at: chrono::Utc::now(),
            }).await {
                tracing::warn!(error = %e, "Failed to save agent event");
            }

            let decision = parse_agent_decision(&response);

            match decision {
                AgentDecision::Final(content) => {
                    let final_content = if content.trim().is_empty() {
                        response.trim().to_string()
                    } else {
                        content
                    };

                    state.output = Some(final_content.clone());
                    state.agent_outcome = Some("final".to_string());

                    ctx.sender.send_activity(
                        "synthesize_final_response",
                        "done",
                        "Final response prepared",
                        &agent_name,
                    )
                    .await
                    .map_err(|err| GraphError::new(self.id(), err.to_string()))?;

                    let _ = ctx.sender.send_json(
                        json!({
                            "type": "chunk",
                            "message": final_content,
                            "mode": "agent",
                            "agentName": agent_name,
                            "nodeId": "synthesize_final_response"
                        }),
                    )
                    .await;

                    let _ = ctx.sender.send_json( json!({"type": "done"})).await;

                    if let Err(e) = ctx.app_state.history.save_agent_event(&AgentEvent {
                        id: uuid::Uuid::new_v4().to_string(),
                        session_id: state.session_id.clone(),
                        node_name: self.id().to_string(),
                        event_type: AgentEventType::NodeCompleted,
                        metadata: json!({"outcome": "final"}),
                        created_at: chrono::Utc::now(),
                    }).await {
                        tracing::warn!(error = %e, "Failed to save agent event");
                    }

                    return Ok(NodeOutput::Final);
                }
                AgentDecision::ToolCall { name, args } => {
                    if !active_policy.is_tool_allowed(&name) {
                        let rejection =
                            format!("Tool `{}` is blocked by the selected agent's policy.", name);
                        ctx.sender.send_activity( "tool_guard", "error", &rejection, "Tool Guard")
                            .await
                            .map_err(|err| GraphError::new(self.id(), err.to_string()))?;
                        messages.push(ChatMessage {
                            role: "system".to_string(),
                            content: rejection,
                        });
                        continue;
                    }

                    if let Err(e) = ctx.app_state.history.save_agent_event(&AgentEvent {
                        id: uuid::Uuid::new_v4().to_string(),
                        session_id: state.session_id.clone(),
                        node_name: self.id().to_string(),
                        event_type: AgentEventType::ToolCall,
                        metadata: json!({"tool_name": name, "args": args}),
                        created_at: chrono::Utc::now(),
                    }).await {
                        tracing::warn!(error = %e, "Failed to save agent event");
                    }

                    ctx.sender.send_activity(
                        "tool_node",
                        "processing",
                        &format!("Executing tool `{}`", name),
                        "Tool Handler",
                    )
                    .await
                    .map_err(|err| GraphError::new(self.id(), err.to_string()))?;

                    let mut requires_confirmation = active_policy.requires_confirmation(&name);
                    if mcp_tool_set.contains(&name) {
                        let policy = ctx.app_state.mcp.load_policy().unwrap_or_default();
                        let is_first_use = {
                            let set = ctx
                                .approved_mcp_tools
                                .lock()
                                .map_err(|err| GraphError::new(self.id(), err.to_string()))?;
                            !set.contains(&name)
                        };
                        requires_confirmation = if is_first_use && policy.first_use_confirmation {
                            true
                        } else {
                            requires_confirmation || policy.require_tool_confirmation
                        };
                    }

                    if requires_confirmation {
                        let approved = ctx.sender.request_tool_approval(
                            ctx.pending_approvals.clone(),
                            &name,
                            &args,
                            approval_timeout(&agent_chat_config),
                        )
                        .await
                        .map_err(|err| GraphError::new(self.id(), err.to_string()))?;

                        if !approved {
                            let denial = format!("Tool `{}` was not approved by the user.", name);
                            ctx.sender.send_activity(
                                "tool_node",
                                "error",
                                &denial,
                                "Tool Handler",
                            )
                            .await
                            .map_err(|err| GraphError::new(self.id(), err.to_string()))?;
                            messages.push(ChatMessage {
                                role: "system".to_string(),
                                content: denial.clone(),
                            });
                            let _ = ctx.sender.send_json(
                                json!({
                                    "type": "status",
                                    "message": format!("Tool {} denied by user", name),
                                }),
                            )
                            .await;
                            continue;
                        }

                        if mcp_tool_set.contains(&name) {
                            if let Ok(mut set) = ctx.approved_mcp_tools.lock() {
                                set.insert(name.clone());
                            }
                        }
                    }

                    let execution = match execute_tool(
                        Some(ctx.app_state),
                        &agent_chat_config,
                        Some(&ctx.app_state.mcp),
                        Some(&state.session_id),
                        &name,
                        &args,
                    )
                    .await
                    {
                        Ok(value) => value,
                        Err(err) => {
                            let failure = format!("Tool `{}` failed: {}", name, err);
                            ctx.sender.send_activity(
                                "tool_node",
                                "error",
                                &failure,
                                "Tool Handler",
                            )
                            .await
                            .map_err(|send_err| GraphError::new(self.id(), send_err.to_string()))?;
                            messages.push(ChatMessage {
                                role: "system".to_string(),
                                content: failure,
                            });
                            continue;
                        }
                    };

                    if let Some(results) = &execution.search_results {
                        let _ = ctx.sender.send_json(
                            json!({ "type": "search_results", "data": results }),
                        )
                        .await;
                    }

                    let tool_payload = format!("Tool `{}` result:\n{}", name, execution.output);
                    let tool_kwargs = json!({
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                        "tool": name,
                    });
                    let _ = ctx
                        .app_state
                        .history
                        .add_message(&state.session_id, "tool", &tool_payload, Some(tool_kwargs))
                        .await;

                    messages.push(ChatMessage {
                        role: "system".to_string(),
                        content: tool_payload,
                    });

                    ctx.sender.send_activity(
                        "tool_node",
                        "done",
                        &format!("Tool `{}` finished", name),
                        "Tool Handler",
                    )
                    .await
                    .map_err(|err| GraphError::new(self.id(), err.to_string()))?;

                    let _ = ctx.sender.send_json(
                        json!({
                            "type": "status",
                            "message": format!("Executed tool {} (step {}/{})", name, step + 1, max_steps),
                        }),
                    )
                    .await;
                }
            }
        }

        let fallback =
            "Agent reached the maximum number of steps without a final answer.".to_string();
        state.output = Some(fallback.clone());

        ctx.sender.send_activity(
            "synthesize_final_response",
            "error",
            &fallback,
            &agent_name,
        )
        .await
        .map_err(|err| GraphError::new(self.id(), err.to_string()))?;

        let _ = ctx.sender.send_json(
            json!({
                "type": "chunk",
                "message": fallback,
                "mode": "agent",
                "agentName": agent_name,
                "nodeId": "synthesize_final_response"
            }),
        )
        .await;

        let _ = ctx.sender.send_json( json!({"type": "done"})).await;

        if let Err(e) = ctx.app_state.history.save_agent_event(&AgentEvent {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: state.session_id.clone(),
            node_name: self.id().to_string(),
            event_type: AgentEventType::NodeCompleted,
            metadata: json!({"outcome": "max_steps_reached"}),
            created_at: chrono::Utc::now(),
        }).await {
            tracing::warn!(error = %e, "Failed to save agent event");
        }

        Ok(NodeOutput::Final)
    }
}

fn requested_mode_from_graph(mode: AgentMode) -> RequestedAgentMode {
    match mode {
        AgentMode::High => RequestedAgentMode::High,
        AgentMode::Direct => RequestedAgentMode::Direct,
        AgentMode::Low => RequestedAgentMode::Low,
    }
}

fn pipeline_mode_from_graph(mode: AgentMode) -> PipelineMode {
    match mode {
        AgentMode::High => PipelineMode::AgentHigh,
        AgentMode::Low => PipelineMode::AgentLow,
        AgentMode::Direct => PipelineMode::AgentDirect,
    }
}
