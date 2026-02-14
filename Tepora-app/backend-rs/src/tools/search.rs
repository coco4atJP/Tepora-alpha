use serde::Serialize;
use serde_json::Value;

use crate::core::errors::ApiError;

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

pub async fn perform_search(config: &Value, query: &str) -> Result<Vec<SearchResult>, ApiError> {
    let provider = config
        .get("tools")
        .and_then(|v| v.get("search_provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("google");

    match provider {
        "brave" => {
            let api_key = config
                .get("tools")
                .and_then(|v| v.get("brave_search_api_key"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !api_key.is_empty() {
                return brave_search(query, api_key).await;
            }
        }
        "bing" => {
            let api_key = config
                .get("tools")
                .and_then(|v| v.get("bing_search_api_key"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !api_key.is_empty() {
                return bing_search(query, api_key).await;
            }
        }
        "google" => {
            let api_key = config
                .get("tools")
                .and_then(|v| v.get("google_search_api_key"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let engine_id = config
                .get("tools")
                .and_then(|v| v.get("google_search_engine_id"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if !api_key.is_empty() && !engine_id.is_empty() {
                if let Ok(results) = google_search(query, api_key, engine_id).await {
                    if !results.is_empty() {
                        return Ok(results);
                    }
                }
            }
        }
        _ => {}
    }

    // Fallback or default
    duckduckgo_search(query).await
}

async fn google_search(
    query: &str,
    api_key: &str,
    engine_id: &str,
) -> Result<Vec<SearchResult>, ApiError> {
    let url = format!(
        "https://www.googleapis.com/customsearch/v1?key={}&cx={}&q={}",
        api_key,
        engine_id,
        urlencoding::encode(query)
    );

    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(ApiError::internal)?;

    if !response.status().is_success() {
        return Err(ApiError::Internal(format!(
            "Google search failed: {}",
            response.status()
        )));
    }

    let payload: Value = response.json().await.map_err(ApiError::internal)?;
    let items = payload
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut results = Vec::new();
    for item in items {
        let title = item
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let url = item
            .get("link")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let snippet = item
            .get("snippet")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if !title.is_empty() && !url.is_empty() {
            results.push(SearchResult {
                title,
                url,
                snippet,
            });
        }
    }

    Ok(results)
}

async fn duckduckgo_search(query: &str) -> Result<Vec<SearchResult>, ApiError> {
    let url = format!(
        "https://api.duckduckgo.com/?q={}&format=json&no_redirect=1&no_html=1",
        urlencoding::encode(query)
    );

    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(ApiError::internal)?;

    if !response.status().is_success() {
        return Err(ApiError::Internal(format!(
            "DuckDuckGo search failed: {}",
            response.status()
        )));
    }

    let payload: Value = response.json().await.map_err(ApiError::internal)?;
    let mut results = Vec::new();

    if let Some(abstract_text) = payload.get("AbstractText").and_then(|v| v.as_str()) {
        if let Some(url) = payload.get("AbstractURL").and_then(|v| v.as_str()) {
            if !abstract_text.is_empty() && !url.is_empty() {
                results.push(SearchResult {
                    title: abstract_text
                        .split(" - ")
                        .next()
                        .unwrap_or(abstract_text)
                        .to_string(),
                    url: url.to_string(),
                    snippet: abstract_text.to_string(),
                });
            }
        }
    }

    if let Some(items) = payload.get("Results").and_then(|v| v.as_array()) {
        extract_ddg_topics(items, &mut results);
    }
    if let Some(items) = payload.get("RelatedTopics").and_then(|v| v.as_array()) {
        extract_ddg_topics(items, &mut results);
    }

    Ok(results)
}

fn extract_ddg_topics(items: &[Value], results: &mut Vec<SearchResult>) {
    for item in items {
        if let Some(topics) = item.get("Topics").and_then(|v| v.as_array()) {
            extract_ddg_topics(topics, results);
            continue;
        }
        let text = item.get("Text").and_then(|v| v.as_str()).unwrap_or("");
        let url = item.get("FirstURL").and_then(|v| v.as_str()).unwrap_or("");
        if text.is_empty() || url.is_empty() {
            continue;
        }
        results.push(SearchResult {
            title: text.split(" - ").next().unwrap_or(text).to_string(),
            url: url.to_string(),
            snippet: text.to_string(),
        });
    }
}

async fn brave_search(query: &str, api_key: &str) -> Result<Vec<SearchResult>, ApiError> {
    let url = format!(
        "https://api.search.brave.com/res/v1/web/search?q={}",
        urlencoding::encode(query)
    );

    let response = reqwest::Client::new()
        .get(url)
        .header("X-Subscription-Token", api_key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(ApiError::internal)?;

    if !response.status().is_success() {
        return Err(ApiError::Internal(format!(
            "Brave search failed: {}",
            response.status()
        )));
    }

    let payload: Value = response.json().await.map_err(ApiError::internal)?;
    let mut results = Vec::new();

    if let Some(items) = payload
        .get("web")
        .and_then(|w| w.get("results"))
        .and_then(|v| v.as_array())
    {
        for item in items {
            let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let url = item.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let snippet = item
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if !title.is_empty() && !url.is_empty() {
                results.push(SearchResult {
                    title: title.to_string(),
                    url: url.to_string(),
                    snippet: snippet.to_string(),
                });
            }
        }
    }

    Ok(results)
}

async fn bing_search(query: &str, api_key: &str) -> Result<Vec<SearchResult>, ApiError> {
    let url = format!(
        "https://api.bing.microsoft.com/v7.0/search?q={}",
        urlencoding::encode(query)
    );

    let response = reqwest::Client::new()
        .get(url)
        .header("Ocp-Apim-Subscription-Key", api_key)
        .send()
        .await
        .map_err(ApiError::internal)?;

    if !response.status().is_success() {
        return Err(ApiError::Internal(format!(
            "Bing search failed: {}",
            response.status()
        )));
    }

    let payload: Value = response.json().await.map_err(ApiError::internal)?;
    let mut results = Vec::new();

    if let Some(items) = payload
        .get("webPages")
        .and_then(|wp| wp.get("value"))
        .and_then(|v| v.as_array())
    {
        for item in items {
            let title = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let url = item.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let snippet = item.get("snippet").and_then(|v| v.as_str()).unwrap_or("");

            if !title.is_empty() && !url.is_empty() {
                results.push(SearchResult {
                    title: title.to_string(),
                    url: url.to_string(),
                    snippet: snippet.to_string(),
                });
            }
        }
    }

    Ok(results)
}
