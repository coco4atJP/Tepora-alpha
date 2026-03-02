use std::sync::Arc;

use crate::domain::episodic_memory::{
    CompressionResult, DecayResult, EpisodicHit, EpisodicMemoryPort,
};
use crate::domain::errors::DomainError;

#[derive(Clone)]
pub struct EpisodicMemoryUseCase {
    episodic_memory: Arc<dyn EpisodicMemoryPort>,
}

impl EpisodicMemoryUseCase {
    pub fn new(episodic_memory: Arc<dyn EpisodicMemoryPort>) -> Self {
        Self { episodic_memory }
    }

    pub async fn ingest_interaction(
        &self,
        session_id: &str,
        user: &str,
        assistant: &str,
        embedding: &[f32],
    ) -> Result<Vec<String>, DomainError> {
        self.episodic_memory
            .ingest_interaction(session_id, user, assistant, embedding)
            .await
    }

    pub async fn recall(
        &self,
        session_id: &str,
        query_embedding: &[f32],
        limit: usize,
    ) -> Result<Vec<EpisodicHit>, DomainError> {
        self.episodic_memory
            .recall(session_id, query_embedding, limit)
            .await
    }

    pub async fn run_decay(&self, session_id: Option<&str>) -> Result<DecayResult, DomainError> {
        self.episodic_memory.run_decay(session_id).await
    }

    pub async fn compress(
        &self,
        session_id: &str,
    ) -> Result<CompressionResult, DomainError> {
        self.episodic_memory.compress(session_id).await
    }
}
