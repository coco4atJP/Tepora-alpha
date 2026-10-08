//! One bounded, ephemeral Float32 PCM session. No audio or text is persisted.
use super::*;
use crate::network::{NativeNetwork, NetworkRequest, NetworkScope, Purpose, RequestCancellation};
#[cfg(test)]
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use std::{sync::Condvar, time::Duration};

struct Session {
    id: String,
    base: String,
    upstream: Option<String>,
    cancel: RequestCancellation,
    timer: Option<tokio::task::AbortHandle>,
    busy: bool,
    next: u64,
    samples: usize,
    last: Option<(u64, String, Value)>,
}
#[derive(Default)]
struct Life {
    closed: bool,
    stopping: bool,
    active: usize,
    stop_barriers: usize,
    session: Option<Session>,
}
pub(super) struct SpeechStream {
    network: NativeNetwork,
    runtime: tokio::runtime::Handle,
    life: Mutex<Life>,
    drained: Condvar,
    ttl: Duration,
}
/// Invalidates immediately; scope exit drains after sibling owners are signalled.
/// Counted barriers keep admissions closed across overlapping Stop/close calls.
pub(super) struct StopBarrier<'a>(&'a SpeechStream);
impl Drop for StopBarrier<'_> {
    fn drop(&mut self) {
        let _ = self.0.cancel(None, false);
        let mut life = self.0.life.lock().unwrap_or_else(|e| e.into_inner());
        life.stop_barriers -= 1;
        self.0.drained.notify_all();
    }
}
struct Flight<'a>(&'a SpeechStream);
impl Drop for Flight<'_> {
    fn drop(&mut self) {
        let mut life = self.0.life.lock().unwrap_or_else(|e| e.into_inner());
        life.active -= 1;
        self.0.drained.notify_all();
    }
}
impl SpeechStream {
    pub(super) fn new(network: NativeNetwork, runtime: tokio::runtime::Handle) -> Arc<Self> {
        Arc::new(Self {
            network,
            runtime,
            life: Mutex::new(Life::default()),
            drained: Condvar::new(),
            ttl: Duration::from_secs(120),
        })
    }
    pub(super) fn stop_barrier(&self, close: bool) -> Result<StopBarrier<'_>, ApiError> {
        let mut life = self.life.lock().map_err(error)?;
        if close {
            life.closed = true;
        }
        life.stop_barriers += 1;
        if let Some(s) = &life.session {
            s.cancel.cancel();
        }
        Ok(StopBarrier(self))
    }
    fn upstream(
        &self,
        base: &str,
        route: &str,
        body: Value,
        cancel: RequestCancellation,
    ) -> Result<Value, ApiError> {
        self.runtime.block_on(async {
            let mut headers = hyper::HeaderMap::new();
            headers.insert(
                "content-type",
                hyper::header::HeaderValue::from_static("application/json"),
            );
            if let Ok(token) = env::var("TEPORA_SPEECH_TOKEN") {
                if !token.is_empty() {
                    headers.insert(
                        "authorization",
                        hyper::header::HeaderValue::from_str(&format!("Bearer {token}"))
                            .map_err(|_| ApiError::bad_request("Invalid speech token"))?,
                    );
                }
            }
            let response = self
                .network
                .request(
                    &format!("{base}{route}"),
                    NetworkRequest {
                        method: hyper::Method::POST,
                        headers,
                        body: serde_json::to_vec(&body).map_err(error)?.into(),
                        cancellation: Some(cancel),
                    },
                    NetworkScope {
                        purpose: Purpose::Worker,
                        timeout: Duration::from_secs(15),
                        max_bytes: 256_000,
                        max_request_bytes: Some(100_000),
                        ..Default::default()
                    },
                )
                .await?;
            require(
                (200..300).contains(&response.status),
                502,
                &format!("Local speech worker returned HTTP {}", response.status),
            )?;
            Ok(response.json(256_000).await?)
        })
    }
    pub(super) fn start(self: &Arc<Self>, settings: &Value) -> Result<Value, ApiError> {
        require(
            settings["voiceEnabled"] != false,
            403,
            "Microphone is disabled",
        )?;
        let base = settings["asrStreamUrl"]
            .as_str()
            .unwrap_or("")
            .trim_end_matches('/')
            .to_owned();
        // Same existing preference validator and network admission; no new policy.
        preferences::endpoint(&json!(base), false)?;
        let id = Uuid::new_v4().to_string();
        let cancel = RequestCancellation::new();
        {
            let mut life = self.life.lock().map_err(error)?;
            require(
                !life.closed && !life.stopping && life.stop_barriers == 0,
                503,
                "Service closing or stopping",
            )?;
            require(
                life.session.is_none(),
                409,
                "A microphone session is already active",
            )?;
            life.session = Some(Session {
                id: id.clone(),
                base: base.clone(),
                upstream: None,
                cancel: cancel.clone(),
                timer: None,
                busy: true,
                next: 0,
                samples: 0,
                last: None,
            });
            life.active += 1;
        }
        let _flight = Flight(self);
        let result = self.upstream(
            &base,
            "/api/start",
            json!({"sample_rate":16000}),
            cancel.clone(),
        );
        let mut life = self.life.lock().map_err(error)?;
        require(!cancel.is_cancelled(), 499, "Speech session cancelled")?;
        let result = result.and_then(|v| {
            require(
                v["session_id"]
                    .as_str()
                    .is_some_and(|s| json_codec::utf16_units(s).len() < 200),
                502,
                "Invalid speech session",
            )?;
            Ok(v)
        });
        match result {
            Err(e) => {
                life.session.take();
                Err(e)
            }
            Ok(v) => {
                let s = life
                    .session
                    .as_mut()
                    .ok_or_else(|| ApiError::new(499, "Speech session cancelled"))?;
                s.upstream = Some(v["session_id"].as_str().unwrap().into());
                s.busy = false;
                let weak = Arc::downgrade(self);
                let timer_id = id.clone();
                let ttl = self.ttl;
                s.timer = Some(
                    self.runtime
                        .spawn(async move {
                            tokio::time::sleep(ttl).await;
                            if let Some(this) = weak.upgrade() {
                                let _ = tokio::task::spawn_blocking(move || {
                                    this.cancel(Some(&timer_id), false)
                                })
                                .await;
                            }
                        })
                        .abort_handle(),
                );
                Ok(json!({"id":id,"sampleRate":16000,"chunkMs":200,"maxAudioSeconds":120}))
            }
        }
    }
    pub(super) fn chunk(&self, body: &Value) -> Result<Value, ApiError> {
        self.send(body, false)
    }
    pub(super) fn finish(&self, body: &Value) -> Result<Value, ApiError> {
        self.send(body, true)
    }
    fn send(&self, b: &Value, finish: bool) -> Result<Value, ApiError> {
        let id = b["id"].as_str().unwrap_or("");
        let (base, upstream, cancel, sequence, pcm, samples) = {
            let mut life = self.life.lock().map_err(error)?;
            let s = life
                .session
                .as_mut()
                .filter(|s| s.id == id && s.upstream.is_some())
                .ok_or_else(|| ApiError::new(409, "Speech session expired"))?;
            require(!s.cancel.is_cancelled(), 499, "Speech session cancelled")?;
            let mut sequence = 0;
            let mut pcm = String::new();
            let mut samples = 0;
            if !finish {
                sequence = safe_integer(&b["sequence"])
                    .filter(|n| *n >= 0)
                    .ok_or_else(|| ApiError::bad_request("Invalid audio sequence"))?
                    as u64;
                pcm = b["pcm"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 90000)
                    .ok_or_else(|| ApiError::bad_request("Invalid PCM"))?
                    .to_owned();
                if let Some((n, old, reply)) = &s.last {
                    if *n == sequence {
                        require(
                            *old == pcm,
                            409,
                            "Audio sequence reused with different content",
                        )?;
                        return Ok(reply.clone());
                    }
                }
                require(
                    sequence == s.next,
                    409,
                    "Out-of-order or concurrent audio chunk",
                )?;
                let engine = base64::engine::GeneralPurpose::new(
                    &base64::alphabet::STANDARD,
                    base64::engine::general_purpose::GeneralPurposeConfig::new()
                        .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
                        .with_decode_allow_trailing_bits(true),
                );
                let bytes = engine
                    .decode(&pcm)
                    .map_err(|_| ApiError::bad_request("Invalid PCM"))?;
                require(
                    !bytes.is_empty() && bytes.len() % 4 == 0 && bytes.len() <= 64000,
                    400,
                    "Use at most one second of Float32 PCM",
                )?;
                for b in bytes.chunks_exact(4) {
                    let n = f32::from_le_bytes(b.try_into().unwrap());
                    require(
                        n.is_finite() && n.abs() <= 1.01,
                        400,
                        "Invalid audio sample",
                    )?;
                }
                samples = bytes.len() / 4;
                require(
                    s.samples + samples <= 16000 * 120,
                    413,
                    "Speech session reached its two-minute budget",
                )?;
            }
            require(!s.busy, 409, "Out-of-order or concurrent audio chunk")?;
            s.busy = true;
            let values = (
                s.base.clone(),
                s.upstream.clone().unwrap(),
                s.cancel.clone(),
                sequence,
                pcm,
                samples,
            );
            life.active += 1;
            values
        };
        let _flight = Flight(self);
        let body = if finish {
            json!({"session_id":upstream})
        } else {
            json!({"session_id":upstream,"sequence":sequence,"pcm":pcm})
        };
        let result = self
            .upstream(
                &base,
                if finish { "/api/finish" } else { "/api/chunk" },
                body,
                cancel.clone(),
            )
            .and_then(|v| {
                require(
                    v["text"]
                        .as_str()
                        .is_some_and(|s| json_codec::utf16_units(s).len() <= 32000),
                    502,
                    "Invalid transcript",
                )?;
                Ok(v)
            });
        let mut life = self.life.lock().map_err(error)?;
        require(!cancel.is_cancelled(), 499, "Speech session cancelled")?;
        let s = life
            .session
            .as_mut()
            .filter(|s| s.id == id)
            .ok_or_else(|| ApiError::new(499, "Speech session cancelled"))?;
        if finish {
            if let Some(timer) = s.timer.take() {
                timer.abort();
            }
            life.session.take();
            result.map(|v| json!({"id":id,"text":v["text"],"final":true,"submitted":false}))
        } else {
            s.busy = false;
            let result = result?;
            let reply = json!({"id":id,"sequence":sequence,"text":result["text"],"final":false});
            s.samples += samples;
            s.next += 1;
            s.last = Some((sequence, pcm, reply.clone()));
            Ok(reply)
        }
    }
    /// Invalidate before draining, so a late worker result cannot resurrect state.
    /// A stop gate also prevents a new session from entering during cleanup.
    pub(super) fn cancel(&self, id: Option<&str>, close: bool) -> Result<Value, ApiError> {
        let mut life = self.life.lock().map_err(error)?;
        while life.stopping {
            life = self.drained.wait(life).map_err(error)?;
        }
        if close {
            life.closed = true;
        }
        if id.is_some_and(|id| life.session.as_ref().is_none_or(|s| s.id != id)) {
            return Ok(json!({"cancelled":true}));
        }
        life.stopping = true;
        let session = life.session.take();
        if let Some(s) = &session {
            s.cancel.cancel();
            if let Some(timer) = &s.timer {
                timer.abort();
            }
        }
        while life.active > 0 {
            life = self.drained.wait(life).map_err(error)?;
        }
        drop(life);
        if let Some(s) = session {
            if let Some(upstream) = s.upstream {
                let _ = self.upstream(
                    &s.base,
                    "/api/cancel",
                    json!({"session_id":upstream}),
                    RequestCancellation::new(),
                );
            }
        }
        let mut life = self.life.lock().map_err(error)?;
        life.stopping = false;
        self.drained.notify_all();
        Ok(json!({"cancelled":true}))
    }
}
#[cfg(test)]
mod tests;
