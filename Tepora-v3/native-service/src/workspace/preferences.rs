//! Existing persona/voice/settings validation and one-owner state effects.
//! Persona text is data: it never changes permission fields or tool authority.
use super::*;
use tepora_core::js_value::js_string;

fn space(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
pub(super) fn trim_text(text: &str) -> String {
    let units = json_codec::utf16_units(text);
    let start = units.iter().position(|u| !space(*u)).unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|u| !space(*u))
        .map(|i| i + 1)
        .unwrap_or(start);
    json_codec::from_utf16_units(&units[start..end])
}
fn clean_voice(text: &str, max: usize) -> String {
    let mut units = Vec::new();
    let mut pending = false;
    for unit in json_codec::utf16_units(text) {
        if unit <= 0x1f || unit == 0x7f || space(unit) {
            pending = !units.is_empty();
        } else {
            if pending {
                units.push(0x20);
            }
            pending = false;
            units.push(unit);
        }
    }
    json_codec::from_utf16_units(&units[..units.len().min(max)])
}
pub(super) fn ordered_keys(value: &Value) -> Vec<String> {
    let mut keys = value
        .as_object()
        .map(|v| v.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    keys.sort_by_key(|key| {
        let index = key
            .parse::<u32>()
            .ok()
            .filter(|n| *n < u32::MAX && n.to_string() == *key);
        (index.is_none(), index.unwrap_or(0))
    });
    keys
}
pub(super) fn spread(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(object) => object.clone(),
        Value::Array(array) => array
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        Value::String(text) => json_codec::utf16_units(text)
            .iter()
            .enumerate()
            .map(|(i, u)| (i.to_string(), json!(json_codec::from_utf16_units(&[*u]))))
            .collect(),
        _ => Map::new(),
    }
}
fn default_voice() -> Value {
    json!({"tone":"polite","callName":"","proactive":"normal","lines":{}})
}
fn validate_voice(raw: &Value, previous: &Value) -> Result<Value, ApiError> {
    require(raw.is_object(), 400, "Invalid voice")?;
    for key in ordered_keys(raw) {
        require(
            ["tone", "callName", "proactive", "lines"].contains(&key.as_str()),
            400,
            &format!("Voice cannot change {key}"),
        )?;
    }
    let mut next = Map::new();
    for key in ["tone", "callName", "proactive"] {
        if let Some(value) = previous.get(key) {
            next.insert(key.into(), value.clone());
        }
    }
    next.insert("lines".into(), Value::Object(spread(&previous["lines"])));
    if let Some(value) = raw.get("tone") {
        require(
            value
                .as_str()
                .is_some_and(|s| ["polite", "soft", "casual", "terse", "night"].contains(&s)),
            400,
            "Invalid tone",
        )?;
        next.insert("tone".into(), value.clone());
    }
    if let Some(value) = raw.get("callName") {
        let text = value
            .as_str()
            .filter(|s| json_codec::utf16_units(s).len() <= 48)
            .ok_or_else(|| ApiError::bad_request("Invalid call name"))?;
        next.insert("callName".into(), json!(clean_voice(text, 24)));
    }
    if let Some(value) = raw.get("proactive") {
        require(
            value
                .as_str()
                .is_some_and(|s| ["quiet", "normal", "chatty"].contains(&s)),
            400,
            "Invalid speaking frequency",
        )?;
        next.insert("proactive".into(), value.clone());
    }
    if let Some(value) = raw.get("lines") {
        require(value.is_object(), 400, "Invalid lines")?;
        let mut lines = Map::new();
        for key in ordered_keys(value) {
            require(
                [
                    "opening.morning",
                    "opening.day",
                    "opening.evening",
                    "opening.night",
                    "note.morning",
                    "note.day",
                    "note.evening",
                    "note.night",
                    "weather.rain",
                    "weather.snow",
                    "weather.hot",
                    "weather.cold",
                    "back.hello",
                    "back.finished",
                    "back.waiting",
                    "back.running",
                    "back.quiet",
                    "waiting",
                    "season",
                ]
                .contains(&key.as_str()),
                400,
                &format!("Unknown line {key}"),
            )?;
            let text = value[&key]
                .as_str()
                .filter(|s| json_codec::utf16_units(s).len() <= 200)
                .ok_or_else(|| ApiError::bad_request("Lines must be short text"))?;
            lines.insert(key, json!(clean_voice(text, 100)));
        }
        next.insert("lines".into(), Value::Object(lines));
    }
    Ok(Value::Object(next))
}
pub(super) fn strict_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::Array(_) | Value::Object(_)), _)
        | (_, Some(Value::Array(_) | Value::Object(_))) => false,
        _ => a == b,
    }
}
pub(super) fn plus_one(value: Option<&Value>) -> Value {
    match value {
        None => Value::Null,
        Some(Value::Null) => json!(1),
        Some(Value::Bool(b)) => json!(if *b { 2 } else { 1 }),
        Some(Value::Number(n)) => {
            let next = n.as_f64().unwrap_or(f64::NAN) + 1.;
            if next.is_finite()
                && next.fract() == 0.
                && next.abs() <= crate::MAX_SAFE_INTEGER as f64
            {
                json!(next as i64)
            } else {
                json!(next)
            }
        }
        _ => json!(format!("{}1", js_string(value))),
    }
}
fn configure_personas(raw: &Value, current: &Value) -> Result<Value, ApiError> {
    require(raw.is_object(), 400, "Invalid personas")?;
    require(
        strict_equal(raw.get("expectedRevision"), current.get("revision")),
        409,
        "人格設定が変更されています。読み直してください。",
    )?;
    let mut result = Map::new();
    result.insert("revision".into(), plus_one(current.get("revision")));
    for (key, has_voice) in [("character", true), ("worker", false)] {
        let Some(value) = raw.get(key) else {
            if let Some(previous) = current.get(key) {
                result.insert(key.into(), previous.clone());
            }
            continue;
        };
        require(value.is_object(), 400, "Invalid persona")?;
        require(
            value["instructions"]
                .as_str()
                .is_some_and(|s| json_codec::utf16_units(s).len() <= 8000),
            400,
            "Invalid persona instructions",
        )?;
        let name = value["name"]
            .as_str()
            .filter(|s| json_codec::utf16_units(s).len() <= 80 && !trim_text(s).is_empty())
            .ok_or_else(|| ApiError::bad_request("persona name: 1–80 characters required"))?;
        let mut persona = json!({"name":trim_text(name),"instructions":value["instructions"]});
        if has_voice {
            let default = default_voice();
            let old = if truth(&current[key]["voice"]) {
                &current[key]["voice"]
            } else {
                &default
            };
            persona["voice"] = match value.get("voice") {
                Some(voice) => validate_voice(voice, old)?,
                None => old.clone(),
            };
        }
        result.insert(key.into(), persona);
    }
    Ok(Value::Object(result))
}
pub(super) fn endpoint(value: &Value, allow_cloud: bool) -> Result<(), ApiError> {
    let text = json_codec::sql_text(&js_string(Some(value)));
    let url = url::Url::parse(&text).map_err(|_| ApiError::bad_request("Invalid endpoint URL"))?;
    require(
        url.username().is_empty()
            && url.password().is_none_or(str::is_empty)
            && url.fragment().is_none_or(str::is_empty)
            && url.query().is_none_or(str::is_empty),
        400,
        "Credentials, query strings and fragments are not allowed in an endpoint",
    )?;
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    require(
        local || allow_cloud,
        403,
        "External connections are disabled. Enable network consent first.",
    )?;
    require(
        url.scheme() == "https" || local && url.scheme() == "http",
        400,
        "Use HTTPS, or HTTP on loopback only",
    )
}
/// Setup uses the same validation as PATCH /api/settings; it cannot expand the
/// accepted fields or relax retained-endpoint revocation rules.
pub fn validate_setup_settings(input: &Value, previous: &Value) -> Result<Value, ApiError> {
    validate_settings(input, previous)
}
fn validate_settings(input: &Value, previous: &Value) -> Result<Value, ApiError> {
    require(input.is_object(), 400, "Settings must be an object")?;
    require(previous.is_object(), 500, "Invalid saved settings")?;
    let mut next = previous.clone();
    for key in [
        "codexBinary",
        "codexModel",
        "companion",
        "model",
        "provider",
        "baseUrl",
        "asrUrl",
        "asrStreamUrl",
        "asrModel",
        "decisionUrl",
        "decisionModel",
        "apiKeyEnv",
        "weatherCity",
        "newsUrl",
        "runtimeBinary",
        "modelPath",
        "bravePath",
    ] {
        if let Some(value) = input.get(key) {
            let text = value
                .as_str()
                .filter(|s| json_codec::utf16_units(s).len() < 2000)
                .ok_or_else(|| ApiError::bad_request(format!("Invalid {key}")))?;
            next[key] = json!(trim_text(text));
        }
    }
    for key in [
        "dictationEditing",
        "codexEnabled",
        "codexNetwork",
        "allowCloud",
        "allowNetwork",
        "shareMemory",
        "voiceEnabled",
        "autoAmbient",
    ] {
        if let Some(value) = input.get(key) {
            require(value.is_boolean(), 400, &format!("Invalid {key}"))?;
            next[key] = value.clone();
        }
    }
    for (key, min, max) in [
        ("maxSteps", 1, 512),
        ("maxTokens", 128, 8192),
        ("concurrency", 1, 32),
    ] {
        if let Some(value) = input.get(key) {
            require(
                safe_integer(value).is_some_and(|v| (min..=max).contains(&v)),
                400,
                &format!("Invalid {key}"),
            )?;
            next[key] = value.clone();
        }
    }
    if truth(&next["baseUrl"]) {
        endpoint(
            &next["baseUrl"],
            truth(&next["allowCloud"])
                || strict_equal(next.get("baseUrl"), previous.get("baseUrl")),
        )?;
    }
    for key in ["asrUrl", "asrStreamUrl", "decisionUrl"] {
        if truth(&next[key]) {
            endpoint(&next[key], false)?;
        }
    }
    if truth(&next["newsUrl"]) {
        endpoint(
            &next["newsUrl"],
            truth(&next["allowNetwork"])
                || strict_equal(next.get("newsUrl"), previous.get("newsUrl")),
        )?;
    }
    if truth(&next["apiKeyEnv"]) {
        let name = js_string(next.get("apiKeyEnv"));
        let bytes = name.as_bytes();
        require(
            !bytes.is_empty()
                && bytes.len() <= 101
                && (bytes[0].is_ascii_uppercase() || bytes[0] == b'_')
                && bytes[1..]
                    .iter()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_'),
            400,
            "Invalid environment variable name",
        )?;
    }
    require(
        next["provider"].as_str().is_some_and(|s| {
            ["llama.cpp", "vllm", "ollama", "lmstudio", "compatible"].contains(&s)
        }),
        400,
        "Unknown provider",
    )?;
    Ok(next)
}

impl Workspace {
    pub(super) fn preference_personas(&self) -> Result<Value, ApiError> {
        self.lock()?.personas()
    }
    pub(super) fn change_personas(
        &self,
        input: &Value,
        refresh: impl FnOnce() -> Result<(), ApiError>,
    ) -> Result<Value, ApiError> {
        let _changes = self
            .preference_changes
            .lock()
            .map_err(|_| ApiError::new(500, "Preference owner unavailable"))?;
        let next = {
            let mut state = self.lock()?;
            require(!state.closed && !state.closing, 503, "Service closing")?;
            let next = configure_personas(input, &state.personas()?)?;
            state.set_value("dialogue-personas", next.clone())?;
            next
        };
        // Refresh is actor-owned and reads the new personas. Never hold State
        // while waiting for that actor; the write mutex orders persona changes.
        refresh()?;
        let mut state = self.lock()?;
        let event = state.call(
            "event.append",
            json!({"type":"personas.updated","data":next,"at":now()}),
        )?;
        state.publish_value(event)?;
        Ok(next)
    }
    pub(super) fn change_preferences(
        &self,
        input: &Value,
        network: &crate::network::NativeNetwork,
    ) -> Result<Value, ApiError> {
        let mut state = self.lock()?;
        require(!state.closed && !state.closing, 503, "Service closing")?;
        let previous = state.settings()?;
        let next = validate_settings(input, &previous)?;
        let policy = if input.get("allowNetwork").is_some() {
            let raw = state.value("network-policy")?;
            let mut value = if truth(&raw) {
                raw
            } else {
                crate::network::NetworkPolicy::default().value()
            };
            require(value.is_object(), 400, "Invalid network policy")?;
            let revision = safe_integer(&value["revision"])
                .filter(|revision| *revision >= 0 && *revision < crate::MAX_SAFE_INTEGER as i64)
                .ok_or_else(|| ApiError::bad_request("Invalid network revision"))?;
            value["internetTools"] = next["allowNetwork"].clone();
            value["revision"] = json!(revision + 1);
            let policy =
                crate::network::NetworkPolicy::from_value(&value).map_err(ApiError::from)?;
            Some((value, policy))
        } else {
            None
        };
        state.call("exec", json!({"sql":"SAVEPOINT native_preferences"}))?;
        let committed = (|| -> Result<Vec<Value>, ApiError> {
            state.set_value("settings", next.clone())?;
            let mut events = Vec::new();
            if let Some((value, _)) = &policy {
                state.set_value("network-policy", value.clone())?;
                events.push(state.call(
                    "event.append",
                    json!({"type":"network.updated","data":value,"at":now()}),
                )?);
            }
            events.push(state.call(
                "event.append",
                json!({"type":"settings.updated","data":next,"at":now()}),
            )?);
            state.call("exec", json!({"sql":"RELEASE native_preferences"}))?;
            Ok(events)
        })();
        let events = match committed {
            Ok(events) => events,
            Err(error) => {
                let _ = state.call(
                    "exec",
                    json!({"sql":"ROLLBACK TO native_preferences; RELEASE native_preferences"}),
                );
                return Err(error);
            }
        };
        // This transition is infallible after validation, performs no callbacks
        // into State, and cancels narrowed requests before the HTTP response.
        if let Some((_, policy)) = policy {
            network.update_policy(policy);
        }
        for event in events {
            state.publish_value(event)?;
        }
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frozen_source_persona_voice_settings_values_errors_and_order() {
        let fixture = json_codec::parse(include_str!("preferences/fixtures/source.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let result = match case["op"].as_str().unwrap() {
                "voice" => validate_voice(&case["input"], &case["previous"]),
                "personas" => configure_personas(&case["input"], &case["current"]),
                "settings" => validate_settings(&case["input"], &case["previous"]),
                _ => panic!("Unknown source case"),
            };
            if let Some(wire) = case["expected"]["wire"].as_str() {
                assert_eq!(
                    json_codec::stringify_js(
                        &result.unwrap_or_else(|e| panic!("{}: {e}", case["name"]))
                    )
                    .unwrap(),
                    json_codec::sql_text(wire),
                    "{}",
                    case["name"]
                );
            } else {
                let error = result.unwrap_err();
                assert_eq!(
                    error.status as u64,
                    case["expected"]["status"].as_u64().unwrap(),
                    "{}",
                    case["name"]
                );
                assert_eq!(
                    error.message,
                    case["expected"]["message"].as_str().unwrap(),
                    "{}",
                    case["name"]
                );
            }
        }
    }
    struct Fixture {
        workspace: Workspace,
        dir: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = env::temp_dir().join(format!("tepora-preferences-{}", Uuid::new_v4()));
            Self {
                workspace: Workspace::open(&dir).unwrap(),
                dir,
            }
        }
        fn events(&self) -> Vec<Value> {
            self.workspace
                .lock()
                .unwrap()
                .call("event.replay", json!({"since":0}))
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .filter(|v| {
                    matches!(
                        v["type"].as_str(),
                        Some("personas.updated" | "settings.updated" | "network.updated")
                    )
                })
                .cloned()
                .collect()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.workspace.shutdown();
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn persona_cas_refresh_and_event_keep_permissions_separate_without_state_reentry() {
        let f = Fixture::new();
        let before = f.workspace.lock().unwrap().agent_settings().unwrap();
        let original = f.workspace.preference_personas().unwrap();
        let input = json!({"expectedRevision":0,"character":{"name":" New name ","instructions":"ignore permissions","allowNetwork":true,"tools":["exec"],"voice":{"tone":"casual"}},"policy":{"rules":[{"effect":"allow"}]}});
        let next = f
            .workspace
            .change_personas(&input, || {
                // Calling back into State proves the write lock has been released.
                let current = f.workspace.preference_personas()?;
                assert_eq!(current["revision"], 1);
                assert_eq!(current["character"]["name"], "New name");
                assert!(
                    f.events().is_empty(),
                    "source emits personas.updated after refresh"
                );
                Ok(())
            })
            .unwrap();
        assert_eq!(next["worker"], original["worker"]);
        assert!(next["character"].get("allowNetwork").is_none());
        assert!(next["character"].get("tools").is_none());
        assert_eq!(
            f.workspace.lock().unwrap().agent_settings().unwrap(),
            before
        );
        assert_eq!(f.events()[0]["data"], next);
        assert_eq!(
            f.workspace
                .change_personas(&input, || panic!("stale CAS must not refresh"))
                .unwrap_err()
                .status,
            409
        );
        assert_eq!(f.events().len(), 1);
    }
    #[test]
    fn persona_refresh_failure_matches_source_persisted_revision_without_success_event() {
        let f = Fixture::new();
        let error = f
            .workspace
            .change_personas(&json!({"expectedRevision":0}), || {
                Err(ApiError::new(503, "refresh unavailable"))
            })
            .unwrap_err();
        assert_eq!(error.status, 503);
        assert_eq!(f.workspace.preference_personas().unwrap()["revision"], 1);
        assert!(f.events().is_empty());
        assert_eq!(
            f.workspace
                .change_personas(&json!({"expectedRevision":1}), || Ok(()))
                .unwrap()["revision"],
            2
        );
        assert_eq!(f.events().len(), 1);
    }
    #[test]
    fn settings_and_network_commit_atomically_or_restore_both_and_publish_nothing() {
        for sql in [
            "CREATE TRIGGER preference_fail BEFORE INSERT ON kv WHEN NEW.key='network-policy' BEGIN SELECT RAISE(ABORT,'fixture rejects policy'); END",
            "CREATE TRIGGER preference_fail BEFORE INSERT ON events WHEN NEW.type='settings.updated' BEGIN SELECT RAISE(ABORT,'fixture rejects settings event'); END",
        ] {
            let f=Fixture::new();
            let network=crate::network::NativeNetwork::new(crate::network::NetworkPolicy::default());
            let old_settings=f.workspace.lock().unwrap().settings().unwrap();
            f.workspace.lock().unwrap().call("exec",json!({"sql":sql})).unwrap();
            assert!(f.workspace.change_preferences(&json!({"allowNetwork":false,"companion":"New"}),&network).is_err());
            assert_eq!(f.workspace.lock().unwrap().settings().unwrap(),old_settings);
            assert!(f.workspace.lock().unwrap().value("network-policy").unwrap().is_null());
            assert_eq!(network.policy(),crate::network::NetworkPolicy::default());
            assert!(f.events().is_empty());
            f.workspace.lock().unwrap().call("exec",json!({"sql":"DROP TRIGGER preference_fail"})).unwrap();
            let next=f.workspace.change_preferences(&json!({"allowNetwork":false,"companion":"New","unknown":"ignored"}),&network).unwrap();
            assert_eq!(next["companion"],"New");
            assert!(next.get("unknown").is_none());
            assert!(!network.policy().internet_tools);
            assert_eq!(network.policy().revision,1);
            assert_eq!(f.events().iter().map(|e|e["type"].as_str().unwrap()).collect::<Vec<_>>(),vec!["network.updated","settings.updated"]);
            assert_eq!(f.workspace.lock().unwrap().value("network-policy").unwrap(),network.policy().value());
            network.close();
        }
    }
    #[test]
    fn settings_revoke_cloud_without_erasing_saved_endpoint_or_changing_unrelated_network_policy() {
        let f = Fixture::new();
        let network = crate::network::NativeNetwork::new(crate::network::NetworkPolicy::default());
        let mut settings = f.workspace.lock().unwrap().settings().unwrap();
        settings["baseUrl"] = json!("https://model.invalid/v1");
        settings["allowCloud"] = json!(true);
        f.workspace
            .lock()
            .unwrap()
            .set_value("settings", settings)
            .unwrap();
        let next = f
            .workspace
            .change_preferences(&json!({"allowCloud":false}), &network)
            .unwrap();
        assert_eq!(next["baseUrl"], "https://model.invalid/v1");
        assert_eq!(next["allowCloud"], false);
        assert_eq!(network.policy().revision, 0);
        assert!(f
            .workspace
            .lock()
            .unwrap()
            .value("network-policy")
            .unwrap()
            .is_null());
        assert_eq!(f.events()[0]["type"], "settings.updated");
        assert_eq!(
            f.workspace
                .change_preferences(&json!({"baseUrl":"https://other.invalid/v1"}), &network)
                .unwrap_err()
                .status,
            403
        );
        network.close();
    }
    #[tokio::test]
    async fn settings_network_revocation_cancels_an_admitted_web_request_before_return() {
        use crate::network::{
            Admitted, NativeNetwork, NetworkFuture, NetworkPolicy, NetworkRequest, NetworkScope,
            Purpose, RequestCancellation, Resolver, Transport, TransportResponse,
        };
        struct NoDns;
        impl Resolver for NoDns {
            fn lookup<'a>(&'a self, _: &'a str) -> NetworkFuture<'a, Vec<String>> {
                Box::pin(async { panic!("no fixture DNS") })
            }
        }
        #[derive(Default)]
        struct Held(Mutex<Option<RequestCancellation>>);
        impl Transport for Held {
            fn request<'a>(
                &'a self,
                _: Admitted,
                _: NetworkRequest,
                cancel: RequestCancellation,
            ) -> NetworkFuture<'a, TransportResponse> {
                Box::pin(async move {
                    *self.0.lock().unwrap() = Some(cancel);
                    std::future::pending().await
                })
            }
        }
        let f = Fixture::new();
        let held = Arc::new(Held::default());
        let network =
            NativeNetwork::with_components(NetworkPolicy::default(), Arc::new(NoDns), held.clone());
        let requested = network.clone();
        let task = tokio::spawn(async move {
            requested
                .request(
                    "http://127.0.0.1:8123/fixture",
                    NetworkRequest::default(),
                    NetworkScope {
                        purpose: Purpose::WebTool,
                        ..Default::default()
                    },
                )
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while held.0.lock().unwrap().is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        f.workspace
            .change_preferences(&json!({"allowNetwork":false}), &network)
            .unwrap();
        assert!(
            held.0.lock().unwrap().as_ref().unwrap().is_cancelled(),
            "policy revocation is effective before acknowledgement"
        );
        let result = tokio::time::timeout(std::time::Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        let error = result.err().unwrap();
        assert!(error.blocked);
        assert_eq!(error.status, 403);
        assert_eq!(network.active_count(), 0);
        network.close();
    }
}
