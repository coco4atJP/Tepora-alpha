use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{redirect::Policy, Client};
use serde_json::Value;

use crate::core::errors::ApiError;

use super::dispatcher::ToolExecution;
use super::search::perform_search;
use super::web_security::{
    allow_web_search, validate_fetch_target, web_fetch_max_bytes, web_fetch_max_chars,
    web_fetch_timeout_secs,
};

pub async fn execute_search(config: &Value, args: &Value) -> Result<ToolExecution, ApiError> {
    if !allow_web_search(config) {
        return Err(ApiError::Forbidden);
    }

    let query = args
        .get("query")
        .or_else(|| args.get("q"))
        .or_else(|| args.get("input"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if query.is_empty() {
        return Err(ApiError::BadRequest("Search query missing".to_string()));
    }

    let results = perform_search(config, &query).await?;
    let output = serde_json::to_string_pretty(&results).unwrap_or_default();

    Ok(ToolExecution {
        output,
        search_results: Some(results),
    })
}

pub async fn execute_web_fetch(config: &Value, args: &Value) -> Result<ToolExecution, ApiError> {
    if !allow_web_search(config) {
        return Err(ApiError::Forbidden);
    }

    let url = args
        .get("url")
        .or_else(|| args.get("link"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if url.is_empty() {
        return Err(ApiError::BadRequest("URL missing".to_string()));
    }

    let parsed = reqwest::Url::parse(&url).map_err(ApiError::internal)?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(ApiError::BadRequest(
            "Only http/https URLs are supported".to_string(),
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ApiError::BadRequest(
            "URLs with embedded credentials are not supported".to_string(),
        ));
    }

    let resolution = validate_fetch_target(config, &parsed).await?;
    let max_chars = web_fetch_max_chars(config);
    let max_bytes = web_fetch_max_bytes(config);
    let timeout_secs = web_fetch_timeout_secs(config);

    let mut client_builder = Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(timeout_secs))
        .connect_timeout(Duration::from_secs(timeout_secs.min(30)));
    if let Some((host, addrs)) = resolution.pinned_dns() {
        client_builder = client_builder.resolve_to_addrs(host, addrs);
    }
    let client = client_builder.build().map_err(ApiError::internal)?;

    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(ApiError::internal)?;
    if !response.status().is_success() {
        return Err(ApiError::Internal(format!(
            "Fetch failed: {}",
            response.status()
        )));
    }
    if let Some(content_length) = response.content_length() {
        if content_length > max_bytes as u64 {
            return Err(ApiError::BadRequest(format!(
                "Fetched content exceeded max size of {} bytes",
                max_bytes
            )));
        }
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(ApiError::internal)?;
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(ApiError::BadRequest(format!(
                "Fetched content exceeded max size of {} bytes",
                max_bytes
            )));
        }
        bytes.extend_from_slice(&chunk);
    }

    let text = String::from_utf8_lossy(&bytes).to_string();
    let truncated = if text.chars().count() > max_chars {
        text.chars().take(max_chars).collect::<String>()
    } else {
        text
    };

    Ok(ToolExecution {
        output: truncated,
        search_results: None,
    })
}
