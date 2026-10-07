//! Explicit user-requested discovery of the fixed local runtime endpoints.
use crate::{
    network::{NativeNetwork, NetworkRequest, NetworkScope, Purpose, RequestCancellation},
    ApiError,
};
use serde_json::{json, Value};
use std::time::Duration;
pub fn providers() -> Vec<Value> {
    vec![
        json!({"id":"llama.cpp","name":"llama.cpp","url":"http://127.0.0.1:8080/v1"}),
        json!({"id":"vllm","name":"vLLM","url":"http://127.0.0.1:8000/v1"}),
        json!({"id":"ollama","name":"Ollama","url":"http://127.0.0.1:11434/v1"}),
        json!({"id":"lmstudio","name":"LM Studio","url":"http://127.0.0.1:1234/v1"}),
    ]
}
pub async fn models(
    network: &NativeNetwork,
    base: &str,
    cancel: &RequestCancellation,
) -> Result<Vec<Value>, ApiError> {
    let base = local_endpoint(base)?;
    let response = network
        .request(
            &format!("{base}/models"),
            NetworkRequest {
                cancellation: Some(cancel.clone()),
                ..Default::default()
            },
            NetworkScope {
                purpose: Purpose::Model,
                timeout: Duration::from_secs(4),
                ..Default::default()
            },
        )
        .await?;
    if !(200..300).contains(&response.status) {
        return Err(ApiError::new(
            502,
            format!("Runtime returned HTTP {}", response.status),
        ));
    }
    let data = response.json(4 * 1024 * 1024).await?;
    let models = data["data"]
        .as_array()
        .filter(|m| m.len() <= 1000)
        .ok_or_else(|| ApiError::new(502, "Invalid model list"))?;
    Ok(models
        .iter()
        .filter_map(|m| m.get("id").filter(|v| v.is_string()).cloned())
        .collect())
}
pub fn local_endpoint(value: &str) -> Result<String, ApiError> {
    let url = crate::network::normal_url(value, false)?;
    if !matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    ) {
        return Err(ApiError::new(
            403,
            "External connections are disabled. Enable network consent first.",
        ));
    }
    Ok(url
        .as_str()
        .strip_suffix('/')
        .unwrap_or(url.as_str())
        .into())
}
pub async fn discover(network: &NativeNetwork, cancel: &RequestCancellation) -> Value {
    let requests = providers().into_iter().map(|mut provider| async move {
        match models(network, provider["url"].as_str().unwrap(), cancel).await {
            Ok(models) => {
                provider["available"] = json!(true);
                provider["models"] = json!(models);
            }
            Err(_) => {
                provider["available"] = json!(false);
                provider["models"] = json!([]);
            }
        }
        provider
    });
    json!(futures_util::future::join_all(requests).await)
}
