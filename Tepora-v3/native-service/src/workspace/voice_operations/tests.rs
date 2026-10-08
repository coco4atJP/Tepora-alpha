use super::*;
use crate::{
    network::{Admitted, NetworkFuture, Resolver, Transport, TransportResponse},
    provider::ProviderState,
};
use std::sync::atomic::{AtomicUsize, Ordering};
#[derive(Default)]
struct State;
impl ProviderState for State {
    fn value(&self, _: &str) -> Result<Option<Value>, ApiError> {
        Ok(None)
    }
    fn set_value(&self, _: &str, _: Value) -> Result<(), ApiError> {
        Ok(())
    }
    fn get(&self, _: &str, _: &str) -> Result<Option<Value>, ApiError> {
        Ok(None)
    }
    fn put(&self, _: &str, _: Value) -> Result<(), ApiError> {
        Ok(())
    }
    fn emit(&self, _: &str, _: Value) -> Result<(), ApiError> {
        Ok(())
    }
}
#[derive(Default)]
struct Mock {
    entered: AtomicUsize,
    hold: Mutex<bool>,
    text: Mutex<Value>,
}
impl Resolver for Mock {
    fn lookup<'a>(&'a self, _: &'a str) -> NetworkFuture<'a, Vec<String>> {
        Box::pin(async { panic!("Loopback must not need DNS") })
    }
}
impl Transport for Mock {
    fn request<'a>(
        &'a self,
        a: Admitted,
        _: NetworkRequest,
        cancel: RequestCancellation,
    ) -> NetworkFuture<'a, TransportResponse> {
        Box::pin(async move {
            assert!(a.address.is_loopback());
            self.entered.fetch_add(1, Ordering::SeqCst);
            if *self.hold.lock().unwrap() {
                return Err(cancel.cancelled().await);
            }
            let body = json_codec::stringify_js(&self.text.lock().unwrap()).unwrap();
            Ok(TransportResponse {
                status: 200,
                headers: Default::default(),
                body: Some(Box::pin(futures_util::stream::once(async move {
                    Ok(body.into())
                }))),
            })
        })
    }
}
fn fixture() -> (Arc<VoiceOperations>, Arc<Mock>) {
    let mock = Arc::new(Mock::default());
    let network = NativeNetwork::with_components(Default::default(), mock.clone(), mock.clone());
    let provider = ProviderRuntime::new(Arc::new(State), network.clone());
    (Arc::new(VoiceOperations::new(provider, network)), mock)
}
fn input(draft: Value) -> Value {
    json!({"draft":draft,"spoken":"  replace  ","utteranceId":" id ","baseRevision":1})
}
fn answer(args: Value) -> Value {
    json!({"tool_calls":[{"function":{"name":"propose_draft_edit","arguments":json_codec::encode_text(&json_codec::stringify_js(&args).unwrap())}}]})
}
#[test]
fn exact_utf16_proposals_preserve_split_surrogates_and_literal_markers() {
    let input = input(json_codec::parse(r#""a😀\ue000\ud800z""#).unwrap());
    let request = edit_request(vec![], &input).unwrap();
    assert_eq!(
        json_codec::parse_js_text(request.messages[1]["content"].as_str().unwrap()).unwrap()
            ["selection"],
        json!({"start":6,"end":6})
    );
    let args = json_codec::parse(r#"{"start":1,"end":2,"expectedText":"\ud83d","replacement":"\ud800\ue000","summary":"ok"}"#).unwrap();
    let result = edit_result(&input, &answer(args)).unwrap();
    assert_eq!(
        json_codec::utf16_units(result["preview"].as_str().unwrap()),
        [0x61, 0xd800, 0xe000, 0xde00, 0xe000, 0xd800, 0x7a]
    );
    assert_eq!(result["utteranceId"], " id ");
    assert_eq!(result["execution"], false);
    let summary = json_codec::from_utf16_units(&vec![0xd800; 241]);
    let result = edit_result(
        &input,
        &answer(json!({"start":0,"end":0,"expectedText":"","replacement":"","summary":summary})),
    )
    .unwrap();
    assert_eq!(
        json_codec::utf16_units(result["summary"].as_str().unwrap()).len(),
        240
    );
}
#[test]
fn source_validation_statuses_and_javascript_whitespace() {
    let valid = input(json!("draft"));
    for (field, value, message) in [
        ("draft", json!(false), "Invalid draft"),
        (
            "spoken",
            json!("\u{feff}\u{a0}"),
            "spoken text: 1–8000 characters required",
        ),
        (
            "utteranceId",
            json!(""),
            "utterance id: 1–200 characters required",
        ),
        ("baseRevision", json!(-1), "Invalid draft revision"),
        (
            "selection",
            json!({"start":4,"end":3}),
            "Invalid text selection",
        ),
    ] {
        let mut body = valid.clone();
        body[field] = value;
        let e = edit_request(vec![], &body).unwrap_err();
        assert_eq!((e.status, e.message), (400, message.into()));
    }
    let mut body = valid.clone();
    body["spoken"] = json!("\u{85}");
    edit_request(vec![], &body).unwrap(); // not JavaScript trim whitespace
    body["baseRevision"] = json!(1e20);
    edit_request(vec![], &body).unwrap();
    for (args, status, message) in [
        (json!({"start":-1,"end":0}), 422, "Invalid edit range"),
        (
            json!({"start":0,"end":1,"expectedText":"wrong"}),
            409,
            "The edit did not match its original text",
        ),
        (
            json!({"start":0,"end":0,"expectedText":"","replacement":false}),
            413,
            "Replacement exceeds draft budget",
        ),
    ] {
        let e = edit_result(&valid, &answer(args)).unwrap_err();
        assert_eq!((e.status, e.message), (status, message.into()));
    }
    let e = edit_result(
        &valid,
        &json!({"tool_calls":[{"function":{"name":"propose_draft_edit","arguments":"{"}}]}),
    )
    .unwrap_err();
    assert_eq!((e.status, e.message), (500, "Invalid edit JSON".into()));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn transcription_budget_deadline_and_request_drop() {
    let (voice, mock) = fixture();
    let settings = json!({"asrUrl":"http://127.0.0.1:8756","asrModel":"synthetic"});
    *mock.text.lock().unwrap() = json!({"text":"語😀"});
    assert_eq!(
        voice
            .transcribe(&settings, vec![0; 32], RequestCancellation::new())
            .await
            .unwrap()["text"],
        "語😀"
    );
    *mock.text.lock().unwrap() = json!({"text":"x".repeat(32_001)});
    assert_eq!(
        voice
            .transcribe(&settings, vec![], RequestCancellation::new())
            .await
            .unwrap_err()
            .status,
        413
    );
    *mock.text.lock().unwrap() = json!({"text":"ok","extra":"x".repeat(RESPONSE_BYTES)});
    let error = voice
        .transcribe(&settings, vec![], RequestCancellation::new())
        .await
        .unwrap_err();
    assert_eq!(
        (error.status, error.message),
        (502, "Response exceeds budget".into())
    );
    *mock.text.lock().unwrap() = json!({"text":false});
    let e = voice
        .transcribe(&settings, vec![], RequestCancellation::new())
        .await
        .unwrap_err();
    assert_eq!(
        (e.status, e.message),
        (502, "ASR did not return text".into())
    );
    *mock.hold.lock().unwrap() = true;
    let before = mock.entered.load(Ordering::SeqCst);
    let owner = voice.clone();
    let s = settings.clone();
    let task = tokio::spawn(async move {
        owner
            .transcribe(&s, vec![], RequestCancellation::new())
            .await
    });
    while mock.entered.load(Ordering::SeqCst) == before {
        tokio::task::yield_now().await;
    }
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(voice.life.lock().unwrap().active.is_empty());
    let (mut short, mock) = fixture();
    Arc::get_mut(&mut short).unwrap().asr_timeout = Duration::from_millis(20);
    *mock.hold.lock().unwrap() = true;
    assert_eq!(
        short
            .transcribe(&settings, vec![], RequestCancellation::new())
            .await
            .unwrap_err()
            .status,
        500
    );
    assert!(short.life.lock().unwrap().active.is_empty());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn overlapping_barriers_close_admission_and_drain_without_late_success() {
    let (voice, mock) = fixture();
    *mock.hold.lock().unwrap() = true;
    let owner = voice.clone();
    let task = tokio::spawn(async move {
        owner
            .transcribe(
                &json!({"asrUrl":"http://127.0.0.1:8756"}),
                vec![],
                RequestCancellation::new(),
            )
            .await
    });
    while mock.entered.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    let barrier = voice.stop_barrier(false).unwrap();
    let second = voice.stop_barrier(false).unwrap();
    assert_eq!(
        voice
            .admit(true, RequestCancellation::new())
            .err()
            .unwrap()
            .status,
        503
    );
    assert_eq!(task.await.unwrap().unwrap_err().status, 499);
    drop(barrier);
    assert_eq!(
        voice
            .admit(true, RequestCancellation::new())
            .err()
            .unwrap()
            .status,
        503
    );
    drop(second);
    let flight = voice.admit(true, RequestCancellation::new()).unwrap();
    assert_eq!(
        voice
            .admit(true, RequestCancellation::new())
            .err()
            .unwrap()
            .status,
        429
    );
    let barrier = voice.stop_barrier(true).unwrap();
    assert_eq!(
        voice
            .complete(&flight, Ok(json!({"preview":"late"})))
            .unwrap_err()
            .status,
        499
    );
    drop(flight);
    drop(barrier);
    assert_eq!(
        voice
            .admit(false, RequestCancellation::new())
            .err()
            .unwrap()
            .status,
        503
    );
}
#[test]
fn multipart_contains_exact_audio_and_usv_normalized_model() {
    let bytes = multipart("fixture", &[0, 1, 255], &json!("model\r\nname\n"));
    assert!(bytes.windows(3).any(|b| b == [0, 1, 255]));
    let text = String::from_utf8_lossy(&bytes);
    for part in [
        "filename=\"recording.wav\"",
        "Content-Type: audio/wav",
        "name=\"language\"\r\n\r\nja",
        "name=\"response_format\"\r\n\r\njson",
        "model\r\nname\r\n",
    ] {
        assert!(text.contains(part));
    }
}

#[test]
fn bounded_transcription_admission_releases_each_flight() {
    let (voice, _) = fixture();
    let mut flights = Vec::new();
    for _ in 0..MAX_TRANSCRIPTIONS {
        flights.push(voice.admit(false, RequestCancellation::new()).unwrap());
    }
    let e = voice
        .admit(false, RequestCancellation::new())
        .err()
        .unwrap();
    assert_eq!(
        (e.status, e.message),
        (429, "Too many transcription requests".into())
    );
    // The edit singleton is independent of the bounded ASR set.
    let edit = voice.admit(true, RequestCancellation::new()).unwrap();
    drop(flights.pop());
    flights.push(voice.admit(false, RequestCancellation::new()).unwrap());
    drop(edit);
    drop(flights);
    assert!(voice.life.lock().unwrap().active.is_empty());
}
