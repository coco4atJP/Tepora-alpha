//! PipelineContext — Ephemeral context for a single turn.
//!
//! Each turn creates a fresh `PipelineContext` that flows through a chain of
//! `ContextWorker` implementations, accumulating system prompts, persona,
//! memory, tool definitions, search results, and RAG chunks before being
//! compiled into the final `Vec<ChatMessage>` sent to the LLM.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::llama::ChatMessage;
use crate::tools::search::SearchResult;

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/// Fine-grained pipeline mode that distinguishes every execution path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PipelineMode {
    Chat,
    SearchFast,
    SearchAgentic,
    AgentHigh,
    AgentLow,
    AgentDirect,
}

impl PipelineMode {
    /// Whether this mode should include a persona.
    pub fn has_persona(&self) -> bool {
        matches!(
            self,
            PipelineMode::Chat
                | PipelineMode::SearchFast
                | PipelineMode::AgentHigh // Synthesis only
                | PipelineMode::AgentLow  // Synthesis only
        )
    }

    /// Whether this mode supports tool usage.
    pub fn has_tools(&self) -> bool {
        !matches!(self, PipelineMode::Chat)
    }

    /// Whether this mode supports RAG.
    pub fn has_rag(&self) -> bool {
        matches!(
            self,
            PipelineMode::SearchFast
                | PipelineMode::SearchAgentic
                | PipelineMode::AgentHigh
                | PipelineMode::AgentLow
                | PipelineMode::AgentDirect
        )
    }

    /// Whether this mode supports web search.
    pub fn has_web_search(&self) -> bool {
        !matches!(self, PipelineMode::Chat)
    }

    /// Whether this mode uses a scratchpad (ReAct loop).
    pub fn has_scratchpad(&self) -> bool {
        matches!(
            self,
            PipelineMode::AgentHigh
                | PipelineMode::AgentLow
                | PipelineMode::AgentDirect
        )
    }

    /// Whether this mode supports sub-agent calls.
    pub fn has_sub_agents(&self) -> bool {
        matches!(self, PipelineMode::AgentHigh | PipelineMode::AgentLow)
    }
}

/// Token budget tracking for context window management.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenBudget {
    /// Maximum tokens allowed in the context.
    pub max_tokens: usize,
    /// Tokens consumed so far.
    pub used_tokens: usize,
    /// Tokens reserved for the model's output.
    pub reserved_output: usize,
}

impl TokenBudget {
    pub fn new(max_tokens: usize, reserved_output: usize) -> Self {
        Self {
            max_tokens,
            used_tokens: 0,
            reserved_output,
        }
    }

    /// Remaining tokens available for context content.
    pub fn remaining(&self) -> usize {
        self.max_tokens
            .saturating_sub(self.used_tokens)
            .saturating_sub(self.reserved_output)
    }

    /// Record additional token usage.
    pub fn consume(&mut self, tokens: usize) {
        self.used_tokens = self.used_tokens.saturating_add(tokens);
    }

    /// Whether the budget has been exceeded.
    pub fn is_exceeded(&self) -> bool {
        self.used_tokens + self.reserved_output > self.max_tokens
    }
}

impl Default for TokenBudget {
    fn default() -> Self {
        Self::new(8192, 1024)
    }
}

/// A labelled piece of the system prompt with priority ordering.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemPart {
    /// Human-readable label (e.g. "base_instructions", "mode_context").
    pub label: String,
    /// The actual prompt text.
    pub content: String,
    /// Priority (higher = more important; kept when trimming).
    pub priority: u8,
}

/// Persona / character configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonaConfig {
    pub name: String,
    pub description: String,
    pub traits: Vec<String>,
    /// Raw persona prompt text injected into system.
    pub prompt_text: Option<String>,
}

/// A chunk of long-term memory retrieved by EM-LLM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryChunk {
    pub content: String,
    pub relevance_score: f32,
    pub source: String,
}

/// A chunk retrieved from the RAG store.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagChunk {
    pub chunk_id: String,
    pub content: String,
    pub source: String,
    pub score: f32,
    pub metadata: HashMap<String, Value>,
}

/// A single entry in the agent's ReAct scratchpad.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScratchpadEntry {
    pub thought: String,
    pub action: Option<String>,
    pub observation: Option<String>,
}

/// Result returned by a sub-agent invocation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubAgentResult {
    pub agent_id: String,
    pub agent_name: String,
    pub result: String,
    pub success: bool,
}

/// Result from a tool invocation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool_name: String,
    pub result: Value,
    pub success: bool,
}

/// Artifact produced or consumed during a session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineArtifact {
    pub artifact_type: String,
    pub content: String,
    pub metadata: HashMap<String, Value>,
}

// ---------------------------------------------------------------------------
// PipelineContext
// ---------------------------------------------------------------------------

/// Ephemeral context built for a single conversational turn.
///
/// Created by the graph entry point, mutated by a chain of `ContextWorker`s,
/// and finally compiled into `Vec<ChatMessage>` for the LLM call.
#[derive(Debug, Clone)]
pub struct PipelineContext {
    // — Identification —
    pub session_id: String,
    pub turn_id: String,
    pub mode: PipelineMode,

    // — Context building —
    pub system_parts: Vec<SystemPart>,
    pub persona: Option<PersonaConfig>,
    pub messages: Vec<ChatMessage>,
    pub user_input: String,

    // — Memory —
    /// Ephemeral working memory shared between workers in a single turn.
    pub working_memory: HashMap<String, Value>,
    /// Long-term memory chunks from EM-LLM.
    pub memory_chunks: Vec<MemoryChunk>,

    // — Search & RAG —
    pub search_results: Vec<SearchResult>,
    pub rag_chunks: Vec<RagChunk>,

    // — Agent context —
    pub artifacts: Vec<PipelineArtifact>,
    pub scratchpad: Vec<ScratchpadEntry>,
    pub tool_results: Vec<ToolResult>,
    pub sub_agent_results: Vec<SubAgentResult>,

    // — Budget —
    pub token_budget: TokenBudget,
}

impl PipelineContext {
    /// Create a new pipeline context for a turn.
    pub fn new(
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        mode: PipelineMode,
        user_input: impl Into<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            turn_id: turn_id.into(),
            mode,
            system_parts: Vec::new(),
            persona: None,
            messages: Vec::new(),
            user_input: user_input.into(),
            working_memory: HashMap::new(),
            memory_chunks: Vec::new(),
            search_results: Vec::new(),
            rag_chunks: Vec::new(),
            artifacts: Vec::new(),
            scratchpad: Vec::new(),
            tool_results: Vec::new(),
            sub_agent_results: Vec::new(),
            token_budget: TokenBudget::default(),
        }
    }

    /// Set the token budget.
    pub fn with_token_budget(mut self, budget: TokenBudget) -> Self {
        self.token_budget = budget;
        self
    }

    /// Set initial chat history messages.
    pub fn with_messages(mut self, messages: Vec<ChatMessage>) -> Self {
        self.messages = messages;
        self
    }

    // -----------------------------------------------------------------------
    // Compilation — turn the accumulated context into LLM messages
    // -----------------------------------------------------------------------

    /// Compile all accumulated parts into a final `Vec<ChatMessage>` suitable
    /// for sending to the LLM.
    pub fn to_messages(&self) -> Vec<ChatMessage> {
        let mut out = Vec::new();

        // 1. System prompt (sorted by priority, highest first)
        let system_text = self.build_system_prompt();
        if !system_text.is_empty() {
            out.push(ChatMessage {
                role: "system".to_string(),
                content: system_text,
            });
        }

        // 2. Memory context
        if !self.memory_chunks.is_empty() {
            let memory_text = self
                .memory_chunks
                .iter()
                .map(|c| c.content.as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            out.push(ChatMessage {
                role: "system".to_string(),
                content: format!("[Memory Context]\n{memory_text}"),
            });
        }

        // 3. RAG context
        if !self.rag_chunks.is_empty() {
            let rag_text = self
                .rag_chunks
                .iter()
                .enumerate()
                .map(|(i, c)| format!("[{}] (score: {:.2}) {}", i + 1, c.score, c.content))
                .collect::<Vec<_>>()
                .join("\n\n");
            out.push(ChatMessage {
                role: "system".to_string(),
                content: format!("[RAG Context]\n{rag_text}"),
            });
        }

        // 4. Search results
        if !self.search_results.is_empty() {
            if let Ok(json) = serde_json::to_string_pretty(&self.search_results) {
                out.push(ChatMessage {
                    role: "system".to_string(),
                    content: format!(
                        "Web search results (cite as [Source: URL]):\n{json}"
                    ),
                });
            }
        }

        // 5. Artifacts
        if !self.artifacts.is_empty() {
            let artifacts_text = self
                .artifacts
                .iter()
                .map(|a| format!("[Artifact: {}]\n{}", a.artifact_type, a.content))
                .collect::<Vec<_>>()
                .join("\n\n---\n\n");
            out.push(ChatMessage {
                role: "system".to_string(),
                content: format!("[Artifacts]\n{artifacts_text}"),
            });
        }

        // 6. Sub-agent results
        if !self.sub_agent_results.is_empty() {
            let results_text = self
                .sub_agent_results
                .iter()
                .map(|r| {
                    let status = if r.success { "✓" } else { "✗" };
                    format!("[{status} {}] {}", r.agent_name, r.result)
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            out.push(ChatMessage {
                role: "system".to_string(),
                content: format!("[Sub-Agent Results]\n{results_text}"),
            });
        }

        // 7. Conversation history
        out.extend(self.messages.clone());

        // 8. Scratchpad (ReAct)
        for entry in &self.scratchpad {
            out.push(ChatMessage {
                role: "assistant".to_string(),
                content: format!("Thought: {}", entry.thought),
            });
            if let Some(action) = &entry.action {
                out.push(ChatMessage {
                    role: "assistant".to_string(),
                    content: format!("Action: {action}"),
                });
            }
            if let Some(obs) = &entry.observation {
                out.push(ChatMessage {
                    role: "user".to_string(),
                    content: format!("Observation: {obs}"),
                });
            }
        }

        // 9. Current user input (always last, unless already in messages)
        if !self.user_input.is_empty() {
            out.push(ChatMessage {
                role: "user".to_string(),
                content: self.user_input.clone(),
            });
        }

        out
    }

    /// Build the combined system prompt from all system parts.
    fn build_system_prompt(&self) -> String {
        let mut parts = self.system_parts.clone();
        parts.sort_by(|a, b| b.priority.cmp(&a.priority));

        let mut sections: Vec<String> = parts
            .iter()
            .map(|p| p.content.clone())
            .collect();

        // Inject persona if present
        if let Some(persona) = &self.persona {
            let persona_section = if let Some(prompt) = &persona.prompt_text {
                prompt.clone()
            } else {
                let traits = persona.traits.join(", ");
                format!(
                    "あなたの名前は{}です。{}\n性格特性: {}",
                    persona.name, persona.description, traits
                )
            };
            sections.push(persona_section);
        }

        sections.join("\n\n")
    }

    /// Estimate total tokens in the compiled context.
    pub fn estimate_tokens(&self) -> usize {
        let messages = self.to_messages();
        messages
            .iter()
            .map(|m| m.content.len().div_ceil(4))
            .sum()
    }

    /// Add a system part.
    pub fn add_system_part(&mut self, label: impl Into<String>, content: impl Into<String>, priority: u8) {
        self.system_parts.push(SystemPart {
            label: label.into(),
            content: content.into(),
            priority,
        });
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pipeline_context_new() {
        let ctx = PipelineContext::new("sess-1", "turn-1", PipelineMode::Chat, "Hello");
        assert_eq!(ctx.session_id, "sess-1");
        assert_eq!(ctx.turn_id, "turn-1");
        assert_eq!(ctx.mode, PipelineMode::Chat);
        assert_eq!(ctx.user_input, "Hello");
        assert!(ctx.system_parts.is_empty());
        assert!(ctx.persona.is_none());
    }

    #[test]
    fn test_pipeline_mode_capabilities() {
        assert!(PipelineMode::Chat.has_persona());
        assert!(!PipelineMode::Chat.has_tools());
        assert!(!PipelineMode::Chat.has_rag());

        assert!(PipelineMode::SearchFast.has_persona());
        assert!(PipelineMode::SearchFast.has_tools());
        assert!(PipelineMode::SearchFast.has_rag());
        assert!(PipelineMode::SearchFast.has_web_search());

        assert!(PipelineMode::AgentHigh.has_persona());
        assert!(PipelineMode::AgentHigh.has_tools());
        assert!(PipelineMode::AgentHigh.has_scratchpad());
        assert!(PipelineMode::AgentHigh.has_sub_agents());

        assert!(!PipelineMode::AgentDirect.has_persona());
        assert!(PipelineMode::AgentDirect.has_tools());
        assert!(!PipelineMode::AgentDirect.has_sub_agents());
    }

    #[test]
    fn test_token_budget() {
        let mut budget = TokenBudget::new(8192, 1024);
        assert_eq!(budget.remaining(), 8192 - 1024);
        assert!(!budget.is_exceeded());

        budget.consume(6000);
        assert_eq!(budget.remaining(), 8192 - 6000 - 1024);
        assert!(!budget.is_exceeded());

        budget.consume(2000);
        assert!(budget.is_exceeded());
    }

    #[test]
    fn test_to_messages_basic() {
        let mut ctx = PipelineContext::new("s1", "t1", PipelineMode::Chat, "テスト入力");
        ctx.add_system_part("base", "あなたはアシスタントです。", 100);

        let msgs = ctx.to_messages();
        assert!(msgs.len() >= 2); // system + user input
        assert_eq!(msgs[0].role, "system");
        assert!(msgs[0].content.contains("アシスタント"));
        assert_eq!(msgs.last().unwrap().role, "user");
        assert_eq!(msgs.last().unwrap().content, "テスト入力");
    }

    #[test]
    fn test_to_messages_with_persona() {
        let mut ctx = PipelineContext::new("s1", "t1", PipelineMode::Chat, "こんにちは");
        ctx.add_system_part("base", "基本プロンプト", 100);
        ctx.persona = Some(PersonaConfig {
            name: "Tepora".to_string(),
            description: "優しい紅茶好きのAI".to_string(),
            traits: vec!["warm".to_string(), "calm".to_string()],
            prompt_text: None,
        });

        let msgs = ctx.to_messages();
        let system = &msgs[0].content;
        assert!(system.contains("Tepora"));
        assert!(system.contains("warm"));
    }

    #[test]
    fn test_to_messages_with_rag() {
        let mut ctx = PipelineContext::new("s1", "t1", PipelineMode::SearchFast, "検索テスト");
        ctx.rag_chunks.push(RagChunk {
            chunk_id: "c1".to_string(),
            content: "RAGチャンクの中身".to_string(),
            source: "doc.pdf".to_string(),
            score: 0.95,
            metadata: HashMap::new(),
        });

        let msgs = ctx.to_messages();
        let has_rag = msgs.iter().any(|m| m.content.contains("[RAG Context]"));
        assert!(has_rag);
    }

    #[test]
    fn test_system_parts_priority_ordering() {
        let mut ctx = PipelineContext::new("s1", "t1", PipelineMode::Chat, "入力");
        ctx.add_system_part("low", "低優先度", 10);
        ctx.add_system_part("high", "高優先度", 200);
        ctx.add_system_part("mid", "中優先度", 100);

        let system_prompt = ctx.build_system_prompt();
        let high_pos = system_prompt.find("高優先度").unwrap();
        let mid_pos = system_prompt.find("中優先度").unwrap();
        let low_pos = system_prompt.find("低優先度").unwrap();

        assert!(high_pos < mid_pos);
        assert!(mid_pos < low_pos);
    }
}
