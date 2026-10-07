//! Source semantic memory, using the one capability and SQLite authorities.
//! Vectors are disposable caches. Original confirmed documents and current
//! consent are rechecked before egress and again before cache publication.
use crate::{
    capabilities::{Capabilities, CapabilityError},
    network::{EgressGuard, NetworkError, RequestCancellation},
    ApiError,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fmt,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
};
use tepora_core::{
    js_value::truthy,
    json_codec::{self, from_utf16_units, utf16_units},
};
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Copy, Debug)]
pub struct Access {
    pub recipient_private: bool,
    pub share: bool,
    pub allow_external: bool,
}
impl Default for Access {
    fn default() -> Self {
        Self {
            recipient_private: true,
            share: false,
            allow_external: false,
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct SearchOptions {
    pub access: Access,
    pub limit: usize,
}
impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            access: Access::default(),
            limit: 8,
        }
    }
}
#[derive(Clone, Default)]
pub struct MemorySnapshot {
    pub documents: Vec<Value>,
    pub vectors: HashMap<String, Value>,
}
#[derive(Clone)]
pub struct VectorProposal {
    pub before: Value,
    pub vector: Value,
}
/// Short synchronous reads/transactions on Workspace's existing owner only.
pub trait SemanticState: Send + Sync {
    fn snapshot(&self) -> Result<MemorySnapshot, ApiError>;
    fn current(&self, ids: &[String]) -> Result<Vec<Value>, ApiError>;
    /// Current capability identity and each document's consent/content/scope
    /// comparison must share the vector writes' single transaction.
    fn commit_vectors(
        &self,
        profile: &Value,
        proposals: &[VectorProposal],
    ) -> Result<usize, ApiError>;
}
struct Active {
    cancel: RequestCancellation,
    ids: Vec<String>,
}
#[derive(Default)]
struct Lifecycle {
    closed: bool,
    next: u64,
    active: HashMap<u64, Active>,
}
#[derive(Default)]
struct Background {
    task: Option<tokio::task::JoinHandle<()>>,
    cancel: Option<RequestCancellation>,
    sessions: Vec<String>,
    unscoped: bool,
}
struct Inner {
    source: Arc<dyn SemanticState>,
    capabilities: Capabilities,
    busy: AtomicBool,
    lifecycle: Mutex<Lifecycle>,
    background: Mutex<Background>,
    drained: tokio::sync::Notify,
}
#[derive(Clone)]
pub struct SemanticMemory {
    inner: Arc<Inner>,
}
struct Operation {
    inner: Weak<Inner>,
    id: u64,
    cancel: RequestCancellation,
}
impl Drop for Operation {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(inner) = self.inner.upgrade() {
            inner
                .lifecycle
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .active
                .remove(&self.id);
            inner.drained.notify_waiters();
        }
    }
}
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl SemanticMemory {
    pub fn new(source: Arc<dyn SemanticState>, capabilities: Capabilities) -> Self {
        Self {
            inner: Arc::new(Inner {
                source,
                capabilities,
                busy: AtomicBool::new(false),
                lifecycle: Mutex::new(Lifecycle::default()),
                background: Mutex::new(Background::default()),
                drained: tokio::sync::Notify::new(),
            }),
        }
    }
    pub fn configured(&self) -> bool {
        self.inner
            .capabilities
            .get()
            .is_ok_and(|r| truthy(&r["routes"]["embedding"]))
    }
    fn operation(&self, ids: Vec<String>) -> Result<Operation, CapabilityError> {
        let mut lifecycle = self
            .inner
            .lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if lifecycle.closed {
            return Err(changed("Semantic memory is closed"));
        }
        let id = lifecycle.next;
        lifecycle.next = lifecycle.next.wrapping_add(1);
        let cancel = RequestCancellation::new();
        lifecycle.active.insert(
            id,
            Active {
                cancel: cancel.clone(),
                ids,
            },
        );
        Ok(Operation {
            inner: Arc::downgrade(&self.inner),
            id,
            cancel,
        })
    }
    /// Called after a memory mutation commits, before that mutation is acknowledged.
    /// Already-transmitted bytes cannot be recalled; queued/active work is revoked.
    pub fn invalidate_memory(&self, id: &str) {
        let lifecycle = self
            .inner
            .lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for active in lifecycle
            .active
            .values()
            .filter(|a| a.ids.iter().any(|v| v == id))
        {
            active.cancel.cancel();
        }
    }
    pub fn cancel_all(&self) {
        for active in self
            .inner
            .lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active
            .values()
        {
            active.cancel.cancel();
        }
        if let Some(cancel) = &self
            .inner
            .background
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .cancel
        {
            cancel.cancel();
        }
    }
    pub fn close(&self) {
        let mut lifecycle = self
            .inner
            .lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        lifecycle.closed = true;
        for active in lifecycle.active.values() {
            active.cancel.cancel();
        }
        drop(lifecycle);
        if let Some(cancel) = &self
            .inner
            .background
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .cancel
        {
            cancel.cancel();
        }
    }
    /// One bounded, deduplicated best-effort cache job. The memory receipt does
    /// not wait for embeddings and does not promise a successful cache update.
    pub fn schedule_index(&self, executor: &tokio::runtime::Handle) {
        self.schedule_index_for(executor, None);
    }
    pub fn schedule_index_for(&self, executor: &tokio::runtime::Handle, session: Option<&str>) {
        let mut background = self
            .inner
            .background
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if background
            .task
            .as_ref()
            .is_some_and(|task| !task.is_finished())
        {
            if let Some(session) = session {
                if !background.sessions.iter().any(|id| id == session) {
                    background.sessions.push(session.to_owned());
                }
            } else {
                background.unscoped = true;
            }
            return;
        }
        if self
            .inner
            .lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .closed
        {
            return;
        }
        let cancel = RequestCancellation::new();
        let task_cancel = cancel.clone();
        let owner = self.clone();
        background.sessions = session.into_iter().map(str::to_owned).collect();
        background.unscoped = session.is_none();
        background.cancel = Some(cancel);
        background.task = Some(executor.spawn(async move {
            let _ = owner.index(Access::default(), &task_cancel).await;
        }));
    }
    /// A session Stop revokes its coalesced cache job without cancelling other
    /// sessions' foreground searches, which have their own actor effect scopes.
    pub fn cancel_session(&self, session: &str) {
        let cancel = {
            let mut background = self
                .inner
                .background
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let owned = background.sessions.iter().any(|id| id == session);
            background.sessions.retain(|id| id != session);
            (owned && background.sessions.is_empty() && !background.unscoped)
                .then(|| background.cancel.clone())
                .flatten()
        };
        if let Some(cancel) = cancel {
            cancel.cancel();
            // Fence an already-started synchronous cache publication.
            drop(
                self.inner
                    .lifecycle
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()),
            );
        }
    }
    /// Workspace calls this before closing its Store. No mutex guard crosses await.
    pub async fn close_and_drain(&self) {
        self.close();
        let task = {
            let mut background = self
                .inner
                .background
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(cancel) = background.cancel.take() {
                cancel.cancel();
            }
            background.task.take()
        };
        if let Some(task) = task {
            let _ = task.await;
        }
        loop {
            let notified = self.inner.drained.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.active_count() == 0 {
                break;
            }
            notified.await;
        }
    }
    pub fn active_count(&self) -> usize {
        self.inner
            .lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active
            .len()
    }
    pub async fn index(
        &self,
        access: Access,
        caller: &RequestCancellation,
    ) -> Result<Value, CapabilityError> {
        check(caller)?;
        if self
            .inner
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(CapabilityError::new(429, "意味検索の索引を更新中です。"));
        }
        let _busy = Busy(&self.inner.busy);
        let profile = self.inner.capabilities.pin("embedding")?;
        let external = profile["domain"] != "device";
        if external && !access.allow_external {
            return Err(CapabilityError::new(
                403,
                "埋め込み先へ記憶を送る許可が必要です。",
            ));
        }
        let snapshot = self.inner.source.snapshot()?;
        let docs = snapshot
            .documents
            .into_iter()
            .filter(|d| allowed(d, access) && (!external || d["scope"] == "shared"))
            .collect::<Vec<_>>();
        let pending = docs
            .iter()
            .filter(|d| {
                snapshot.vectors.get(id(d)).is_none_or(|v| {
                    v["identity"] != profile["identity"]
                        || v["contentHash"] != content_hash(text(d, "content"))
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        let batch = pending.iter().take(24).cloned().collect::<Vec<_>>();
        if batch.is_empty() {
            return Ok(json!({"indexed":docs.len(),"remaining":0}));
        }
        let operation = self.operation(batch.iter().map(|d| id(d).to_owned()).collect())?;
        let authority = Arc::new(DocumentGuard {
            source: self.inner.source.clone(),
            expected: batch.clone(),
            access,
            external,
            cancel: operation.cancel.clone(),
        });
        authority.check()?;
        let inputs = json!(batch
            .iter()
            .map(|d| slice(text(d, "content"), 12000))
            .collect::<Vec<_>>());
        let result = tokio::select! {biased;
            error=caller.cancelled()=>return Err(error.into()),
            error=operation.cancel.cancelled()=>return Err(error.into()),
            result=self.inner.capabilities.embed_guarded(&inputs,Some(&profile),&operation.cancel,Some(authority))=>result?
        };
        check(caller)?;
        check(&operation.cancel)?;
        let proposals=batch.iter().enumerate().map(|(index,before)|VectorProposal{before:before.clone(),vector:json!({"id":before["id"],"identity":profile["identity"],"contentHash":content_hash(text(before,"content")),"vector":result["vectors"][index],"dimensions":result["dimensions"]})}).collect::<Vec<_>>();
        // Serialize final publication against Stop/Close. Once cancellation
        // returns, no already-admitted operation can publish a cache write.
        let added = {
            let lifecycle = self
                .inner
                .lifecycle
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            check(caller)?;
            check(&operation.cancel)?;
            if lifecycle.closed {
                return Err(changed("Semantic memory is closed"));
            }
            self.inner.source.commit_vectors(&profile, &proposals)?
        };
        let current = self.inner.source.snapshot()?;
        let indexed = docs
            .iter()
            .filter(|d| {
                current
                    .vectors
                    .get(id(d))
                    .is_some_and(|v| v["identity"] == profile["identity"])
            })
            .count();
        Ok(
            json!({"added":added,"indexed":indexed,"remaining":pending.len().saturating_sub(added),"truncatedDocuments":batch.iter().filter(|d|utf16_units(text(d,"content")).len()>12000).count()}),
        )
    }
    pub async fn search(
        &self,
        query: &Value,
        options: SearchOptions,
        caller: &RequestCancellation,
    ) -> Result<Value, CapabilityError> {
        validate_query(query)?;
        if !(1..=30).contains(&options.limit) {
            return Err(CapabilityError::new(400, "Invalid search limit"));
        }
        check(caller)?;
        let operation = self.operation(vec![])?;
        let snapshot = self.inner.source.snapshot()?;
        let docs = snapshot
            .documents
            .into_iter()
            .filter(|d| allowed(d, options.access))
            .collect::<Vec<_>>();
        let lexical = lexical_ranking(query, &docs);
        let mut semantic = vec![];
        let mut note = "キーワード検索";
        let mut indexed = 0;
        if let Ok(profile) = self.inner.capabilities.pin("embedding") {
            if profile["domain"] == "device" || options.access.allow_external {
                let query_input = json!([query]);
                let result = tokio::select! {biased;
                    error=caller.cancelled()=>return Err(error.into()),
                    error=operation.cancel.cancelled()=>return Err(error.into()),
                    result=self.inner.capabilities.embed(&query_input,Some(&profile),&operation.cancel)=>result
                };
                check(caller)?;
                check(&operation.cancel)?;
                let ranked = result.and_then(|result| {
                    let current = self.inner.source.snapshot()?;
                    semantic_ranking(&docs, &current.vectors, &profile, &result)
                });
                match ranked {
                    Ok(ranking) => {
                        indexed = ranking.len();
                        semantic = ranking;
                        note = "意味＋キーワード検索";
                    }
                    Err(_) => note = "意味検索の接続が使えないため、キーワード検索で続けています。",
                }
            }
        }
        let chosen = rrf(&lexical, &semantic, options.limit);
        let current = self.inner.source.current(&chosen)?;
        let hits = chosen
            .iter()
            .filter_map(|id| {
                let before = docs.iter().find(|d| self::id(d) == id)?;
                let now = current.iter().find(|d| self::id(d) == id)?;
                (allowed(now, options.access) && now["content"] == before["content"])
                    .then(|| before.clone())
            })
            .collect::<Vec<_>>();
        check(caller)?;
        check(&operation.cancel)?;
        Ok(
            json!({"hits":hits,"note":note,"indexed":indexed,"total":docs.len(),"coverageComplete":indexed==docs.len(),"automaticLearning":false}),
        )
    }
    pub async fn rank(
        &self,
        query: &Value,
        candidates: &Value,
        profile: Option<&Value>,
        caller: &RequestCancellation,
    ) -> Result<Value, CapabilityError> {
        validate_query(query)?;
        let values = candidates
            .as_array()
            .filter(|a| {
                (1..=24).contains(&a.len())
                    && a.iter().all(|v| {
                        v.as_str().is_some_and(|s| {
                            let n = utf16_units(s).len();
                            n > 0 && n <= 4000
                        })
                    })
            })
            .ok_or_else(|| CapabilityError::new(400, "Rank 1–24 short candidates"))?;
        let operation = self.operation(vec![])?;
        let mut inputs = vec![query.clone()];
        inputs.extend(values.iter().cloned());
        let inputs = json!(inputs);
        let result = tokio::select! {biased;
            error=caller.cancelled()=>return Err(error.into()),
            error=operation.cancel.cancelled()=>return Err(error.into()),
            result=self.inner.capabilities.embed(&inputs,profile,&operation.cancel)=>result?
        };
        check(caller)?;
        check(&operation.cancel)?;
        let mut rows = values
            .iter()
            .enumerate()
            .map(|(index, _)| {
                cosine(&result["vectors"][0], &result["vectors"][index + 1])
                    .map(|score| (index, score))
            })
            .collect::<Result<Vec<_>, _>>()?;
        rows.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        Ok(json!(rows
            .into_iter()
            .map(|(index, similarity)| json!({"index":index,"similarity":similarity}))
            .collect::<Vec<_>>()))
    }
}
struct DocumentGuard {
    source: Arc<dyn SemanticState>,
    expected: Vec<Value>,
    access: Access,
    external: bool,
    cancel: RequestCancellation,
}
impl fmt::Debug for DocumentGuard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SemanticDocumentGuard(<private>)")
    }
}
impl EgressGuard for DocumentGuard {
    fn check(&self) -> Result<(), NetworkError> {
        if let Some(error) = self.cancel.error() {
            return Err(error);
        }
        let ids = self
            .expected
            .iter()
            .map(|d| id(d).to_owned())
            .collect::<Vec<_>>();
        let current = self
            .source
            .current(&ids)
            .map_err(|_| NetworkError::blocked("Semantic document authority is unavailable"))?;
        for before in &self.expected {
            let now = current.iter().find(|d| id(d) == id(before));
            if now.is_none_or(|now| {
                !allowed(now, self.access)
                    || now["content"] != before["content"]
                    || now["scope"] != before["scope"]
                    || self.external && (!self.access.allow_external || now["scope"] != "shared")
            }) {
                return Err(NetworkError::blocked(
                    "Semantic document consent or content changed",
                ));
            }
        }
        Ok(())
    }
}
pub fn allowed(doc: &Value, access: Access) -> bool {
    truthy(&doc["confirmed"])
        && (access.recipient_private || access.share && doc["scope"] == "shared")
}
pub fn content_hash(content: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(json_codec::sql_text(content).as_bytes())
    )
}
pub fn same_document(before: &Value, now: &Value) -> bool {
    truthy(&now["confirmed"])
        && now["content"] == before["content"]
        && now["scope"] == before["scope"]
}
fn id(doc: &Value) -> &str {
    text(doc, "id")
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn slice(s: &str, max: usize) -> String {
    let u = utf16_units(s);
    from_utf16_units(&u[..u.len().min(max)])
}
fn check(cancel: &RequestCancellation) -> Result<(), CapabilityError> {
    cancel.error().map_or(Ok(()), |e| Err(e.into()))
}
fn changed(message: &str) -> CapabilityError {
    let mut e = CapabilityError::new(409, message);
    e.invalidated = true;
    e
}
fn validate_query(query: &Value) -> Result<(), CapabilityError> {
    let valid=query.as_str().is_some_and(|s|{
        let u=utf16_units(s);u.len()<=4000&&u.iter().any(|c|!matches!(*c,0x0009..=0x000d|0x20|0xa0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff))
    });
    if valid {
        Ok(())
    } else {
        Err(CapabilityError::new(
            400,
            "query: 1–4000 characters required",
        ))
    }
}
pub fn cosine(a: &Value, b: &Value) -> Result<f64, CapabilityError> {
    let (Some(a), Some(b)) = (a.as_array(), b.as_array()) else {
        return Err(CapabilityError::new(400, "Incompatible embedding spaces"));
    };
    if a.len() != b.len() || a.is_empty() {
        return Err(CapabilityError::new(400, "Incompatible embedding spaces"));
    }
    let (mut dot, mut aa, mut bb) = (0.0, 0.0, 0.0);
    for (a, b) in a.iter().zip(b) {
        let a = a
            .as_f64()
            .filter(|v| v.is_finite())
            .ok_or_else(|| CapabilityError::new(400, "Invalid vector"))?;
        let b = b
            .as_f64()
            .filter(|v| v.is_finite())
            .ok_or_else(|| CapabilityError::new(400, "Invalid vector"))?;
        dot += a * b;
        aa += a * a;
        bb += b * b;
    }
    if !(aa > 0.0 && bb > 0.0) {
        return Err(CapabilityError::new(400, "Zero embedding"));
    }
    Ok(dot / (aa * bb).sqrt())
}
fn lexical_ranking(query: &Value, docs: &[Value]) -> Vec<(String, f64)> {
    let terms = tepora_core::store_domain::search_tokens(query, 40, 17);
    let mut ranking = docs
        .iter()
        .filter_map(|d| {
            let normalized = json_codec::sql_text(text(d, "content"))
                .nfkc()
                .collect::<String>()
                .to_lowercase();
            let score = terms
                .iter()
                .filter(|term| normalized.contains(term.as_str()))
                .count();
            (score > 0).then(|| (id(d).to_owned(), score as f64))
        })
        .collect::<Vec<_>>();
    ranking.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    ranking
}
fn semantic_ranking(
    docs: &[Value],
    vectors: &HashMap<String, Value>,
    profile: &Value,
    result: &Value,
) -> Result<Vec<(String, f64)>, CapabilityError> {
    let mut ranking = vec![];
    for d in docs
        .iter()
        .filter(|d| profile["domain"] == "device" || d["scope"] == "shared")
    {
        if let Some(e) = vectors.get(id(d)).filter(|e| {
            e["identity"] == profile["identity"]
                && e["contentHash"] == content_hash(text(d, "content"))
                && e["dimensions"] == result["dimensions"]
        }) {
            ranking.push((
                id(d).to_owned(),
                cosine(&result["vectors"][0], &e["vector"])?,
            ));
        }
    }
    ranking.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    Ok(ranking)
}
fn rrf(lexical: &[(String, f64)], semantic: &[(String, f64)], limit: usize) -> Vec<String> {
    let mut scores: Vec<(String, f64)> = vec![];
    for ranking in [
        lexical.to_vec(),
        semantic
            .iter()
            .filter(|(_, score)| *score > 0.0)
            .cloned()
            .collect(),
    ] {
        for (i, (id, _)) in ranking.into_iter().take(60).enumerate() {
            let score = 1.0 / (60 + i) as f64;
            if let Some(row) = scores.iter_mut().find(|(key, _)| *key == id) {
                row.1 += score;
            } else {
                scores.push((id, score));
            }
        }
    }
    scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scores.into_iter().take(limit).map(|(id, _)| id).collect()
}
#[cfg(test)]
mod tests;

/// Exact memory_search display; this is data returned to the normal receipt host.
pub fn tool_result(hits: &[Value]) -> Value {
    let lines = hits
        .iter()
        .map(|memory| {
            format!(
                "- ({}{}) {}",
                slice(text(memory, "id"), 8),
                if truthy(&memory["title"]) {
                    format!(" {}", tepora_core::js_value::js_string(memory.get("title")))
                } else {
                    String::new()
                },
                tepora_core::js_value::js_string(memory.get("content"))
            )
        })
        .collect::<Vec<_>>();
    json!({"text":if lines.is_empty(){"No memories found.".to_owned()}else{lines.join("\n")}})
}
