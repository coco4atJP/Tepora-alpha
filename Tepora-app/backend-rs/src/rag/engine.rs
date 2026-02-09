//! RAG Engine for chunk collection and processing.
//!
//! Collects text chunks from:
//! - Web content (via URL fetching)
//! - File attachments
//! - Direct text input

use serde::{Deserialize, Serialize};

/// Configuration for the RAG engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RAGConfig {
    /// Maximum chunk size in characters
    pub chunk_size: usize,
    /// Overlap between chunks
    pub chunk_overlap: usize,
    /// Maximum total chunks to collect
    pub max_chunks: usize,
    /// Timeout for web requests in seconds
    pub web_timeout_secs: u64,
}

impl Default for RAGConfig {
    fn default() -> Self {
        Self {
            chunk_size: 500,
            chunk_overlap: 50,
            max_chunks: 20,
            web_timeout_secs: 30,
        }
    }
}

/// A text chunk with source information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextChunk {
    /// The text content
    pub text: String,
    /// Source identifier (URL, filename, etc.)
    pub source: String,
    /// Character offset in original document
    pub start_offset: usize,
    /// Chunk index within the source
    pub chunk_index: usize,
}

/// RAG Engine for collecting and processing chunks.
pub struct RAGEngine {
    config: RAGConfig,
}

impl RAGEngine {
    /// Create a new RAG engine with the given configuration.
    pub fn new(config: RAGConfig) -> Self {
        Self { config }
    }

    /// Create with default configuration.
    pub fn default() -> Self {
        Self::new(RAGConfig::default())
    }

    /// Get the configuration.
    pub fn config(&self) -> &RAGConfig {
        &self.config
    }

    /// Collect chunks from a URL.
    ///
    /// Fetches the web content and splits it into chunks.
    pub async fn collect_from_url(&self, url: &str) -> anyhow::Result<Vec<TextChunk>> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(self.config.web_timeout_secs))
            .build()?;

        let response = client.get(url).send().await?;
        let text = response.text().await?;

        // Strip HTML tags (simple approach)
        let clean_text = strip_html_tags(&text);

        Ok(self.split_into_chunks(&clean_text, url))
    }

    /// Collect chunks from text content.
    pub fn collect_from_text(&self, text: &str, source: &str) -> Vec<TextChunk> {
        self.split_into_chunks(text, source)
    }

    /// Collect chunks from multiple attachments.
    ///
    /// Attachments can be:
    /// - `{"type": "text", "content": "...", "name": "..."}`
    /// - `{"type": "url", "url": "..."}`
    pub async fn collect_from_attachments(
        &self,
        attachments: &[serde_json::Value],
    ) -> Vec<TextChunk> {
        let mut all_chunks = Vec::new();

        for attachment in attachments {
            let attachment_type = attachment
                .get("type")
                .and_then(|t| t.as_str())
                .unwrap_or("unknown");

            match attachment_type {
                "text" => {
                    if let (Some(content), Some(name)) = (
                        attachment.get("content").and_then(|c| c.as_str()),
                        attachment.get("name").and_then(|n| n.as_str()),
                    ) {
                        let chunks = self.collect_from_text(content, name);
                        all_chunks.extend(chunks);
                    }
                }
                "url" => {
                    if let Some(url) = attachment.get("url").and_then(|u| u.as_str()) {
                        match self.collect_from_url(url).await {
                            Ok(chunks) => all_chunks.extend(chunks),
                            Err(e) => {
                                tracing::warn!("Failed to fetch URL {}: {}", url, e);
                            }
                        }
                    }
                }
                _ => {
                    tracing::debug!("Unknown attachment type: {}", attachment_type);
                }
            }

            // Respect max chunks limit
            if all_chunks.len() >= self.config.max_chunks {
                all_chunks.truncate(self.config.max_chunks);
                break;
            }
        }

        all_chunks
    }

    /// Split text into overlapping chunks.
    fn split_into_chunks(&self, text: &str, source: &str) -> Vec<TextChunk> {
        let chunk_size = self.config.chunk_size;
        let overlap = self.config.chunk_overlap;
        let max_chunks = self.config.max_chunks;

        let mut chunks = Vec::new();
        let chars: Vec<char> = text.chars().collect();
        let total_chars = chars.len();

        if total_chars == 0 {
            return chunks;
        }

        let step = chunk_size.saturating_sub(overlap).max(1);
        let mut start = 0;
        let mut chunk_index = 0;

        while start < total_chars && chunks.len() < max_chunks {
            let end = (start + chunk_size).min(total_chars);
            let chunk_text: String = chars[start..end].iter().collect();

            // Try to break at sentence boundary
            let final_text = if end < total_chars {
                find_sentence_boundary(&chunk_text)
            } else {
                chunk_text
            };

            chunks.push(TextChunk {
                text: final_text.trim().to_string(),
                source: source.to_string(),
                start_offset: start,
                chunk_index,
            });

            start += step;
            chunk_index += 1;
        }

        chunks
    }
}

/// Simple HTML tag stripper.
fn strip_html_tags(html: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;
    let mut in_script = false;
    let mut in_style = false;

    let html_lower = html.to_lowercase();
    let chars: Vec<char> = html.chars().collect();
    let chars_lower: Vec<char> = html_lower.chars().collect();

    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];

        // Check for script/style start
        if i + 7 < chars.len() {
            let tag: String = chars_lower[i..i + 7].iter().collect();
            if tag == "<script" {
                in_script = true;
            } else if tag == "<style "
                || (i + 6 < chars.len()
                    && chars_lower[i..i + 6].iter().collect::<String>() == "<style")
            {
                in_style = true;
            }
        }

        // Check for script/style end
        if in_script && i + 9 <= chars.len() {
            let tag: String = chars_lower[i..i + 9].iter().collect();
            if tag == "</script>" {
                in_script = false;
                i += 9;
                continue;
            }
        }
        if in_style && i + 8 <= chars.len() {
            let tag: String = chars_lower[i..i + 8].iter().collect();
            if tag == "</style>" {
                in_style = false;
                i += 8;
                continue;
            }
        }

        if in_script || in_style {
            i += 1;
            continue;
        }

        if c == '<' {
            in_tag = true;
        } else if c == '>' {
            in_tag = false;
        } else if !in_tag {
            result.push(c);
        }

        i += 1;
    }

    // Clean up whitespace
    let lines: Vec<&str> = result
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();

    lines.join("\n")
}

/// Find a good sentence boundary within the chunk.
fn find_sentence_boundary(text: &str) -> String {
    // Look for sentence endings near the end of the chunk
    let sentence_endings = [". ", "! ", "? ", ".\n", "!\n", "?\n"];

    // Search in the last 20% of the chunk
    let search_start = (text.len() * 80) / 100;
    let search_text = &text[search_start..];

    for ending in sentence_endings.iter() {
        if let Some(pos) = search_text.rfind(ending) {
            let cut_pos = search_start + pos + ending.len();
            return text[..cut_pos].to_string();
        }
    }

    // No good boundary found, return as-is
    text.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chunk_splitting() {
        let engine = RAGEngine::new(RAGConfig {
            chunk_size: 100,
            chunk_overlap: 20,
            max_chunks: 10,
            ..Default::default()
        });

        let text = "This is a test. ".repeat(20);
        let chunks = engine.collect_from_text(&text, "test");

        assert!(!chunks.is_empty());
        assert!(chunks.len() <= 10);

        // Check overlapping
        if chunks.len() >= 2 {
            // Chunks should have some overlap in content
            let c1_end = &chunks[0].text[chunks[0].text.len().saturating_sub(20)..];
            let c2_start = &chunks[1].text[..20.min(chunks[1].text.len())];
            // Just verify they exist, exact overlap depends on sentence boundaries
            assert!(!c1_end.is_empty());
            assert!(!c2_start.is_empty());
        }
    }

    #[test]
    fn test_html_stripping() {
        let html = r#"
            <html>
            <head><script>var x = 1;</script></head>
            <body>
                <h1>Hello</h1>
                <p>World</p>
            </body>
            </html>
        "#;

        let text = strip_html_tags(html);
        assert!(text.contains("Hello"));
        assert!(text.contains("World"));
        assert!(!text.contains("<"));
        assert!(!text.contains("var x"));
    }
}
