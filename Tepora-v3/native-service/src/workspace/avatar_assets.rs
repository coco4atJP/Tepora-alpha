//! Local avatar assets. Files never leave this service and share its state owner.
use super::*;
use sha2::{Digest, Sha256};
use std::io::Write;
mod inspect;
pub(crate) use inspect::MAX_ASSET_BYTES;
const MAX_ASSETS: usize = 24;
const MAX_LIBRARY_BYTES: u64 = 1024 * 1024 * 1024;
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn public(entry: &Value) -> Value {
    let mut out = pick(
        entry,
        &["id", "kind", "name", "bytes", "createdAt", "meta", "files"],
    );
    out["files"] = json!(entry["files"]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .map(|f| pick(f, &["path", "mime", "bytes"]))
        .collect::<Vec<_>>());
    out
}
pub(super) fn snapshot(list: &Value) -> Value {
    json!({"assets":list.as_array().unwrap_or(&Vec::new()).iter().map(public).collect::<Vec<_>>(),"limits":{"maxAssets":MAX_ASSETS,"maxBytes":MAX_ASSET_BYTES,"maxVrmBytes":inspect::MAX_VRM_BYTES,"maxLibraryBytes":MAX_LIBRARY_BYTES}})
}
fn filename(name: &str) -> String {
    filename_for(name, cfg!(windows))
}
fn filename_for(name: &str, windows: bool) -> String {
    let units = json_codec::utf16_units(name);
    let drive = windows
        && units.len() >= 2
        && ((65..=90).contains(&units[0]) || (97..=122).contains(&units[0]))
        && units[1] == 58;
    let units = &units[if drive { 2 } else { 0 }..];
    let sep = |u: &u16| *u == 47 || (windows && *u == 92);
    let end = units
        .iter()
        .rposition(|u| !sep(u))
        .map(|i| i + 1)
        .unwrap_or(0);
    let start = units[..end]
        .iter()
        .rposition(sep)
        .map(|i| i + 1)
        .unwrap_or(0);
    let cleaned = units[start..end]
        .iter()
        .map(|u| if *u <= 31 || *u == 127 { 32 } else { *u })
        .collect::<Vec<_>>();
    let whitespace = |u: &u16| matches!(*u,0x0009..=0x000d|0x0020|0x00a0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff);
    let first = cleaned
        .iter()
        .position(|u| !whitespace(u))
        .unwrap_or(cleaned.len());
    let last = cleaned
        .iter()
        .rposition(|u| !whitespace(u))
        .map(|i| i + 1)
        .unwrap_or(first);
    let units = &cleaned[first..last.min(first + 80)];
    let end = units
        .iter()
        .rposition(|u| *u == 46)
        .filter(|i| *i + 1 < units.len())
        .unwrap_or(units.len());
    json_codec::from_utf16_units(&units[..end])
}
fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
}
impl Workspace {
    pub(super) fn execute_avatar_assets(&self, op: &Operation) -> Result<Option<Reply>, ApiError> {
        if !matches!(
            op,
            Operation::AvatarAssets
                | Operation::AvatarAssetAdd { .. }
                | Operation::AvatarAssetRead { .. }
                | Operation::AvatarAssetDelete { .. }
        ) {
            return Ok(None);
        }
        // Only assets take this lock; no SQLite lock is retained over filesystem I/O.
        let _change = self.avatar_asset_changes.lock().map_err(error)?;
        let (dir, mut list) = {
            let mut s = self.lock()?;
            require(!s.closed && !s.closing, 503, "Service closing")?;
            (
                s.dir.join("avatar"),
                s.value("avatar-assets")?
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
            )
        };
        match op {
            Operation::AvatarAssets => Ok(Some(Reply::Json(snapshot(&json!(list))))),
            Operation::AvatarAssetAdd {
                kind,
                bytes,
                filename: name,
            } => {
                require(
                    ["vrm", "image", "imageset", "mesh"].contains(&kind.as_str()),
                    400,
                    "素材の種類が正しくありません。",
                )?;
                require(!bytes.is_empty(), 400, "ファイルを選んでください。")?;
                let checked = inspect::inspect(kind, bytes)?;
                let hash = digest(bytes);
                if let Some(same) = list
                    .iter()
                    .find(|a| a["kind"] == *kind && a["sha256"] == hash)
                {
                    let mut value = snapshot(&json!(list));
                    value["asset"] = public(same);
                    value["existing"] = json!(true);
                    return Ok(Some(Reply::Json(value)));
                }
                require(
                    list.len() < MAX_ASSETS,
                    413,
                    "素材は24件までです。使わないものを削除してください。",
                )?;
                require(
                    list.iter()
                        .map(|a| a["bytes"].as_u64().unwrap_or(0))
                        .sum::<u64>()
                        + bytes.len() as u64
                        <= MAX_LIBRARY_BYTES,
                    413,
                    "保存できる素材の合計サイズを超えます。",
                )?;
                let id = Uuid::new_v4().to_string();
                let temp = dir.join(format!(".upload-{}", Uuid::new_v4()));
                let final_dir = dir.join(&id);
                let mut stored = Vec::new();
                fs::create_dir_all(&temp).map_err(error)?;
                let written = (|| -> std::io::Result<()> {
                    for (index, file) in checked.files.iter().enumerate() {
                        let mut f = fs::OpenOptions::new()
                            .write(true)
                            .create_new(true)
                            .open(temp.join(index.to_string()))?;
                        f.write_all(&file.bytes)?;
                        stored.push(json!({"path":file.path,"mime":file.mime,"bytes":file.bytes.len(),"sha256":digest(&file.bytes),"store":index}));
                    }
                    fs::rename(&temp, &final_dir)
                })();
                if let Err(e) = written {
                    let _ = fs::remove_dir_all(&temp);
                    return Err(error(e));
                }
                let name = checked
                    .name
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| filename(name));
                let name = if name.is_empty() {
                    match kind.as_str() {
                        "vrm" => "3Dモデル",
                        "image" => "画像",
                        "imageset" => "画像セット",
                        _ => "メッシュアバター",
                    }
                    .into()
                } else {
                    name
                };
                let entry = json!({"id":id,"kind":kind,"name":name,"bytes":bytes.len(),"sha256":hash,"createdAt":now(),"meta":checked.meta,"files":stored});
                let asset = public(&entry);
                list.push(entry);
                let mut result = self.commit_avatar_assets(list, None)?;
                result["asset"] = asset;
                Ok(Some(Reply::Json(result)))
            }
            Operation::AvatarAssetRead { id, .. } | Operation::AvatarAssetDelete { id } => {
                require(valid_id(id), 404, "素材が見つかりません。")?;
                let meta = list
                    .iter()
                    .find(|a| a["id"] == *id)
                    .ok_or_else(|| ApiError::new(404, "素材が見つかりません。"))?;
                if let Operation::AvatarAssetRead { path, .. } = op {
                    let entry = meta["files"]
                        .as_array()
                        .and_then(|files| files.iter().find(|f| f["path"] == *path))
                        .ok_or_else(|| ApiError::new(404, "素材のファイルが見つかりません。"))?;
                    let bytes = fs::read(dir.join(id).join(str_of(&entry["store"])))
                        .map_err(|_| ApiError::new(404, "素材のファイルが見つかりません。"))?;
                    require(
                        entry["sha256"] == digest(&bytes),
                        409,
                        "保存した素材が変更されています。追加し直してください。",
                    )?;
                    return Ok(Some(Reply::AvatarFile {
                        bytes,
                        mime: entry["mime"].as_str().unwrap_or("").into(),
                    }));
                }
                let path = dir.join(id);
                let removed = match fs::remove_dir_all(&path) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotADirectory => {
                        fs::remove_file(&path)
                    }
                    other => other,
                };
                match removed {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(error(e)),
                };
                list.retain(|a| a["id"] != *id);
                let mut value = self.commit_avatar_assets(list, Some(id))?;
                value["removed"] = json!(id);
                Ok(Some(Reply::Json(value)))
            }
            _ => unreachable!(),
        }
    }
    fn commit_avatar_assets(
        &self,
        list: Vec<Value>,
        removed: Option<&str>,
    ) -> Result<Value, ApiError> {
        let value = snapshot(&json!(list));
        let mut s = self.lock()?;
        // Graceful close drains this admitted operation before closing the database.
        require(!s.closed, 503, "Service closing")?;
        s.set_value("avatar-assets", json!(list))?;
        let event = s.call(
            "event.append",
            json!({"type":"avatar.assets","data":value,"at":now()}),
        )?;
        s.publish_value(event)?;
        if let Some(id) = removed {
            s.avatar_asset_removed(id)?;
        }
        Ok(value)
    }
}
#[cfg(test)]
#[path = "avatar_assets/tests.rs"]
mod tests;
