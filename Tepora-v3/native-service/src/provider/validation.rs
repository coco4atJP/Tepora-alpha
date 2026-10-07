use super::*;
use crate::network::{ip_domain, normal_url, Domain};

pub const ROLES: &[&str] = &[
    "main",
    "chat",
    "work",
    "compaction",
    "grounding",
    "vision",
    "escalation",
    "dictation",
];
pub const PROTOCOLS: &[&str] = &["chat-completions", "responses", "anthropic", "gemini"];
pub const SERVERS: &[&str] = &[
    "auto",
    "llama.cpp",
    "ollama",
    "vllm",
    "lmstudio",
    "openai",
    "other",
];
const FIELDS: &[&str] = &[
    "id",
    "name",
    "protocol",
    "baseUrl",
    "model",
    "domain",
    "pinnedAddress",
    "allowPlainHttp",
    "enabled",
    "apiKeyEnv",
    "capabilities",
    "maxTokens",
    "contextTokens",
    "timeoutMs",
    "firstByteTimeoutMs",
    "idleTimeoutMs",
    "maxParallel",
    "resource",
    "reasoningEffort",
    "thinkingBudget",
    "sampling",
    "server",
    "cache",
    "sessionHeader",
];

fn require(ok: bool, message: impl Into<String>) -> Result<(), ApiError> {
    if ok {
        Ok(())
    } else {
        Err(ApiError::bad_request(message))
    }
}
fn matches(pattern: &str, value: &str) -> bool {
    regex::Regex::new(pattern).unwrap().is_match(value)
}
fn truth(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|v| v != 0.),
        _ => true,
    }
}
fn js_whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn nonempty(raw: &Value, key: &str, max: usize) -> Result<Value, ApiError> {
    let value = raw[key]
        .as_str()
        .ok_or_else(|| ApiError::bad_request(format!("{key}: 1–{max} characters required")))?;
    require(
        !value.trim_matches(js_whitespace).is_empty()
            && json_codec::utf16_units(value).len() <= max,
        format!("{key}: 1–{max} characters required"),
    )?;
    Ok(json!(value.trim_matches(js_whitespace)))
}
fn number(raw: &Value, key: &str, default: Value, min: f64, max: f64) -> Result<Value, ApiError> {
    let value = raw
        .get(key)
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(default);
    require(
        value.is_null()
            || value
                .as_f64()
                .is_some_and(|n| n.is_finite() && n.fract() == 0. && n >= min && n <= max),
        format!("Invalid {key}"),
    )?;
    Ok(value)
}
fn sampling(raw: Option<&Value>) -> Result<Value, ApiError> {
    let Some(raw) = raw else {
        return Ok(json!({}));
    };
    let object = raw
        .as_object()
        .ok_or_else(|| ApiError::bad_request("Invalid sampling"))?;
    for (key, value) in object {
        let (min, max, integer) = match key.as_str() {
            "temperature" => (0., 2., false),
            "top_p" | "min_p" => (0., 1., false),
            "top_k" => (1., 1000., true),
            "presence_penalty" | "frequency_penalty" => (-2., 2., false),
            "repeat_penalty" => (0.5, 2., false),
            "seed" => (0., 2147483647., true),
            _ => return Err(ApiError::bad_request(format!("Invalid sampling {key}"))),
        };
        require(
            value.as_f64().is_some_and(|n| {
                n.is_finite() && n >= min && n <= max && (!integer || n.fract() == 0.)
            }),
            format!("Invalid sampling {key}"),
        )?;
    }
    Ok(raw.clone())
}

/// Profile insertion order is the persisted JavaScript SHA-256 identity contract.
/// Input and output strings use the core's lossless UTF-16 JSON codec.
pub fn validate_profile(raw: &Value) -> Result<Value, ApiError> {
    let object = raw
        .as_object()
        .ok_or_else(|| ApiError::bad_request("Unknown provider field"))?;
    require(
        object.keys().all(|k| FIELDS.contains(&k.as_str())),
        "Unknown provider field",
    )?;
    require(
        matches(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$", s(raw, "id")),
        "Use a short alphanumeric provider ID",
    )?;
    let url =
        normal_url(&json_codec::sql_text(s(raw, "baseUrl")), false).map_err(ApiError::from)?;
    let host = url
        .host_str()
        .unwrap_or("")
        .trim_start_matches('[')
        .trim_end_matches(']');
    let lexical = if host == "localhost" {
        Domain::Device
    } else {
        ip_domain(host)
    };
    require(
        PROTOCOLS.contains(&s(raw, "protocol")),
        "Select an explicit API protocol",
    )?;
    let domain = Domain::parse(s(raw, "domain"))
        .ok_or_else(|| ApiError::bad_request("Select device / LAN / cloud"))?;
    require(
        match domain {
            Domain::Device => lexical == Domain::Device,
            Domain::Lan => matches!(lexical, Domain::Lan | Domain::Name),
            Domain::Cloud => matches!(lexical, Domain::Cloud | Domain::Name),
            _ => false,
        },
        "Provider domain does not match its address",
    )?;
    if domain == Domain::Cloud {
        require(url.scheme() == "https", "Cloud APIs require HTTPS")?;
    }
    if domain == Domain::Lan {
        require(
            ip_domain(s(raw, "pinnedAddress")) == Domain::Lan,
            "Pin the LAN machine to an RFC1918/ULA address",
        )?;
        require(
            lexical == Domain::Name || s(raw, "pinnedAddress") == host,
            "LAN pin and URL do not match",
        )?;
        require(
            url.scheme() == "https" || raw["allowPlainHttp"] == true,
            "LAN HTTP needs explicit plaintext consent",
        )?;
    }
    let mut caps = json!({"text":true,"tools":null,"vision":null,"structured":null});
    if let Some(raw_caps) = raw.get("capabilities").filter(|v| truth(v)) {
        let declared = raw_caps
            .as_object()
            .ok_or_else(|| ApiError::bad_request("Invalid capability declaration"))?;
        for (key, value) in declared {
            require(
                caps.get(key).is_some() && (value.is_boolean() || value.is_null()),
                "Invalid capability declaration",
            )?;
            caps[key] = value.clone();
        }
    }
    require(
        !truth(&raw["apiKeyEnv"]) || matches(r"^[A-Z_][A-Z0-9_]{0,100}$", s(raw, "apiKeyEnv")),
        "Invalid API key environment variable",
    )?;
    require(
        raw.get("enabled").is_none_or(Value::is_boolean),
        "Invalid enabled",
    )?;
    require(
        !truth(&raw["resource"])
            || matches(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$", s(raw, "resource")),
        "Invalid resource group",
    )?;
    require(
        !truth(&raw["reasoningEffort"])
            || ["minimal", "low", "medium", "high"].contains(&s(raw, "reasoningEffort")),
        "Invalid reasoning effort",
    )?;
    require(
        raw.get("server").is_none() || SERVERS.contains(&s(raw, "server")),
        "Invalid server kind",
    )?;
    require(
        !truth(&raw["sessionHeader"]) || matches(r"^x-[a-z0-9-]{1,60}$", s(raw, "sessionHeader")),
        "Invalid session header name",
    )?;
    let slow = match domain {
        Domain::Device => 600000,
        Domain::Lan => 300000,
        _ => 180000,
    };
    let mut named = raw.clone();
    if !truth(&raw["name"]) {
        named["name"] = raw["id"].clone();
    }
    let mut p = json!({
        "id":raw["id"], "name":nonempty(&named,"name",100)?, "protocol":raw["protocol"],
        "baseUrl":json_codec::encode_text(url.as_str().strip_suffix('/').unwrap_or(url.as_str())),
        "model":nonempty(raw,"model",160)?, "domain":raw["domain"], "enabled":raw["enabled"] != false,
        "apiKeyEnv":if truth(&raw["apiKeyEnv"]) {raw["apiKeyEnv"].clone()} else {json!("")}, "capabilities":caps,
        "pinnedAddress":if domain == Domain::Lan {raw["pinnedAddress"].clone()} else {json!("")},
        "allowPlainHttp":domain == Domain::Lan && raw["allowPlainHttp"] == true,
        "maxTokens":number(raw,"maxTokens",json!(8192),128.,131072.)?,
        "contextTokens":number(raw,"contextTokens",Value::Null,2048.,4_000_000.)?,
        "timeoutMs":number(raw,"timeoutMs",json!(60000),1000.,600000.)?,
        "firstByteTimeoutMs":number(raw,"firstByteTimeoutMs",json!(slow),1000.,3600000.)?,
        "idleTimeoutMs":number(raw,"idleTimeoutMs",json!(120000),1000.,3600000.)?,
        "maxParallel":number(raw,"maxParallel",json!(if domain == Domain::Cloud {4} else {1}),1.,64.)?,
        "resource":if truth(&raw["resource"]) {raw["resource"].clone()} else {raw["id"].clone()},
        "thinkingBudget":number(raw,"thinkingBudget",Value::Null,1024.,128000.)?, "sampling":sampling(raw.get("sampling"))?,
        "server":if truth(&raw["server"]) {raw["server"].clone()} else {json!("auto")}, "cache":raw["cache"] != false,
        "sessionHeader":if truth(&raw["sessionHeader"]) {raw["sessionHeader"].clone()} else {json!(if host=="opencode.ai" || host.ends_with(".opencode.ai") {"x-opencode-session"} else {""})}
    });
    if truth(&raw["reasoningEffort"]) {
        p["reasoningEffort"] = raw["reasoningEffort"].clone();
    }
    p["identity"] = json!(digest(&p)?);
    Ok(p)
}

pub fn validate_registry(raw: &Value) -> Result<Value, ApiError> {
    require(
        raw.as_object().is_some_and(|o| {
            o.keys()
                .all(|k| ["profiles", "routes"].contains(&k.as_str()))
        }),
        "Invalid provider configuration",
    )?;
    let profiles = raw["profiles"]
        .as_array()
        .filter(|v| v.len() <= 32)
        .ok_or_else(|| ApiError::bad_request("At most 32 named providers"))?
        .iter()
        .map(validate_profile)
        .collect::<Result<Vec<_>, _>>()?;
    let ids: std::collections::HashSet<_> = profiles.iter().map(|p| s(p, "id")).collect();
    require(ids.len() == profiles.len(), "Duplicate provider IDs")?;
    let mut routes = serde_json::Map::new();
    if let Some(raw_routes) = raw.get("routes").filter(|v| truth(v)) {
        for (role, route) in raw_routes
            .as_object()
            .ok_or_else(|| ApiError::bad_request("Invalid route"))?
        {
            require(
                ROLES.contains(&role.as_str())
                    && route.as_object().is_some_and(|o| {
                        o.keys()
                            .all(|k| ["primary", "fallbacks"].contains(&k.as_str()))
                    }),
                "Invalid route",
            )?;
            let fallback = route
                .get("fallbacks")
                .filter(|v| truth(v))
                .cloned()
                .unwrap_or_else(|| json!([]));
            let fallback = fallback
                .as_array()
                .ok_or_else(|| ApiError::bad_request("Invalid fallback chain"))?;
            let mut chain = vec![route["primary"].clone()];
            chain.extend(fallback.iter().cloned());
            require(
                chain.len() <= 8
                    && chain
                        .iter()
                        .enumerate()
                        .all(|(i, v)| !chain[..i].contains(v)),
                "Invalid fallback chain",
            )?;
            for id in &chain {
                let p = profiles
                    .iter()
                    .find(|p| p["id"] == *id && p["enabled"] == true)
                    .ok_or_else(|| {
                        ApiError::bad_request("Route refers to a missing or disabled profile")
                    })?;
                if role == "vision" {
                    require(
                        p["capabilities"]["vision"] != false,
                        "Vision routes need a vision-capable model",
                    )?;
                }
                if role == "dictation" {
                    require(p["domain"] == "device", "Dictation stays on this PC")?;
                }
            }
            routes.insert(
                role.clone(),
                json!({"primary":route["primary"],"fallbacks":fallback}),
            );
        }
    }
    require(
        profiles.is_empty()
            || ["main", "chat", "work"]
                .iter()
                .any(|r| routes.contains_key(*r)),
        "A main route is required",
    )?;
    Ok(json!({"profiles":profiles,"routes":routes}))
}

pub fn role_chain(role: &str, registry: &Value) -> Vec<Value> {
    let roles: Vec<&str> = match role {
        "chat" => vec!["chat", "main"],
        "work" => vec!["work", "main"],
        "compaction" => vec!["compaction", "work", "main"],
        "grounding" => vec!["grounding", "work", "main"],
        _ => vec![role],
    };
    for role in roles {
        if let Some(route) = registry["routes"].get(role) {
            let mut ids = vec![route["primary"].clone()];
            ids.extend(array(&route["fallbacks"]).iter().cloned());
            return ids
                .iter()
                .filter_map(|id| {
                    array(&registry["profiles"])
                        .iter()
                        .find(|p| p["id"] == *id && p["enabled"] == true)
                        .cloned()
                })
                .collect();
        }
    }
    vec![]
}
