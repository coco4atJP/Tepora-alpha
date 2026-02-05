use reqwest::Client;
use serde_json::Value;

use crate::errors::ApiError;
use crate::mcp::McpManager;
use crate::search::{perform_search, SearchResult};

#[derive(Debug, Clone)]
pub struct ToolExecution {
    pub output: String,
    pub search_results: Option<Vec<SearchResult>>,
}

pub async fn execute_tool(
    config: &Value,
    mcp: Option<&McpManager>,
    tool_name: &str,
    args: &Value,
) -> Result<ToolExecution, ApiError> {
    match tool_name {
        "native_web_fetch" | "native_fetch" | "web_fetch" => execute_web_fetch(config, args).await,
        "native_google_search" | "native_duckduckgo" | "native_search" | "search" => {
            execute_search(config, args).await
        }
        _ => {
            if let Some(manager) = mcp {
                let output = manager.execute_tool(tool_name, args).await?;
                return Ok(ToolExecution {
                    output,
                    search_results: None,
                });
            }
            Err(ApiError::BadRequest(format!("Unknown tool: {}", tool_name)))
        }
    }
}

async fn execute_search(config: &Value, args: &Value) -> Result<ToolExecution, ApiError> {
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

async fn execute_web_fetch(config: &Value, args: &Value) -> Result<ToolExecution, ApiError> {
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

    if let Some(host) = parsed.host_str() {
        let denylist = url_denylist(config);
        if denylist
            .iter()
            .any(|pattern| host_matches_pattern(host, pattern))
        {
            return Err(ApiError::Forbidden);
        }
    }

    let max_chars = web_fetch_max_chars(config);
    let client = Client::new();
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

    let text = response.text().await.map_err(ApiError::internal)?;
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

fn allow_web_search(config: &Value) -> bool {
    config
        .get("privacy")
        .and_then(|v| v.get("allow_web_search"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn web_fetch_max_chars(config: &Value) -> usize {
    config
        .get("app")
        .and_then(|v| v.get("web_fetch_max_chars"))
        .and_then(|v| v.as_u64())
        .unwrap_or(6000) as usize
}

fn url_denylist(config: &Value) -> Vec<String> {
    if let Some(list) = config
        .get("privacy")
        .and_then(|v| v.get("url_denylist"))
        .and_then(|v| v.as_array())
    {
        let mut out = Vec::new();
        for entry in list {
            if let Some(item) = entry.as_str() {
                out.push(item.to_string());
            }
        }
        if !out.is_empty() {
            return out;
        }
    }

    vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "0.0.0.0".to_string(),
        "192.168.*".to_string(),
        "10.*".to_string(),
        "172.16.*".to_string(),
        "172.17.*".to_string(),
        "172.18.*".to_string(),
        "172.19.*".to_string(),
        "172.20.*".to_string(),
        "172.21.*".to_string(),
        "172.22.*".to_string(),
        "172.23.*".to_string(),
        "172.24.*".to_string(),
        "172.25.*".to_string(),
        "172.26.*".to_string(),
        "172.27.*".to_string(),
        "172.28.*".to_string(),
        "172.29.*".to_string(),
        "172.30.*".to_string(),
        "172.31.*".to_string(),
        "169.254.*".to_string(),
        "::1".to_string(),
    ]
}

fn host_matches_pattern(host: &str, pattern: &str) -> bool {
    if pattern.contains('*') {
        let prefix = pattern.trim_end_matches('*');
        if pattern.starts_with('*') {
            let suffix = pattern.trim_start_matches('*');
            return host.ends_with(suffix);
        }
        return host.starts_with(prefix);
    }
    host == pattern
}
