use super::*;
use std::time::Instant;
use tokio::sync::oneshot;

#[derive(Default)]
struct Group {
    active: usize,
    limit: usize,
    reserve: usize,
    queue: Vec<Waiter>,
}
struct Waiter {
    id: u64,
    priority: f64,
    at: Instant,
    tx: oneshot::Sender<GateLease>,
}
#[derive(Default)]
struct GateState {
    groups: HashMap<String, Group>,
    next: u64,
    closed: bool,
}
#[derive(Clone, Default)]
pub struct ResourceGate {
    inner: Arc<Mutex<GateState>>,
}
pub struct GateLease {
    gate: ResourceGate,
    key: String,
    released: bool,
}
impl Drop for GateLease {
    fn drop(&mut self) {
        self.release();
    }
}
impl GateLease {
    pub fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let mut state = lock(&self.gate.inner);
        if let Some(group) = state.groups.get_mut(&self.key) {
            group.active = group.active.saturating_sub(1);
        }
        self.gate.drain(&mut state, &self.key);
    }
}
struct Waiting {
    gate: ResourceGate,
    key: String,
    id: u64,
}
impl Drop for Waiting {
    fn drop(&mut self) {
        let mut state = lock(&self.gate.inner);
        if let Some(group) = state.groups.get_mut(&self.key) {
            group.queue.retain(|e| e.id != self.id);
        }
        self.gate.drain(&mut state, &self.key);
    }
}
impl ResourceGate {
    pub async fn acquire(
        &self,
        key: &str,
        limit: usize,
        priority: f64,
        reserve: usize,
        cancel: &RequestCancellation,
    ) -> Result<GateLease, ProviderFailure> {
        check(cancel)?;
        let (tx, rx) = oneshot::channel();
        let id = {
            let mut state = lock(&self.inner);
            if state.closed {
                return Err(ProviderFailure::unavailable("Service closed", 30000));
            }
            state
                .groups
                .retain(|_, g| g.active > 0 || !g.queue.is_empty());
            let id = state.next;
            state.next = state.next.wrapping_add(1);
            let group = state.groups.entry(key.into()).or_default();
            group.limit = limit.max(1);
            group.reserve = reserve.min(group.limit - 1);
            if group.queue.len() >= 256 {
                return Err(
                    ProviderFailure::new("transient", "Inference queue is full").with_status(429)
                );
            }
            group.queue.push(Waiter {
                id,
                priority,
                at: Instant::now(),
                tx,
            });
            self.drain(&mut state, key);
            id
        };
        let _waiting = Waiting {
            gate: self.clone(),
            key: key.into(),
            id,
        };
        tokio::select! { biased;
            error = cancel.cancelled() => Err(error.into()),
            result = rx => result.map_err(|_| ProviderFailure::unavailable("Service closed",30000)),
        }
    }
    fn drain(&self, state: &mut GateState, key: &str) {
        let Some(group) = state.groups.get_mut(key) else {
            return;
        };
        while group.active < group.limit && !group.queue.is_empty() {
            group.queue.sort_by(|a, b| {
                let rank = |e: &Waiter| e.priority + (e.at.elapsed().as_secs_f64() / 2.).min(9.);
                rank(b).total_cmp(&rank(a)).then(a.id.cmp(&b.id))
            });
            let Some(index) = group
                .queue
                .iter()
                .position(|e| e.priority >= 10. || group.active < group.limit - group.reserve)
            else {
                break;
            };
            let entry = group.queue.remove(index);
            group.active += 1;
            let lease = GateLease {
                gate: self.clone(),
                key: key.into(),
                released: false,
            };
            if let Err(mut lease) = entry.tx.send(lease) {
                // Receiver cancellation must not Drop/reenter the mutex here.
                lease.released = true;
                group.active -= 1;
            }
        }
    }
    pub fn snapshot(&self) -> Value {
        let state = lock(&self.inner);
        let mut groups: Vec<_> = state.groups.iter().collect();
        groups.sort_by_key(|(key, _)| *key);
        json!(groups.into_iter().map(|(resource,g)| json!({"resource":resource,"active":g.active,"queued":g.queue.len(),"limit":g.limit})).collect::<Vec<_>>())
    }
    pub fn close(&self) {
        let mut state = lock(&self.inner);
        state.closed = true;
        for group in state.groups.values_mut() {
            group.queue.clear();
        }
    }
}

#[derive(Default)]
struct Slots {
    busy: std::collections::HashSet<usize>,
    last: Vec<(String, usize)>,
    urgent: Option<usize>,
}
#[derive(Clone, Default)]
pub struct SlotPool {
    inner: Arc<Mutex<HashMap<String, Slots>>>,
}
pub struct SlotLease {
    pool: SlotPool,
    resource: String,
    pub slot: usize,
}
impl Drop for SlotLease {
    fn drop(&mut self) {
        if let Some(state) = lock(&self.pool.inner).get_mut(&self.resource) {
            state.busy.remove(&self.slot);
        }
    }
}
impl SlotPool {
    pub fn acquire(
        &self,
        resource: &str,
        slots: usize,
        key: &str,
        urgent: bool,
    ) -> Option<SlotLease> {
        let mut state = lock(&self.inner);
        let state = state.entry(resource.into()).or_default();
        let previous = state
            .last
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, slot)| *slot)
            .filter(|slot| *slot < slots && !state.busy.contains(slot));
        let slot = previous
            .or_else(|| {
                (0..slots).find(|slot| {
                    !state.busy.contains(slot) && (urgent || Some(*slot) != state.urgent)
                })
            })
            .or_else(|| (0..slots).find(|slot| !state.busy.contains(slot)))?;
        state.busy.insert(slot);
        if urgent {
            state.urgent = Some(slot);
        }
        if !key.is_empty() {
            state.last.retain(|(k, _)| k != key);
            state.last.push((key.into(), slot));
            if state.last.len() > 500 {
                state.last.remove(0);
            }
        }
        Some(SlotLease {
            pool: self.clone(),
            resource: resource.into(),
            slot,
        })
    }
}
