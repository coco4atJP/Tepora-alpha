//! RAG Context Builder.
//!
//! Builds context strings from collected chunks by:
//! 1. Computing embeddings for query and chunks
//! 2. Selecting top-k most similar chunks
//! 3. Formatting into a context string with citations

use super::engine::TextChunk;
use serde::{Deserialize, Serialize};

/// Configuration for context building.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextBuilderConfig {
    /// Maximum number of chunks to include
    pub top_k: usize,
    /// Maximum total context length in characters
    pub max_context_length: usize,
    /// Whether to include source citations
    pub include_citations: bool,
    /// Similarity threshold (0.0-1.0)
    pub similarity_threshold: f64,
}

impl Default for ContextBuilderConfig {
    fn default() -> Self {
        Self {
            top_k: 5,
            max_context_length: 4000,
            include_citations: true,
            similarity_threshold: 0.3,
        }
    }
}

/// A chunk with its computed similarity score.
#[derive(Debug, Clone)]
struct ScoredChunk {
    chunk: TextChunk,
    score: f64,
}

/// RAG Context Builder.
///
/// Builds optimized context strings from chunks using embedding similarity.
pub struct RAGContextBuilder {
    config: ContextBuilderConfig,
}

impl RAGContextBuilder {
    /// Create a new context builder with the given configuration.
    pub fn new(config: ContextBuilderConfig) -> Self {
        Self { config }
    }

    /// Create with default configuration.
    pub fn default() -> Self {
        Self::new(ContextBuilderConfig::default())
    }

    /// Get the configuration.
    pub fn config(&self) -> &ContextBuilderConfig {
        &self.config
    }

    /// Build context from chunks using pre-computed embeddings.
    ///
    /// # Arguments
    /// * `chunks` - List of text chunks
    /// * `chunk_embeddings` - Embedding for each chunk (same order as chunks)
    /// * `query_embedding` - Embedding for the query
    ///
    /// # Returns
    /// Formatted context string with top-k most relevant chunks
    pub fn build_context(
        &self,
        chunks: &[TextChunk],
        chunk_embeddings: &[Vec<f32>],
        query_embedding: &[f32],
    ) -> String {
        if chunks.is_empty() || chunks.len() != chunk_embeddings.len() {
            return String::new();
        }

        // Score chunks by similarity
        let mut scored_chunks: Vec<ScoredChunk> = chunks
            .iter()
            .zip(chunk_embeddings.iter())
            .map(|(chunk, emb)| ScoredChunk {
                chunk: chunk.clone(),
                score: cosine_similarity(query_embedding, emb),
            })
            .filter(|sc| sc.score >= self.config.similarity_threshold)
            .collect();

        // Sort by score (descending)
        scored_chunks.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

        // Take top-k
        scored_chunks.truncate(self.config.top_k);

        // Build context string
        self.format_context(&scored_chunks)
    }

    /// Build context using a simple keyword-based scoring (fallback when embeddings unavailable).
    ///
    /// # Arguments
    /// * `chunks` - List of text chunks
    /// * `query` - The query string
    ///
    /// # Returns
    /// Formatted context string with top-k most relevant chunks
    pub fn build_context_keyword(
        &self,
        chunks: &[TextChunk],
        query: &str,
    ) -> String {
        if chunks.is_empty() {
            return String::new();
        }

        let query_lower = query.to_lowercase();
        let query_terms: Vec<&str> = query_lower.split_whitespace().collect();

        let mut scored_chunks: Vec<ScoredChunk> = chunks
            .iter()
            .map(|chunk| {
                let chunk_lower = chunk.text.to_lowercase();
                let score = query_terms
                    .iter()
                    .filter(|term| chunk_lower.contains(*term))
                    .count() as f64
                    / query_terms.len().max(1) as f64;

                ScoredChunk {
                    chunk: chunk.clone(),
                    score,
                }
            })
            .filter(|sc| sc.score > 0.0)
            .collect();

        scored_chunks.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        scored_chunks.truncate(self.config.top_k);

        self.format_context(&scored_chunks)
    }

    /// Format scored chunks into a context string.
    fn format_context(&self, scored_chunks: &[ScoredChunk]) -> String {
        if scored_chunks.is_empty() {
            return String::new();
        }

        let mut context = String::new();
        let mut current_length = 0;
        let max_length = self.config.max_context_length;

        for (i, sc) in scored_chunks.iter().enumerate() {
            let chunk_text = &sc.chunk.text;

            // Check if adding this chunk would exceed max length
            let addition_length = chunk_text.len() + 50; // Extra for formatting
            if current_length + addition_length > max_length {
                break;
            }

            if self.config.include_citations {
                context.push_str(&format!(
                    "[{}] (Source: {}, relevance: {:.2})\n{}\n\n",
                    i + 1,
                    sc.chunk.source,
                    sc.score,
                    chunk_text
                ));
            } else {
                context.push_str(chunk_text);
                context.push_str("\n\n");
            }

            current_length += addition_length;
        }

        context.trim().to_string()
    }

    /// Get sources used in the context.
    pub fn get_sources(&self, context: &str) -> Vec<String> {
        // Simple extraction from citation format
        let mut sources = Vec::new();
        for line in context.lines() {
            if line.contains("(Source:") {
                if let Some(start) = line.find("Source: ") {
                    let rest = &line[start + 8..];
                    if let Some(end) = rest.find(',') {
                        sources.push(rest[..end].to_string());
                    }
                }
            }
        }
        sources.sort();
        sources.dedup();
        sources
    }
}

/// Calculate cosine similarity between two vectors.
fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }

    let dot: f64 = a.iter().zip(b.iter()).map(|(x, y)| (*x as f64) * (*y as f64)).sum();
    let norm_a: f64 = a.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();
    let norm_b: f64 = b.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();

    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }

    (dot / (norm_a * norm_b)).clamp(-1.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_chunk(text: &str, source: &str) -> TextChunk {
        TextChunk {
            text: text.to_string(),
            source: source.to_string(),
            start_offset: 0,
            chunk_index: 0,
        }
    }

    #[test]
    fn test_context_building_with_embeddings() {
        let builder = RAGContextBuilder::default();

        let chunks = vec![
            make_chunk("The sky is blue and vast.", "doc1"),
            make_chunk("The ocean is deep and mysterious.", "doc2"),
            make_chunk("Mathematics is about numbers.", "doc3"),
        ];

        // Query about sky/blue - first chunk most similar
        let query_emb = vec![1.0, 0.0, 0.0];
        let chunk_embs = vec![
            vec![0.9, 0.1, 0.0], // Most similar to query
            vec![0.5, 0.5, 0.0],
            vec![0.0, 0.1, 0.9], // Least similar
        ];

        let context = builder.build_context(&chunks, &chunk_embs, &query_emb);

        assert!(!context.is_empty());
        // First chunk should appear (highest similarity)
        assert!(context.contains("sky is blue"));
    }

    #[test]
    fn test_context_building_keyword() {
        let builder = RAGContextBuilder::default();

        let chunks = vec![
            make_chunk("The sky is blue.", "doc1"),
            make_chunk("Blue whales are large.", "doc2"),
            make_chunk("Red roses are beautiful.", "doc3"),
        ];

        let context = builder.build_context_keyword(&chunks, "blue sky");

        assert!(!context.is_empty());
        // Both "sky is blue" and "Blue whales" should appear
        assert!(context.contains("sky is blue"));
    }

    #[test]
    fn test_source_extraction() {
        let builder = RAGContextBuilder::default();

        let context = r#"
[1] (Source: doc1.txt, relevance: 0.95)
Some text here.

[2] (Source: doc2.pdf, relevance: 0.80)
Other text here.
"#;

        let sources = builder.get_sources(context);
        assert_eq!(sources.len(), 2);
        assert!(sources.contains(&"doc1.txt".to_string()));
        assert!(sources.contains(&"doc2.pdf".to_string()));
    }
}
