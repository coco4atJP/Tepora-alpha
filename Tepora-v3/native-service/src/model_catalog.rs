//! models.dev is bounded metadata, never executable code, a probe or a price guarantee.
use crate::{
    network::{NativeNetwork, NetworkRequest, NetworkScope, Purpose, RequestCancellation},
    provider::ProviderState,
    ApiError,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tepora_core::{js_value::truthy, json_codec};

pub const CATALOG_URL: &str = "https://models.dev/api.json";
pub const MAX_CATALOG_BYTES: usize = 24 * 1024 * 1024;

fn short(value: &Value, max: usize) -> String {
    let units = value
        .as_str()
        .map(json_codec::utf16_units)
        .unwrap_or_default();
    json_codec::from_utf16_units(&units[..units.len().min(max)])
}
fn modalities(value: &Value) -> Value {
    json!(value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v
            .as_str()
            .is_some_and(|s| ["text", "image", "audio", "video", "pdf"].contains(&s)))
        .cloned()
        .collect::<Vec<_>>())
}
fn entries(value: &Value) -> Vec<(String, &Value)> {
    match value {
        Value::Object(map) => map.iter().map(|(k, v)| (k.clone(), v)).collect(),
        Value::Array(array) => array
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        _ => vec![],
    }
}
pub fn parse_catalog(raw: &Value) -> Result<Vec<Value>, ApiError> {
    if !raw.is_object() {
        return Err(ApiError::bad_request("Invalid models.dev catalog"));
    }
    // Object.entries and JSON.stringify share JavaScript's integer-key order.
    let ordered = json_codec::parse(
        &json_codec::stringify_js(raw).map_err(|e| ApiError::bad_request(e.to_string()))?,
    )
    .map_err(|e| ApiError::bad_request(e.to_string()))?;
    let mut output = vec![];
    for (provider_id, provider) in entries(&ordered) {
        if !provider.is_object() || !truthy(&provider["models"]) {
            continue;
        }
        for (model_id, model) in entries(&provider["models"]) {
            if output.len() >= 30000 {
                return Err(ApiError::new(413, "Catalog exceeds model budget"));
            }
            if !model.is_object() && !model.is_array() {
                continue;
            }
            let name = if truthy(&model["name"]) {
                model["name"].clone()
            } else {
                json!(model_id)
            };
            let provider_name = if truthy(&provider["name"]) {
                provider["name"].clone()
            } else {
                json!(provider_id)
            };
            let context = model["limit"]["context"]
                .as_f64()
                .filter(|n| n.is_finite() && *n > 0.);
            let cost = if model["cost"].is_object() || model["cost"].is_array() {
                let mut cost = Map::new();
                for key in ["input", "output", "cache_read", "cache_write"] {
                    if model["cost"][key]
                        .as_f64()
                        .is_some_and(|n| n.is_finite() && n >= 0. && n < 10000.)
                    {
                        cost.insert(key.into(), model["cost"][key].clone());
                    }
                }
                Value::Object(cost)
            } else {
                Value::Null
            };
            output.push(json!({"providerId":short(&json!(provider_id),160),"provider":short(&provider_name,160),"modelId":short(&json!(model_id),240),"name":short(&name,240),
                "tools":model["tool_call"].as_bool(),"input":modalities(&model["modalities"]["input"]),"output":modalities(&model["modalities"]["output"]),"context":context,
                "cost":cost,"updated":short(&model["last_updated"],30),"source":"models.dev","verified":false}));
        }
    }
    if output.is_empty() {
        return Err(ApiError::bad_request("No models in catalog"));
    }
    Ok(output)
}
#[derive(Clone)]
pub struct ModelCatalog {
    state: Arc<dyn ProviderState>,
    network: NativeNetwork,
    closed: RequestCancellation,
}
impl ModelCatalog {
    pub fn new(state: Arc<dyn ProviderState>, network: NativeNetwork) -> Self {
        Self {
            state,
            network,
            closed: RequestCancellation::new(),
        }
    }
    pub fn import(&self, raw: &Value) -> Result<Value, ApiError> {
        let entries = parse_catalog(raw)?;
        let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let wire =
            json_codec::stringify_js(raw).map_err(|e| ApiError::bad_request(e.to_string()))?;
        let count = entries.len();
        self.state.put("catalog",json!({"id":"models.dev","entries":entries,"at":at,"sha256":format!("{:x}",Sha256::digest(wire.as_bytes()))}))?;
        Ok(json!({"count":count,"at":at,"verified":false}))
    }
    pub async fn refresh(&self, cancel: &RequestCancellation) -> Result<Value, ApiError> {
        if let Some(error) = cancel.error().or_else(|| self.closed.error()) {
            return Err(error.into());
        }
        let request_cancel = RequestCancellation::new();
        tokio::select! {biased;
            error=cancel.cancelled()=>{request_cancel.cancel();Err(error.into())},
            error=self.closed.cancelled()=>{request_cancel.cancel();Err(error.into())},
            result=self.refresh_inner(&request_cancel,cancel)=>result,
        }
    }
    pub fn close(&self) {
        self.closed.cancel();
    }
    async fn refresh_inner(
        &self,
        request_cancel: &RequestCancellation,
        caller: &RequestCancellation,
    ) -> Result<Value, ApiError> {
        let response = self
            .network
            .request(
                CATALOG_URL,
                NetworkRequest {
                    cancellation: Some(request_cancel.clone()),
                    ..Default::default()
                },
                NetworkScope {
                    purpose: Purpose::Web,
                    allow_cloud: true,
                    max_bytes: MAX_CATALOG_BYTES,
                    timeout: Duration::from_secs(30),
                    ..Default::default()
                },
            )
            .await?;
        if !(200..300).contains(&response.status) {
            return Err(ApiError::new(502, "Model catalog is unavailable"));
        }
        let value = response.json(MAX_CATALOG_BYTES).await?;
        if let Some(error) = caller
            .error()
            .or_else(|| self.closed.error())
            .or_else(|| request_cancel.error())
        {
            return Err(error.into());
        }
        self.import(&value)
    }
    pub fn search(&self, query: &str) -> Result<Value, ApiError> {
        if json_codec::utf16_units(query).len() > 300 {
            return Err(ApiError::bad_request("Invalid catalog query"));
        }
        let doc = self
            .state
            .get("catalog", "models.dev")?
            .unwrap_or(Value::Null);
        let rows = doc["entries"].as_array().cloned().unwrap_or_default();
        let lower = query.to_lowercase();
        let terms: Vec<_> = lower
            .split(js_whitespace)
            .filter(|s| !s.is_empty())
            .collect();
        let models: Vec<_> = rows
            .iter()
            .filter(|row| {
                let mut parts = vec![];
                for key in ["provider", "name", "modelId"] {
                    parts.push(row[key].as_str().unwrap_or("").to_owned());
                }
                for key in ["input", "output"] {
                    parts.push(
                        row[key]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(" "),
                    );
                }
                let haystack = parts.join(" ").to_lowercase();
                terms.iter().all(|t| haystack.contains(t))
            })
            .take(80)
            .cloned()
            .collect();
        Ok(json!({"models":models,"count":rows.len(),"at":doc["at"],"verified":false}))
    }
}
fn js_whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}

#[cfg(test)]
mod tests;
