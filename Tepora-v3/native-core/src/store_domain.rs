//! Workspace document domain shared by the Node adapter and standalone Rust host.
//! All strings below use json_codec's lossless UTF-16 transport. Imported documents
//! remain open records: only explicit authority fields and references are changed.
use crate::{invalid, js_value, json_codec, CoreError, CoreResult, NativeState, MAX_SAFE_INTEGER};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};
use unicode_normalization::UnicodeNormalization;

const EXPORT_KINDS: &[&str] = &[
    "memory",
    "artifact",
    "revision",
    "skill",
    "job",
    "message",
    "checkpoint",
    "effect",
    "asset",
    "note",
    "evidence",
    "routine",
    "plan",
];
const NULL: Value = Value::Null;
fn get<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&NULL)
}
fn opt(value: &Value, key: &str, default: Value) -> Value {
    value.get(key).cloned().unwrap_or(default)
}
fn fallback<'a>(value: &'a Value, default: &'a Value) -> &'a Value {
    if js_value::truthy(value) {
        value
    } else {
        default
    }
}
fn truncate(text: &str, count: usize) -> String {
    json_codec::from_utf16_units(
        &json_codec::utf16_units(text)
            .into_iter()
            .take(count)
            .collect::<Vec<_>>(),
    )
}
fn whitespace(unit: &u16) -> bool {
    matches!(unit, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
fn checked_text(value: &Value, name: &str, max: usize) -> CoreResult<String> {
    let error = || invalid(format!("{name}: 1–{max} characters required"));
    let text = value.as_str().ok_or_else(error)?;
    let units = json_codec::utf16_units(text);
    let first = units
        .iter()
        .position(|u| !whitespace(u))
        .ok_or_else(error)?;
    if units.len() > max {
        return Err(error());
    }
    let last = units.iter().rposition(|u| !whitespace(u)).unwrap() + 1;
    Ok(json_codec::from_utf16_units(&units[first..last]))
}
fn unicode_version(payload: &Value) -> u64 {
    payload
        .get("unicodeVersion")
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str()?.split('.').next()?.parse().ok())
        })
        .unwrap_or(17)
}

/// Matches core/search.mjs: NFKC, lower-case, Unicode L/N/underscore runs,
/// overlapping Han/Hiragana/Katakana bigrams, first 30,000 terms then uniqueness.
/// The caller selects the JS runtime Unicode version; standalone Rust uses 17.
pub fn indexed_text(doc: &Value, unicode: u64) -> String {
    // regex-syntax 0.8.11 ships Unicode 16. These additive ranges are the
    // Unicode 17 L/N and CJK Script deltas, checked against Node 24's Unicode
    // 17 property escapes; Unicode 16 requests keep the unchanged base tables.
    const WORDS_ADDED_17: &str = r"\u{88f}\u{c5c}\u{cdc}\u{a7ce}-\u{a7cf}\u{a7d2}\u{a7d4}\u{a7f1}\u{10940}-\u{10959}\u{10ec5}-\u{10ec7}\u{11db0}-\u{11ddb}\u{11de0}-\u{11de9}\u{16ea0}-\u{16eb8}\u{16ebb}-\u{16ed3}\u{16ff2}-\u{16ff6}\u{187f8}-\u{187ff}\u{18d09}-\u{18d1e}\u{18d80}-\u{18df2}\u{1e6c0}-\u{1e6de}\u{1e6e0}-\u{1e6e2}\u{1e6e4}-\u{1e6e5}\u{1e6e7}-\u{1e6ed}\u{1e6f0}-\u{1e6f4}\u{1e6fe}-\u{1e6ff}\u{2b73a}-\u{2b73f}\u{2cea2}-\u{2cead}\u{323b0}-\u{33479}";
    const CJK_ADDED_17: &str =
        r"\u{16ff2}-\u{16ff6}\u{2b73a}-\u{2b73f}\u{2cea2}-\u{2cead}\u{323b0}-\u{33479}";
    static WORDS_16: OnceLock<Regex> = OnceLock::new();
    static WORDS_17: OnceLock<Regex> = OnceLock::new();
    static CJK_16: OnceLock<Regex> = OnceLock::new();
    static CJK_17: OnceLock<Regex> = OnceLock::new();
    static NEW: OnceLock<Regex> = OnceLock::new();
    let words = if unicode < 17 {
        WORDS_16.get_or_init(|| Regex::new(r"[\p{L}\p{N}_]+").unwrap())
    } else {
        WORDS_17
            .get_or_init(|| Regex::new(&format!(r"[\p{{L}}\p{{N}}_{WORDS_ADDED_17}]+")).unwrap())
    };
    let cjk = if unicode < 17 {
        CJK_16.get_or_init(|| Regex::new(r"[\p{Han}\p{Hiragana}\p{Katakana}]").unwrap())
    } else {
        CJK_17.get_or_init(|| {
            Regex::new(&format!(
                r"[\p{{Han}}\p{{Hiragana}}\p{{Katakana}}{CJK_ADDED_17}]"
            ))
            .unwrap()
        })
    };
    let text = ["title", "name", "content", "input", "output"]
        .into_iter()
        .filter_map(|key| {
            doc.get(key)
                .filter(|v| js_value::truthy(v))
                .map(|v| js_value::js_string(Some(v)))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let text = json_codec::sql_text(&text);
    // Characters unassigned in Unicode 16 cannot create words or normalize into
    // old letters in a Node 22 index. Keep them as separating replacement chars.
    let text = if unicode < 17 {
        NEW.get_or_init(|| Regex::new(r"\P{Age:16.0}").unwrap())
            .replace_all(&text, "\u{fffd}")
            .into_owned()
    } else {
        text
    };
    let normalized = text.nfkc().collect::<String>().to_lowercase();
    let mut terms = Vec::new();
    for token in words.find_iter(&normalized).map(|m| m.as_str()) {
        if cjk.is_match(token) {
            let chars = token.chars().collect::<Vec<_>>();
            if chars.len() == 1 {
                terms.push(token.to_owned());
            }
            for pair in chars.windows(2) {
                terms.push(pair.iter().collect::<String>());
            }
        } else {
            terms.push(token.to_owned());
        }
        if terms.len() >= 30_000 {
            break;
        }
    }
    let mut seen = HashSet::new();
    json_codec::encode_text(
        &terms
            .into_iter()
            .take(30_000)
            .filter(|term| seen.insert(term.clone()))
            .collect::<Vec<_>>()
            .join(" "),
    )
}

fn now(state: &NativeState, payload: &Value) -> CoreResult<String> {
    if let Some(at) = payload.get("at") {
        return at
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| invalid("at must be a string"));
    }
    Ok(state
        .db()?
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
            r.get(0)
        })?)
}
fn uuid(state: &NativeState) -> CoreResult<String> {
    // SQLite's OS-seeded random generator supplies 122 random UUIDv4 bits. This
    // is an identity, never a credential or authorization grant.
    let mut bytes: Vec<u8> = state
        .db()?
        .query_row("SELECT randomblob(16)", [], |r| r.get(0))?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    Ok(format!("{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}", bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5],bytes[6],bytes[7],bytes[8],bytes[9],bytes[10],bytes[11],bytes[12],bytes[13],bytes[14],bytes[15]))
}
fn call(state: &mut NativeState, op: &str, payload: Value) -> CoreResult<Value> {
    state.call_internal(op, payload)
}
fn value(state: &mut NativeState, key: &str) -> CoreResult<Value> {
    call(state, "kv.get", json!({"key":key}))
}
fn list(state: &mut NativeState, kind: &str) -> CoreResult<Vec<Value>> {
    Ok(call(state, "document.list", json!({"kind":kind}))?
        .as_array()
        .unwrap()
        .clone())
}
fn put(state: &mut NativeState, kind: &str, doc: &Value, unicode: u64) -> CoreResult<Value> {
    let terms = if matches!(kind, "memory" | "job") {
        indexed_text(doc, unicode)
    } else {
        String::new()
    };
    state.put_document(kind, doc, &terms)
}
fn emit(state: &mut NativeState, kind: &str, data: &Value, payload: &Value) -> CoreResult<Value> {
    let at = now(state, payload)?;
    call(
        state,
        "event.append",
        json!({"type":kind,"data":data,"at":at,"retention":5000}),
    )
}
fn envelope(value: Value, events: Vec<Value>) -> Value {
    json!({"value":value,"events":events})
}
fn atomic(
    state: &mut NativeState,
    work: impl FnOnce(&mut NativeState) -> CoreResult<Value>,
) -> CoreResult<Value> {
    state.db()?.execute_batch("SAVEPOINT tepora_store_write")?;
    let result = work(state);
    match result {
        Ok(value) => {
            if let Err(error) = state.db()?.execute_batch("RELEASE tepora_store_write") {
                let _ = state
                    .db()?
                    .execute_batch("ROLLBACK TO tepora_store_write; RELEASE tepora_store_write");
                return Err(error.into());
            }
            Ok(value)
        }
        Err(error) => {
            let _ = state
                .db()?
                .execute_batch("ROLLBACK TO tepora_store_write; RELEASE tepora_store_write");
            Err(error)
        }
    }
}

pub fn default_settings() -> Value {
    json!({"dictationEditing":false,"codexEnabled":false,"codexNetwork":false,"codexBinary":"","codexModel":"","companion":"Tepora","provider":"llama.cpp","baseUrl":"http://127.0.0.1:8080/v1","model":"","apiKeyEnv":"","allowCloud":false,"allowNetwork":false,"shareMemory":false,"maxSteps":64,"maxTokens":2048,"concurrency":2,"asrUrl":"","asrStreamUrl":"","asrModel":"Qwen/Qwen3-ASR-1.7B","decisionUrl":"","decisionModel":"multilingual","voiceEnabled":true,"autoAmbient":false,"weatherCity":"","newsUrl":"","runtimeBinary":"","modelPath":"","bravePath":""})
}
fn settings(state: &mut NativeState) -> CoreResult<Value> {
    let mut settings = default_settings();
    let saved = value(state, "settings")?;
    if let Some(text) = saved.as_str() {
        for (index, unit) in json_codec::utf16_units(text).into_iter().enumerate() {
            settings[index.to_string()] = json!(json_codec::from_utf16_units(&[unit]));
        }
    } else {
        crate::extend_object(settings.as_object_mut().unwrap(), &saved);
    }
    Ok(settings)
}
fn snapshot(state: &mut NativeState) -> CoreResult<Value> {
    Ok(
        json!({"seq":call(state,"event.seq",json!({}))?,"artifacts":list(state,"artifact")?,"display":value(state,"display")?,"skills":list(state,"skill")?,"mcp":list(state,"mcp")?,"memories":list(state,"memory")?,"settings":settings(state)?}),
    )
}
fn export(state: &mut NativeState, payload: &Value) -> CoreResult<Value> {
    let mut collections = Map::new();
    for kind in EXPORT_KINDS {
        collections.insert(
            (*kind).into(),
            Value::Array(
                list(state, kind)?
                    .into_iter()
                    .filter(|d| *kind != "skill" || get(d, "source") != "shared")
                    .collect(),
            ),
        );
    }
    let references = list(state, "skill")?
        .into_iter()
        .filter(|d| get(d, "source") == "shared")
        .map(|d| {
            let mut reference = Map::new();
            for key in ["name", "sourcePath", "sha256"] {
                if let Some(v) = d.get(key) {
                    reference.insert(key.into(), v.clone());
                }
            }
            Value::Object(reference)
        })
        .collect::<Vec<_>>();
    let mut messages = list(state, "dialogue-message")?;
    messages.reverse();
    Ok(
        json!({"format":"tepora-v3-context","version":2,"exportedAt":now(state,payload)?,"collections":collections,"sharedReferences":references,
        "display":value(state,"display")?,"dialogueArchive":{"version":1,"session":value(state,"dialogue-session")?,"personas":value(state,"dialogue-personas")?,"messages":messages,"questions":list(state,"worker-question")?,"archives":list(state,"dialogue-archive")?},
        "memories":collections["memory"],"artifacts":collections["artifact"],"skills":collections["skill"]}),
    )
}

fn memory(state: &mut NativeState, payload: &Value) -> CoreResult<Value> {
    let content = checked_text(get(payload, "content"), "memory", 32000)?;
    let options = get(payload, "options");
    let title = opt(options, "title", json!(""));
    let title = match title {
        Value::String(text) => json!(truncate(&text, 160)),
        Value::Array(values) => Value::Array(values.into_iter().take(160).collect()),
        Value::Null => {
            return Err(CoreError(
                "Cannot read properties of null (reading 'slice')".into(),
            ))
        }
        _ => return Err(CoreError("title.slice is not a function".into())),
    };
    let doc = json!({"id":uuid(state)?,"content":content,"title":title,
        "source":opt(options,"source",json!("user")),"confirmed":opt(options,"confirmed",json!(true)),"scope":if get(options,"scope")=="shared" {"shared"} else {"private"},"createdAt":now(state,payload)?});
    let unicode = unicode_version(payload);
    atomic(state, |state| {
        put(state, "memory", &doc, unicode)?;
        let event = emit(state, "memory.updated", &doc, payload)?;
        Ok(envelope(doc, vec![event]))
    })
}
fn artifact(state: &mut NativeState, payload: &Value) -> CoreResult<Value> {
    checked_text(get(payload, "content"), "artifact", 200000)?;
    checked_text(get(payload, "title"), "title", 160)?;
    let options = get(payload, "options");
    let kind = opt(options, "kind", json!("html"));
    if !matches!(kind.as_str(), Some("html" | "markdown" | "text")) {
        return Err(invalid("Unsupported artifact type"));
    }
    let id = match options.get("id") {
        Some(id) => id.clone(),
        None => json!(uuid(state)?),
    };
    let mut args = json!({"doc":{"id":id,"title":get(payload,"title"),"content":get(payload,"content"),"kind":kind,"jobId":opt(options,"jobId",Value::Null),"updatedAt":now(state,payload)?}});
    if let Some(expected) = options.get("expectedVersion") {
        args["expectedVersion"] = expected.clone();
    }
    atomic(state, |state| {
        let doc = call(state, "artifact.put", args)?;
        let event = emit(state, "artifact.updated", &doc, payload)?;
        Ok(envelope(doc, vec![event]))
    })
}
fn memory_patch(state: &mut NativeState, payload: &Value) -> CoreResult<Value> {
    let id = crate::string(payload, "id")?;
    let mut doc = state.document("memory", id)?;
    if doc.is_null() {
        return Err(CoreError("[404] Memory not found".into()));
    }
    let patch = get(payload, "patch");
    if !patch.is_object() {
        return Err(invalid("Memory patch must be an object"));
    }
    if let Some(title) = patch.get("title") {
        if title
            .as_str()
            .is_none_or(|v| json_codec::utf16_units(v).len() > 160)
        {
            return Err(invalid("Invalid memory title"));
        }
        doc["title"] = title.clone();
    }
    if let Some(content) = patch.get("content") {
        doc["content"] = json!(checked_text(content, "text", 32000)?);
    }
    if let Some(confirmed) = patch.get("confirmed") {
        if !confirmed.is_boolean() {
            return Err(invalid("Invalid confirmed"));
        }
        doc["confirmed"] = confirmed.clone();
    }
    if let Some(scope) = patch.get("scope") {
        if !matches!(scope.as_str(), Some("shared" | "private")) {
            return Err(invalid("Invalid scope"));
        }
        doc["scope"] = scope.clone();
    }
    atomic(state, |state| {
        put(state, "memory", &doc, unicode_version(payload))?;
        let event = emit(state, "memory.updated", &doc, payload)?;
        Ok(envelope(doc, vec![event]))
    })
}
fn memory_delete(state: &mut NativeState, payload: &Value) -> CoreResult<Value> {
    let id = crate::string(payload, "id")?;
    if state.document("memory", id)?.is_null() {
        return Err(CoreError("[404] Memory not found".into()));
    }
    atomic(state, |state| {
        call(state, "document.remove", json!({"kind":"memory","id":id}))?;
        let event = emit(state, "memory.deleted", &json!({"id":id}), payload)?;
        Ok(envelope(json!({"deleted":true}), vec![event]))
    })
}

fn dialogue_archives(
    state: &NativeState,
    bundle: &Value,
    payload: &Value,
) -> CoreResult<Vec<Value>> {
    let archive = get(bundle, "dialogueArchive");
    if !js_value::truthy(archive) {
        return Ok(vec![]);
    }
    let empty = json!([]);
    let archives = fallback(get(archive, "archives"), &empty);
    if get(archive, "version").as_f64() != Some(1.0)
        || !get(archive, "messages").is_array()
        || archives.as_array().is_none_or(|a| a.len() > 1000)
    {
        return Err(invalid("Invalid dialogue archive"));
    }
    let mut result = Vec::new();
    for source in std::iter::once(archive).chain(archives.as_array().unwrap()) {
        let messages = get(source, "messages")
            .as_array()
            .filter(|a| a.len() <= 100000)
            .ok_or_else(|| invalid("Invalid dialogue archive"))?;
        let mut prepared = Vec::new();
        for message in messages {
            if !matches!(
                get(message, "role").as_str(),
                Some("user" | "assistant" | "tool" | "system")
            ) {
                return Err(invalid("Invalid archived dialogue role"));
            }
            checked_text(get(message, "content"), "archived dialogue content", 100000)?;
            let source_job = fallback(get(message, "jobId"), get(message, "sourceJobId"));
            let source_question =
                fallback(get(message, "questionId"), get(message, "sourceQuestionId"));
            prepared.push(json!({"role":get(message,"role"),"content":get(message,"content"),"kind":truncate(&js_value::js_string(Some(fallback(get(message,"kind"),&json!("archive")))),80),"at":truncate(&js_value::js_string(Some(fallback(get(message,"at"),&json!("")))),100),
                "sourceJobId":source_job.as_str().map(|s|truncate(s,300)),"sourceQuestionId":source_question.as_str().map(|s|truncate(s,300)),"readOnly":true}));
        }
        let mut personas = Map::new();
        for role in ["character", "worker"] {
            let persona = get(get(source, "personas"), role);
            if js_value::truthy(persona) {
                let instructions = get(persona, "instructions")
                    .as_str()
                    .filter(|s| json_codec::utf16_units(s).len() <= 8000)
                    .unwrap_or("");
                personas.insert(role.into(),json!({"name":checked_text(get(persona,"name"),"archived persona name",80)?,"instructions":instructions}));
            }
        }
        let source_session = fallback(
            get(get(source, "session"), "id"),
            get(source, "sourceSessionId"),
        );
        result.push(json!({"id":uuid(state)?,"sourceSessionId":source_session.as_str().map(|s|truncate(s,300)),"personas":personas,"messages":prepared,"importedAt":now(state,payload)?,"readOnly":true,
            "note":"Imported dialogue archive. No live session, question, execution or sharing permission was restored."}));
    }
    Ok(result)
}
fn import(state: &mut NativeState, payload: &Value) -> CoreResult<Value> {
    let bundle = get(payload, "bundle");
    if get(bundle, "format") != "tepora-v3-context"
        || !matches!(get(bundle, "version").as_f64(), Some(1.0 | 2.0))
    {
        return Err(invalid("Invalid context format"));
    }
    let legacy = json!({"memory":fallback(get(bundle,"memories"),&json!([]))});
    let collections = if get(bundle, "version").as_f64() == Some(2.0) {
        get(bundle, "collections")
    } else {
        &legacy
    };
    if !collections.is_object() {
        return Err(invalid("Invalid collections"));
    }
    let archives = dialogue_archives(state, bundle, payload)?;
    let mut ids = HashMap::new();
    let mut prepared = Vec::new();
    let mut counts = Map::new();
    for &kind in EXPORT_KINDS {
        let empty = json!([]);
        let docs = fallback(get(collections, kind), &empty)
            .as_array()
            .filter(|a| a.len() <= 100000)
            .ok_or_else(|| invalid("Too many documents"))?;
        counts.insert(kind.into(), json!(docs.len()));
        for raw in docs {
            if !raw.is_object() {
                return Err(invalid("Invalid document"));
            }
            let mut doc = raw.clone();
            let old = if js_value::truthy(get(&doc, "id")) {
                get(&doc, "id").clone()
            } else {
                json!(uuid(state)?)
            };
            let old = old
                .as_str()
                .ok_or_else(|| invalid("Duplicate id in import"))?
                .to_owned();
            let key = format!("{kind}:{old}");
            if ids.contains_key(&key) {
                return Err(invalid("Duplicate id in import"));
            }
            let id = uuid(state)?;
            doc["id"] = json!(id);
            ids.insert(key, id);
            if matches!(
                kind,
                "memory" | "artifact" | "revision" | "skill" | "message"
            ) {
                checked_text(
                    get(&doc, "content"),
                    "content",
                    if kind == "memory" { 32000 } else { 200000 },
                )?;
            }
            if matches!(kind, "artifact" | "revision") {
                if !matches!(
                    get(&doc, "kind").as_str(),
                    Some("text" | "markdown" | "html")
                ) {
                    return Err(invalid("Invalid artifact kind"));
                }
                checked_text(get(&doc, "title"), "title", 160)?;
                let version = get(&doc, "version").as_f64();
                if version
                    .is_none_or(|n| n < 1.0 || n > MAX_SAFE_INTEGER as f64 || n.fract() != 0.0)
                {
                    return Err(invalid("Invalid artifact version"));
                }
            }
            let overrides = match kind {
                "memory" => json!({"confirmed":false,"scope":"private","source":"import"}),
                "skill" => json!({"enabled":false,"source":"import"}),
                "routine" => {
                    if !get(&doc, "lastJobId").is_null() && !get(&doc, "lastJobId").is_string() {
                        return Err(invalid("Invalid routine last job reference"));
                    }
                    json!({"enabled":false,"status":"proposed","runtime":null,"destination":null,"nextAt":null})
                }
                "plan" => json!({"status":"proposed","jobs":{},"runtime":null,"destination":null}),
                "job" => {
                    json!({"status":"interrupted","approval":null,"resumeBlocked":true,"characterSessionId":null,"dialogueSequence":0,"pendingQuestionId":null,"note":"移行した仕事です。外部操作の状態を確認するまで自動再開しません。"})
                }
                _ => json!({}),
            };
            crate::extend_object(doc.as_object_mut().unwrap(), &overrides);
            prepared.push((kind, doc, old));
        }
    }
    for (kind, doc, old) in &mut prepared {
        for (field, target) in [("jobId", "job"), ("artifactId", "artifact")] {
            if js_value::truthy(get(doc, field)) {
                doc[field] = ids
                    .get(&format!("{target}:{}", js_value::js_string(doc.get(field))))
                    .map_or(Value::Null, |id| json!(id));
            }
        }
        if *kind == "routine" {
            doc["lastJobId"] = get(doc, "lastJobId")
                .as_str()
                .and_then(|id| ids.get(&format!("job:{id}")))
                .map_or(Value::Null, |id| json!(id));
        }
        if *kind == "revision" {
            doc["id"] = json!(format!(
                "{}:{}",
                js_value::js_string(doc.get("artifactId")),
                js_value::js_string(doc.get("version"))
            ));
        }
        if *kind == "checkpoint" {
            if let Some(id) = ids.get(&format!("job:{old}")) {
                doc["id"] = json!(id);
            }
            doc["imported"] = json!(true);
        }
    }
    atomic(state, |state| {
        for (kind, doc, _) in &prepared {
            put(state, kind, doc, unicode_version(payload))?;
        }
        for archive in &archives {
            put(state, "dialogue-archive", archive, unicode_version(payload))?;
        }
        let snap = snapshot(state)?;
        let event = emit(state, "snapshot", &snap, payload)?;
        Ok(envelope(
            json!({"imported":prepared.len(),"dialogueArchiveId":archives.first().map(|a|get(a,"id")),"dialogueArchiveIds":archives.iter().map(|a|get(a,"id")).collect::<Vec<_>>(),"counts":counts,
            "note":"記憶は未確認・非共有、スキルは無効、仕事は中断状態で復元しました。接続先・認証・共通資産は変更しません。"}),
            vec![event],
        ))
    })
}

pub(crate) fn dispatch(state: &mut NativeState, op: &str, payload: &Value) -> CoreResult<Value> {
    match op {
        "store.settings" => Ok(envelope(settings(state)?, vec![])),
        "store.snapshot" => Ok(envelope(snapshot(state)?, vec![])),
        "store.export" => Ok(envelope(export(state, payload)?, vec![])),
        "store.memory" => memory(state, payload),
        "store.artifact" => artifact(state, payload),
        "store.import" => import(state, payload),
        "store.memoryPatch" => memory_patch(state, payload),
        "store.memoryDelete" => memory_delete(state, payload),
        _ => Err(invalid(format!("unknown store operation: {op}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> NativeState {
        NativeState::open(":memory:").unwrap()
    }
    fn run(state: &mut NativeState, op: &str, payload: Value) -> Value {
        state.call(op, payload).unwrap()
    }
    fn execute(state: &mut NativeState, sql: &str) {
        run(state, "exec", json!({"sql":sql}));
    }

    #[test]
    fn workspace_requires_no_node_and_returns_durable_event_envelopes() {
        let mut s = state();
        let r = run(
            &mut s,
            "store.memory",
            json!({"content":"  茶会 ＡＢＣ cafe  ","at":"2026-10-07T00:00:00.000Z","options":{"scope":"shared"}}),
        );
        assert_eq!(r["value"]["content"], "茶会 ＡＢＣ cafe");
        assert_eq!(r["value"]["createdAt"], "2026-10-07T00:00:00.000Z");
        assert_eq!(r["events"][0]["data"], r["value"]);
        assert_eq!(r["events"][0]["seq"], 1);
        let id = r["value"]["id"].as_str().unwrap();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
        assert_eq!(
            run(
                &mut s,
                "document.search",
                json!({"kind":"memory","expression":"\"abc\""})
            )[0],
            r["value"]
        );
        let snap = run(&mut s, "store.snapshot", json!({}));
        assert_eq!(snap["value"]["seq"], 1);
        assert_eq!(snap["events"], json!([]));
        assert_eq!(snap["value"]["settings"], default_settings());
        let bodies = run(
            &mut s,
            "sql",
            json!({"sql":"SELECT body FROM events","args":[],"mode":"all"}),
        );
        assert_eq!(
            serde_json::from_str::<Value>(bodies[0]["body"].as_str().unwrap()).unwrap(),
            json!({"id":id})
        );
    }

    #[test]
    fn js_whitespace_surrogates_and_exact_boundaries_are_preserved() {
        let mut s = state();
        let result = s
            .call_json(
                "store.memory",
                r#"{"content":"\ufeff \ud800 \ue000 \udc00 \ufeff","options":{"title":"😀😀"}}"#,
            )
            .unwrap();
        assert!(result.contains(r#""content":"\ud800  \udc00""#));
        assert!(s
            .call("store.memory", json!({"content":"😀".repeat(16001)}))
            .unwrap_err()
            .to_string()
            .contains("32000"));
        assert_eq!(
            run(&mut s, "store.memory", json!({"content":"\u{85}"}))["value"]["content"],
            "\u{85}"
        );
        assert!(s
            .call("store.memory", json!({"content":"\u{feff}\u{2000}"}))
            .is_err());
        let title = format!("a{}", "😀".repeat(80));
        let raw = s
            .call_json(
                "store.memory",
                &json!({"content":"x","options":{"title":title}}).to_string(),
            )
            .unwrap();
        assert!(raw.contains("\\ud83d"));
        assert_eq!(
            run(
                &mut s,
                "store.artifact",
                json!({"title":" keep ","content":" raw ","options":{"id":"a","kind":"text"}})
            )["value"]["content"],
            " raw "
        );
    }

    #[test]
    fn indexing_handles_nfkc_contextual_case_bigrams_and_version_gating() {
        assert_eq!(
            indexed_text(
                &json!({"content":"ＡＢＣ ΟΣ Ａ茶会語 ｶﾀｶﾅ café e\u{301} १२३ _x Ⅷ"}),
                17
            ),
            "abc ος a茶 茶会 会語 カタ タカ カナ café é १२३ _x viii"
        );
        let new_char = "\u{323b0}";
        assert_eq!(indexed_text(&json!({"content":new_char}), 16), "");
        assert_eq!(indexed_text(&json!({"content":new_char}), 17), new_char);
        assert_eq!(
            indexed_text(
                &json!({"title":["AB",null,"Ｃ"],"content":false,"input":{"x":1}}),
                17
            ),
            "ab c object"
        );
        assert_eq!(indexed_text(&json!({"content":"foo foo"}), 17), "foo");
    }

    #[test]
    fn workspace_write_and_event_failure_roll_back_as_one_unit() {
        let mut s = state();
        execute(&mut s,"CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'event failed'); END");
        assert!(s
            .call("store.memory", json!({"content":"rollbackmarker"}))
            .unwrap_err()
            .to_string()
            .contains("event failed"));
        assert_eq!(
            run(&mut s, "document.list", json!({"kind":"memory"})),
            json!([])
        );
        assert_eq!(
            run(
                &mut s,
                "document.search",
                json!({"kind":"memory","expression":"\"rollbackmarker\""})
            ),
            json!([])
        );
        assert_eq!(run(&mut s, "event.seq", json!({})), 0);
        execute(&mut s, "DROP TRIGGER reject_event; BEGIN IMMEDIATE");
        run(&mut s, "store.memory", json!({"content":"outer"}));
        execute(&mut s, "ROLLBACK");
        assert_eq!(
            run(&mut s, "document.list", json!({"kind":"memory"})),
            json!([])
        );
    }

    #[test]
    fn import_remaps_references_and_retains_unknown_fields_without_restoring_authority() {
        let mut s = state();
        let bundle = json!({"format":"tepora-v3-context","version":2,"settings":{"allowCloud":true},"collections":{
            "memory":[{"id":"m","content":"remember","confirmed":true,"scope":"shared","future":{"nested":5}}],
            "artifact":[{"id":"a","title":"doc","content":"new","kind":"text","version":2,"jobId":"j"}],
            "revision":[{"id":"r","artifactId":"a","title":"doc","content":"old","kind":"text","version":1}],
            "job":[{"id":"j","status":"running","approval":{"approved":true},"characterSessionId":"live"}],
            "checkpoint":[{"id":"j","execution":{"future":true}}],
            "routine":[{"id":"r","lastJobId":"j","enabled":true,"runtime":{"x":1}}],
            "plan":[{"id":"p","jobs":{"live":true},"runtime":"unsafe"}]
        },"dialogueArchive":{"version":1,"messages":[{"role":"user","content":" keep ","jobId":"j","privateGrant":true}],"session":{"id":"live"},"personas":{"character":{"name":" Person ","instructions":" instructions ","grant":true}}}});
        let imported = run(&mut s, "store.import", json!({"bundle":bundle}));
        assert_eq!(imported["value"]["imported"], 7);
        assert_eq!(imported["events"][0]["data"]["seq"], 0);
        assert_eq!(imported["events"][0]["seq"], 1);
        let exported = run(&mut s, "store.export", json!({}));
        let c = &exported["value"]["collections"];
        assert_eq!(c["memory"][0]["future"], json!({"nested":5}));
        assert_eq!(c["memory"][0]["confirmed"], false);
        assert_eq!(c["memory"][0]["scope"], "private");
        assert_eq!(c["job"][0]["status"], "interrupted");
        assert_eq!(c["job"][0]["characterSessionId"], Value::Null);
        assert_eq!(c["routine"][0]["lastJobId"], c["job"][0]["id"]);
        assert_eq!(c["routine"][0]["enabled"], false);
        assert_eq!(c["checkpoint"][0]["id"], c["job"][0]["id"]);
        assert_eq!(c["artifact"][0]["jobId"], c["job"][0]["id"]);
        assert_eq!(
            c["revision"][0]["id"],
            format!("{}:1", c["artifact"][0]["id"].as_str().unwrap())
        );
        assert_eq!(c["plan"][0]["jobs"], json!({}));
        let archive = &exported["value"]["dialogueArchive"]["archives"][0];
        assert_eq!(archive["messages"][0]["content"], " keep ");
        assert_eq!(archive["messages"][0]["readOnly"], true);
        assert!(archive["messages"][0].get("privateGrant").is_none());
        assert_eq!(archive["personas"]["character"]["name"], "Person");
        assert_eq!(exported["value"]["dialogueArchive"]["session"], Value::Null);
        assert_eq!(
            run(&mut s, "store.settings", json!({}))["value"]["allowCloud"],
            false
        );
    }

    #[test]
    fn patch_and_forget_keep_privacy_and_reject_invalid_fields() {
        let mut s = state();
        let memory = run(&mut s, "store.memory", json!({"content":"secretmarker"}));
        let id = &memory["value"]["id"];
        run(
            &mut s,
            "document.put",
            json!({"kind":"memory-vector","doc":{"id":id,"vector":[1]}}),
        );
        assert!(s
            .call(
                "store.memoryPatch",
                json!({"id":id,"patch":{"confirmed":"yes"}})
            )
            .is_err());
        let patch = run(
            &mut s,
            "store.memoryPatch",
            json!({"id":id,"patch":{"title":"new","content":" updated ","scope":"shared","forbidden":true}}),
        );
        assert_eq!(patch["value"]["content"], "updated");
        assert!(patch["value"].get("forbidden").is_none());
        let gone = run(&mut s, "store.memoryDelete", json!({"id":id}));
        assert_eq!(gone["value"], json!({"deleted":true}));
        assert_eq!(
            run(
                &mut s,
                "document.get",
                json!({"kind":"memory-vector","id":id})
            ),
            Value::Null
        );
        let replay = run(&mut s, "event.replay", json!({}));
        assert_eq!(replay.as_array().unwrap().len(), 1);
        assert_eq!(replay[0]["type"], "memory.deleted");
        assert!(s
            .call("store.memoryDelete", json!({"id":id}))
            .unwrap_err()
            .to_string()
            .starts_with("[404]"));
    }
}
