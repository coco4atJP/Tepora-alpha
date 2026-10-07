//! Bounded session file listing/download. Symlink destinations cannot escape
//! the selected session folder; this intentionally tightens the old lexical
//! prefix-only download check. No application or model code is executed here.
use super::*;
use std::io::Read;

pub(super) fn list_files(root: &Path) -> Result<Value, ApiError> {
    fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<Value>) -> Result<(), ApiError> {
        let Ok(entries) = fs::read_dir(dir) else {
            return Ok(());
        };
        let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            if out.len() >= 300 {
                break;
            }
            let name = entry.file_name();
            if [".git", "node_modules", ".venv", "__pycache__"]
                .iter()
                .any(|s| name == std::ffi::OsStr::new(s))
            {
                continue;
            }
            let kind = entry.file_type().map_err(error)?;
            if kind.is_dir() {
                if depth < 5 {
                    walk(root, &entry.path(), depth + 1, out)?;
                }
            } else if kind.is_file() {
                let info = entry.metadata().map_err(error)?;
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .map_err(error)?
                    .components()
                    .map(|p| p.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                let modified: chrono::DateTime<Utc> = info.modified().map_err(error)?.into();
                out.push(json!({"path":json_codec::encode_text(&relative),"bytes":info.len(),"modifiedAt":modified.to_rfc3339_opts(SecondsFormat::Millis,true)}));
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(root, root, 0, &mut files)?;
    Ok(json!({"root":json_codec::encode_text(&root.to_string_lossy()),"files":files}))
}
pub(super) fn download(root: &Path, selected: &str) -> Result<(Vec<u8>, String), ApiError> {
    let root = fs::canonicalize(root).map_err(error)?;
    let selected = json_codec::sql_text(selected);
    let requested = root.join(selected);
    let mut lexical = PathBuf::new();
    for part in requested.components() {
        match part {
            std::path::Component::ParentDir => {
                lexical.pop();
            }
            std::path::Component::CurDir => {}
            part => lexical.push(part.as_os_str()),
        }
    }
    require(
        lexical != root && lexical.starts_with(&root),
        403,
        "File is outside the session folder",
    )?;
    let file = fs::canonicalize(&requested).map_err(error)?;
    require(
        file != root && file.starts_with(&root),
        403,
        "File is outside the session folder",
    )?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut handle = options.open(&file).map_err(error)?;
    let info = handle.metadata().map_err(error)?;
    require(
        info.is_file() && info.len() <= 50_000_000,
        413,
        "Download is limited to 50 MB",
    )?;
    // Recheck a bounded read even when the file grows after metadata.
    let mut bytes = Vec::with_capacity(info.len() as usize);
    (&mut handle)
        .take(50_000_001)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    require(
        bytes.len() <= 50_000_000,
        413,
        "Download is limited to 50 MB",
    )?;
    let name = requested.file_name().unwrap_or_default().to_string_lossy();
    let mut encoded = String::new();
    for b in name.as_bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(b) {
            encoded.push(*b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    Ok((bytes, format!("attachment; filename*=UTF-8''{encoded}")))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn files_are_bounded_and_internal_directories_are_skipped() {
        let dir = env::temp_dir().join(format!("tepora-session-files-{}", Uuid::new_v4()));
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git/secret"), "skip").unwrap();
        fs::write(dir.join("résumé.txt"), "hello").unwrap();
        let value = list_files(&dir).unwrap();
        assert_eq!(value["files"].as_array().unwrap().len(), 1);
        assert_eq!(value["files"][0]["bytes"], 5);
        let (bytes, header) = download(&dir, "résumé.txt").unwrap();
        assert_eq!(bytes, b"hello");
        assert!(header.ends_with("r%C3%A9sum%C3%A9.txt"));
        assert_eq!(download(&dir, "").unwrap_err().status, 403);
        fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn download_rejects_external_symlink_but_allows_internal_link() {
        use std::os::unix::fs::symlink;
        let dir = env::temp_dir().join(format!("tepora-session-links-{}", Uuid::new_v4()));
        fs::create_dir_all(dir.join("work")).unwrap();
        fs::write(dir.join("outside"), "private").unwrap();
        fs::write(dir.join("work/inside"), "public").unwrap();
        symlink("../outside", dir.join("work/escape")).unwrap();
        symlink("inside", dir.join("work/link")).unwrap();
        assert_eq!(
            download(&dir.join("work"), "escape").unwrap_err().status,
            403
        );
        assert_eq!(download(&dir.join("work"), "link").unwrap().0, b"public");
        assert_eq!(
            list_files(&dir.join("work")).unwrap()["files"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
