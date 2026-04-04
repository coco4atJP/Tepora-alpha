//! PipelineContext - Ephemeral context for a single turn.
//!
//! Each turn creates a fresh `PipelineContext` that flows through a chain of
//! `ContextWorker` implementations before being compiled into the final
//! `Vec<ChatMessage>` sent to the LLM.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::infrastructure::episodic_store::MemoryScope;
use crate::llm::ChatMessage;
use crate::memory::MemoryLayer;
use crate::tools::search::SearchResult;

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
    pub fn has_character(&self) -> bool {
        matches!(
            self,
            PipelineMode::Chat
                | PipelineMode::SearchFast
                | PipelineMode::AgentHigh
                | PipelineMode::AgentLow
        )
    }

    pub fn has_tools(&self) -> bool {
        !matches!(self, PipelineMode::Chat)
    }

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

    pub fn has_web_search(&self) -> bool {
        !matches!(self, PipelineMode::Chat)
    }

    pub fn has_scratchpad(&self) -> bool {
        matches!(
            self,
            PipelineMode::AgentHigh | PipelineMode::AgentLow | PipelineMode::AgentDirect
        )
    }

    pub fn has_sub_agents(&self) -> bool {
        matches!(self, PipelineMode::AgentHigh | PipelineMode::AgentLow)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PipelineStage {
    #[default]
    Main,
    SearchQueryGenerate,
    SearchChunkSelect,
    SearchReportBuild,
    SearchFinalSynthesis,
    AgentPlanner,
    AgentExecutor,
    AgentSynthesizer,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelTokenizerSpec {
    pub model_id: Option<String>,
    pub tokenizer_path: Option<String>,
    pub tokenizer_format: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenBudget {
    pub max_tokens: usize,
    pub max_context: usize,
    pub used_tokens: usize,
    pub reserved_output: usize,
    pub safety_margin: usize,
    pub available_input_budget: usize,
    pub estimation_source: String,
}

impl TokenBudget {
    pub fn new(max_tokens: usize, reserved_output: usize) -> Self {
        let safety_margin = (max_tokens / 10).max(96);
        Self::with_margin(max_tokens, reserved_output, safety_margin)
    }

    pub fn with_margin(max_tokens: usize, reserved_output: usize, safety_margin: usize) -> Self {
        let available_input_budget = max_tokens
            .saturating_sub(safety_margin)
            .saturating_sub(reserved_output);
        Self {
            max_tokens,
            max_context: max_tokens,
            used_tokens: 0,
            reserved_output,
            safety_margin,
            available_input_budget,
            estimation_source: "heuristic".to_string(),
        }
    }

    pub fn available_input_budget(&self) -> usize {
        self.available_input_budget.saturating_sub(self.used_tokens)
    }

    pub fn remaining(&self) -> usize {
        self.available_input_budget()
    }

    pub fn consume(&mut self, tokens: usize) {
        self.used_tokens = self.used_tokens.saturating_add(tokens);
    }

    pub fn set_estimation_source(&mut self, source: impl Into<String>) {
        self.estimation_source = source.into();
    }

    pub fn is_exceeded(&self) -> bool {
        self.used_tokens + self.safety_margin + self.reserved_output > self.max_tokens
    }
}

impl Default for TokenBudget {
    fn default() -> Self {
        Self::new(2048, 256)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemPart {
    pub label: String,
    pub content: String,
    pub priority: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterConfig {
    pub name: String,
    pub description: String,
    pub traits: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryChunk {
    pub content: String,
    pub relevance_score: f32,
    pub source: String,
    pub strength: f64,
    pub memory_layer: MemoryLayer,
    pub scope: MemoryScope,
    pub session_id: String,
    pub character_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InteractionTail {
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LocalContext {
    pub goal: Option<String>,
    pub constraints: Vec<String>,
    pub resolved_points: Vec<String>,
    pub open_questions: Vec<String>,
    pub current_topic: Option<String>,
    pub session_entities: Vec<String>,
}

impl LocalContext {
    pub fn is_empty(&self) -> bool {
        self.goal.as_deref().unwrap_or("").trim().is_empty()
            && self.constraints.is_empty()
            && self.resolved_points.is_empty()
            && self.open_questions.is_empty()
            && self
                .current_topic
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
            && self.session_entities.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagChunk {
    pub chunk_id: String,
    pub content: String,
    pub source: String,
    pub score: f32,
    pub metadata: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScratchpadEntry {
    pub thought: String,
    pub action: Option<String>,
    pub observation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubAgentResult {
    pub agent_id: String,
    pub agent_name: String,
    pub result: String,
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool_name: String,
    pub result: Value,
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineArtifact {
    pub artifact_type: String,
    pub content: String,
    pub metadata: HashMap<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReasoningState {
    pub app_thinking_raw: Vec<String>,
    pub app_thinking_digest: Option<String>,
    pub model_thinking_raw: Vec<String>,
    pub model_thinking_digest: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PipelineContext {
    pub session_id: String,
    pub turn_id: String,
    pub mode: PipelineMode,
    pub stage: PipelineStage,
    pub config_snapshot: Value,
    pub system_parts: Vec<SystemPart>,
    pub character: Option<CharacterConfig>,
    pub user_input: String,
    pub working_memory: HashMap<String, Value>,
    pub local_context: LocalContext,
    pub interaction_tail: Option<InteractionTail>,
    pub memory_chunks: Vec<MemoryChunk>,
    pub search_results: Vec<SearchResult>,
    pub rag_chunks: Vec<RagChunk>,
    pub artifacts: Vec<PipelineArtifact>,
    pub scratchpad: Vec<ScratchpadEntry>,
    pub tool_results: Vec<ToolResult>,
    pub sub_agent_results: Vec<SubAgentResult>,
    pub reasoning: ReasoningState,
    pub token_budget: TokenBudget,
    pub tokenizer_spec: ModelTokenizerSpec,
}

impl PipelineContext {
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
            stage: PipelineStage::Main,
            config_snapshot: Value::Null,
            system_parts: Vec::new(),
            character: None,
            user_input: user_input.into(),
            working_memory: HashMap::new(),
            local_context: LocalContext::default(),
            interaction_tail: None,
            memory_chunks: Vec::new(),
            search_results: Vec::new(),
            rag_chunks: Vec::new(),
            artifacts: Vec::new(),
            scratchpad: Vec::new(),
            tool_results: Vec::new(),
            sub_agent_results: Vec::new(),
            reasoning: ReasoningState::default(),
            token_budget: TokenBudget::default(),
            tokenizer_spec: ModelTokenizerSpec::default(),
        }
    }

    pub fn with_token_budget(mut self, budget: TokenBudget) -> Self {
        self.token_budget = budget;
        self
    }

    pub fn with_stage(mut self, stage: PipelineStage) -> Self {
        self.stage = stage;
        self
    }

    pub fn with_config_snapshot(mut self, config_snapshot: Value) -> Self {
        self.config_snapshot = config_snapshot;
        self
    }

    pub fn with_tokenizer_spec(mut self, tokenizer_spec: ModelTokenizerSpec) -> Self {
        self.tokenizer_spec = tokenizer_spec;
        self
    }

    pub fn with_messages(mut self, messages: Vec<ChatMessage>) -> Self {
        self.interaction_tail = if messages.is_empty() {
            None
        } else {
            Some(InteractionTail { messages })
        };
        self
    }

    pub fn to_messages(&self) -> Vec<ChatMessage> {
        super::controller::ContextController::new(self).render(self)
    }

    pub fn config(&self) -> &Value {
        &self.config_snapshot
    }

    pub(crate) fn build_system_prompt(&self) -> String {
        let mut parts = self.system_parts.clone();
        parts.sort_by(|a, b| b.priority.cmp(&a.priority));
        parts
            .iter()
            .map(|p| p.content.clone())
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    pub(crate) fn scratchpad_messages(&self) -> Vec<ChatMessage> {
        let mut out = Vec::new();
        for entry in &self.scratchpad {
            out.push(ChatMessage {
                role: "assistant".to_string(),
                content: format!("Thought: {}", entry.thought),
                multimodal_parts: None,
            });
            if let Some(action) = &entry.action {
                out.push(ChatMessage {
                    role: "assistant".to_string(),
                    content: format!("Action: {action}"),
                    multimodal_parts: None,
                });
            }
            if let Some(obs) = &entry.observation {
                out.push(ChatMessage {
                    role: "user".to_string(),
                    content: format!("Observation: {obs}"),
                    multimodal_parts: None,
                });
            }
        }
        out
    }

    pub fn estimate_tokens(&self) -> usize {
        let messages = self.to_messages();
        messages.iter().map(|m| m.content.len().div_ceil(4)).sum()
    }

    pub fn add_system_part(
        &mut self,
        label: impl Into<String>,
        content: impl Into<String>,
        priority: u8,
    ) {
        self.system_parts.push(SystemPart {
            label: label.into(),
            content: content.into(),
            priority,
        });
    }

    pub fn add_artifact(
        &mut self,
        artifact_type: impl Into<String>,
        content: impl Into<String>,
        metadata: HashMap<String, Value>,
    ) {
        self.artifacts.push(PipelineArtifact {
            artifact_type: artifact_type.into(),
            content: content.into(),
            metadata,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pipeline_context_new() {
        let ctx = PipelineContext::new("sess-1", "turn-1", PipelineMode::Chat, "hello");
        assert_eq!(ctx.session_id, "sess-1");
        assert_eq!(ctx.turn_id, "turn-1");
        assert_eq!(ctx.mode, PipelineMode::Chat);
        assert_eq!(ctx.stage, PipelineStage::Main);
        assert_eq!(ctx.user_input, "hello");
        assert!(ctx.system_parts.is_empty());
        assert!(ctx.character.is_none());
    }

    #[test]
    fn test_pipeline_mode_capabilities() {
        assert!(PipelineMode::Chat.has_character());
        assert!(!PipelineMode::Chat.has_tools());
        assert!(!PipelineMode::Chat.has_rag());

        assert!(PipelineMode::SearchFast.has_character());
        assert!(PipelineMode::SearchFast.has_tools());
        assert!(PipelineMode::SearchFast.has_rag());
        assert!(PipelineMode::SearchFast.has_web_search());

        assert!(PipelineMode::AgentHigh.has_character());
        assert!(PipelineMode::AgentHigh.has_tools());
        assert!(PipelineMode::AgentHigh.has_scratchpad());
        assert!(PipelineMode::AgentHigh.has_sub_agents());

        assert!(!PipelineMode::AgentDirect.has_character());
        assert!(PipelineMode::AgentDirect.has_tools());
        assert!(!PipelineMode::AgentDirect.has_sub_agents());
    }

    #[test]
    fn test_token_budget() {
        let mut budget = TokenBudget::with_margin(8192, 1024, 128);
        assert_eq!(budget.remaining(), 8192 - 1024 - 128);
        assert!(!budget.is_exceeded());

        budget.consume(6000);
        assert_eq!(budget.remaining(), 8192 - 6000 - 1024 - 128);
        assert!(!budget.is_exceeded());

        budget.consume(2000);
        assert!(budget.is_exceeded());
    }

    #[test]
    fn test_to_messages_basic() {
        let mut ctx = PipelineContext::new("s1", "t1", PipelineMode::Chat, "test input");
        ctx.add_system_part("base", "You are an assistant.", 100);

        let msgs = ctx.to_messages();
        assert!(msgs.len() >= 2);
        assert_eq!(msgs[0].role, "system");
        assert!(msgs[0].content.contains("assistant"));
        assert_eq!(msgs.last().unwrap().role, "user");
        assert_eq!(msgs.last().unwrap().content, "test input");
    }

    #[test]
    fn test_to_messages_with_persona() {
        let mut ctx = PipelineContext::new("s1", "t1", PipelineMode::Chat, "hello");
        ctx.add_system_part("base", "Base prompt", 100);
        ctx.character = Some(CharacterConfig {
            name: "Tepora".to_string(),
            description: "A calm tea-loving AI".to_string(),
            traits: vec!["warm".to_string(), "calm".to_string()],
        });

        let msgs = ctx.to_messages();
        let system = &msgs[0].content;
        assert!(system.contains("Base prompt"));
    }

    #[test]
    fn test_to_messages_with_rag() {
        let mut ctx = PipelineContext::new("s1", "t1", PipelineMode::SearchFast, "search test");
        ctx.rag_chunks.push(RagChunk {
            chunk_id: "c1".to_string(),
            content: "RAG chunk content".to_string(),
            source: "doc.pdf".to_string(),
            score: 0.95,
            metadata: HashMap::new(),
        });

        let msgs = ctx.to_messages();
        let has_rag = msgs.iter().any(|m| m.content.contains("[Evidence"));
        assert!(has_rag);
    }

    #[test]
    fn test_system_parts_priority_ordering() {
        let mut ctx = PipelineContext::new("s1", "t1", PipelineMode::Chat, "input");
        ctx.add_system_part("low", "low priority", 10);
        ctx.add_system_part("high", "high priority", 200);
        ctx.add_system_part("mid", "mid priority", 100);

        let system_prompt = ctx.build_system_prompt();
        let high_pos = system_prompt.find("high priority").unwrap();
        let mid_pos = system_prompt.find("mid priority").unwrap();
        let low_pos = system_prompt.find("low priority").unwrap();

        assert!(high_pos < mid_pos);
        assert!(mid_pos < low_pos);
    }
}
