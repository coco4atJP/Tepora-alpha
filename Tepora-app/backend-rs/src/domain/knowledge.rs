use async_trait::async_trait;
use serde_json::Value;

use super::errors::DomainError;

#[derive(Debug, Clone)]
pub struct KnowledgeChunkInput {
    pub chunk_id: Option<String>,
    pub content: String,
    pub source: String,
    pub embedding: Vec<f32>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone)]
pub enum KnowledgeSource {
    Text {
        content: String,
        source: String,
        metadata: Option<Value>,
    },
    Url {
        url: String,
        metadata: Option<Value>,
    },
    Chunks(Vec<KnowledgeChunkInput>),
}

#[derive(Debug, Clone)]
pub struct KnowledgeHit {
    pub chunk_id: String,
    pub content: String,
    pub source: String,
    pub score: f32,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct KnowledgeChunk {
    pub chunk_id: String,
    pub content: String,
    pub source: String,
    pub session_id: String,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct ContextConfig {
    pub limit: usize,
    pub max_context_length: usize,
    pub session_id: Option<String>,
}

impl Default for ContextConfig {
    fn default() -> Self {
        Self {
            limit: 8,
            max_context_length: 4000,
            session_id: None,
        }
    }
}

#[async_trait]
pub trait KnowledgePort: Send + Sync {
    async fn ingest(
        &self,
        source: KnowledgeSource,
        session_id: &str,
    ) -> Result<Vec<String>, DomainError>;

    async fn search(
        &self,
        query_embedding: &[f32],
        limit: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<KnowledgeHit>, DomainError>;

    async fn text_search(
        &self,
        pattern: &str,
        limit: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<KnowledgeChunk>, DomainError>;

    async fn get_chunk(&self, chunk_id: &str) -> Result<Option<KnowledgeChunk>, DomainError>;

    async fn get_chunk_window(
        &self,
        chunk_id: &str,
        max_chars: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<KnowledgeChunk>, DomainError>;

    async fn build_context(
        &self,
        query: &str,
        query_embedding: &[f32],
        config: &ContextConfig,
    ) -> Result<String, DomainError>;

    async fn clear_session(&self, session_id: &str) -> Result<usize, DomainError>;

    async fn reindex(&self, embedding_model: &str) -> Result<(), DomainError>;
}
