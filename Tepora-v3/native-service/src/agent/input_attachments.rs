//! Materialization of server-resolved attachment snapshots. No request body can
//! supply a path grant, image payload, or trusted attachment metadata here. All
//! filesystem work runs outside the coordinator, and cancellation never detaches
//! a dispatched filesystem operation from its drain receipt.
use super::EffectError;
use crate::{network::RequestCancellation, workspace::input_files::inspect_image, ApiError};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
};
use tepora_core::json_codec::{from_utf16_units, sql_text, utf16_units};

struct Image {
    name: String,
    info: Value,
    bytes: Vec<u8>,
}
struct Saved {
    files: Vec<Value>,
    images: Vec<Image>,
}
static FILESYSTEM_WORKERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
fn check(cancel: &RequestCancellation) -> Result<(), ApiError> {
    if cancel.is_cancelled() {
        Err(ApiError::new(503, "Attachment preparation was cancelled"))
    } else {
        Ok(())
    }
}
fn io_error(error: io::Error) -> ApiError {
    ApiError::new(500, format!("Could not save attachment: {error}"))
}
fn invalid(message: &str) -> ApiError {
    ApiError::bad_request(message)
}

// HTTP admission may itself occupy Tokio's blocking pool. A dedicated owned
// thread avoids a pool waiter/work dependency cycle; the actor bounds concurrent
// preparations. Awaiting its receipt also joins the actual filesystem worker.
async fn filesystem_task<T: Send + 'static>(
    cancel: &RequestCancellation,
    work: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    let permit = tokio::select! { biased;
        _ = cancel.cancelled() => return Err(ApiError::new(503,"Attachment preparation was cancelled")),
        permit = FILESYSTEM_WORKERS.acquire() => permit.map_err(|_|ApiError::new(503,"Attachment filesystem owner closed"))?,
    };
    check(cancel)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let worker = std::thread::Builder::new()
        .name("tepora-input-files".into())
        .spawn(move || {
            let _permit = permit;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(work))
                .unwrap_or_else(|_| Err(ApiError::new(500, "Attachment filesystem task panicked")));
            let _ = tx.send(result);
        })
        .map_err(|_| ApiError::new(503, "Cannot start attachment filesystem task"))?;
    let result = rx
        .await
        .map_err(|_| ApiError::new(500, "Attachment filesystem task lost its receipt"));
    worker
        .join()
        .map_err(|_| ApiError::new(500, "Attachment filesystem task failed"))?;
    result?
}

/// Values are cloned from Workspace.resolve_inputs, never taken from HTTP
/// attachment metadata. A failed task leaves any already-created files on disk,
/// matching the source's partial-write behavior; it never caches acceptance.
pub(crate) async fn materialize(
    work_root: String,
    date: String,
    documents: Vec<Value>,
    cancellation: RequestCancellation,
) -> Result<Value, EffectError> {
    check(&cancellation)?;
    let worker_cancel = cancellation.clone();
    let saved = filesystem_task(&cancellation, move || {
        save_files(&work_root, &date, &documents, &worker_cancel)
    })
    .await?;
    check(&cancellation)?;
    let mut images = Vec::new();
    // Source chooses the first four image attachments before attempting loads.
    // A skipped large image does not allow a fifth attachment to enter context.
    for image in saved.images.into_iter().take(4) {
        check(&cancellation)?;
        let big = image.info["width"]
            .as_u64()
            .unwrap_or(0)
            .max(image.info["height"].as_u64().unwrap_or(0))
            > 1568
            || image.bytes.len() > 3_500_000;
        let loaded = if big {
            resize_image(image, &cancellation).await.ok()
        } else {
            Some(inline_image(image.info, image.name))
        };
        check(&cancellation)?;
        if let Some(image) = loaded {
            images.push(image);
        }
    }
    Ok(json!({"files":saved.files,"images":images}))
}
fn inline_image(info: Value, name: String) -> Value {
    json!({"mime":info["mime"],"width":info["width"],"height":info["height"],"bytes":info["bytes"],"base64":info["base64"],"name":name})
}
fn valid_date(date: &str) -> bool {
    date.len() == 10
        && chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .is_ok_and(|parsed| parsed.format("%Y-%m-%d").to_string() == date)
}
fn safe_name(name: &str) -> Result<String, ApiError> {
    let mut units = utf16_units(name);
    if units.is_empty()
        || units.len() > 160
        || units.iter().any(|u| *u <= 31 || [47, 58, 92].contains(u))
    {
        return Err(invalid("Invalid staged attachment name"));
    }
    for unit in &mut units {
        if [47, 58, 92, 42, 63, 34, 60, 62, 124].contains(unit) {
            *unit = 95;
        }
    }
    let name = from_utf16_units(&units);
    if name == "." || name == ".." {
        return Err(invalid("Invalid staged attachment name"));
    }
    Ok(name)
}
fn numbered_name(name: &str, number: u64) -> String {
    if number == 0 {
        return name.into();
    }
    match name.rfind('.') {
        Some(at) => format!("{}-{number}{}", &name[..at], &name[at..]),
        None => format!("{name}-{number}"),
    }
}
fn save_files(
    root: &str,
    date: &str,
    docs: &[Value],
    cancel: &RequestCancellation,
) -> Result<Saved, ApiError> {
    check(cancel)?;
    if docs.len() > 6 || !valid_date(date) {
        return Err(invalid("Invalid attachment preparation snapshot"));
    }
    if docs.is_empty() {
        return Ok(Saved {
            files: vec![],
            images: vec![],
        });
    }
    let os_root = PathBuf::from(sql_text(root));
    if !os_root.is_absolute() {
        return Err(invalid("Attachment workRoot must be absolute"));
    }
    // Resolve and validate all bytes before creating a file in this batch.
    let mut prepared = Vec::new();
    let (mut total, mut text_total) = (0usize, 0usize);
    for doc in docs {
        let name = doc["name"]
            .as_str()
            .ok_or_else(|| invalid("Missing staged attachment name"))?;
        let safe = safe_name(name)?;
        let (bytes, image) = if doc["kind"] == "image" {
            let encoded = doc["base64"]
                .as_str()
                .ok_or_else(|| invalid("Missing staged image bytes"))?;
            let info = inspect_image(encoded, name)?;
            let bytes = STANDARD
                .decode(sql_text(encoded))
                .map_err(|_| invalid("Invalid staged image bytes"))?;
            (bytes, Some(info))
        } else {
            let content = doc["content"]
                .as_str()
                .ok_or_else(|| invalid("Missing staged text content"))?;
            let bytes = sql_text(content).into_bytes();
            if bytes.is_empty() || bytes.len() > 256 * 1024 || bytes.contains(&0) {
                return Err(invalid("Invalid staged text bytes"));
            }
            text_total += bytes.len();
            (bytes, None)
        };
        let checksum = format!("{:x}", Sha256::digest(&bytes));
        if doc["sha256"].as_str() != Some(checksum.as_str())
            || doc["bytes"].as_u64() != Some(bytes.len() as u64)
        {
            return Err(ApiError::new(
                409,
                "添付ファイルが変更されています。再度確認してください。",
            ));
        }
        total += bytes.len();
        if total > 8 * 1024 * 1024 || text_total > 1024 * 1024 {
            return Err(ApiError::new(
                413,
                "Attachment selection exceeds its byte limit",
            ));
        }
        prepared.push((name.to_owned(), safe, bytes, image));
    }
    let destination = Destination::open(&os_root, date).map_err(io_error)?;
    let logical_folder = PathBuf::from(root).join("inbox").join(date);
    let mut saved = Saved {
        files: vec![],
        images: vec![],
    };
    for (name, safe, bytes, image) in prepared {
        check(cancel)?;
        let mut number = 0u64;
        let (mut file, selected) = loop {
            check(cancel)?;
            let selected = numbered_name(&safe, number);
            match destination.create(&sql_text(&selected)) {
                Ok(file) => break (file, selected),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    number = number
                        .checked_add(1)
                        .ok_or_else(|| invalid("Too many attachment filename collisions"))?;
                }
                Err(error) => return Err(io_error(error)),
            }
        };
        file.write_all(&bytes).map_err(io_error)?;
        drop(file);
        destination.verify().map_err(io_error)?;
        let path = logical_folder.join(selected).to_string_lossy().into_owned();
        saved
            .files
            .push(json!({"path":path,"name":name,"kind":if image.is_some(){"image"}else{"text"}}));
        if let Some(info) = image {
            saved.images.push(Image { name, info, bytes });
        }
        check(cancel)?;
    }
    Ok(saved)
}

// Directory handles keep each write under the selected root. In particular,
// an existing symlink/reparse point named inbox or date is never traversed.
#[cfg(unix)]
struct Destination {
    folder: File,
    path: PathBuf,
}
#[cfg(unix)]
impl Destination {
    fn open(root: &Path, date: &str) -> io::Result<Self> {
        use std::os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::OpenOptionsExt,
        };
        fs::create_dir_all(root)?;
        let mut folder = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
            .open(root)?;
        for name in ["inbox", date] {
            let name = std::ffi::CString::new(name).unwrap();
            if unsafe { libc::mkdirat(folder.as_raw_fd(), name.as_ptr(), 0o777) } < 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::AlreadyExists {
                    return Err(error);
                }
            }
            let fd = unsafe {
                libc::openat(
                    folder.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            folder = unsafe { File::from_raw_fd(fd) };
        }
        Ok(Self {
            folder,
            path: root.join("inbox").join(date),
        })
    }
    fn verify(&self) -> io::Result<()> {
        use std::os::unix::fs::MetadataExt;
        let live = fs::symlink_metadata(&self.path)?;
        let pinned = self.folder.metadata()?;
        if !live.is_dir() || live.dev() != pinned.dev() || live.ino() != pinned.ino() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Attachment directory changed during preparation",
            ));
        }
        Ok(())
    }
    fn create(&self, name: &str) -> io::Result<File> {
        use std::os::fd::{AsRawFd, FromRawFd};
        let name = std::ffi::CString::new(name)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid filename"))?;
        let fd = unsafe {
            libc::openat(
                self.folder.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o666,
            )
        };
        if fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(fd) })
        }
    }
}
#[cfg(windows)]
struct Destination {
    folder: PathBuf,
    _parents: Vec<File>,
}
#[cfg(windows)]
impl Destination {
    fn open(root: &Path, date: &str) -> io::Result<Self> {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        fn pin(path: &Path) -> io::Result<File> {
            // Deny FILE_SHARE_DELETE to prevent renaming a pinned ancestor.
            let handle = fs::OpenOptions::new()
                .read(true)
                .share_mode(0x1 | 0x2)
                .custom_flags(0x02000000 | 0x00200000)
                .open(path)?;
            let meta = handle.metadata()?;
            if !meta.is_dir() || meta.file_attributes() & 0x400 != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Attachment directory is a reparse point",
                ));
            }
            Ok(handle)
        }
        fs::create_dir_all(root)?;
        let mut folder = fs::canonicalize(root)?;
        let mut paths = folder
            .ancestors()
            .map(Path::to_path_buf)
            .collect::<Vec<_>>();
        paths.reverse();
        let mut parents = paths
            .iter()
            .map(|path| pin(path))
            .collect::<io::Result<Vec<_>>>()?;
        for name in ["inbox", date] {
            folder.push(name);
            match fs::create_dir(&folder) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
            parents.push(pin(&folder)?);
        }
        Ok(Self {
            folder,
            _parents: parents,
        })
    }
    fn create(&self, name: &str) -> io::Result<File> {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.folder.join(name))
    }
    fn verify(&self) -> io::Result<()> {
        Ok(())
    }
}
#[cfg(not(any(unix, windows)))]
struct Destination;
#[cfg(not(any(unix, windows)))]
impl Destination {
    fn open(_: &Path, _: &str) -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Secure attachment materialization is unavailable on this platform",
        ))
    }
    fn create(&self, _: &str) -> io::Result<File> {
        unreachable!()
    }
    fn verify(&self) -> io::Result<()> {
        unreachable!()
    }
}

#[cfg(not(target_os = "macos"))]
async fn resize_image(_: Image, _: &RequestCancellation) -> Result<Value, ApiError> {
    Err(ApiError::new(
        415,
        "The image is too large and cannot be resized here",
    ))
}
#[cfg(target_os = "macos")]
async fn resize_image(image: Image, cancel: &RequestCancellation) -> Result<Value, ApiError> {
    use std::{process::Stdio, time::Duration};
    struct Temp(PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let prepared = filesystem_task(cancel, move || -> Result<(Temp, String), ApiError> {
        use std::os::unix::fs::DirBuilderExt;
        let root = std::env::temp_dir().join(format!("tepora-image-{}", uuid::Uuid::new_v4()));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .map_err(io_error)?;
        let guard = Temp(root);
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(guard.0.join("input"))
            .map_err(io_error)?;
        file.write_all(&image.bytes).map_err(io_error)?;
        Ok((guard, image.name))
    })
    .await?;
    let (guard, name) = prepared;
    check(cancel)?;
    let mut child = tokio::process::Command::new("/usr/bin/sips")
        .args([
            "-s",
            "format",
            "jpeg",
            "-s",
            "formatOptions",
            "80",
            "-Z",
            "1568",
        ])
        .arg(guard.0.join("input"))
        .arg("--out")
        .arg(guard.0.join("image.jpg"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(io_error)?;
    let status = tokio::select! {biased;
        _=cancel.cancelled()=>{let _=child.kill().await;let _=child.wait().await;return Err(ApiError::new(503,"Image conversion cancelled"));},
        _=tokio::time::sleep(Duration::from_secs(30))=>{let _=child.kill().await;let _=child.wait().await;return Err(ApiError::new(504,"Image conversion timed out"));},
        result=child.wait()=>result.map_err(io_error)?,
    };
    if !status.success() {
        return Err(ApiError::new(415, "The image could not be converted"));
    }
    check(cancel)?;
    filesystem_task(cancel, move || {
        let bytes = fs::read(guard.0.join("image.jpg")).map_err(io_error)?;
        let info = inspect_image(&STANDARD.encode(bytes), &name)?;
        Ok(inline_image(info, name))
    })
    .await
}

#[cfg(test)]
mod tests;
