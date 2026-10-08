//! Inert local photo bytes, using the existing Workspace database/event owner.
use super::*;
use sha2::{Digest, Sha256};
use std::io::Write;
pub(crate) const MAX_PHOTO_BYTES: usize = 24 * 1024 * 1024;
const MAX_PHOTOS: usize = 300;
const MAX_FRAME_BYTES: u64 = 2 * 1024 * 1024 * 1024;
fn be16(b: &[u8], i: usize) -> u32 {
    u16::from_be_bytes([b[i], b[i + 1]]) as u32
}
fn le16(b: &[u8], i: usize) -> u32 {
    u16::from_le_bytes([b[i], b[i + 1]]) as u32
}
fn le24(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], 0])
}
fn jpeg_size(b: &[u8]) -> (u32, u32) {
    let mut i = 2;
    while i + 9 < b.len() {
        if b[i] != 255 || b[i + 1] == 255 {
            i += 1;
            continue;
        }
        let marker = b[i + 1];
        i += 2;
        if marker == 216 || marker == 1 || (208..=215).contains(&marker) {
            continue;
        }
        if marker == 217 {
            break;
        }
        let length = be16(b, i) as usize;
        if (192..=207).contains(&marker) && ![196, 200, 204].contains(&marker) {
            return (be16(b, i + 5), be16(b, i + 3));
        }
        i += length.max(2);
    }
    (0, 0)
}
fn inspect(b: &[u8]) -> Result<(&'static str, &'static str, u32, u32), ApiError> {
    require(b.len() >= 16, 400, "画像ファイルを選んでください。")?;
    require(b.len() <= MAX_PHOTO_BYTES, 413, "写真は24MBまでです。")?;
    let (mime, ext, w, h) = if b.starts_with(&[255, 216, 255]) {
        let (w, h) = jpeg_size(b);
        ("image/jpeg", "jpg", w, h)
    } else if b.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) && &b[12..16] == b"IHDR" {
        // Node's Buffer reader throws on a truncated IHDR, rather than accepting it.
        if b.len() < 24 {
            return Err(ApiError::new(500,format!("The value of \"offset\" is out of range. It must be >= 0 and <= {}. Received {}",b.len()-4,if b.len()<20 {16}else{20})));
        }
        (
            "image/png",
            "png",
            u32::from_be_bytes(b[16..20].try_into().unwrap()),
            u32::from_be_bytes(b[20..24].try_into().unwrap()),
        )
    } else if &b[..6] == b"GIF87a" || &b[..6] == b"GIF89a" {
        ("image/gif", "gif", le16(b, 6), le16(b, 8))
    } else if &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        let (w, h) = match &b[12..16] {
            b"VP8X" if b.len() >= 30 => (1 + le24(b, 24), 1 + le24(b, 27)),
            b"VP8 " if b.len() >= 30 && b[23..26] == [157, 1, 42] => {
                (le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff)
            }
            b"VP8L" if b.len() >= 25 && b[20] == 47 => (
                1 + (((b[22] as u32 & 63) << 8) | b[21] as u32),
                1 + (((b[24] as u32 & 15) << 10)
                    | ((b[23] as u32) << 2)
                    | ((b[22] as u32 & 192) >> 6)),
            ),
            _ => (0, 0),
        };
        ("image/webp", "webp", w, h)
    } else if &b[4..8] == b"ftyp" && [&b"avif"[..], &b"avis"[..]].contains(&&b[8..12]) {
        ("image/avif", "avif", 0, 0)
    } else {
        return Err(ApiError::bad_request(
            "JPEG・PNG・WebP・GIF・AVIFの写真を選んでください。",
        ));
    };
    if w != 0 || h != 0 {
        require(w > 0 && h > 0, 400, "画像の大きさを読み取れません。")?;
        require(
            u64::from(w) * u64::from(h) <= 120_000_000,
            413,
            "画像が大きすぎます。画面に十分な大きさに縮小して選んでください。",
        )?;
    }
    Ok((mime, ext, w, h))
}
pub(super) fn snapshot(list: &Value) -> Value {
    json!({"photos":list.as_array().unwrap_or(&Vec::new()).iter().map(|p|pick(p,&["id","name","mime","bytes","width","height","addedAt"])).collect::<Vec<_>>(),"limits":{"maxPhotos":MAX_PHOTOS,"maxBytes":MAX_PHOTO_BYTES,"maxTotalBytes":MAX_FRAME_BYTES}})
}
fn filename(name: &str) -> String {
    filename_for(name, cfg!(windows))
}
fn filename_for(name: &str, windows: bool) -> String {
    let units = json_codec::utf16_units(name);
    let drive = windows
        && units.len() >= 2
        && ((units[0] >= 65 && units[0] <= 90) || (units[0] >= 97 && units[0] <= 122))
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
    if first == last {
        "写真".into()
    } else {
        json_codec::from_utf16_units(&cleaned[first..last.min(first + 120)])
    }
}
impl Workspace {
    pub(super) fn execute_frame(&self, op: &Operation) -> Result<Option<Reply>, ApiError> {
        if !matches!(
            op,
            Operation::Frame
                | Operation::FrameAdd { .. }
                | Operation::FrameRead { .. }
                | Operation::FrameDelete { .. }
        ) {
            return Ok(None);
        }
        // Serialize only photo operations; never retain the SQLite lock over file I/O.
        let _change = self.photo_changes.lock().map_err(error)?;
        let (dir, mut list) = {
            let mut s = self.lock()?;
            require(!s.closed && !s.closing, 503, "Service closing")?;
            (
                s.dir.join("frame"),
                s.value("frame-photos")?
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
            )
        };
        match op {
            Operation::Frame => return Ok(Some(Reply::Json(snapshot(&json!(list))))),
            Operation::FrameAdd {
                bytes,
                filename: name,
            } => {
                let (mime, ext, width, height) = inspect(bytes)?;
                let hash = format!("{:x}", Sha256::digest(bytes));
                if list.iter().any(|p| p["sha256"] == hash) {
                    return Ok(Some(Reply::Json(snapshot(&json!(list)))));
                }
                require(list.len() < MAX_PHOTOS, 413, "写真は300枚までです。")?;
                require(
                    list.iter()
                        .map(|p| p["bytes"].as_u64().unwrap_or(0))
                        .sum::<u64>()
                        + bytes.len() as u64
                        <= MAX_FRAME_BYTES,
                    413,
                    "保存できる写真の合計サイズを超えます。",
                )?;
                let id = Uuid::new_v4().to_string();
                let file = dir.join(format!("{id}.{ext}"));
                let temp = dir.join(format!(".upload-{}", Uuid::new_v4()));
                fs::create_dir_all(&dir).map_err(error)?;
                let written = (|| -> std::io::Result<()> {
                    let mut f = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&temp)?;
                    f.write_all(bytes)?;
                    drop(f);
                    fs::rename(&temp, &file)
                })();
                if let Err(e) = written {
                    let _ = fs::remove_file(&temp);
                    return Err(error(e));
                }
                list.push(json!({"id":id,"name":filename(name),"mime":mime,"ext":ext,"bytes":bytes.len(),"sha256":hash,"width":width,"height":height,"addedAt":now()}));
            }
            Operation::FrameRead { id } | Operation::FrameDelete { id } => {
                let meta = list
                    .iter()
                    .find(|p| p["id"] == *id)
                    .ok_or_else(|| ApiError::new(404, "写真が見つかりません。"))?;
                let file = dir.join(format!(
                    "{}.{}",
                    meta["id"].as_str().unwrap_or(""),
                    meta["ext"].as_str().unwrap_or("")
                ));
                if matches!(op, Operation::FrameRead { .. }) {
                    let bytes = fs::read(file)
                        .map_err(|_| ApiError::new(404, "写真のファイルが見つかりません。"))?;
                    return Ok(Some(Reply::Photo {
                        bytes,
                        mime: meta["mime"].as_str().unwrap_or("").into(),
                    }));
                }
                match fs::remove_file(file) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(error(e)),
                };
                list.retain(|p| p["id"] != *id);
            }
            _ => unreachable!(),
        }
        self.commit_frame(list).map(Some)
    }
    // Called only under photo_changes after admission. Shutdown may withdraw new
    // admission during I/O, but must drain this file/metadata operation together.
    fn commit_frame(&self, list: Vec<Value>) -> Result<Reply, ApiError> {
        let value = snapshot(&json!(list));
        let mut s = self.lock()?;
        require(!s.closed, 503, "Service closing")?;
        s.set_value("frame-photos", json!(list))?;
        let event = s.call(
            "event.append",
            json!({"type":"frame.updated","data":value,"at":now()}),
        )?;
        s.publish_value(event)?;
        Ok(Reply::Json(value))
    }
}
#[cfg(test)]
#[path = "photo_frame/tests.rs"]
mod tests;
