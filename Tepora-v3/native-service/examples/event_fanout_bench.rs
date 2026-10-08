//! Synthetic live-channel fan-out benchmark. No database or user payloads.
//! cargo run --release --example event_fanout_bench -- baseline 10 100 200
//! Modes compare the old owned clone fan-out with immutable Arc fan-out.
use std::{
    alloc::{GlobalAlloc, Layout, System},
    hint::black_box,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Instant,
};
use tepora_native_service::ServiceEvent;
use tokio::sync::mpsc;
static COUNT: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);
struct Measured;
unsafe impl GlobalAlloc for Measured {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        COUNT.fetch_add(1, Ordering::Relaxed);
        BYTES.fetch_add(layout.size(), Ordering::Relaxed);
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        System.dealloc(p, layout)
    }
    unsafe fn realloc(&self, p: *mut u8, layout: Layout, n: usize) -> *mut u8 {
        COUNT.fetch_add(1, Ordering::Relaxed);
        BYTES.fetch_add(n, Ordering::Relaxed);
        System.realloc(p, layout, n)
    }
}
#[global_allocator]
static ALLOC: Measured = Measured;
fn consume(event: &ServiceEvent) {
    // Match HTTP framing's JSON work. All fixtures are public events.
    let wire = tepora_core::json_codec::stringify_js(&event.value()).unwrap();
    let prefix = event
        .seq
        .map(|seq| format!("id: {seq}\n"))
        .unwrap_or_default();
    black_box(format!("{prefix}data: {wire}\n\n"));
}
fn run<T>(
    event: &ServiceEvent,
    listeners: usize,
    iterations: usize,
    make: impl Fn(&ServiceEvent) -> T,
    view: impl Fn(&T) -> &ServiceEvent,
) where
    T: Clone,
{
    let mut channels = (0..listeners)
        .map(|_| mpsc::channel::<T>(64))
        .collect::<Vec<_>>();
    // Warm allocator and serializer before measuring.
    for _ in 0..10 {
        for _ in 0..listeners {
            consume(event)
        }
    }
    let mut durations = Vec::with_capacity(iterations);
    COUNT.store(0, Ordering::Relaxed);
    BYTES.store(0, Ordering::Relaxed);
    let start = Instant::now();
    for _ in 0..iterations {
        let begin = Instant::now();
        if !channels.is_empty() {
            let item = make(event);
            for (sender, _) in &channels {
                sender
                    .try_send(item.clone())
                    .unwrap_or_else(|_| panic!("unexpected full queue"));
            }
            for (_, receiver) in &mut channels {
                consume(view(&receiver.try_recv().unwrap()));
            }
        }
        durations.push(begin.elapsed().as_nanos());
    }
    let elapsed = start.elapsed();
    let count = COUNT.load(Ordering::Relaxed);
    let bytes = BYTES.load(Ordering::Relaxed);
    durations.sort_unstable();
    let rss = std::fs::read_to_string("/proc/self/status")
        .unwrap_or_default()
        .lines()
        .find(|l| l.starts_with("VmHWM:"))
        .unwrap_or("RSS unavailable")
        .to_owned();
    println!(
        "wall_ms={:.3} events_per_sec={:.1} p95_us={:.3} allocations={} allocated_bytes={} {}",
        elapsed.as_secs_f64() * 1000.,
        iterations as f64 / elapsed.as_secs_f64(),
        durations[iterations * 95 / 100] as f64 / 1000.,
        count,
        bytes,
        rss
    );
}
fn main() {
    let a = std::env::args().collect::<Vec<_>>();
    let mode = &a[1];
    let listeners = a[2].parse().unwrap();
    let history: usize = a[3].parse().unwrap();
    let iterations = a.get(4).map(|s| s.parse().unwrap()).unwrap_or(200);
    let entries=(0..history).map(|i|serde_json::json!({"id":format!("synthetic-{i}"),"role":"assistant","content":"synthetic immutable text ".repeat(16)})).collect::<Vec<_>>();
    let event = ServiceEvent {
        seq: Some(42),
        event_type: "session.updated".into(),
        data: serde_json::json!({"id":"synthetic-session","history":entries}),
        at: Some("2026-01-01T00:00:00Z".into()),
    };
    print!("mode={mode} listeners={listeners} history={history} iterations={iterations} ");
    if mode == "baseline" {
        run(&event, listeners, iterations, Clone::clone, |e| e)
    } else if mode == "shared" {
        run(
            &event,
            listeners,
            iterations,
            |e| Arc::new(e.clone()),
            |e| e,
        )
    } else {
        panic!("unknown mode")
    }
}
