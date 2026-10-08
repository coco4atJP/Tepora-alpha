//! Synchronous durable state domain shared by Node today and a Rust host in future.
//!
//! The JSON transport preserves document fields introduced by other app versions.
//! Domain writes use savepoints: an outer application transaction still owns its
//! commit, and a failed multi-table operation cannot leave half-written state.

use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::{error::Error, fmt};

mod context;
pub mod harness;
pub mod execution;
pub mod js_value;
pub mod json_codec;
pub mod projection;
pub mod protocols;
pub mod runtime;
pub mod store_domain;
mod tokens;
use json_codec::{encode_text, encode_value, sql_text};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const SCHEMA: &str = "
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE VIRTUAL TABLE IF NOT EXISTS content_search USING fts5(kind UNINDEXED,id UNINDEXED,terms,tokenize='unicode61');
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session_log(session_id TEXT NOT NULL,seq INTEGER NOT NULL,type TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(session_id,seq));
CREATE TABLE IF NOT EXISTS evidence_store(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,seq INTEGER NOT NULL,tool TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS evidence_by_session ON evidence_store(session_id,seq);
CREATE VIRTUAL TABLE IF NOT EXISTS session_search USING fts5(session_id UNINDEXED,seq UNINDEXED,terms,tokenize='unicode61');
CREATE TABLE IF NOT EXISTS session_inbox(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS inbox_by_session ON session_inbox(session_id,at);
";

#[derive(Debug)]
pub struct CoreError(String);

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl Error for CoreError {}
impl From<rusqlite::Error> for CoreError {
    fn from(value: rusqlite::Error) -> Self {
        Self(value.to_string())
    }
}
impl From<serde_json::Error> for CoreError {
    fn from(value: serde_json::Error) -> Self {
        Self(value.to_string())
    }
}
type CoreResult<T> = Result<T, CoreError>;

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError(format!("[400] {}", message.into()))
}
fn string<'a>(v: &'a Value, key: &str) -> CoreResult<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("{key} must be a string")))
}
fn number(v: &Value, key: &str, default: i64) -> CoreResult<i64> {
    match v.get(key) {
        None => Ok(default),
        Some(value) => value
            .as_i64()
            .filter(|n| n.unsigned_abs() <= MAX_SAFE_INTEGER as u64)
            .ok_or_else(|| invalid(format!("{key} must be a safe integer"))),
    }
}
fn field<'a>(v: &'a Value, key: &str) -> CoreResult<&'a Value> {
    v.get(key)
        .ok_or_else(|| invalid(format!("{key} is required")))
}
fn parse(raw: String) -> CoreResult<Value> {
    json_codec::parse(&raw)
}

/// Preserve the existing JavaScript confirmation predicate for legacy documents.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JSON-compatible equivalent of spreading body fields after an entry header.
fn extend_object(target: &mut Map<String, Value>, fields: &Value) {
    match fields {
        Value::Object(fields) => {
            for (key, value) in fields {
                target.insert(key.clone(), value.clone());
            }
        }
        Value::Array(fields) => {
            for (i, value) in fields.iter().enumerate() {
                target.insert(i.to_string(), value.clone());
            }
        }
        Value::String(value) => {
            for (i, value) in value.chars().enumerate() {
                target.insert(i.to_string(), Value::String(value.to_string()));
            }
        }
        _ => {}
    }
}

/// Owns a single SQLite connection. All nested application transactions and
/// sessions use this same connection; no independent writer is hidden by N-API.
pub struct NativeState {
    connection: Option<Connection>,
}

impl NativeState {
    pub fn open(filename: &str) -> CoreResult<Self> {
        let connection = Connection::open(filename)?;
        connection.execute_batch(SCHEMA)?;
        Ok(Self {
            connection: Some(connection),
        })
    }

    fn db(&self) -> CoreResult<&Connection> {
        self.connection
            .as_ref()
            .ok_or_else(|| CoreError("The Tepora database is closed".into()))
    }

    fn atomic<T>(&self, work: impl FnOnce() -> CoreResult<T>) -> CoreResult<T> {
        let db = self.db()?;
        db.execute_batch("SAVEPOINT tepora_domain_write")?;
        match work() {
            Ok(value) => {
                if let Err(error) = db.execute_batch("RELEASE tepora_domain_write") {
                    let _ = db.execute_batch(
                        "ROLLBACK TO tepora_domain_write; RELEASE tepora_domain_write",
                    );
                    return Err(error.into());
                }
                Ok(value)
            }
            Err(error) => {
                let _ = db
                    .execute_batch("ROLLBACK TO tepora_domain_write; RELEASE tepora_domain_write");
                Err(error)
            }
        }
    }

    fn document(&self, kind: &str, id: &str) -> CoreResult<Value> {
        let raw: Option<String> = self
            .db()?
            .prepare_cached("SELECT body FROM documents WHERE kind=? AND id=?")?
            .query_row(
                params![sql_text(kind), sql_text(id)],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(parse).transpose().map(|v| v.unwrap_or(Value::Null))
    }

    fn index(&self, kind: &str, id: &str, terms: &str) -> CoreResult<()> {
        self.db()?.execute(
            "DELETE FROM content_search WHERE kind=? AND id=?",
            params![sql_text(kind), sql_text(id)],
        )?;
        self.db()?.execute(
            "INSERT INTO content_search(kind,id,terms) VALUES(?,?,?)",
            params![sql_text(kind), sql_text(id), sql_text(terms)],
        )?;
        Ok(())
    }

    fn put_document(&self, kind: &str, doc: &Value, terms: &str) -> CoreResult<Value> {
        let id = string(doc, "id")?;
        if id.is_empty() || sql_text(id).encode_utf16().count() > 300 {
            return Err(invalid("Document id required"));
        }
        self.atomic(|| {
            self.db()?.execute(
                "INSERT INTO documents(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
                params![sql_text(kind), sql_text(id), json_codec::stringify(doc)?],
            )?;
            if matches!(kind, "memory" | "job") {
                self.index(kind, id, terms)?;
            }
            Ok(doc.clone())
        })
    }

    fn run_result(&self, changes: usize) -> CoreResult<Value> {
        Ok(json!({"changes": changes, "lastInsertRowid": self.db()?.last_insert_rowid()}))
    }

    fn next_seq(&self, id: &str) -> CoreResult<i64> {
        let seq: i64 = self.db()?.query_row(
            "SELECT COALESCE(MAX(seq),0)+1 FROM session_log WHERE session_id=?",
            [sql_text(id)],
            |r| r.get(0),
        )?;
        Ok(seq)
    }

    fn merged_entry(seq: i64, kind: String, at: String, body: String) -> CoreResult<Value> {
        let body = parse(body)?;
        let mut entry = Map::new();
        entry.insert("seq".into(), json!(seq));
        entry.insert("type".into(), json!(encode_text(&kind)));
        entry.insert("at".into(), json!(encode_text(&at)));
        extend_object(&mut entry, &body);
        Ok(Value::Object(entry))
    }

    fn entries(&self, sql: &str, args: &[SqlValue]) -> CoreResult<Vec<Value>> {
        let mut statement = self.db()?.prepare(sql)?;
        let mut rows = statement.query(params_from_iter(args))?;
        let mut entries = Vec::new();
        while let Some(row) = rows.next()? {
            entries.push(Self::merged_entry(
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
            )?);
        }
        Ok(entries)
    }

    fn entry(&self, id: &str, seq: i64) -> CoreResult<Value> {
        Ok(self
            .entries(
                "SELECT seq,type,at,body FROM session_log WHERE session_id=? AND seq=?",
                &[SqlValue::Text(sql_text(id)), SqlValue::Integer(seq)],
            )?
            .into_iter()
            .next()
            .unwrap_or(Value::Null))
    }

    fn pending(&self, id: &str) -> CoreResult<Value> {
        let mut stmt = self
            .db()?
            .prepare("SELECT body FROM session_inbox WHERE session_id=? ORDER BY at,rowid")?;
        let values = stmt
            .query_map([sql_text(id)], |r| r.get::<_, String>(0))?
            .map(|row| parse(row?))
            .collect::<CoreResult<Vec<_>>>()?;
        Ok(Value::Array(values))
    }

    /// Stable transport contract. The SQL operation is a compatibility escape
    /// hatch for old transaction callers and fixtures, not the state domain API.
    /// Unicode-only convenience interface. Use call_json to preserve all JS UTF-16 strings.
    pub fn call(&mut self, op: &str, payload: Value) -> CoreResult<Value> {
        let result = self.call_internal(op, encode_value(payload))?;
        Ok(serde_json::from_str(&json_codec::stringify(&result)?)?)
    }

    /// Lossless JSON interface, including legacy unpaired UTF-16 surrogate escapes.
    pub fn call_json(&mut self, op: &str, payload_json: &str) -> CoreResult<String> {
        let payload = json_codec::parse(payload_json)?;
        let result = self.call_internal(op, payload)?;
        json_codec::stringify(&result)
    }

    fn call_internal(&mut self, op: &str, payload: Value) -> CoreResult<Value> {
        let p = &payload;
        if op == "close" {
            if let Some(connection) = self.connection.take() {
                if let Err((connection, error)) = connection.close() {
                    self.connection = Some(connection);
                    return Err(error.into());
                }
            }
            return Ok(Value::Null);
        }
        // Fail predictably after close, including operations with no SQL work.
        self.db()?;
        if op.starts_with("store.") {
            return store_domain::dispatch(self, op, p);
        }
        match op {
            "kv.get" => {
                let raw: Option<String> = self.db()?.query_row(
                    "SELECT value FROM kv WHERE key=?", [sql_text(string(p, "key")?)], |r| r.get(0),
                ).optional()?;
                raw.map(parse).transpose().map(|v| v.unwrap_or(Value::Null))
            }
            "kv.set" => {
                let value = field(p, "value")?;
                // Keep changed values synchronous, but do not rewrite an exact
                // serialized duplicate (including its primary-key index).
                self.db()?.execute("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE kv.value IS NOT excluded.value",
                    params![sql_text(string(p, "key")?), json_codec::stringify(value)?])?;
                Ok(value.clone())
            }
            "kv.delete" => {
                let changes = self.db()?.execute("DELETE FROM kv WHERE key=?", [sql_text(string(p, "key")?)])?;
                self.run_result(changes)
            }
            "document.get" => self.document(string(p, "kind")?, string(p, "id")?),
            "document.list" => {
                let kind = string(p, "kind")?;
                let offset = number(p, "offset", 0)?;
                if offset < 0 { return Err(invalid("Invalid offset")); }
                let mut args = vec![SqlValue::Text(sql_text(kind))];
                let sql = if p.get("limit").is_some() {
                    let limit = number(p, "limit", 0)?;
                    if limit <= 0 { return Err(invalid("Invalid limit")); }
                    args.extend([SqlValue::Integer(limit), SqlValue::Integer(offset)]);
                    "SELECT body FROM documents WHERE kind=? ORDER BY rowid DESC LIMIT ? OFFSET ?"
                } else {
                    "SELECT body FROM documents WHERE kind=? ORDER BY rowid DESC"
                };
                let mut stmt = self.db()?.prepare(sql)?;
                let docs = stmt.query_map(params_from_iter(args), |r| r.get::<_, String>(0))?
                    .map(|row| parse(row?)).collect::<CoreResult<Vec<_>>>()?;
                Ok(Value::Array(docs))
            }
            "document.put" => self.put_document(string(p, "kind")?, field(p, "doc")?, p["terms"].as_str().unwrap_or("")),
            "document.index" => self.atomic(|| {
                self.index(string(p, "kind")?, string(p, "id")?, string(p, "terms")?)?;
                Ok(Value::Null)
            }),
            "document.remove" => self.atomic(|| {
                let kind = string(p, "kind")?;
                let id = string(p, "id")?;
                if matches!(kind, "memory" | "job") {
                    self.db()?.execute("DELETE FROM content_search WHERE kind=? AND id=?", params![sql_text(kind), sql_text(id)])?;
                }
                let changes = self.db()?.execute("DELETE FROM documents WHERE kind=? AND id=?", params![sql_text(kind), sql_text(id)])?;
                let result = self.run_result(changes)?;
                if kind == "memory" {
                    self.db()?.execute("DELETE FROM documents WHERE kind='memory-vector' AND id=?", [sql_text(id)])?;
                    self.db()?.execute("DELETE FROM events WHERE type LIKE 'memory.%' AND json_extract(body,'$.id')=?", [sql_text(id)])?;
                }
                Ok(result)
            }),
            "document.search" => {
                let kind = string(p, "kind")?;
                if !matches!(kind, "memory" | "job") { return Err(invalid("Unknown search collection")); }
                let expression = string(p, "expression")?;
                if expression.is_empty() { return Ok(json!([])); }
                let offset = number(p, "offset", 0)?;
                if offset < 0 { return Err(invalid("Invalid offset")); }
                let mut args = vec![SqlValue::Text(sql_text(expression)), SqlValue::Text(sql_text(kind))];
                let mut sql = "SELECT d.body FROM content_search f JOIN documents d ON d.kind=f.kind AND d.id=f.id WHERE content_search MATCH ? AND f.kind=? ORDER BY bm25(content_search)".to_string();
                if p.get("limit").is_some() {
                    let limit = number(p, "limit", 0)?;
                    if limit <= 0 { return Err(invalid("Invalid limit")); }
                    sql.push_str(" LIMIT ? OFFSET ?");
                    args.extend([SqlValue::Integer(limit), SqlValue::Integer(offset)]);
                }
                let mut stmt = self.db()?.prepare(&sql)?;
                let docs = stmt.query_map(params_from_iter(args), |r| r.get::<_, String>(0))?
                    .map(|row| parse(row?)).collect::<CoreResult<Vec<_>>>()?;
                Ok(Value::Array(docs))
            }
            "memory.recall" => {
                let expression = string(p, "expression")?;
                if expression.is_empty() { return Ok(json!([])); }
                let cloud = truthy(&p["cloud"]);
                let share = truthy(&p["share"]);
                let limit = number(p, "limit", 6)?;
                let mut statement = self.db()?.prepare("SELECT d.body FROM content_search f JOIN documents d ON d.kind=f.kind AND d.id=f.id WHERE content_search MATCH ? AND f.kind='memory' ORDER BY bm25(content_search)")?;
                let mut rows = statement.query([sql_text(expression)])?;
                let mut memories = Vec::new();
                // One ranked cursor keeps imported, unconfirmed collections a
                // linear scan, without repeated OFFSET sorts or a giant JSON
                // result crossing the native boundary. Consent is checked here
                // before any memory is added to the returned result.
                while let Some(row) = rows.next()? {
                    let memory = parse(row.get(0)?)?;
                    if truthy(&memory["confirmed"]) && (!cloud || (share && memory["scope"] == "shared")) {
                        memories.push(memory);
                    }
                    // Match the old search loop even for zero/negative limits.
                    if memories.len() as i64 >= limit { break; }
                }
                Ok(Value::Array(memories))
            }
            "artifact.put" => self.atomic(|| {
                self.db()?.execute("UPDATE documents SET id=id WHERE 0", [])?;
                let mut doc = field(p, "doc")?.clone();
                let id = string(&doc, "id")?.to_owned();
                let previous = self.document("artifact", &id)?;
                let version = previous["version"].as_i64().unwrap_or(0);
                if let Some(expected) = p.get("expectedVersion") {
                    if expected.as_i64() != Some(version) {
                        return Err(CoreError("[409] Artifact changed. Read its latest version before editing.".into()));
                    }
                }
                if !previous.is_null() {
                    let mut revision = previous;
                    revision["id"] = json!(format!("{id}:{version}"));
                    revision["artifactId"] = json!(id);
                    self.put_document("revision", &revision, "")?;
                }
                doc["version"] = json!(version + 1);
                self.put_document("artifact", &doc, "")
            }),
            "event.append" => self.atomic(|| {
                let kind = string(p, "type")?;
                let data = field(p, "data")?;
                let at = string(p, "at")?;
                let durable = if kind.starts_with("memory.") {
                    let mut value = Map::new();
                    if let Some(id) = data.get("id") { value.insert("id".into(), id.clone()); }
                    Value::Object(value)
                } else { data.clone() };
                self.db()?.execute("INSERT INTO events(type,body,at) VALUES(?,?,?)",
                    params![sql_text(kind), json_codec::stringify(&durable)?, sql_text(at)])?;
                let seq = self.db()?.last_insert_rowid();
                if seq % 100 == 0 {
                    let retention = number(p, "retention", 5000)?;
                    self.db()?.execute("DELETE FROM events WHERE seq < ?", [seq - retention])?;
                }
                Ok(json!({"seq": seq, "type": kind, "data": data, "at": at}))
            }),
            "event.replay" => {
                let mut stmt = self.db()?.prepare("SELECT seq,type,body,at FROM events WHERE seq>? ORDER BY seq LIMIT 5000")?;
                let mut rows = stmt.query([number(p, "since", 0)?])?;
                let mut events = Vec::new();
                while let Some(row) = rows.next()? {
                    let seq: i64 = row.get(0)?;
                    let mut kind: String = row.get(1)?;
                    let mut data = parse(row.get(2)?)?;
                    let at: String = row.get(3)?;
                    if kind == "memory.updated" {
                        let id = data["id"].as_str().unwrap_or("");
                        let memory = self.document("memory", id)?;
                        if memory.is_null() {
                            kind = "memory.deleted".into();
                            let mut deleted = Map::new();
                            if let Some(id) = data.get("id") { deleted.insert("id".into(), id.clone()); }
                            data = Value::Object(deleted);
                        } else { data = memory; }
                    }
                    events.push(json!({"seq": seq, "type": encode_text(&kind), "data": data, "at": encode_text(&at)}));
                }
                Ok(Value::Array(events))
            }
            "event.seq" => {
                let seq: i64 = self.db()?.query_row("SELECT seq FROM sqlite_sequence WHERE name='events'", [], |r| r.get(0))
                    .optional()?.unwrap_or(0);
                Ok(json!(seq))
            }
            "session.seq" => Ok(json!(self.next_seq(string(p, "id")?)?)),
            "session.append" => self.atomic(|| {
                let id = string(p, "id")?;
                let kind = string(p, "type")?;
                if !["input", "assistant", "tool", "notice", "checkpoint", "clear", "event"].contains(&kind) {
                    return Err(invalid("Unknown log entry type"));
                }
                let body = field(p, "body")?;
                let at = string(p, "at")?;
                // Obtain the write lock before reading MAX, also when multiple
                // independent Rust handles intentionally open the same database.
                self.db()?.execute("UPDATE session_log SET seq=seq WHERE 0", [])?;
                let seq = self.next_seq(id)?;
                let body_text = json_codec::stringify(body)?;
                self.db()?.execute("INSERT INTO session_log(session_id,seq,type,body,at) VALUES(?,?,?,?,?)",
                    params![sql_text(id), seq, sql_text(kind), body_text, sql_text(at)])?;
                let terms = p["terms"].as_str().unwrap_or("");
                if !terms.is_empty() {
                    self.db()?.execute("INSERT INTO session_search(session_id,seq,terms) VALUES(?,?,?)", params![sql_text(id), seq, sql_text(terms)])?;
                }
                Self::merged_entry(seq, sql_text(kind), sql_text(at), body_text)
            }),
            "session.entries" => {
                let mut stmt = self.db()?.prepare("SELECT seq,type,at,body FROM session_log WHERE session_id=? AND seq>=? AND seq<=? ORDER BY seq")?;
                let mut rows = stmt.query(params![sql_text(string(p, "id")?), number(p, "from", 1)?, number(p, "to", MAX_SAFE_INTEGER)?])?;
                let mut entries = Vec::new();
                while let Some(row) = rows.next()? {
                    let kind: String = row.get(1)?;
                    if let Some(types) = p.get("types").filter(|v| !v.is_null()) {
                        let types = types.as_array().ok_or_else(|| invalid("types must be an array"))?;
                        if !types.iter().any(|value| value.as_str() == Some(&kind)) { continue; }
                    }
                    entries.push(Self::merged_entry(row.get(0)?, kind, row.get(2)?, row.get(3)?)?);
                }
                Ok(Value::Array(entries))
            }
            "session.entry" => self.entry(string(p, "id")?, number(p, "seq", 0)?),
            "session.latest" => Ok(self.entries(
                "SELECT seq,type,at,body FROM session_log WHERE session_id=? AND type=? ORDER BY seq DESC LIMIT 1",
                &[SqlValue::Text(sql_text(string(p, "id")?)), SqlValue::Text(sql_text(string(p, "type")?))],
            )?.into_iter().next().unwrap_or(Value::Null)),
            "session.tail" => {
                let mut entries = self.entries("SELECT seq,type,at,body FROM session_log WHERE session_id=? ORDER BY seq DESC LIMIT ?",
                    &[SqlValue::Text(sql_text(string(p, "id")?)), SqlValue::Integer(number(p, "limit", 50)?)])?;
                entries.reverse();
                Ok(Value::Array(entries))
            }
            "session.patch" => self.atomic(|| {
                let id = string(p, "id")?;
                let seq = number(p, "seq", 0)?;
                let entry = self.entry(id, seq)?;
                if entry.is_null() { return Ok(Value::Null); }
                let mut merged = entry.as_object().cloned().unwrap_or_default();
                let mut body = merged.clone();
                for key in ["seq", "type", "at"] { body.shift_remove(key); }
                let fields = field(p, "fields")?;
                extend_object(&mut body, fields);
                if let Some(keys) = p.get("removeKeys") {
                    let keys = keys.as_array().ok_or_else(|| invalid("removeKeys must be an array"))?;
                    for key in keys {
                        let key = key.as_str().ok_or_else(|| invalid("removeKeys must contain strings"))?;
                        body.shift_remove(key);
                    }
                }
                self.db()?.execute("UPDATE session_log SET body=? WHERE session_id=? AND seq=?",
                    params![json_codec::stringify(&Value::Object(body))?, sql_text(id), seq])?;
                extend_object(&mut merged, fields);
                if let Some(keys) = p.get("removeKeys").and_then(Value::as_array) {
                    for key in keys { merged.shift_remove(key.as_str().unwrap()); }
                }
                Ok(Value::Object(merged))
            }),
            "session.search" => {
                let expression = string(p, "expression")?;
                if expression.is_empty() { return Ok(json!([])); }
                let limit = number(p, "limit", 10)?;
                let mut stmt = self.db()?.prepare("SELECT session_id,CAST(seq AS INTEGER) FROM session_search WHERE session_search MATCH ? ORDER BY bm25(session_search) LIMIT 400")?;
                let mut rows = stmt.query([sql_text(expression)])?;
                let mut matches = Vec::new();
                while let Some(row) = rows.next()? {
                    let id = encode_text(&row.get::<_, String>(0)?);
                    if let Some(ids) = p.get("sessionIds").filter(|v| !v.is_null()) {
                        let ids = ids.as_array().ok_or_else(|| invalid("sessionIds must be an array"))?;
                        if !ids.iter().any(|v| v.as_str() == Some(&id)) { continue; }
                    }
                    let entry = self.entry(&id, row.get(1)?)?;
                    if !entry.is_null() {
                        let mut output = Map::new();
                        output.insert("sessionId".into(), json!(id));
                        extend_object(&mut output, &entry);
                        matches.push(Value::Object(output));
                    }
                    if matches.len() as i64 >= limit { break; }
                }
                Ok(Value::Array(matches))
            }
            "session.remove" => self.atomic(|| {
                let id = string(p, "id")?;
                for sql in [
                    "DELETE FROM session_inbox WHERE session_id=?",
                    "DELETE FROM session_log WHERE session_id=?",
                    "DELETE FROM evidence_store WHERE session_id=?",
                    "DELETE FROM session_search WHERE session_id=?",
                    "DELETE FROM documents WHERE kind='session' AND id=?",
                ] { self.db()?.execute(sql, [sql_text(id)])?; }
                Ok(Value::Null)
            }),
            "evidence.put" => {
                let id = string(p, "id")?;
                self.db()?.execute("INSERT OR REPLACE INTO evidence_store(id,session_id,seq,tool,body,at) VALUES(?,?,?,?,?,?)",
                    params![sql_text(id), sql_text(string(p, "sessionId")?), number(p, "seq", 0)?, sql_text(string(p, "tool")?), sql_text(string(p, "content")?), sql_text(string(p, "at")?)])?;
                Ok(json!(id))
            }
            "evidence.get" => {
                let mut stmt = self.db()?.prepare("SELECT id,session_id,seq,tool,body,at FROM evidence_store WHERE id=?")?;
                let mut rows = stmt.query([sql_text(string(p, "id")?)])?;
                if let Some(row) = rows.next()? {
                    Ok(encode_value(json!({"id":row.get::<_,String>(0)?,"sessionId":row.get::<_,String>(1)?,"seq":row.get::<_,i64>(2)?,"tool":row.get::<_,String>(3)?,"content":row.get::<_,String>(4)?,"at":row.get::<_,String>(5)?})))
                } else { Ok(Value::Null) }
            }
            "inbox.enqueue" => {
                let item = field(p, "item")?;
                self.db()?.execute("INSERT INTO session_inbox(id,session_id,body,at) VALUES(?,?,?,?)",
                    params![sql_text(string(item, "id")?), sql_text(string(p, "sessionId")?), json_codec::stringify(item)?, sql_text(string(item, "at")?)])?;
                Ok(item.clone())
            }
            "inbox.pending" => self.pending(string(p, "id")?),
            "inbox.take" => self.atomic(|| {
                let id = string(p, "id")?;
                // Reserve the writer before selecting, so consumption is atomic
                // across independent connections as well as within this process.
                self.db()?.execute("UPDATE session_inbox SET id=id WHERE 0", [])?;
                let pending = self.pending(id)?;
                self.db()?.execute("DELETE FROM session_inbox WHERE session_id=?", [sql_text(id)])?;
                Ok(pending)
            }),
            "inbox.takeItem" => Ok(json!(self.db()?.execute("DELETE FROM session_inbox WHERE session_id=? AND id=?",
                params![sql_text(string(p, "id")?), sql_text(string(p, "itemId")?)])? > 0)),
            "inbox.sessions" => {
                let mut stmt = self.db()?.prepare("SELECT DISTINCT session_id AS id FROM session_inbox")?;
                let ids = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>,_>>()?;
                Ok(encode_value(json!(ids)))
            }
            "exec" => { self.db()?.execute_batch(&sql_text(string(p, "sql")?))?; Ok(Value::Null) }
            "sql" => self.compatibility_sql(p),
            _ => Err(invalid(format!("Unknown native state operation: {op}"))),
        }
    }

    fn compatibility_sql(&self, p: &Value) -> CoreResult<Value> {
        let empty = Vec::new();
        let args = p.get("args").and_then(Value::as_array).unwrap_or(&empty);
        let args = args
            .iter()
            .map(|v| match v {
                Value::Null => Ok(SqlValue::Null),
                Value::Bool(value) => Ok(SqlValue::Integer(i64::from(*value))),
                Value::String(value) => Ok(SqlValue::Text(sql_text(value))),
                Value::Number(value) => match value.as_i64() {
                    Some(value) => Ok(SqlValue::Integer(value)),
                    None => value
                        .as_f64()
                        .map(SqlValue::Real)
                        .ok_or_else(|| invalid("Invalid SQL number")),
                },
                _ => Err(invalid("SQL arguments must be scalar values")),
            })
            .collect::<CoreResult<Vec<_>>>()?;
        let mut stmt = self.db()?.prepare(&sql_text(string(p, "sql")?))?;
        let mode = string(p, "mode")?;
        if mode == "run" {
            return self.run_result(stmt.execute(params_from_iter(args))?);
        }
        if !matches!(mode, "get" | "all") {
            return Err(invalid("Unknown SQL result mode"));
        }
        let names = stmt
            .column_names()
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>();
        let mut rows = stmt.query(params_from_iter(args))?;
        let mut output = Vec::new();
        while let Some(row) = rows.next()? {
            let mut object = Map::new();
            for (i, name) in names.iter().enumerate() {
                let value = match row.get::<_, SqlValue>(i)? {
                    SqlValue::Null => Value::Null,
                    SqlValue::Integer(value) => json!(value),
                    SqlValue::Real(value) => json!(value),
                    SqlValue::Text(value) => json!(encode_text(&value)),
                    SqlValue::Blob(value) => json!(value),
                };
                object.insert(encode_text(name), value);
            }
            output.push(Value::Object(object));
            if mode == "get" {
                break;
            }
        }
        if mode == "get" {
            Ok(output.into_iter().next().unwrap_or(Value::Null))
        } else {
            Ok(Value::Array(output))
        }
    }
}

/// Node-independent, lossless entry point for context, token and UI computations.
/// Inputs/outputs are external JSON; isolated UTF-16 surrogate escapes are retained.
pub fn compute_json(operation: &str, payload_json: &str) -> CoreResult<String> {
    let payload = json_codec::parse(payload_json)?;
    let result = if operation.starts_with("context.") {
        context::call(operation, payload)?
    } else if operation.starts_with("tokens.") {
        tokens::call(operation, payload)?
    } else if operation.starts_with("harness.") {
        harness::call(operation, &payload)?
    } else if operation.starts_with("ui.") {
        projection::call(operation, payload)?
    } else {
        return Err(invalid("Unknown compute operation"));
    };
    json_codec::stringify(&result)
}

#[cfg(feature = "node")]
mod binding {
    use super::*;
    use napi_derive::napi;

    #[napi(js_name = "computeCore")]
    pub fn compute_core(operation: String, payload_json: String) -> napi::Result<String> {
        compute_json(&operation, &payload_json)
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    #[napi]
    pub struct StateCore {
        state: NativeState,
    }

    #[napi]
    impl StateCore {
        #[napi(constructor)]
        pub fn new(filename: String) -> napi::Result<Self> {
            NativeState::open(&filename)
                .map(|state| Self { state })
                .map_err(|error| napi::Error::from_reason(error.to_string()))
        }

        #[napi]
        pub fn call(&mut self, op: String, payload_json: String) -> napi::Result<String> {
            self.state
                .call_json(&op, &payload_json)
                .map_err(|error| napi::Error::from_reason(error.to_string()))
        }
    }
}

#[cfg(test)]
mod tests;
