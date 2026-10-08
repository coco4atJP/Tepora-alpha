//! Native web tools. All outbound hops use the existing checked/pinned network;
//! HTML is untrusted evidence, never a source of tool approval or instructions.
//! No Node, shell, process, browser fallback, or API key lookup is implicit.
#[path = "web/html.rs"]
pub mod html;
use super::{
    decisions::{self, Decisions, Relevance},
    EffectError,
};
use crate::network::{
    NativeNetwork, NetworkError, NetworkRequest, NetworkResponse, NetworkScope, Purpose,
    RequestCancellation,
};
use bytes::Bytes;
use hyper::{header, HeaderMap, Method};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tepora_core::{
    js_value::{js_string, truthy},
    json_codec::{self, encode_text, from_utf16_units, sql_text, stringify_js, utf16_units},
};
use url::Url;
impl From<html::HtmlError> for EffectError {
    fn from(e: html::HtmlError) -> Self {
        error(e.status, e.message)
    }
}
const UA:&str="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Tepora";
/// Exact source metadata. Host toolsets must opt in only after web policy wiring.
pub fn definitions() -> Vec<Value> {
    json_codec::parse(include_str!("web/catalog.json"))
        .expect("frozen web catalog")
        .as_array()
        .unwrap()
        .clone()
}
pub fn summarize(name: &str, args: &Value) -> Result<String, EffectError> {
    match name {
        "web_search" => Ok(format!(
            "web_search {}",
            match args.get("query") {
                Some(query) =>
                    encode_text(&stringify_js(query).map_err(|e| error(400, e.to_string()))?),
                None => "undefined".into(),
            }
        )),
        "web_fetch" => Ok(format!(
            "web_fetch {}{}{}",
            js_string(args.get("url")),
            if args.get("question").is_some_and(truthy) {
                format!(" ? {}", one_line(&js_string(args.get("question")), 40)?)
            } else {
                String::new()
            },
            if args.get("offset").is_some_and(truthy) {
                format!(" @{}", js_string(args.get("offset")))
            } else {
                String::new()
            }
        )),
        _ => Err(error(503, "Native web tool is not implemented")),
    }
}
pub const SEARCH_PROVIDERS: [&str; 4] = ["auto", "brave", "searxng", "duckduckgo"];
/// A trusted owner-supplied snapshot/revision check, never page instructions.
/// It runs without holding a database lock across an awaited request.
pub trait WebAuthority: Send + Sync {
    fn check(&self) -> Result<(), EffectError>;
}
pub trait WebClock: Send + Sync {
    fn now_ms(&self) -> i64;
}
pub struct SystemWebClock;
impl WebClock for SystemWebClock {
    fn now_ms(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebConfig {
    pub provider: String,
    pub searxng_url: String,
    pub brave_key_env: String,
}
impl Default for WebConfig {
    fn default() -> Self {
        Self {
            provider: "auto".into(),
            searxng_url: String::new(),
            brave_key_env: "BRAVE_API_KEY".into(),
        }
    }
}
impl WebConfig {
    pub fn from_value(v: &Value) -> Result<Self, EffectError> {
        let mut c = Self::default();
        for (key, target) in [
            ("provider", &mut c.provider),
            ("searxngUrl", &mut c.searxng_url),
            ("braveKeyEnv", &mut c.brave_key_env),
        ] {
            if let Some(v) = v.get(key) {
                *target = v
                    .as_str()
                    .ok_or_else(|| error(400, format!("Invalid webSearch.{key}")))?
                    .into();
            }
        }
        Ok(c)
    }
}
/// Actor resolves saved Brave key first, then config.braveKeyEnv. No Debug/JSON
/// representation prevents accidental credentials in diagnostics or receipts.
#[derive(Clone, Default)]
pub struct SecretSnapshot {
    brave: String,
}
impl SecretSnapshot {
    pub fn new(brave: impl Into<String>) -> Self {
        Self {
            brave: brave.into(),
        }
    }
}
#[derive(Clone, Debug)]
pub struct BrowserRenderRequest {
    pub url: String,
    pub purpose: Purpose,
    pub network_revision: u64,
    pub max_html_units: usize,
    pub max_response_bytes: usize,
    pub cancellation: RequestCancellation,
}
#[derive(Clone, Debug)]
pub struct RenderedPage {
    pub html: String,
    pub url: String,
}
pub type BrowserFuture<'a> =
    Pin<Box<dyn Future<Output = Result<RenderedPage, EffectError>> + Send + 'a>>;
/// Trusted optional adapter. It must enforce the passed web-tool purpose plus
/// current network policy for navigation/subresources/redirects and honor Stop.
/// It must not use rendering to retry a policy-denied target or transmit keys.
pub trait BrowserRenderer: Send + Sync {
    fn render<'a>(&'a self, request: BrowserRenderRequest) -> BrowserFuture<'a>;
}
#[derive(Clone, Debug)]
pub struct WebDocument {
    pub url: String,
    pub title: String,
    pub content_type: String,
    pub text: String,
    pub at: i64,
}
impl WebDocument {
    pub fn value(&self) -> Value {
        json!({"url":self.url,"title":self.title,"type":self.content_type,"text":self.text,"at":self.at})
    }
}
#[derive(Clone, Debug)]
pub struct SearchResults {
    pub provider: String,
    pub results: Vec<Value>,
    pub fallback_from: Vec<String>,
}
impl SearchResults {
    pub fn value(&self) -> Value {
        let mut v = json!({"provider":self.provider,"results":self.results});
        if !self.fallback_from.is_empty() {
            v["fallbackFrom"] = json!(self.fallback_from);
        }
        v
    }
}
#[derive(Default)]
struct Cache {
    pages: HashMap<String, WebDocument>,
    order: VecDeque<String>,
}
pub struct WebTools {
    network: NativeNetwork,
    config: WebConfig,
    keys: SecretSnapshot,
    browser: Option<Arc<dyn BrowserRenderer>>,
    decisions: Option<Arc<Decisions>>,
    unicode_version: u32,
    clock: Arc<dyn WebClock>,
    cache: Mutex<Cache>,
    authority: Option<Arc<dyn WebAuthority>>,
}
impl WebTools {
    pub fn new(
        network: NativeNetwork,
        config: WebConfig,
        keys: SecretSnapshot,
        browser: Option<Arc<dyn BrowserRenderer>>,
        decisions: Option<Arc<Decisions>>,
        unicode_version: u32,
    ) -> Self {
        Self {
            network,
            config,
            keys,
            browser,
            decisions,
            unicode_version,
            clock: Arc::new(SystemWebClock),
            cache: Mutex::default(),
            authority: None,
        }
    }
    pub fn with_authority(mut self, authority: Arc<dyn WebAuthority>) -> Self {
        self.authority = Some(authority);
        self
    }
    pub fn check_authority(&self) -> Result<(), EffectError> {
        if let Some(authority) = &self.authority {
            authority.check()?;
        }
        Ok(())
    }
    pub fn with_clock(mut self, clock: Arc<dyn WebClock>) -> Self {
        self.clock = clock;
        self
    }
    pub fn config(&self) -> &WebConfig {
        &self.config
    }
    pub fn provider(&self) -> &str {
        if self.config.provider != "auto" {
            &self.config.provider
        } else if !self.keys.brave.is_empty() {
            "brave"
        } else if !self.config.searxng_url.is_empty() {
            "searxng"
        } else {
            "duckduckgo"
        }
    }
    pub fn clear_cache(&self) {
        *self.cache.lock().unwrap_or_else(|p| p.into_inner()) = Cache::default();
    }
    fn check(&self, cancel: &RequestCancellation) -> Result<(), EffectError> {
        check_cancel(cancel)?;
        if !self.network.policy().internet_tools {
            return Err(error(403, "インターネットを使う道具が許可されていません。"));
        }
        self.check_authority()
    }
    async fn render(
        &self,
        url: &str,
        cancel: &RequestCancellation,
    ) -> Result<RenderedPage, EffectError> {
        self.check(cancel)?;
        self.network
            .assert_uncontained("Web browser")
            .map_err(network_error)?;
        let browser=self.browser.as_ref().ok_or_else(||error(409,"JavaScriptで描画するページの取得には、コンピューター操作のブラウザを有効にしてください。"))?;
        let revision = self.network.policy().revision;
        let result = browser
            .render(BrowserRenderRequest {
                url: url.into(),
                purpose: Purpose::WebTool,
                network_revision: revision,
                max_html_units: 6_000_000,
                max_response_bytes: 10_000_000,
                cancellation: cancel.clone(),
            })
            .await?;
        self.check(cancel)?;
        if self.network.policy().revision != revision {
            return Err(error(
                409,
                "Network policy changed while rendering the page",
            ));
        }
        Ok(result)
    }
    pub async fn search(
        &self,
        query: &str,
        count: usize,
        cancel: &RequestCancellation,
    ) -> Result<SearchResults, EffectError> {
        self.check(cancel)?;
        let first = self.provider().to_owned();
        let mut order = vec![first.clone()];
        if self.config.provider == "auto" {
            for p in ["brave", "searxng", "duckduckgo"] {
                if p != first
                    && (p != "brave" || !self.keys.brave.is_empty())
                    && (p != "searxng" || !self.config.searxng_url.is_empty())
                {
                    order.push(p.into());
                }
            }
        }
        let mut errors = Vec::new();
        let mut denied = false;
        for (i, provider) in order.iter().enumerate() {
            match self.search_with(provider, query, count, cancel).await {
                Ok(mut r)
                    if !r.results.is_empty() || i + 1 == order.len() && self.browser.is_none() =>
                {
                    r.fallback_from = errors;
                    return Ok(r);
                }
                Ok(_) => errors.push(format!("{provider}: no results")),
                Err(e) => {
                    check_cancel(cancel)?;
                    denied |= e.error["blocked"] == true;
                    errors.push(format!("{provider}: {}", slice(&message(&e), 0, 120)));
                }
            }
        }
        if self.browser.is_some() && !denied {
            let url = format!(
                "https://html.duckduckgo.com/html/?q={}&kl=jp-jp",
                encode_component(query)?
            );
            match self.render(&url, cancel).await {
                Ok(rendered) => {
                    return Ok(SearchResults {
                        provider: "browser".into(),
                        results: html::parse_duckduckgo(&rendered.html)
                            .map_err(|m| error(502, m))?
                            .into_iter()
                            .take(count)
                            .collect(),
                        fallback_from: errors,
                    })
                }
                Err(e) => {
                    check_cancel(cancel)?;
                    errors.push(format!("browser: {}", slice(&message(&e), 0, 120)));
                }
            }
        } else if self.browser.is_some() && denied {
            errors.push("browser: unavailable after a network-policy denial".into());
        }
        Err(error(
            502,
            format!("Web search failed: {}", errors.join("; ")),
        ))
    }
    pub async fn search_with(
        &self,
        provider: &str,
        query: &str,
        count: usize,
        cancel: &RequestCancellation,
    ) -> Result<SearchResults, EffectError> {
        self.check(cancel)?;
        let mut options = FetchOptions::default();
        let (url, provider) = match provider {
            "brave" => {
                if self.keys.brave.is_empty() {
                    return Err(error(409, "Brave SearchのAPIキーが設定されていません。"));
                }
                options.headers.insert(
                    header::ACCEPT,
                    header::HeaderValue::from_static("application/json"),
                );
                let mut key = header::HeaderValue::from_str(&sql_text(&self.keys.brave))
                    .map_err(|_| error(400, "Invalid Brave Search credential header"))?;
                key.set_sensitive(true);
                options.headers.insert("x-subscription-token", key);
                (
                    format!(
                        "https://api.search.brave.com/res/v1/web/search?q={}&count={count}",
                        encode_component(query)?
                    ),
                    "brave",
                )
            }
            "searxng" => {
                if self.config.searxng_url.is_empty() {
                    return Err(error(409, "SearXNGのURLが設定されていません。"));
                }
                options.headers.insert(
                    header::ACCEPT,
                    header::HeaderValue::from_static("application/json"),
                );
                (
                    format!(
                        "{}/search?q={}&format=json",
                        self.config
                            .searxng_url
                            .strip_suffix('/')
                            .unwrap_or(&self.config.searxng_url),
                        encode_component(query)?
                    ),
                    "searxng",
                )
            }
            _ => {
                options.method = Method::POST;
                options.headers.insert(
                    header::CONTENT_TYPE,
                    header::HeaderValue::from_static("application/x-www-form-urlencoded"),
                );
                options.headers.insert(
                    header::ACCEPT,
                    header::HeaderValue::from_static("text/html"),
                );
                options.body = Bytes::from(format!("q={}&kl=jp-jp", encode_component(query)?));
                ("https://html.duckduckgo.com/html/".into(), "duckduckgo")
            }
        };
        let (response, _) = fetch_following_guarded(
            &self.network,
            &url,
            options,
            cancel,
            self.authority.clone(),
        )
        .await?;
        if !(200..300).contains(&response.status) {
            return Err(error(
                502,
                match provider {
                    "brave" => format!("Brave Search HTTP {}", response.status),
                    "searxng" => format!(
                        "SearXNG HTTP {}（JSON出力を有効にしてください）",
                        response.status
                    ),
                    _ => format!("DuckDuckGo HTTP {}", response.status),
                },
            ));
        }
        let results = if provider == "duckduckgo" {
            html::parse_duckduckgo(&read_text(response).await?)
                .map_err(|m| error(502, m))?
                .into_iter()
                .take(count)
                .collect()
        } else {
            let bytes = response.bytes().await.map_err(network_error)?;
            let raw = String::from_utf8_lossy(&bytes);
            let v = json_codec::parse(raw.strip_prefix('\u{feff}').unwrap_or(&raw))
                .map_err(|e| error(502, encode_text(&format!("Invalid search JSON: {e}"))))?;
            if v.is_null() {
                return Err(error(502, "Search provider returned a null JSON document"));
            }
            let values = if provider == "brave" {
                &v["web"]["results"]
            } else {
                &v["results"]
            };
            if truthy(values) && !values.is_array() {
                return Err(error(502, "Search provider returned invalid results"));
            }
            values
                .as_array()
                .into_iter()
                .flatten()
                .take(count)
                .map(|x| {
                    if x.is_null() {
                        return Err(error(502, "Search provider returned a null result item"));
                    }
                    let mut out = json!({});
                    for k in ["title", "url"] {
                        if let Some(v) = x.get(k) {
                            out[k] = v.clone();
                        }
                    }
                    let snippet = x
                        .get(if provider == "brave" {
                            "description"
                        } else {
                            "content"
                        })
                        .filter(|v| truthy(v))
                        .cloned()
                        .unwrap_or(json!(""));
                    out["snippet"] = if provider == "brave" {
                        let s = snippet
                            .as_str()
                            .ok_or_else(|| error(502, "Brave Search description must be text"))?;
                        json!(regex::Regex::new(r"<[^>]+>")
                            .unwrap()
                            .replace_all(s, "")
                            .into_owned())
                    } else {
                        snippet
                    };
                    out["age"] = x
                        .get(if provider == "brave" {
                            "age"
                        } else {
                            "publishedDate"
                        })
                        .filter(|v| truthy(v))
                        .cloned()
                        .unwrap_or(Value::Null);
                    Ok(out)
                })
                .collect::<Result<Vec<_>, EffectError>>()?
        };
        check_cancel(cancel)?;
        Ok(SearchResults {
            provider: provider.into(),
            results,
            fallback_from: vec![],
        })
    }
    pub async fn page(
        &self,
        url: &str,
        render: bool,
        cancel: &RequestCancellation,
    ) -> Result<WebDocument, EffectError> {
        self.check(cancel)?;
        let key = format!("{}{url}", if render { "r:" } else { "" });
        if let Some(doc) = self
            .cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pages
            .get(&key)
            .filter(|d| self.clock.now_ms() - d.at < 600000)
            .cloned()
        {
            check_cancel(cancel)?;
            return Ok(doc);
        }
        let revision = self.network.policy().revision;
        let doc = if render {
            let rendered = self.render(url, cancel).await?;
            let md = html::html_to_markdown(&rendered.html, &rendered.url, true)?;
            WebDocument {
                url: rendered.url,
                title: md.title,
                content_type: "text/html".into(),
                text: md.markdown,
                at: self.clock.now_ms(),
            }
        } else {
            let mut options = FetchOptions::default();
            options.headers.insert(
                header::ACCEPT,
                header::HeaderValue::from_static(
                    "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
                ),
            );
            let (response, final_url) = fetch_following_guarded(
                &self.network,
                url,
                options,
                cancel,
                self.authority.clone(),
            )
            .await?;
            let typ = response
                .headers
                .get(header::CONTENT_TYPE)
                .and_then(|h| h.to_str().ok())
                .unwrap_or("")
                .to_lowercase();
            if !(200..300).contains(&response.status) {
                return Err(error(
                    502,
                    format!("HTTP {} from {final_url}", response.status),
                ));
            }
            if typ.contains("pdf") {
                return Err(error(415,format!("{final_url} is a PDF. Download it with exec (curl -L -o file.pdf URL) and convert it with pdftotext, or read it another way.")));
            }
            if !typ.is_empty()
                && !["text", "json", "xml", "javascript", "markdown"]
                    .iter()
                    .any(|p| typ.contains(p))
            {
                return Err(error(415,format!("{final_url} is not a text page ({typ}). Use exec with curl to download it.")));
            }
            let raw = read_text(response).await?;
            let is_html=typ.contains("html")||regex::Regex::new(r"^[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*<([!][dD][oO][cC][tT][yY][pP][eE] [hH][tT][mM][lL]|[hH][tT][mM][lL])").unwrap().is_match(&raw);
            let (title, text) = if is_html {
                let md = html::html_to_markdown(&raw, &final_url, true)?;
                let text = if !md.description.is_empty() && !md.markdown.contains(&md.description) {
                    format!("> {}\n\n{}", md.description, md.markdown)
                } else {
                    md.markdown
                };
                (md.title, text)
            } else {
                (String::new(), raw)
            };
            WebDocument {
                url: final_url,
                title,
                content_type: encode_text(&typ),
                text,
                at: self.clock.now_ms(),
            }
        };
        // Cached offline reads are local and remain valid. A policy revision during
        // an active fetch, however, must not publish a late cache entry.
        self.check(cancel)?;
        if self.network.policy().revision != revision {
            return Err(error(409, "Network policy changed while fetching the page"));
        }
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        if !cache.pages.contains_key(&key) {
            cache.order.push_back(key.clone());
        }
        cache.pages.insert(key, doc.clone());
        if cache.pages.len() > 64 {
            if let Some(old) = cache.order.pop_front() {
                cache.pages.remove(&old);
            }
        }
        Ok(doc)
    }
    pub async fn focus(
        &self,
        doc: &WebDocument,
        question: &str,
        max_tokens: f64,
        cancel: &RequestCancellation,
    ) -> Result<Value, EffectError> {
        self.check(cancel)?;
        let sections = decisions::split_sections(&doc.text, 1800).map_err(EffectError::from)?;
        let relevance = if let Some(decisions) = &self.decisions {
            decisions.relevance(question, &sections, cancel).await?
        } else {
            Relevance {
                scores: decisions::lexical_scores(question, &sections),
                method: "lexical".into(),
            }
        };
        focus_sections(
            &sections,
            &relevance.scores,
            &relevance.method,
            max_tokens,
            self.unicode_version,
        )
    }
    pub async fn execute(
        &self,
        name: &str,
        args: &Value,
        cancel: &RequestCancellation,
    ) -> Result<Value, EffectError> {
        self.check(cancel)?;
        match name {
            "web_search" => {
                let r = self
                    .search(
                        args["query"]
                            .as_str()
                            .ok_or_else(|| error(400, "query must be a string"))?,
                        number(args.get("count"), 8.0) as usize,
                        cancel,
                    )
                    .await?;
                let text = if r.results.is_empty() {
                    format!("No results ({}).", r.provider)
                } else {
                    r.results
                        .iter()
                        .enumerate()
                        .map(|(i, r)| {
                            format!(
                                "{}. {}\n   {}{}\n   {}",
                                i + 1,
                                js_string(r.get("title")),
                                js_string(r.get("url")),
                                if truthy(&r["age"]) {
                                    format!(" ({})", js_string(r.get("age")))
                                } else {
                                    String::new()
                                },
                                js_string(r.get("snippet"))
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                };
                Ok(
                    json!({"text":format!("{text}{}",if r.fallback_from.is_empty(){String::new()}else{format!("\n(searched with {} because {})",r.provider,r.fallback_from.join("; "))}),"data":{"provider":r.provider,"count":r.results.len()}}),
                )
            }
            "web_fetch" => {
                let doc = self
                    .page(
                        args["url"]
                            .as_str()
                            .ok_or_else(|| error(400, "url must be a string"))?,
                        args["render"] == true,
                        cancel,
                    )
                    .await?;
                if args.get("question").is_some_and(truthy)
                    && raw_tokens(&doc.text, self.unicode_version)? > 1200.0
                {
                    let f = self
                        .focus(
                            &doc,
                            &js_string(args.get("question")),
                            number(args.get("max_tokens"), 3000.0).min(8000.0),
                            cancel,
                        )
                        .await?;
                    if f["picked"].as_array().is_some_and(|a| !a.is_empty()) {
                        return focused_result(&doc, &f);
                    }
                }
                page_part(
                    &doc,
                    number(args.get("offset"), 0.0),
                    number(args.get("max_tokens"), 6000.0),
                    self.unicode_version,
                )
            }
            _ => Err(error(
                503,
                format!("Native web tool {name} is not implemented"),
            )),
        }
    }
}
#[derive(Clone)]
pub struct FetchOptions {
    pub headers: HeaderMap,
    pub max_bytes: usize,
    pub timeout: Duration,
    pub method: Method,
    pub body: Bytes,
}
impl Default for FetchOptions {
    fn default() -> Self {
        Self {
            headers: HeaderMap::new(),
            max_bytes: 10_000_000,
            timeout: Duration::from_millis(30000),
            method: Method::GET,
            body: Bytes::new(),
        }
    }
}
pub async fn fetch_following(
    network: &NativeNetwork,
    url: &str,
    options: FetchOptions,
    cancel: &RequestCancellation,
) -> Result<(NetworkResponse, String), EffectError> {
    fetch_following_guarded(network, url, options, cancel, None).await
}
// Carry the same captured web binding through DNS and TCP/TLS waits.
struct WebEgressGuard(Arc<dyn WebAuthority>);
impl std::fmt::Debug for WebEgressGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WebEgressGuard")
    }
}
impl crate::network::EgressGuard for WebEgressGuard {
    fn check(&self) -> Result<(), crate::network::NetworkError> {
        self.0.check().map_err(|_| {
            crate::network::NetworkError::blocked("Web settings or credentials changed")
        })
    }
}
async fn fetch_following_guarded(
    network: &NativeNetwork,
    url: &str,
    mut options: FetchOptions,
    cancel: &RequestCancellation,
    authority: Option<Arc<dyn WebAuthority>>,
) -> Result<(NetworkResponse, String), EffectError> {
    let mut current = url.to_owned();
    if !options.headers.contains_key(header::USER_AGENT) {
        options
            .headers
            .insert(header::USER_AGENT, header::HeaderValue::from_static(UA));
    }
    if !options.headers.contains_key(header::ACCEPT_LANGUAGE) {
        options.headers.insert(
            header::ACCEPT_LANGUAGE,
            header::HeaderValue::from_static("ja,en;q=0.8"),
        );
    }
    for _ in 0..6 {
        check_cancel(cancel)?;
        if let Some(authority) = &authority {
            authority.check()?;
        }
        check_cancel(cancel)?;
        let response = network
            .request(
                &sql_text(&current),
                NetworkRequest {
                    method: options.method.clone(),
                    headers: options.headers.clone(),
                    body: options.body.clone(),
                    cancellation: Some(cancel.clone()),
                },
                NetworkScope {
                    egress_guard: authority.as_ref().map(|a| {
                        Arc::new(WebEgressGuard(a.clone())) as Arc<dyn crate::network::EgressGuard>
                    }),
                    purpose: Purpose::WebTool,
                    redirects: true,
                    max_bytes: options.max_bytes,
                    timeout: options.timeout,
                    ..NetworkScope::default()
                },
            )
            .await
            .map_err(network_error)?;
        if (300..400).contains(&response.status) {
            if let Some(location) = response
                .headers
                .get(header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .filter(|s| !s.is_empty())
            {
                let base = Url::parse(&sql_text(&current))
                    .map_err(|_| error(400, "Invalid redirect base URL"))?;
                let next = base
                    .join(location)
                    .map_err(|_| error(502, "Invalid redirect URL"))?;
                // Deliberate security correction to source: never forward credentials from
                // a trusted origin to a redirect destination on another origin.
                if base.origin() != next.origin() {
                    let remove = options
                        .headers
                        .iter()
                        .filter(|(name, value)| {
                            value.is_sensitive()
                                || matches!(
                                    name.as_str(),
                                    "authorization"
                                        | "proxy-authorization"
                                        | "cookie"
                                        | "cookie2"
                                        | "x-api-key"
                                        | "api-key"
                                        | "x-subscription-token"
                                )
                        })
                        .map(|(n, _)| n.clone())
                        .collect::<Vec<_>>();
                    for name in remove {
                        options.headers.remove(name);
                    }
                }
                current = encode_text(next.as_str());
                options.method = Method::GET;
                options.body = Bytes::new();
                drop(response);
                continue;
            }
        }
        return Ok((response, current));
    }
    Err(error(502, "Too many redirects"))
}
pub async fn read_text(response: NetworkResponse) -> Result<String, EffectError> {
    let typ = response
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let bytes = response.bytes().await.map_err(network_error)?;
    Ok(decode_text(&bytes, &typ))
}
pub fn decode_text(bytes: &[u8], content_type: &str) -> String {
    let header = regex::Regex::new(r"[cC][hH][aA][rR][sS][eE][tT]=([A-Za-z0-9_-]+)").unwrap();
    let latin1 = bytes[..bytes.len().min(4000)]
        .iter()
        .map(|b| char::from(*b))
        .collect::<String>();
    let meta = regex::Regex::new(
        r#"<[mM][eE][tT][aA][^>]+[cC][hH][aA][rR][sS][eE][tT]=["']?([A-Za-z0-9_-]+)"#,
    )
    .unwrap();
    let label = header
        .captures(content_type)
        .map(|c| c[1].to_owned())
        .or_else(|| meta.captures(&latin1).map(|c| c[1].to_owned()))
        .unwrap_or_else(|| "utf-8".into());
    let text = if let Some(encoding) =
        encoding_rs::Encoding::for_label_no_replacement(label.to_ascii_lowercase().as_bytes())
            .filter(|encoding| {
                !encoding.name().eq_ignore_ascii_case("iso-8859-16")
                    && !encoding.name().eq_ignore_ascii_case("x-user-defined")
            }) {
        if let Some(table) = single_byte_tables().get(&encoding.name().to_ascii_lowercase()) {
            // A fixed, source-verified scalar/code-unit lookup avoids per-byte
            // decoder calls and preserves baseline ICU mapping quirks exactly.
            return from_utf16_units(
                &bytes
                    .iter()
                    .map(|b| table[usize::from(*b)])
                    .collect::<Vec<_>>(),
            );
        }
        encoding.decode_with_bom_removal(bytes).0.into_owned()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    encode_text(&text)
}
fn single_byte_tables() -> &'static HashMap<String, Vec<u16>> {
    static TABLES: std::sync::OnceLock<HashMap<String, Vec<u16>>> = std::sync::OnceLock::new();
    TABLES.get_or_init(|| {
        let value = json_codec::parse(include_str!("web/single-byte-tables.json"))
            .expect("frozen single-byte mappings");
        value["tables"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(name, text)| {
                let units = utf16_units(text.as_str().unwrap());
                assert_eq!(units.len(), 256, "single-byte table must cover every byte");
                (name.clone(), units)
            })
            .collect()
    })
}

pub fn focus_sections(
    sections: &[String],
    scores: &[f64],
    method: &str,
    max_tokens: f64,
    unicode: u32,
) -> Result<Value, EffectError> {
    let mut ranked = sections
        .iter()
        .enumerate()
        .map(|(i, text)| {
            (
                i,
                text,
                scores
                    .get(i)
                    .copied()
                    .filter(|v| v.is_finite())
                    .unwrap_or(0.0),
            )
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|a, b| b.2.total_cmp(&a.2));
    let top = ranked.first().map(|r| r.2).unwrap_or(0.0);
    let mut picked = Vec::new();
    let mut size = 0.0;
    for (i, text, score) in ranked {
        let keep = if method == "decision" {
            score >= 0.5 || top < 0.5 && picked.len() < 2
        } else {
            score > 0.0 && (picked.len() < 2 || score >= top * 0.5)
        };
        if !keep {
            break;
        }
        let t = raw_tokens(text, unicode)?;
        if size + t > max_tokens && !picked.is_empty() {
            continue;
        }
        picked.push((i, text, score));
        size += t;
        if size >= max_tokens {
            break;
        }
    }
    picked.sort_by_key(|p| p.0);
    let mut others = Vec::new();
    for (i, text) in sections
        .iter()
        .enumerate()
        .filter(|(i, _)| !picked.iter().any(|p| p.0 == *i))
        .take(30)
    {
        let _ = i;
        let h = section_heading(text).unwrap_or(one_line(text, 40)?);
        others.push(one_line(&h, 48)?);
    }
    Ok(
        json!({"picked":picked.into_iter().map(|(i,text,score)|json!({"text":text,"i":i,"score":score})).collect::<Vec<_>>(),"total":sections.len(),"method":method,"others":others}),
    )
}
fn section_heading(text: &str) -> Option<String> {
    static HEADING: std::sync::OnceLock<regress::Regex> = std::sync::OnceLock::new();
    let pattern = HEADING.get_or_init(|| {
        regress::Regex::with_flags(r"^#{1,4} (.+)$", "m").expect("fixed section heading pattern")
    });
    let units = utf16_units(text);
    let found = pattern.find_from_ucs2(&units, 0).next()?;
    let range = found.captures.first()?.as_ref()?;
    Some(from_utf16_units(&units[range.clone()]))
}

fn head(doc: &WebDocument) -> String {
    format!(
        "{}URL: {}",
        if doc.title.is_empty() {
            String::new()
        } else {
            format!("# {}\n", doc.title)
        },
        doc.url
    )
}
pub fn focused_result(doc: &WebDocument, focus: &Value) -> Result<Value, EffectError> {
    let picked = focus["picked"]
        .as_array()
        .ok_or_else(|| error(500, "Invalid focus result"))?;
    let others = focus["others"].as_array().cloned().unwrap_or_default();
    Ok(
        json!({"text":format!("{}\n(question-focused: {} of {} sections, chosen by {}; the text is exact, nothing rewritten)\n\n{}\n\n{}[the whole page: web_fetch(url) without question]",head(doc),picked.len(),js_string(focus.get("total")),if focus["method"]=="decision"{"the decision model"}else{"keyword match"},picked.iter().map(|p|p["text"].as_str().unwrap_or("")).collect::<Vec<_>>().join("\n\n…\n\n"),if others.is_empty(){String::new()}else{format!("Other sections: {}\n",others.iter().map(|v|js_string(Some(v))).collect::<Vec<_>>().join(" · "))}),"data":{"url":doc.url,"total":utf16_units(&doc.text).len(),"focused":picked.len(),"method":focus["method"]}}),
    )
}
pub fn page_part(
    doc: &WebDocument,
    from: f64,
    budget: f64,
    unicode: u32,
) -> Result<Value, EffectError> {
    let units = utf16_units(&doc.text);
    let mut end = (units.len() as f64).min(from + budget * 4.0);
    while end > from + 500.0
        && raw_tokens(&slice(&doc.text, from as usize, end as usize), unicode)? > budget
    {
        end = from + ((end - from) * 0.8).floor();
    }
    if end < (units.len() as f64) {
        if let Some(cut) = units[..(end as usize).saturating_add(1).min(units.len())]
            .iter()
            .rposition(|u| *u == 10)
        {
            if (cut as f64) > from + (end - from) * 0.6 {
                end = cut as f64;
            }
        }
    }
    let part = slice(&doc.text, from as usize, end as usize);
    Ok(
        json!({"text":format!("{}\n(characters {}–{} of {})\n\n{part}{}",head(doc),js_string(Some(&json!(from))),js_string(Some(&json!(end))),units.len(),if end<(units.len()as f64){format!("\n\n[continues: web_fetch(url, offset={})]",js_string(Some(&json!(end))))}else{String::new()}),"data":{"url":doc.url,"total":units.len(),"end":end}}),
    )
}
fn encode_component(s: &str) -> Result<String, EffectError> {
    let u = utf16_units(s);
    if char::decode_utf16(u).any(|r| r.is_err()) {
        return Err(error(400, "URI malformed"));
    }
    let mut out = String::new();
    for b in sql_text(s).bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    Ok(out)
}
fn number(v: Option<&Value>, default: f64) -> f64 {
    v.filter(|v| truthy(v))
        .and_then(Value::as_f64)
        .unwrap_or(default)
}
fn slice(s: &str, start: usize, end: usize) -> String {
    let u = utf16_units(s);
    let start = start.min(u.len());
    let end = end.min(u.len()).max(start);
    from_utf16_units(&u[start..end])
}
fn raw_tokens(s: &str, unicode: u32) -> Result<f64, EffectError> {
    Ok(
        compute("tokens.raw", json!({"text":s,"unicodeVersion":unicode}))?
            .as_f64()
            .unwrap_or(0.0),
    )
}
fn one_line(s: &str, max: usize) -> Result<String, EffectError> {
    Ok(
        compute("harness.format.oneLine", json!({"value":s,"max":max}))?
            .as_str()
            .unwrap_or("")
            .into(),
    )
}
fn compute(op: &str, payload: Value) -> Result<Value, EffectError> {
    let input = stringify_js(&payload).map_err(|e| error(500, encode_text(&e.to_string())))?;
    let out = tepora_core::compute_json(op, &input)
        .map_err(|e| error(500, encode_text(&e.to_string())))?;
    json_codec::parse(&out).map_err(|e| error(500, encode_text(&e.to_string())))
}
fn check_cancel(c: &RequestCancellation) -> Result<(), EffectError> {
    if c.is_cancelled() {
        Err(EffectError::cancelled(false))
    } else {
        Ok(())
    }
}
fn error(status: u16, message: impl Into<String>) -> EffectError {
    EffectError {
        error: json!({"message":message.into(),"status":status}),
        aborted: false,
    }
}
fn network_error(e: NetworkError) -> EffectError {
    EffectError {
        error: json!({"message":encode_text(&e.message),"status":e.status,"blocked":e.blocked}),
        aborted: e.cancelled,
    }
}
fn message(e: &EffectError) -> String {
    e.error["message"]
        .as_str()
        .unwrap_or("Web request failed")
        .into()
}
#[cfg(test)]
#[path = "web/tests.rs"]
mod tests;
