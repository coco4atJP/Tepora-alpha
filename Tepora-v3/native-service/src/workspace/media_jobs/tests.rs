use super::*;
use crate::network::{
    Admitted, NetworkError, NetworkFuture, NetworkRequest, Resolver, Transport, TransportResponse,
};
use bytes::Bytes;
use std::collections::VecDeque;
#[derive(Default)]
struct Mock {
    replies: Mutex<VecDeque<Option<Result<(u16, Vec<u8>), NetworkError>>>>,
    requests: Mutex<Vec<NetworkRequest>>,
}
impl Resolver for Mock {
    fn lookup<'a>(&'a self, _: &'a str) -> NetworkFuture<'a, Vec<String>> {
        Box::pin(async { Ok(vec!["127.0.0.1".into()]) })
    }
}
impl Transport for Mock {
    fn request<'a>(
        &'a self,
        _: Admitted,
        request: NetworkRequest,
        cancel: RequestCancellation,
    ) -> NetworkFuture<'a, TransportResponse> {
        self.requests.lock().unwrap().push(request);
        let reply = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected fixture request");
        Box::pin(async move {
            let (status, bytes) = match reply {
                Some(v) => v?,
                None => return Err(cancel.cancelled().await),
            };
            Ok(TransportResponse {
                status,
                headers: hyper::HeaderMap::new(),
                body: Some(Box::pin(futures_util::stream::iter(vec![Ok(Bytes::from(
                    bytes,
                ))]))),
            })
        })
    }
}
impl Mock {
    fn json(&self, value: Value) {
        self.replies
            .lock()
            .unwrap()
            .push_back(Some(Ok((200, serde_json::to_vec(&value).unwrap()))));
    }
    fn raw(&self, bytes: Vec<u8>) {
        self.replies
            .lock()
            .unwrap()
            .push_back(Some(Ok((200, bytes))));
    }
    fn hold(&self) {
        self.replies.lock().unwrap().push_back(None);
    }
    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}
struct Fixture {
    w: Workspace,
    media: Arc<MediaJobs>,
    mock: Arc<Mock>,
    dir: PathBuf,
}
impl Fixture {
    fn new(kind: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("tepora-media-test-{}", Uuid::new_v4()));
        let w = Workspace::open(&dir).unwrap();
        let mock = Arc::new(Mock::default());
        let network = NativeNetwork::with_components(
            crate::network::NetworkPolicy::default(),
            mock.clone(),
            mock.clone(),
        );
        let caps = Capabilities::new(Arc::new(w.access()), network.clone());
        let protocol = match kind {
            "image" => "openai-images",
            "image_edit" => "openai-image-edit",
            "tts" => "openai-speech",
            _ => "xai-video",
        };
        caps.save(&json!({"profiles":[{"id":"fixture","name":"Synthetic local media","protocol":protocol,"baseUrl":"http://127.0.0.1:54321/v1","model":"synthetic","domain":"device","enabled":true,"maxParallel":2}],"routes":{kind:"fixture"}}),0).unwrap();
        let media =
            MediaJobs::new(w.access(), caps, network, tokio::runtime::Handle::current()).unwrap();
        Self {
            w,
            media,
            mock,
            dir,
        }
    }
    fn body(&self, kind: &str, id: &str) -> Value {
        json!({"kind":kind,"prompt":"synthetic test","requestId":id,"profileIdentity":self.media.capabilities.pin(kind).unwrap()["identity"],"consent":true})
    }
    async fn status(&self, id: &str, status: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let j = self.media.get(id).unwrap();
                if j["status"] == status {
                    return j;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("expected {status}; got {}", self.media.get(id).unwrap()))
    }
    async fn settled(&self) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if self.media.life.lock().unwrap().active.is_empty() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap();
    }
    async fn close(&self) {
        self.media.begin_close().unwrap();
        self.media.drain().await;
        self.w.shutdown().unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}
fn png() -> Vec<u8> {
    let mut b = vec![0; 24];
    b[..8].copy_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
    b
}
fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
#[test]
fn signatures_and_public_projection() {
    assert_eq!(media_type(&png()).unwrap(), "image/png");
    assert_eq!(media_type(&[255, 216, 255, 0]).unwrap(), "image/jpeg");
    assert_eq!(media_type(b"RIFF0000WEBP").unwrap(), "image/webp");
    assert_eq!(media_type(b"RIFF0000WAVE").unwrap(), "audio/wav");
    assert_eq!(media_type(b"ID3").unwrap(), "audio/mpeg");
    assert_eq!(media_type(b"0000ftyp00000").unwrap(), "video/mp4");
    assert_eq!(media_type(b"bad").unwrap_err().status, 502);
    let j = json!({"id":"x","status":"paused","remoteId":"remote","providerName":"mock","prompt":"private","profile":{"key":"private"},"providerMayContinue":true});
    let p = public(&j);
    assert_eq!(p["canResume"], true);
    assert_eq!(p["provider"], "mock");
    assert!(p.get("prompt").is_none());
    assert!(p.get("profile").is_none());
}
#[tokio::test]
async fn image_idempotency_bytes_events_and_cleanup() {
    let f = Fixture::new("image");
    f.mock.json(json!({"data":[{"b64_json":b64(&png())}]}));
    let body = f.body("image", "image-a");
    let job = f.media.create(&body).unwrap();
    let id = job["id"].as_str().unwrap();
    let ready = f.status(id, "ready").await;
    f.settled().await;
    assert_eq!(f.media.create(&body).unwrap()["id"], id);
    assert_eq!(f.mock.count(), 1);
    let mut changed = body.clone();
    changed["prompt"] = json!("other");
    assert_eq!(f.media.create(&changed).unwrap_err().status, 409);
    let asset = ready["asset"]["id"].as_str().unwrap();
    assert_eq!(f.media.read_asset(asset).unwrap().1, png());
    let path = f.dir.join("media").join(asset);
    assert!(path.exists());
    let events =
        f.w.lock()
            .unwrap()
            .call("event.replay", json!({"since":0}))
            .unwrap();
    let states = events
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["type"] == "media.updated")
        .map(|e| e["data"]["status"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(states, vec!["queued", "submitting", "ready"]);
    assert_eq!(f.media.remove(id).unwrap(), json!({"deleted":true}));
    assert!(!path.exists());
    assert!(f.media.snapshot().unwrap()["jobs"]
        .as_array()
        .unwrap()
        .is_empty());
    f.close().await;
}
#[tokio::test]
async fn consent_profile_options_and_admission_validation() {
    let f = Fixture::new("image");
    let mut body = f.body("image", "validation");
    body["consent"] = json!(false);
    assert_eq!(f.media.create(&body).unwrap_err().status, 403);
    body["consent"] = json!(true);
    body["profileIdentity"] = json!("stale");
    assert_eq!(f.media.create(&body).unwrap_err().status, 409);
    body = f.body("image", "validation");
    for options in [
        json!({"duration":0}),
        json!({"size":"tiny"}),
        json!({"aspectRatio":"bad"}),
        json!({"unknown":1}),
        Value::Null,
    ] {
        body["options"] = options;
        assert_eq!(f.media.create(&body).unwrap_err().status, 400);
    }
    body = f.body("image", "validation");
    body["inputId"] = json!("x");
    assert_eq!(f.media.create(&body).unwrap_err().status, 400);
    assert_eq!(f.mock.count(), 0);
    f.close().await;
}
#[tokio::test]
async fn uncertain_submit_is_never_replayed_cancel_drains() {
    let f = Fixture::new("image");
    f.mock
        .replies
        .lock()
        .unwrap()
        .push_back(Some(Err(NetworkError::transport("lost response"))));
    let j = f.media.create(&f.body("image", "lost")).unwrap();
    let id = j["id"].as_str().unwrap();
    f.status(id, "unknown").await;
    f.settled().await;
    assert_eq!(f.media.resume(id).unwrap_err().status, 409);
    assert_eq!(f.mock.count(), 1);
    f.mock.hold();
    let j = f.media.create(&f.body("image", "cancel")).unwrap();
    let id = j["id"].as_str().unwrap();
    f.status(id, "submitting").await;
    let stopped = f.media.cancel(id).unwrap();
    assert_eq!(stopped["status"], "cancelled");
    assert_eq!(stopped["providerMayContinue"], true);
    f.settled().await;
    assert_eq!(f.media.get(id).unwrap()["status"], "cancelled");
    f.media.remove(id).unwrap();
    f.close().await;
}
#[tokio::test]
async fn rejection_and_wrong_modality_remain_distinct() {
    let f = Fixture::new("image");
    f.mock
        .replies
        .lock()
        .unwrap()
        .push_back(Some(Ok((400, b"rejected".to_vec()))));
    let j = f.media.create(&f.body("image", "rejected")).unwrap();
    f.status(j["id"].as_str().unwrap(), "failed").await;
    f.mock.json(json!({"data":[{"b64_json":b64(b"ID3audio")}]}));
    let j = f.media.create(&f.body("image", "mismatch")).unwrap();
    let j = f.status(j["id"].as_str().unwrap(), "unknown").await;
    assert_eq!(j["providerMayContinue"], true);
    f.close().await;
}
#[tokio::test]
async fn two_slots_queue_limit_stop_all_and_close_persistence() {
    let f = Fixture::new("image");
    f.mock.hold();
    f.mock.hold();
    let mut ids = vec![];
    for n in 0..16 {
        ids.push(
            f.media
                .create(&f.body("image", &format!("job-{n}")))
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    assert_eq!(
        f.media
            .create(&f.body("image", "overflow"))
            .unwrap_err()
            .status,
        429
    );
    f.status(&ids[0], "submitting").await;
    f.status(&ids[1], "submitting").await;
    assert_eq!(f.mock.count(), 2);
    f.media.begin_close().unwrap();
    f.media.drain().await;
    assert_eq!(f.media.get(&ids[0]).unwrap()["status"], "unknown");
    let queued = f.media.get(&ids[2]).unwrap();
    assert_eq!(queued["status"], "paused");
    assert_eq!(queued["notSubmitted"], true);
    assert_eq!(public(&queued)["canResume"], true);
    assert_eq!(f.mock.count(), 2);
    f.w.shutdown().unwrap();
}
#[tokio::test]
async fn restart_preserves_remote_handles_and_unsent_queue() {
    let f = Fixture::new("video");
    let profile = f.media.capabilities.pin("video").unwrap();
    for (id, status, remote) in [
        ("one", "submitting", Value::Null),
        ("two", "queued", Value::Null),
        ("three", "running", json!("remote")),
    ] {
        f.w.lock()
            .unwrap()
            .put(
                "media-job",
                json!({"id":id,"status":status,"remoteId":remote,"profile":profile}),
            )
            .unwrap();
    }
    let restored = MediaJobs::new(
        f.w.access(),
        f.media.capabilities.clone(),
        f.media.network.clone(),
        tokio::runtime::Handle::current(),
    )
    .unwrap();
    assert_eq!(restored.get("one").unwrap()["status"], "unknown");
    assert_eq!(restored.get("two").unwrap()["notSubmitted"], true);
    assert_eq!(restored.get("three").unwrap()["status"], "paused");
    assert_eq!(restored.get("three").unwrap()["remoteId"], "remote");
    assert_eq!(f.mock.count(), 0);
    restored.begin_close().unwrap();
    restored.drain().await;
    f.close().await;
}
#[tokio::test]
async fn tts_and_image_edit_payloads_are_typed() {
    let f = Fixture::new("tts");
    f.mock.raw(b"ID3synthetic".to_vec());
    let job = f.media.create(&f.body("tts", "speech")).unwrap();
    let ready = f.status(job["id"].as_str().unwrap(), "ready").await;
    assert_eq!(ready["asset"]["mime"], "audio/mpeg");
    f.close().await;
    let f = Fixture::new("image_edit");
    let bytes = png();
    f.w.lock().unwrap().put("input-file",json!({"id":"input","kind":"image","mime":"image/png","base64":b64(&bytes),"sha256":hash(&bytes)})).unwrap();
    let mut body = f.body("image_edit", "edit");
    body["inputId"] = json!("input");
    f.mock.json(json!({"data":[{"b64_json":b64(&bytes)}]}));
    let job = f.media.create(&body).unwrap();
    f.status(job["id"].as_str().unwrap(), "ready").await;
    let request = &f.mock.requests.lock().unwrap()[0];
    assert!(String::from_utf8_lossy(&request.body).contains("name=\"image[]\""));
    f.close().await;
}
#[tokio::test]
async fn video_polling_resume_download_integrity_and_timer_stop() {
    let mut f = Fixture::new("video");
    Arc::get_mut(&mut f.media).unwrap().poll_ms = 10;
    f.mock.json(json!({"request_id":"remote"}));
    f.mock.json(json!({"status":"pending"}));
    f.mock
        .json(json!({"status":"done","video":{"url":"http://127.0.0.1:54321/v1/asset"}}));
    f.mock.raw(b"0000ftyp00000".to_vec());
    let job = f.media.create(&f.body("video", "movie")).unwrap();
    let ready = f.status(job["id"].as_str().unwrap(), "ready").await;
    assert_eq!(f.mock.count(), 4);
    assert_eq!(ready["remoteId"], "remote");
    assert_eq!(ready["asset"]["mime"], "video/mp4");
    let asset = ready["asset"]["id"].as_str().unwrap();
    fs::write(f.dir.join("media").join(asset), b"0000ftyp99999").unwrap();
    assert_eq!(f.media.read_asset(asset).unwrap_err().status, 409);
    f.close().await;
}
#[tokio::test]
async fn resume_download_never_recreates_paid_job_and_rechecks_profile() {
    let f = Fixture::new("image");
    f.mock
        .json(json!({"data":[{"url":"http://127.0.0.1:54321/v1/image"}]}));
    f.mock
        .replies
        .lock()
        .unwrap()
        .push_back(Some(Err(NetworkError::transport("download interrupted"))));
    let j = f.media.create(&f.body("image", "download")).unwrap();
    let id = j["id"].as_str().unwrap();
    let paused = f.status(id, "paused").await;
    f.settled().await;
    assert_eq!(public(&paused)["canResume"], true);
    assert_eq!(f.mock.count(), 2);
    f.mock.raw(png());
    f.media.resume(id).unwrap();
    let ready = f.status(id, "ready").await;
    assert_eq!(ready["downloadUrl"], Value::Null);
    assert_eq!(f.mock.count(), 3);
    assert_eq!(
        f.mock
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.method == hyper::Method::POST)
            .count(),
        1
    );
    f.close().await;
}
#[tokio::test]
async fn startup_unsent_resume_and_stop_all_do_not_resubmit_accepted_jobs() {
    let f = Fixture::new("image");
    let mut j = json!({"id":"saved-unsent","status":"paused","notSubmitted":true,"kind":"image","prompt":"synthetic","options":{},"profile":f.media.capabilities.pin("image").unwrap(),"model":"synthetic","jobId":null,"title":"Synthetic"});
    f.w.lock().unwrap().put("media-job", j.clone()).unwrap();
    f.mock.json(json!({"data":[{"b64_json":b64(&png())}]}));
    f.media.resume("saved-unsent").unwrap();
    f.status("saved-unsent", "ready").await;
    assert_eq!(f.mock.count(), 1);
    j["id"] = json!("stale");
    j["profile"]["identity"] = json!("changed");
    f.w.lock().unwrap().put("media-job", j).unwrap();
    assert_eq!(f.media.resume("stale").unwrap_err().status, 409);
    f.mock.hold();
    let j = f.media.create(&f.body("image", "stopped")).unwrap();
    let id = j["id"].as_str().unwrap();
    f.status(id, "submitting").await;
    f.media.stop_all().unwrap();
    f.settled().await;
    assert_eq!(f.media.get(id).unwrap()["status"], "cancelled");
    f.close().await;
}
#[tokio::test]
async fn stale_input_and_local_quota_do_not_publish_assets() {
    let f = Fixture::new("image_edit");
    let bytes = png();
    let d = json!({"id":"input","kind":"image","mime":"image/png","base64":b64(&bytes),"sha256":hash(&bytes)});
    f.w.lock().unwrap().put("input-file", d.clone()).unwrap();
    // Hold both lifecycle slots so the third input is changed before dispatch.
    for n in 0..2 {
        f.mock.hold();
        let mut body = f.body("image_edit", &format!("hold-{n}"));
        body["inputId"] = json!("input");
        f.media.create(&body).unwrap();
    }
    let mut body = f.body("image_edit", "stale-input");
    body["inputId"] = json!("input");
    let j = f.media.create(&body).unwrap();
    let mut changed = d;
    changed["revoked"] = json!(true);
    f.w.lock().unwrap().put("input-file", changed).unwrap();
    // The already queued source remains independently owned; stopping the first
    // jobs frees slots and then verifies the pinned image before submission.
    for n in 0..2 {
        f.media
            .cancel(&hash(format!("user:hold-{n}").as_bytes()))
            .unwrap();
    }
    f.status(j["id"].as_str().unwrap(), "failed").await;
    assert!(f.w.lock().unwrap().list("media-asset").unwrap().is_empty());
    f.close().await;
    let f = Fixture::new("image");
    f.w.lock()
        .unwrap()
        .put(
            "media-asset",
            json!({"id":"synthetic-budget","bytes":512*1024*1024}),
        )
        .unwrap();
    f.mock.json(json!({"data":[{"b64_json":b64(&png())}]}));
    let j = f.media.create(&f.body("image", "quota")).unwrap();
    f.status(j["id"].as_str().unwrap(), "unknown").await;
    assert_eq!(f.w.lock().unwrap().list("media-asset").unwrap().len(), 1);
    f.close().await;
}
#[tokio::test]
async fn video_cancel_and_close_own_pending_poll_timers() {
    for close in [false, true] {
        let mut f = Fixture::new("video");
        Arc::get_mut(&mut f.media).unwrap().poll_ms = 2000;
        f.mock.json(json!({"request_id":"retained-remote"}));
        let created = f.media.create(&f.body("video", "timer")).unwrap();
        let id = created["id"].as_str().unwrap();
        f.status(id, "running").await;
        f.settled().await;
        assert_eq!(f.media.life.lock().unwrap().timers.len(), 1);
        if close {
            f.media.begin_close().unwrap();
            f.media.drain().await;
        } else {
            f.media.cancel(id).unwrap();
        }
        tokio::time::sleep(Duration::from_millis(2100)).await;
        assert_eq!(f.mock.count(), 1);
        assert_eq!(
            f.media.get(id).unwrap()["status"],
            if close { "paused" } else { "cancelled" }
        );
        assert!(f.media.life.lock().unwrap().timers.is_empty());
        f.close().await;
    }
}
