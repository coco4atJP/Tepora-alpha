use serde_json::Value;

use crate::core::errors::ApiError;
use crate::llm::{ChatMessage, ChatRequest};
use crate::state::AppState;

use super::execution::SelectedAgentRuntime;

pub async fn generate_execution_plan(
    state: &AppState,
    chat_config: &Value,
    user_input: &str,
    context_messages: &[ChatMessage],
    selected_agent: Option<&SelectedAgentRuntime>,
    thinking_mode: bool,
    model_id: &str,
) -> Result<String, ApiError> {
    let selected = selected_agent
        .map(|agent| {
            if agent.controller_summary.trim().is_empty() {
                format!("{} ({})", agent.name, agent.id)
            } else {
                format!(
                    "{} ({})\nSummary: {}",
                    agent.name, agent.id, agent.controller_summary
                )
            }
        })
        .unwrap_or_else(|| "default".to_string());
    let detail = if thinking_mode { "detailed" } else { "compact" };

    let mut planning_messages = context_messages.to_vec();
    if let Some(last) = planning_messages.last() {
        if last.role == "user" && last.content.trim() == user_input.trim() {
            planning_messages.pop();
        }
    }

    planning_messages.push(ChatMessage {
        role: "system".to_string(),
        content: "You are a planner for a tool-using AI agent.\nCreate a practical execution plan with up to 6 ordered steps.\nUse concise markdown bullets and include fallback actions.\nDo not add any text before or after the plan.".to_string(),
    });
    planning_messages.push(ChatMessage {
        role: "user".to_string(),
        content: format!(
            "User request:\n{}\n\nPreferred executor:\n{}\n\nDetail level:\n{}",
            user_input, selected, detail
        ),
    });

    let request = ChatRequest::new(planning_messages).with_config(chat_config);
    let plan = state.llm.chat(request, model_id).await?;
    let trimmed = plan.trim();
    if trimmed.is_empty() {
        return Ok(
            "- Clarify objective and constraints\n- Gather required evidence\n- Execute tools safely\n- Synthesize final answer"
                .to_string(),
        );
    }
    Ok(trimmed.to_string())
}

pub fn requires_fast_mode_planning(user_input: &str) -> bool {
    let lowered = user_input.to_lowercase();
    if lowered.len() > 220 {
        return true;
    }

    let indicators = [
        "step by step",
        "plan",
        "roadmap",
        "architecture",
        "migration",
        "strategy",
        "analysis",
        "complex",
        "比較",
        "分析",
        "計画",
        "設計",
        "段階",
        "手順",
        "移行",
        "包括",
        "複雑",
    ];
    indicators.iter().any(|keyword| lowered.contains(keyword))
}
