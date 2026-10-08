use super::*;
use crate::network::{Admitted, NetworkFuture, Resolver, Transport, TransportResponse};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Default)]
struct Worker {
    calls: Mutex<Vec<(String, Value)>>,
    delay: Mutex<Option<String>>,
    entered: AtomicUsize,
    bad: Mutex<Option<Value>>,
}
impl Resolver for Worker {
    fn lookup<'a>(&'a self, _: &'a str) -> NetworkFuture<'a, Vec<String>> {
        Box::pin(async { panic!("Loopback must not resolve DNS") })
    }
}
impl Transport for Worker {
    fn request<'a>(
        &'a self,
        a: Admitted,
        r: NetworkRequest,
        c: RequestCancellation,
    ) -> NetworkFuture<'a, TransportResponse> {
        Box::pin(async move {
            assert!(a.address.is_loopback());
            let route = a.url.path().to_owned();
            let body: Value = serde_json::from_slice(&r.body).unwrap();
            self.calls.lock().unwrap().push((route.clone(), body));
            let delay = self.delay.lock().unwrap().as_ref() == Some(&route);
            if delay {
                self.entered.fetch_add(1, Ordering::SeqCst);
                return Err(c.cancelled().await);
            }
            let v = self
                .bad
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| match route.as_str() {
                    "/api/start" => json!({"session_id":"worker-id"}),
                    "/api/chunk" => json!({"text":"partial"}),
                    "/api/finish" => json!({"text":"final text"}),
                    "/api/cancel" => json!({"cancelled":true}),
                    _ => panic!("unexpected route"),
                });
            Ok(TransportResponse {
                status: 200,
                headers: Default::default(),
                body: Some(Box::pin(futures_util::stream::once(async move {
                    Ok(serde_json::to_vec(&v).unwrap().into())
                }))),
            })
        })
    }
}
struct Fixture {
    speech: Arc<SpeechStream>,
    worker: Arc<Worker>,
    _runtime: tokio::runtime::Runtime,
}
impl Fixture {
    fn new() -> Self {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let worker = Arc::new(Worker::default());
        let network =
            NativeNetwork::with_components(Default::default(), worker.clone(), worker.clone());
        Self {
            speech: SpeechStream::new(network, runtime.handle().clone()),
            worker,
            _runtime: runtime,
        }
    }
    fn start(&self) -> Value {
        self.speech
            .start(&json!({"voiceEnabled":true,"asrStreamUrl":"http://127.0.0.1:8756"}))
            .unwrap()
    }
}
fn pcm(samples: usize) -> String {
    STANDARD.encode(vec![0u8; samples * 4])
}
#[test]
fn ordered_retry_finish_cancel_contract() {
    let f = Fixture::new();
    let s = f.start();
    let id = &s["id"];
    assert_eq!(s["sampleRate"], 16000);
    assert_eq!(s["maxAudioSeconds"], 120);
    assert_eq!(
        f.speech
            .start(&json!({"asrStreamUrl":"http://localhost:8756"}))
            .unwrap_err()
            .status,
        409
    );
    let b = json!({"id":id,"sequence":0,"pcm":pcm(3200)});
    let first = f.speech.chunk(&b).unwrap();
    assert_eq!(first["text"], "partial");
    assert_eq!(first["final"], false);
    assert_eq!(f.speech.chunk(&b).unwrap(), first);
    assert_eq!(f.worker.calls.lock().unwrap().len(), 2);
    assert_eq!(
        f.speech
            .chunk(&json!({"id":id,"sequence":0,"pcm":pcm(1)}))
            .unwrap_err()
            .status,
        409
    );
    assert_eq!(
        f.speech
            .chunk(&json!({"id":id,"sequence":2,"pcm":pcm(1)}))
            .unwrap_err()
            .status,
        409
    );
    let done = f.speech.finish(&json!({"id":id})).unwrap();
    assert_eq!(done["text"], "final text");
    assert_eq!(done["submitted"], false);
    assert_eq!(f.speech.finish(&json!({"id":id})).unwrap_err().status, 409);
    assert_eq!(
        f.speech.cancel(Some("missing"), false).unwrap(),
        json!({"cancelled":true})
    );
    let s = f.start();
    f.speech.cancel(s["id"].as_str(), false).unwrap();
    assert_eq!(
        f.worker.calls.lock().unwrap().last().unwrap().0,
        "/api/cancel"
    );
}
#[test]
fn validation_budget_and_worker_failure() {
    let f = Fixture::new();
    assert_eq!(
        f.speech
            .start(&json!({"voiceEnabled":false}))
            .unwrap_err()
            .status,
        403
    );
    let s = f.start();
    let id = &s["id"];
    for b in [
        json!({"sequence":-1,"pcm":pcm(1)}),
        json!({"sequence":0.5,"pcm":pcm(1)}),
        json!({"sequence":0,"pcm":"%%%%"}),
        json!({"sequence":0,"pcm":STANDARD.encode([1u8,2,3])}),
        json!({"sequence":0,"pcm":STANDARD.encode(f32::NAN.to_le_bytes())}),
        json!({"sequence":0,"pcm":STANDARD.encode(1.1f32.to_le_bytes())}),
        json!({"sequence":0,"pcm":pcm(16001)}),
    ] {
        let mut b = b;
        b["id"] = id.clone();
        assert_eq!(f.speech.chunk(&b).unwrap_err().status, 400);
    }
    *f.worker.bad.lock().unwrap() = Some(json!({"text":false}));
    let b = json!({"id":id,"sequence":0,"pcm":pcm(16000)});
    assert_eq!(f.speech.chunk(&b).unwrap_err().status, 502);
    for n in 0..120 {
        f.speech
            .chunk(&json!({"id":id,"sequence":n,"pcm":pcm(16000)}))
            .unwrap();
    }
    assert_eq!(
        f.speech
            .chunk(&json!({"id":id,"sequence":120,"pcm":pcm(1)}))
            .unwrap_err()
            .status,
        413
    );
    *f.worker.bad.lock().unwrap() = Some(json!({"text":null}));
    assert_eq!(f.speech.finish(&json!({"id":id})).unwrap_err().status, 502);
    assert!(f.speech.life.lock().unwrap().session.is_none());
}
#[test]
fn stop_and_close_drain_start_chunk_finish_without_resurrection() {
    for route in ["/api/start", "/api/chunk", "/api/finish"] {
        for close in [false, true] {
            let f = Fixture::new();
            let s = if route != "/api/start" {
                f.start()
            } else {
                Value::Null
            };
            *f.worker.delay.lock().unwrap() = Some(route.into());
            let speech = f.speech.clone();
            let route = route.to_owned();
            let task = std::thread::spawn(move || match route.as_str() {
                "/api/start" => speech.start(&json!({"asrStreamUrl":"http://127.0.0.1:8756"})),
                "/api/chunk" => speech.chunk(&json!({"id":s["id"],"sequence":0,"pcm":pcm(1)})),
                _ => speech.finish(&json!({"id":s["id"]})),
            });
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while f.worker.entered.load(Ordering::SeqCst) == 0 {
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
            f.speech.cancel(None, close).unwrap();
            assert_eq!(task.join().unwrap().unwrap_err().status, 499);
            {
                let life = f.speech.life.lock().unwrap();
                assert!(life.session.is_none());
                assert_eq!(life.active, 0);
            }
            *f.worker.delay.lock().unwrap() = None;
            let next = f
                .speech
                .start(&json!({"asrStreamUrl":"http://127.0.0.1:8756"}));
            if close {
                assert_eq!(next.unwrap_err().status, 503)
            } else {
                assert!(next.is_ok());
                f.speech.cancel(None, true).unwrap();
            }
        }
    }
}
#[test]
fn concurrent_chunk_finish_are_rejected() {
    let f = Fixture::new();
    let s = f.start();
    *f.worker.delay.lock().unwrap() = Some("/api/chunk".into());
    let speech = f.speech.clone();
    let id = s["id"].clone();
    let b = json!({"id":id,"sequence":0,"pcm":pcm(1)});
    let other = b.clone();
    let task = std::thread::spawn(move || speech.chunk(&b));
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while f.worker.entered.load(Ordering::SeqCst) == 0 {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(f.speech.chunk(&other).unwrap_err().status, 409);
    assert_eq!(f.speech.finish(&json!({"id":id})).unwrap_err().status, 409);
    f.speech.cancel(Some(id.as_str().unwrap()), false).unwrap();
    assert_eq!(task.join().unwrap().unwrap_err().status, 499);
}

#[test]
fn session_timer_cancels_and_releases_slot() {
    let mut f = Fixture::new();
    Arc::get_mut(&mut f.speech).unwrap().ttl = Duration::from_millis(30);
    f.start();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        {
            let life = f.speech.life.lock().unwrap();
            if life.session.is_none() && !life.stopping {
                break;
            }
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(
        f.worker.calls.lock().unwrap().last().unwrap().0,
        "/api/cancel"
    );
    f.start();
    f.speech.cancel(None, true).unwrap();
}

#[test]
fn overlapping_stop_barriers_signal_before_drain_and_hold_admission() {
    let f = Fixture::new();
    let s = f.start();
    *f.worker.delay.lock().unwrap() = Some("/api/chunk".into());
    let speech = f.speech.clone();
    let pending =
        std::thread::spawn(move || speech.chunk(&json!({"id":s["id"],"sequence":0,"pcm":pcm(1)})));
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while f.worker.entered.load(Ordering::SeqCst) == 0 {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    let first = f.speech.stop_barrier(false).unwrap();
    let second = f.speech.stop_barrier(false).unwrap();
    // Local transport is already cancelled while both drains are deferred.
    while !pending.is_finished() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(pending.join().unwrap().unwrap_err().status, 499);
    drop(first);
    assert_eq!(
        f.speech
            .start(&json!({"asrStreamUrl":"http://127.0.0.1:8756"}))
            .unwrap_err()
            .status,
        503
    );
    drop(second);
    f.start();
    f.speech.cancel(None, true).unwrap();
}
