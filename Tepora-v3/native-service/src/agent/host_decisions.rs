//! Actor-owned decision routes. Futures only infer or wait; every route update,
//! episode, withdrawal and delegated admission is committed by the FIFO host.
use super::{
    decisions::{self, DecisionBackend, DecisionFuture, Decisions, RouteRequest},
    EffectContext, EffectError, EffectResult, EffectScope, EffectTask,
};
use crate::{network::RequestCancellation, ApiError};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::watch;

pub struct UnavailableBackend;
impl DecisionBackend for UnavailableBackend {
    fn available(&self) -> bool {
        false
    }
    fn decide<'a>(
        &'a self,
        _: &'a Value,
        _: &'a Value,
        _: &'a RequestCancellation,
    ) -> DecisionFuture<'a> {
        Box::pin(async {
            Err(decisions::DecisionError::invalidated(
                "Decision route is unavailable",
            ))
        })
    }
}
struct Route {
    service: u64,
    epoch: u64,
    request: RouteRequest,
    binding: Value,
    cancel: RequestCancellation,
    answer: watch::Sender<Option<Option<f64>>>,
    held: bool,
    consumed: bool,
}
#[derive(Default)]
struct Memory {
    versions: HashMap<String, u64>,
    routes: HashMap<String, Route>,
}
pub struct DecisionHost {
    pub decisions: Arc<Decisions>,
    memory: Mutex<Memory>,
}
impl DecisionHost {
    pub fn new(decisions: Arc<Decisions>) -> Self {
        Self {
            decisions,
            memory: Mutex::new(Memory::default()),
        }
    }
    pub fn held(&self, id: &str) -> bool {
        self.memory
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .routes
            .get(id)
            .is_some_and(|r| r.held && !r.consumed)
    }
    pub fn prepare(
        &self,
        ctx: &EffectContext,
        session: &Value,
        settings: &Value,
        policy: &Value,
        inputs: &[Value],
    ) -> Result<Vec<Value>, ApiError> {
        let mut memory = self
            .memory
            .lock()
            .map_err(|_| ApiError::new(500, "Decision route owner unavailable"))?;
        let id = &ctx.scope.session_id;
        let mut command = None;
        for input in inputs {
            let from = input["from"].as_str().unwrap_or("");
            if input["passive"] == true
                || !(from == "user" || from.starts_with("voice"))
                || input["kind"] != "message"
            {
                continue;
            }
            let previous = *memory.versions.get(id).unwrap_or(&0);
            if let Some(request) = decisions::route_request(
                session,
                settings,
                input["text"].as_str().unwrap_or(""),
                input["seq"].as_u64().unwrap_or(0),
                policy,
                previous,
                self.decisions.available(),
            )? {
                let version = request.version;
                if let Some(old) = memory.routes.remove(id) {
                    old.cancel.cancel();
                }
                memory.versions.insert(id.clone(), version);
                let (answer, _) = watch::channel(None);
                memory.routes.insert(
                    id.clone(),
                    Route {
                        service: ctx.scope.service_id,
                        epoch: ctx.scope.run_epoch,
                        request,
                        binding: self.decisions.binding(),
                        cancel: RequestCancellation::new(),
                        answer,
                        held: true,
                        consumed: false,
                    },
                );
                command = Some(json!({"kind":"decisionRoute","routeVersion":version}));
            }
        }
        Ok(command.into_iter().collect())
    }
    pub fn auxiliary(
        &self,
        ctx: &EffectContext,
        command: &Value,
    ) -> Result<EffectTask, EffectError> {
        if command["kind"] != "decisionRoute" {
            return Err(EffectError::new("Unknown auxiliary decision command"));
        }
        let (request, route_cancel) = {
            let memory = self
                .memory
                .lock()
                .map_err(|_| EffectError::new("Decision route owner unavailable"))?;
            let Some(route) = memory
                .routes
                .get(&ctx.scope.session_id)
                .filter(|r| matches(r, &ctx.scope, command["routeVersion"].as_u64()))
            else {
                return Ok(EffectTask::ready(Value::Null));
            };
            (route.request.clone(), route.cancel.clone())
        };
        let decisions = self.decisions.clone();
        let cancel = ctx.cancellation.clone();
        Ok(EffectTask::Async(Box::pin(async move {
            let raw = tokio::select! {
                biased;
                _=cancel.cancelled()=>return Err(EffectError::cancelled(false)),
                _=route_cancel.cancelled()=>return Err(EffectError::cancelled(false)),
                value=decisions.yes(&request.state,request.question["text"].as_str().unwrap_or(""),&cancel)=>value.ok().flatten()
            };
            Ok(EffectResult::new(
                json!({"raw":raw,"routeVersion":request.version}),
            ))
        })))
    }
    pub fn complete(
        &self,
        ctx: &EffectContext,
        command: &Value,
        result: Result<EffectResult, EffectError>,
    ) -> Result<bool, ApiError> {
        let mut memory = self
            .memory
            .lock()
            .map_err(|_| ApiError::new(500, "Decision route owner unavailable"))?;
        let Some(route) = memory
            .routes
            .get_mut(&ctx.scope.session_id)
            .filter(|r| matches(r, &ctx.scope, command["routeVersion"].as_u64()))
        else {
            return Ok(false);
        };
        if route.cancel.is_cancelled() || ctx.cancellation.is_cancelled() {
            return Ok(false);
        }
        let raw = if route.binding == self.decisions.binding() {
            result.ok().and_then(|v| v.value["raw"].as_f64())
        } else { None };
        route.held = tepora_core::runtime::completion_verdict(&json!(raw), &route.request.question)
            ["accepted"]
            == true;
        route.answer.send_replace(Some(raw));
        Ok(true)
    }
    pub fn main_turn(&self, ctx: &EffectContext) -> Result<EffectTask, EffectError> {
        let (mut answer, version, route_cancel) = {
            let mut memory = self
                .memory
                .lock()
                .map_err(|_| EffectError::new("Decision route owner unavailable"))?;
            let Some(route) = memory
                .routes
                .get_mut(&ctx.scope.session_id)
                .filter(|r| matches(r, &ctx.scope, None) && !r.consumed)
            else {
                return Ok(EffectTask::ready(json!({"delegated":false})));
            };
            route.consumed = true;
            (
                route.answer.subscribe(),
                route.request.version,
                route.cancel.clone(),
            )
        };
        let cancel = ctx.cancellation.clone();
        Ok(EffectTask::Async(Box::pin(async move {
            loop {
                if cancel.is_cancelled() {
                    return Err(EffectError::cancelled(false));
                }
                let raw = *answer.borrow_and_update();
                if let Some(raw) = raw {
                    return Ok(EffectResult::new(json!({"routeVersion":version,"raw":raw})));
                }
                tokio::select! {
                    biased;
                    _=cancel.cancelled()=>return Err(EffectError::cancelled(false)),
                    _=route_cancel.cancelled()=>return Ok(EffectResult::new(json!({"delegated":false}))),
                    changed=answer.changed()=>if changed.is_err(){return Ok(EffectResult::new(json!({"delegated":false})));}
                }
            }
        })))
    }
    /// Called only from complete_effect after coordinator ownership validation.
    pub fn take(&self, scope: &EffectScope, version: Option<u64>) -> Option<RouteRequest> {
        let mut memory = self.memory.lock().unwrap_or_else(|p| p.into_inner());
        if version.is_none()
            || !memory
                .routes
                .get(&scope.session_id)
                .is_some_and(|r| matches(r, scope, version) && !r.cancel.is_cancelled() && r.binding == self.decisions.binding())
        {
            return None;
        }
        memory.routes.remove(&scope.session_id).map(|r| r.request)
    }
    pub fn completion(&self, ctx: &EffectContext, command: &Value) -> EffectTask {
        let decisions = self.decisions.clone();
        let binding = decisions.binding();
        let state = command["state"].clone();
        let q = command["q"]["text"].as_str().unwrap_or("").to_owned();
        let cancel = ctx.cancellation.clone();
        EffectTask::Async(Box::pin(async move {
            let raw = decisions.yes(&state, &q, &cancel).await;
            if cancel.is_cancelled() {
                return Err(EffectError::cancelled(false));
            }
            Ok(EffectResult::new(json!({"raw":raw.ok().flatten(),"binding":binding})))
        }))
    }
    pub fn cancel(&self, id: &str, epoch: Option<u64>) {
        let mut memory = self.memory.lock().unwrap_or_else(|p| p.into_inner());
        if memory
            .routes
            .get(id)
            .is_some_and(|r| epoch.is_none_or(|e| r.epoch == e))
        {
            if let Some(route) = memory.routes.remove(id) {
                route.cancel.cancel();
            }
        }
    }
    pub fn close(&self) {
        let mut memory = self.memory.lock().unwrap_or_else(|p| p.into_inner());
        for (_, route) in memory.routes.drain() {
            route.cancel.cancel();
        }
        self.decisions.close();
    }
}
fn matches(route: &Route, scope: &EffectScope, version: Option<u64>) -> bool {
    route.service == scope.service_id
        && route.epoch == scope.run_epoch
        && version.is_none_or(|v| route.request.version == v)
}
