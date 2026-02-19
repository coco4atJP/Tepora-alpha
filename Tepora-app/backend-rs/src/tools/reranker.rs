use crate::state::AppState;
use crate::tools::search::SearchResult;
use crate::tools::vector_math;
use serde_json::Value;
use std::sync::Arc;

pub async fn rerank_search_results_with_embeddings(
    state: &Arc<AppState>,
    config: &Value,
    query: &str,
    results: Vec<SearchResult>,
) -> Vec<SearchResult> {
    if !embedding_rerank_enabled(config) || query.trim().is_empty() || results.len() < 2 {
        return results;
    }

    let mut inputs = Vec::with_capacity(results.len() + 1);
    inputs.push(query.to_string());
    for result in &results {
        inputs.push(format!("{}\n{}", result.title, result.snippet));
    }

    use crate::models::types::ModelRuntimeConfig;

    // ... existing imports ...

    let model_cfg = match ModelRuntimeConfig::for_embedding(config) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("Reranking skipped (config error): {}", e);
            return results;
        }
    };
    let embeddings: Vec<Vec<f32>> = match state
        .llama
        .embed(&model_cfg, &inputs, std::time::Duration::from_secs(5))
        .await
    {
        Ok(vectors) => vectors,
        Err(err) => {
            tracing::debug!("Search rerank skipped (embedding unavailable): {}", err);
            return results;
        }
    };

    if embeddings.len() != inputs.len() {
        tracing::debug!(
            "Search rerank skipped (embedding size mismatch): {} != {}",
            embeddings.len(),
            inputs.len()
        );
        return results;
    }

    let query_embedding = &embeddings[0];
    let candidate_embeddings = embeddings[1..].to_vec();
    let ranking =
        match vector_math::rank_descending_by_cosine(query_embedding, &candidate_embeddings) {
            Ok(scores) => scores,
            Err(err) => {
                tracing::debug!("Search rerank skipped (cosine scoring failed): {}", err);
                return results;
            }
        };

    let mut reranked = Vec::with_capacity(results.len());
    for (idx, _) in ranking {
        if let Some(result) = results.get(idx).cloned() {
            reranked.push(result);
        }
    }

    if reranked.len() == results.len() {
        reranked
    } else {
        results
    }
}

fn embedding_rerank_enabled(config: &Value) -> bool {
    config
        .get("search")
        .and_then(|v| v.get("embedding_rerank"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}
