//! Inert pi-ai catalog metadata and the same model checks as core/pi-model-catalog.mjs.
//! The SDK (functions, auth flows, filters) stays in the Node worker; Rust only reads
//! its JSON catalog dump and validates SDK-produced model lists before persisting them.
use crate::{
    network::{inside_endpoint, normal_url},
    ApiError,
};
use serde_json::{json, Value};

const SUPPORTED_APIS: &[&str] = &[
    "openai-completions",
    "mistral-conversations",
    "openai-responses",
    "azure-openai-responses",
    "openai-codex-responses",
    "anthropic-messages",
    "google-generative-ai",
    "pi-messages",
];
const MODEL_KEYS: &[&str] = &[
    "id", "name", "api", "provider", "baseUrl", "input", "inputLimits", "cost", "headers", "type",
    "reasoning", "thinkingLevelMap", "promptCache", "contextWindow", "maxTokens", "samplingParams",
    "samplingParamsByThinkingLevel", "compat", "lab", "enabled", "providers",
];
pub fn supported(api: &str) -> bool {
    SUPPORTED_APIS.contains(&api)
}
pub fn protocol_for(api: &str) -> &'static str {
    match api {
        "anthropic-messages" => "anthropic",
        "google-generative-ai" => "gemini",
        a if a.contains("responses") => "responses",
        _ => "chat-completions",
    }
}
fn invalid(message: &str) -> ApiError {
    ApiError::bad_request(message)
}
fn require(ok: bool, message: &str) -> Result<(), ApiError> {
    if ok {
        Ok(())
    } else {
        Err(invalid(message))
    }
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn units(text: &str) -> usize {
    tepora_core::json_codec::utf16_units(text).len()
}
fn bounded(v: &Value, max: usize) -> bool {
    v.as_str().is_some_and(|x| {
        !x.is_empty() && units(x) <= max && !x.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
    })
}
fn safe_int(v: &Value) -> Option<i64> {
    v.as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0. && n.abs() <= 9_007_199_254_740_991.)
        .map(|n| n as i64)
}

/// Catalog dump from `pi-worker.mjs` `operation:"catalog"`.
#[derive(Debug)]
pub struct Catalog {
    pub version: String,
    providers: Vec<Value>,
}
impl Catalog {
    pub fn from_value(value: Value) -> Result<Self, String> {
        let version = value["version"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 32)
            .ok_or("pi-ai catalog has no version")?
            .to_owned();
        let providers = value["providers"]
            .as_array()
            .filter(|p| p.iter().all(|p| p["id"].is_string() && p["models"].is_array()))
            .ok_or("pi-ai catalog has no providers")?
            .clone();
        Ok(Self { version, providers })
    }
    pub fn provider(&self, id: &str) -> Option<&Value> {
        self.providers.iter().find(|p| s(p, "id") == id)
    }
    pub fn models(&self, provider: &str) -> &[Value] {
        self.provider(provider)
            .and_then(|p| p["models"].as_array())
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
    pub fn model(&self, provider: &str, id: &str) -> Option<&Value> {
        self.models(provider).iter().find(|m| s(m, "id") == id)
    }
    /// `piProviders()` from core/pi-ai.mjs.
    pub fn snapshot(&self) -> Value {
        let providers: Vec<Value> = self.providers.iter().map(|p| {
            let models = p["models"].as_array().map(Vec::as_slice).unwrap_or(&[]);
            let some = models.iter().any(|m| supported(s(m, "api")));
            let unsupported = models.iter().any(|m| !supported(s(m, "api")));
            json!({"id":p["id"],"name":p["name"],"baseUrl":p["baseUrl"],"modelCount":models.len(),
                "oauth":if p["oauth"].is_object(){json!({"name":p["oauth"]["name"],"subscription":p["oauth"]["subscription"]==true})}else{Value::Null},
                "apiKey":p["apiKey"]==true,"apiKeyLogin":p["apiKeyLogin"]==true,"available":some,
                "note":if unsupported {"このアダプターの専用通信は未接続です。通常APIの別プロバイダーを使用してください。"} else if !models.is_empty() {"カタログ掲載は利用権限・実モデルでの動作確認を意味しません。"} else {"チャットモデルがありません（別の操作専用）。"}})
        }).collect();
        json!({"engine":"pi-ai","version":self.version,"providers":providers})
    }
    /// `checkedPiModels()`: persist only inert, bounded SDK metadata.
    pub fn checked_models(&self, provider: &str, models: &Value) -> Result<Value, ApiError> {
        let list = models.as_array().filter(|m| m.len() <= 2048);
        require(self.provider(provider).is_some() && list.is_some(), "pi-aiモデル一覧の形式が不正です。")?;
        checked_json(models)?;
        let mut ids = std::collections::HashSet::new();
        for model in list.unwrap() {
            self.checked_model(model, provider)?;
            require(ids.insert(s(model, "id").to_owned()), "pi-aiモデルIDが重複しています。")?;
        }
        Ok(models.clone())
    }
    /// `storedPiCatalog()`: another SDK version needs an explicit refresh.
    pub fn stored(&self, value: &Value, provider: &str) -> Result<Option<Value>, ApiError> {
        if value.is_null() {
            return Ok(None);
        }
        let ok = value.as_object().is_some_and(|o| o.keys().all(|k| ["schema", "version", "at", "models"].contains(&k.as_str())))
            && value["schema"] == 1
            && bounded(&value["version"], 32)
            && value["at"].as_str().is_some_and(|at| chrono::DateTime::parse_from_rfc3339(at).is_ok())
            && value["models"].is_array();
        require(ok, "pi-ai保存モデル一覧の形式が不正です。")?;
        if s(value, "version") != self.version {
            return Ok(None);
        }
        Ok(Some(json!({"schema":1,"version":value["version"],"at":value["at"],"models":self.checked_models(provider,&value["models"])?})))
    }
    fn checked_model(&self, model: &Value, provider: &str) -> Result<(), ApiError> {
        let def = self.provider(provider).ok_or_else(|| invalid("pi-aiモデルのプロバイダー・形式が不正です。"))?;
        let def_models = self.models(provider);
        require(
            model.as_object().is_some_and(|o| o.keys().all(|k| MODEL_KEYS.contains(&k.as_str())))
                && s(model, "provider") == provider
                && (model.get("type").is_none() || model["type"] == "chat"),
            "pi-aiモデルのプロバイダー・形式が不正です。",
        )?;
        require(bounded(&model["id"], 160) && bounded(&model["name"], 500), "pi-aiモデルのID・名前が不正です。")?;
        let api = s(model, "api");
        require(supported(api) && def_models.iter().any(|m| s(m, "api") == api), "このpi-aiアダプターの専用通信はまだ接続していません。")?;
        let input = model["input"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        let unique: std::collections::HashSet<_> = input.iter().map(|x| x.as_str().unwrap_or("")).collect();
        require(
            model["reasoning"].is_boolean() && !input.is_empty() && input.len() <= 2 && unique.len() == input.len()
                && input.iter().all(|x| matches!(x.as_str(), Some("text" | "image"))),
            "pi-aiモデルの入力形式が不正です。",
        )?;
        for field in ["contextWindow", "maxTokens"] {
            require(safe_int(&model[field]).is_some_and(|n| n > 0 && n <= 32_000_000), "pi-aiモデルのトークン数が不正です。")?;
        }
        let rates = |cost: &Value| cost.is_object() && ["input", "output", "cacheRead", "cacheWrite"].iter().all(|k| cost[*k].as_f64().is_some_and(|n| n.is_finite() && (0. ..=1_000_000_000.).contains(&n)));
        let cost = &model["cost"];
        require(
            rates(cost) && (cost.get("tiers").is_none() || cost["tiers"].as_array().is_some_and(|t| t.len() <= 32 && t.iter().all(|t| rates(t) && safe_int(&t["inputTokensAbove"]).is_some_and(|n| n >= 0)))),
            "pi-aiモデルの料金定義が不正です。",
        )?;
        let empty_azure = model["baseUrl"] == "" && provider == "azure" && def["oauth"].is_null() && def_models.iter().any(|m| s(m, "api") == api && m["baseUrl"] == "");
        if !empty_azure {
            require(bounded(&model["baseUrl"], 2048), "pi-aiモデルの送信先が不正です。")?;
            let url = normal_url(s(model, "baseUrl"), false).map_err(|_| invalid("pi-aiモデルの送信先が不正です。"))?;
            let copilot = provider == "github-copilot" && copilot_origin(&url.origin().ascii_serialization());
            let mut endpoints = vec![s(def, "baseUrl")];
            endpoints.extend(def_models.iter().map(|m| s(m, "baseUrl")));
            require(
                url.scheme() == "https" && (copilot || endpoints.iter().any(|base| !base.is_empty() && inside_endpoint(url.as_str(), base))),
                "pi-aiモデルの送信先が登録外です。",
            )?;
        }
        for key in ["lab", "enabled", "providers"] {
            if model.get(key).is_some() {
                require(provider == "radius", "pi-aiモデルのゲートウェイ属性が不正です。")?;
            }
        }
        if model.get("lab").is_some() {
            require(bounded(&model["lab"], 500), "pi-aiモデルのラベルが不正です。")?;
        }
        if model.get("enabled").is_some() {
            require(model["enabled"].is_boolean(), "pi-aiモデルの有効状態が不正です。")?;
        }
        if let Some(entries) = model.get("providers") {
            let entries = entries.as_array().filter(|e| e.len() <= 64).ok_or_else(|| invalid("pi-aiモデルのゲートウェイ一覧が不正です。"))?;
            for entry in entries {
                require(
                    entry.as_object().is_some_and(|o| o.keys().all(|k| ["id", "name", "credential", "source"].contains(&k.as_str())))
                        && bounded(&entry["id"], 100)
                        && regex::Regex::new(r"^[a-z][a-z0-9-]*$").unwrap().is_match(s(entry, "id"))
                        && bounded(&entry["name"], 500)
                        && entry["credential"] == "radius"
                        && entry["source"] == "radius",
                    "pi-aiモデルのゲートウェイ属性に認証情報・送信先は保存できません。",
                )?;
            }
        }
        if let Some(headers) = model.get("headers") {
            let headers = headers.as_object().filter(|h| h.len() <= 32).ok_or_else(|| invalid("pi-aiモデルのヘッダーが不正です。"))?;
            let name = regex::Regex::new(r"^[A-Za-z0-9-]{1,100}$").unwrap();
            let secret = regex::Regex::new(r"(?i)(authorization|cookie|api[-_]?key|token|secret|credential|^host$|^connection$|^content-length$|^transfer-encoding$)").unwrap();
            for (key, value) in headers {
                require(name.is_match(key) && !secret.is_match(key) && bounded(value, 8000), "pi-aiモデルに認証ヘッダーは保存できません。")?;
            }
        }
        Ok(())
    }
}
pub fn copilot_origin(origin: &str) -> bool {
    regex::Regex::new(r"^https://api\.(individual|business|enterprise)\.githubcopilot\.com$")
        .unwrap()
        .is_match(origin)
}
fn checked_json(value: &Value) -> Result<(), ApiError> {
    fn visit(x: &Value, depth: usize, nodes: &mut usize) -> Result<(), ApiError> {
        *nodes += 1;
        require(*nodes <= 100_000 && depth <= 16, "pi-aiモデル定義が大きすぎます。")?;
        match x {
            Value::String(s) => require(units(s) <= 16000, "pi-aiモデル定義の文字列が長すぎます。"),
            Value::Array(items) => items.iter().try_for_each(|v| visit(v, depth + 1, nodes)),
            Value::Object(map) => map.iter().try_for_each(|(k, v)| {
                require(!["__proto__", "constructor", "prototype"].contains(&k.as_str()), "pi-aiモデル定義のキーが不正です。")?;
                visit(v, depth + 1, nodes)
            }),
            _ => Ok(()),
        }
    }
    visit(value, 0, &mut 0)?;
    let encoded = tepora_core::json_codec::stringify_js(value).map_err(|e| invalid(&e.to_string()))?;
    require(encoded.len() <= 2_000_000, "pi-aiモデル一覧が大きすぎます。")
}
/// Public model row from core/pi-ai.mjs `modelInfo`.
pub fn model_info(m: &Value) -> Value {
    let api = s(m, "api");
    json!({"id":m["id"],"name":m["name"],"api":api,"protocol":protocol_for(api),"baseUrl":m.get("baseUrl").filter(|v|v.is_string()).cloned().unwrap_or(json!("")),
        "contextTokens":m["contextWindow"],"maxTokens":m["maxTokens"],"reasoning":m["reasoning"]==true,
        "vision":m["input"].as_array().is_some_and(|i|i.contains(&json!("image"))),"cost":m["cost"],"available":supported(api)&&m["enabled"]!=false})
}
