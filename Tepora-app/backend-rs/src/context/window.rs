//! Context Window Manager.
//!
//! Manages the LLM context window by:
//! - Estimating token counts
//! - Trimming history to fit within limits
//! - Selecting important messages to retain

use serde::{Deserialize, Serialize};

/// Configuration for context window management.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextWindowConfig {
    /// Maximum tokens in the context window
    pub max_tokens: usize,
    /// Reserved tokens for system prompt
    pub system_reserve: usize,
    /// Reserved tokens for user input
    pub input_reserve: usize,
    /// Reserved tokens for model output
    pub output_reserve: usize,
    /// Whether to preserve system messages when trimming
    pub preserve_system: bool,
    /// Minimum number of recent messages to keep
    pub min_recent_messages: usize,
}

impl Default for ContextWindowConfig {
    fn default() -> Self {
        Self {
            max_tokens: 8192,
            system_reserve: 500,
            input_reserve: 1000,
            output_reserve: 1000,
            preserve_system: true,
            min_recent_messages: 4,
        }
    }
}

/// A message in the conversation history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextMessage {
    /// Role: "system", "user", "assistant"
    pub role: String,
    /// Message content
    pub content: String,
    /// Estimated token count (cached)
    pub token_count: Option<usize>,
}

impl ContextMessage {
    /// Create a new message.
    pub fn new(role: impl Into<String>, content: impl Into<String>) -> Self {
        let content_str = content.into();
        let estimated_tokens = estimate_tokens(&content_str);
        Self {
            role: role.into(),
            content: content_str,
            token_count: Some(estimated_tokens),
        }
    }

    /// Get the estimated token count.
    pub fn tokens(&self) -> usize {
        self.token_count.unwrap_or_else(|| estimate_tokens(&self.content))
    }
}

/// Context window manager for LLM history.
pub struct ContextWindowManager {
    config: ContextWindowConfig,
}

impl ContextWindowManager {
    /// Create a new context window manager.
    pub fn new(config: ContextWindowConfig) -> Self {
        Self { config }
    }

    /// Create with default configuration.
    pub fn default() -> Self {
        Self::new(ContextWindowConfig::default())
    }

    /// Get the configuration.
    pub fn config(&self) -> &ContextWindowConfig {
        &self.config
    }

    /// Get the available tokens for history.
    pub fn available_tokens(&self) -> usize {
        self.config
            .max_tokens
            .saturating_sub(self.config.system_reserve)
            .saturating_sub(self.config.input_reserve)
            .saturating_sub(self.config.output_reserve)
    }

    /// Fit messages within the token budget.
    ///
    /// Returns the messages that should be included in the context.
    /// Older messages are removed first, but system messages and
    /// recent messages are preserved.
    pub fn fit_to_window(&self, messages: Vec<ContextMessage>) -> Vec<ContextMessage> {
        let budget = self.available_tokens();

        if messages.is_empty() {
            return messages;
        }

        let mut result = Vec::new();
        let mut total_tokens = 0;

        // Separate system messages and conversation messages
        let mut system_msgs: Vec<ContextMessage> = Vec::new();
        let mut conv_msgs: Vec<ContextMessage> = Vec::new();

        for msg in messages {
            if msg.role == "system" && self.config.preserve_system {
                system_msgs.push(msg);
            } else {
                conv_msgs.push(msg);
            }
        }

        // Add all system messages first
        for msg in system_msgs {
            let tokens = msg.tokens();
            if total_tokens + tokens <= budget {
                total_tokens += tokens;
                result.push(msg);
            }
        }

        // Determine how many conversation messages we can fit
        let remaining_budget = budget.saturating_sub(total_tokens);

        // Always include recent messages
        let min_recent = self.config.min_recent_messages.min(conv_msgs.len());
        let recent_msgs: Vec<ContextMessage> = conv_msgs.split_off(conv_msgs.len().saturating_sub(min_recent));

        // Calculate tokens needed for recent messages
        let recent_tokens: usize = recent_msgs.iter().map(|m| m.tokens()).sum();

        // Add older messages if we have space
        let older_budget = remaining_budget.saturating_sub(recent_tokens);
        let mut older_tokens = 0;

        // Add older messages from the end (most recent first among older)
        let mut older_to_add = Vec::new();
        for msg in conv_msgs.into_iter().rev() {
            let tokens = msg.tokens();
            if older_tokens + tokens <= older_budget {
                older_tokens += tokens;
                older_to_add.push(msg);
            } else {
                break;
            }
        }

        // Reverse to maintain chronological order
        older_to_add.reverse();
        result.extend(older_to_add);

        // Add recent messages
        result.extend(recent_msgs);

        result
    }

    /// Check if adding a message would exceed the budget.
    pub fn would_exceed(&self, current_tokens: usize, new_message: &ContextMessage) -> bool {
        current_tokens + new_message.tokens() > self.available_tokens()
    }

    /// Calculate total tokens in a message list.
    pub fn total_tokens(&self, messages: &[ContextMessage]) -> usize {
        messages.iter().map(|m| m.tokens()).sum()
    }
}

/// Estimate token count from text.
///
/// This is a simple estimation: ~4 characters per token for English text.
/// For production, use a proper tokenizer.
fn estimate_tokens(text: &str) -> usize {
    // Simple estimation: ~4 chars per token for English
    // This is a rough approximation - actual tokenizers needed for accuracy
    (text.len() + 3) / 4
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_estimation() {
        assert!(estimate_tokens("Hello world") > 0);
        assert!(estimate_tokens("This is a longer sentence.") > estimate_tokens("Hi"));
    }

    #[test]
    fn test_context_message() {
        let msg = ContextMessage::new("user", "Hello world");
        assert_eq!(msg.role, "user");
        assert!(msg.tokens() > 0);
    }

    #[test]
    fn test_fit_to_window() {
        let config = ContextWindowConfig {
            max_tokens: 100,
            system_reserve: 10,
            input_reserve: 10,
            output_reserve: 10,
            preserve_system: true,
            min_recent_messages: 2,
        };
        let manager = ContextWindowManager::new(config);

        let messages = vec![
            ContextMessage::new("system", "You are helpful."),
            ContextMessage::new("user", "Question 1"),
            ContextMessage::new("assistant", "Answer 1"),
            ContextMessage::new("user", "Question 2"),
            ContextMessage::new("assistant", "Answer 2"),
            ContextMessage::new("user", "Question 3"),
            ContextMessage::new("assistant", "Answer 3"),
        ];

        let fitted = manager.fit_to_window(messages);

        // Should include system message
        assert!(fitted.iter().any(|m| m.role == "system"));
        // Should include recent messages
        assert!(fitted.iter().any(|m| m.content.contains("Question 3")));
    }

    #[test]
    fn test_available_tokens() {
        let config = ContextWindowConfig {
            max_tokens: 8192,
            system_reserve: 500,
            input_reserve: 1000,
            output_reserve: 1000,
            ..Default::default()
        };
        let manager = ContextWindowManager::new(config);

        assert_eq!(manager.available_tokens(), 8192 - 500 - 1000 - 1000);
    }
}
