use async_trait::async_trait;

use super::errors::DomainError;

#[derive(Debug, Clone)]
pub struct EpisodicHit {
    pub content: String,
    pub relevance_score: f32,
    pub source: String,
    pub strength: f64,
}

#[derive(Debug, Clone, Default)]
pub struct DecayResult {
    pub updated: usize,
    pub promoted: usize,
    pub demoted: usize,
    pub pruned: usize,
}

#[derive(Debug, Clone, Default)]
pub struct CompressionResult {
    pub scanned_events: usize,
    pub merged_groups: usize,
    pub replaced_events: usize,
    pub created_events: usize,
}

#[async_trait]
pub trait EpisodicMemoryPort: Send + Sync {
    async fn ingest_interaction(
        &self,
        session_id: &str,
        user: &str,
        assistant: &str,
        embedding: &[f32],
    ) -> Result<Vec<String>, DomainError>;

    async fn recall(
        &self,
        session_id: &str,
        query_embedding: &[f32],
        limit: usize,
    ) -> Result<Vec<EpisodicHit>, DomainError>;

    async fn run_decay(&self, session_id: Option<&str>) -> Result<DecayResult, DomainError>;

    async fn compress(
        &self,
        session_id: &str,
    ) -> Result<CompressionResult, DomainError>;
}
