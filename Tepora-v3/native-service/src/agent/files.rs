//! Native read/write/edit effects. Internal JSON strings use json_codec; filesystem
//! boundaries deliberately apply Node's UTF-16 -> UTF-8 replacement semantics.
//!
//! Cancellation is checked before dispatch (and after waiting for the file lock).
//! Once a blocking operation starts it always settles, even after Stop. Its real
//! result must be drained into the receipt; cancelling a future is not rollback.
use super::EffectError;
use crate::{network::RequestCancellation, ApiError};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
    time::{SystemTime, UNIX_EPOCH},
};
use tepora_core::json_codec::{encode_text, from_utf16_units, sql_text, utf16_units};
use tokio::sync::Mutex as AsyncMutex;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SandboxMode {
    #[default]
    Off,
    Workspace,
    Readonly,
    Container,
}
impl SandboxMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Workspace => "workspace",
            Self::Readonly => "readonly",
            Self::Container => "container",
        }
    }
}
/// The file-relevant projection of normalized sandboxConfig. Process/network
/// settings are owned by their own hosts, never interpreted as file permission.
#[derive(Clone, Debug, Default)]
pub struct SandboxPolicy {
    pub mode: SandboxMode,
    pub writable: Vec<PathBuf>,
}
impl SandboxPolicy {
    pub fn from_value(value: &Value) -> Result<Self, ApiError> {
        if !value.is_object() {
            return Err(ApiError::bad_request("Invalid sandbox settings"));
        }
        let mode = match value.get("mode").and_then(Value::as_str).unwrap_or("off") {
            "off" => SandboxMode::Off,
            "workspace" => SandboxMode::Workspace,
            "readonly" => SandboxMode::Readonly,
            "container" => SandboxMode::Container,
            _ => return Err(ApiError::bad_request("Unknown sandbox mode")),
        };
        if value.get("mode").is_some_and(|m| !m.is_string()) {
            return Err(ApiError::bad_request("Unknown sandbox mode"));
        }
        let mut writable = Vec::new();
        if let Some(raw) = value.get("writable") {
            let raw = raw
                .as_array()
                .filter(|a| a.len() <= 16)
                .ok_or_else(|| ApiError::bad_request("Writable paths must be absolute"))?;
            for entry in raw {
                let path = entry
                    .as_str()
                    .map(sql_text)
                    .map(PathBuf::from)
                    .filter(|p| p.is_absolute())
                    .ok_or_else(|| ApiError::bad_request("Writable paths must be absolute"))?;
                if !writable.contains(&path) {
                    writable.push(path);
                }
            }
        }
        Ok(Self { mode, writable })
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FileStamp {
    pub mtime_ms: f64,
    pub size: u64,
}
impl FileStamp {
    fn of(info: &Metadata) -> Self {
        Self {
            mtime_ms: info.modified().map(epoch_ms).unwrap_or(0.0),
            size: info.len(),
        }
    }
}
#[derive(Clone, Copy, Debug)]
struct ReadStamp {
    seq: u64,
    stamp: FileStamp,
}
/// Ephemeral memory belongs to one session and survives ordinary turns. Reset it
/// only with the existing forget lifecycle, not each inference/tool call.
#[derive(Debug, Default)]
pub struct FileMemory {
    files: HashMap<PathBuf, FileStamp>,
    reads: HashMap<String, ReadStamp>,
    read_order: VecDeque<String>,
}
impl FileMemory {
    /// Call only after the owner commits a read receipt, with that receipt's seq.
    pub fn record_read(&mut self, seq: u64, result: &Value) {
        let d = &result["data"];
        let (Some(key), Some(mtime_ms), Some(size)) = (
            d["readKey"].as_str(),
            d["mtimeMs"].as_f64(),
            d["size"].as_u64(),
        ) else {
            return;
        };
        if !self.reads.contains_key(key) {
            self.read_order.push_back(key.into());
        }
        self.reads.insert(
            key.into(),
            ReadStamp {
                seq,
                stamp: FileStamp { mtime_ms, size },
            },
        );
        if self.reads.len() > 300 {
            if let Some(old) = self.read_order.pop_front() {
                self.reads.remove(&old);
            }
        }
    }
    pub fn stamp(&self, path: &Path) -> Option<FileStamp> {
        self.files.get(path).copied()
    }
    pub fn clear(&mut self) {
        *self = Self::default();
    }
}

#[derive(Clone, Debug)]
pub struct FileContext {
    pub cwd: PathBuf,
    /// Optional original session.cwd in the internal JSON string codec.
    pub cwd_text: Option<String>,
    pub home: PathBuf,
    pub session_created_at_ms: Option<f64>,
    pub sandbox: SandboxPolicy,
    pub memory: Arc<Mutex<FileMemory>>,
    /// max(context.clearUpTo, context.checkpoint.upTo), from the current view.
    pub read_visible_after: u64,
}
impl FileContext {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self {
            cwd: cwd.into(),
            cwd_text: None,
            home: home_dir(),
            session_created_at_ms: None,
            sandbox: SandboxPolicy::default(),
            memory: Arc::new(Mutex::new(FileMemory::default())),
            read_visible_after: 0,
        }
    }
}
#[derive(Clone, Copy, Debug, Default)]
pub struct FileTools;
type FileLocks = Mutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>>;
static LOCKS: OnceLock<FileLocks> = OnceLock::new();
fn file_lock(file: &Path) -> Arc<AsyncMutex<()>> {
    let mut locks = LOCKS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    // Weak entries keep no completed operation alive. Purge them on admission.
    locks.retain(|_, lock| lock.strong_count() > 0);
    locks
        .entry(file.into())
        .or_default()
        .upgrade()
        .unwrap_or_else(|| {
            let lock = Arc::new(AsyncMutex::new(()));
            locks.insert(file.into(), Arc::downgrade(&lock));
            lock
        })
}
impl FileTools {
    pub async fn execute(
        &self,
        name: &str,
        args: Value,
        context: FileContext,
        cancellation: RequestCancellation,
    ) -> Result<Value, EffectError> {
        if cancellation.is_cancelled() {
            return Err(EffectError::cancelled(true));
        }
        if !matches!(name, "read" | "write" | "edit") {
            return Err(ApiError::unavailable(format!(
                "Native file tool {name} is not implemented"
            ))
            .into());
        }
        let file = resolve_file(&context, &args["path"])?;
        let guard = if name != "read" {
            let lock = file_lock(&file.logical);
            Some(tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(EffectError::cancelled(true)),
                guard = lock.lock_owned() => guard,
            })
        } else {
            None
        };
        if cancellation.is_cancelled() {
            return Err(EffectError::cancelled(true));
        }
        let name = name.to_owned();
        // Intentionally no select!/abort around this join. The lock moves into
        // the blocking job so even a dropped caller cannot release it early.
        settle_blocking(cancellation, move || {
            let _guard = guard;
            match name.as_str() {
                "read" => read(&file, &args, &context),
                "write" => write(&file, &args, &context),
                "edit" => edit(&file, &args, &context),
                _ => unreachable!(),
            }
        })
        .await
    }
}
async fn settle_blocking<F>(
    cancellation: RequestCancellation,
    operation: F,
) -> Result<Value, EffectError>
where
    F: FnOnce() -> Result<Value, EffectError> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        if cancellation.is_cancelled() {
            return Err(EffectError::cancelled(true));
        }
        operation()
    })
    .await
    .map_err(|e| {
        error(
            500,
            format!("Native file operation did not settle normally: {e}"),
        )
    })?
}

#[derive(Clone, Debug)]
struct ResolvedFile {
    os: PathBuf,
    /// Path operations happen on the logical JS string; replacement occurs
    /// only for OS syscalls, never in receipts/read keys/session lock keys.
    logical: PathBuf,
}
impl ResolvedFile {
    fn text(&self) -> String {
        self.logical.to_string_lossy().into_owned()
    }
    fn display(&self) -> std::path::Display<'_> {
        self.logical.display()
    }
    fn join(&self, path: &str) -> Self {
        Self {
            os: self.os.join(path),
            logical: self.logical.join(path),
        }
    }
}
impl AsRef<Path> for ResolvedFile {
    fn as_ref(&self) -> &Path {
        &self.os
    }
}
impl std::ops::Deref for ResolvedFile {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.os
    }
}

pub fn resolve_path(context: &FileContext, value: &Value) -> Result<PathBuf, EffectError> {
    Ok(resolve_file(context, value)?.os)
}
fn resolve_file(context: &FileContext, value: &Value) -> Result<ResolvedFile, EffectError> {
    let s = value
        .as_str()
        .ok_or_else(|| error(400, "path is required"))?;
    let units = utf16_units(s);
    if units.is_empty() || units.len() > 4096 || units.contains(&0) {
        return Err(error(400, "path is required"));
    }
    let home = PathBuf::from(encode_text(&context.home.to_string_lossy()));
    let cwd = PathBuf::from(
        context
            .cwd_text
            .clone()
            .unwrap_or_else(|| encode_text(&context.cwd.to_string_lossy())),
    );
    let path = if s == "~" {
        home
    } else if let Some(tail) = s.strip_prefix("~/") {
        home.join(tail.trim_start_matches(std::path::is_separator))
    } else {
        PathBuf::from(s)
    };
    let path = if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    };
    let path = if path.is_absolute() {
        path
    } else {
        PathBuf::from(encode_text(
            &std::env::current_dir()
                .map_err(|e| error(500, e.to_string()))?
                .to_string_lossy(),
        ))
        .join(path)
    };
    let logical = normalize(&path);
    let os = PathBuf::from(sql_text(&logical.to_string_lossy()));
    Ok(ResolvedFile { os, logical })
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            _ => out.push(part.as_os_str()),
        }
    }
    out
}
fn home_dir() -> PathBuf {
    // std's home_dir follows the same platform account fallback as os.homedir.
    #[allow(deprecated)]
    std::env::home_dir().unwrap_or_else(|| PathBuf::from(std::path::MAIN_SEPARATOR.to_string()))
}
fn epoch_ms(time: SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1_000_000.0,
        Err(e) => {
            -(e.duration().as_secs() as f64 * 1000.0
                + e.duration().subsec_nanos() as f64 / 1_000_000.0)
        }
    }
}
fn real(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| normalize(path))
}
pub fn writable_roots(policy: &SandboxPolicy, cwd: &Path) -> Option<Vec<PathBuf>> {
    if policy.mode == SandboxMode::Off {
        return None;
    }
    let mut roots = vec![
        real(&std::env::temp_dir()),
        PathBuf::from("/tmp"),
        PathBuf::from("/private/tmp"),
    ];
    if policy.mode != SandboxMode::Readonly && !cwd.as_os_str().is_empty() {
        roots.push(real(cwd));
    }
    roots.extend(policy.writable.iter().map(|p| real(p)));
    let mut unique = Vec::new();
    for root in roots {
        if !unique.contains(&root) {
            unique.push(root);
        }
    }
    Some(unique)
}
/// Corrects the source's final-symlink and missing-parent escape: inspect the
/// nearest existing ancestor, not just realpath(dirname) with lexical fallback.
/// This is a deliberate narrowing under non-off policies only.
fn existing_target(path: &Path) -> Result<PathBuf, std::io::Error> {
    match fs::symlink_metadata(path) {
        Ok(_) => fs::canonicalize(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or(e)?;
            let name = path
                .file_name()
                .ok_or_else(|| std::io::Error::other("Path has no filename"))?;
            Ok(existing_target(parent)?.join(name))
        }
        Err(e) => Err(e),
    }
}
pub fn assert_writable(policy: &SandboxPolicy, cwd: &Path, file: &Path) -> Result<(), EffectError> {
    let Some(roots) = writable_roots(policy, cwd) else {
        return Ok(());
    };
    let target = existing_target(file).map_err(|e| io_error("realpath", file, e))?;
    let target = target.to_string_lossy();
    // Preserve source string-prefix behavior (including an explicit '/' root).
    let allowed = roots.iter().any(|r| {
        let root = r.to_string_lossy();
        target == root || target.starts_with(&format!("{root}{}", std::path::MAIN_SEPARATOR))
    });
    if !allowed {
        return Err(error(403, format!("サンドボックス（{}）では {} に書き込めません。書き込めるのは作業フォルダと一時フォルダです。", policy.mode.as_str(), file.display())));
    }
    // A final symlink may be swapped after permission validation. Non-off
    // writers also open O_NOFOLLOW (or reject a Windows reparse point) below.
    if fs::symlink_metadata(file).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(error(
            403,
            format!(
                "Sandboxed native writes cannot target a symbolic link: {}",
                file.display()
            ),
        ));
    }
    Ok(())
}
fn memory(context: &FileContext) -> std::sync::MutexGuard<'_, FileMemory> {
    context.memory.lock().unwrap_or_else(|p| p.into_inner())
}
fn remember(context: &FileContext, file: &ResolvedFile) {
    if let Ok(info) = fs::metadata(file) {
        memory(context)
            .files
            .insert(file.logical.clone(), FileStamp::of(&info));
    }
}
fn assert_fresh(context: &FileContext, file: &ResolvedFile, op: &str) -> Result<(), EffectError> {
    let Some(seen) = memory(context).stamp(&file.logical) else {
        return Ok(());
    };
    if let Ok(info) = fs::metadata(file) {
        if FileStamp::of(&info) != seen {
            return Err(encoded_error(409, format!("{} changed since you last read or wrote it (the user, another agent or a program touched it). Read it again before you {op} it.", file.display())));
        }
    }
    Ok(())
}
fn assert_seen(context: &FileContext, file: &ResolvedFile) -> Result<(), EffectError> {
    let Ok(info) = fs::metadata(file) else {
        return Ok(());
    };
    if info.is_dir() {
        return Err(encoded_error(
            400,
            format!(
                "{} is a folder, not a file. Give a file path inside it, for example {}.",
                file.display(),
                file.join("notes.md").display()
            ),
        ));
    }
    if info.len() == 0 || memory(context).files.contains_key(&file.logical) {
        return Ok(());
    }
    let born = info
        .created()
        .map(epoch_ms)
        .ok()
        .filter(|v| *v > 0.0)
        .unwrap_or_else(|| FileStamp::of(&info).mtime_ms);
    if context
        .session_created_at_ms
        .is_some_and(|since| since.is_finite() && born >= since - 1000.0)
    {
        return Ok(());
    }
    Err(encoded_error(409, format!("{} already existed before this task ({} bytes) and you have not read it. Read it first; then change it with edit, or write the complete new content.", file.display(), info.len())))
}
fn read_text(file: &ResolvedFile) -> Result<String, EffectError> {
    let bytes = fs::read(file).map_err(|e| resolved_io_error("read", file, e))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
fn read(file: &ResolvedFile, args: &Value, context: &FileContext) -> Result<Value, EffectError> {
    let info = fs::metadata(file).map_err(|e| resolved_io_error("stat", file, e))?;
    let path = file.text();
    if info.is_dir() {
        let mut entries = fs::read_dir(file)
            .map_err(|e| resolved_io_error("scandir", file, e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| resolved_io_error("scandir", file, e))?;
        entries.sort_by_key(|e| e.file_name());
        let mut names = Vec::new();
        for entry in entries.into_iter().take(500) {
            let is_dir = entry
                .file_type()
                .map_err(|e| io_error("stat", &entry.path(), e))?
                .is_dir();
            names.push(format!(
                "{}{}",
                encode_text(&entry.file_name().to_string_lossy()),
                if is_dir { "/" } else { "" }
            ));
        }
        return Ok(json!({"text":format!("{path} is a directory:\n{}", names.join("\n"))}));
    }
    if file.extension().is_some_and(|e| {
        matches!(
            e.to_string_lossy().to_ascii_lowercase().as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "heic" | "heif"
        )
    }) {
        return Err(encoded_error(503, format!("Native image reading is not implemented: {}. Use the compatibility service for image/vision tools.", file.display())));
    }
    let mut probe = File::open(file).map_err(|e| resolved_io_error("open", file, e))?;
    let mut bytes = [0u8; 8000];
    let count = probe
        .read(&mut bytes)
        .map_err(|e| resolved_io_error("read", file, e))?;
    if bytes[..count].contains(&0) {
        return Ok(
            json!({"text":format!("{path} is a binary file ({} bytes). Use exec with an appropriate command (for example pdftotext, unzip -l, xxd) to inspect it.", info.len())}),
        );
    }
    if info.len() > 50_000_000 {
        return Err(error(
            413,
            "File is larger than 50 MB; use exec (head, sed, grep) instead.",
        ));
    }
    let offset = positive(args.get("offset"), 1);
    let limit = positive(args.get("limit"), 800);
    let offset_key = tepora_core::js_value::js_string(
        args.get("offset")
            .filter(|v| tepora_core::js_value::truthy(v))
            .or(Some(&json!(1))),
    );
    let limit_key = tepora_core::js_value::js_string(
        args.get("limit")
            .filter(|v| tepora_core::js_value::truthy(v))
            .or(Some(&json!(800))),
    );
    let key = format!("{path}:{offset_key}:{limit_key}");
    let stamp = FileStamp::of(&info);
    let prior = memory(context)
        .reads
        .get(&key)
        .copied()
        .filter(|r| r.stamp == stamp && r.seq > context.read_visible_after);
    if let Some(prior) = prior {
        return Ok(
            json!({"text":format!("{path} is unchanged since #{}, where these lines are shown in full above. Read another range (offset/limit) if you need other lines.", prior.seq),"data":{"path":path,"unchanged":true}}),
        );
    }
    memory(context).files.insert(file.logical.clone(), stamp);
    let text = read_text(file)?;
    let lines: Vec<_> = text.split('\n').collect();
    let from = offset.saturating_sub(1);
    let mut shown = Vec::new();
    for (index, line) in lines.iter().enumerate().skip(from).take(limit) {
        let units: Vec<_> = line.encode_utf16().collect();
        let cut = from_utf16_units(&units[..units.len().min(2000)]);
        shown.push(format!(
            "{:>5}\t{cut}{}",
            index + 1,
            if units.len() > 2000 { "…" } else { "" }
        ));
    }
    let end = from.saturating_add(limit);
    let more = if end < lines.len() {
        format!(
            "\n… {} more lines (read with offset={})",
            lines.len() - end,
            end + 1
        )
    } else {
        String::new()
    };
    Ok(
        json!({"text":format!("{path} ({} lines)\n{}{more}",lines.len(),shown.join("\n")),"data":{"path":path,"readKey":key,"mtimeMs":stamp.mtime_ms,"size":stamp.size}}),
    )
}
fn positive(v: Option<&Value>, default: usize) -> usize {
    v.and_then(Value::as_f64)
        .filter(|n| *n > 0.0)
        .map(|n| n as usize)
        .unwrap_or(default)
}
fn string<'a>(args: &'a Value, key: &str) -> Result<&'a str, EffectError> {
    args[key]
        .as_str()
        .ok_or_else(|| error(400, format!("{key} must be a string")))
}
fn open_write(
    file: &ResolvedFile,
    append: bool,
    create: bool,
    context: &FileContext,
) -> Result<File, EffectError> {
    assert_resolved_writable(context, file)?;
    let mut options = OpenOptions::new();
    options
        .write(true)
        .append(append)
        .truncate(!append)
        .create(create);
    #[cfg(unix)]
    if context.sandbox.mode != SandboxMode::Off {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    if context.sandbox.mode != SandboxMode::Off {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        // FILE_ATTRIBUTE_REPARSE_POINT: junctions and symlinks are not safe
        // write targets. OPEN_REPARSE_POINT avoids traversing a swapped link.
        if fs::symlink_metadata(file).is_ok_and(|m| m.file_attributes() & 0x400 != 0) {
            return Err(error(
                403,
                "Sandboxed native writes cannot target a reparse point",
            ));
        }
        options.custom_flags(0x0020_0000);
    }
    options
        .open(file)
        .map_err(|e| resolved_io_error("open", file, e))
}
fn write(file: &ResolvedFile, args: &Value, context: &FileContext) -> Result<Value, EffectError> {
    assert_resolved_writable(context, file)?;
    let content = string(args, "content")?;
    let append = args["append"].as_bool().unwrap_or(false);
    if append {
        match fs::metadata(file) {
            Ok(info) if info.is_dir() => {
                return Err(encoded_error(
                    400,
                    format!(
                        "{} is a folder, not a file. Give a file path inside it.",
                        file.display()
                    ),
                ))
            }
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err(resolved_io_error("stat", file, e))
            }
            _ => {}
        }
    } else {
        assert_seen(context, file)?;
        assert_fresh(context, file, "overwrite")?;
    }
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| io_error("mkdir", parent, e))?;
    }
    let mut output = open_write(file, append, true, context)?;
    output
        .write_all(sql_text(content).as_bytes())
        .map_err(|e| resolved_io_error("write", file, e))?;
    drop(output);
    let now = read_text(file)?;
    remember(context, file);
    let sha = sha(&now);
    let path = file.text();
    Ok(
        json!({"text":format!("{} {} characters to {path} (now {} lines, {} bytes, sha {sha})",if append {"Appended"} else {"Wrote"},utf16_units(content).len(),now.split('\n').count(),now.len()),"data":{"path":path,"op":if append {"append"} else {"write"},"bytes":now.len(),"sha":sha}}),
    )
}
fn edit(file: &ResolvedFile, args: &Value, context: &FileContext) -> Result<Value, EffectError> {
    assert_resolved_writable(context, file)?;
    assert_fresh(context, file, "edit")?;
    let before = read_text(file)?;
    let old = utf16_units(string(args, "old_string")?);
    let new = utf16_units(string(args, "new_string")?);
    if old.is_empty() {
        return Err(error(400, "old_string must not be empty"));
    }
    if old == new {
        return Err(error(400, "old_string and new_string are identical"));
    }
    let units: Vec<_> = before.encode_utf16().collect();
    let mut matches = Vec::new();
    let mut pos = 0;
    while pos + old.len() <= units.len() {
        if units[pos..].starts_with(&old) {
            matches.push(pos);
            pos += old.len();
        } else {
            pos += 1;
        }
    }
    if matches.is_empty() {
        let first = old
            .split(|u| *u == 10)
            .map(trim_units)
            .find(|l| !l.is_empty())
            .unwrap_or(&[]);
        let probe = &first[..first.len().min(40)];
        let near = if probe.is_empty() {
            vec![]
        } else {
            units
                .split(|u| *u == 10)
                .enumerate()
                .filter(|(_, line)| line.windows(probe.len()).any(|s| s == probe))
                .take(3)
                .map(|(i, l)| format!("{}: {}", i + 1, from_utf16_units(&l[..l.len().min(200)])))
                .collect::<Vec<_>>()
        };
        let message = format!(
            "old_string was not found in {}.{}",
            file.text(),
            if near.is_empty() {
                " Read the file again; it may have changed.".into()
            } else {
                format!(" Similar lines:\n{}", near.join("\n"))
            }
        );
        return Err(encoded_error(409, message));
    }
    let replace_all = args["replace_all"].as_bool().unwrap_or(false);
    if matches.len() != 1 && !replace_all {
        return Err(error(409, format!("old_string occurs {} times; add surrounding lines to make it unique or set replace_all.",matches.len())));
    }
    let mut after = Vec::new();
    let mut cursor = 0;
    for &at in matches
        .iter()
        .take(if replace_all { matches.len() } else { 1 })
    {
        after.extend_from_slice(&units[cursor..at]);
        after.extend_from_slice(&new);
        cursor = at + old.len();
    }
    after.extend_from_slice(&units[cursor..]);
    let after = String::from_utf16_lossy(&after);
    let mut output = open_write(file, false, true, context)?;
    output
        .write_all(after.as_bytes())
        .map_err(|e| resolved_io_error("write", file, e))?;
    drop(output);
    remember(context, file);
    let line = units[..matches[0]].iter().filter(|&&u| u == 10).count() + 1;
    let location = if replace_all {
        format!("{} replacements", matches.len())
    } else {
        format!("line {line}")
    };
    let path = file.text();
    let sha = sha(&after);
    Ok(
        json!({"text":format!("Edited {path}: {location} (sha {sha})"),"data":{"path":path,"op":"edit","bytes":after.len(),"sha":sha}}),
    )
}
fn trim_units(mut text: &[u16]) -> &[u16] {
    fn space(u: u16) -> bool {
        matches!(u,0x0009..=0x000d|0x0020|0x00a0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
    }
    while text.first().is_some_and(|u| space(*u)) {
        text = &text[1..];
    }
    while text.last().is_some_and(|u| space(*u)) {
        text = &text[..text.len() - 1];
    }
    text
}
fn sha(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))[..12].into()
}
fn encoded_error(status: u16, message: String) -> EffectError {
    EffectError {
        error: json!({"message":message,"status":status}),
        aborted: false,
    }
}
fn error(status: u16, message: impl AsRef<str>) -> EffectError {
    encoded_error(status, encode_text(message.as_ref()))
}
fn assert_resolved_writable(context: &FileContext, file: &ResolvedFile) -> Result<(), EffectError> {
    assert_writable(&context.sandbox, &context.cwd, &file.os).map_err(|mut e| {
        if let Some(message) = e.error["message"].as_str() {
            e.error["message"] =
                json!(message.replace(&encode_text(&file.os.to_string_lossy()), &file.text()));
        }
        e
    })
}
fn resolved_io_error(op: &str, file: &ResolvedFile, e: std::io::Error) -> EffectError {
    let mut error = io_error(op, &file.os, e);
    if let Some(message) = error.error["message"].as_str() {
        error.error["message"] =
            json!(message.replace(&encode_text(&file.os.to_string_lossy()), &file.text()));
    }
    error
}

fn io_error(op: &str, path: &Path, e: std::io::Error) -> EffectError {
    let (status, code) = match e.kind() {
        std::io::ErrorKind::NotFound => (404, "ENOENT"),
        std::io::ErrorKind::PermissionDenied => (403, "EACCES"),
        std::io::ErrorKind::AlreadyExists => (409, "EEXIST"),
        _ => (500, "EIO"),
    };
    EffectError {
        error: json!({"message":encode_text(&format!("{code}: {e}, {op} '{}'",path.display())),"status":status,"code":code}),
        aborted: false,
    }
}

#[cfg(test)]
mod tests;
