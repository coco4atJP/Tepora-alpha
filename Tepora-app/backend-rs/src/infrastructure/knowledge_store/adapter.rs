use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::json;
use uuid::Uuid;

use crate::core::config::ConfigService;
use crate::core::errors::ApiError;
use crate::domain::errors::DomainError;
use crate::domain::knowledge::{
    ContextConfig, KnowledgeChunk, KnowledgeChunkInput, KnowledgeHit, KnowledgePort,
    KnowledgeSource,
};
use crate::llm::LlamaService;
use crate::models::types::ModelRuntimeConfig;
use crate::rag::{RAGEngine, RagStore, StoredChunk};

pub struct RagKnowledgeAdapter {
    rag_store: Arc<dyn RagStore>,
    llama: LlamaService,
    config: ConfigService,
}

impl RagKnowledgeAdapter {
    pub fn new(rag_store: Arc<dyn RagStore>, llama: LlamaService, config: ConfigService) -> Self {
        Self {
            rag_store,
            llama,
            config,
        }
    }

    async fn embed_inputs(&self, inputs: &[String]) -> Result<Vec<Vec<f32>>, DomainError> {
        if inputs.is_empty() {
            return Ok(Vec::new());
        }

        let config = self
            .config
            .load_config()
            .map_err(api_error_to_domain_error)?;
        let model_cfg =
            ModelRuntimeConfig::for_embedding(&config).map_err(api_error_to_domain_error)?;
        self.llama
            .embed(&model_cfg, inputs, Duration::from_secs(5))
            .await
            .map_err(api_error_to_domain_error)
    }

    async fn ingest_chunks(
        &self,
        chunks: Vec<KnowledgeChunkInput>,
        session_id: &str,
    ) -> Result<Vec<String>, DomainError> {
        if chunks.is_empty() {
            return Ok(Vec::new());
        }

        let mut ids = Vec::with_capacity(chunks.len());
        let mut items = Vec::with_capacity(chunks.len());

        for chunk in chunks {
            if chunk.content.trim().is_empty() {
                continue;
            }
            if chunk.embedding.is_empty() {
                return Err(DomainError::InvalidInput(
                    "chunk embedding is required for pre-chunked ingest".to_string(),
                ));
            }

            let chunk_id = chunk
                .chunk_id
                .unwrap_or_else(|| format!("rag-{}", Uuid::new_v4()));
            let stored = StoredChunk {
                chunk_id: chunk_id.clone(),
                content: chunk.content,
                source: chunk.source,
                session_id: session_id.to_string(),
                metadata: chunk.metadata,
            };
            ids.push(chunk_id);
            items.push((stored, chunk.embedding));
        }

        self.rag_store
            .insert_batch(items)
            .await
            .map_err(api_error_to_domain_error)?;

        Ok(ids)
    }

    fn truncate_to_chars(text: &str, max_chars: usize) -> String {
        if text.chars().count() <= max_chars {
            return text.to_string();
        }
        text.chars().take(max_chars).collect()
    }

    fn map_chunk(chunk: StoredChunk) -> KnowledgeChunk {
        KnowledgeChunk {
            chunk_id: chunk.chunk_id,
            content: chunk.content,
            source: chunk.source,
            session_id: chunk.session_id,
            metadata: chunk.metadata,
        }
    }
}

#[async_trait]
impl KnowledgePort for RagKnowledgeAdapter {
    async fn ingest(
        &self,
        source: KnowledgeSource,
        session_id: &str,
    ) -> Result<Vec<String>, DomainError> {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return Err(DomainError::InvalidInput(
                "session_id is required".to_string(),
            ));
        }

        match source {
            KnowledgeSource::Chunks(chunks) => self.ingest_chunks(chunks, session_id).await,
            KnowledgeSource::Text {
                content,
                source,
                metadata,
            } => {
                if content.trim().is_empty() {
                    return Err(DomainError::InvalidInput(
                        "knowledge text content is empty".to_string(),
                    ));
                }
                let source = source.trim();
                if source.is_empty() {
                    return Err(DomainError::InvalidInput(
                        "knowledge source is empty".to_string(),
                    ));
                }

                let rag_engine = RAGEngine::default();
                let chunks = rag_engine.collect_from_text(&content, source);
                let inputs = chunks
                    .iter()
                    .map(|chunk| chunk.text.clone())
                    .collect::<Vec<_>>();
                let embeddings = self.embed_inputs(&inputs).await?;
                if embeddings.len() != chunks.len() {
                    return Err(DomainError::Storage(format!(
                        "embedding/chunk size mismatch: {} != {}",
                        embeddings.len(),
                        chunks.len()
                    )));
                }

                let items = chunks
                    .into_iter()
                    .zip(embeddings)
                    .map(|(chunk, embedding)| {
                        let chunk_id = format!("rag-{}", Uuid::new_v4());
                        let chunk_metadata = Some(json!({
                            "chunk_index": chunk.chunk_index,
                            "start_offset": chunk.start_offset,
                            "user_metadata": metadata.clone(),
                        }));

                        (
                            StoredChunk {
                                chunk_id,
                                content: chunk.text,
                                source: chunk.source,
                                session_id: session_id.to_string(),
                                metadata: chunk_metadata,
                            },
                            embedding,
                        )
                    })
                    .collect::<Vec<_>>();

                let ids = items
                    .iter()
                    .map(|(stored, _)| stored.chunk_id.clone())
                    .collect::<Vec<_>>();
                self.rag_store
                    .insert_batch(items)
                    .await
                    .map_err(api_error_to_domain_error)?;
                Ok(ids)
            }
            KnowledgeSource::Url { url, metadata } => {
                let url = url.trim();
                if url.is_empty() {
                    return Err(DomainError::InvalidInput(
                        "knowledge URL is empty".to_string(),
                    ));
                }

                let rag_engine = RAGEngine::default();
                let chunks = rag_engine
                    .collect_from_url(url)
                    .await
                    .map_err(|err| DomainError::Storage(err.to_string()))?;
                if chunks.is_empty() {
                    return Ok(Vec::new());
                }

                let inputs = chunks
                    .iter()
                    .map(|chunk| chunk.text.clone())
                    .collect::<Vec<_>>();
                let embeddings = self.embed_inputs(&inputs).await?;
                if embeddings.len() != chunks.len() {
                    return Err(DomainError::Storage(format!(
                        "embedding/chunk size mismatch: {} != {}",
                        embeddings.len(),
                        chunks.len()
                    )));
                }

                let items = chunks
                    .into_iter()
                    .zip(embeddings)
                    .map(|(chunk, embedding)| {
                        let chunk_id = format!("rag-{}", Uuid::new_v4());
                        let chunk_metadata = Some(json!({
                            "chunk_index": chunk.chunk_index,
                            "start_offset": chunk.start_offset,
                            "user_metadata": metadata.clone(),
                        }));

                        (
                            StoredChunk {
                                chunk_id,
                                content: chunk.text,
                                source: chunk.source,
                                session_id: session_id.to_string(),
                                metadata: chunk_metadata,
                            },
                            embedding,
                        )
                    })
                    .collect::<Vec<_>>();

                let ids = items
                    .iter()
                    .map(|(stored, _)| stored.chunk_id.clone())
                    .collect::<Vec<_>>();
                self.rag_store
                    .insert_batch(items)
                    .await
                    .map_err(api_error_to_domain_error)?;
                Ok(ids)
            }
        }
    }

    async fn search(
        &self,
        query_embedding: &[f32],
        limit: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<KnowledgeHit>, DomainError> {
        if query_embedding.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }

        let results = self
            .rag_store
            .search(query_embedding, limit, session_id)
            .await
            .map_err(api_error_to_domain_error)?;

        Ok(results
            .into_iter()
            .map(|result| KnowledgeHit {
                chunk_id: result.chunk.chunk_id,
                content: result.chunk.content,
                source: result.chunk.source,
                score: result.score,
                metadata: result.chunk.metadata,
            })
            .collect())
    }

    async fn text_search(
        &self,
        pattern: &str,
        limit: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<KnowledgeChunk>, DomainError> {
        let chunks = self
            .rag_store
            .text_search(pattern, limit, session_id)
            .await
            .map_err(api_error_to_domain_error)?;

        Ok(chunks.into_iter().map(Self::map_chunk).collect())
    }

    async fn get_chunk(&self, chunk_id: &str) -> Result<Option<KnowledgeChunk>, DomainError> {
        let chunk = self
            .rag_store
            .get_chunk(chunk_id)
            .await
            .map_err(api_error_to_domain_error)?;
        Ok(chunk.map(Self::map_chunk))
    }

    async fn get_chunk_window(
        &self,
        chunk_id: &str,
        max_chars: usize,
        session_id: Option<&str>,
    ) -> Result<Vec<KnowledgeChunk>, DomainError> {
        let chunks = self
            .rag_store
            .get_chunk_window(chunk_id, max_chars, session_id)
            .await
            .map_err(api_error_to_domain_error)?;
        Ok(chunks.into_iter().map(Self::map_chunk).collect())
    }

    async fn build_context(
        &self,
        query: &str,
        query_embedding: &[f32],
        config: &ContextConfig,
    ) -> Result<String, DomainError> {
        let hits = self
            .search(
                query_embedding,
                config.limit.max(1),
                config.session_id.as_deref(),
            )
            .await?;
        if hits.is_empty() {
            return Ok(String::new());
        }

        let mut context = String::new();
        let query = query.trim();
        if !query.is_empty() {
            context.push_str("Question: ");
            context.push_str(query);
            context.push_str("\n\n");
        }

        let max_len = config.max_context_length.max(1);
        let mut has_chunk = false;

        for (index, hit) in hits.iter().enumerate() {
            let section = format!(
                "[{}] (Source: {}, score: {:.3})\n{}\n\n",
                index + 1,
                hit.source,
                hit.score,
                hit.content
            );
            if context.chars().count() + section.chars().count() > max_len {
                continue;
            }
            context.push_str(&section);
            has_chunk = true;
        }

        if !has_chunk {
            let fallback = format!(
                "[1] (Source: {}, score: {:.3})\n{}",
                hits[0].source, hits[0].score, hits[0].content
            );
            context.push_str(&Self::truncate_to_chars(&fallback, max_len));
        }

        Ok(context.trim().to_string())
    }

    async fn clear_session(&self, session_id: &str) -> Result<usize, DomainError> {
        self.rag_store
            .clear_session(session_id)
            .await
            .map_err(api_error_to_domain_error)
    }

    async fn reindex(&self, embedding_model: &str) -> Result<(), DomainError> {
        self.rag_store
            .reindex_with_model(embedding_model)
            .await
            .map_err(api_error_to_domain_error)
    }
}

fn api_error_to_domain_error(value: ApiError) -> DomainError {
    match value {
        ApiError::BadRequest(message) => DomainError::InvalidInput(message),
        ApiError::NotImplemented(message) => DomainError::NotSupported(message),
        other => DomainError::Storage(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::core::config::{AppPaths, ConfigService};
    use crate::domain::knowledge::{ContextConfig, KnowledgeChunkInput, KnowledgeSource};
    use crate::rag::{RagStore, SqliteRagStore};

    async fn test_adapter() -> RagKnowledgeAdapter {
        let db_path =
            std::env::temp_dir().join(format!("knowledge_adapter_test_{}.db", Uuid::new_v4()));
        let user_data_dir = db_path
            .parent()
            .map(std::path::Path::to_path_buf)
            .unwrap_or_else(std::env::temp_dir);

        let mut paths = AppPaths::new();
        paths.user_data_dir = user_data_dir;
        let paths = Arc::new(paths);
        let config = ConfigService::new(paths.clone());
        let llama = LlamaService::new(paths).unwrap();
        let rag_store =
            Arc::new(SqliteRagStore::with_path(db_path).await.unwrap()) as Arc<dyn RagStore>;

        RagKnowledgeAdapter::new(rag_store, llama, config)
    }

    #[tokio::test]
    async fn ingest_search_build_context_and_clear_with_chunks() {
        let adapter = test_adapter().await;

        let source = KnowledgeSource::Chunks(vec![
            KnowledgeChunkInput {
                chunk_id: Some("chunk-a".to_string()),
                content: "Rust ownership prevents data races.".to_string(),
                source: "manual".to_string(),
                embedding: vec![1.0, 0.0],
                metadata: Some(serde_json::json!({ "start_offset": 0 })),
            },
            KnowledgeChunkInput {
                chunk_id: Some("chunk-b".to_string()),
                content: "Tokio enables asynchronous I/O in Rust.".to_string(),
                source: "manual".to_string(),
                embedding: vec![0.8, 0.2],
                metadata: Some(serde_json::json!({ "start_offset": 10 })),
            },
        ]);

        let inserted = adapter.ingest(source, "session-1").await.unwrap();
        assert_eq!(inserted.len(), 2);

        let hits = adapter
            .search(&[1.0, 0.0], 5, Some("session-1"))
            .await
            .unwrap();
        assert!(!hits.is_empty());
        assert_eq!(hits[0].chunk_id, "chunk-a");

        let text_hits = adapter
            .text_search("Tokio", 5, Some("session-1"))
            .await
            .unwrap();
        assert_eq!(text_hits.len(), 1);
        assert_eq!(text_hits[0].chunk_id, "chunk-b");

        let chunk = adapter.get_chunk("chunk-a").await.unwrap().unwrap();
        assert_eq!(chunk.session_id, "session-1");

        let window = adapter
            .get_chunk_window("chunk-a", 200, Some("session-1"))
            .await
            .unwrap();
        assert_eq!(window.len(), 2);

        let context = adapter
            .build_context(
                "What does Rust guarantee?",
                &[1.0, 0.0],
                &ContextConfig {
                    limit: 3,
                    max_context_length: 1024,
                    session_id: Some("session-1".to_string()),
                },
            )
            .await
            .unwrap();
        assert!(context.contains("Rust ownership"));

        let deleted = adapter.clear_session("session-1").await.unwrap();
        assert_eq!(deleted, 2);
    }

    #[tokio::test]
    async fn reindex_removes_existing_chunks() {
        let adapter = test_adapter().await;
        let source = KnowledgeSource::Chunks(vec![KnowledgeChunkInput {
            chunk_id: Some("chunk-r1".to_string()),
            content: "Reindex target chunk".to_string(),
            source: "manual".to_string(),
            embedding: vec![1.0, 0.0],
            metadata: None,
        }]);

        let inserted = adapter.ingest(source, "session-r").await.unwrap();
        assert_eq!(inserted.len(), 1);
        assert!(adapter.get_chunk("chunk-r1").await.unwrap().is_some());

        adapter.reindex("embed-v2").await.unwrap();
        assert!(adapter.get_chunk("chunk-r1").await.unwrap().is_none());
    }
}
