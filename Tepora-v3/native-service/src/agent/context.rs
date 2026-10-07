//! Owned-snapshot integration for cached prompts, token budgets, context and
//! real asynchronous compaction. No helper owns a database connection or commits
//! session state. The coordinator applies proposals only to a current operation.
use super::EffectError;
use crate::{
    network::{Purpose, RequestCancellation},
    provider::{EventSink, InvokeRequest, ProviderFailure, ProviderRuntime},
};
use serde_json::{json, Value};
use std::sync::Arc;
use tepora_core::json_codec;

/// All Values, including strings nested in profile, persona and log documents,
/// use json_codec's internal lossless encoding. `at` is an injected ISO timestamp.
#[derive(Clone, Debug)]
pub struct PromptSnapshot {
    pub session: Value,
    /// Current enabled toolset in its stable registry order, after exclusions.
    pub available_tools: Vec<String>,
    pub personas: Value,
    pub sandbox: Value,
    pub environment: Value,
    pub computer: Value,
    pub skills: Vec<Value>,
    /// A truthful, host-owned instruction for the selected native capabilities.
    /// Include its heading (e.g. "# Native availability") when supplied.
    pub availability_instruction: String,
    pub at: String,
}
#[derive(Clone, Debug)]
pub struct PromptProposal {
    pub session: Value,
    pub patch: Option<Value>,
}
#[derive(Clone, Debug)]
pub struct PromptUpdate {
    pub patch: Value,
    /// Append this body with type="notice" before applying patch.
    pub notice: Value,
}
#[derive(Clone, Debug)]
pub struct BudgetSnapshot {
    pub session: Value,
    pub tool_defs: Vec<Value>,
    /// Snapshot of ProviderRuntime::chain(session.role). Permission/current
    /// identity is checked again before discovery and every transport dispatch.
    pub chain: Vec<Value>,
    /// Provider identity -> finite calibration ratio; absent/invalid means 1.
    pub ratios: Value,
    pub unicode_version: u32,
}
#[derive(Clone, Debug)]
pub struct ContextSnapshot {
    pub session: Value,
    /// Ordered session log, including its latest checkpoint and following tail.
    pub entries: Vec<Value>,
    pub budget: Value,
    pub vision: bool,
    pub plan: bool,
    pub force: bool,
    pub idle: bool,
    pub unicode_version: u32,
}
#[derive(Clone, Debug)]
pub struct CompactionSnapshot {
    pub session: Value,
    /// Raw log entries for checkpoint.upTo+1 through the new boundary. A full
    /// ordered log snapshot is also accepted; the pure planner filters it.
    pub entries: Vec<Value>,
    pub built: Value,
    pub budget: Value,
    pub todo: Value,
    pub reflection: Value,
    pub live: Value,
    pub cache_retention: String,
    pub reason: String,
    pub tail_share: Option<f64>,
    pub unicode_version: u32,
}
#[derive(Clone, Debug)]
pub struct CompactionProposal {
    /// Append with type="checkpoint"; the store assigns seq and entry at.
    pub checkpoint: Value,
    /// Append with type="notice", adding compaction=<new checkpoint seq>.
    pub notice: Value,
    /// Emit source event "compaction" after both durable entries and statistics.
    pub event: Value,
    pub completed_at: String,
}
pub type CompletionClock = Arc<dyn Fn() -> String + Send + Sync>;

fn compute(op: &str, payload: Value) -> Result<Value, EffectError> {
    let raw = json_codec::stringify(&payload).map_err(core_error)?;
    let out = tepora_core::compute_json(op, &raw).map_err(core_error)?;
    json_codec::parse(&out).map_err(core_error)
}
fn harness(op: &str, payload: Value) -> Result<Value, EffectError> {
    compute(&format!("harness.{op}"), payload)
}
fn core_error(error: tepora_core::CoreError) -> EffectError {
    EffectError::new(error.to_string())
}
fn provider_error(error: ProviderFailure, cancel: &RequestCancellation) -> EffectError {
    EffectError {
        aborted: cancel.is_cancelled() || error.cancelled,
        error: error.value(),
    }
}
fn check(cancel: &RequestCancellation) -> Result<(), EffectError> {
    if cancel.is_cancelled() {
        Err(EffectError::cancelled(false))
    } else {
        Ok(())
    }
}
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|v| v != 0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
fn ws(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
pub fn default_personas(character_name: &Value) -> Value {
    let name = if truthy(character_name) {
        character_name.as_str().unwrap_or("Tepora")
    } else {
        "Tepora"
    };
    let units = json_codec::utf16_units(name);
    let name = json_codec::from_utf16_units(&units[..units.len().min(80)]);
    json!({"revision":0,"character":{"name":name,"instructions":"落ち着いた親しみやすい会話。仕事はワーカーへ渡し、会話を続けられるようにする。","voice":{"tone":"polite","callName":"","proactive":"normal","lines":{}}},"worker":{"name":"Tepora Worker","instructions":"依頼の範囲内で検証可能な成果を作る。確認が必要なときは質問し、結果を根拠とともに報告する。"}})
}
fn render(snapshot: &PromptSnapshot, tools: &[Value]) -> Result<String, EffectError> {
    let defaults = default_personas(&json!("Tepora"));
    let personas = if truthy(&snapshot.personas) {
        &snapshot.personas
    } else {
        &defaults
    };
    let mut persona = if snapshot.session["kind"] == "main" {
        personas["character"].clone()
    } else if truthy(&snapshot.session["persona"]) {
        snapshot.session["persona"].clone()
    } else {
        personas["worker"].clone()
    };
    // normalizePersonas fills an older character's absent/falsy voice without
    // rewriting its stored persona. Worker personas retain their original shape.
    if snapshot.session["kind"] == "main" && !truthy(&persona["voice"]) {
        if !persona.is_object() {
            persona = json!({});
        }
        persona["voice"] = defaults["character"]["voice"].clone();
    }
    let persona = harness("prompts.personaForPrompt", json!({"persona":persona}))?;
    let rendered = harness(
        "prompts.systemPrompt",
        json!({"session":snapshot.session,"tools":tools,"sandbox":if snapshot.sandbox.is_null(){json!({"mode":"off"})}else{snapshot.sandbox.clone()},"persona":persona,"computer":snapshot.computer,"skills":snapshot.skills,"environment":snapshot.environment}),
    )?;
    let mut text = rendered
        .as_str()
        .ok_or_else(|| EffectError::new("System prompt renderer returned non-text"))?
        .to_owned();
    if !snapshot.availability_instruction.is_empty() {
        text.push_str("\n\n");
        text.push_str(&snapshot.availability_instruction);
    }
    Ok(text)
}

/// Preserve the cached prefix unless explicitly refreshed at a checkpoint.
/// Even a stale prompt remains unchanged until its normal refresh boundary.
pub fn prompt(snapshot: &PromptSnapshot, refresh: bool) -> Result<PromptProposal, EffectError> {
    if truthy(&snapshot.session["system"]) && !refresh {
        return Ok(PromptProposal {
            session: snapshot.session.clone(),
            patch: None,
        });
    }
    let tools = if !array(&snapshot.session["tools"]).is_empty() && !refresh {
        array(&snapshot.session["tools"]).to_vec()
    } else {
        snapshot.available_tools.iter().map(|s| json!(s)).collect()
    };
    let patch = json!({"system":render(snapshot,&tools)?,"tools":tools,"promptAt":snapshot.at,"promptStale":false,"announced":null});
    let mut session = snapshot.session.clone();
    let object = session
        .as_object_mut()
        .ok_or_else(|| EffectError::new("Prompt session must be an object"))?;
    object.extend(patch.as_object().unwrap().clone());
    Ok(PromptProposal {
        session,
        patch: Some(patch),
    })
}
fn sections(text: &str) -> Vec<String> {
    let mut out = vec![];
    let mut start = 0;
    for (index, _) in text.match_indices("\n# ") {
        let part = text[start..index].trim_matches(ws);
        if !part.is_empty() {
            out.push(part.to_owned());
        }
        start = index + 1;
    }
    let part = text[start..].trim_matches(ws);
    if !part.is_empty() {
        out.push(part.to_owned());
    }
    out
}
/// Produce the exact append-only instruction update. Applying this does not
/// overwrite session.system or session.tools and cannot invalidate the cache.
pub fn prompt_update(snapshot: &PromptSnapshot) -> Result<Option<PromptUpdate>, EffectError> {
    if !truthy(&snapshot.session["system"]) {
        return Ok(None);
    }
    let told = if truthy(&snapshot.session["announced"]) {
        snapshot.session["announced"].clone()
    } else {
        json!({"system":snapshot.session["system"],"tools":array(&snapshot.session["tools"])})
    };
    let declared = array(&snapshot.session["tools"]);
    let next = render(snapshot, declared)?;
    let old = sections(s(&told, "system"));
    let changed: Vec<_> = sections(&next)
        .into_iter()
        .filter(|section| !old.contains(section))
        .collect();
    let available: Vec<_> = snapshot.available_tools.iter().map(|s| json!(s)).collect();
    let added: Vec<_> = available
        .iter()
        .filter(|name| !array(&told["tools"]).contains(name))
        .cloned()
        .collect();
    let removed: Vec<_> = array(&told["tools"])
        .iter()
        .filter(|name| !available.contains(name))
        .cloned()
        .collect();
    if changed.is_empty() && added.is_empty() && removed.is_empty() {
        return Ok(None);
    }
    let text = harness(
        "prompts.notice",
        json!({"name":"instructionsUpdated","args":[{"sections":changed,"added":added,"removed":removed}]}),
    )?;
    Ok(Some(PromptUpdate {
        patch: json!({"promptStale":true,"announced":{"system":next,"tools":available}}),
        notice: json!({"text":text,"promptUpdate":true}),
    }))
}

pub async fn budget(
    provider: &ProviderRuntime,
    snapshot: &BudgetSnapshot,
    cancel: &RequestCancellation,
) -> Result<Value, EffectError> {
    check(cancel)?;
    let mut chain = Vec::new();
    for profile in &snapshot.chain {
        if provider.permitted(profile, Purpose::Model)? {
            chain.push(profile.clone());
        }
    }
    let tools_tokens = compute(
        "tokens.tools",
        json!({"tools":snapshot.tool_defs,"unicodeVersion":snapshot.unicode_version}),
    )?;
    let Some(profile) = chain.first() else {
        return Ok(
            json!({"chain":[],"B":0,"toolDefs":snapshot.tool_defs,"toolsTokens":tools_tokens,"vision":false}),
        );
    };
    let limits = provider
        .limits(profile, cancel)
        .await
        .map_err(|e| provider_error(e, cancel))?;
    check(cancel)?;
    let ratio = snapshot.ratios[s(profile, "identity")]
        .as_f64()
        .filter(|n| n.is_finite())
        .unwrap_or(1.0);
    let context = limits["context"]
        .as_f64()
        .ok_or_else(|| EffectError::new("Provider context limit is missing"))?;
    let max_tokens = profile["maxTokens"]
        .as_f64()
        .ok_or_else(|| EffectError::new("Provider output limit is missing"))?;
    let reserve = max_tokens.min((context * 0.25).floor());
    let b = ((context - reserve) * 0.95 - tools_tokens.as_f64().unwrap_or(0.) * ratio).floor();
    let vision = provider.vision_allowed(profile)?;
    check(cancel)?;
    Ok(
        json!({"chain":chain,"profile":profile,"limits":limits,"ratio":ratio,"B":b,"reserve":reserve,"toolDefs":snapshot.tool_defs,"toolsTokens":tools_tokens,"vision":vision}),
    )
}

pub fn context(snapshot: &ContextSnapshot) -> Result<Value, EffectError> {
    let checkpoint = snapshot
        .entries
        .iter()
        .rev()
        .find(|entry| entry["type"] == "checkpoint")
        .cloned()
        .unwrap_or(Value::Null);
    let from = checkpoint["upTo"].as_u64().unwrap_or(0).saturating_add(1);
    let entries: Vec<_> = snapshot
        .entries
        .iter()
        .filter(|entry| entry["seq"].as_u64().is_some_and(|seq| seq >= from))
        .cloned()
        .collect();
    let view = compute(
        "context.view",
        json!({"checkpoint":checkpoint,"entries":entries}),
    )?;
    let built = compute(
        "context.build",
        json!({"view":view,"system":snapshot.session["system"],"vision":snapshot.vision,"unicodeVersion":snapshot.unicode_version}),
    )?;
    let mut out = json!({"built":built});
    if snapshot.plan {
        out["plan"] = harness(
            "compaction.plan",
            json!({"built":built,"B":snapshot.budget["B"],"ratio":snapshot.budget["ratio"],"force":snapshot.force,"idle":snapshot.idle,"unicodeVersion":snapshot.unicode_version}),
        )?;
    }
    Ok(out)
}
fn silent_sink() -> EventSink {
    // Compaction has no visible stream or session route callback in the source.
    // Provider-global health/cache events still go through ProviderState.
    Arc::new(|_| {})
}
fn valid_summary(content: &Value, max_tokens: &Value, unicode: u32) -> Result<bool, EffectError> {
    Ok(harness(
        "compaction.validSummary",
        json!({"text":content,"maxTokens":max_tokens,"unicodeVersion":unicode}),
    )? == true)
}

/// Execute actual model calls. Model failures degrade through the existing
/// in-context -> rolling -> deterministic paths; cancellation never produces a
/// commit proposal. Provider events do not stream hidden summary text to users.
pub async fn compact(
    provider: &ProviderRuntime,
    snapshot: &CompactionSnapshot,
    cancel: &RequestCancellation,
    clock: CompletionClock,
) -> Result<Option<CompactionProposal>, EffectError> {
    check(cancel)?;
    let mut payload = json!({"session":snapshot.session,"entries":snapshot.entries,"built":snapshot.built,"B":snapshot.budget["B"],"ratio":snapshot.budget["ratio"],"todo":snapshot.todo,"reflection":snapshot.reflection,"live":snapshot.live,"reason":snapshot.reason,"unicodeVersion":snapshot.unicode_version});
    if let Some(tail_share) = snapshot.tail_share {
        payload["tailShare"] = json!(tail_share);
    }
    let prepared = harness("compaction.prepare", payload)?;
    if prepared.is_null() {
        return Ok(None);
    }
    let mut summary = String::new();
    let mut method = "in-context";
    let mut usage = Value::Null;
    for attempt in 0..prepared["inContextAttempts"].as_u64().unwrap_or(0) {
        check(cancel)?;
        let mut messages = array(&snapshot.built["messages"]).to_vec();
        messages.push(json!({"role":"user","content":prepared[if attempt==0{"instruction"}else{"retryInstruction"}]}));
        let request = InvokeRequest {
            chain: array(&snapshot.budget["chain"]).to_vec(),
            messages,
            options: json!({"tools":snapshot.budget["toolDefs"],"toolChoice":"none","maxTokens":prepared["requestMaxTokens"],"cacheKey":snapshot.session["id"],"slotKey":snapshot.session["id"],"cacheRetention":snapshot.cache_retention,"priority":prepared["priority"]}),
        };
        let answer = provider.invoke(request, cancel, silent_sink()).await;
        check(cancel)?;
        match answer {
            Ok(answer) => {
                usage = answer.get("usage").cloned().unwrap_or(Value::Null);
                if answer["finish"] != "length"
                    && valid_summary(
                        &answer["content"],
                        &prepared["maxTokens"],
                        snapshot.unicode_version,
                    )?
                {
                    summary = s(&answer, "content").trim_matches(ws).to_owned();
                    break;
                }
            }
            Err(error) => {
                if error.cancelled {
                    return Err(provider_error(error, cancel));
                }
                if error.kind != "overflow" && error.kind != "bad-request" {
                    break;
                }
            }
        }
    }
    if summary.is_empty() {
        method = "rolling";
        let mut rolling = s(&prepared, "previousSummary").to_owned();
        let mut complete = true;
        for part in array(&prepared["chunks"]) {
            check(cancel)?;
            let request_text = harness(
                "prompts.summarizerRequest",
                json!({"previous":rolling,"ledger":prepared["ledgerText"],"transcript":part,"maxTokens":prepared["maxTokens"]}),
            )?;
            let request = InvokeRequest {
                chain: provider.chain("compaction")?,
                messages: vec![
                    json!({"role":"system","content":prepared["summarizerSystem"]}),
                    json!({"role":"user","content":request_text}),
                ],
                options: json!({"maxTokens":prepared["requestMaxTokens"],"priority":prepared["priority"]}),
            };
            let answer = provider.invoke(request, cancel, silent_sink()).await;
            check(cancel)?;
            match answer {
                Ok(answer) => {
                    // Original rolling path validates headings/size and accepts
                    // even finish=length when the resulting summary is valid.
                    if valid_summary(
                        &answer["content"],
                        &prepared["maxTokens"],
                        snapshot.unicode_version,
                    )? {
                        rolling = s(&answer, "content").trim_matches(ws).to_owned();
                    } else {
                        complete = false;
                        break;
                    }
                }
                Err(error) => {
                    if error.cancelled {
                        return Err(provider_error(error, cancel));
                    }
                    complete = false;
                    break;
                }
            }
        }
        if complete {
            summary = rolling;
        }
    }
    check(cancel)?;
    let completed_at = clock();
    let finished = harness(
        "compaction.finalize",
        json!({"prepared":prepared,"built":snapshot.built,"B":snapshot.budget["B"],"ratio":snapshot.budget["ratio"],"summary":summary,"method":method,"reason":snapshot.reason,"at":completed_at,"unicodeVersion":snapshot.unicode_version}),
    )?;
    check(cancel)?;
    Ok(Some(CompactionProposal {
        checkpoint: finished["checkpoint"].clone(),
        notice: json!({"text":finished["notice"]}),
        event: json!({"sessionId":snapshot.session["id"],"action":"compact","upTo":finished["checkpoint"]["upTo"],"method":finished["checkpoint"]["method"],"reason":snapshot.reason,"usage":usage}),
        completed_at,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        network::{
            Admitted, ByteStream, NativeNetwork, NetworkFuture, NetworkPolicy, NetworkRequest,
            Resolver, Transport, TransportResponse,
        },
        provider::ProviderState,
        ApiError,
    };
    use hyper::{header::HeaderValue, HeaderMap};
    use std::{
        collections::{HashMap, VecDeque},
        sync::{Mutex, MutexGuard},
        time::Duration,
    };
    fn lock<T>(v: &Mutex<T>) -> MutexGuard<'_, T> {
        v.lock().unwrap_or_else(|e| e.into_inner())
    }
    #[derive(Default)]
    struct State {
        values: Mutex<HashMap<String, Value>>,
        events: Mutex<Vec<(String, Value)>>,
    }
    impl ProviderState for State {
        fn value(&self, key: &str) -> Result<Option<Value>, ApiError> {
            Ok(lock(&self.values).get(key).cloned())
        }
        fn set_value(&self, key: &str, value: Value) -> Result<(), ApiError> {
            lock(&self.values).insert(key.into(), value);
            Ok(())
        }
        fn get(&self, _: &str, _: &str) -> Result<Option<Value>, ApiError> {
            Ok(None)
        }
        fn put(&self, _: &str, _: Value) -> Result<(), ApiError> {
            Ok(())
        }
        fn emit(&self, event: &str, data: Value) -> Result<(), ApiError> {
            lock(&self.events).push((event.into(), data));
            Ok(())
        }
    }
    struct NoDns;
    impl Resolver for NoDns {
        fn lookup<'a>(&'a self, _: &'a str) -> NetworkFuture<'a, Vec<String>> {
            Box::pin(async { panic!("local compaction fixture must not resolve DNS") })
        }
    }
    struct Response {
        body: Value,
        delay: Duration,
    }
    #[derive(Default)]
    struct FixtureTransport {
        responses: Mutex<VecDeque<Response>>,
        requests: Mutex<Vec<NetworkRequest>>,
        started: tokio::sync::Notify,
    }
    impl Transport for FixtureTransport {
        fn request<'a>(
            &'a self,
            _: Admitted,
            request: NetworkRequest,
            cancel: RequestCancellation,
        ) -> NetworkFuture<'a, TransportResponse> {
            Box::pin(async move {
                lock(&self.requests).push(request);
                self.started.notify_one();
                let response = lock(&self.responses)
                    .pop_front()
                    .expect("unexpected model call");
                if !response.delay.is_zero() {
                    tokio::select! {e=cancel.cancelled()=>return Err(e),_=tokio::time::sleep(response.delay)=>{}}
                }
                let bytes = json_codec::stringify_js(&response.body)
                    .unwrap()
                    .into_bytes();
                let stream: ByteStream =
                    Box::pin(futures_util::stream::iter(vec![Ok(bytes.into())]));
                let mut headers = HeaderMap::new();
                headers.insert("content-type", HeaderValue::from_static("application/json"));
                Ok(TransportResponse {
                    status: 200,
                    headers,
                    body: Some(stream),
                })
            })
        }
    }
    fn response(content: &str, finish: &str) -> Response {
        Response {
            body: json!({"choices":[{"message":{"content":content},"finish_reason":finish}],"usage":{"prompt_tokens":31,"completion_tokens":17}}),
            delay: Duration::ZERO,
        }
    }
    fn setup(
        responses: Vec<Response>,
    ) -> (
        ProviderRuntime,
        Arc<State>,
        Arc<FixtureTransport>,
        Vec<Value>,
    ) {
        let state = Arc::new(State::default());
        let transport = Arc::new(FixtureTransport::default());
        lock(&transport.responses).extend(responses);
        let network = NativeNetwork::with_components(
            NetworkPolicy::default(),
            Arc::new(NoDns),
            transport.clone(),
        );
        let provider = ProviderRuntime::with_options(
            state.clone(),
            network,
            false,
            Arc::new(|| 1791340800000),
        );
        provider.save(&json!({"profiles":[{"id":"local","protocol":"chat-completions","baseUrl":"http://127.0.0.1:12345/v1","model":"fixture","domain":"device","maxTokens":4096,"contextTokens":8192,"server":"other"}],"routes":{"main":{"primary":"local"}}}),0).unwrap();
        let chain = provider.chain("work").unwrap();
        (provider, state, transport, chain)
    }
    fn prompt_snapshot() -> PromptSnapshot {
        PromptSnapshot {
            session: json!({"id":"s","kind":"main","cwd":"/tmp/work","toolset":"main"}),
            available_tools: vec!["reflect".into(), "memory_search".into()],
            personas: default_personas(&json!("ユキ")),
            sandbox: json!({"mode":"off"}),
            environment: json!({"platform":"linux","arch":"x64","username":"fixture","home":"/tmp","shell":"bash"}),
            computer: Value::Null,
            skills: vec![],
            availability_instruction:
                "# Native availability\nThe schedule tool is unavailable in this native mode."
                    .into(),
            at: "2026-10-07T10:00:00.000Z".into(),
        }
    }
    fn summary(label: &str) -> String {
        [
            "Goal",
            "User preferences and constraints",
            "Done so far",
            "Key facts",
            "Decisions",
            "Dead ends",
            "Current work",
            "Next step",
            "Chapter digest",
        ]
        .iter()
        .map(|h| format!("## {h}\n- {label} with exact fact and source #1"))
        .collect::<Vec<_>>()
        .join("\n")
    }
    fn compaction_snapshot(chain: Vec<Value>) -> CompactionSnapshot {
        let entries = vec![
            json!({"seq":1,"type":"input","kind":"task","text":"Write /tmp/result.txt and verify it.","at":"2026-10-07T09:00:00.000Z"}),
            json!({"seq":2,"type":"assistant","toolCalls":[{"id":"call","name":"read","arguments":"{\"path\":\"/tmp/input.txt\"}"}]}),
            json!({"seq":3,"type":"tool","name":"read","callId":"call","content":"source fact ".repeat(600),"stub":"input text"}),
            json!({"seq":4,"type":"assistant","content":"Checking the result."}),
        ];
        let session =
            json!({"id":"s","kind":"worker","system":"system","role":"work","stats":{"steps":2}});
        let budget = json!({"B":1000,"ratio":1,"chain":chain,"toolDefs":[{"type":"function","function":{"name":"read","parameters":{"type":"object"}}}]});
        let built = context(&ContextSnapshot {
            session: session.clone(),
            entries: entries.clone(),
            budget: budget.clone(),
            vision: false,
            plan: true,
            force: false,
            idle: false,
            unicode_version: 16,
        })
        .unwrap()["built"]
            .clone();
        CompactionSnapshot {
            session,
            entries,
            built,
            budget,
            todo: json!([{ "text":"verify", "status":"pending"}]),
            reflection: json!({"understanding":"verify the file","confidence":0.5}),
            live: json!({}),
            cache_retention: "long".into(),
            reason: "budget".into(),
            tail_share: None,
            unicode_version: 16,
        }
    }
    fn clock() -> CompletionClock {
        Arc::new(|| "2026-10-07T10:30:00.000Z".into())
    }
    fn request_body(transport: &FixtureTransport, i: usize) -> Value {
        json_codec::parse(std::str::from_utf8(&lock(&transport.requests)[i].body).unwrap()).unwrap()
    }

    #[test]
    fn prompt_cache_checkpoint_refresh_and_explicit_availability() {
        let mut snapshot = prompt_snapshot();
        let initial = prompt(&snapshot, false).unwrap();
        assert!(s(&initial.session, "system").starts_with("You are ユキ,"));
        assert!(s(&initial.session, "system").contains("schedule tool is unavailable"));
        assert_eq!(initial.session["promptStale"], false);
        snapshot.session = initial.session.clone();
        snapshot.available_tools = vec!["read".into()];
        snapshot.personas["character"]["instructions"] = json!("new instructions");
        snapshot.at = "later".into();
        let cached = prompt(&snapshot, false).unwrap();
        assert!(cached.patch.is_none());
        assert_eq!(cached.session, initial.session);
        let refreshed = prompt(&snapshot, true).unwrap();
        assert_eq!(refreshed.session["tools"], json!(["read"]));
        assert_eq!(refreshed.session["promptAt"], "later");
        assert!(s(&refreshed.session, "system").contains("new instructions"));
        let name = json_codec::parse(&format!("\"{}\\ud800\"", "x".repeat(80))).unwrap();
        assert_eq!(
            json_codec::utf16_units(s(&default_personas(&name)["character"], "name")).len(),
            80
        );
    }
    #[test]
    fn prompt_changes_append_once_and_retain_declared_prefix() {
        let mut snapshot = prompt_snapshot();
        snapshot.session = prompt(&snapshot, false).unwrap().session;
        let old = snapshot.session["system"].clone();
        snapshot.personas["character"]["instructions"] = json!("Updated constraints");
        snapshot.available_tools = vec!["reflect".into(), "read".into()];
        let update = prompt_update(&snapshot).unwrap().unwrap();
        assert_eq!(update.notice["promptUpdate"], true);
        assert!(s(&update.notice, "text").contains("New tools available through tools_call: read."));
        assert!(s(&update.notice, "text").contains("No longer available: memory_search."));
        snapshot
            .session
            .as_object_mut()
            .unwrap()
            .extend(update.patch.as_object().unwrap().clone());
        assert_eq!(snapshot.session["system"], old);
        assert!(prompt_update(&snapshot).unwrap().is_none());
    }
    #[test]
    fn context_uses_latest_checkpoint_and_keeps_clear_replay_exact() {
        let entries = vec![
            json!({"seq":1,"type":"input","text":"old"}),
            json!({"seq":2,"type":"assistant","content":"older"}),
            json!({"seq":3,"type":"input","text":"tail"}),
            json!({"seq":4,"type":"checkpoint","upTo":2,"text":"checkpoint"}),
            json!({"seq":5,"type":"notice","text":"new"}),
        ];
        let result = context(&ContextSnapshot {
            session: json!({"system":"system"}),
            entries,
            budget: json!({"B":1000,"ratio":1}),
            vision: false,
            plan: true,
            force: true,
            idle: false,
            unicode_version: 16,
        })
        .unwrap();
        assert_eq!(result["built"]["view"]["checkpoint"]["upTo"], 2);
        assert_eq!(result["built"]["messages"][1]["content"], "checkpoint");
        assert!(!json_codec::stringify_js(&result["built"]["messages"])
            .unwrap()
            .contains("older"));
        assert_eq!(result["plan"]["action"], "compact");
    }
    #[tokio::test]
    async fn budget_uses_real_registry_limits_calibration_and_exact_reserve() {
        let (provider, _, transport, chain) = setup(vec![]);
        let identity = s(&chain[0], "identity").to_owned();
        let defs = vec![json!({"type":"function","function":{"name":"read"}})];
        let snapshot = BudgetSnapshot {
            session: json!({"role":"work"}),
            tool_defs: defs,
            chain,
            ratios: json!({identity:1.25}),
            unicode_version: 16,
        };
        let result = budget(&provider, &snapshot, &RequestCancellation::new())
            .await
            .unwrap();
        let tool_tokens = result["toolsTokens"].as_f64().unwrap();
        assert_eq!(result["reserve"], 2048.);
        assert_eq!(
            result["B"],
            json!(((8192. - 2048.) * 0.95 - tool_tokens * 1.25).floor())
        );
        assert_eq!(result["ratio"], 1.25);
        assert!(lock(&transport.requests).is_empty());
        let mut absent = snapshot;
        absent.chain.clear();
        let empty = budget(&provider, &absent, &RequestCancellation::new())
            .await
            .unwrap();
        assert_eq!(empty["B"], 0);
        assert_eq!(empty["vision"], false);
        assert!(empty.get("profile").is_none());
    }
    #[tokio::test]
    async fn compaction_executes_two_real_attempts_and_returns_only_proposed_effects() {
        let (provider, state, transport, chain) = setup(vec![
            response("bad headings", "stop"),
            response(&summary("verified"), "stop"),
        ]);
        let snapshot = compaction_snapshot(chain);
        let result = compact(&provider, &snapshot, &RequestCancellation::new(), clock())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.checkpoint["method"], "in-context");
        assert_eq!(result.event["usage"]["input"], 31);
        assert_eq!(result.notice["text"],"[harness] Earlier turns (up to #3) were compacted into the checkpoint above. Use recall(\"#n\") or history_search for exact details.");
        assert_eq!(
            result.checkpoint["chapters"][0]["at"],
            "2026-10-07T10:30:00.000Z"
        );
        assert_eq!(result.completed_at, "2026-10-07T10:30:00.000Z");
        assert_eq!(lock(&transport.requests).len(), 2);
        let second = request_body(&transport, 1);
        assert!(
            second["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap()
                .contains("Your previous attempt did not follow")
        );
        assert_eq!(second["tool_choice"], "none");
        assert!(second["tools"].is_array());
        assert!(lock(&state.events).iter().all(|(e, _)| e != "compaction"));
        assert!(result.checkpoint.get("seq").is_none());
    }
    #[tokio::test]
    async fn overflow_skips_in_context_and_rolling_accepts_valid_length_finish() {
        let (provider, _, transport, chain) = setup(vec![response(&summary("rolling"), "length")]);
        let mut snapshot = compaction_snapshot(chain);
        snapshot.reason = "overflow".into();
        let result = compact(&provider, &snapshot, &RequestCancellation::new(), clock())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.checkpoint["method"], "rolling");
        assert_eq!(result.event["usage"], Value::Null);
        assert_eq!(lock(&transport.requests).len(), 1);
        let request = request_body(&transport, 0);
        assert!(request["tools"].is_null());
        assert!(request["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("working memory of a long-running agent"));
    }
    #[tokio::test]
    async fn invalid_real_model_results_fall_back_with_exact_ledger_and_prior_facts() {
        let (provider, _, transport, chain) = setup(vec![
            response("bad", "stop"),
            response("bad", "stop"),
            response("bad", "stop"),
        ]);
        let snapshot = compaction_snapshot(chain);
        let result = compact(&provider, &snapshot, &RequestCancellation::new(), clock())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.checkpoint["method"], "deterministic");
        assert!(s(&result.checkpoint, "summary").contains("Steps since the previous checkpoint"));
        assert!(s(&result.checkpoint, "text").contains("Write /tmp/result.txt and verify it."));
        assert!(
            s(&result.checkpoint, "text").contains("confidence")
                || s(&result.checkpoint, "text").contains("Confidence")
        );
        assert_eq!(lock(&transport.requests).len(), 3);
    }
    #[tokio::test]
    async fn cancellation_during_provider_never_returns_checkpoint_or_fallback() {
        let mut reply = response(&summary("cancelled"), "stop");
        reply.delay = Duration::from_secs(10);
        let (provider, _, transport, chain) = setup(vec![reply]);
        let snapshot = compaction_snapshot(chain);
        let cancel = RequestCancellation::new();
        let token = cancel.clone();
        let task =
            tokio::spawn(async move { compact(&provider, &snapshot, &token, clock()).await });
        transport.started.notified().await;
        cancel.cancel();
        let result = task.await.unwrap().unwrap_err();
        assert!(result.aborted);
        assert_eq!(lock(&transport.requests).len(), 1);
    }
    #[tokio::test]
    async fn cancellation_at_finish_clock_prevents_even_a_complete_summary_proposal() {
        let (provider, _, _, chain) = setup(vec![response(&summary("done"), "stop")]);
        let snapshot = compaction_snapshot(chain);
        let cancel = RequestCancellation::new();
        let token = cancel.clone();
        let clock: CompletionClock = Arc::new(move || {
            token.cancel();
            "2026-10-07T10:30:00.000Z".into()
        });
        assert!(
            compact(&provider, &snapshot, &cancel, clock)
                .await
                .unwrap_err()
                .aborted
        );
    }
    #[tokio::test]
    async fn absent_compaction_boundary_makes_no_provider_request() {
        let (provider, _, transport, chain) = setup(vec![]);
        let mut snapshot = compaction_snapshot(chain);
        snapshot.entries = vec![json!({"seq":1,"type":"input","text":"hello"})];
        snapshot.built = context(&ContextSnapshot {
            session: snapshot.session.clone(),
            entries: snapshot.entries.clone(),
            budget: snapshot.budget.clone(),
            vision: false,
            plan: false,
            force: false,
            idle: false,
            unicode_version: 16,
        })
        .unwrap()["built"]
            .clone();
        assert!(
            compact(&provider, &snapshot, &RequestCancellation::new(), clock())
                .await
                .unwrap()
                .is_none()
        );
        assert!(lock(&transport.requests).is_empty());
    }
}
