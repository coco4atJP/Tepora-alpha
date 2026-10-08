//! Actor-side scheduling adapter. Timer plans and decision futures are owned by
//! the coordinator; only these synchronous callbacks mutate Workspace state.
use super::*;
use crate::agent::{scheduler, RequestPlan, SchedulerKind, SchedulerPolicy};

impl NativeAgentHost {
    pub(super) fn scheduler_policy_snapshot(&self) -> Result<SchedulerPolicy, ApiError> {
        Ok(SchedulerPolicy {
            heartbeat_ms: scheduler::heartbeat_period(&self.settings()?),
        })
    }
    pub(super) fn plan_scheduled(&self, kind: SchedulerKind) -> Result<RequestPlan, ApiError> {
        if kind == SchedulerKind::Schedules {
            let docs = array(&self.state("document.list", json!({"kind":"schedule"}))?);
            let due = self
                .scheduler
                .lock()
                .map_err(|_| ApiError::new(500, "Scheduler state unavailable"))?
                .due(&docs)?;
            let mut events = Vec::new();
            for due in due {
                let mut runtime = self
                    .runtime
                    .lock()
                    .map_err(|_| ApiError::new(500, "Runtime state unavailable"))?;
                let main = runtime.main(self)?;
                let id = main["id"].as_str().unwrap_or("");
                let delivery = if due.task {
                    runtime.spawn(
                        self,
                        Some(&main),
                        &json!({"task":due.text,"title":due.title,"from":"schedule"}),
                    )
                } else {
                    runtime.send(self,id,&json!({"text":due.text,"from":"schedule","kind":"reminder","source":due.source}))
                };
                drop(runtime);
                // Source task failures are reported after consuming the due
                // item; a failed one-shot is not silently retried on restart.
                let task_error = match delivery {
                    Ok(admission) => {
                        events.extend(admission.events);
                        None
                    }
                    Err(error) if due.task => Some(error),
                    Err(error) => return Err(error),
                };
                let mutation = match due.next {
                    Some(next) => ("document.put".into(), json!({"kind":"schedule","doc":next})),
                    None => (
                        "document.remove".into(),
                        json!({"kind":"schedule","id":due.document["id"]}),
                    ),
                };
                self.state.agent_batch(&[
                    mutation,
                    (
                        "event.emit".into(),
                        json!({"type":"schedule.updated","data":due.event}),
                    ),
                ])?;
                if let Some(error) = task_error {
                    let message = compute(
                        "harness.format.oneLine",
                        json!({"value":error.message,"max":200}),
                    )
                    .map_err(as_api)?;
                    self.emit(
                        id,
                        "schedule-failed",
                        json!({"id":due.document["id"],"message":message}),
                    )?;
                }
            }
            return Ok(RequestPlan::Ready(Admission {
                value: Value::Null,
                events,
            }));
        }
        let (main, busy) = {
            let runtime = self
                .runtime
                .lock()
                .map_err(|_| ApiError::new(500, "Runtime state unavailable"))?;
            let main = runtime.main(self)?;
            let busy = runtime.is_active(main["id"].as_str().unwrap_or(""));
            (main, busy)
        };
        let id = main["id"].as_str().unwrap_or("");
        let pending = !array(&self.state("inbox.pending", json!({"id":id}))?).is_empty();
        let settings = self.settings()?;
        let sessions = array(&self.state("session.list", json!({}))?);
        let approvals = array(&self.state("document.list", json!({"kind":"approval"}))?);
        let heartbeat = self
            .scheduler
            .lock()
            .map_err(|_| ApiError::new(500, "Scheduler state unavailable"))?
            .heartbeat(
                &settings,
                &sessions,
                &approvals,
                busy,
                pending,
                self.decision_host.decisions.available(),
            )?;
        let Some(heartbeat) = heartbeat else {
            return Ok(RequestPlan::Ready(Admission::new(json!(false))));
        };
        if !heartbeat.infer {
            return self
                .finish_heartbeat(id, &heartbeat.message, true)
                .map(RequestPlan::Ready);
        }
        Ok(RequestPlan::Prepare {
            session_id: id.into(),
            command: json!({"kind":"heartbeat","state":heartbeat.state_text,"message":heartbeat.message,"heartbeatGeneration":heartbeat.generation}),
        })
    }
    pub(super) fn heartbeat_effect(&self, ctx: &EffectContext, command: &Value) -> EffectTask {
        let decisions = self.decision_host.decisions.clone();
        let cancel = ctx.cancellation.clone();
        let state = command["state"].clone();
        let message = command["message"].clone();
        EffectTask::Async(Box::pin(async move {
            let probability = decisions
                .yes(&state, scheduler::HEARTBEAT_QUESTION, &cancel)
                .await?;
            Ok(EffectResult::new(
                json!({"send":probability.is_none_or(|p|p>=0.25),"message":message}),
            ))
        }))
    }
    pub(super) fn finish_heartbeat(
        &self,
        id: &str,
        message: &str,
        send: bool,
    ) -> Result<Admission, ApiError> {
        if !send {
            return Ok(Admission::new(json!(false)));
        }
        let sent = self
            .runtime
            .lock()
            .map_err(|_| ApiError::new(500, "Runtime state unavailable"))?
            .send(
                self,
                id,
                &json!({"text":message,"from":"timer","kind":"heartbeat","source":"check-in"}),
            )?;
        Ok(Admission {
            value: json!(true),
            events: sent.events,
        })
    }
    pub(super) fn scheduler_tool(&self, session: &Value, args: &Value) -> Result<Value, ApiError> {
        let scheduler = self
            .scheduler
            .lock()
            .map_err(|_| ApiError::new(500, "Scheduler state unavailable"))?;
        match args["action"].as_str().unwrap_or("") {
            "list" => {
                let docs = scheduler.list(&array(
                    &self.state("document.list", json!({"kind":"schedule"}))?,
                ));
                let lines = docs
                    .iter()
                    .map(|doc| scheduler.show(doc))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(
                    json!({"text":if lines.is_empty(){"Nothing is scheduled.".to_owned()}else{lines.join("\n")}}),
                )
            }
            "cancel" => {
                let id = if tepora_core::js_value::truthy(&args["id"]) {
                    js_string(args.get("id"))
                } else {
                    String::new()
                };
                let doc = self.state("document.get", json!({"kind":"schedule","id":id}))?;
                if doc.is_null() {
                    return Err(ApiError::new(
                        404,
                        format!("No scheduled item {}", js_string(args.get("id"))),
                    ));
                }
                let mut event = doc.clone();
                event["removed"] = json!(true);
                self.state.agent_batch(&[
                    (
                        "document.remove".into(),
                        json!({"kind":"schedule","id":doc["id"]}),
                    ),
                    (
                        "event.emit".into(),
                        json!({"type":"schedule.updated","data":event}),
                    ),
                ])?;
                Ok(json!({"text":format!("Cancelled {}.",doc["id"].as_str().unwrap_or(""))}))
            }
            "add" => {
                let count = array(&self.state("document.list", json!({"kind":"schedule"}))?).len();
                let doc = scheduler.add(args, session["id"].as_str().unwrap_or(""), count)?;
                self.state.agent_batch(&[
                    ("document.put".into(), json!({"kind":"schedule","doc":doc})),
                    (
                        "event.emit".into(),
                        json!({"type":"schedule.updated","data":doc}),
                    ),
                ])?;
                Ok(
                    json!({"text":format!("Scheduled {}",scheduler.show(&doc)?),"data":{"id":doc["id"],"at":doc["at"]}}),
                )
            }
            _ => Err(ApiError::bad_request("Invalid schedule action")),
        }
    }
    pub(super) fn scheduler_failed(
        &self,
        request: &AgentRequest,
        error: &ApiError,
    ) -> Result<(), ApiError> {
        if matches!(
            request,
            AgentRequest::SchedulerTick {
                kind: SchedulerKind::Heartbeat
            }
        ) {
            let text = json_codec::utf16_units(&error.message);
            self.state("event.emit",json!({"type":"agent.event","data":{"type":"heartbeat-failed","message":json_codec::from_utf16_units(&text[..text.len().min(200)])}}))?;
        }
        Ok(())
    }
}
