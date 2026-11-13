//! The main session's long-term memory on the native host: its <memory> block,
//! episode labeling at the idle handoff, archiving finished work agents under
//! their episode, and Dreaming. Rendering, label parsing and consolidation are
//! native-core's harness.memory.* operations, shared with the Node host.
use super::*;
use crate::network::RequestCancellation;

const STATE: &str = "episodes";
const CORE: &str = "memory-core";
const FAILED: &str = "memory-dream";
const LABEL_TYPES: [&str; 4] = ["input", "assistant", "tool", "notice"];
/// A failed consolidation waits this long before the next attempt.
const RETRY_MS: i64 = 30 * 60 * 1000;

fn object_or_empty(v: Value) -> Value {
    if v.is_object() {
        v
    } else {
        json!({})
    }
}
fn last(c: &Value) -> String {
    c["last"].as_str().unwrap_or("").to_owned()
}
fn id_number(c: &Value) -> u64 {
    c["id"].as_str().and_then(|s| s.strip_prefix('E')).and_then(|n| n.parse().ok()).unwrap_or(0)
}
fn by_last(cards: &mut [Value]) {
    cards.sort_by(|a, b| last(a).cmp(&last(b)).then(id_number(a).cmp(&id_number(b))));
}

impl NativeAgentHost {
    fn kv(&self, key: &str) -> Result<Value, ApiError> {
        self.state("kv.get", json!({"key":key}))
    }
    /// Enabled skills by name: the index the <memory> block lists.
    fn skill_index(&self) -> Result<Vec<Value>, ApiError> {
        let mut skills: Vec<Value> = array(&self.state("document.list", json!({"kind":"skill"}))?)
            .into_iter()
            .filter(|s| s["enabled"] == true)
            .map(|s| json!({"name":s["name"],"description":s["description"]}))
            .collect();
        skills.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
        skills.truncate(60);
        Ok(skills)
    }
    pub(super) fn memory_layers(&self, session: &Value) -> Result<String, EffectError> {
        if session["kind"] != "main" {
            return Ok(String::new());
        }
        let core = object_or_empty(self.kv(CORE)?);
        let skills = json!(self.skill_index()?);
        let tokens = if core["contextTokens"].is_number() { core["contextTokens"].clone() } else { json!(32000) };
        let out = compute("harness.memory.layers", json!({"skills":skills,"core":core,"contextTokens":tokens}))?;
        Ok(out.as_str().unwrap_or("").to_owned())
    }
    fn episode_cards(&self, session_id: Option<&str>) -> Result<Vec<Value>, ApiError> {
        Ok(array(&self.state("document.list", json!({"kind":"episode"}))?)
            .into_iter()
            .filter(|c| session_id.is_none_or(|id| c["sessionId"] == id))
            .collect())
    }
    /// Open and recently paused episodes: what the labeler may continue.
    fn known_episodes(&self, session_id: &str) -> Result<Vec<Value>, ApiError> {
        let mut all: Vec<Value> = self.episode_cards(Some(session_id))?.into_iter().filter(|c| c["state"] != "done").collect();
        by_last(&mut all);
        let mut out: Vec<Value> = all.iter().filter(|c| c["state"] == "open").cloned().collect();
        let paused: Vec<Value> = all.iter().filter(|c| c["state"] == "paused").cloned().collect();
        out.extend(paused[paused.len().saturating_sub(8)..].iter().cloned());
        Ok(out)
    }
    pub(super) fn episode_topics(&self, session_id: &str) -> Result<String, EffectError> {
        let cards = self.episode_cards(Some(session_id))?;
        Ok(compute("harness.memory.topics", json!({"cards":cards}))?.as_str().unwrap_or("").to_owned())
    }
    fn memory_state(&self) -> Result<Value, ApiError> {
        let mut st = object_or_empty(self.kv(STATE)?);
        for (k, v) in [("next", json!(1)), ("revision", json!(0)), ("labeled", json!({}))] {
            if st.get(k).is_none_or(Value::is_null) {
                st[k] = v;
            }
        }
        Ok(st)
    }
    /// What labeling needs, read before the idle lease's first await: the
    /// unlabeled entries, known episodes, counters, and a transcript of the
    /// unlabeled part already out of view.
    pub(super) fn label_snapshot(&self, session_id: &str, entries: &[Value]) -> Result<Value, EffectError> {
        let st = self.memory_state()?;
        let from = st["labeled"][session_id].as_u64().unwrap_or(0) + 1;
        let pending: Vec<Value> = entries
            .iter()
            .filter(|e| e["seq"].as_u64().is_some_and(|s| s >= from) && LABEL_TYPES.contains(&e["type"].as_str().unwrap_or("")))
            .cloned()
            .collect();
        let checkpoint = entries.iter().rev().find(|e| e["type"] == "checkpoint").cloned().unwrap_or(Value::Null);
        let up_to = checkpoint["upTo"].as_u64().unwrap_or(0);
        let hidden: Vec<Value> = pending.iter().filter(|e| e["seq"].as_u64().unwrap_or(0) <= up_to).cloned().collect();
        let transcript = if hidden.is_empty() {
            String::new()
        } else {
            let text = compute("harness.compaction.transcriptText", json!({"entries":hidden,"clearUpTo":0,"unicodeVersion":17}))?;
            compute("harness.format.fitTokens", json!({"text":text,"maxTokens":4000,"ref":format!("#{}",hidden[0]["seq"]),"unicodeVersion":17}))?["text"].as_str().unwrap_or("").to_owned()
        };
        Ok(json!({"from":from,"entries":pending,"known":self.known_episodes(session_id)?,"state":st,"transcript":transcript}))
    }
    /// Labels and cards from the idle lease, committed only if it was not preempted.
    pub(super) fn commit_labels(&self, session_id: &str, labels: &Value) -> Result<(), EffectError> {
        let mut ops: Vec<(String, Value)> = array(&labels["cards"])
            .into_iter()
            .map(|c| ("document.put".to_owned(), json!({"kind":"episode","doc":c})))
            .collect();
        ops.push(("session.label".into(), json!({"id":session_id,"labels":labels["labels"]})));
        let mut st = self.memory_state()?;
        st["next"] = labels["nextId"].clone();
        st["revision"] = labels["revision"].clone();
        st["labeled"][session_id] = labels["to"].clone();
        ops.push(("kv.set".into(), json!({"key":STATE,"value":st})));
        ops.push(("event.emit".into(), json!({"type":"agent.episodes","data":{"sessionId":session_id,"cards":array(&labels["cards"]).iter().map(|c|c["id"].clone()).collect::<Vec<_>>(),"fallback":labels["fallback"]}})));
        self.state.agent_batch(&ops)?;
        self.archive_finished(session_id)?;
        Ok(())
    }
    /// Finished work agents (with everything they started) move under their
    /// episode, out of the live session list the runtime enumerates.
    fn archive_finished(&self, session_id: &str) -> Result<(), ApiError> {
        let live = array(&self.state("session.list", json!({}))?);
        let mut owner = HashMap::new();
        for c in self.episode_cards(Some(session_id))? {
            for child in array(&c["children"]) {
                if let Some(id) = child.as_str() {
                    owner.insert(id.to_owned(), c["id"].clone());
                }
            }
        }
        for s in &live {
            let Some(episode) = s["id"].as_str().and_then(|id| owner.get(id)) else { continue };
            if s["parentId"] != session_id {
                continue;
            }
            let mut tree = vec![s.clone()];
            let mut i = 0;
            while i < tree.len() {
                let parent = tree[i]["id"].clone();
                tree.extend(live.iter().filter(|x| x["parentId"] == parent).cloned());
                i += 1;
            }
            let mut settled = true;
            for x in &tree {
                let pending = array(&self.state("inbox.pending", json!({"id":x["id"]}))?);
                if !matches!(x["status"].as_str(), Some("done" | "stopped")) || !pending.is_empty() {
                    settled = false;
                }
            }
            if !settled {
                continue;
            }
            for x in &tree {
                self.state("session.archive", json!({"id":x["id"],"episodeId":episode}))?;
            }
        }
        Ok(())
    }
    /// Dreaming is due when episodes changed since the last consolidation (and a
    /// failed attempt is not too recent).
    pub(super) fn dream_due(&self) -> Result<bool, ApiError> {
        if self.settings()?["dream"] == false {
            return Ok(false);
        }
        let revision = self.memory_state()?["revision"].as_u64().unwrap_or(0);
        let core = self.kv(CORE)?;
        let failed = self.kv(FAILED)?["failedAt"]
            .as_str()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.timestamp_millis())
            .unwrap_or(0);
        Ok(revision > core["revision"].as_u64().unwrap_or(0) && chrono::Utc::now().timestamp_millis() - failed > RETRY_MS)
    }
    pub(super) fn dream_snapshot(&self) -> Result<Value, ApiError> {
        let core = object_or_empty(self.kv(CORE)?);
        let since = core["revision"].as_u64().unwrap_or(0);
        let mut cards: Vec<Value> = self.episode_cards(None)?.into_iter().filter(|c| c["revision"].as_u64().unwrap_or(0) > since).collect();
        by_last(&mut cards);
        let cards = cards[cards.len().saturating_sub(12)..].to_vec();
        let mut memories: Vec<Value> = array(&self.state("document.list", json!({"kind":"memory"}))?).into_iter().filter(|m| m["confirmed"] == true).collect();
        let stamp = |m: &Value| m["updatedAt"].as_str().or(m["createdAt"].as_str()).unwrap_or("").to_owned();
        memories.sort_by_key(|m| stamp(m));
        let memories = memories[memories.len().saturating_sub(80)..].to_vec();
        Ok(json!({"cards":cards,"memories":memories,"core":core,"revision":self.memory_state()?["revision"]}))
    }
    pub(super) fn commit_dream(&self, dream: &Value) -> Result<(), EffectError> {
        if dream["failed"] == true {
            self.state("kv.set", json!({"key":FAILED,"value":{"failedAt":now()}}))?;
            return Ok(());
        }
        let mut ops: Vec<(String, Value)> = Vec::new();
        for content in array(&dream["add"]) {
            ops.push(("store.memory".into(), json!({"content":content,"options":{"source":"dream","confirmed":true}})));
        }
        for u in array(&dream["update"]) {
            ops.push(("store.memoryPatch".into(), json!({"id":u["id"],"patch":{"content":u["content"]}})));
        }
        for id in array(&dream["remove"]) {
            ops.push(("store.memoryDelete".into(), json!({"id":id})));
        }
        ops.push(("kv.set".into(), json!({"key":CORE,"value":{"facts":dream["core"]["facts"],"engagement":dream["core"]["engagement"],"revision":dream["revision"],"contextTokens":dream["contextTokens"],"dreamedAt":now()}})));
        ops.push(("event.emit".into(), json!({"type":"agent.memory","data":{"added":array(&dream["add"]).len(),"updated":array(&dream["update"]).len(),"removed":array(&dream["remove"]).len(),"episodes":array(&dream["episodes"])}})));
        self.state.agent_batch(&ops)?;
        if !array(&dream["add"]).is_empty() || !array(&dream["update"]).is_empty() {
            if let (Some(semantic), Ok(handle)) = (self.semantic.as_ref().filter(|s| s.configured()), tokio::runtime::Handle::try_current()) {
                semantic.schedule_index_for(&handle, None);
            }
        }
        Ok(())
    }
}

/// Label the unlabeled stretch in context: the same prefix as the handoff request, so it is read from cache.
pub(super) async fn label(
    provider: &ProviderRuntime,
    session: &Value,
    built: &Value,
    budget: &Value,
    snap: &Value,
    retention: &str,
    cancel: &RequestCancellation,
) -> Result<Value, EffectError> {
    let entries = array(&snap["entries"]);
    if entries.is_empty() {
        return Ok(Value::Null);
    }
    let to = entries.last().unwrap()["seq"].clone();
    let request = compute("harness.memory.labelRequest", json!({"cards":snap["known"],"from":snap["from"],"to":to,"transcript":snap["transcript"]}))?;
    let mut messages = array(&built["messages"]);
    messages.push(json!({"role":"user","content":request}));
    let answer = provider
        .invoke(
            InvokeRequest {
                chain: array(&budget["chain"]),
                messages,
                options: json!({"accountingSessionId":session["id"],"accountingPurpose":"summary","tools":budget["toolDefs"],"toolChoice":"none","maxTokens":1500,"cacheKey":session["id"],"slotKey":session["id"],"cacheRetention":retention,"priority":5}),
            },
            cancel,
            context::silent_sink(),
        )
        .await;
    context::check(cancel)?;
    let text = match answer {
        Ok(a) if matches!(a["finish"].as_str(), None | Some("stop")) => a["content"].as_str().unwrap_or("").to_owned(),
        Ok(_) => String::new(),
        Err(error) => {
            if error.cancelled || error.kind == "accounting" {
                return Err(context::provider_error(error, cancel));
            }
            String::new()
        }
    };
    apply_labels(snap, &session["id"], &text)
}

/// The labeler's answer applied to the snapshot's stretch: proposed cards and
/// per-entry labels, committed by `commit_labels` with the lease.
pub(super) fn apply_labels(snap: &Value, session_id: &Value, text: &str) -> Result<Value, EffectError> {
    let entries = array(&snap["entries"]);
    let Some(to) = entries.last().map(|e| e["seq"].clone()) else { return Ok(Value::Null) };
    let revision = snap["state"]["revision"].as_u64().unwrap_or(0) + 1;
    let seqs: Vec<Value> = entries
        .iter()
        .map(|e| {
            let mut s = json!({"seq":e["seq"],"at":e["at"]});
            if e["type"] == "tool" && e["name"] == "sessions_spawn" && e["data"]["sessionId"].is_string() {
                s["spawned"] = e["data"]["sessionId"].clone();
            }
            s
        })
        .collect();
    let first_input = entries.iter().find(|e| e["type"] == "input").map(|e| e["text"].clone()).unwrap_or(json!(""));
    let title = compute("harness.format.oneLine", json!({"value":first_input,"max":60}))?;
    let mut out = compute("harness.memory.applyLabels", json!({"text":text,"cards":snap["known"],"seqs":seqs,"nextId":snap["state"]["next"],"revision":revision,"sessionId":session_id,"fallbackTitle":title}))?;
    out["revision"] = json!(revision);
    out["to"] = to;
    Ok(out)
}

/// Process the new prefix right after a handoff so the next reply reads it from
/// the prompt cache: only for a model on this computer or the LAN. Stops at the
/// first generated token.
pub(super) async fn warm(provider: &ProviderRuntime, session: &Value, built: &Value, budget: &Value, retention: &str, cancel: &RequestCancellation) -> Result<(), EffectError> {
    let Some(p) = array(&budget["chain"]).first().cloned() else { return Ok(()) };
    if p["domain"] == "cloud" {
        return Ok(());
    }
    let stop = RequestCancellation::new();
    let first = stop.clone();
    let sink: crate::provider::EventSink = Arc::new(move |event| {
        if matches!(event.kind.as_str(), "text" | "reasoning" | "delta") {
            first.cancel();
        }
    });
    let request = InvokeRequest {
        chain: vec![p],
        messages: array(&built["messages"]),
        options: json!({"accountingSessionId":session["id"],"accountingPurpose":"summary","tools":budget["toolDefs"],"toolChoice":"none","maxTokens":1,"cacheKey":session["id"],"slotKey":session["id"],"cacheRetention":retention,"priority":5}),
    };
    tokio::select! {
        answer = provider.invoke(request, &stop, sink) => {
            if let Err(error) = answer {
                if error.kind == "accounting" { return Err(context::provider_error(error, cancel)); }
            }
        }
        _ = cancel.cancelled() => { stop.cancel(); }
    }
    context::check(cancel)
}

/// Dreaming: consolidate the changed episodes into the saved memories and core memory.
pub(super) async fn dream(provider: &ProviderRuntime, snap: &Value, b: f64, cancel: &RequestCancellation) -> Result<Value, EffectError> {
    let request = compute("harness.memory.dreamRequest", json!({"cards":snap["cards"],"memories":snap["memories"],"core":snap["core"],"contextTokens":b}))?;
    let answer = provider
        .invoke(
            InvokeRequest {
                chain: provider.chain("compaction")?,
                messages: vec![json!({"role":"system","content":request["system"]}), json!({"role":"user","content":request["prompt"]})],
                options: json!({"accountingPurpose":"summary","maxTokens":3000,"priority":0}),
            },
            cancel,
            context::silent_sink(),
        )
        .await;
    context::check(cancel)?;
    let text = match answer {
        Ok(a) if matches!(a["finish"].as_str(), None | Some("stop")) && a["content"].is_string() => a["content"].clone(),
        Ok(_) => return Ok(json!({"failed":true})),
        Err(error) => {
            if error.cancelled || error.kind == "accounting" {
                return Err(context::provider_error(error, cancel));
            }
            return Ok(json!({"failed":true}));
        }
    };
    let mut out = compute("harness.memory.dreamApply", json!({"text":text,"memories":snap["memories"],"core":snap["core"],"contextTokens":b}))?;
    out["revision"] = snap["revision"].clone();
    out["contextTokens"] = json!(b);
    out["episodes"] = json!(array(&snap["cards"]).iter().map(|c| c["id"].clone()).collect::<Vec<_>>());
    Ok(out)
}
