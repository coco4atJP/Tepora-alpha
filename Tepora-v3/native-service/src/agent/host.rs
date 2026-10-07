//! Native effect integration. Engines remain the scheduling authority; this host
//! reads owned snapshots and commits effects only on the coordinator thread.
#[cfg(test)]
mod tests;
use super::{
    context, Admission, AgentHost, AgentRequest, EffectContext, EffectError, EffectResult,
    EffectScope, EffectTask,
};
use crate::{
    network::NativeNetwork,
    provider::{InvokeRequest, ProviderRuntime},
    workspace::WorkspaceAccess,
    ApiError,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tepora_core::{js_value::js_string, json_codec};

pub fn compute(op: &str, payload: Value) -> Result<Value, EffectError> {
    let raw = json_codec::stringify_js(&payload).map_err(|e| EffectError::new(e.to_string()))?;
    let out = tepora_core::compute_json(op, &raw).map_err(|e| EffectError::new(e.to_string()))?;
    json_codec::parse(&out).map_err(|e| EffectError::new(e.to_string()))
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn as_api(e: EffectError) -> ApiError {
    ApiError::new(
        500,
        e.error["message"]
            .as_str()
            .unwrap_or("Native effect failed"),
    )
}
fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
fn array(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}
fn initial_memory() -> Value {
    json!({"calls":[],"errorStreak":0,"warned":[],"overflows":0,"badRequests":0,"empties":0,"nudges":0,"healthy":0})
}
#[derive(Default)]
struct Stream {
    text: String,
    reasoning: String,
    main: bool,
    load_pct: Option<f64>,
    scheduled: bool,
}
/// Native-only host. Configured JS hooks are rejected before construction;
/// optional compatibility effects will be installed explicitly in a later slice.
pub struct NativeAgentHost {
    pub state: WorkspaceAccess,
    pub provider: ProviderRuntime,
    pub network: NativeNetwork,
    streams: Mutex<HashMap<String, Stream>>,
    memory: Mutex<HashMap<String, Value>>,
    runtime: Mutex<super::host_runtime::RuntimeState>,
    approvals: super::approvals::Approvals,
    approved: Mutex<HashMap<String, String>>,
    reads: Mutex<HashMap<String, Arc<Mutex<super::files::FileMemory>>>>,
    process_host: super::process_host::ProcessHost,
    semantic: Option<Arc<crate::semantic::SemanticMemory>>,
    pub web: Arc<super::web_host::WebHost>,
}
impl NativeAgentHost {
    pub fn new(
        state: WorkspaceAccess,
        provider: ProviderRuntime,
        network: NativeNetwork,
    ) -> Result<Self, ApiError> {
        let approvals = super::approvals::Approvals::new(state.clone())?;
        let web = Arc::new(super::web_host::WebHost::new(
            state.clone(),
            network.clone(),
            None,
            None,
        ));
        Ok(Self {
            state,
            provider,
            network,
            streams: Mutex::new(HashMap::new()),
            memory: Mutex::new(HashMap::new()),
            runtime: Mutex::new(super::host_runtime::RuntimeState::new()),
            approvals,
            approved: Mutex::new(HashMap::new()),
            reads: Mutex::new(HashMap::new()),
            process_host: super::process_host::ProcessHost::new(),
            semantic: None,
            web,
        })
    }
    pub fn new_with_semantic(
        state: WorkspaceAccess,
        provider: ProviderRuntime,
        network: NativeNetwork,
        semantic: Arc<crate::semantic::SemanticMemory>,
    ) -> Result<Self, ApiError> {
        let mut host = Self::new(state, provider, network)?;
        host.semantic = Some(semantic);
        Ok(host)
    }
    pub fn invalidate_web(&self) -> Result<(), ApiError> {
        self.web.invalidate();
        Ok(())
    }
    pub fn state(&self, op: &str, args: Value) -> Result<Value, ApiError> {
        self.state.agent_state(op, args)
    }
    /// An owned process view; callers must not hold Workspace's Store lock.
    pub fn processes(&self, session: &str) -> Value {
        self.process_host.list(session)
    }
    fn tool_catalog(&self) -> Vec<Value> {
        // core/agent/runtime.mjs registers exec, filesystem, web, then agent
        // tools. Preserve that order because registry search uses stable ties.
        let (files, other): (Vec<_>, Vec<_>) = super::tools::catalog()
            .into_iter()
            .partition(|d| matches!(d["name"].as_str(), Some("read" | "write" | "edit")));
        self.process_host
            .catalog()
            .into_iter()
            .chain(files)
            .chain(super::web::definitions())
            .chain(other)
            .collect()
    }
    fn tool_definition(&self, name: &str) -> Option<Value> {
        self.process_host
            .definition(name)
            .or_else(|| super::tools::definition(name))
            .or_else(|| {
                super::web::definitions()
                    .into_iter()
                    .find(|d| d["name"] == name)
            })
    }
    fn toolset(&self, kind: &str) -> Vec<String> {
        // Exact source TOOLSETS order, filtered only by genuine native
        // definitions. Persisted session.tools still follows the existing
        // cached-prefix/refresh lifecycle in prompt(), not this registry view.
        let names: &[&str] = match kind {
            "main" => &[
                "sessions_spawn",
                "sessions_send",
                "sessions_list",
                "sessions_history",
                "sessions_stop",
                "schedule",
                "memory_search",
                "memory_write",
                "web_search",
                "web_fetch",
                "recall",
                "history_search",
                "skill",
                "reflect",
                "tools_search",
                "tools_call",
            ],
            "lean" => &[
                "exec",
                "read",
                "write",
                "edit",
                "web_search",
                "web_fetch",
                "computer",
                "todo",
                "reflect",
                "recall",
                "skill",
                "sessions_send",
            ],
            _ => &[
                "exec",
                "process",
                "read",
                "write",
                "edit",
                "find",
                "grep",
                "web_search",
                "web_fetch",
                "computer",
                "media",
                "todo",
                "reflect",
                "artifact",
                "recall",
                "history_search",
                "memory_search",
                "memory_write",
                "skill",
                "sessions_spawn",
                "sessions_send",
                "sessions_list",
                "tools_search",
                "tools_call",
            ],
        };
        names
            .iter()
            .filter(|name| self.tool_definition(name).is_some())
            .map(|name| (*name).to_owned())
            .collect()
    }
    fn search_tools(&self, session: &Value, query: &str) -> Result<Value, ApiError> {
        let terms = tepora_core::store_domain::search_tokens(&json!(query), 40, 17);
        let exclude = strings(&session["tools"]);
        let mut hits = Vec::new();
        for def in self.tool_catalog() {
            let name = def["name"].as_str().unwrap_or("");
            if exclude.iter().any(|excluded| excluded == name) {
                continue;
            }
            let text = format!(
                "{} {} {}",
                name.replace('_', " "),
                def["description"].as_str().unwrap_or(""),
                def["keywords"].as_str().unwrap_or("")
            );
            let tokens = tepora_core::store_domain::search_tokens(&json!(text), 30000, 17);
            let score = terms.iter().filter(|term| tokens.contains(term)).count();
            if score > 0 {
                hits.push((score, def));
            }
        }
        hits.sort_by(|a, b| b.0.cmp(&a.0));
        let lines = hits
            .into_iter()
            .take(8)
            .map(|(_, def)| {
                let schema = json_codec::stringify_js(&def["parameters"])
                    .map_err(|e| ApiError::bad_request(e.to_string()))?;
                Ok(format!(
                    "## {} (builtin)\n{}\nparameters: {}",
                    def["name"].as_str().unwrap_or(""),
                    def["description"].as_str().unwrap_or(""),
                    json_codec::encode_text(&schema)
                ))
            })
            .collect::<Result<Vec<_>, ApiError>>()?;
        Ok(
            json!({"text":if lines.is_empty(){"No matching tools.".to_owned()}else{lines.join("\n\n")}}),
        )
    }
    fn session(&self, id: &str) -> Result<Value, ApiError> {
        self.state("session.get", json!({"id":id}))
    }
    fn settings(&self) -> Result<Value, ApiError> {
        self.state("settings", json!({}))
    }
    fn emit(&self, id: &str, event: &str, data: Value) -> Result<(), ApiError> {
        let mut body = data.as_object().cloned().unwrap_or_default();
        body.insert("event".into(), json!(event));
        let mut source = data.as_object().cloned().unwrap_or_default();
        source.insert("sessionId".into(), json!(id));
        source.insert("type".into(), json!(event));
        self.state.agent_batch(&[
            (
                "session.append".into(),
                json!({"id":id,"type":"event","body":body}),
            ),
            (
                "event.emit".into(),
                json!({"type":"agent.event","data":source}),
            ),
        ])?;
        Ok(())
    }
    fn entries(&self, id: &str) -> Result<Vec<Value>, ApiError> {
        Ok(array(&self.state("session.entries", json!({"id":id}))?))
    }
    fn retention(&self, session: &Value) -> Result<String, ApiError> {
        Ok(
            self.settings()?["cacheRetention"][if session["kind"] == "main" {
                "main"
            } else {
                "worker"
            }]
            .as_str()
            .unwrap_or(if session["kind"] == "main" {
                "long"
            } else {
                "short"
            })
            .into(),
        )
    }
    fn prompt_snapshot(&self, session: Value) -> Result<context::PromptSnapshot, EffectError> {
        let settings = self.settings()?;
        let mut available_tools = self.toolset(session["toolset"].as_str().unwrap_or("worker"));
        if num(&session["depth"]) >= num(&settings["maxDepth"]) {
            available_tools.retain(|n| n != "sessions_spawn");
        }
        let skills = array(&self.state("document.list", json!({"kind":"skill"}))?)
            .into_iter()
            .filter(|s| s["enabled"] != false)
            .collect();
        Ok(context::PromptSnapshot{session,available_tools,personas:self.state("personas",json!({}))?,sandbox:settings["sandbox"].clone(),environment:json_codec::encode_value(json!({"platform":if cfg!(windows){"win32"}else if cfg!(target_os="macos"){"darwin"}else{"linux"},"arch":match std::env::consts::ARCH{"x86_64"=>"x64","aarch64"=>"arm64","x86"=>"ia32",other=>other},"username":std::env::var("USER").or_else(|_|std::env::var("USERNAME")).unwrap_or_default(),"home":std::env::var("HOME").or_else(|_|std::env::var("USERPROFILE")).unwrap_or_default(),"shell":std::env::var("SHELL").or_else(|_|std::env::var("COMSPEC")).unwrap_or_default()})),computer:Value::Null,skills,availability_instruction:"# Native availability\nOnly the tools listed above are available in this development host. Read supports text files only; image ingestion and vision bridging are not yet available. Scheduling, browser rendering, MCP, Computer Use, media and JavaScript plugins are not yet available. Never promise or report those effects as completed.".into(),at:now()})
    }
    fn prompt(&self, session: Value, refresh: bool) -> Result<Value, EffectError> {
        if !refresh {
            let unavailable = strings(&session["tools"])
                .into_iter()
                .filter(|name| self.tool_definition(name).is_none())
                .collect::<Vec<_>>();
            if !unavailable.is_empty() {
                return Err(EffectError::new(format!("Cached session tools unavailable in native mode: {}. Continue with the compatibility host.",unavailable.join(", "))));
            }
        }
        let proposal = context::prompt(&self.prompt_snapshot(session)?, refresh)?;
        if let Some(patch) = proposal.patch {
            Ok(self.state(
                "session.update",
                json!({"id":proposal.session["id"],"patch":patch}),
            )?)
        } else {
            Ok(proposal.session)
        }
    }
    fn refresh_prompt(&self, id: &str) -> Result<bool, ApiError> {
        let session = self.session(id)?;
        let snapshot = self.prompt_snapshot(session).map_err(as_api)?;
        if let Some(update) = context::prompt_update(&snapshot).map_err(as_api)? {
            self.state.agent_batch(&[
                (
                    "session.append".into(),
                    json!({"id":id,"type":"notice","body":update.notice}),
                ),
                (
                    "session.update".into(),
                    json!({"id":id,"patch":update.patch}),
                ),
            ])?;
            Ok(true)
        } else {
            Ok(false)
        }
    }
    fn definitions(&self, session: &Value) -> Vec<Value> {
        strings(&session["tools"]).iter().filter_map(|name|self.tool_definition(name)).map(|def|json!({"type":"function","function":{"name":def["name"],"description":def["description"],"parameters":def["parameters"]}})).collect()
    }
    fn budget_snapshot(
        &self,
        session: Value,
        defs: Vec<Value>,
    ) -> Result<context::BudgetSnapshot, EffectError> {
        let chain = self
            .provider
            .chain(session["role"].as_str().unwrap_or("work"))?;
        let mut ratios = serde_json::Map::new();
        for p in &chain {
            if let Some(id) = p["identity"].as_str() {
                let v = self.state("kv.get", json!({"key":format!("token-ratio:{id}")}))?;
                ratios.insert(id.into(), v["ratio"].clone());
            }
        }
        Ok(context::BudgetSnapshot {
            session,
            tool_defs: defs,
            chain,
            ratios: Value::Object(ratios),
            unicode_version: 17,
        })
    }
    fn account(&self, id: &str, answer: &Value, ms: f64) -> Result<(), EffectError> {
        let session = self.session(id)?;
        let u = &answer["usage"];
        let mut stats = session["stats"].as_object().cloned().unwrap_or_default();
        let price = self.provider.price(&answer["route"])?;
        let uncached = (num(&u["input"]) - num(&u["cacheRead"]) - num(&u["cacheWrite"])).max(0.0);
        let cost = price
            .map(|p| {
                let input = num(&p["input"]);
                (uncached * input
                    + num(&u["cacheRead"]) * p["cache_read"].as_f64().unwrap_or(input * 0.1)
                    + num(&u["cacheWrite"]) * p["cache_write"].as_f64().unwrap_or(input * 1.25)
                    + num(&u["output"]) * p["output"].as_f64().unwrap_or(input))
                    / 1e6
            })
            .unwrap_or(0.0);
        for k in ["input", "output", "cacheRead", "cacheWrite"] {
            stats.insert(k.into(), json!(stats.get(k).map_or(0.0, num) + num(&u[k])));
        }
        for (k, add) in [("steps", 1.0), ("cost", cost), ("modelMs", ms)] {
            stats.insert(k.into(), json!(stats.get(k).map_or(0.0, num) + add));
        }
        stats.insert("lastInput".into(), json!(num(&u["input"])));
        let key = format!("agent-usage:{}", chrono::Utc::now().format("%Y-%m-%d"));
        let daily = self.state("kv.get", json!({"key":key}))?;
        let value = json!({"input":num(&daily["input"])+num(&u["input"]),"output":num(&daily["output"])+num(&u["output"]),"cacheRead":num(&daily["cacheRead"])+num(&u["cacheRead"]),"cost":num(&daily["cost"])+cost,"calls":num(&daily["calls"])+1.0});
        self.state.agent_batch(&[
            (
                "session.update".into(),
                json!({"id":id,"patch":{"stats":stats}}),
            ),
            ("kv.set".into(), json!({"key":key,"value":value})),
        ])?;
        Ok(())
    }
    fn stream_end(&self, id: &str, discard: bool) -> Result<(), ApiError> {
        let stream = self
            .streams
            .lock()
            .map_err(|_| ApiError::new(500, "Stream owner unavailable"))?
            .remove(id);
        if let Some(b) = stream {
            let silent = b.main
                && compute("harness.prompts.isSilentReply", json!({"text":b.text}))
                    .map_err(as_api)?
                    .as_bool()
                    .unwrap_or(false);
            self.state("event.broadcast",json!({"type":"agent.delta","data":{"sessionId":id,"text":if discard||silent{String::new()}else{b.text},"reasoning":if discard{String::new()}else{b.reasoning},"done":true}}))?;
        }
        Ok(())
    }
    fn flush(&self, id: &str) -> Result<(), ApiError> {
        let mut streams = self
            .streams
            .lock()
            .map_err(|_| ApiError::new(500, "Stream owner unavailable"))?;
        if let Some(b) = streams.get_mut(id) {
            b.scheduled = false;
            let held = b.main
                && compute("harness.prompts.mayBeSilent", json!({"text":b.text}))
                    .map_err(as_api)?
                    .as_bool()
                    .unwrap_or(false);
            self.state("event.broadcast",json!({"type":"agent.delta","data":{"sessionId":id,"text":if held{String::new()}else{b.text.clone()},"reasoning":b.reasoning}}))?;
        }
        Ok(())
    }
    fn execution_effect(&self, ctx: &EffectContext, c: &Value) -> Result<EffectTask, EffectError> {
        let id = &ctx.scope.session_id;
        match c["kind"].as_str().unwrap_or("") {
            "prompt" => Ok(EffectTask::ready(
                self.prompt(c["session"].clone(), c["refresh"] == true)?,
            )),
            "budget" => {
                let session = if c["overflow"] == true {
                    self.session(id)?
                } else {
                    c["session"].clone()
                };
                let defs = c
                    .get("toolDefs")
                    .filter(|v| !v.is_null())
                    .map(array)
                    .unwrap_or_else(|| self.definitions(&session));
                let snap = self.budget_snapshot(session, defs)?;
                let provider = self.provider.clone();
                let cancel = ctx.cancellation.clone();
                Ok(EffectTask::Async(Box::pin(async move {
                    context::budget(&provider, &snap, &cancel)
                        .await
                        .map(EffectResult::new)
                })))
            }
            "context" => Ok(EffectTask::ready(context::context(
                &context::ContextSnapshot {
                    session: c["session"].clone(),
                    entries: self.entries(id)?,
                    budget: c["budget"].clone(),
                    vision: c["vision"] != false,
                    plan: c["plan"] == true,
                    force: c["force"] == true,
                    idle: false,
                    unicode_version: 17,
                },
            )?)),
            "clear" => {
                self.state("context.clear", json!({"id":id,"upTo":c["upTo"]}))?;
                Ok(EffectTask::ready(Value::Null))
            }
            "compact" => {
                let session = if c["overflow"] == true {
                    self.session(id)?
                } else {
                    c["session"].clone()
                };
                let children = array(&self.state("session.list", json!({"parentId":id}))?);
                let live = json!({"sessions":children.iter().filter_map(|s|s["id"].as_str().map(|id|(id.to_owned(),s["status"].clone()))).collect::<serde_json::Map<_,_>>(),"processes":self.process_host.live(id)});
                let snap = context::CompactionSnapshot {
                    session: session.clone(),
                    entries: self.entries(id)?,
                    built: c["built"].clone(),
                    budget: c["budget"].clone(),
                    todo: session["todo"].clone(),
                    reflection: session["reflection"].clone(),
                    live,
                    cache_retention: self.retention(&session)?,
                    reason: c["reason"].as_str().unwrap_or("budget").into(),
                    tail_share: c["tailShare"].as_f64(),
                    unicode_version: 17,
                };
                self.state(
                    "session.update",
                    json!({"id":id,"patch":{"note":"文脈を整理しています"}}),
                )?;
                let provider = self.provider.clone();
                let cancel = ctx.cancellation.clone();
                Ok(EffectTask::Async(Box::pin(async move {
                    let proposal =
                        context::compact(&provider, &snap, &cancel, Arc::new(now)).await?;
                    Ok(EffectResult::new(proposal.map(|p|json!({"checkpoint":p.checkpoint,"notice":p.notice,"event":p.event})).unwrap_or(Value::Null)))
                })))
            }
            "beforeRequest" => {
                let processes = self.process_host.clone();
                let session = id.clone();
                let cancel = ctx.cancellation.clone();
                let messages = c["messages"].clone();
                Ok(EffectTask::Async(Box::pin(async move {
                    processes.ready_session(&session, &cancel).await?;
                    Ok(EffectResult::new(json!({"messages":messages})))
                })))
            }
            "invoke" => {
                let provider = self.provider.clone();
                let cancel = ctx.cancellation.clone();
                let sink = ctx.events.clone();
                let req = InvokeRequest {
                    chain: array(&c["chain"]),
                    messages: array(&c["messages"]),
                    options: json!({"tools":c["toolDefs"],"cacheKey":c["cacheKey"],"slotKey":c["slotKey"],"priority":c["priority"],"cacheRetention":self.retention(&c["session"])?}),
                };
                Ok(EffectTask::Async(Box::pin(async move {
                    let scheduled = Arc::new(std::sync::atomic::AtomicBool::new(false));
                    let failed = Arc::new(std::sync::atomic::AtomicBool::new(false));
                    let callback_failed = failed.clone();
                    let callback_cancel = cancel.clone();
                    let answer = provider
                        .invoke(
                            req,
                            &cancel,
                            Arc::new(move |event| {
                                let delta = matches!(event.kind.as_str(), "text" | "reasoning");
                                if sink
                                    .publish(json!({"kind":event.kind,"value":event.value}))
                                    .is_err()
                                {
                                    callback_failed
                                        .store(true, std::sync::atomic::Ordering::SeqCst);
                                    callback_cancel.cancel();
                                    return;
                                }
                                if delta
                                    && !scheduled.swap(true, std::sync::atomic::Ordering::SeqCst)
                                {
                                    let sink = sink.clone();
                                    let scheduled = scheduled.clone();
                                    tokio::spawn(async move {
                                        tokio::time::sleep(std::time::Duration::from_millis(60))
                                            .await;
                                        scheduled.store(false, std::sync::atomic::Ordering::SeqCst);
                                        let _ = sink.publish(json!({"kind":"flush"}));
                                    });
                                }
                            }),
                        )
                        .await;
                    if failed.load(std::sync::atomic::Ordering::SeqCst) {
                        return Err(EffectError::new(
                            "Native provider event queue overflowed or closed",
                        ));
                    }
                    answer.map(EffectResult::new).map_err(|e| EffectError {
                        aborted: e.cancelled,
                        error: e.value(),
                    })
                })))
            }
            "account" => {
                self.account(id, &c["answer"], num(&c["elapsedMs"]))?;
                Ok(EffectTask::ready(Value::Null))
            }
            "commit" => {
                let mut changed = Value::Null;
                for a in array(&c["actions"]) {
                    if ctx.cancellation.is_cancelled() {
                        return Err(EffectError::cancelled(false));
                    }
                    match a["kind"].as_str().unwrap_or("") {
                        "append" => {
                            self.state(
                                "session.append",
                                json!({"id":id,"type":a["type"],"body":a["body"]}),
                            )?;
                        }
                        "notice" => {
                            let text = compute(
                                "harness.prompts.notice",
                                json!({"name":a["notice"],"args":a["args"]}),
                            )?;
                            self.state(
                                "session.append",
                                json!({"id":id,"type":"notice","body":{"text":text}}),
                            )?;
                        }
                        "event" => {
                            self.emit(id, a["event"].as_str().unwrap_or(""), a["data"].clone())?
                        }
                        "streamEnd" => self.stream_end(id, a["discard"] == true)?,
                        "learnNoVision" => self.provider.learn_no_vision(&a["profile"])?,
                        "learnLimit" => {
                            self.provider
                                .learn_limit(&a["profile"], a["limit"].as_u64().unwrap_or(0))?;
                        }
                        "calibrate" => {
                            let identity = a["identity"].as_str().unwrap_or("");
                            if !identity.is_empty()
                                && num(&a["sentRaw"]) > 200.0
                                && num(&a["reported"]) > 0.0
                            {
                                let key = format!("token-ratio:{identity}");
                                let prior = self.state("kv.get", json!({"key":key}))?;
                                let ratio = compute(
                                    "tokens.observe",
                                    json!({"identity":identity,"estimated":a["sentRaw"],"actual":a["reported"],"ratio":prior["ratio"].as_f64().unwrap_or(1.0)}),
                                )?;
                                self.state(
                                    "kv.set",
                                    json!({"key":key,"value":{"ratio":ratio,"at":now()}}),
                                )?;
                            }
                        }
                        "lean" => {
                            let s = self.state(
                                "session.update",
                                json!({"id":id,"patch":{"toolset":"lean"}}),
                            )?;
                            changed = self.prompt(s, true)?;
                            self.emit(id, "lean-tools", json!({"context":a["context"]}))?;
                        }
                        _ => {
                            return Err(EffectError::new("Unknown native execution commit action"))
                        }
                    }
                }
                Ok(EffectTask::ready(if changed.is_null() {
                    Value::Null
                } else {
                    json!({"session":changed})
                }))
            }
            "toolCatalog" => {
                let tools = self
                    .tool_catalog()
                    .into_iter()
                    .map(|def| {
                        (
                            def["name"].as_str().unwrap_or("").to_owned(),
                            json!({"readOnly":def["readOnly"]}),
                        )
                    })
                    .collect::<serde_json::Map<_, _>>();
                Ok(EffectTask::ready(
                    json!({"session":self.session(id)?,"tools":tools}),
                ))
            }
            "prepareTool" => {
                let parsed = compute(
                    "harness.format.parseArgs",
                    json!({"raw":c["call"]["arguments"]}),
                )?;
                if !parsed["error"].is_null() {
                    return Ok(EffectTask::ready(
                        json!({"error":format!("{}. Send the call again with valid JSON arguments.",js_string(parsed.get("error"))),"ms":0}),
                    ));
                }
                let mut name = c["call"]["name"].as_str().unwrap_or("").to_owned();
                let mut args = parsed["args"].clone();
                if name == "tools_call" {
                    name = args["name"].as_str().unwrap_or("").into();
                    args = args.get("arguments").cloned().unwrap_or_else(|| json!({}));
                }
                let Some(def) = self.tool_definition(&name) else {
                    return Ok(EffectTask::ready(
                        json!({"error":format!("Unknown tool \"{name}\". Use tools_search to find available tools."),"ms":0}),
                    ));
                };
                let definition_key =
                    format!("{}:tool:{}", ctx.scope.generation.unwrap_or(0), c["index"]);
                self.process_host
                    .freeze_definition(&ctx.scope, &definition_key, &name)?;
                let invalid = compute(
                    "harness.format.checkArgs",
                    json!({"schema":def["parameters"],"args":args}),
                )?;
                if !invalid.is_null() {
                    return Ok(EffectTask::ready(
                        json!({"error":format!("Invalid arguments for {name}: {}.",js_string(Some(&invalid))),"ms":0,"definitionKey":definition_key}),
                    ));
                }
                Ok(EffectTask::ready(
                    json!({"name":name,"args":args,"definitionKey":definition_key,"repaired":parsed["repaired"],"ms":0}),
                ))
            }
            "authorizeTool" => self.approvals.check(
                &c["session"],
                c["prepared"]["name"].as_str().unwrap_or(""),
                &c["prepared"]["args"],
                &ctx.cancellation,
            ),
            "executeTool" => {
                let prepared = &c["prepared"];
                let key = Self::approval_key(ctx, prepared);
                let encoded = json_codec::stringify_js(&prepared["args"])
                    .map_err(|e| EffectError::new(e.to_string()))?;
                let approved = self
                    .approved
                    .lock()
                    .map_err(|_| EffectError::new("Approval handles unavailable"))?
                    .remove(&key);
                if approved.as_ref() != Some(&encoded) {
                    let mut e =
                        EffectError::new("Approved tool arguments changed before execution");
                    e.error["notExecuted"] = json!(true);
                    return Err(e);
                }
                let name = prepared["name"].as_str().unwrap_or("").to_owned();
                let args = prepared["args"].clone();
                let session = c["session"].clone();
                let note = match self.process_host.summarize(&name, &args)? {
                    Some(note) => {
                        compute("harness.format.oneLine", json!({"value":note,"max":100}))?
                    }
                    None if matches!(name.as_str(), "web_search" | "web_fetch") => compute(
                        "harness.format.oneLine",
                        json!({"value":super::web::summarize(&name, &args)?,"max":100}),
                    )?,
                    None => json!(super::tools::summarize(&name, &args)?),
                };
                self.state("session.update", json!({"id":id,"patch":{"note":note}}))?;
                if name == "memory_search" {
                    if let Some(semantic) = self
                        .semantic
                        .as_ref()
                        .filter(|semantic| semantic.configured())
                        .cloned()
                    {
                        let context = ctx.clone();
                        return Ok(EffectTask::Async(Box::pin(async move {
                            // Source validates the raw truthy limit before inference;
                            // malformed/fractional limits reach ordinary SQL fallback.
                            let limit = if !tepora_core::js_value::truthy(&args["limit"]) {
                                Some(8)
                            } else {
                                args["limit"]
                                    .as_f64()
                                    .filter(|n| {
                                        n.is_finite() && n.fract() == 0. && *n >= 1. && *n <= 30.
                                    })
                                    .map(|n| n as usize)
                            };
                            if let Some(limit) = limit {
                                if let Ok(value) = semantic
                                    .search(
                                        &args["query"],
                                        crate::semantic::SearchOptions {
                                            limit,
                                            ..Default::default()
                                        },
                                        &context.cancellation,
                                    )
                                    .await
                                {
                                    return Ok(EffectResult::new(
                                        json!({"result":crate::semantic::tool_result(value["hits"].as_array().map(Vec::as_slice).unwrap_or(&[]))}),
                                    ));
                                }
                            }
                            if context.cancellation.is_cancelled() {
                                return Err(EffectError::cancelled(false));
                            }
                            super::tools::execute("memory_search", args, session, context)
                                .await
                                .map(|result| EffectResult::new(json!({"result":result})))
                        })));
                    }
                }
                if matches!(name.as_str(), "web_search" | "web_fetch") {
                    return self.web.start(ctx, &name, args);
                }
                if matches!(name.as_str(), "exec" | "process") {
                    let work_root = self.state("workRoot", json!({}))?;
                    let invocation = super::process_host::ProcessInvocation::from_effect(
                        ctx,
                        prepared.clone(),
                        approved.unwrap(),
                        session,
                        self.settings()?,
                        work_root.as_str().unwrap_or("").to_owned(),
                    );
                    return self.process_host.start_effect(invocation)?.ok_or_else(|| {
                        EffectError::new("Prepared process definition disappeared")
                    });
                }
                let context = ctx.clone();
                if matches!(name.as_str(), "read" | "write" | "edit") {
                    let cwd = session["cwd"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                        .unwrap_or(
                            self.state("workRoot", json!({}))?
                                .as_str()
                                .unwrap_or("")
                                .to_owned(),
                        );
                    let mut file = super::files::FileContext::new(json_codec::sql_text(&cwd));
                    file.cwd_text = Some(cwd);
                    file.sandbox =
                        super::files::SandboxPolicy::from_value(&self.settings()?["sandbox"])?;
                    file.session_created_at_ms = session["createdAt"]
                        .as_str()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .map(|t| t.timestamp_millis() as f64);
                    file.memory = self
                        .reads
                        .lock()
                        .map_err(|_| EffectError::new("Read state unavailable"))?
                        .entry(id.clone())
                        .or_default()
                        .clone();
                    let cp = self.state("session.latest", json!({"id":id,"type":"checkpoint"}))?;
                    let view = compute(
                        "context.view",
                        json!({"checkpoint":cp,"entries":self.entries(id)?}),
                    )?;
                    file.read_visible_after = view["clearUpTo"]
                        .as_u64()
                        .unwrap_or(0)
                        .max(view["checkpoint"]["upTo"].as_u64().unwrap_or(0));
                    Ok(EffectTask::Async(Box::pin(async move {
                        super::files::FileTools
                            .execute(&name, args, file, context.cancellation)
                            .await
                            .map(|result| EffectResult::new(json!({"result":result})))
                    })))
                } else {
                    Ok(EffectTask::Async(Box::pin(async move {
                        super::tools::execute(&name, args, session, context)
                            .await
                            .map(|result| EffectResult::new(json!({"result":result})))
                    })))
                }
            }
            "beforeTool" => Ok(EffectTask::ready(json!({}))),
            "afterTool" => Ok(EffectTask::ready(json!({"result":c["result"]}))),
            "recordTools" => {
                let memory = self
                    .memory
                    .lock()
                    .map_err(|_| EffectError::new("Agent memory unavailable"))?
                    .get(id)
                    .cloned()
                    .unwrap_or_else(initial_memory);
                let definitions = self
                    .tool_catalog()
                    .into_iter()
                    .filter_map(|d| d["name"].as_str().map(str::to_owned).map(|name| (name, d)))
                    .collect::<serde_json::Map<_, _>>();
                let mut outputs = array(&c["outputs"]);
                if ctx.cancellation.is_cancelled() {
                    for out in &mut outputs {
                        out["interrupted"] = json!(true);
                    }
                }
                let definitions = self.process_host.definitions_for_receipts(
                    &ctx.scope,
                    &Value::Object(definitions),
                    &array(&c["calls"]),
                    &outputs,
                )?;
                let result=self.state("tools.receipts",json!({"id":id,"calls":c["calls"],"outputs":outputs,"B":c["B"],"memory":memory,"definitions":definitions}))?;
                // Ordered durable receipts no longer need their immutable
                // callbacks or any approved but undispatched tool handles.
                if let Some(generation) = ctx.scope.generation {
                    self.process_host
                        .release_step(id, ctx.scope.run_epoch, generation);
                    let prefix = format!("{}:{}:{}:", id, ctx.scope.run_epoch, generation);
                    self.approved
                        .lock()
                        .map_err(|_| EffectError::new("Approval handles unavailable"))?
                        .retain(|key, _| !key.starts_with(&prefix));
                }
                self.memory
                    .lock()
                    .map_err(|_| EffectError::new("Agent memory unavailable"))?
                    .insert(id.clone(), result["memory"].clone());
                let memory = self
                    .reads
                    .lock()
                    .map_err(|_| EffectError::new("Read memory unavailable"))?
                    .entry(id.clone())
                    .or_default()
                    .clone();
                let mut memory = memory
                    .lock()
                    .map_err(|_| EffectError::new("Read memory unavailable"))?;
                for read in array(&result["reads"]) {
                    memory.record_read(read["seq"].as_u64().unwrap_or(0), &read["result"]);
                }
                Ok(EffectTask::ready(Value::Null))
            }
            "afterTools" => {
                let memory = self
                    .memory
                    .lock()
                    .map_err(|_| EffectError::new("Agent memory unavailable"))?
                    .get(id)
                    .cloned()
                    .unwrap_or_else(initial_memory);
                let result = super::metacognition::after_tools(
                    self,
                    id,
                    &memory,
                    &super::metacognition::AfterToolsContext {
                        built: c["built"].clone(),
                        budget: c["budget"].clone(),
                        now_ms: chrono::Utc::now().timestamp_millis(),
                        created_at_ms: None,
                    },
                )?;
                self.memory
                    .lock()
                    .map_err(|_| EffectError::new("Agent memory unavailable"))?
                    .insert(id.clone(), result.mem);
                Ok(EffectTask::Ready(EffectResult {
                    value: Value::Null,
                    facts: json!({}),
                    events: result.events,
                }))
            }
            _ => Err(EffectError::new(format!(
                "Native execution effect {} is not integrated",
                js_string(c.get("kind"))
            ))),
        }
    }
}
impl NativeAgentHost {
    fn approval_key(ctx: &EffectContext, prepared: &Value) -> String {
        format!(
            "{}:{}:{}:{}",
            ctx.scope.session_id,
            ctx.scope.run_epoch,
            ctx.scope.generation.unwrap_or(0),
            prepared["definitionKey"].as_str().unwrap_or("")
        )
    }
    pub fn recover(&self) -> Result<(), ApiError> {
        self.runtime
            .lock()
            .map_err(|_| ApiError::new(500, "Runtime state unavailable"))?
            .recover(self)
    }
    pub fn preflight(&self) -> Result<(), ApiError> {
        let capabilities = self.state("kv.get", json!({"key":"capabilities"}))?;
        if tepora_core::js_value::truthy(&capabilities["routes"]["decision"]) {
            return Err(ApiError::unavailable("Configured decision route requires the compatibility host until native decision inference is integrated"));
        }
        let settings = self.settings()?;
        if tepora_core::js_value::truthy(&settings["heartbeat"]["enabled"]) {
            return Err(ApiError::unavailable("Configured heartbeat requires the compatibility host until native scheduling is integrated"));
        }
        if !array(&self.state("document.list", json!({"kind":"schedule"}))?).is_empty() {
            return Err(ApiError::unavailable("Saved schedules require the compatibility host until native scheduling is integrated"));
        }
        // Hooks are executable files, not ordinary persisted skills. The CLI
        // supplies the plugin scan separately before constructing this host.
        super::policy::CompiledPolicy::validate(
            settings["policy"].get("rules").unwrap_or(&json!([])),
        )?;
        for s in array(&self.state("session.list", json!({}))?) {
            if matches!(s["status"].as_str(), Some("done" | "stopped")) {
                continue;
            }
            let unsupported = strings(&s["tools"])
                .into_iter()
                .filter(|n| self.tool_definition(n).is_none())
                .collect::<Vec<_>>();
            if !unsupported.is_empty() {
                return Err(ApiError::unavailable(format!("Session {} has cached unavailable tools: {}. Continue with the compatibility host.",s["id"].as_str().unwrap_or(""),unsupported.join(", "))));
            }
        }
        Ok(())
    }
}
impl super::host_runtime::HostServices for NativeAgentHost {
    fn state(&self, op: &str, args: Value) -> Result<Value, ApiError> {
        NativeAgentHost::state(self, op, args)
    }
    fn configured(&self) -> Result<bool, ApiError> {
        self.provider.configured()
    }
    fn has_route(&self, role: &str) -> Result<bool, ApiError> {
        self.provider.has_route(role)
    }
    fn has_hooks(&self) -> bool {
        false
    }
    fn decision_available(&self) -> bool {
        false
    }
    fn refresh_prompt(&self, id: &str) -> Result<bool, ApiError> {
        NativeAgentHost::refresh_prompt(self, id)
    }
    fn worker_toolset(&self, role: &str) -> Result<Option<String>, ApiError> {
        let Some(p) = self.provider.chain(role)?.into_iter().find(|p| {
            self.provider
                .permitted(p, crate::network::Purpose::Model)
                .unwrap_or(false)
        }) else {
            return Ok(None);
        };
        Ok(self.provider.known_limits(&p)?.map(|l| {
            if num(&l["context"]) < 16000.0 {
                "lean".into()
            } else {
                "worker".into()
            }
        }))
    }
    fn stream_end(&self, id: &str, discard: bool) -> Result<(), ApiError> {
        NativeAgentHost::stream_end(self, id, discard)
    }
    fn stop_resources(&self, id: &str) -> Result<(), ApiError> {
        self.process_host.stop_session(id);
        if let Some(semantic) = &self.semantic {
            semantic.cancel_session(id);
        }
        self.web.cancel_session(id);
        let approval = self.approvals.cancel(id);
        let stream = self.stream_end(id, true);
        approval.and(stream)
    }
    fn cancel_all_approvals(&self) -> Result<(), ApiError> {
        self.approvals.cancel_all()
    }
}
impl AgentHost for NativeAgentHost {
    fn setup_context(&self, busy: bool) -> Result<Value, ApiError> {
        self.state.setup_selection_context(busy)
    }
    fn activate_setup(&self, commit: &crate::setup::SelectionCommit) -> Result<(), ApiError> {
        self.state
            .activate_selection_on_actor(&self.provider, commit)
    }
    fn facts(&self) -> Result<Value, ApiError> {
        self.runtime
            .lock()
            .map_err(|_| ApiError::new(500, "Runtime state unavailable"))?
            .facts(self)
    }
    fn request(&self, request: &AgentRequest) -> Result<Admission, ApiError> {
        match request {
            AgentRequest::DecideApproval { id, allow } => {
                Ok(Admission::new(self.approvals.decide(id, *allow)?))
            }
            AgentRequest::DecideApprovals { ids, allow } => Ok(Admission::new(json!(ids
                .iter()
                .map(|id| match self.approvals.decide(id, *allow) {
                    Ok(v) => json!({"id":id,"ok":true,"approval":v}),
                    Err(e) => json!({"id":id,"ok":false,"error":e.message}),
                })
                .collect::<Vec<_>>()))),
            _ => {
                let result = self.runtime.lock()
                    .map_err(|_| ApiError::new(500, "Runtime state unavailable"))?
                    .request(self, request)?;
                if matches!(request, AgentRequest::Configure { patch } if patch.get("webSearch").is_some()) {
                    self.web.invalidate();
                }
                Ok(result)
            }
        }
    }
    fn session(&self, id: &str) -> Result<Value, ApiError> {
        NativeAgentHost::session(self, id)
    }
    fn apply_runtime_actions(&self, actions: &[Value]) -> Result<Vec<Value>, ApiError> {
        let events = self
            .runtime
            .lock()
            .map_err(|_| ApiError::new(500, "Runtime state unavailable"))?
            .apply_actions(self, actions)?;
        for a in actions {
            if a["kind"] == "releaseRun" {
                self.process_host.release_run(
                    a["sessionId"].as_str().unwrap_or(""),
                    a["runEpoch"].as_u64().unwrap_or(0),
                );
                let prefix = format!(
                    "{}:{}:",
                    a["sessionId"].as_str().unwrap_or(""),
                    a["runEpoch"]
                );
                self.approved
                    .lock()
                    .map_err(|_| ApiError::new(500, "Approval handles unavailable"))?
                    .retain(|k, _| !k.starts_with(&prefix));
            }
        }
        Ok(events)
    }
    fn start_effect(&self, ctx: &EffectContext, c: &Value) -> Result<EffectTask, EffectError> {
        if ctx.scope.namespace == super::EffectNamespace::Runtime {
            if let Some(task) = self
                .runtime
                .lock()
                .map_err(|_| EffectError::new("Runtime state unavailable"))?
                .effect(self, ctx, c)?
            {
                return Ok(task);
            }
            if c["kind"] == "idleCompact" {
                let session = self.prompt(self.session(&ctx.scope.session_id)?, false)?;
                let snapshot = self.budget_snapshot(session.clone(), self.definitions(&session))?;
                let entries = self.entries(&ctx.scope.session_id)?;
                let retention = self.retention(&session)?;
                let provider = self.provider.clone();
                let cancel = ctx.cancellation.clone();
                let children =
                    array(&self.state("session.list", json!({"parentId":ctx.scope.session_id}))?);
                let live = json!({"sessions":children.iter().filter_map(|s|s["id"].as_str().map(|id|(id.to_owned(),s["status"].clone()))).collect::<serde_json::Map<_,_>>(),"processes":self.process_host.live(&ctx.scope.session_id)});
                return Ok(EffectTask::Async(Box::pin(async move {
                    let budget = context::budget(&provider, &snapshot, &cancel).await?;
                    if array(&budget["chain"]).is_empty() || num(&budget["B"]) < 1200.0 {
                        return Ok(EffectResult::new(Value::Null));
                    }
                    let built = context::context(&context::ContextSnapshot {
                        session: session.clone(),
                        entries: entries.clone(),
                        budget: budget.clone(),
                        vision: true,
                        plan: true,
                        force: false,
                        idle: true,
                        unicode_version: 17,
                    })?;
                    if built["plan"]["action"] != "compact" {
                        return Ok(EffectResult::new(Value::Null));
                    }
                    let snap = context::CompactionSnapshot {
                        session: session.clone(),
                        entries,
                        built: built["built"].clone(),
                        budget,
                        todo: session["todo"].clone(),
                        reflection: session["reflection"].clone(),
                        live,
                        cache_retention: retention,
                        reason: "idle".into(),
                        tail_share: None,
                        unicode_version: 17,
                    };
                    let proposal =
                        context::compact(&provider, &snap, &cancel, Arc::new(now)).await?;
                    Ok(EffectResult::new(proposal.map(|p|json!({"checkpoint":p.checkpoint,"notice":p.notice,"event":p.event})).unwrap_or(Value::Null)))
                })));
            }
            return Err(EffectError::new(format!(
                "Native runtime effect {} is not integrated",
                js_string(c.get("kind"))
            )));
        }
        self.execution_effect(ctx, c)
    }
    fn complete_effect(
        &self,
        ctx: &EffectContext,
        c: &Value,
        mut result: EffectResult,
    ) -> Result<EffectResult, EffectError> {
        match c["kind"].as_str().unwrap_or("") {
            "authorizeTool" => {
                result = self.approvals.finish(result, &ctx.cancellation)?;
                if result.value.is_string() {
                    result.value = json!({"decision":result.value});
                }
                if result.value["decision"] == "allow" && !ctx.cancellation.is_cancelled() {
                    let encoded = json_codec::stringify_js(&c["prepared"]["args"])
                        .map_err(|e| EffectError::new(e.to_string()))?;
                    self.approved
                        .lock()
                        .map_err(|_| EffectError::new("Approval handles unavailable"))?
                        .insert(Self::approval_key(ctx, &c["prepared"]), encoded);
                }
            }
            "compact" | "idleCompact" => {
                if ctx.cancellation.is_cancelled() {
                    return Err(EffectError::cancelled(false));
                }
                let id = &ctx.scope.session_id;
                if !result.value.is_null() {
                    let mut p = result.value.clone();
                    p["id"] = json!(id);
                    self.state("context.checkpoint", p)?;
                    self.prompt(self.session(id)?, true)?;
                    self.memory
                        .lock()
                        .map_err(|_| EffectError::new("Agent memory unavailable"))?
                        .entry(id.clone())
                        .or_insert_with(initial_memory)["selfCheckContext"] = json!(false);
                }
                let session = self.session(id)?;
                result.value = if c["kind"] == "idleCompact" {
                    Value::Null
                } else {
                    json!({"session":session,"toolDefs":if c["overflow"]==true{c["budget"]["toolDefs"].clone()}else{json!(self.definitions(&session))}})
                };
            }
            _ => {}
        }
        Ok(result)
    }
    fn scoped_request(&self, scope: &EffectScope, request: Value) -> Result<Admission, ApiError> {
        let from = self.session(&scope.session_id)?;
        match request["op"].as_str().unwrap_or("") {
            "runtime.spawn" => self
                .runtime
                .lock()
                .map_err(|_| ApiError::new(500, "Runtime state unavailable"))?
                .spawn(self, Some(&from), &request["args"]),
            "runtime.send" | "runtime.stop" => {
                let target = request["id"]
                    .as_str()
                    .ok_or_else(|| ApiError::bad_request("Missing target session"))?;
                let sessions = array(&self.state("session.list", json!({}))?);
                if !super::host_runtime::visible(&from, target, &sessions) {
                    return Err(ApiError::new(403, "Session is not visible"));
                }
                if request["op"] == "runtime.stop" {
                    let session = self.session(target)?;
                    if session["kind"] == "main" {
                        return Err(ApiError::new(
                            403,
                            "A work agent cannot stop the main session",
                        ));
                    }
                    return Ok(Admission {
                        value: session,
                        events: vec![
                            json!({"type":"stop","sessionId":target,"reason":request["reason"].as_str().unwrap_or("Stopped by another session")}),
                        ],
                    });
                }
                let mut body = request["body"].clone();
                body["from"] = json!(scope.session_id);
                body["source"] = json!(format!(
                    "message from \"{}\" ({})",
                    from["title"].as_str().unwrap_or(""),
                    scope.session_id
                ));
                self.runtime
                    .lock()
                    .map_err(|_| ApiError::new(500, "Runtime state unavailable"))?
                    .send(self, target, &body)
            }
            "nativeTools.execute" if request["name"] == "tools_search" => Ok(Admission::new(
                self.search_tools(&from, request["args"]["query"].as_str().unwrap_or(""))?,
            )),
            _ => {
                let result = self.state.tool_state(&scope.session_id, &request)?;
                if request["op"] == "nativeTools.execute" && request["name"] == "memory_write" {
                    if let Some(semantic) = self.semantic.as_ref().filter(|s| s.configured()) {
                        semantic.schedule_index_for(&tokio::runtime::Handle::current(), Some(&scope.session_id));
                    }
                }
                Ok(Admission::new(result))
            }
        }
    }
    fn stream(&self, scope: &EffectScope, event: Value) -> Result<(), ApiError> {
        let id = &scope.session_id;
        match event["kind"].as_str().unwrap_or("") {
            "route" => {
                self.state(
                    "session.update",
                    json!({"id":id,"patch":{"route":event["value"]}}),
                )?;
            }
            "progress" => {
                let p = &event["value"];
                let total = num(&p["total"]);
                if total <= 0.0 {
                    return Ok(());
                }
                let pct = ((num(&p["processed"]) + num(&p["cache"])) / total * 100.0)
                    .floor()
                    .min(99.0);
                let mut streams = self
                    .streams
                    .lock()
                    .map_err(|_| ApiError::new(500, "Stream state unavailable"))?;
                let b = streams.entry(id.clone()).or_default();
                if pct - b.load_pct.unwrap_or(-10.0) >= 5.0 {
                    b.load_pct = Some(pct);
                    self.state(
                        "session.update",
                        json!({"id":id,"patch":{"note":format!("文脈を読み込み中 {pct}%")}}),
                    )?;
                }
            }
            "text" | "reasoning" => {
                let mut streams = self
                    .streams
                    .lock()
                    .map_err(|_| ApiError::new(500, "Stream state unavailable"))?;
                let b = streams.entry(id.clone()).or_insert_with(|| Stream {
                    main: self
                        .session(id)
                        .map(|s| s["kind"] == "main")
                        .unwrap_or(false),
                    ..Stream::default()
                });
                b.main = self.session(id)?["kind"] == "main";
                if event["kind"] == "text" {
                    b.text.push_str(event["value"].as_str().unwrap_or(""));
                } else {
                    b.reasoning.push_str(event["value"].as_str().unwrap_or(""));
                }
                drop(streams);
            }
            "flush" => self.flush(id)?,
            _ => {
                return Err(ApiError::bad_request(
                    "Unknown native provider stream event",
                ))
            }
        }
        Ok(())
    }
    fn close(&self) -> Result<(), ApiError> {
        self.process_host.begin_close();
        if let Some(semantic) = &self.semantic {
            semantic.close();
        }
        self.web.close();
        let approval = self.approvals.cancel_all();
        self.provider.close();
        self.network.close();
        let processes = self.process_host.close_and_drain();
        approval.and(processes)
    }
}
impl super::metacognition::MetacogHost for NativeAgentHost {
    fn state(&self, op: &str, args: Value) -> Result<Value, ApiError> {
        NativeAgentHost::state(self, op, args)
    }
    fn event(&self, id: &str, name: &str, data: Value) -> Result<(), ApiError> {
        self.emit(id, name, data)
    }
    fn has_route(&self, role: &str) -> Result<bool, ApiError> {
        self.provider.has_route(role)
    }
    fn first_model(&self, role: &str) -> Result<Option<String>, ApiError> {
        Ok(self
            .provider
            .chain(role)?
            .first()
            .and_then(|p| p["model"].as_str())
            .map(str::to_owned))
    }
    fn send_parent(&self, id: &str, body: Value) -> Result<Admission, ApiError> {
        self.runtime
            .lock()
            .map_err(|_| ApiError::new(500, "Runtime state unavailable"))?
            .send(self, id, &body)
    }
}
