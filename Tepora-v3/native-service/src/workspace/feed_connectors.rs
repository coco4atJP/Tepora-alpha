//! Saved weather/news connectors. In-memory cache and owned cancellable feed
//! requests reuse NativeNetwork; neither feed content nor this owner grants access.
use super::*;
use crate::network::{NativeNetwork, NetworkRequest, NetworkScope, Purpose, RequestCancellation};
use futures_util::StreamExt;
use regex::Regex;
use std::{sync::Condvar, time::Duration};

const MAX_FLIGHTS: usize = 8;
const MAX_CACHE: usize = 32;
const WEATHER_BYTES: usize = 1_048_576;
const NEWS_BYTES: usize = 4_000_000;
const NEWS_UNITS: usize = 1_000_000;
const WEATHER_TTL: i64 = 900_000;
const NEWS_TTL: i64 = 600_000;
struct Cached {
    at: i64,
    value: Value,
}
#[derive(Default)]
struct Life {
    closed: bool,
    barriers: usize,
    next: u64,
    active: HashMap<u64, RequestCancellation>,
    cache: HashMap<String, Cached>,
}
pub(super) struct FeedConnectors {
    network: NativeNetwork,
    life: Mutex<Life>,
    drained: Condvar,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    timeout: Duration,
}
pub(super) struct StopBarrier<'a>(&'a FeedConnectors);
impl Drop for StopBarrier<'_> {
    fn drop(&mut self) {
        let mut life = self.0.life.lock().unwrap_or_else(|e| e.into_inner());
        while !life.active.is_empty() {
            life = self.0.drained.wait(life).unwrap_or_else(|e| e.into_inner());
        }
        life.barriers -= 1;
        self.0.drained.notify_all();
    }
}
struct Flight<'a> {
    owner: &'a FeedConnectors,
    id: u64,
    cancel: RequestCancellation,
}
impl Drop for Flight<'_> {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.owner
            .life
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active
            .remove(&self.id);
        self.owner.drained.notify_all();
    }
}
impl FeedConnectors {
    pub(super) fn new(network: NativeNetwork) -> Self {
        Self {
            network,
            life: Mutex::new(Life::default()),
            drained: Condvar::new(),
            clock: Arc::new(|| Utc::now().timestamp_millis()),
            timeout: Duration::from_secs(10),
        }
    }
    pub(super) fn stop_barrier(&self, close: bool) -> Result<StopBarrier<'_>, ApiError> {
        let mut life = self.life.lock().map_err(error)?;
        life.closed |= close;
        life.barriers += 1;
        for cancel in life.active.values() {
            cancel.cancel();
        }
        Ok(StopBarrier(self))
    }
    fn admit(&self, cancel: RequestCancellation) -> Result<Flight<'_>, ApiError> {
        let mut life = self.life.lock().map_err(error)?;
        require(
            !life.closed && life.barriers == 0,
            503,
            "Service closing or stopping",
        )?;
        if let Some(e) = cancel.error() {
            return Err(e.into());
        }
        require(
            life.active.len() < MAX_FLIGHTS,
            429,
            "Too many feed requests",
        )?;
        life.next += 1;
        let id = life.next;
        life.active.insert(id, cancel.clone());
        Ok(Flight {
            owner: self,
            id,
            cancel,
        })
    }
    fn cached(&self, flight: &Flight<'_>, key: &str, ttl: i64) -> Result<Option<Value>, ApiError> {
        let life = self.life.lock().map_err(error)?;
        if let Some(e) = flight.cancel.error() {
            return Err(e.into());
        }
        Ok(life
            .cache
            .get(key)
            .filter(|c| (self.clock)() as i128 - (c.at as i128) < ttl as i128)
            .map(|c| c.value.clone()))
    }
    fn publish(&self, flight: &Flight<'_>, key: String, value: Value) -> Result<Value, ApiError> {
        // Stop's invalidation and cache publication share the same lock.
        let mut life = self.life.lock().map_err(error)?;
        if let Some(e) = flight.cancel.error() {
            return Err(e.into());
        }
        if life.cache.len() >= MAX_CACHE && !life.cache.contains_key(&key) {
            if let Some(oldest) = life
                .cache
                .iter()
                .min_by_key(|(_, c)| c.at)
                .map(|(k, _)| k.clone())
            {
                life.cache.remove(&oldest);
            }
        }
        life.cache.insert(
            key,
            Cached {
                at: (self.clock)(),
                value: value.clone(),
            },
        );
        Ok(value)
    }
    fn timestamp(&self) -> String {
        chrono::DateTime::from_timestamp_millis((self.clock)())
            .expect("clock within timestamp range")
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    }
    async fn request(
        &self,
        url: &str,
        flight: &Flight<'_>,
        bytes: usize,
    ) -> Result<crate::network::NetworkResponse, ApiError> {
        self.network
            .request(
                url,
                NetworkRequest {
                    cancellation: Some(flight.cancel.clone()),
                    ..Default::default()
                },
                NetworkScope {
                    purpose: Purpose::Feed,
                    allow_cloud: true,
                    timeout: self.timeout,
                    max_bytes: bytes,
                    ..Default::default()
                },
            )
            .await
            .map_err(network_error)
    }
    async fn json(&self, url: &str, flight: &Flight<'_>, message: &str) -> Result<Value, ApiError> {
        let work = async {
            let response = self.request(url, flight, WEATHER_BYTES).await?;
            require((200..300).contains(&response.status), 502, message)?;
            response.json(WEATHER_BYTES).await.map_err(network_error)
        };
        tokio::select! { biased;
            e = flight.cancel.cancelled() => Err(e.into()),
            result = tokio::time::timeout(self.timeout, work) => result.unwrap_or_else(|_| Err(timeout_error())),
        }
    }
    pub(super) async fn weather(
        &self,
        settings: &Value,
        cancel: RequestCancellation,
    ) -> Result<Value, ApiError> {
        require(
            truth(&settings["allowNetwork"]),
            403,
            "天気の取得にはネットワーク接続の許可が必要です。",
        )?;
        let city = settings["weatherCity"]
            .as_str()
            .filter(|s| {
                !preferences::trim_text(s).is_empty() && json_codec::utf16_units(s).len() <= 100
            })
            .ok_or_else(|| ApiError::bad_request("city: 1–100 characters required"))?;
        let flight = self.admit(cancel)?;
        let key = format!("weather:{city}");
        if let Some(value) = self.cached(&flight, &key, WEATHER_TTL)? {
            return Ok(value);
        }
        let geo = self
            .json(
                &geocode_url(city)?,
                &flight,
                "Weather location service unavailable",
            )
            .await?;
        let place = geo["results"].get(0).filter(|p| truth(p)).ok_or_else(|| {
            ApiError::new(404, "都市が見つかりません。英字表記も試してください。")
        })?;
        let data = self
            .json(
                &forecast_url(place),
                &flight,
                "Weather provider unavailable",
            )
            .await?;
        self.publish(&flight, key, weather_value(place, &data, &self.timestamp()))
    }
    pub(super) async fn news(
        &self,
        settings: &Value,
        cancel: RequestCancellation,
    ) -> Result<Value, ApiError> {
        require(
            truth(&settings["allowNetwork"]) && truth(&settings["newsUrl"]),
            409,
            "RSSのURLとネットワーク許可を設定してください。",
        )?;
        let source = tepora_core::js_value::js_string(Some(&settings["newsUrl"]));
        let flight = self.admit(cancel)?;
        let key = format!("news:{source}");
        if let Some(value) = self.cached(&flight, &key, NEWS_TTL)? {
            return Ok(value);
        }
        preferences::endpoint(&settings["newsUrl"], true)?;
        let work = async {
            let mut response = self
                .request(&json_codec::sql_text(&source), &flight, NEWS_BYTES)
                .await?;
            require(
                (200..300).contains(&response.status),
                502,
                "RSS feed unavailable",
            )?;
            let mut decoder = encoding_rs::UTF_8.new_decoder();
            let mut xml = String::new();
            let mut units = 0;
            while let Some(chunk) = response.body.next().await {
                let chunk = chunk.map_err(network_error)?;
                let before = xml.len();
                xml.reserve(chunk.len().saturating_mul(3) + 4);
                let (_, read, _) = decoder.decode_to_string(&chunk, &mut xml, false);
                debug_assert_eq!(read, chunk.len());
                units += xml[before..].encode_utf16().count();
                require(units < NEWS_UNITS, 400, "RSS feed too large")?;
            }
            xml.reserve(4);
            let _ = decoder.decode_to_string(&[], &mut xml, true);
            Ok(news_value(&xml, &source, &self.timestamp()))
        };
        let value = tokio::select! { biased;
            e = flight.cancel.cancelled() => Err(e.into()),
            result = tokio::time::timeout(self.timeout, work) => result.unwrap_or_else(|_| Err(timeout_error())),
        }?;
        self.publish(&flight, key, value)
    }
}
fn timeout_error() -> ApiError {
    ApiError::new(500, "The operation was aborted due to timeout")
}
fn network_error(error: crate::network::NetworkError) -> ApiError {
    if error.timeout {
        timeout_error()
    } else {
        error.into()
    }
}
fn geocode_url(city: &str) -> Result<String, ApiError> {
    // encodeURIComponent leaves this exact ASCII set; unlike form encoding it
    // emits %20 for spaces. Isolated UTF-16 surrogates match its URIError.
    let plain = String::from_utf16(&json_codec::utf16_units(city))
        .map_err(|_| ApiError::new(500, "URI malformed"))?;
    let encoded: String = plain
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    Ok(format!(
        "https://geocoding-api.open-meteo.com/v1/search?name={encoded}&count=1&language=ja"
    ))
}
fn forecast_url(place: &Value) -> String {
    let latitude = tepora_core::js_value::js_string(place.get("latitude"));
    let longitude = tepora_core::js_value::js_string(place.get("longitude"));
    format!("https://api.open-meteo.com/v1/forecast?latitude={latitude}&longitude={longitude}&current=temperature_2m,weather_code,apparent_temperature&hourly=temperature_2m,weather_code,precipitation_probability&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max&timezone=auto&forecast_days=2")
}
fn weather_value(place: &Value, data: &Value, at: &str) -> Value {
    let hourly = &data["hourly"];
    let keep = hourly["time"].as_array().map_or(0, |a| a.len().min(48));
    let mut result = Map::new();
    if let Some(city) = place.get("name") {
        result.insert("city".into(), city.clone());
    }
    if let Some(current) = data.get("current") {
        result.insert("current".into(), current.clone());
    }
    let mut sliced = Map::new();
    for key in [
        "time",
        "temperature_2m",
        "weather_code",
        "precipitation_probability",
    ] {
        sliced.insert(
            key.into(),
            json!(hourly[key]
                .as_array()
                .map(|a| a.iter().take(keep).cloned().collect::<Vec<_>>())
                .unwrap_or_default()),
        );
    }
    result.insert("hourly".into(), Value::Object(sliced));
    if let Some(daily) = data.get("daily") {
        result.insert("daily".into(), daily.clone());
    }
    result.insert("source".into(), json!("Open-Meteo"));
    result.insert("sourceUrl".into(), json!("https://open-meteo.com/"));
    result.insert("fetchedAt".into(), json!(at));
    Value::Object(result)
}
struct FeedPatterns {
    cdata: Regex,
    tags: Regex,
    items: Regex,
    head: Regex,
    link: Regex,
    fields: HashMap<&'static str, Regex>,
}
fn patterns() -> &'static FeedPatterns {
    static PATTERNS: OnceLock<FeedPatterns> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let space = r"\x09-\x0d\x20\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
        FeedPatterns {
            cdata: Regex::new(r"(?s)<!\[CDATA\[(.*?)\]\]>").unwrap(),
            tags: Regex::new(r"<[^>]*>").unwrap(),
            items: Regex::new(&format!(
                r"(?i-u:<(?:item|entry))(?:[{space}][^>]*)?>(?s:(.*?))(?i-u:</(?:item|entry)>)"
            ))
            .unwrap(),
            head: Regex::new(&format!(r"(?i-u:<(?:item|entry))[{space}>]")).unwrap(),
            link: Regex::new(r#"(?i-u:<link)[^>]*(?i-u:href)=["']([^"']+)["']"#).unwrap(),
            fields: ["title", "link", "pubDate", "published", "updated"]
                .into_iter()
                .map(|t| {
                    (
                        t,
                        Regex::new(&format!(r"(?i-u:<{t})[^>]*>(?s:(.*?))(?i-u:</{t}>)")).unwrap(),
                    )
                })
                .collect(),
        }
    })
}
fn field(block: &str, name: &str) -> String {
    let p = patterns();
    let text = p.fields[name]
        .captures(block)
        .and_then(|c| c.get(1))
        .map_or("", |c| c.as_str());
    let text = p.cdata.replace_all(text, "$1");
    let text = p.tags.replace_all(&text, "");
    preferences::trim_text(&json_codec::encode_text(
        &text
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\""),
    ))
}
fn news_value(xml: &str, source: &str, at: &str) -> Value {
    let p = patterns();
    let items: Vec<_> = p.items.captures_iter(xml).take(12).filter_map(|m| {
        let block = m.get(1).unwrap().as_str();
        let link = field(block, "link");
        let link = if link.is_empty() { p.link.captures(block).and_then(|c| c.get(1)).map_or("", |c| c.as_str()).to_owned() } else { json_codec::sql_text(&link) };
        // Source webURL validation, not endpoint/network admission: these links
        // are returned as inert text and never opened or fetched here.
        let url = url::Url::parse(&link).ok()?;
        if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some_and(|p| !p.is_empty()) { return None; }
        let published = ["pubDate", "published", "updated"].into_iter().map(|t| field(block, t)).find(|s| !s.is_empty()).unwrap_or_default();
        Some(json!({"title":slice(&field(block,"title"),240),"url":json_codec::encode_text(url.as_str()),"publishedAt":published}))
    }).collect();
    let head = &xml[..p.head.find(xml).map_or(xml.len(), |m| m.start())];
    json!({"title":slice(&field(head,"title"),120),"items":items,"source":source,"fetchedAt":at})
}
#[cfg(test)]
mod tests;
