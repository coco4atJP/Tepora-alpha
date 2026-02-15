use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

use crate::core::config::{AppPaths, ConfigService};
use crate::core::errors::ApiError;
use crate::llm::LlmService;

use super::store::EmMemoryStore;

#[derive(Debug, Clone, Serialize)]
pub struct EmMemoryStats {
    pub enabled: bool,
    pub total_events: usize,
    pub retrieval_limit: usize,
    pub min_score: f32,
}

#[derive(Debug, Clone)]
pub struct RetrievedMemory {
    pub content: String,
    pub relevance_score: f32,
    pub source: String,
}

#[derive(Clone)]
pub struct EmMemoryService {
    store: Arc<EmMemoryStore>,
    enabled: bool,
    retrieval_limit: usize,
    min_score: f32,
}

impl EmMemoryService {
    pub async fn new(paths: &AppPaths, config_service: &ConfigService) -> Result<Self, ApiError> {
        let config = config_service
            .load_config()
            .unwrap_or_else(|_| Value::Object(Default::default()));

        let enabled = config
            .get("em_llm")
            .and_then(|v| v.get("enabled"))
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        let retrieval_limit = config
            .get("em_llm")
            .and_then(|v| v.get("retrieval_limit"))
            .and_then(|v| v.as_u64())
            .unwrap_or(5)
            .clamp(1, 20) as usize;

        let min_score = config
            .get("em_llm")
            .and_then(|v| v.get("min_score"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.15)
            .clamp(-1.0, 1.0) as f32;

        let store = Arc::new(EmMemoryStore::new(paths).await?);

        Ok(Self {
            store,
            enabled,
            retrieval_limit,
            min_score,
        })
    }

    pub fn with_store_for_test(
        store: Arc<EmMemoryStore>,
        enabled: bool,
        retrieval_limit: usize,
        min_score: f32,
    ) -> Self {
        Self {
            store,
            enabled,
            retrieval_limit: retrieval_limit.clamp(1, 50),
            min_score,
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub async fn ingest_interaction(
        &self,
        session_id: &str,
        user_input: &str,
        assistant_output: &str,
        llm: &LlmService,
        embedding_model_id: &str,
    ) -> Result<(), ApiError> {
        if !self.enabled {
            return Ok(());
        }

        let content = build_memory_text(user_input, assistant_output);
        if content.trim().is_empty() {
            return Ok(());
        }

        let embeddings = llm
            .embed(std::slice::from_ref(&content), embedding_model_id)
            .await
            .map_err(|err| ApiError::internal(format!("EM memory embedding failed: {err}")))?;

        let Some(embedding) = embeddings.first() else {
            return Err(ApiError::internal("EM memory embedding is empty"));
        };

        self.ingest_interaction_with_embedding(session_id, user_input, assistant_output, embedding)
            .await
    }

    pub async fn ingest_interaction_with_embedding(
        &self,
        session_id: &str,
        user_input: &str,
        assistant_output: &str,
        embedding: &[f32],
    ) -> Result<(), ApiError> {
        if !self.enabled {
            return Ok(());
        }

        let event_id = uuid::Uuid::new_v4().to_string();
        let content = build_memory_text(user_input, assistant_output);

        self.store
            .insert_event(
                &event_id,
                session_id,
                user_input,
                assistant_output,
                &content,
                embedding,
            )
            .await
    }

    pub async fn retrieve_for_query(
        &self,
        session_id: &str,
        query: &str,
        llm: &LlmService,
        embedding_model_id: &str,
    ) -> Result<Vec<RetrievedMemory>, ApiError> {
        if !self.enabled || query.trim().is_empty() {
            return Ok(Vec::new());
        }

        let query = query.trim().to_string();
        let embeddings = llm
            .embed(&[query], embedding_model_id)
            .await
            .map_err(|err| {
                ApiError::internal(format!("EM memory retrieval embedding failed: {err}"))
            })?;

        let Some(query_embedding) = embeddings.first() else {
            return Ok(Vec::new());
        };

        self.retrieve_for_query_with_embedding(session_id, query_embedding)
            .await
    }

    pub async fn retrieve_for_query_with_embedding(
        &self,
        session_id: &str,
        query_embedding: &[f32],
    ) -> Result<Vec<RetrievedMemory>, ApiError> {
        if !self.enabled {
            return Ok(Vec::new());
        }

        let records = self
            .store
            .retrieve_similar(query_embedding, Some(session_id), self.retrieval_limit)
            .await?;

        Ok(records
            .into_iter()
            .filter(|record| record.score >= self.min_score)
            .map(|record| RetrievedMemory {
                content: record.content,
                relevance_score: record.score,
                source: format!("em://{}/{}", record.session_id, record.id),
            })
            .collect())
    }

    pub async fn stats(&self) -> Result<EmMemoryStats, ApiError> {
        let total_events = self.store.count_events(None).await?;
        Ok(EmMemoryStats {
            enabled: self.enabled,
            total_events,
            retrieval_limit: self.retrieval_limit,
            min_score: self.min_score,
        })
    }
}

fn build_memory_text(user_input: &str, assistant_output: &str) -> String {
    format!(
        "User: {}\nAssistant: {}",
        user_input.trim(),
        assistant_output.trim()
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::em_llm::store::EmMemoryStore;

    async fn test_service() -> EmMemoryService {
        let tmp = std::env::temp_dir().join(format!(
            "tepora-em-service-test-{}.db",
            uuid::Uuid::new_v4()
        ));
        let store = Arc::new(EmMemoryStore::with_path(tmp).await.unwrap());
        EmMemoryService::with_store_for_test(store, true, 5, 0.0)
    }

    #[tokio::test]
    async fn ingest_and_retrieve_with_embeddings() {
        let service = test_service().await;

        service
            .ingest_interaction_with_embedding(
                "s1",
                "user asks",
                "assistant answers",
                &[1.0, 0.0, 0.0],
            )
            .await
            .unwrap();

        let results = service
            .retrieve_for_query_with_embedding("s1", &[1.0, 0.0, 0.0])
            .await
            .unwrap();

        assert_eq!(results.len(), 1);
        assert!(results[0].content.contains("User:"));
        assert!(results[0].source.starts_with("em://s1/"));
    }

    #[tokio::test]
    async fn stats_reflect_insertions() {
        let service = test_service().await;
        let before = service.stats().await.unwrap();
        assert_eq!(before.total_events, 0);

        service
            .ingest_interaction_with_embedding("s1", "u", "a", &[0.0, 1.0])
            .await
            .unwrap();

        let after = service.stats().await.unwrap();
        assert_eq!(after.total_events, 1);
        assert!(after.enabled);
    }
}
