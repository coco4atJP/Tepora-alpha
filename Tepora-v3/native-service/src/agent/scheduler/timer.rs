//! Bounded recurring wakeups. All state mutations remain on the FIFO actor.
use crate::network::RequestCancellation;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::{runtime::Handle, task::JoinHandle};

pub(crate) struct RecurringTimer {
    pub generation: u64,
    cancellation: RequestCancellation,
    queued: Arc<AtomicBool>,
    task: JoinHandle<()>,
}

impl RecurringTimer {
    /// Callback returns false when its receiving actor has gone away. The
    /// generation is captured by that callback and checked by the actor before
    /// acknowledging the wakeup, so replacement cannot revive stale ticks.
    pub fn start(
        executor: &Handle,
        generation: u64,
        millis: u64,
        immediate: bool,
        send: impl Fn() -> bool + Send + 'static,
    ) -> Self {
        let cancellation = RequestCancellation::new();
        let queued = Arc::new(AtomicBool::new(false));
        let cancel = cancellation.clone();
        let pending = queued.clone();
        // Match setInterval: the first regular wake is a complete period away.
        // Anchor before spawn so executor load doesn't extend the first period.
        let period = Duration::from_millis(millis.max(1));
        let first = tokio::time::Instant::now() + period;
        let task = executor.spawn(async move {
            if cancel.is_cancelled() {
                return;
            }
            if immediate {
                pending.store(true, Ordering::Release);
                if !send() {
                    return;
                }
            }
            let mut interval = tokio::time::interval_at(first, period);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! { biased;
                    _ = cancel.cancelled() => break,
                    _ = interval.tick() => {
                        // A stalled actor retains one wake, never one per tick.
                        if !pending.swap(true, Ordering::AcqRel) && !send() {
                            break;
                        }
                    }
                }
            }
        });
        Self {
            generation,
            cancellation,
            queued,
            task,
        }
    }

    pub fn acknowledge(&self) {
        self.queued.store(false, Ordering::Release);
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
    }
}

impl Drop for RecurringTimer {
    fn drop(&mut self) {
        self.cancel();
        // The task owns no external work. Aborting also promptly releases its
        // mailbox sender when shutdown happens before Tokio next polls it.
        self.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    async fn advance(ms: u64) {
        tokio::time::advance(Duration::from_millis(ms)).await;
        tokio::task::yield_now().await;
    }

    #[tokio::test(start_paused = true)]
    async fn immediate_tick_coalesces_until_actor_acknowledges() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let timer = RecurringTimer::start(&Handle::current(), 7, 15_000, true, move || {
            tx.send(7).is_ok()
        });
        assert_eq!(rx.recv().await, Some(7));
        assert_eq!(timer.generation, 7);
        advance(150_000).await;
        assert!(rx.try_recv().is_err());
        timer.acknowledge();
        advance(15_000).await;
        assert_eq!(rx.try_recv().unwrap(), 7);
        advance(150_000).await;
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn delayed_tick_cancellation_and_drop_release_sender() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let timer = RecurringTimer::start(&Handle::current(), 1, 15_000, false, move || {
            tx.send(1).is_ok()
        });
        advance(14_999).await;
        assert!(rx.try_recv().is_err());
        timer.cancel();
        advance(1).await;
        assert_eq!(rx.recv().await, None);
        assert!(timer.task.is_finished());
        drop(timer);

        let (tx, mut rx) = mpsc::unbounded_channel::<()>();
        let timer = RecurringTimer::start(&Handle::current(), 2, 15_000, true, move || {
            tx.send(()).is_ok()
        });
        drop(timer); // Before the immediate callback is ever polled.
        tokio::task::yield_now().await;
        assert_eq!(rx.recv().await, None);
    }

    #[tokio::test(start_paused = true)]
    async fn closed_receiver_stops_timer_without_busy_retry() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = calls.clone();
        let timer = RecurringTimer::start(&Handle::current(), 1, 1, false, move || {
            count.fetch_add(1, Ordering::SeqCst);
            false
        });
        advance(1).await;
        advance(1_000).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(timer.task.is_finished());
    }
}
