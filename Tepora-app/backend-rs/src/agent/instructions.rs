use super::execution::SelectedAgentRuntime;
use super::modes::RequestedAgentMode;

pub fn build_agent_instructions(
    tool_names: &[String],
    mode: RequestedAgentMode,
    thinking_mode: bool,
    selected_agent: Option<&SelectedAgentRuntime>,
) -> String {
    let tools = if tool_names.is_empty() {
        "None (you must solve without tools unless the user asks to change policy)".to_string()
    } else {
        tool_names.join(", ")
    };
    let selected_agent_text = selected_agent
        .map(|agent| format!("Selected professional agent: {} ({})", agent.name, agent.id))
        .unwrap_or_else(|| "Selected professional agent: default".to_string());
    let thinking_note = if thinking_mode {
        "Thinking mode is enabled. Reason step-by-step before each tool call."
    } else {
        "Thinking mode is disabled. Keep reasoning concise."
    };
    format!(
        "You are operating in agent mode ({mode}).\n\
{selected_agent_text}\n\
{thinking_note}\n\
You have access to the following tools: {tools}.\n\
Return your next action through the structured decision channel.\n\
Use `type=tool_call` when invoking a tool and `type=final` when responding to the user.\n\
Do not include extra commentary or alternate formats.",
        mode = mode.as_str()
    )
}
