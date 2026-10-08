//! Versioned interval callbacks enqueue ordinary requests on the owning actor.
use super::*;
use crate::agent::scheduler::timer::RecurringTimer;

impl Coordinator {
    pub(super) fn refresh_schedulers(&mut self, initialize: bool) -> Result<(), ApiError> {
        if self.closing {
            return Ok(());
        }
        let Some(policy) = guarded_api(|| self.host.scheduler_policy())? else {
            return Ok(());
        };
        if initialize {
            self.arm_recurring(
                SchedulerKind::Schedules,
                super::super::scheduler::SCHEDULE_PERIOD_MS,
                true,
            );
        }
        self.recurring.remove(&SchedulerKind::Heartbeat);
        // Configuration replaces both its timer and any in-flight old check-in.
        let mut cancelled = Vec::new();
        for (scope, admission) in &self.admissions {
            if matches!(
                admission.request,
                AgentRequest::SchedulerTick {
                    kind: SchedulerKind::Heartbeat
                }
            ) {
                if let Some(pending) = self.pending.get(scope) {
                    pending.context.cancellation.cancel();
                    if let Some(generation) = pending.command["heartbeatGeneration"].as_u64() {
                        cancelled.push(generation);
                    }
                }
            }
        }
        for generation in cancelled {
            guarded_api(|| self.host.retry_cancelled_heartbeat(generation))?;
        }
        if let Some(ms) = policy.heartbeat_ms {
            self.arm_recurring(SchedulerKind::Heartbeat, ms, false);
        }
        Ok(())
    }
    fn arm_recurring(&mut self, kind: SchedulerKind, millis: u64, immediate: bool) {
        self.recurring.remove(&kind);
        self.next_recurring += 1;
        let generation = self.next_recurring;
        let tx = self.shared.tx.clone();
        let service_id = self.service_id;
        let timer =
            RecurringTimer::start(&self.executor, generation, millis, immediate, move || {
                tx.send(Message::SchedulerTimer {
                    service_id,
                    kind,
                    generation,
                })
                .is_ok()
            });
        self.recurring.insert(kind, timer);
    }
    pub(super) fn scheduler_tick(&mut self, service_id: u64, kind: SchedulerKind, generation: u64) {
        if self.closing || service_id != self.service_id {
            return;
        }
        let Some(timer) = self
            .recurring
            .get(&kind)
            .filter(|timer| timer.generation == generation)
        else {
            return;
        };
        timer.acknowledge();
        self.shared.requests.fetch_add(1, Ordering::AcqRel);
        self.admit_request(AgentRequest::SchedulerTick { kind }, ResponseSender::Ignore);
    }
    pub(super) fn background_error(&mut self, request: &AgentRequest, error: &ApiError) {
        if !self.closing && matches!(request, AgentRequest::SchedulerTick { .. }) {
            if let Err(error) = guarded_api(|| self.host.background_error(request, error)) {
                self.fail(error);
            }
        }
    }
}
