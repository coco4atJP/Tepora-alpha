//! User-selected attachment staging. Payloads are inert data; staging grants no
//! execution authority. All database writes use Workspace's existing owner.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};

const MAX_IMAGE: usize = 4 * 1024 * 1024;
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn metadata(doc: &Value) -> Value {
    let mut value = pick(doc, &["id", "name", "bytes", "sha256", "createdAt"]);
    if doc["kind"] == "image" {
        for key in ["kind", "mime", "width", "height"] {
            value[key] = doc[key].clone();
        }
    } else {
        value["kind"] = json!("text");
    }
    value
}
pub(crate) fn inspect_image(encoded: &str, name: &str) -> Result<Value, ApiError> {
    require(
        encoded.len() <= 5_600_000 && !encoded.is_empty(),
        415,
        "Invalid image encoding",
    )?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| ApiError::new(415, "Invalid image encoding"))?;
    require(
        bytes.len() > 24 && bytes.len() <= MAX_IMAGE && STANDARD.encode(&bytes) == encoded,
        415,
        "Invalid/oversized image",
    )?;
    let (mut mime, mut width, mut height) = ("", 0u32, 0u32);
    if bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) && &bytes[12..16] == b"IHDR" {
        mime = "image/png";
        width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
        height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    } else if bytes.starts_with(&[255, 216]) {
        let mut at = 2;
        while at + 4 < bytes.len() {
            if bytes[at] != 255 {
                break;
            }
            while bytes.get(at) == Some(&255) {
                at += 1;
            }
            let Some(&marker) = bytes.get(at) else {
                break;
            };
            at += 1;
            if marker == 217 || marker == 218 {
                break;
            }
            if marker == 1 || (208..=215).contains(&marker) {
                continue;
            }
            require(at + 2 <= bytes.len(), 415, "Malformed JPEG")?;
            let len = u16::from_be_bytes([bytes[at], bytes[at + 1]]) as usize;
            require(len >= 2 && at + len <= bytes.len(), 415, "Malformed JPEG")?;
            if [
                192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
            ]
            .contains(&marker)
            {
                require(len >= 8, 415, "Malformed JPEG dimensions")?;
                mime = "image/jpeg";
                height = u16::from_be_bytes([bytes[at + 3], bytes[at + 4]]) as u32;
                width = u16::from_be_bytes([bytes[at + 5], bytes[at + 6]]) as u32;
                break;
            }
            at += len;
        }
    }
    require(
        !mime.is_empty()
            && width > 0
            && height > 0
            && width <= 16384
            && height <= 16384
            && u64::from(width) * u64::from(height) <= 32_000_000,
        415,
        "PNG/JPEG with bounded dimensions required",
    )?;
    Ok(
        json!({"kind":"image","mime":mime,"width":width,"height":height,"bytes":bytes.len(),"sha256":digest(&bytes),"base64":encoded,"name":name}),
    )
}
fn prepare(files: &Value) -> Result<Vec<Value>, ApiError> {
    let files = files
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 6)
        .ok_or_else(|| ApiError::bad_request("ファイルは1〜6件ずつ選んでください。"))?;
    let mut docs = Vec::with_capacity(files.len());
    for file in files {
        let name = file["name"]
            .as_str()
            .ok_or_else(|| ApiError::bad_request("Invalid file payload"))?;
        require(
            file.is_object() && (file["content"].is_string() || file["base64"].is_string()),
            400,
            "Invalid file payload",
        )?;
        let units = json_codec::utf16_units(name);
        require(
            !units.is_empty()
                && units.len() <= 160
                && !units.iter().any(|u| *u <= 31 || [47, 58, 92].contains(u)),
            400,
            "ファイル名が不正です。",
        )?;
        let extension = name
            .rsplit_once('.')
            .filter(|(stem, _)| !stem.is_empty())
            .map(|(_, v)| v.to_ascii_lowercase())
            .unwrap_or_default();
        let mut doc = if let Some(encoded) = file["base64"].as_str() {
            require(
                ["png", "jpg", "jpeg"].contains(&extension.as_str()),
                415,
                "PNG/JPEGファイルを指定してください。",
            )?;
            inspect_image(encoded, name)?
        } else {
            require(["txt","md","csv","tsv","json","yaml","yml"].contains(&extension.as_str()), 415, "現在はUTF-8のテキスト・Markdown・CSV・JSON・YAMLに対応しています。PNG/JPEG画像も選択できます。PDF・Office文書はまだ読み込めません。")?;
            let content = file["content"].as_str().unwrap();
            require(
                !content.contains('\0'),
                415,
                "バイナリファイルは読み込めません。",
            )?;
            // Buffer.byteLength and createHash replace lone UTF-16 surrogates
            // with U+FFFD, while the stored logical JSON retains the original.
            let bytes = json_codec::sql_text(content).into_bytes();
            require(
                !bytes.is_empty() && bytes.len() <= 256 * 1024,
                413,
                "ファイルは空でない256KB以下のものを選んでください。",
            )?;
            json!({"name":name,"content":content,"bytes":bytes.len(),"sha256":digest(&bytes)})
        };
        doc["id"] = json!(Uuid::new_v4().to_string());
        doc["createdAt"] = json!(now());
        docs.push(doc);
    }
    check_totals(&docs)?;
    Ok(docs)
}
fn check_totals(docs: &[Value]) -> Result<(), ApiError> {
    let total = docs.iter().fold(0u64, |sum, d| {
        sum.saturating_add(d["bytes"].as_u64().unwrap_or(0))
    });
    let text: u64 = docs
        .iter()
        .filter(|d| d["kind"] != "image")
        .fold(0u64, |sum, d| {
            sum.saturating_add(d["bytes"].as_u64().unwrap_or(0))
        });
    require(text <= 1024 * 1024, 413, "テキストの合計は1MBまでです。")?;
    require(
        total <= 8 * 1024 * 1024,
        413,
        "一度に渡せるファイルは合計8MBまでです。",
    )
}
impl WorkspaceAccess {
    pub fn resolve_inputs(&self, ids: &Value) -> Result<Vec<Value>, ApiError> {
        let ids = ids
            .as_array()
            .filter(|v| v.len() <= 6)
            .ok_or_else(|| ApiError::bad_request("Invalid attachment selection"))?;
        let mut unique = std::collections::HashSet::new();
        let mut state = self.lock()?;
        let mut docs = Vec::with_capacity(ids.len());
        for id in ids {
            let id = id
                .as_str()
                .ok_or_else(|| ApiError::bad_request("Invalid file id"))?;
            require(unique.insert(id), 400, "Invalid attachment selection")?;
            let doc = state.get("input-file", id)?;
            require(
                !doc.is_null() && !truth(&doc["revoked"]),
                404,
                "選んだファイルが見つかりません。もう一度選んでください。",
            )?;
            docs.push(doc);
        }
        check_totals(&docs)?;
        Ok(docs)
    }
}
impl Workspace {
    pub(super) fn remove_input(&self, id: &str) -> Result<Value, ApiError> {
        let mut state = self.lock()?;
        require(!state.closed && !state.closing, 503, "Service closing")?;
        let used = state.list("job")?.iter().any(|job| {
            job["inputFiles"]
                .as_array()
                .is_some_and(|files| files.iter().any(|f| f["id"] == id))
        });
        require(
            !used,
            409,
            "このファイルは仕事で使用されています。下書きから外す操作では実行記録を削除しません。",
        )?;
        state.call("document.remove", json!({"kind":"input-file","id":id}))?;
        Ok(json!({"deleted":true}))
    }
    pub(super) fn stage_inputs(&self, files: &Value) -> Result<Value, ApiError> {
        let docs = prepare(files)?;
        let mut state = self.lock()?;
        require(!state.closed && !state.closing, 503, "Service closing")?;
        let used = state.list("input-file")?.iter().fold(0u64, |sum, d| {
            sum.saturating_add(d["bytes"].as_u64().unwrap_or(0))
        });
        let size: u64 = docs.iter().map(|d| d["bytes"].as_u64().unwrap()).sum();
        require(
            used.saturating_add(size) <= 64 * 1024 * 1024,
            413,
            "添付の保存容量に達しました。不要な下書き用ファイルを外してください。",
        )?;
        state.call("exec", json!({"sql":"SAVEPOINT native_input_staging"}))?;
        let result = (|| -> Result<(), ApiError> {
            for doc in &docs {
                state.put("input-file", doc.clone())?;
            }
            state.call("exec", json!({"sql":"RELEASE native_input_staging"}))?;
            Ok(())
        })();
        if let Err(e) = result {
            let _ = state.call(
                "exec",
                json!({"sql":"ROLLBACK TO native_input_staging; RELEASE native_input_staging"}),
            );
            return Err(e);
        }
        Ok(json!({"files":docs.iter().map(metadata).collect::<Vec<_>>()}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn text_preserves_logical_utf16_and_hashes_actual_utf8() {
        let logical = json_codec::from_utf16_units(&[0xd800, 0xe000, 0xe100]);
        let docs = prepare(&json!([{"name":"note.md","content":logical}])).unwrap();
        assert_eq!(docs[0]["content"], logical);
        assert_eq!(docs[0]["bytes"], 9);
        assert_eq!(docs[0]["sha256"], digest("�\u{e000}\u{e100}".as_bytes()));
        assert!(metadata(&docs[0]).get("content").is_none());
    }
    #[test]
    fn rejects_names_and_batch_limits_before_storage() {
        for name in ["../a.txt", "a\\b.txt", "a:b.txt", "a\n.txt", ""] {
            assert_eq!(
                prepare(&json!([{"name":name,"content":"a"}]))
                    .unwrap_err()
                    .status,
                400
            );
        }
        assert_eq!(
            prepare(&json!([{"name":"a.txt","content":""}]))
                .unwrap_err()
                .status,
            413
        );
        assert_eq!(
            prepare(&json!([{"name":"a.pdf","content":"a"}]))
                .unwrap_err()
                .status,
            415
        );
        assert_eq!(
            prepare(&json!(vec![
                json!({"name":"a.txt","content":"x".repeat(256*1024)});
                5
            ]))
            .unwrap_err()
            .status,
            413
        );
    }
    #[test]
    fn hidden_extension_and_duplicate_selection_match_source_bounds() {
        assert_eq!(
            prepare(&json!([{"name":".txt","content":"a"}]))
                .unwrap_err()
                .status,
            415
        );
        assert!(prepare(&json!([{"name":"..txt","content":"a"}])).is_ok());
        assert_eq!(
            check_totals(&[json!({"bytes":u64::MAX}), json!({"bytes":u64::MAX})])
                .unwrap_err()
                .status,
            413
        );
    }
    #[test]
    fn staging_uses_one_owner_and_rolls_back_the_entire_batch() {
        let dir = env::temp_dir().join(format!("tepora-inputs-{}", Uuid::new_v4()));
        let workspace = Workspace::open(&dir).unwrap();
        let staged = workspace
            .stage_inputs(&json!([{"name":"a.txt","content":"one"}]))
            .unwrap();
        assert_eq!(staged["files"][0]["kind"], "text");
        let id = staged["files"][0]["id"].as_str().unwrap();
        assert_eq!(
            workspace.lock().unwrap().get("input-file", id).unwrap()["content"],
            "one"
        );
        workspace.lock().unwrap().call("exec",json!({"sql":"CREATE TRIGGER fail_second_attachment BEFORE INSERT ON documents WHEN json_extract(NEW.body, '$.name') = 'bad.txt' BEGIN SELECT RAISE(ABORT, 'attachment fixture failure'); END"})).unwrap();
        assert!(workspace.stage_inputs(&json!([{"name":"good.txt","content":"first"},{"name":"bad.txt","content":"second"}])).is_err());
        assert_eq!(
            workspace.lock().unwrap().list("input-file").unwrap().len(),
            1
        );
        drop(workspace);
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn validates_canonical_base64_and_dimensions_without_decoding_pixels() {
        let mut png = vec![
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
        ];
        png.extend(2u32.to_be_bytes());
        png.extend(3u32.to_be_bytes());
        png.push(0);
        let encoded = STANDARD.encode(&png);
        let image = inspect_image(&encoded, "p.png").unwrap();
        assert_eq!(image["width"], 2);
        assert_eq!(image["height"], 3);
        assert_eq!(
            inspect_image(&(encoded + "\n"), "p.png")
                .unwrap_err()
                .status,
            415
        );
        png[16..20].copy_from_slice(&0u32.to_be_bytes());
        assert_eq!(
            inspect_image(&STANDARD.encode(png), "p.png")
                .unwrap_err()
                .status,
            415
        );
        assert_eq!(
            inspect_image(&STANDARD.encode([255u8; 30]), "p.jpg")
                .unwrap_err()
                .status,
            415
        );
    }
}
