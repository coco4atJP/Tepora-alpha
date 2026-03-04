use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::knowledge::{
    ContextConfig, KnowledgeChunk, KnowledgeHit, KnowledgePort, KnowledgeSource,
};

#[derive(Clone)]
pub struct KnowledgeUseCase {
    knowledge: Arc<dyn KnowledgePort>,
}

impl KnowledgeUseCase {
    pub fn new(knowledge: Arc<dyn KnowledgePort>) -> Self {
        Self { knowledge }
    }

    pub async fn ingest(
        &self,
        source: KnowledgeSource,
        session_id: &str,
    ) -> Result<Vec<String>, DomainError> {
        self.knowledge.ingest(source, session_id).await
    }

    pub async fn search(
        &self,
        query_embedding: &[f32],
        limit: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<KnowledgeHit>, DomainError> {
        self.knowledge
            .search(query_embedding, limit, session_id)
            .await
    }

    pub async fn text_search(
        &self,
        pattern: &str,
        limit: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<KnowledgeChunk>, DomainError> {
        self.knowledge.text_search(pattern, limit, session_id).await
    }

    pub async fn get_chunk(&self, chunk_id: &str) -> Result<Option<KnowledgeChunk>, DomainError> {
        self.knowledge.get_chunk(chunk_id).await
    }

    pub async fn get_chunk_window(
        &self,
        chunk_id: &str,
        max_chars: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<KnowledgeChunk>, DomainError> {
        self.knowledge
            .get_chunk_window(chunk_id, max_chars, session_id)
            .await
    }

    pub async fn build_context(
        &self,
        query: &str,
        query_embedding: &[f32],
        config: &ContextConfig,
    ) -> Result<String, DomainError> {
        self.knowledge
            .build_context(query, query_embedding, config)
            .await
    }

    pub async fn clear_session(&self, session_id: &str) -> Result<usize, DomainError> {
        self.knowledge.clear_session(session_id).await
    }

    pub async fn reindex(&self, embedding_model: &str) -> Result<(), DomainError> {
        self.knowledge.reindex(embedding_model).await
    }
}
