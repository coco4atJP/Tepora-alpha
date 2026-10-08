//! Synchronous agent state operations on Workspace's one SQLite connection.
//! A batch commits before any listener sees its derived or source events.
use super::*;
use tepora_core::js_value::js_string;

impl WorkspaceAccess {
    pub fn agent_state(&self, operation: &str, args: Value) -> Result<Value, ApiError> {
        self.agent_batch(&[(operation.to_owned(), args)])
            .map(|mut v| v.remove(0))
    }
    pub fn agent_batch(&self, operations: &[(String, Value)]) -> Result<Vec<Value>, ApiError> {
        let mut state = self.lock()?;
        state.call("exec", json!({"sql":"SAVEPOINT native_agent_batch"}))?;
        let mut events = Vec::new();
        let result = operations
            .iter()
            .map(|(op, args)| state.agent_operation(op, args, &mut events))
            .collect::<Result<Vec<_>, _>>();
        match result {
            Ok(values) => {
                if let Err(e) = state.call("exec", json!({"sql":"RELEASE native_agent_batch"})) {
                    let _ = state.call(
                        "exec",
                        json!({"sql":"ROLLBACK TO native_agent_batch; RELEASE native_agent_batch"}),
                    );
                    return Err(e);
                }
                for event in events {
                    state.publish_value(event)?;
                }
                Ok(values)
            }
            Err(e) => {
                let _ = state.call(
                    "exec",
                    json!({"sql":"ROLLBACK TO native_agent_batch; RELEASE native_agent_batch"}),
                );
                Err(e)
            }
        }
    }
}
fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, ApiError> {
    args[key]
        .as_str()
        .ok_or_else(|| ApiError::bad_request(format!("{key} must be a string")))
}
fn broadcast(events: &mut Vec<Value>, kind: &str, data: Value) {
    events.push(json!({"seq":null,"type":kind,"data":data,"at":now()}));
}
fn public_session(mut session: Value) -> Value {
    if let Some(o) = session.as_object_mut() {
        o.remove("system");
        o.remove("tools");
    }
    session
}
fn indexable(kind: &str, body: &Value) -> String {
    let text = match kind {
        "input" | "notice" => body["text"].as_str().unwrap_or("").to_owned(),
        "assistant" => {
            let mut fields = vec![body["content"].as_str().unwrap_or("").to_owned()];
            if let Some(calls) = body["toolCalls"].as_array() {
                for c in calls {
                    fields.push(format!(
                        "{} {}",
                        js_string(c.get("name")),
                        js_string(c.get("arguments"))
                    ));
                }
            }
            fields.join("\n")
        }
        "tool" => format!(
            "{} {}\n{}",
            js_string(body.get("name")),
            body["stub"].as_str().unwrap_or(""),
            slice(
                &if truth(&body["content"]) {
                    js_string(body.get("content"))
                } else {
                    String::new()
                },
                20000
            )
        ),
        "checkpoint" => body["summary"].as_str().unwrap_or("").to_owned(),
        _ => String::new(),
    };
    store_domain::indexed_text(&json!({"content":slice(&text,40000)}), 17)
}
impl State {
    pub(super) fn agent_operation(
        &mut self,
        op: &str,
        args: &Value,
        events: &mut Vec<Value>,
    ) -> Result<Value, ApiError> {
        match op {
            "model.record" => self.record_model_call(&args["receipt"]),
            "settings" => self.agent_settings(),
            "settings.configure" => {
                let patch = args.get("patch").unwrap_or(args);
                require(patch.is_object(), 400, "Invalid agent settings")?;
                let old = self.value("agent-settings")?;
                let mut next = merge(&old, patch);
                if truth(&patch["sandbox"]) {
                    next["sandbox"] = sandbox_settings(
                        &merge(&self.defaults["agent"]["sandbox"], &old["sandbox"]),
                        &patch["sandbox"],
                    )?;
                }
                for k in [
                    "maxDepth",
                    "maxSteps",
                    "progressEvery",
                    "concurrency",
                    "idleCompactSeconds",
                ] {
                    if let Some(v) = patch.get(k) {
                        require(
                            safe_integer(v).is_some_and(|n| (0..=100000).contains(&n)),
                            400,
                            &format!("Invalid {k}"),
                        )?;
                    }
                }
                for k in ["dream", "metacognition", "delegationGuard"] {
                    if let Some(v) = patch.get(k) {
                        require(v.is_boolean(), 400, &format!("{k} is true or false"))?;
                    }
                }
                if let Some(v) = patch.get("verifyCompletion") {
                    require(
                        matches!(v.as_str(), Some("auto" | "self" | "off")),
                        400,
                        "verifyCompletion is auto, self or off",
                    )?;
                }
                if truth(&patch["budget"]) {
                    next["budget"] = merge(&old["budget"], &patch["budget"]);
                    for k in ["sessionUsd", "dailyUsd"] {
                        if let Some(v) = next["budget"].get(k) {
                            require(
                                v.as_f64().is_some_and(|n| {
                                    n.is_finite() && (0.0..=100000.0).contains(&n)
                                }),
                                400,
                                &format!("Invalid budget {k}"),
                            )?;
                        }
                    }
                }
                if truth(&patch["cacheRetention"]) {
                    require(
                        patch["cacheRetention"].as_object().is_some_and(|o| {
                            o.values()
                                .all(|v| matches!(v.as_str(), Some("short" | "long")))
                        }),
                        400,
                        "Cache retention is short or long",
                    )?;
                    next["cacheRetention"] =
                        merge(&old["cacheRetention"], &patch["cacheRetention"]);
                }
                self.set_value("agent-settings", next)?;
                let value = self.agent_settings()?;
                let event = self.call(
                    "event.append",
                    json!({"type":"agent.settings","data":value,"at":now()}),
                )?;
                events.push(event);
                Ok(value)
            }
            "personas" => self.personas(),
            "workRoot" => Ok(json!(json_codec::encode_text(
                &self.work_root.to_string_lossy()
            ))),
            "main" => self.main(),
            "session.list" => Ok(json!(self
                .list("session")?
                .into_iter()
                .filter(|s| {
                    (!truth(&args["kind"]) || s["kind"] == args["kind"])
                        && (args.get("parentId").is_none() || s["parentId"] == args["parentId"])
                        && (!truth(&args["status"]) || s["status"] == args["status"])
                })
                .collect::<Vec<_>>())),
            "session.get" => self.get("session", string_arg(args, "id")?),
            "session.remove" => {
                let id=string_arg(args,"id")?;
                require(!self.get("session",id)?.is_null(),404,"Session not found")?;
                self.call("session.remove",json!({"id":id}))
            }
            "session.create" => {
                let f = args.get("fields").unwrap_or(args);
                require(
                    matches!(f["kind"].as_str(), Some("main" | "worker" | "specialist")),
                    400,
                    "Unknown session kind",
                )?;
                let fallback = |key: &str, default: Value| {
                    if truth(&f[key]) {
                        f[key].clone()
                    } else {
                        default
                    }
                };
                let main = f["kind"] == "main";
                let at = now();
                let mut s = json!({"id":fallback("id",json!(Uuid::new_v4().to_string())),"kind":f["kind"],"title":slice(&if truth(&f["title"]){js_string(f.get("title"))}else{String::new()},120),"parentId":fallback("parentId",Value::Null),"rootId":fallback("rootId",fallback("parentId",Value::Null)),"depth":fallback("depth",json!(0)),"status":"idle","role":fallback("role",json!(if main{"chat"}else{"work"})),"toolset":fallback("toolset",json!(if main{"main"}else{"worker"})),"persona":fallback("persona",Value::Null),"cwd":fallback("cwd",Value::Null),"task":fallback("task",Value::Null),"label":fallback("label",Value::Null),"result":null,"note":"","stats":{"steps":0,"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"compactions":0,"clears":0},"createdAt":at,"updatedAt":at});
                s = merge(&s, &f["extra"]);
                require(
                    self.get("session", string_arg(&s, "id")?)?.is_null(),
                    409,
                    "Session already exists",
                )?;
                self.put("session", s.clone())?;
                broadcast(events, "session.updated", public_session(s.clone()));
                Ok(s)
            }
            "session.update" => {
                let id = string_arg(args, "id")?;
                let current = self.get("session", id)?;
                require(!current.is_null(), 404, "Session not found")?;
                require(args["patch"].is_object(), 400, "Invalid session patch")?;
                let mut next = merge(&current, &args["patch"]);
                next["updatedAt"] = json!(now());
                self.put("session", next.clone())?;
                broadcast(events, "session.updated", public_session(next.clone()));
                Ok(next)
            }
            "session.append" => {
                let id = string_arg(args, "id")?;
                let kind = string_arg(args, "type")?;
                let entry=self.call(op,json!({"id":id,"type":kind,"body":args["body"],"at":now(),"terms":indexable(kind,&args["body"])}))?;
                broadcast(
                    events,
                    "session.entry",
                    json!({"sessionId":id,"entry":entry}),
                );
                Ok(entry)
            }
            "context.clear" => {
                let id = string_arg(args, "id")?;
                let entry = self.agent_operation(
                    "session.append",
                    &json!({"id":id,"type":"clear","body":{"upTo":args["upTo"]}}),
                    events,
                )?;
                let current = self.get("session", id)?;
                let mut stats = current["stats"].clone();
                stats["clears"] = json!(stats["clears"].as_u64().unwrap_or(0) + 1);
                self.agent_operation(
                    "session.update",
                    &json!({"id":id,"patch":{"stats":stats}}),
                    events,
                )?;
                self.agent_operation("event.emit",&json!({"type":"compaction","data":{"sessionId":id,"action":"clear","upTo":args["upTo"]}}),events)?;
                Ok(entry)
            }
            "context.checkpoint" => {
                let id = string_arg(args, "id")?;
                let checkpoint = self.agent_operation(
                    "session.append",
                    &json!({"id":id,"type":"checkpoint","body":args["checkpoint"]}),
                    events,
                )?;
                let mut notice = args["notice"].clone();
                notice["compaction"] = checkpoint["seq"].clone();
                self.agent_operation(
                    "session.append",
                    &json!({"id":id,"type":"notice","body":notice}),
                    events,
                )?;
                let current = self.get("session", id)?;
                let mut stats = current["stats"].clone();
                stats["compactions"] = json!(stats["compactions"].as_u64().unwrap_or(0) + 1);
                self.agent_operation(
                    "session.update",
                    &json!({"id":id,"patch":{"stats":stats}}),
                    events,
                )?;
                self.agent_operation(
                    "event.emit",
                    &json!({"type":"compaction","data":args["event"]}),
                    events,
                )?;
                Ok(checkpoint)
            }
            "tools.receipts" => {
                let id = string_arg(args, "id")?;
                let session = self.get("session", id)?;
                let first_seq = self
                    .call("session.seq", json!({"id":id}))?
                    .as_u64()
                    .ok_or_else(|| ApiError::new(500, "Invalid transcript sequence"))?;
                let calls = args["calls"]
                    .as_array()
                    .ok_or_else(|| ApiError::bad_request("Missing receipt calls"))?;
                let outputs = args["outputs"]
                    .as_array()
                    .ok_or_else(|| ApiError::bad_request("Missing receipt outputs"))?;
                let plan = crate::agent::receipts::plan_receipts_with_unicode(
                    &session,
                    calls,
                    outputs,
                    args["B"].as_f64().unwrap_or(0.0),
                    &args["definitions"],
                    &args["memory"],
                    first_seq,
                    17,
                )
                .map_err(|e| {
                    ApiError::new(
                        500,
                        e.error["message"]
                            .as_str()
                            .unwrap_or("Receipt planning failed"),
                    )
                })?;
                let mut reads = Vec::new();
                for receipt in plan.receipts {
                    if let Some(evidence) = receipt.evidence {
                        self.agent_operation("evidence.put", &evidence, events)?;
                    }
                    let entry = self.agent_operation(
                        "session.append",
                        &json!({"id":id,"type":"tool","body":receipt.body}),
                        events,
                    )?;
                    require(
                        entry["seq"].as_u64() == Some(receipt.seq),
                        500,
                        "Receipt sequence changed inside transaction",
                    )?;
                    if let Some(read) = receipt.read_result {
                        reads.push(json!({"seq":receipt.seq,"result":read}));
                    }
                }
                self.agent_operation(
                    "session.update",
                    &json!({"id":id,"patch":{"stats":plan.stats}}),
                    events,
                )?;
                Ok(json!({"memory":plan.memory,"reads":reads}))
            }
            "inbox.enqueue" => {
                let id = args
                    .get("sessionId")
                    .or_else(|| args.get("id"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| ApiError::bad_request("Missing sessionId"))?;
                let input = args
                    .get("input")
                    .or_else(|| args.get("item"))
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let mut item = merge(&json!({"id":Uuid::new_v4().to_string()}), &input);
                if !truth(&item["at"]) {
                    item["at"] = json!(now());
                }
                self.call(op, json!({"sessionId":id,"item":item}))?;
                let count = self
                    .call("inbox.pending", json!({"id":id}))?
                    .as_array()
                    .map_or(0, Vec::len);
                broadcast(
                    events,
                    "session.inbox",
                    json!({"sessionId":id,"count":count,"item":item}),
                );
                Ok(item)
            }
            "inbox.deliver" => {
                let id = string_arg(args, "id")?;
                let items = self.call("inbox.take", json!({"id":id}))?;
                let mut delivered = 0;
                for item in items.as_array().into_iter().flatten() {
                    let passive = item["mode"] == "notify";
                    let mut body = item
                        .as_object()
                        .cloned()
                        .ok_or_else(|| ApiError::new(500, "Invalid inbox item"))?;
                    body.remove("id");
                    body.remove("at");
                    body.remove("mode");
                    body.insert("passive".into(), json!(passive));
                    self.agent_operation(
                        "session.append",
                        &json!({"id":id,"type":"input","body":body}),
                        events,
                    )?;
                    if !passive {
                        delivered += 1;
                    }
                }
                Ok(json!({"delivered":delivered}))
            }
            "event.broadcast" => {
                broadcast(events, string_arg(args, "type")?, args["data"].clone());
                Ok(Value::Null)
            }
            "event.emit" => {
                let event = self.call(
                    "event.append",
                    json!({"type":string_arg(args,"type")?,"data":args["data"],"at":now()}),
                )?;
                events.push(event.clone());
                Ok(event)
            }
            "memory.recall" | "document.get" | "document.list" | "document.remove"
            | "document.search" | "kv.get" | "kv.set" | "kv.delete" | "session.seq"
            | "session.entries" | "session.contextEntries" | "session.latest" | "session.entry" | "session.tail"
            | "session.patch" | "session.search" | "inbox.pending" | "inbox.take"
            | "inbox.takeItem" | "inbox.sessions" | "evidence.get" => self.call(op, args.clone()),
            "document.put" => self.put(string_arg(args, "kind")?, args["doc"].clone()),
            "evidence.put" => {
                let mut p = args.clone();
                p["at"] = json!(now());
                self.call(op, p)
            }
            "store.memory" | "store.memoryPatch" | "store.memoryDelete" | "store.artifact" => {
                let result = self.call(op, args.clone())?;
                if let Some(es) = result["events"].as_array() {
                    events.extend(es.iter().cloned());
                }
                Ok(result["value"].clone())
            }
            _ => Err(ApiError::unavailable(format!(
                "Native agent state operation {op} is unavailable"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_window_agent_router_reads_without_new_writes() {
        let dir = std::env::temp_dir().join(format!("tepora-history-router-{}", Uuid::new_v4()));
        let workspace = Workspace::open(&dir).unwrap();
        let access = workspace.access();
        let session = access.agent_state("main", json!({})).unwrap();
        let id = &session["id"];
        for (kind, body) in [
            ("input", json!({"text":"earlier"})),
            ("checkpoint", json!({"upTo":1,"text":"summary"})),
            ("input", json!({"text":"live"})),
        ] {
            access.agent_state("session.append", json!({"id":id,"type":kind,"body":body})).unwrap();
        }
        let counters = || {
            let mut state = access.lock().unwrap();
            let changes = state.call("sql",json!({"mode":"get","sql":"SELECT total_changes() AS n"})).unwrap();
            let sequence = state.call("event.seq",json!({})).unwrap();
            (changes, sequence)
        };
        let before = counters();
        let entries = access.agent_state("session.contextEntries",json!({"id":id})).unwrap();
        assert_eq!(entries.as_array().unwrap().len(), 2);
        assert_eq!(entries[0]["type"], "checkpoint");
        assert_eq!(entries[1]["text"], "live");
        assert_eq!(counters(), before);
        assert_eq!(access.agent_state("session.entries",json!({"id":id})).unwrap().as_array().unwrap().len(),3);
        drop(access);
        drop(workspace);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
