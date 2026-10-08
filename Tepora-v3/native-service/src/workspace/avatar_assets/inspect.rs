//! Content-only inspection of ordinary avatar imports. No decoding, I/O or fetches.
use super::*;
use std::collections::HashSet;

pub(crate) const MAX_ASSET_BYTES: usize = 96 * 1024 * 1024;
pub(crate) const MAX_VRM_BYTES: usize = 80 * 1024 * 1024;
const MAX_PICTURE_BYTES: usize = 16 * 1024 * 1024;
const MAX_PICTURE_PIXELS: u64 = 40_000_000;
const MAX_PACK_FILES: usize = 200;
const MAX_LAYER_PIXELS: u64 = 60_000_000;
const MAX_JSON_BYTES: usize = 16 * 1024 * 1024;
const MAX_RIG_BYTES: usize = 2 * 1024 * 1024;
const PACK_MAGIC: &[u8] = b"TPAK1\n";
const PICTURE_MIMES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/avif",
    "image/gif",
];
const SET_MIMES: &[&str] = &["image/png", "image/webp", "image/jpeg", "image/avif"];
const MOODS: &[&str] = &[
    "idle",
    "listening",
    "thinking",
    "talking",
    "happy",
    "attention",
    "concerned",
    "sleepy",
];
const EYE_PARTS: &[&str] = &["ball", "low", "crease", "lash"];

#[derive(Debug)]
pub(super) struct AssetFile<'a> {
    pub path: String,
    pub mime: String,
    pub bytes: &'a [u8],
}
#[derive(Debug)]
pub(super) struct Inspected<'a> {
    pub files: Vec<AssetFile<'a>>,
    pub meta: Value,
    pub name: Option<String>,
}

pub(super) fn inspect<'a>(kind: &str, bytes: &'a [u8]) -> Result<Inspected<'a>, ApiError> {
    require(
        ["vrm", "image", "imageset", "mesh"].contains(&kind),
        400,
        "素材の種類が正しくありません。",
    )?;
    require(!bytes.is_empty(), 400, "ファイルを選んでください。")?;
    match kind {
        "vrm" => {
            let meta = inspect_vrm(bytes)?;
            Ok(Inspected {
                name: meta["name"].as_str().map(str::to_owned),
                files: vec![asset_file("file", "model/gltf-binary", bytes)],
                meta,
            })
        }
        "image" => {
            let info =
                inspect_picture(bytes, MAX_PICTURE_BYTES, MAX_PICTURE_PIXELS, PICTURE_MIMES)?;
            Ok(Inspected {
                files: vec![asset_file("file", info.mime, bytes)],
                meta: json!({"mime":info.mime,"width":info.width,"height":info.height}),
                name: None,
            })
        }
        _ => {
            let pack = parse_pack(bytes)?;
            require(pack.kind == kind, 400, "素材の種類が一致しません。")?;
            let (files, meta) = if kind == "mesh" {
                inspect_mesh_pack(&pack.files)?
            } else {
                inspect_image_set(&pack.files)?
            };
            Ok(Inspected {
                files,
                meta,
                name: (!pack.name.is_empty()).then_some(pack.name),
            })
        }
    }
}

fn asset_file<'a>(path: &str, mime: &str, bytes: &'a [u8]) -> AssetFile<'a> {
    AssetFile {
        path: path.into(),
        mime: mime.into(),
        bytes,
    }
}
fn property<'a>(v: &'a Value, key: &str) -> &'a Value {
    v.get(key).unwrap_or(&Value::Null)
}
fn object(v: &Value) -> bool {
    v.is_object() || v.is_array()
}
fn finite(v: &Value) -> bool {
    v.as_f64().is_some_and(f64::is_finite)
}
fn number(v: &Value, lo: f64, hi: f64) -> bool {
    v.as_f64()
        .is_some_and(|n| n.is_finite() && n >= lo && n <= hi)
}
fn array_size(v: &Value, size: usize) -> bool {
    v.as_array().is_some_and(|a| a.len() == size)
}
fn numeric_array(v: &Value, size: usize) -> bool {
    v.as_array()
        .is_some_and(|a| a.len() == size && a.iter().all(finite))
}
fn clip(v: &Value, max: usize) -> String {
    let Some(s) = v.as_str() else {
        return String::new();
    };
    let units = json_codec::utf16_units(s)
        .into_iter()
        .map(|u| if u <= 31 || u == 127 { 32 } else { u })
        .collect::<Vec<_>>();
    let whitespace = |u: &u16| matches!(*u,0x0009..=0x000d|0x0020|0x00a0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff);
    let first = units
        .iter()
        .position(|u| !whitespace(u))
        .unwrap_or(units.len());
    let last = units
        .iter()
        .rposition(|u| !whitespace(u))
        .map(|i| i + 1)
        .unwrap_or(first);
    json_codec::from_utf16_units(&units[first..last.min(first + max)])
}

/// JSON.parse accepts overflowing numeric literals as infinities. serde_json does
/// not. Keep those numbers distinguishable until validation, without changing
/// strings, object order, duplicate-key behavior or the original stored bytes.
struct ParsedJson {
    value: Value,
    nonfinite_key: Option<String>,
}
impl std::ops::Deref for ParsedJson {
    type Target = Value;
    fn deref(&self) -> &Value {
        &self.value
    }
}
impl ParsedJson {
    fn nonfinite(&self, v: &Value) -> bool {
        self.nonfinite_key.as_ref().is_some_and(|key| {
            v.as_object()
                .is_some_and(|o| o.len() == 1 && o.contains_key(key))
        })
    }
}
fn json_number_token(token: &str) -> bool {
    let bytes = token.as_bytes();
    let mut i = usize::from(bytes.first() == Some(&b'-'));
    if bytes.get(i) == Some(&b'0') {
        i += 1;
    } else {
        let start = i;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    if bytes.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    if bytes.get(i).is_some_and(|b| *b == b'e' || *b == b'E') {
        i += 1;
        if bytes.get(i).is_some_and(|b| *b == b'+' || *b == b'-') {
            i += 1;
        }
        let start = i;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == bytes.len()
}
fn parse_json(bytes: &[u8], message: &str) -> Result<ParsedJson, ApiError> {
    let source = String::from_utf8_lossy(bytes);
    let raw = source.as_bytes();
    let mut replacements = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        match raw[i] {
            b'"' => {
                i += 1;
                while i < raw.len() && raw[i] != b'"' {
                    if raw[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
                i += 1;
            }
            b'-' | b'0'..=b'9' => {
                let start = i;
                i += 1;
                while i < raw.len()
                    && matches!(raw[i], b'0'..=b'9' | b'e' | b'E' | b'+' | b'-' | b'.')
                {
                    i += 1;
                }
                let token = &source[start..i];
                if json_number_token(token) && token.parse::<f64>().is_ok_and(|n| !n.is_finite()) {
                    replacements.push((start, i));
                }
            }
            _ => i += 1,
        }
    }
    if replacements.is_empty() {
        return json_codec::parse(&source)
            .map(|value| ParsedJson {
                value,
                nonfinite_key: None,
            })
            .map_err(|_| ApiError::bad_request(message));
    }
    let replace = |replacement: &str| {
        let mut out = String::with_capacity(source.len());
        let mut at = 0;
        for &(start, end) in &replacements {
            out.push_str(&source[at..start]);
            out.push_str(replacement);
            at = end;
        }
        out.push_str(&source[at..]);
        out
    };
    let normalized = replace("null");
    let value = json_codec::parse(&normalized).map_err(|_| ApiError::bad_request(message))?;
    let mut keys = HashSet::new();
    let mut pending = vec![&value];
    while let Some(v) = pending.pop() {
        match v {
            Value::Object(o) => {
                for (key, child) in o {
                    keys.insert(key.as_str());
                    pending.push(child);
                }
            }
            Value::Array(a) => pending.extend(a),
            _ => {}
        }
    }
    let mut key = "__tepora_avatar_nonfinite__".to_owned();
    while keys.contains(key.as_str()) {
        key.push('_');
    }
    let transformed = replace(&format!("{{\"{key}\":true}}"));
    let value = json_codec::parse(&transformed).map_err(|_| ApiError::bad_request(message))?;
    Ok(ParsedJson {
        value,
        nonfinite_key: Some(key),
    })
}

/// ECMAScript Object.entries order puts canonical uint32 keys first.
fn entries(v: &Value) -> Vec<(String, &Value)> {
    match v {
        Value::Object(o) => {
            let mut indexed = Vec::new();
            let mut named = Vec::new();
            for (key, value) in o {
                if let Ok(index) = key.parse::<u32>() {
                    if index != u32::MAX && index.to_string() == *key {
                        indexed.push((index, key.clone(), value));
                        continue;
                    }
                }
                named.push((key.clone(), value));
            }
            indexed.sort_by_key(|(index, _, _)| *index);
            indexed
                .into_iter()
                .map(|(_, key, value)| (key, value))
                .chain(named)
                .collect()
        }
        Value::Array(a) => a
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        _ => Vec::new(),
    }
}

fn inspect_vrm(bytes: &[u8]) -> Result<Value, ApiError> {
    const STRUCTURE: &str = "VRMの構造を読み取れません。";
    require(
        bytes.len() >= 20,
        400,
        "VRMファイル（.vrm）を選んでください。",
    )?;
    require(
        bytes.len() <= MAX_VRM_BYTES,
        413,
        "VRMファイルは80MBまでです。",
    )?;
    let u32le = |at| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    require(
        u32le(0) == 0x46546c67 && u32le(4) == 2,
        400,
        "glTF 2.0バイナリ（VRM）ではありません。",
    )?;
    require(
        u32le(8) as usize == bytes.len(),
        400,
        "ファイルの長さが一致しません。破損している可能性があります。",
    )?;
    let length = u32le(12) as usize;
    require(
        u32le(16) == 0x4e4f534a
            && length > 0
            && length <= MAX_JSON_BYTES
            && 20 + length <= bytes.len(),
        400,
        STRUCTURE,
    )?;
    let parsed = parse_json(&bytes[20..20 + length], STRUCTURE)?;
    let root = &parsed.value;
    require(root.is_object() && !parsed.nonfinite(root), 400, STRUCTURE)?;
    let used = property(root, "extensionsUsed").as_array();
    let has = |key: &str| used.is_some_and(|a| a.iter().any(|v| v.as_str() == Some(key)));
    let extensions = property(root, "extensions");
    let v1 = property(extensions, "VRMC_vrm");
    let v0 = property(extensions, "VRM");
    require(
        (has("VRMC_vrm") && truth(v1)) || (has("VRM") && truth(v0)),
        400,
        "VRMの拡張情報がありません。VRoid Studioなどで書き出した.vrmを選んでください。",
    )?;
    for key in ["buffers", "images"] {
        if let Some(list) = property(root, key).as_array() {
            for item in list {
                let uri = property(item, "uri");
                require(
                    !truth(uri)
                        || str_of(uri)
                            .get(..5)
                            .is_some_and(|s| s.eq_ignore_ascii_case("data:")),
                    400,
                    "外部ファイルを参照するモデルは使えません。埋め込み形式のVRMを選んでください。",
                )?;
            }
        }
    }
    if truth(v1) {
        let meta = property(v1, "meta");
        let name = clip(property(meta, "name"), 160);
        let authors = property(meta, "authors")
            .as_array()
            .into_iter()
            .flatten()
            .map(|a| clip(a, 80))
            .filter(|a| !a.is_empty())
            .take(6)
            .collect::<Vec<_>>();
        Ok(
            json!({"version":"1.0","name":if name.is_empty(){"VRMモデル".into()}else{name},"authors":authors,
            "license":clip(property(meta,"licenseUrl"),300),"avatarPermission":clip(property(meta,"avatarPermission"),40),
            "commercialUsage":clip(property(meta,"commercialUsage"),40),"allowRedistribution":property(meta,"allowRedistribution")==&Value::Bool(true)}),
        )
    } else {
        let meta = property(v0, "meta");
        let name = clip(property(meta, "title"), 160);
        let author = clip(property(meta, "author"), 80);
        let other = property(meta, "otherLicenseUrl");
        Ok(
            json!({"version":"0.x","name":if name.is_empty(){"VRMモデル".into()}else{name},"authors":if author.is_empty(){vec![]}else{vec![author]},
            "license":clip(if truth(other){other}else{property(meta,"licenseName")},300),"avatarPermission":clip(property(meta,"allowedUserName"),40),
            "commercialUsage":clip(property(meta,"commercialUssageName"),40),"allowRedistribution":false}),
        )
    }
}

#[derive(Clone, Copy, Debug)]
struct Picture {
    mime: &'static str,
    width: u32,
    height: u32,
}
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
fn webp_size(b: &[u8]) -> (u32, u32) {
    match &b[12..16] {
        b"VP8X" if b.len() >= 30 => (1 + le24(b, 24), 1 + le24(b, 27)),
        b"VP8 " if b.len() >= 30 && b[23..26] == [157, 1, 42] => {
            (le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff)
        }
        b"VP8L" if b.len() >= 25 && b[20] == 47 => (
            1 + (((b[22] as u32 & 63) << 8) | b[21] as u32),
            1 + (((b[24] as u32 & 15) << 10) | ((b[23] as u32) << 2) | ((b[22] as u32 & 192) >> 6)),
        ),
        _ => (0, 0),
    }
}
fn inspect_picture(
    b: &[u8],
    max_bytes: usize,
    max_pixels: u64,
    mimes: &[&str],
) -> Result<Picture, ApiError> {
    require(b.len() >= 16, 400, "画像ファイルを選んでください。")?;
    require(
        b.len() <= max_bytes,
        413,
        &format!(
            "画像は{}MBまでです。",
            (max_bytes as f64 / 1048576.0).round() as usize
        ),
    )?;
    let info = if b.starts_with(&[255, 216, 255]) {
        let (width, height) = jpeg_size(b);
        Some(Picture {
            mime: "image/jpeg",
            width,
            height,
        })
    } else if b.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) && &b[12..16] == b"IHDR" {
        // Preserve the compatibility host's Buffer offset error for truncated IHDR.
        if b.len() < 24 {
            return Err(ApiError::new(500, format!("The value of \"offset\" is out of range. It must be >= 0 and <= {}. Received {}", b.len()-4, if b.len()<20 {16}else{20})));
        }
        Some(Picture {
            mime: "image/png",
            width: u32::from_be_bytes(b[16..20].try_into().unwrap()),
            height: u32::from_be_bytes(b[20..24].try_into().unwrap()),
        })
    } else if &b[..6] == b"GIF87a" || &b[..6] == b"GIF89a" {
        Some(Picture {
            mime: "image/gif",
            width: le16(b, 6),
            height: le16(b, 8),
        })
    } else if &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        let (width, height) = webp_size(b);
        Some(Picture {
            mime: "image/webp",
            width,
            height,
        })
    } else if &b[4..8] == b"ftyp" && [&b"avif"[..], &b"avis"[..]].contains(&&b[8..12]) {
        Some(Picture {
            mime: "image/avif",
            width: 0,
            height: 0,
        })
    } else {
        None
    };
    let info = info
        .filter(|info| mimes.contains(&info.mime))
        .ok_or_else(|| {
            ApiError::bad_request(format!(
                "{} の画像を選んでください。SVGは使えません。",
                mimes
                    .iter()
                    .map(|m| m[6..].to_uppercase())
                    .collect::<Vec<_>>()
                    .join("・")
            ))
        })?;
    if info.width != 0 || info.height != 0 {
        require(
            info.width > 0 && info.height > 0,
            400,
            "画像の大きさを読み取れません。",
        )?;
        require(
            info.width <= 16384 && info.height <= 16384,
            413,
            "画像が大きすぎます。",
        )?;
        require(
            u64::from(info.width) * u64::from(info.height) <= max_pixels,
            413,
            "画像が大きすぎます。小さくしてから選んでください。",
        )?;
    }
    Ok(info)
}

#[derive(Debug)]
struct PackedFile<'a> {
    path: String,
    bytes: &'a [u8],
}
#[derive(Debug)]
struct Pack<'a> {
    kind: String,
    name: String,
    files: Vec<PackedFile<'a>>,
}
fn safe_name(name: &str) -> bool {
    (1..=48).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn safe_path(path: &str) -> bool {
    !path.contains("..")
        && path.len() <= 120
        && path.split('/').count() <= 4
        && path.split('/').all(|part| {
            (1..=61).contains(&part.len())
                && part.as_bytes()[0].is_ascii_alphanumeric()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || [b'_', b'.', b'-'].contains(&b))
        })
}
fn parse_pack(bytes: &[u8]) -> Result<Pack<'_>, ApiError> {
    const INVALID: &str = "素材のまとまりを読み取れません。";
    let start = PACK_MAGIC.len() + 4;
    require(bytes.len() > start, 400, INVALID)?;
    require(bytes.len() <= MAX_ASSET_BYTES, 413, "素材は96MBまでです。")?;
    require(bytes.starts_with(PACK_MAGIC), 400, INVALID)?;
    let length = u32::from_le_bytes(bytes[PACK_MAGIC.len()..start].try_into().unwrap()) as usize;
    require(
        length > 0 && length <= 262144 && start + length <= bytes.len(),
        400,
        INVALID,
    )?;
    let manifest = parse_json(&bytes[start..start + length], INVALID)?;
    let kind = property(&manifest, "kind").as_str().unwrap_or("");
    require(
        manifest.is_object() && ["imageset", "mesh"].contains(&kind),
        400,
        "素材の種類が正しくありません。",
    )?;
    let list = property(&manifest, "files").as_array();
    require(
        list.is_some_and(|a| !a.is_empty() && a.len() <= MAX_PACK_FILES),
        400,
        "ファイルは1〜200個にしてください。",
    )?;
    let mut offset = start + length;
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for item in list.unwrap() {
        let path = property(item, "path").as_str();
        require(
            path.is_some_and(safe_path),
            400,
            "使えないファイル名が含まれています。",
        )?;
        let path = path.unwrap();
        require(
            seen.insert(path.to_ascii_lowercase()),
            400,
            "同じ名前のファイルが重なっています。",
        )?;
        let size = safe_integer(property(item, "size"));
        require(
            size.is_some_and(|n| n >= 0 && n as u64 <= (bytes.len() - offset) as u64),
            400,
            "ファイルの長さが一致しません。",
        )?;
        let end = offset + size.unwrap() as usize;
        files.push(PackedFile {
            path: path.into(),
            bytes: &bytes[offset..end],
        });
        offset = end;
    }
    require(offset == bytes.len(), 400, "ファイルの長さが一致しません。")?;
    Ok(Pack {
        kind: kind.into(),
        name: clip(property(&manifest, "name"), 80),
        files,
    })
}
fn parse_json_file(file: &PackedFile<'_>, max: usize, label: &str) -> Result<ParsedJson, ApiError> {
    require(
        file.bytes.len() <= max,
        413,
        &format!("{label}が大きすぎます。"),
    )?;
    parse_json(file.bytes, &format!("{label}を読み取れません。"))
}
fn bounded_json(document: &ParsedJson) -> Result<(), ApiError> {
    fn walk(
        doc: &ParsedJson,
        value: &Value,
        depth: usize,
        count: &mut usize,
    ) -> Result<(), ApiError> {
        require(depth <= 14, 400, "設定ファイルが複雑すぎます。")?;
        *count += 1;
        require(*count <= 200000, 400, "設定ファイルが複雑すぎます。")?;
        if value.is_number() || doc.nonfinite(value) {
            require(
                finite(value),
                400,
                "設定ファイルに数値でない値が含まれています。",
            )?;
        } else if let Some(array) = value.as_array() {
            for item in array {
                walk(doc, item, depth + 1, count)?;
            }
        } else if value.is_object() {
            for (key, item) in entries(value) {
                require(
                    json_codec::utf16_units(&key).len() <= 80 && key != "__proto__",
                    400,
                    "設定ファイルの項目名が正しくありません。",
                )?;
                walk(doc, item, depth + 1, count)?;
            }
        }
        Ok(())
    }
    walk(document, &document.value, 0, &mut 0)
}

fn png_path(path: &str, prefix: &str) -> bool {
    path.strip_prefix(prefix)
        .and_then(|p| p.strip_suffix(".png"))
        .is_some_and(safe_name)
}
fn picture_path(path: &str) -> bool {
    path.strip_prefix("images/")
        .and_then(|p| p.rsplit_once('.'))
        .is_some_and(|(name, ext)| {
            safe_name(name) && ["png", "webp", "jpg", "jpeg", "avif"].contains(&ext)
        })
}
fn check_mesh_rig(
    rig: &Value,
    layers: &Value,
    by_path: &HashMap<&str, &PackedFile<'_>>,
) -> Result<(), ApiError> {
    let mesh = property(rig, "mesh");
    require(
        number(property(mesh, "baseCell"), 1.0, 1024.0),
        400,
        "rig.json のメッシュの細かさ（baseCell）が正しくありません。",
    )?;
    for key in [
        "eyeBallCell",
        "eyeCell",
        "tasselCell",
        "handCell",
        "spriteCell",
    ] {
        require(
            mesh.get(key).is_none_or(|v| number(v, 1.0, 1024.0)),
            400,
            &format!("rig.json のメッシュの細かさ（{key}）が正しくありません。"),
        )?;
    }
    let view = property(rig, "view");
    require(
        view.is_object()
            && ["padTop", "padSide"]
                .iter()
                .all(|k| view.get(*k).is_none_or(|v| number(v, -1.0, 1.0))),
        400,
        "rig.json の view が正しくありません。",
    )?;
    let cells = |w: f64, h: f64, cell: f64| (w / cell).ceil() * (h / cell).ceil();
    let n = |v: &Value| v.as_f64().unwrap_or(f64::NAN);
    let image = property(rig, "image");
    require(
        cells(
            n(property(image, "width")),
            n(property(image, "height")),
            n(property(mesh, "baseCell")),
        ) <= 400000.0,
        400,
        "メッシュが細かすぎます。baseCell を大きくしてください。",
    )?;
    if let Some(f) = mesh.get("fine") {
        require(
            object(f)
                && ["x0", "x1", "y0", "y1"]
                    .iter()
                    .all(|k| finite(property(f, k)))
                && number(property(f, "cell"), 1.0, 1024.0)
                && n(property(f, "x1")) >= n(property(f, "x0"))
                && n(property(f, "y1")) >= n(property(f, "y0")),
            400,
            "rig.json の細かいメッシュの範囲が正しくありません。",
        )?;
        require(
            cells(
                n(property(f, "x1")) - n(property(f, "x0")),
                n(property(f, "y1")) - n(property(f, "y0")),
                n(property(f, "cell")),
            ) <= 400000.0,
            400,
            "メッシュが細かすぎます。fine.cell を大きくしてください。",
        )?;
    }
    let layer_map = property(layers, "layers");
    for (name, rect) in entries(layer_map) {
        let rect = rect.as_array().unwrap();
        let (w, h) = (n(&rect[2]), n(&rect[3]));
        require(
            w > 0.0 && h > 0.0 && w <= 8192.0 && h <= 8192.0,
            400,
            "layers.json の層の大きさが正しくありません。",
        )?;
        let key = if name.ends_with("_ball") {
            "eyeBallCell"
        } else if name.as_bytes().get(..3) == Some(b"eye")
            && name.as_bytes().get(3).is_some_and(u8::is_ascii_digit)
            && name.as_bytes().get(4) == Some(&b'_')
        {
            "eyeCell"
        } else if name == "hand" {
            "handCell"
        } else {
            "tasselCell"
        };
        if let Some(cell) = mesh.get(key) {
            require(
                cells(w, h, n(cell)) <= 400000.0,
                400,
                "メッシュが細かすぎます。",
            )?;
        }
    }
    for eye in property(rig, "eyes").as_array().unwrap() {
        require(
            object(eye)
                && finite(property(eye, "x0"))
                && finite(property(eye, "x1"))
                && n(property(eye, "x1")) > n(property(eye, "x0"))
                && ["top", "bot"]
                    .iter()
                    .all(|k| numeric_array(property(eye, k), 24)),
            400,
            "rig.json の目の形が正しくありません。",
        )?;
    }
    if let Some(strands) = rig.get("strands") {
        require(
            strands.as_array().is_some_and(|a| a.len() <= 64),
            400,
            "rig.json の髪の設定が多すぎます。",
        )?;
        for st in strands.as_array().unwrap() {
            require(
                property(st, "name")
                    .as_str()
                    .is_some_and(|s| json_codec::utf16_units(s).len() <= 40)
                    && property(st, "nodes").as_array().is_some_and(|a| {
                        (2..=16).contains(&a.len()) && a.iter().all(|v| numeric_array(v, 2))
                    })
                    && ["sigma", "max", "k"]
                        .iter()
                        .all(|k| finite(property(st, k)))
                    && n(property(st, "sigma")) > 0.0,
                400,
                "rig.json の髪の設定が正しくありません。",
            )?;
        }
    }
    if let Some(accessories) = rig.get("accessories") {
        require(
            accessories.as_array().is_some_and(|a| a.len() <= 16),
            400,
            "rig.json の飾りの設定が多すぎます。",
        )?;
        for a in accessories.as_array().unwrap() {
            let name = property(a, "name").as_str();
            require(
                name.is_some_and(safe_name)
                    && ["pivot", "tip"]
                        .iter()
                        .all(|k| numeric_array(property(a, k), 2))
                    && finite(property(a, "split")),
                400,
                "rig.json の飾りの設定が正しくありません。",
            )?;
            let name = name.unwrap();
            require(
                truth(property(layer_map, name))
                    && by_path.contains_key(format!("built/{name}.png").as_str()),
                400,
                &format!("飾りの画像がありません: {name}.png"),
            )?;
        }
    }
    if let Some(hand) = rig.get("hand") {
        require(
            object(hand)
                && truth(property(layer_map, "hand"))
                && by_path.contains_key("built/hand.png"),
            400,
            "手の画像（hand.png）がありません。",
        )?;
    }
    Ok(())
}

fn inspect_mesh_pack<'a>(
    files: &[PackedFile<'a>],
) -> Result<(Vec<AssetFile<'a>>, Value), ApiError> {
    let by_path = files
        .iter()
        .map(|f| (f.path.as_str(), f))
        .collect::<HashMap<_, _>>();
    for f in files {
        require(
            [
                "rig.json",
                "built/layers.json",
                "built/sprites/sprites.json",
            ]
            .contains(&f.path.as_str())
                || png_path(&f.path, "built/")
                || png_path(&f.path, "built/sprites/"),
            400,
            &format!(
                "メッシュアバターに使えないファイルが含まれています: {}",
                f.path
            ),
        )?;
    }
    let mut need = vec![
        "rig.json".into(),
        "built/layers.json".into(),
        "built/base.png".into(),
        "built/hairmask.png".into(),
    ];
    for i in 0..2 {
        for part in EYE_PARTS {
            need.push(format!("built/eye{i}_{part}.png"));
        }
    }
    for path in need {
        require(
            by_path.contains_key(path.as_str()),
            400,
            &format!("メッシュアバターに必要なファイルがありません: {path}"),
        )?;
    }
    let rig = parse_json_file(by_path["rig.json"], MAX_RIG_BYTES, "rig.json")?;
    bounded_json(&rig)?;
    require(
        rig.is_object() && property(&rig, "version").as_f64() == Some(1.0),
        400,
        "rig.json は version 1 のものだけ使えます。",
    )?;
    let image = property(&rig, "image");
    require(
        ["width", "height"].iter().all(|k| {
            property(image, k)
                .as_f64()
                .is_some_and(|n| n.fract() == 0.0 && n > 0.0 && n <= 8192.0)
        }),
        400,
        "rig.json の画像サイズが正しくありません。",
    )?;
    for key in ["head", "body", "face", "mouth", "mesh"] {
        require(
            object(property(&rig, key)),
            400,
            "rig.json の構成が正しくありません。",
        )?;
    }
    require(
        array_size(property(&rig, "eyes"), 2) && array_size(property(&rig, "cheeks"), 2),
        400,
        "rig.json の目・頬の設定が正しくありません。",
    )?;
    let layers = parse_json_file(by_path["built/layers.json"], 256 * 1024, "layers.json")?;
    bounded_json(&layers)?;
    let layer_map = property(&layers, "layers");
    require(
        object(&layers) && layer_map.is_object(),
        400,
        "layers.json の構成が正しくありません。",
    )?;
    for (name, rect) in entries(layer_map) {
        require(
            safe_name(&name) && numeric_array(rect, 4),
            400,
            "layers.json の層の指定が正しくありません。",
        )?;
        require(
            by_path.contains_key(format!("built/{name}.png").as_str()),
            400,
            &format!("層の画像がありません: {name}.png"),
        )?;
    }
    for i in 0..2 {
        for part in EYE_PARTS {
            let name = format!("eye{i}_{part}");
            require(
                property(layer_map, &name).is_array(),
                400,
                &format!("layers.json に目の層の位置がありません: {name}"),
            )?;
        }
    }
    check_mesh_rig(&rig, &layers, &by_path)?;
    let sprites = by_path.contains_key("built/sprites/sprites.json");
    if sprites {
        let sheet = parse_json_file(
            by_path["built/sprites/sprites.json"],
            256 * 1024,
            "sprites.json",
        )?;
        bounded_json(&sheet)?;
        require(
            object(&sheet) && object(property(&sheet, "layers")),
            400,
            "sprites.json の構成が正しくありません。",
        )?;
        for (name, _) in entries(property(&sheet, "layers")) {
            require(
                safe_name(&name)
                    && by_path.contains_key(format!("built/sprites/{name}.png").as_str()),
                400,
                &format!("スプライトの画像がありません: {name}.png"),
            )?;
        }
    }
    let mut pixels = 0;
    let mut out = Vec::new();
    for f in files {
        let mime = if f.path.ends_with(".png") {
            let info = inspect_picture(
                f.bytes,
                MAX_PICTURE_BYTES,
                MAX_PICTURE_PIXELS,
                &["image/png"],
            )?;
            require(
                info.width <= 8192 && info.height <= 8192,
                413,
                "層の画像が大きすぎます。",
            )?;
            pixels += u64::from(info.width) * u64::from(info.height);
            "image/png"
        } else {
            "application/json"
        };
        out.push(asset_file(&f.path, mime, f.bytes));
    }
    require(
        pixels <= MAX_LAYER_PIXELS,
        413,
        "層の画像の合計が大きすぎます。",
    )?;
    Ok((
        out,
        json!({"rigVersion":1,"width":image["width"],"height":image["height"],"layers":layer_map.as_object().unwrap().len(),"sprites":sprites}),
    ))
}

fn inspect_image_set<'a>(
    files: &[PackedFile<'a>],
) -> Result<(Vec<AssetFile<'a>>, Value), ApiError> {
    let by_path = files
        .iter()
        .map(|f| (f.path.as_str(), f))
        .collect::<HashMap<_, _>>();
    for f in files {
        require(
            f.path == "imageset.json" || picture_path(&f.path),
            400,
            &format!("画像セットに使えないファイルが含まれています: {}", f.path),
        )?;
    }
    require(
        by_path.contains_key("imageset.json"),
        400,
        "画像セットに imageset.json がありません。",
    )?;
    let count = files.iter().filter(|f| picture_path(&f.path)).count();
    require(
        (1..=12).contains(&count),
        400,
        "画像は1〜12枚にしてください。",
    )?;
    let sheet = parse_json_file(by_path["imageset.json"], 16 * 1024, "imageset.json")?;
    let moods = property(&sheet, "moods");
    require(
        sheet.is_object()
            && property(&sheet, "version").as_f64() == Some(1.0)
            && moods.is_object()
            && !sheet.nonfinite(moods),
        400,
        "imageset.json の構成が正しくありません。",
    )?;
    for (key, _) in entries(&sheet) {
        require(
            ["version", "moods", "talkOpen"].contains(&key.as_str()),
            400,
            &format!("imageset.json に使えない項目があります: {key}"),
        )?;
    }
    require(
        property(moods, "idle").is_string(),
        400,
        "「いつも」の画像が必要です。",
    )?;
    for (mood, path) in entries(moods) {
        require(
            MOODS.contains(&mood.as_str())
                && path
                    .as_str()
                    .is_some_and(|p| by_path.contains_key(p) && picture_path(p)),
            400,
            &format!(
                "気分「{}」の画像が正しくありません。",
                clip(&Value::String(mood), 20)
            ),
        )?;
    }
    require(
        sheet.get("talkOpen").is_none_or(|v| {
            v.as_str()
                .is_some_and(|p| by_path.contains_key(p) && picture_path(p))
        }),
        400,
        "口を開けた画像が正しくありません。",
    )?;
    let mut out = Vec::new();
    let mut dimensions = HashMap::new();
    for f in files {
        if f.path == "imageset.json" {
            out.push(asset_file(&f.path, "application/json", f.bytes));
            continue;
        }
        let info = inspect_picture(f.bytes, 8 * 1024 * 1024, 16_000_000, SET_MIMES)?;
        dimensions.insert(f.path.as_str(), info);
        out.push(asset_file(&f.path, info.mime, f.bytes));
    }
    let idle = dimensions[property(moods, "idle").as_str().unwrap()];
    Ok((
        out,
        json!({"moods":entries(moods).into_iter().map(|(k,_)|k).collect::<Vec<_>>(),"talkOpen":truth(property(&sheet,"talkOpen")),"width":idle.width,"height":idle.height}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0; 33];
        bytes[..8].copy_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
        bytes[8..12].copy_from_slice(&13u32.to_be_bytes());
        bytes[12..16].copy_from_slice(b"IHDR");
        bytes[16..20].copy_from_slice(&width.to_be_bytes());
        bytes[20..24].copy_from_slice(&height.to_be_bytes());
        bytes[24] = 8;
        bytes[25] = 6;
        bytes
    }
    fn wire(value: &Value) -> Vec<u8> {
        json_codec::stringify_js(value).unwrap().into_bytes()
    }
    fn glb_json(raw: &[u8]) -> Vec<u8> {
        let mut body = raw.to_vec();
        while body.len() % 4 != 0 {
            body.push(b' ');
        }
        let mut bytes = Vec::new();
        for n in [
            0x46546c67,
            2,
            (20 + body.len()) as u32,
            body.len() as u32,
            0x4e4f534a,
        ] {
            bytes.extend_from_slice(&n.to_le_bytes());
        }
        bytes.extend(body);
        bytes
    }
    fn glb(json: &Value) -> Vec<u8> {
        glb_json(&wire(json))
    }
    fn vrm1(meta: Value) -> Value {
        json!({"asset":{"version":"2.0"},"extensionsUsed":["VRMC_vrm"],"extensions":{"VRMC_vrm":{"specVersion":"1.0","meta":meta}}})
    }
    fn pack_manifest(manifest: &Value, body: &[u8]) -> Vec<u8> {
        let text = wire(manifest);
        let mut bytes = PACK_MAGIC.to_vec();
        bytes.extend_from_slice(&(text.len() as u32).to_le_bytes());
        bytes.extend(text);
        bytes.extend_from_slice(body);
        bytes
    }
    fn pack(kind: &str, files: &[(String, Vec<u8>)], name: &str) -> Vec<u8> {
        let body = files
            .iter()
            .flat_map(|(_, b)| b.iter().copied())
            .collect::<Vec<_>>();
        pack_manifest(
            &json!({"kind":kind,"name":name,"files":files.iter().map(|(path,bytes)|json!({"path":path,"size":bytes.len()})).collect::<Vec<_>>()}),
            &body,
        )
    }
    fn set_files(sheet: Value) -> Vec<(String, Vec<u8>)> {
        vec![
            ("imageset.json".into(), wire(&sheet)),
            ("images/idle.png".into(), png(40, 30)),
            ("images/happy.png".into(), png(20, 20)),
            ("images/open.png".into(), png(40, 30)),
        ]
    }
    fn set_sheet() -> Value {
        json!({"version":1,"moods":{"idle":"images/idle.png","happy":"images/happy.png"},"talkOpen":"images/open.png"})
    }
    fn eye() -> Value {
        json!({"x0":0,"x1":8,"top":vec![2;24],"bot":vec![6;24]})
    }
    fn rig() -> Value {
        json!({"version":1,"image":{"width":64,"height":64},"head":{"cx":1,"cy":1},"body":{},"face":{},"eyes":[eye(),eye()],"mouth":{},"cheeks":[[1,2],[3,4]],"mesh":{"baseCell":8},"view":{"padTop":0,"padSide":0}})
    }
    fn layer_map() -> Value {
        let mut layers = Map::new();
        for i in 0..2 {
            for part in EYE_PARTS {
                layers.insert(format!("eye{i}_{part}"), json!([0, 0, 8, 8]));
            }
        }
        Value::Object(layers)
    }
    fn mesh_files(rig: &Value, layers: &Value) -> Vec<(String, Vec<u8>)> {
        let mut files = vec![
            ("rig.json".into(), wire(rig)),
            (
                "built/layers.json".into(),
                wire(&json!({"build":1,"layers":layers})),
            ),
            ("built/base.png".into(), png(64, 64)),
            ("built/hairmask.png".into(), png(64, 64)),
        ];
        for i in 0..2 {
            for part in EYE_PARTS {
                files.push((format!("built/eye{i}_{part}.png"), png(8, 8)));
            }
        }
        files
    }
    fn mesh(rig: &Value, layers: &Value) -> Result<Value, ApiError> {
        inspect(
            "mesh",
            &pack("mesh", &mesh_files(rig, layers), "Fixture mesh"),
        )
        .map(|found| found.meta)
    }
    fn error_has<T: std::fmt::Debug>(result: Result<T, ApiError>, status: u16, text: &str) {
        let error = result.unwrap_err();
        assert_eq!(error.status, status, "{}", error.message);
        assert!(
            error.message.contains(text),
            "expected {text:?}, got {:?}",
            error.message
        );
    }

    #[test]
    fn vrm_versions_metadata_and_original_bytes() {
        let source = glb(&vrm1(
            json!({"name":"  Mika\u{0000}\u{0007} avatar  ","authors":[" A ",null,7,"", "B","C","D","E","F","G"],"licenseUrl":" https://vrm.dev/licenses/1.0/ ","avatarPermission":"everyone","commercialUsage":"personalNonProfit","allowRedistribution":true}),
        ));
        let found = inspect("vrm", &source).unwrap();
        assert_eq!(found.name.as_deref(), Some("Mika   avatar"));
        assert_eq!(found.meta["version"], "1.0");
        assert_eq!(found.meta["authors"], json!(["A", "B", "C", "D", "E", "F"]));
        assert_eq!(found.meta["license"], "https://vrm.dev/licenses/1.0/");
        assert_eq!(found.meta["allowRedistribution"], true);
        assert_eq!(found.files[0].path, "file");
        assert_eq!(found.files[0].mime, "model/gltf-binary");
        assert_eq!(found.files[0].bytes, source);
        assert_eq!(found.files[0].bytes.as_ptr(), source.as_ptr());
        let old = json!({"extensionsUsed":["VRM"],"extensions":{"VRM":{"meta":{"title":"Legacy avatar","author":"Legacy author","licenseName":"CC_BY","allowedUserName":"Everyone","commercialUssageName":"Allow","allowRedistribution":true}}}});
        let old_bytes = glb(&old);
        let found = inspect("vrm", &old_bytes).unwrap();
        assert_eq!(
            found.meta,
            json!({"version":"0.x","name":"Legacy avatar","authors":["Legacy author"],"license":"CC_BY","avatarPermission":"Everyone","commercialUsage":"Allow","allowRedistribution":false})
        );
        assert_eq!(
            inspect("vrm", &glb(&vrm1(json!({}))))
                .unwrap()
                .name
                .as_deref(),
            Some("VRMモデル")
        );
    }

    #[test]
    fn vrm_header_container_and_embedded_references() {
        error_has(inspect("vrm", b"not a model at all"), 400, "VRMファイル");
        let valid = glb(&vrm1(json!({})));
        let mut bad = valid.clone();
        bad[4] = 1;
        error_has(inspect("vrm", &bad), 400, "glTF 2.0");
        let mut bad = valid.clone();
        bad[8] = bad[8].wrapping_add(1);
        error_has(inspect("vrm", &bad), 400, "長さが一致");
        let mut bad = valid.clone();
        bad[16] = 0;
        error_has(inspect("vrm", &bad), 400, "構造");
        error_has(inspect("vrm", &glb_json(b"{")), 400, "構造");
        error_has(inspect("vrm", &glb(&json!([]))), 400, "構造");
        error_has(inspect("vrm", &glb(&json!({}))), 400, "拡張情報");
        let mut data = vrm1(json!({}));
        data["buffers"] = json!([{"uri":"body.bin"}]);
        error_has(inspect("vrm", &glb(&data)), 400, "外部ファイル");
        data["buffers"] = json!([{"uri":"DaTa:application/octet-stream;base64,AA=="}]);
        data["images"] = json!([null,{}, {"uri":""}]);
        assert!(inspect("vrm", &glb(&data)).is_ok());
    }

    #[test]
    fn image_header_formats_and_zero_dimensions() {
        let bytes = png(40, 30);
        let image = inspect("image", &bytes).unwrap();
        assert_eq!(
            image.meta,
            json!({"mime":"image/png","width":40,"height":30})
        );
        assert!(image.name.is_none());
        let jpeg = [
            255, 216, 255, 192, 0, 17, 8, 0, 20, 0, 30, 3, 1, 34, 0, 2, 17, 1, 3, 17, 1, 0, 0, 0, 0,
        ];
        assert_eq!(
            inspect("image", &jpeg).unwrap().meta,
            json!({"mime":"image/jpeg","width":30,"height":20})
        );
        let gif = [
            b'G', b'I', b'F', b'8', b'9', b'a', 4, 0, 3, 0, 0, 0, 0, 0, 0, 0,
        ];
        assert_eq!(inspect("image", &gif).unwrap().meta["height"], 3);
        for (kind, width, height) in [
            (b"VP8X", 100, 50),
            (b"VP8 ", 30, 20),
            (b"VP8L", 20, 15),
            (b"NONE", 0, 0),
        ] {
            let mut webp = vec![0; 30];
            webp[..4].copy_from_slice(b"RIFF");
            webp[8..12].copy_from_slice(b"WEBP");
            webp[12..16].copy_from_slice(kind);
            match kind {
                b"VP8X" => {
                    webp[24] = 99;
                    webp[27] = 49;
                }
                b"VP8 " => {
                    webp[23..26].copy_from_slice(&[157, 1, 42]);
                    webp[26] = 30;
                    webp[28] = 20;
                }
                b"VP8L" => {
                    webp[20] = 47;
                    webp[21] = 19;
                    webp[22] = 128;
                    webp[23] = 3;
                }
                _ => {}
            }
            let found = inspect("image", &webp).unwrap();
            assert_eq!(
                found.meta,
                json!({"mime":"image/webp","width":width,"height":height})
            );
        }
        for brand in [b"avif", b"avis"] {
            let mut avif = vec![0; 16];
            avif[4..8].copy_from_slice(b"ftyp");
            avif[8..12].copy_from_slice(brand);
            assert_eq!(
                inspect("image", &avif).unwrap().meta,
                json!({"mime":"image/avif","width":0,"height":0})
            );
        }
        assert!(inspect("image", &png(0, 0)).is_ok());
        error_has(inspect("image", &png(0, 10)), 400, "大きさを読み取れ");
        error_has(
            inspect("image", b"ordinary text file"),
            400,
            "PNG・JPEG・WEBP・AVIF・GIF",
        );
        error_has(inspect("image", &png(1, 1)[..16]), 500, "Received 16");
        error_has(inspect("image", &png(1, 1)[..20]), 500, "Received 20");
    }

    #[test]
    fn image_dimensions_and_byte_limits_are_kind_specific() {
        error_has(
            inspect("image", &png(16385, 1)),
            413,
            "画像が大きすぎます。",
        );
        error_has(inspect("image", &png(9000, 9000)), 413, "小さくして");
        assert!(inspect("image", &png(8000, 5000)).is_ok());
        let mut large = png(8, 8);
        large.resize(MAX_PICTURE_BYTES + 1, 0);
        error_has(inspect("image", &large), 413, "画像は16MB");
        large.truncate(8 * 1024 * 1024 + 1);
        error_has(
            inspect_picture(&large, 8 * 1024 * 1024, 16_000_000, SET_MIMES),
            413,
            "画像は8MB",
        );
        error_has(inspect("", &[]), 400, "種類");
        error_has(inspect("image", &[]), 400, "ファイルを選んで");
        assert_eq!(MAX_ASSET_BYTES, 96 * 1024 * 1024);
        assert_eq!(MAX_VRM_BYTES, 80 * 1024 * 1024);
    }

    #[test]
    fn pack_manifest_names_and_exact_lengths() {
        let files = vec![
            ("imageset.json".into(), b"{}".to_vec()),
            ("images/a.png".into(), png(8, 8)),
        ];
        let bytes = pack("imageset", &files, "  Fixture\u{0000} pack  ");
        let parsed = parse_pack(&bytes).unwrap();
        assert_eq!(parsed.name, "Fixture  pack");
        assert_eq!(parsed.files[1].path, "images/a.png");
        assert_eq!(parsed.files[1].bytes, files[1].1);
        error_has(inspect("mesh", &bytes), 400, "種類が一致");
        let mut extra = bytes.clone();
        extra.push(0);
        assert!(parse_pack(&extra).unwrap_err().message.contains("長さ"));
        assert!(parse_pack(&bytes[..bytes.len() - 1])
            .unwrap_err()
            .message
            .contains("長さ"));
        for name in [
            "",
            "folder/",
            "folder//image.png",
            "abcde/abcde/abcde/abcde/abcde",
            &"a".repeat(62),
        ] {
            let bad = pack("imageset", &[(name.into(), vec![])], "");
            assert!(parse_pack(&bad).unwrap_err().message.contains("ファイル名"));
        }
        let duplicate = pack(
            "mesh",
            &[("a.png".into(), vec![]), ("A.PNG".into(), vec![])],
            "",
        );
        assert!(parse_pack(&duplicate)
            .unwrap_err()
            .message
            .contains("重なって"));
        let wrong_size = pack_manifest(
            &json!({"kind":"mesh","files":[{"path":"a.png","size":0.5}]}),
            b"x",
        );
        assert!(parse_pack(&wrong_size)
            .unwrap_err()
            .message
            .contains("長さ"));
        let bad = pack("image", &files, "");
        assert!(parse_pack(&bad).unwrap_err().message.contains("種類"));
        let empty = pack("mesh", &[], "");
        assert!(parse_pack(&empty).unwrap_err().message.contains("1〜200"));
        let many = (0..201)
            .map(|i| (format!("f{i}.png"), vec![]))
            .collect::<Vec<_>>();
        assert!(parse_pack(&pack("mesh", &many, ""))
            .unwrap_err()
            .message
            .contains("1〜200"));
    }

    #[test]
    fn image_set_moods_files_and_content_mimes() {
        let files = set_files(set_sheet());
        let bytes = pack("imageset", &files, "Fixture pack");
        let found = inspect("imageset", &bytes).unwrap();
        assert_eq!(found.name.as_deref(), Some("Fixture pack"));
        assert_eq!(
            found.meta,
            json!({"moods":["idle","happy"],"talkOpen":true,"width":40,"height":30})
        );
        assert_eq!(
            found
                .files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            files.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(found.files[0].mime, "application/json");
        assert_eq!(found.files[0].bytes, files[0].1);
        let files = vec![
            (
                "imageset.json".into(),
                wire(&json!({"version":1,"moods":{"idle":"images/one.jpeg"}})),
            ),
            ("images/one.jpeg".into(), png(12, 15)),
        ];
        let bytes = pack("imageset", &files, "");
        let found = inspect("imageset", &bytes).unwrap();
        assert!(found.name.is_none());
        assert_eq!(found.files[1].mime, "image/png");
        assert_eq!(found.meta["talkOpen"], false);
    }

    #[test]
    fn image_set_structure_and_picture_limits() {
        for (sheet, text) in [
            (json!({"version":2,"moods":{}}), "構成"),
            (json!({"version":1,"moods":[]}), "構成"),
            (
                json!({"version":1,"moods":{"happy":"images/happy.png"}}),
                "いつも",
            ),
            (
                json!({"version":1,"moods":{"idle":"images/idle.png","angry":"images/happy.png"}}),
                "気分「angry」",
            ),
            (
                json!({"version":1,"moods":{"idle":"images/missing.png"}}),
                "気分「idle」",
            ),
            (
                json!({"version":1,"moods":{"idle":"images/idle.png"},"talkOpen":null}),
                "口を開けた",
            ),
            (
                json!({"version":1,"moods":{"idle":"images/idle.png"},"note":"hello"}),
                "使えない項目",
            ),
        ] {
            error_has(
                inspect("imageset", &pack("imageset", &set_files(sheet), "")),
                400,
                text,
            );
        }
        let mut files = set_files(set_sheet());
        files.remove(0);
        error_has(
            inspect("imageset", &pack("imageset", &files, "")),
            400,
            "imageset.json がありません",
        );
        let mut files = set_files(set_sheet());
        files.push(("notes.txt".into(), b"hi".to_vec()));
        error_has(
            inspect("imageset", &pack("imageset", &files, "")),
            400,
            "使えないファイル",
        );
        let mut files = set_files(set_sheet());
        files[1].1 = png(5000, 5000);
        error_has(
            inspect("imageset", &pack("imageset", &files, "")),
            413,
            "小さくして",
        );
        let mut files = set_files(set_sheet());
        for i in 0..10 {
            files.push((format!("images/more{i}.png"), png(1, 1)));
        }
        error_has(
            inspect("imageset", &pack("imageset", &files, "")),
            400,
            "1〜12枚",
        );
    }

    #[test]
    fn complete_mesh_and_optional_sprites_preserve_files() {
        let bytes = pack("mesh", &mesh_files(&rig(), &layer_map()), "Fixture mesh");
        let found = inspect("mesh", &bytes).unwrap();
        assert_eq!(
            found.meta,
            json!({"rigVersion":1,"width":64,"height":64,"layers":8,"sprites":false})
        );
        assert_eq!(found.files.len(), 12);
        assert_eq!(found.files[0].mime, "application/json");
        assert_eq!(found.files[2].mime, "image/png");
        let base = bytes.as_ptr() as usize;
        let mut last_end = base;
        for file in &found.files {
            let start = file.bytes.as_ptr() as usize;
            assert!(start >= last_end && start + file.bytes.len() <= base + bytes.len());
            last_end = start + file.bytes.len();
        }
        assert_eq!(last_end, base + bytes.len());
        let mut files = mesh_files(&rig(), &layer_map());
        files.push((
            "built/sprites/sprites.json".into(),
            wire(&json!({"layers":{"mouth_a":[0,0,4,4]}})),
        ));
        files.push(("built/sprites/mouth_a.png".into(), png(4, 4)));
        let bytes = pack("mesh", &files, "");
        let found = inspect("mesh", &bytes).unwrap();
        assert_eq!(found.meta["sprites"], true);
        assert_eq!(found.files[13].bytes, files[13].1);
        files.pop();
        error_has(
            inspect("mesh", &pack("mesh", &files, "")),
            400,
            "スプライトの画像がありません",
        );
    }

    #[test]
    fn mesh_structure_and_required_layers() {
        let layers = layer_map();
        for (key, value, text) in [
            ("version", json!(2), "version 1"),
            ("image", json!({"width":64.5,"height":64}), "画像サイズ"),
            ("head", json!("head"), "構成"),
            ("eyes", json!([{}]), "目・頬"),
            ("view", Value::Null, "view"),
        ] {
            let mut r = rig();
            r[key] = value;
            error_has(mesh(&r, &layers), 400, text);
        }
        let mut r = rig();
        r["head"] = json!([]);
        r["body"] = json!([]);
        assert!(mesh(&r, &layers).is_ok());
        let mut files = mesh_files(&rig(), &layers);
        files.remove(3);
        error_has(
            inspect("mesh", &pack("mesh", &files, "")),
            400,
            "built/hairmask.png",
        );
        let mut files = mesh_files(&rig(), &layers);
        files.push(("notes.txt".into(), vec![]));
        error_has(
            inspect("mesh", &pack("mesh", &files, "")),
            400,
            "使えないファイル",
        );
        let mut layers = layer_map();
        layers["eye0_ball"] = json!("rect");
        error_has(mesh(&rig(), &layers), 400, "層の指定");
        error_has(mesh(&rig(), &json!({})), 400, "目の層の位置");
        let mut layers = layer_map();
        layers["extra"] = json!([0, 0, 8, 8]);
        error_has(
            mesh(&rig(), &layers),
            400,
            "層の画像がありません: extra.png",
        );
    }

    #[test]
    fn mesh_cell_fine_grid_and_eye_constraints() {
        let layers = layer_map();
        for value in [json!(0), json!(-8), json!("8"), Value::Null, json!(1025)] {
            let mut r = rig();
            r["mesh"]["baseCell"] = value;
            error_has(mesh(&r, &layers), 400, "baseCell");
        }
        for key in [
            "eyeBallCell",
            "eyeCell",
            "tasselCell",
            "handCell",
            "spriteCell",
        ] {
            let mut r = rig();
            r["mesh"][key] = json!(0);
            error_has(mesh(&r, &layers), 400, key);
        }
        let mut r = rig();
        r["image"] = json!({"width":8000,"height":8000});
        r["mesh"]["baseCell"] = json!(1);
        error_has(mesh(&r, &layers), 400, "baseCell を大きく");
        let mut r = rig();
        r["mesh"]["fine"] = json!({"x0":0,"x1":8000,"y0":0,"y1":8000,"cell":1});
        error_has(mesh(&r, &layers), 400, "fine.cell");
        r["mesh"]["fine"]["cell"] = json!(0);
        error_has(mesh(&r, &layers), 400, "細かいメッシュの範囲");
        r["mesh"]["fine"] = json!({"x0":8,"x1":40,"y0":8,"y1":40,"cell":4});
        assert!(mesh(&r, &layers).is_ok());
        let mut r = rig();
        r["eyes"][1]["top"] = json!([1, 2, 3]);
        error_has(mesh(&r, &layers), 400, "目の形");
        let mut r = rig();
        r["view"]["padTop"] = json!(7);
        error_has(mesh(&r, &layers), 400, "view");
        let mut layers = layer_map();
        layers["eye0_ball"] = json!([0, 0, -1, 8]);
        error_has(mesh(&rig(), &layers), 400, "層の大きさ");
    }

    #[test]
    fn mesh_hair_accessories_and_hand() {
        let strand = json!({"name":"bang0","nodes":[[1,1],[2,5],[3,9]],"sigma":6,"max":4,"k":1});
        let mut r = rig();
        r["strands"] = json!([strand]);
        assert!(mesh(&r, &layer_map()).is_ok());
        r["strands"] = json!(vec![strand.clone(); 65]);
        error_has(mesh(&r, &layer_map()), 400, "髪の設定が多すぎ");
        r["strands"] = json!([strand]);
        r["strands"][0]["sigma"] = json!(0);
        error_has(mesh(&r, &layer_map()), 400, "髪の設定が正しく");
        let mut r = rig();
        r["accessories"] = json!([{"name":"tassel","pivot":[2,2],"tip":[2,12],"split":0.5}]);
        error_has(mesh(&r, &layer_map()), 400, "飾りの画像がありません");
        let mut layers = layer_map();
        layers["tassel"] = json!([0, 0, 8, 8]);
        layers["hand"] = json!([0, 0, 8, 8]);
        r["hand"] = json!({});
        let mut files = mesh_files(&r, &layers);
        files.push(("built/tassel.png".into(), png(8, 8)));
        files.push(("built/hand.png".into(), png(8, 8)));
        assert!(inspect("mesh", &pack("mesh", &files, "")).is_ok());
        let mut r = rig();
        r["hand"] = json!({});
        error_has(mesh(&r, &layer_map()), 400, "手の画像");
    }

    #[test]
    fn mesh_picture_size_and_aggregate_pixels() {
        let mut files = mesh_files(&rig(), &layer_map());
        files[2].1 = png(9000, 100);
        error_has(
            inspect("mesh", &pack("mesh", &files, "")),
            413,
            "層の画像が大きすぎ",
        );
        let mut files = mesh_files(&rig(), &layer_map());
        files[2].1 = png(8000, 5000);
        files[3].1 = png(8000, 5000);
        error_has(
            inspect("mesh", &pack("mesh", &files, "")),
            413,
            "層の画像の合計",
        );
        let mut files = mesh_files(&rig(), &layer_map());
        files[2].1 = b"not an image file at all".to_vec();
        error_has(
            inspect("mesh", &pack("mesh", &files, "")),
            400,
            "PNG の画像",
        );
    }

    #[test]
    fn json_number_overflow_and_string_semantics() {
        let parsed = parse_json(
            br#"{"x":1e999,"y":-1e999,"text":"1e999","__tepora_avatar_nonfinite__":3}"#,
            "bad",
        )
        .unwrap();
        assert!(parsed.nonfinite(&parsed["x"]));
        assert!(parsed.nonfinite(&parsed["y"]));
        assert_eq!(parsed["text"], "1e999");
        assert_eq!(parsed["__tepora_avatar_nonfinite__"], 3);
        error_has(bounded_json(&parsed), 400, "数値でない値");
        for raw in ["01e999", "1e++999", "1e999.0", "-01e999"] {
            assert!(parse_json(raw.as_bytes(), "bad").is_err(), "{raw}");
        }
        let mantissa = "9".repeat(400);
        for raw in [mantissa.clone(), format!("{mantissa}e0")] {
            let parsed = parse_json(raw.as_bytes(), "bad").unwrap();
            assert!(parsed.nonfinite(&parsed.value));
            error_has(bounded_json(&parsed), 400, "数値でない値");
        }
        for raw in [format!("0{mantissa}"), format!("-0{mantissa}")] {
            assert!(parse_json(raw.as_bytes(), "bad").is_err());
        }
        let mut r = wire(&rig());
        r.pop();
        r.extend_from_slice(b",\"ordinaryNumber\":1e999}");
        let mut files = mesh_files(&rig(), &layer_map());
        files[0].1 = r;
        error_has(
            inspect("mesh", &pack("mesh", &files, "")),
            400,
            "数値でない値",
        );
        let bytes=glb_json(br#"{"extensionsUsed":["VRMC_vrm"],"extensions":{"VRMC_vrm":{"meta":{"name":"A\ud83e"}}},"unused":1e999}"#);
        let found = inspect("vrm", &bytes).unwrap();
        assert_eq!(
            json_codec::utf16_units(found.name.as_deref().unwrap()),
            vec![65, 0xd83e]
        );
        let name = format!("{}🦀", "a".repeat(159));
        let bytes = glb(&vrm1(json!({"name":name})));
        let found = inspect("vrm", &bytes).unwrap();
        assert_eq!(
            json_codec::utf16_units(found.name.as_deref().unwrap()).last(),
            Some(&0xd83e)
        );
        assert_eq!(
            json_codec::utf16_units(found.name.as_deref().unwrap()).len(),
            160
        );
        let private = json_codec::parse("\"\\ue000\"").unwrap();
        assert_eq!(json_codec::utf16_units(&clip(&private, 1)), vec![0xe000]);
    }

    #[test]
    fn bounded_rig_depth_count_keys_and_json_sizes() {
        let mut deep = Value::Null;
        for _ in 0..15 {
            deep = json!([deep]);
        }
        let parsed = parse_json(&wire(&deep), "bad").unwrap();
        error_has(bounded_json(&parsed), 400, "複雑すぎ");
        let parsed = parse_json(&wire(&json!(vec![0; 200000])), "bad").unwrap();
        error_has(bounded_json(&parsed), 400, "複雑すぎ");
        let mut r = rig();
        r["a".repeat(81)] = json!(0);
        error_has(mesh(&r, &layer_map()), 400, "項目名");
        let mut files = mesh_files(&rig(), &layer_map());
        files[0].1 = vec![b' '; MAX_RIG_BYTES + 1];
        error_has(
            inspect("mesh", &pack("mesh", &files, "")),
            413,
            "rig.jsonが大きすぎ",
        );
        let mut files = set_files(set_sheet());
        files[0].1 = b"{invalid".to_vec();
        error_has(
            inspect("imageset", &pack("imageset", &files, "")),
            400,
            "imageset.jsonを読み取れ",
        );
        let parsed = parse_json(br#"{"z":0,"10":1,"2":2,"a":3}"#, "bad").unwrap();
        assert_eq!(
            entries(&parsed)
                .iter()
                .map(|(k, _)| k.as_str())
                .collect::<Vec<_>>(),
            vec!["2", "10", "z", "a"]
        );
    }
}
