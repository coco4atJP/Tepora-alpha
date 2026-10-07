use super::*;
use crate::network::{NetworkProfile, NetworkRequest, NetworkResponse, NetworkScope};
use futures_util::StreamExt;
use hyper::{
    header::{HeaderName, HeaderValue},
    HeaderMap, Method,
};
use tepora_core::protocols::{encode_request, Decoder};

const FRAME_LIMIT: usize = 4_000_000;
fn js_whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}

pub const USER_AGENT: &str = "Tepora/3.0 (local agent harness)";
const OPTIONAL_PARAMS: &[&str] = &[
    "stream_options",
    "prompt_cache_key",
    "prompt_cache_retention",
    "cache_prompt",
    "id_slot",
    "return_progress",
    "tool_choice",
    "parallel_tool_calls",
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "presence_penalty",
    "frequency_penalty",
    "repeat_penalty",
    "seed",
    "max_completion_tokens",
    "max_tokens",
    "reasoning",
    "reasoning_effort",
    "thinking",
    "thinkingConfig",
    "include",
    "think",
    "keep_alive",
];

pub fn request_path(profile: &Value) -> String {
    match s(profile, "protocol") {
        "responses" => "responses".into(),
        "anthropic" => "messages".into(),
        "gemini" => format!(
            "models/{}:streamGenerateContent?alt=sse",
            encode_component(
                s(profile, "model")
                    .strip_prefix("models/")
                    .unwrap_or(s(profile, "model"))
            )
        ),
        _ => "chat/completions".into(),
    }
}
fn encode_component(value: &str) -> String {
    let mut out = String::new();
    for byte in json_codec::sql_text(value).bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
pub fn request_headers(
    profile: &Value,
    key: &str,
    session_key: Option<&Value>,
) -> Result<HeaderMap, ProviderFailure> {
    let mut headers = HeaderMap::new();
    for (name, value) in [
        ("content-type", "application/json"),
        ("accept", "text/event-stream, application/json"),
        ("user-agent", USER_AGENT),
    ] {
        headers.insert(
            HeaderName::from_static(name),
            HeaderValue::from_static(value),
        );
    }
    if !s(profile, "sessionHeader").is_empty() {
        if let Some(key) = session_key.filter(|v| !v.is_null() && v.as_str() != Some("")) {
            let text = key
                .as_str()
                .map(json_codec::sql_text)
                .unwrap_or_else(|| key.to_string());
            let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
            let name = HeaderName::from_bytes(s(profile, "sessionHeader").as_bytes())
                .map_err(|_| ProviderFailure::new("bad-request", "Invalid session header name"))?;
            headers.insert(
                name,
                HeaderValue::from_str(&format!("tepora-{}", &hash[..32])).unwrap(),
            );
        }
    }
    let (name, value) = match s(profile, "protocol") {
        "anthropic" => {
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
            ("x-api-key", key.to_owned())
        }
        "gemini" => ("x-goog-api-key", key.to_owned()),
        _ => ("authorization", format!("Bearer {key}")),
    };
    if !key.is_empty() {
        headers.insert(
            HeaderName::from_static(name),
            HeaderValue::from_str(&value).map_err(|_| {
                ProviderFailure::new(
                    "bad-request",
                    "API key cannot be represented as an HTTP header",
                )
            })?,
        );
    }
    Ok(headers)
}
pub fn overflow_limit(text: &str) -> Option<u64> {
    for pattern in [
        r"(?i)maximum context length is (\d+)",
        r"(?i)context (?:length|window|size)(?: of| is| =|:)? ?(\d{3,7})",
        r"(?i)n_ctx(?:_slot)?\D{0,12}(\d{3,7})",
        r"(?i)limit(?: of| is)? (\d{3,7}) tokens",
        r"> ?(\d{3,7}) maximum",
    ] {
        if let Some(c) = regex::Regex::new(pattern).unwrap().captures(text) {
            if let Ok(n) = c[1].parse() {
                return Some(n);
            }
        }
    }
    None
}
pub fn retry_after(headers: &HeaderMap, now_ms: i64) -> Option<u64> {
    if let Some(ms) = headers
        .get("retry-after-ms")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.)
    {
        return Some(ms.min(3600000.) as u64);
    }
    let value = headers.get("retry-after")?.to_str().ok()?;
    if value.is_empty() {
        return None;
    }
    if let Ok(seconds) = value.trim().parse::<f64>() {
        if seconds.is_finite() {
            return Some((seconds * 1000.).clamp(0., 3600000.) as u64);
        }
    }
    chrono::DateTime::parse_from_rfc2822(value)
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(value))
        .ok()
        .map(|at| (at.timestamp_millis() - now_ms).clamp(0, 3600000) as u64)
}
pub fn classify_response(
    status: u16,
    headers: &HeaderMap,
    body: &str,
    sent: &[&str],
    now_ms: i64,
) -> ProviderFailure {
    let body = truncate(body, 8000);
    let message = json_codec::parse(&body)
        .ok()
        .and_then(|v| {
            let error = &v["error"];
            [
                error.get("message"),
                Some(error),
                v.get("message"),
                v.get("detail"),
            ]
            .into_iter()
            .flatten()
            .find(|v| !v.is_null() && v.as_str() != Some(""))
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| json_codec::stringify_js(v).unwrap_or_default())
            })
        })
        .unwrap_or_else(|| truncate(&body, 300));
    let message = if message.is_empty() {
        format!("HTTP {status}")
    } else {
        truncate(&message, 500)
    };
    let overflow=regex::Regex::new(r"(?i)context[_ -]?(length|window|size)|maximum context|too many tokens|prompt is too long|prompt too long|input is too long|exceeds? (the )?(available |model'?s? )?context|n_ctx|reduce the length|longer than the model|too large for model|context limit").unwrap().is_match(&body);
    let mut error = if matches!(status, 401 | 403) {
        ProviderFailure::new(
            "auth",
            format!("認証に失敗しました（HTTP {status}）。APIキーと接続先を確認してください。"),
        )
    } else if status == 429 {
        let mut e = ProviderFailure::new(
            "rate",
            truncate(&format!("利用上限に達しました（HTTP 429）。{message}"), 400),
        );
        e.retry_after_ms = Some(retry_after(headers, now_ms).unwrap_or(15000));
        e
    } else if overflow && matches!(status, 400 | 413 | 422 | 500) {
        let mut e = ProviderFailure::new(
            "overflow",
            format!("Context window exceeded: {}", truncate(&message, 300)),
        );
        e.limit = overflow_limit(&body);
        e
    } else if matches!(status, 408 | 409) || status >= 500 {
        let mut e = ProviderFailure::new(
            "transient",
            truncate(
                &format!("Model server error (HTTP {status}): {message}"),
                400,
            ),
        );
        e.retry_after_ms = retry_after(headers, now_ms);
        e
    } else {
        let mut e = ProviderFailure::new(
            "bad-request",
            truncate(
                &format!("Model request rejected (HTTP {status}): {message}"),
                500,
            ),
        );
        e.param = sent
            .iter()
            .find(|p| {
                regex::Regex::new(&format!(r"\b{}\b", regex::escape(p)))
                    .unwrap()
                    .is_match(&body)
            })
            .map(|p| (*p).into());
        e
    };
    error.upstream_status = Some(status);
    error.body = body;
    error
}

/// TextDecoder-compatible incremental replacement decoding, preserving split UTF-8
/// scalars and dropping only the initial BOM. At most three incomplete bytes remain.
#[derive(Default)]
pub struct Utf8Decoder {
    pending: Vec<u8>,
    started: bool,
}
impl Utf8Decoder {
    pub fn push(&mut self, bytes: &[u8], end: bool) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        let mut consumed = 0;
        loop {
            match std::str::from_utf8(&self.pending[consumed..]) {
                Ok(text) => {
                    out.push_str(text);
                    consumed = self.pending.len();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    out.push_str(
                        std::str::from_utf8(&self.pending[consumed..consumed + valid]).unwrap(),
                    );
                    consumed += valid;
                    if let Some(length) = error.error_len() {
                        out.push('\u{fffd}');
                        consumed += length;
                    } else if end {
                        out.push('\u{fffd}');
                        consumed = self.pending.len();
                        break;
                    } else {
                        break;
                    }
                }
            }
        }
        self.pending.drain(..consumed);
        if !self.started && !out.is_empty() {
            self.started = true;
            if out.starts_with('\u{feff}') {
                out.remove(0);
            }
        }
        out
    }
}
#[derive(Clone, Copy)]
pub enum Framing {
    Sse,
    Ndjson,
}
pub struct FrameDecoder {
    utf8: Utf8Decoder,
    buffer: String,
    data: Vec<String>,
    frame: usize,
    kind: Framing,
}
impl FrameDecoder {
    pub fn new(kind: Framing) -> Self {
        Self {
            utf8: Utf8Decoder::default(),
            buffer: String::new(),
            data: vec![],
            frame: 0,
            kind,
        }
    }
    pub fn push(&mut self, bytes: &[u8], end: bool) -> Result<Vec<String>, ProviderFailure> {
        self.buffer.push_str(&self.utf8.push(bytes, end));
        let mut frames = vec![];
        while let Some(index) = self.buffer.find('\n') {
            let mut line = self.buffer[..index].to_owned();
            self.buffer.drain(..=index);
            if line.ends_with('\r') {
                line.pop();
            }
            match self.kind {
                Framing::Ndjson => {
                    if !line.trim_matches(js_whitespace).is_empty() {
                        if line.encode_utf16().count() >= FRAME_LIMIT {
                            return Err(frame_error());
                        }
                        frames.push(line.trim_matches(js_whitespace).to_owned());
                    }
                }
                Framing::Sse => {
                    if line.is_empty() {
                        if !self.data.is_empty() {
                            frames.push(self.data.join("\n"));
                            self.data.clear();
                            self.frame = 0;
                        }
                    } else if let Some(data) = line.strip_prefix("data:") {
                        self.frame += line.encode_utf16().count();
                        if self.frame >= FRAME_LIMIT {
                            return Err(frame_error());
                        }
                        self.data
                            .push(data.trim_start_matches(js_whitespace).to_owned());
                    }
                }
            }
        }
        if self.buffer.encode_utf16().count() >= FRAME_LIMIT {
            return Err(frame_error());
        }
        if end {
            match self.kind {
                Framing::Ndjson => {
                    if !self.buffer.trim_matches(js_whitespace).is_empty() {
                        frames.push(self.buffer.trim_matches(js_whitespace).to_owned());
                    }
                }
                Framing::Sse => {
                    if let Some(data) = self.buffer.strip_prefix("data:") {
                        self.frame += self.buffer.encode_utf16().count();
                        if self.frame >= FRAME_LIMIT {
                            return Err(frame_error());
                        }
                        self.data.push(data.trim_matches(js_whitespace).to_owned());
                    }
                    if !self.data.is_empty() {
                        frames.push(self.data.join("\n"));
                        self.data.clear();
                    }
                }
            }
            self.buffer.clear();
        }
        Ok(frames)
    }
}
fn frame_error() -> ProviderFailure {
    ProviderFailure::new("transient", "Upstream stream frame is too large")
}
fn emit(
    events: Vec<Value>,
    sink: &EventSink,
    cancel: &RequestCancellation,
) -> Result<(), ProviderFailure> {
    for event in events {
        check(cancel)?;
        sink(ProviderEvent {
            kind: s(&event, "type").into(),
            value: event["value"].clone(),
        });
    }
    Ok(())
}
async fn decode_wire(
    profile: &Value,
    kind: &str,
    mut response: NetworkResponse,
    cancel: &RequestCancellation,
    sink: &EventSink,
) -> Result<Value, ProviderFailure> {
    let mut decoder = Decoder::new(
        profile.clone(),
        kind,
        &uuid::Uuid::new_v4().to_string()[..12],
    )
    .map_err(ProviderFailure::from_core)?;
    let sse = response
        .headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| s.contains("text/event-stream"));
    if kind == "ollama" || sse {
        let mut frames = FrameDecoder::new(if kind == "ollama" {
            Framing::Ndjson
        } else {
            Framing::Sse
        });
        let mut ended = false;
        loop {
            let chunk = tokio::select! {biased;error=cancel.cancelled()=>return Err(error.into()),chunk=response.body.next()=>chunk};
            let end = chunk.is_none();
            let chunk = match chunk {
                Some(c) => c.map_err(ProviderFailure::from)?,
                None => bytes::Bytes::new(),
            };
            for frame in frames.push(&chunk, end)? {
                check(cancel)?;
                if matches!(kind, "chat-completions" | "responses") && frame == "[DONE]" {
                    ended = true;
                    break;
                }
                let packet = match json_codec::parse(&frame) {
                    Ok(v) => v,
                    Err(_) if kind != "ollama" => continue,
                    Err(_) => {
                        return Err(ProviderFailure::new(
                            "transient",
                            "Invalid Ollama NDJSON response",
                        ))
                    }
                };
                emit(
                    decoder
                        .push(&packet, true)
                        .map_err(ProviderFailure::from_core)?,
                    sink,
                    cancel,
                )?;
            }
            if end || ended {
                break;
            }
        }
    } else {
        let bytes = tokio::select! {biased;error=cancel.cancelled()=>return Err(error.into()),body=response.bytes()=>body.map_err(ProviderFailure::from)?};
        let mut utf8 = Utf8Decoder::default();
        let text = utf8.push(&bytes, true);
        let packet = json_codec::parse(&text)
            .map_err(|_| ProviderFailure::new("transient", "Invalid provider JSON response"))?;
        emit(
            decoder
                .push(&packet, false)
                .map_err(ProviderFailure::from_core)?,
            sink,
            cancel,
        )?;
    }
    check(cancel)?;
    let finished = decoder.finish().map_err(ProviderFailure::from_core)?;
    emit(array(&finished["events"]).to_vec(), sink, cancel)?;
    Ok(finished["result"].clone())
}

pub async fn protocol_chat(
    network: &NativeNetwork,
    profile: &Value,
    key: &str,
    messages: &[Value],
    options: &Value,
    mut scope: NetworkScope,
    cancel: &RequestCancellation,
    sink: &EventSink,
) -> Result<Value, ProviderFailure> {
    check(cancel)?;
    let ollama = s(profile, "protocol") == "chat-completions" && s(profile, "server") == "ollama";
    let body =
        encode_request(profile, messages, options, ollama).map_err(ProviderFailure::from_core)?;
    let sent: Vec<_> = OPTIONAL_PARAMS
        .iter()
        .copied()
        .filter(|k| body.get(*k).is_some() || body["generationConfig"].get(*k).is_some())
        .collect();
    let base = json_codec::sql_text(s(profile, "baseUrl"));
    let url = if ollama {
        format!(
            "{}/api/chat",
            url::Url::parse(&base)
                .map_err(|_| ProviderFailure::new("bad-request", "Invalid provider URL"))?
                .origin()
                .ascii_serialization()
        )
    } else {
        format!("{}/{}", base.trim_end_matches('/'), request_path(profile))
    };
    if ollama {
        let mut p = NetworkProfile::from_value(profile)?;
        p.base_url = url::Url::parse(&base)
            .unwrap()
            .origin()
            .ascii_serialization();
        scope.profile = Some(p);
    }
    scope.gemini_stream_query = s(profile, "protocol") == "gemini";
    let request = NetworkRequest {
        method: Method::POST,
        headers: request_headers(profile, key, options.get("cacheKey"))?,
        body: json_codec::stringify_js(&body)
            .map_err(ProviderFailure::from_core)?
            .into(),
        cancellation: Some(cancel.clone()),
    };
    let result = async {
        let response = network
            .request(&url, request, scope)
            .await
            .map_err(ProviderFailure::from)?;
        if !(200..300).contains(&response.status) {
            let status = response.status;
            let headers = response.headers.clone();
            let body = response.text().await.unwrap_or_default();
            check(cancel)?;
            return Err(classify_response(status, &headers, &body, &sent, now_ms()));
        }
        decode_wire(
            profile,
            if ollama {
                "ollama"
            } else {
                s(profile, "protocol")
            },
            response,
            cancel,
            sink,
        )
        .await
    }
    .await;
    result.map_err(|mut e| {
        if !key.is_empty() {
            e.message = e.message.replace(key, "[redacted]");
            e.body = e.body.replace(key, "[redacted]");
        }
        e
    })
}
