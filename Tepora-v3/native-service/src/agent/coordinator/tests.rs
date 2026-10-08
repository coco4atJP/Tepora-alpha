use super::*;
use std::sync::atomic::AtomicUsize;

type Deferred = (EffectContext, oneshot::Sender<EffectAnswer>);
#[derive(Default)]
struct Data {
    scheduler_enabled: bool,
    scheduler_ticks: Vec<SchedulerKind>,
    admission_checks: usize,
    admission_plans: usize,
    admission_commits: usize,
    admission_seen: HashMap<String, Value>,
    setup_commits: usize,
    auxiliary: bool,
    auxiliary_commits: usize,
    sessions: Vec<Value>,
    tail: HashMap<String, Vec<Value>>,
    effects: Vec<(String, String, u64)>,
    actions: Vec<Value>,
    held: HashMap<String, VecDeque<Deferred>>,
    holds: Vec<String>,
    callbacks: Vec<Value>,
    receipts: Vec<Value>,
    answers: VecDeque<Value>,
    reentrant_stop: bool,
    stop_after_authorization: bool,
    panic_at: Option<String>,
    async_panic_at: Option<String>,
    close_count: usize,
}
struct FakeHost {
    data: Mutex<Data>,
    changed: Condvar,
    completed: AtomicUsize,
}
impl FakeHost {
    fn new(sessions: Vec<Value>) -> Arc<Self> {
        let tail = sessions
            .iter()
            .map(|s| (string(s, "id"), vec![json!({"type":"input","text":"work"})]))
            .collect();
        Arc::new(Self {
            data: Mutex::new(Data {
                sessions,
                tail,
                ..Data::default()
            }),
            changed: Condvar::new(),
            completed: AtomicUsize::new(0),
        })
    }
    fn wait(&self, predicate: impl Fn(&Data) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut data = self.data.lock().unwrap();
        while !predicate(&data) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(
                !remaining.is_zero(),
                "Timed out; effects={:?}, actions={:?}",
                data.effects,
                data.actions
            );
            data = self.changed.wait_timeout(data, remaining).unwrap().0;
        }
    }
    fn hold(&self, kind: &str) {
        self.data.lock().unwrap().holds.push(kind.into());
    }
    fn pop(&self, kind: &str) -> Deferred {
        self.wait(|d| d.held.get(kind).is_some_and(|q| !q.is_empty()));
        self.data
            .lock()
            .unwrap()
            .held
            .get_mut(kind)
            .unwrap()
            .pop_front()
            .unwrap()
    }
    fn resolve(&self, kind: &str, value: Value) -> EffectContext {
        let (context, tx) = self.pop(kind);
        tx.send(Ok(EffectResult::new(value))).unwrap();
        context
    }
}
fn session(id: &str, kind: &str) -> Value {
    json!({"id":id,"kind":kind,"status":"idle","toolset":"lean","tools":[],"stats":{"steps":0,"toolCalls":0,"cost":0},"result":null})
}
impl AgentHost for FakeHost {
    fn scheduler_policy(&self) -> Result<Option<SchedulerPolicy>, ApiError> {
        Ok(self.data.lock().unwrap().scheduler_enabled.then_some(SchedulerPolicy { heartbeat_ms: Some(60_000) }))
    }
    fn setup_context(&self, busy: bool) -> Result<Value, ApiError> {
        Ok(json!({"busy":busy}))
    }
    fn activate_setup(&self, _: &crate::setup::SelectionCommit) -> Result<(), ApiError> {
        self.data.lock().unwrap().setup_commits += 1;
        Ok(())
    }
    fn request_key(&self, request: &AgentRequest) -> Result<Option<String>, ApiError> {
        let AgentRequest::Input { body } = request else {
            return Ok(None);
        };
        self.data.lock().unwrap().admission_checks += 1;
        self.changed.notify_all();
        Ok(body["requestId"].as_str().map(str::to_owned))
    }
    fn plan_request(&self, request: &AgentRequest) -> Result<RequestPlan, ApiError> {
        if let AgentRequest::SchedulerTick { kind } = request {
            self.data.lock().unwrap().scheduler_ticks.push(*kind);
            return Ok(RequestPlan::Ready(Admission::new(Value::Null)));
        }
        let AgentRequest::Input { body } = request else {
            return self.request(request).map(RequestPlan::Ready);
        };
        let mut d = self.data.lock().unwrap();
        if let Some(value) = body["requestId"]
            .as_str()
            .and_then(|key| d.admission_seen.get(key))
        {
            return Ok(RequestPlan::Ready(Admission::new(value.clone())));
        }
        d.admission_plans += 1;
        self.changed.notify_all();
        Ok(RequestPlan::Prepare {
            session_id: "main".into(),
            command: json!({"kind":"prepareInput"}),
        })
    }
    fn complete_request(
        &self,
        _: &EffectContext,
        request: &AgentRequest,
        _: EffectResult,
    ) -> Result<Admission, ApiError> {
        let AgentRequest::Input { body } = request else {
            unreachable!()
        };
        let value = json!({"accepted":true,"requestId":body["requestId"],"text":body["text"]});
        let mut d = self.data.lock().unwrap();
        d.admission_commits += 1;
        if let Some(key) = body["requestId"].as_str() {
            d.admission_seen.insert(key.into(), value.clone());
        }
        self.changed.notify_all();
        Ok(Admission::new(value))
    }
    fn facts(&self) -> Result<Value, ApiError> {
        let d = self.data.lock().unwrap();
        Ok(
            json!({"nowMs":now_ms(),"settings":{"concurrency":1,"verifyCompletion":"off","progressEvery":0,"maxSteps":0,"budget":{}},"dailyCost":0,"hasHooks":false,"decisionAvailable":false,"sessions":d.sessions.iter().map(|s|json!({"session":s,"tail":d.tail.get(s["id"].as_str().unwrap()),"pending":0})).collect::<Vec<_>>()}),
        )
    }
    fn session(&self, id: &str) -> Result<Value, ApiError> {
        self.data
            .lock()
            .unwrap()
            .sessions
            .iter()
            .find(|s| s["id"] == id)
            .cloned()
            .ok_or_else(|| ApiError::new(404, "Session not found"))
    }
    fn request(&self, r: &AgentRequest) -> Result<Admission, ApiError> {
        match r {
            AgentRequest::Send { id, .. } => Ok(Admission {
                value: json!({"accepted":true}),
                events: vec![json!({"type":"wake","sessionId":id,"from":"user"})],
            }),
            _ => Ok(Admission::new(Value::Null)),
        }
    }
    fn apply_runtime_actions(&self, actions: &[Value]) -> Result<Vec<Value>, ApiError> {
        let mut d = self.data.lock().unwrap();
        let mut events = vec![];
        for a in actions {
            d.actions.push(a.clone());
            let id = string(a, "sessionId");
            if a["kind"] == "createRun" && d.reentrant_stop {
                d.reentrant_stop = false;
                events.extend([
                    json!({"type":"stop","sessionId":id,"reason":"reentrant"}),
                    json!({"type":"resume","sessionId":id}),
                ]);
            }
            if let Some(s) = d.sessions.iter_mut().find(|s| s["id"] == id) {
                match a["kind"].as_str().unwrap() {
                    "updateSession" => {
                        for (k, v) in a["patch"].as_object().unwrap() {
                            s[k] = v.clone();
                        }
                    }
                    "finish" => {
                        s["status"] = a["status"].clone();
                        s["result"] = a["text"].clone();
                    }
                    _ => {}
                }
            }
        }
        self.changed.notify_all();
        Ok(events)
    }
    fn start_effect(&self, c: &EffectContext, command: &Value) -> Result<EffectTask, EffectError> {
        let kind = string(command, "kind");
        let mut d = self.data.lock().unwrap();
        d.effects
            .push((c.scope.session_id.clone(), kind.clone(), c.scope.run_epoch));
        self.changed.notify_all();
        if d.panic_at.as_ref() == Some(&kind) {
            drop(d);
            panic!("controlled synchronous host panic");
        }
        if d.async_panic_at.as_ref() == Some(&kind) {
            return Ok(EffectTask::Async(Box::pin(async {
                panic!("controlled async host panic");
            })));
        }
        if d.holds.contains(&kind) {
            let (tx, rx) = oneshot::channel();
            d.held.entry(kind).or_default().push_back((c.clone(), tx));
            self.changed.notify_all();
            return Ok(EffectTask::Async(Box::pin(async move {
                rx.await
                    .unwrap_or_else(|_| Err(EffectError::new("Controlled fake effect dropped")))
            })));
        }
        if kind == "authorizeTool" && d.stop_after_authorization {
            d.stop_after_authorization = false;
            return Ok(EffectTask::Ready(EffectResult {
                value: json!({"decision":"allow"}),
                facts: json!({}),
                events: vec![
                    json!({"type":"stop","sessionId":c.scope.session_id,"reason":"before dispatch"}),
                ],
            }));
        }
        if kind == "deliver" && d.auxiliary {
            d.auxiliary = false;
            return Ok(EffectTask::ReadyWithAuxiliary(
                EffectResult::new(json!({"delivered":1})),
                vec![json!({"kind":"decisionRoute","routeVersion":1})],
            ));
        }
        let value = match kind.as_str() {
            "prepareInput" => json!({"files":[],"images":[]}),
            "deliver" => json!({"delivered":0}),
            "prompt" => command["session"].clone(),
            "budget" => {
                json!({"chain":[{"id":"fake"}],"B":5000,"limits":{"context":8192},"ratio":1,"toolDefs":[],"toolsTokens":0,"vision":false})
            }
            "context" => json!({"built":{"messages":[],"tokens":10},"plan":{"action":"none"}}),
            "beforeRequest" => json!({"messages":[]}),
            "invoke" => d
                .answers
                .pop_front()
                .unwrap_or_else(|| json!({"content":"done","tool_calls":[],"usage":{}})),
            "account" => {
                let s = d
                    .sessions
                    .iter_mut()
                    .find(|s| s["id"] == c.scope.session_id)
                    .unwrap();
                s["stats"]["steps"] = json!(s["stats"]["steps"].as_u64().unwrap() + 1);
                Value::Null
            }
            "commit" => {
                for action in command["actions"].as_array().unwrap() {
                    if action["kind"] == "append" {
                        let mut entry = action["body"].clone();
                        entry["type"] = action["type"].clone();
                        d.tail.get_mut(&c.scope.session_id).unwrap().push(entry);
                    }
                }
                Value::Null
            }
            "toolCatalog" => {
                json!({"session":d.sessions.iter().find(|s|s["id"]==c.scope.session_id).unwrap(),"tools":{"read":{"readOnly":true},"write":{"readOnly":false},"tools_call":{"readOnly":false}}})
            }
            "prepareTool" => {
                json!({"name":command["call"]["name"],"args":{},"definitionKey":format!("{}:{}",c.scope.generation.unwrap(),command["index"]),"ms":0})
            }
            "beforeTool" => json!({}),
            "authorizeTool" => json!({"decision":"allow"}),
            "executeTool" => json!({"result":"ok"}),
            "afterTool" => json!({"result":command["result"]}),
            "recordTools" => {
                d.receipts
                    .extend(command["outputs"].as_array().unwrap().iter().cloned());
                self.changed.notify_all();
                Value::Null
            }
            "afterTools" => Value::Null,
            "mainTurn" => json!({"delegated":false}),
            "probeFiles" => json!([]),
            "completionContext" => json!({"brief":"fake"}),
            _ => return Err(EffectError::new(format!("Unexpected fake effect {kind}"))),
        };
        Ok(EffectTask::ready(value))
    }
    fn complete_auxiliary(
        &self,
        _: &EffectContext,
        _: &Value,
        _: EffectAnswer,
    ) -> Result<(), ApiError> {
        self.data.lock().unwrap().auxiliary_commits += 1;
        Ok(())
    }
    fn complete_effect(
        &self,
        _: &EffectContext,
        _: &Value,
        r: EffectResult,
    ) -> Result<EffectResult, EffectError> {
        self.completed.fetch_add(1, Ordering::SeqCst);
        Ok(r)
    }
    fn stream(&self, _: &EffectScope, v: Value) -> Result<(), ApiError> {
        let mut d = self.data.lock().unwrap();
        d.callbacks.push(v);
        self.changed.notify_all();
        Ok(())
    }
    fn scoped_request(&self, _: &EffectScope, v: Value) -> Result<Admission, ApiError> {
        Ok(Admission::new(v))
    }
    fn close(&self) -> Result<(), ApiError> {
        let mut d = self.data.lock().unwrap();
        d.close_count += 1;
        self.changed.notify_all();
        Ok(())
    }
}
fn start(host: Arc<FakeHost>) -> (tokio::runtime::Runtime, AgentHandle) {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let handle = AgentCoordinator::start(host, rt.handle().clone()).unwrap();
    (rt, handle)
}
fn wait_idle(handle: &AgentHandle, id: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let s = handle.state(id).unwrap();
        if s["runtime"]["active"] == false && s["pending"] == 0 {
            break;
        }
        assert!(Instant::now() < deadline, "not idle: {s}");
        thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn reserved_main_lane_and_worker_capacity_are_owned_by_native_runtime() {
    let host = FakeHost::new(vec![
        session("w1", "worker"),
        session("w2", "worker"),
        session("main", "main"),
    ]);
    host.hold("invoke");
    let (_rt, h) = start(host.clone());
    h.request(AgentRequest::Initialize).unwrap();
    host.wait(|d| d.held.get("invoke").is_some_and(|v| v.len() == 2));
    let d = host.data.lock().unwrap();
    let admitted = d
        .effects
        .iter()
        .filter(|(_, k, _)| k == "invoke")
        .map(|(id, _, _)| id.as_str())
        .collect::<Vec<_>>();
    assert!(admitted.contains(&"w1") && admitted.contains(&"main"));
    assert!(!admitted.contains(&"w2"));
    drop(d);
    let ticket = h.begin_close();
    host.resolve("invoke", json!({"content":"old","tool_calls":[]}));
    host.resolve("invoke", json!({"content":"old","tool_calls":[]}));
    ticket.wait().unwrap();
}

#[test]
fn stop_resume_waits_for_actual_effect_and_rejects_late_streams() {
    let host = FakeHost::new(vec![session("main", "main")]);
    host.hold("invoke");
    let (_rt, h) = start(host.clone());
    h.request(AgentRequest::Initialize).unwrap();
    let (old, tx) = host.pop("invoke");
    old.events.publish(json!({"text":"before stop"})).unwrap();
    host.wait(|d| d.callbacks.len() == 1);
    h.request(AgentRequest::Stop {
        id: "main".into(),
        reason: "stop".into(),
        rearm_main: false,
    })
    .unwrap();
    h.request(AgentRequest::Resume { id: "main".into() })
        .unwrap();
    assert!(old.cancellation.is_cancelled());
    assert_eq!(h.state("main").unwrap()["runtime"]["draining"], true);
    old.events.publish(json!({"text":"stale"})).unwrap();
    tx.send(Ok(EffectResult::new(
        json!({"content":"old","tool_calls":[]}),
    )))
    .unwrap();
    let (new, tx) = host.pop("invoke");
    assert_ne!(old.scope.run_epoch, new.scope.run_epoch);
    assert_ne!(old.scope.generation, new.scope.generation);
    old.events
        .publish(json!({"text":"stale after resume"}))
        .unwrap();
    h.shared
        .tx
        .send(Message::Complete(
            old.scope.clone(),
            Ok(EffectResult::new(
                json!({"content":"duplicate old completion"}),
            )),
        ))
        .unwrap();
    assert_eq!(
        h.state("main").unwrap()["runtime"]["runEpoch"],
        new.scope.run_epoch
    );
    assert_eq!(host.data.lock().unwrap().callbacks.len(), 1);
    assert_eq!(host.data.lock().unwrap().tail["main"].len(), 1);
    h.begin_close();
    tx.send(Ok(EffectResult::new(Value::Null))).unwrap();
    h.begin_close().wait().unwrap();
}

#[test]
fn parallel_actual_tool_outcomes_drain_in_model_order() {
    let host = FakeHost::new(vec![session("main", "main")]);
    host.hold("executeTool");
    host.data.lock().unwrap().answers.push_back(json!({"content":"","usage":{},"tool_calls":[{"id":"a","function":{"name":"read","arguments":"{}"}},{"id":"b","function":{"name":"read","arguments":"{}"}},{"id":"c","function":{"name":"write","arguments":"{}"}}]}));
    let (_rt, h) = start(host.clone());
    h.request(AgentRequest::Initialize).unwrap();
    let (a, ta) = host.pop("executeTool");
    let (b, tb) = host.pop("executeTool");
    assert_ne!(a.scope.operation_id, b.scope.operation_id);
    h.request(AgentRequest::Stop {
        id: "main".into(),
        reason: "stop".into(),
        rearm_main: false,
    })
    .unwrap();
    tb.send(Ok(EffectResult::new(json!({"result":"second"}))))
        .unwrap();
    assert_eq!(h.state("main").unwrap()["runtime"]["draining"], true);
    assert!(host.data.lock().unwrap().receipts.is_empty());
    ta.send(Ok(EffectResult::new(json!({"result":"first"}))))
        .unwrap();
    host.wait(|d| d.receipts.len() == 3);
    wait_idle(&h, "main");
    let d = host.data.lock().unwrap();
    assert_eq!(d.receipts[0]["result"], "first");
    assert_eq!(d.receipts[1]["result"], "second");
    assert_eq!(d.receipts[0]["interrupted"], true);
    assert_ne!(d.receipts[0]["notExecuted"], true);
    assert_eq!(d.receipts[2]["notExecuted"], true);
    assert_eq!(
        d.effects
            .iter()
            .filter(|(_, k, _)| k == "executeTool")
            .count(),
        2
    );
    drop(d);
    h.begin_close().wait().unwrap();
}

#[test]
fn pending_approval_close_cancels_then_waits_for_ordered_receipt() {
    let host = FakeHost::new(vec![session("main", "main")]);
    host.hold("authorizeTool");
    host.data.lock().unwrap().answers.push_back(json!({"content":"","usage":{},"tool_calls":[{"id":"a","function":{"name":"write","arguments":"{}"}}]}));
    let (_rt, h) = start(host.clone());
    h.request(AgentRequest::Initialize).unwrap();
    let (context, tx) = host.pop("authorizeTool");
    let close = h.begin_close();
    host.wait(|d| d.actions.iter().any(|a| a["kind"] == "cancelAllApprovals"));
    assert!(context.cancellation.is_cancelled());
    assert!(!close.is_complete());
    tx.send(Err(EffectError::cancelled(true))).unwrap();
    close.wait().unwrap();
    let d = host.data.lock().unwrap();
    assert_eq!(d.receipts.len(), 1);
    assert_eq!(d.receipts[0]["notExecuted"], true);
    assert_eq!(d.close_count, 1);
    assert!(!d.effects.iter().any(|(_, k, _)| k == "executeTool"));
}

#[test]
fn reentrant_stop_resume_runs_after_whole_batch_before_any_old_effect() {
    let host = FakeHost::new(vec![session("main", "main")]);
    host.hold("invoke");
    host.data.lock().unwrap().reentrant_stop = true;
    let (_rt, h) = start(host.clone());
    h.request(AgentRequest::Initialize).unwrap();
    let (context, tx) = host.pop("invoke");
    let d = host.data.lock().unwrap();
    let epochs = d
        .actions
        .iter()
        .filter(|a| a["kind"] == "createRun")
        .map(|a| a["runEpoch"].as_u64().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(epochs.len(), 2);
    assert_eq!(context.scope.run_epoch, epochs[1]);
    assert!(!d.effects.iter().any(|(_, _, epoch)| *epoch == epochs[0]));
    drop(d);
    let close = h.begin_close();
    tx.send(Ok(EffectResult::new(Value::Null))).unwrap();
    close.wait().unwrap();
}

#[test]
fn synchronous_and_async_panics_become_rejections_without_stranded_runs() {
    for asynchronous in [false, true] {
        let host = FakeHost::new(vec![session("main", "main")]);
        if asynchronous {
            host.data.lock().unwrap().async_panic_at = Some("budget".into());
        } else {
            host.data.lock().unwrap().panic_at = Some("prompt".into());
        }
        let (_rt, h) = start(host.clone());
        h.request(AgentRequest::Initialize).unwrap();
        host.wait(|d| {
            d.actions
                .iter()
                .any(|a| a["kind"] == "event" && a["event"] == "crash")
        });
        wait_idle(&h, "main");
        h.begin_close().wait().unwrap();
    }
}

#[test]
fn stopped_timer_and_deleted_session_cannot_admit_old_callback() {
    let host = FakeHost::new(vec![session("main", "main")]);
    host.hold("invoke");
    let (_rt, h) = start(host.clone());
    h.request(AgentRequest::Initialize).unwrap();
    let (_, tx) = host.pop("invoke");
    // Use a real model failure so RuntimeEngine itself owns the retry timer.
    tx.send(Err(EffectError {
        error: json!({"kind":"transient","message":"retry","retryAfterMs":200}),
        aborted: false,
    }))
    .unwrap();
    host.wait(|d| d.actions.iter().any(|a| a["kind"] == "armTimer"));
    let token = h.state("main").unwrap()["runtime"]["timer"]["timerToken"].clone();
    h.request(AgentRequest::Stop {
        id: "main".into(),
        reason: "stop timer".into(),
        rearm_main: true,
    })
    .unwrap();
    h.shared
        .tx
        .send(Message::Runtime(
            json!({"type":"timerFired","sessionId":"main","timerToken":token}),
        ))
        .unwrap();
    assert_eq!(h.state("main").unwrap()["runtime"]["active"], false);
    host.data.lock().unwrap().sessions.clear();
    h.shared
        .tx
        .send(Message::Runtime(
            json!({"type":"timerFired","sessionId":"main","timerToken":token}),
        ))
        .unwrap();
    assert_eq!(h.state("main").unwrap()["runtime"]["active"], false);
    h.begin_close().wait().unwrap();
}

#[test]
fn tool_state_callbacks_are_fifo_and_rejected_after_stop() {
    let host = FakeHost::new(vec![session("main", "main")]);
    host.hold("invoke");
    let (rt, h) = start(host.clone());
    h.request(AgentRequest::Initialize).unwrap();
    let (c, tx) = host.pop("invoke");
    assert_eq!(
        rt.block_on(c.events.call(json!({"read":1}))).unwrap(),
        json!({"read":1})
    );
    h.request(AgentRequest::Stop {
        id: "main".into(),
        reason: "stop".into(),
        rearm_main: false,
    })
    .unwrap();
    assert_eq!(
        rt.block_on(c.events.call(json!({"late":true})))
            .unwrap_err()
            .status,
        409
    );
    tx.send(Ok(EffectResult::new(Value::Null))).unwrap();
    wait_idle(&h, "main");
    h.begin_close().wait().unwrap();
}

#[test]
fn nested_execution_and_runtime_operation_namespaces_do_not_collide() {
    let host = FakeHost::new(vec![session("main", "main")]);
    let (_rt, h) = start(host.clone());
    h.request(AgentRequest::Initialize).unwrap();
    host.wait(|d| d.actions.iter().any(|a| a["kind"] == "reply"));
    wait_idle(&h, "main");
    let d = host.data.lock().unwrap();
    assert_eq!(d.tail["main"].last().unwrap()["content"], "done");
    assert_eq!(d.actions.iter().filter(|a| a["kind"] == "reply").count(), 1);
    assert!(!d.actions.iter().any(|a| a["event"] == "crash"));
    drop(d);
    h.begin_close().wait().unwrap();
}

#[test]
fn cancellation_before_execute_dispatch_is_explicitly_not_executed() {
    let host = FakeHost::new(vec![session("main", "main")]);
    {
        let mut d = host.data.lock().unwrap();
        d.stop_after_authorization = true;
        d.answers.push_back(json!({"content":"","usage":{},"tool_calls":[{"id":"a","function":{"name":"write","arguments":"{}"}}]}));
    }
    let (_rt, h) = start(host.clone());
    h.request(AgentRequest::Initialize).unwrap();
    host.wait(|d| !d.receipts.is_empty());
    wait_idle(&h, "main");
    let d = host.data.lock().unwrap();
    assert_eq!(d.receipts[0]["notExecuted"], true);
    assert!(!d.effects.iter().any(|(_, kind, _)| kind == "executeTool"));
    drop(d);
    h.begin_close().wait().unwrap();
}

#[test]
fn auxiliary_route_is_parallel_tool_safe_and_stop_drains_actual_future() {
    let host = FakeHost::new(vec![session("main", "main")]);
    {
        let mut d = host.data.lock().unwrap();
        d.auxiliary = true;
        d.answers.push_back(json!({"content":"","tool_calls":[{"id":"read1","name":"read","arguments":"{}"}],"usage":{}}));
    }
    host.hold("decisionRoute");
    host.hold("executeTool");
    let (_rt, h) = start(host.clone());
    h.request(AgentRequest::Initialize).unwrap();
    let (aux, aux_tx) = host.pop("decisionRoute");
    let (tool, tool_tx) = host.pop("executeTool");
    assert_ne!(aux.scope.namespace, tool.scope.namespace);
    assert_eq!(aux.scope.run_epoch, tool.scope.run_epoch);
    h.request(AgentRequest::Stop {
        id: "main".into(),
        reason: "fixture".into(),
        rearm_main: false,
    })
    .unwrap();
    assert!(aux.cancellation.is_cancelled());
    tool_tx
        .send(Ok(EffectResult::new(json!({"result":"actual receipt"}))))
        .unwrap();
    host.wait(|d| !d.receipts.is_empty());
    assert_eq!(h.state("main").unwrap()["runtime"]["active"], true);
    aux.events.publish(json!({"late":true})).unwrap();
    aux_tx
        .send(Ok(EffectResult::new(json!({"raw":0.99}))))
        .unwrap();
    wait_idle(&h, "main");
    assert!(host.data.lock().unwrap().callbacks.is_empty());
    assert_eq!(host.data.lock().unwrap().auxiliary_commits, 0);
    h.begin_close().wait().unwrap();
}
#[test]
fn close_waits_for_auxiliary_without_accepting_its_late_commit() {
    let host = FakeHost::new(vec![session("main", "main")]);
    host.data.lock().unwrap().auxiliary = true;
    host.hold("decisionRoute");
    host.hold("invoke");
    let (_rt, h) = start(host.clone());
    h.request(AgentRequest::Initialize).unwrap();
    let (aux, aux_tx) = host.pop("decisionRoute");
    let (_, chat_tx) = host.pop("invoke");
    let close = h.begin_close();
    host.wait(|d| d.actions.iter().any(|a| a["kind"] == "abortRun"));
    chat_tx.send(Err(EffectError::cancelled(false))).unwrap();
    assert!(!close.is_complete());
    assert!(aux.cancellation.is_cancelled());
    aux_tx.send(Ok(EffectResult::new(Value::Null))).unwrap();
    close.wait().unwrap();
    assert_eq!(host.data.lock().unwrap().auxiliary_commits, 0);
}

fn pending_input(handle: &AgentHandle, key: &str, text: &str) -> thread::JoinHandle<Answer> {
    let handle = handle.clone();
    let body = json!({"requestId":key,"text":text});
    thread::spawn(move || handle.request(AgentRequest::Input { body }))
}
#[test]
fn concurrent_input_ids_share_one_preparation_and_cache_only_committed_success() {
    let host = FakeHost::new(vec![session("main", "main")]);
    host.hold("prepareInput");
    let (_rt, h) = start(host.clone());
    let first = pending_input(&h, "same-request", "first");
    let (ctx, tx) = host.pop("prepareInput");
    assert_eq!(ctx.scope.namespace, EffectNamespace::Admission);
    let second = pending_input(&h, "same-request", "second");
    host.wait(|d| d.admission_checks == 2);
    assert_eq!(host.data.lock().unwrap().admission_plans, 1);
    assert_eq!(h.state("main").unwrap()["pending"], 1);
    assert_eq!(h.shared.requests.load(Ordering::SeqCst), 2);
    tx.send(Ok(EffectResult::new(Value::Null))).unwrap();
    let accepted = first.join().unwrap().unwrap();
    assert_eq!(accepted, second.join().unwrap().unwrap());
    assert_eq!(accepted["text"], "first");
    assert_eq!(
        h.request(AgentRequest::Input {
            body: json!({"requestId":"same-request","text":"later"})
        })
        .unwrap(),
        accepted
    );
    assert_eq!(host.data.lock().unwrap().admission_commits, 1);
    assert_eq!(host.data.lock().unwrap().admission_plans, 1);
    assert_eq!(h.shared.requests.load(Ordering::SeqCst), 0);
    h.begin_close().wait().unwrap();
}
#[test]
fn failed_and_panicking_preparations_release_reservations_for_retry() {
    let host = FakeHost::new(vec![session("main", "main")]);
    host.hold("prepareInput");
    let (_rt, h) = start(host.clone());
    let first = pending_input(&h, "retry-request", "first");
    let (_, tx) = host.pop("prepareInput");
    let second = pending_input(&h, "retry-request", "second");
    host.wait(|d| d.admission_checks == 2);
    tx.send(Err(
        ApiError::new(413, "controlled preparation failure").into()
    ))
    .unwrap();
    for reply in [first, second] {
        assert_eq!(reply.join().unwrap().unwrap_err().status, 413);
    }
    assert_eq!(host.data.lock().unwrap().admission_commits, 0);
    let retry = pending_input(&h, "retry-request", "retry");
    host.resolve("prepareInput", Value::Null);
    assert_eq!(retry.join().unwrap().unwrap()["text"], "retry");
    host.data.lock().unwrap().async_panic_at = Some("prepareInput".into());
    assert_eq!(
        h.request(AgentRequest::Input {
            body: json!({"requestId":"panic-request","text":"panic"})
        })
        .unwrap_err()
        .status,
        500
    );
    host.data.lock().unwrap().async_panic_at = None;
    let retry = pending_input(&h, "panic-request", "after panic");
    host.resolve("prepareInput", Value::Null);
    assert!(retry.join().unwrap().is_ok());
    assert_eq!(h.shared.requests.load(Ordering::SeqCst), 0);
    assert_eq!(h.state("main").unwrap()["pending"], 0);
    h.begin_close().wait().unwrap();
}
#[test]
fn admission_callbacks_cannot_mutate_state_and_stop_close_wait_for_actual_preparation() {
    for closing in [false, true] {
        let host = FakeHost::new(vec![session("main", "main")]);
        host.hold("prepareInput");
        let (rt, h) = start(host.clone());
        let reply = pending_input(&h, "cancel-request", "input");
        let (ctx, tx) = host.pop("prepareInput");
        assert_eq!(
            rt.block_on(ctx.events.call(json!({"untrustedMutation":true})))
                .unwrap_err()
                .status,
            409
        );
        ctx.events.publish(json!({"untrustedStream":true})).unwrap();
        let close = if closing {
            Some(h.begin_close())
        } else {
            h.request(AgentRequest::Stop {
                id: "main".into(),
                reason: "cancel input".into(),
                rearm_main: false,
            })
            .unwrap();
            None
        };
        h.state("main").unwrap();
        assert!(ctx.cancellation.is_cancelled());
        assert!(!reply.is_finished());
        if let Some(close) = &close {
            assert!(!close.is_complete());
        }
        tx.send(Ok(EffectResult::new(Value::Null))).unwrap();
        assert_eq!(
            reply.join().unwrap().unwrap_err().status,
            if closing { 503 } else { 409 }
        );
        assert_eq!(host.data.lock().unwrap().admission_commits, 0);
        assert!(host.data.lock().unwrap().callbacks.is_empty());
        close.unwrap_or_else(|| h.begin_close()).wait().unwrap();
    }
}
#[test]
fn admission_cap_bounds_preparation_and_close_drains_all_waiters() {
    let host = FakeHost::new(vec![session("main", "main")]);
    host.hold("prepareInput");
    let (_rt, h) = start(host.clone());
    let mut replies = Vec::new();
    let mut effects = Vec::new();
    for n in 0..MAX_PREPARATIONS {
        replies.push(pending_input(&h, &format!("request-{n}"), "input"));
        effects.push(host.pop("prepareInput"));
    }
    assert_eq!(
        h.request(AgentRequest::Input {
            body: json!({"requestId":"overflow-request","text":"input"})
        })
        .unwrap_err()
        .status,
        429
    );
    assert_eq!(h.state("main").unwrap()["pending"], MAX_PREPARATIONS);
    let close = h.begin_close();
    h.state("main").unwrap();
    assert!(!close.is_complete());
    for (ctx, tx) in effects {
        assert!(ctx.cancellation.is_cancelled());
        tx.send(Ok(EffectResult::new(Value::Null))).unwrap();
    }
    for reply in replies {
        assert_eq!(reply.join().unwrap().unwrap_err().status, 503);
    }
    close.wait().unwrap();
    assert_eq!(h.shared.requests.load(Ordering::SeqCst), 0);
}
#[test]
fn new_epoch_dispatch_is_parked_until_released_old_auxiliary_actually_drains() {
    let host = FakeHost::new(vec![session("main", "main")]);
    host.data.lock().unwrap().auxiliary = true;
    host.hold("decisionRoute");
    host.hold("invoke");
    let (_rt, h) = start(host.clone());
    h.request(AgentRequest::Initialize).unwrap();
    let (aux, aux_tx) = host.pop("decisionRoute");
    host.resolve(
        "invoke",
        json!({"content":"done","tool_calls":[],"usage":{}}),
    );
    host.wait(|d| d.actions.iter().any(|a| a["kind"] == "releaseRun"));
    assert!(aux.cancellation.is_cancelled());
    host.data
        .lock()
        .unwrap()
        .tail
        .get_mut("main")
        .unwrap()
        .push(json!({"type":"input","text":"new input"}));
    h.request(AgentRequest::Send {
        id: "main".into(),
        body: json!({"text":"new input"}),
    })
    .unwrap();
    host.wait(|d| {
        d.actions
            .iter()
            .filter(|a| a["kind"] == "createRun")
            .count()
            == 2
    });
    assert!(host
        .data
        .lock()
        .unwrap()
        .effects
        .iter()
        .all(|(_, _, epoch)| *epoch == aux.scope.run_epoch));
    aux_tx.send(Ok(EffectResult::new(Value::Null))).unwrap();
    let (new, tx) = host.pop("invoke");
    assert_ne!(new.scope.run_epoch, aux.scope.run_epoch);
    let close = h.begin_close();
    tx.send(Err(EffectError::cancelled(false))).unwrap();
    close.wait().unwrap();
}

#[test]
fn setup_selection_final_busy_check_is_serialized_with_new_runs_and_cancellation() {
    let host = FakeHost::new(vec![session("main", "main")]);
    host.hold("invoke");
    let (_rt, h) = start(host.clone());
    assert_eq!(
        h.request(AgentRequest::SetupContext).unwrap()["busy"],
        false
    );
    let selection = crate::setup::SelectionCommit {
        cancellation: RequestCancellation::new(),
        expected_configuration: "fixture".into(),
        expected_registry_revision: 0,
        settings: json!({}),
        report: json!({}),
        registry: json!({}),
    };
    h.request(AgentRequest::Initialize).unwrap();
    let (_, tx) = host.pop("invoke");
    assert_eq!(h.request(AgentRequest::SetupContext).unwrap()["busy"], true);
    assert_eq!(
        h.request(AgentRequest::ActivateSetup {
            commit: selection.clone()
        })
        .unwrap_err()
        .status,
        409
    );
    h.request(AgentRequest::Stop {
        id: "main".into(),
        reason: "stop for selection".into(),
        rearm_main: false,
    })
    .unwrap();
    assert_eq!(
        h.request(AgentRequest::ActivateSetup {
            commit: selection.clone()
        })
        .unwrap_err()
        .status,
        409,
        "Draining active run must remain busy"
    );
    tx.send(Err(EffectError::cancelled(false))).unwrap();
    wait_idle(&h, "main");
    let cancelled = crate::setup::SelectionCommit {
        cancellation: RequestCancellation::new(),
        ..selection.clone()
    };
    cancelled.cancellation.cancel();
    assert_eq!(
        h.request(AgentRequest::ActivateSetup { commit: cancelled })
            .unwrap_err()
            .status,
        409
    );
    assert_eq!(host.data.lock().unwrap().setup_commits, 0);
    h.request(AgentRequest::ActivateSetup { commit: selection })
        .unwrap();
    assert_eq!(host.data.lock().unwrap().setup_commits, 1);
    h.begin_close().wait().unwrap();
}

#[test]
fn scheduler_reconfiguration_and_shutdown_reject_stale_queued_ticks() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1).enable_all().build().unwrap();
    let host = FakeHost::new(vec![]);
    host.data.lock().unwrap().scheduler_enabled = true;
    let (tx, rx) = mpsc::channel();
    let shared = Arc::new(Shared {
        tx, closing: AtomicBool::new(false), requests: AtomicUsize::new(0),
        streams: AtomicUsize::new(0), handles: AtomicUsize::new(1), thread: Mutex::new(None),
        done: Arc::new(Completion { result: Mutex::new(None), changed: Condvar::new() }),
    });
    let mut actor = Coordinator::new(host.clone(), runtime.handle().clone(), shared.clone());
    actor.refresh_schedulers(true).unwrap();
    let service = actor.service_id;
    let first = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    actor.message(first);
    assert_eq!(host.data.lock().unwrap().scheduler_ticks, vec![SchedulerKind::Schedules]);
    let old = actor.recurring[&SchedulerKind::Heartbeat].generation;
    actor.refresh_schedulers(false).unwrap();
    let new = actor.recurring[&SchedulerKind::Heartbeat].generation;
    assert_ne!(old, new);
    actor.scheduler_tick(service, SchedulerKind::Heartbeat, old);
    actor.scheduler_tick(service + 1, SchedulerKind::Heartbeat, new);
    assert_eq!(host.data.lock().unwrap().scheduler_ticks.len(), 1);
    actor.scheduler_tick(service, SchedulerKind::Heartbeat, new);
    assert_eq!(host.data.lock().unwrap().scheduler_ticks.len(), 2);
    assert_eq!(shared.requests.load(Ordering::SeqCst), 0);
    actor.begin_close();
    assert!(actor.recurring.is_empty());
    actor.scheduler_tick(service, SchedulerKind::Heartbeat, new);
    assert_eq!(host.data.lock().unwrap().scheduler_ticks.len(), 2);
}
