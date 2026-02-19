use serde_json::Value;

use crate::core::errors::ApiError;
use crate::llm::ChatMessage;
use crate::models::types::ModelRuntimeConfig;
use crate::state::AppState;

use super::execution::SelectedAgentRuntime;

pub async fn generate_execution_plan(
    state: &AppState,
    chat_config: &Value,
    user_input: &str,
    selected_agent: Option<&SelectedAgentRuntime>,
    thinking_mode: bool,
) -> Result<String, ApiError> {
    let selected = selected_agent
        .map(|agent| format!("{} ({})", agent.name, agent.id))
        .unwrap_or_else(|| "default".to_string());
    let detail = if thinking_mode { "detailed" } else { "compact" };

    let planning_messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: "You are a planner for a tool-using AI agent.\n\
Create a practical execution plan with up to 6 ordered steps.\n\
Use concise markdown bullets and include fallback actions.\n\
Do not add any text before or after the plan."
                .to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: format!(
                "User request:\n{}\n\nPreferred executor:\n{}\n\nDetail level:\n{}",
                user_input, selected, detail
            ),
        },
    ];

    let config = ModelRuntimeConfig::for_chat(chat_config)?;
    let plan = state.llama.chat(&config, planning_messages, std::time::Duration::from_secs(5)).await?;
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
