//! Durable media handles, owned by the native host. The lifecycle lock orders
//! admissions, completions and stop; the SQLite owner is never held across I/O.
use super::*;
use crate::capabilities::{Capabilities, CapabilityBody, CapabilityError, CapabilityRequest};
use crate::network::{Domain, NativeNetwork, Purpose, RequestCancellation};
use base64::Engine;
use sha2::{Digest, Sha256};
use std::{io::Write, time::Duration};
use tokio::task::JoinHandle;
const ACTIVE: &[&str] = &["queued", "submitting", "running", "downloading"];
const MAX_BYTES: usize = 32 * 1024 * 1024;
fn active(j: &Value) -> bool {
    ACTIVE.contains(&j["status"].as_str().unwrap_or(""))
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn token(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 160
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn check(ok: bool, status: u16, message: &str) -> Result<(), CapabilityError> {
    if ok {
        Ok(())
    } else {
        Err(CapabilityError::new(status, message))
    }
}
pub(super) fn public(j: &Value) -> Value {
    let mut out = pick(
        j,
        &[
            "id",
            "title",
            "kind",
            "status",
            "note",
            "createdAt",
            "updatedAt",
            "model",
            "jobId",
            "asset",
        ],
    );
    if let Some(name) = j.get("providerName") {
        out["provider"] = name.clone();
    }
    out["providerMayContinue"] = json!(truth(&j["providerMayContinue"]));
    out["canResume"] = json!(
        (truth(&j["remoteId"]) || truth(&j["downloadUrl"]) || truth(&j["notSubmitted"]))
            && matches!(j["status"].as_str(), Some("paused" | "awaiting-download"))
    );
    out
}
fn media_type(b: &[u8]) -> Result<&'static str, CapabilityError> {
    if b.len() >= 24 && b.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        Ok("image/png")
    } else if b.len() >= 4 && b.starts_with(&[255, 216, 255]) {
        Ok("image/jpeg")
    } else if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") {
        Ok("image/webp")
    } else if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WAVE") {
        Ok("audio/wav")
    } else if b.starts_with(b"ID3")
        || b.first() == Some(&255) && b.get(1).is_some_and(|v| v & 0xe0 == 0xe0)
    {
        Ok("audio/mpeg")
    } else if b.len() > 12 && b.get(4..8) == Some(b"ftyp") {
        Ok("video/mp4")
    } else {
        Err(CapabilityError::new(
            502,
            "配信されたファイルは対応する画像・音声・動画ではありません。",
        ))
    }
}
#[derive(Default)]
struct Lifecycle {
    closed: bool,
    active: HashMap<String, RequestCancellation>,
    timers: HashMap<String, RequestCancellation>,
    tasks: Vec<JoinHandle<()>>,
}
pub(super) struct MediaJobs {
    state: WorkspaceAccess,
    capabilities: Capabilities,
    network: NativeNetwork,
    runtime: tokio::runtime::Handle,
    life: Mutex<Lifecycle>,
    poll_ms: u64,
}
impl MediaJobs {
    pub(super) fn new(
        state: WorkspaceAccess,
        capabilities: Capabilities,
        network: NativeNetwork,
        runtime: tokio::runtime::Handle,
    ) -> Result<Arc<Self>, ApiError> {
        let this = Arc::new(Self {
            state,
            capabilities,
            network,
            runtime,
            life: Mutex::new(Lifecycle::default()),
            poll_ms: 5000,
        });
        for j in this.list_raw()? {
            if active(&j) {
                this.update(&j,json!({"status":if j["status"]=="submitting" && !truth(&j["remoteId"]) {"unknown"}else{"paused"},"notSubmitted":j["status"]=="queued" && !truth(&j["remoteId"]) && !truth(&j["downloadUrl"]),"note":"前回の状態を保持しました。生成要求は自動で再送しません。"}))?;
            }
        }
        Ok(this)
    }
    fn list_raw(&self) -> Result<Vec<Value>, ApiError> {
        self.state.lock()?.list("media-job")
    }
    fn get(&self, id: &str) -> Result<Value, ApiError> {
        self.state.lock()?.get("media-job", id)
    }
    fn update(&self, j: &Value, patch: Value) -> Result<Value, ApiError> {
        let mut next = merge(j, &patch);
        next["updatedAt"] = json!(now());
        let mut s = self.state.lock()?;
        s.put("media-job", next.clone())?;
        let event = s.call(
            "event.append",
            json!({"type":"media.updated","data":public(&next),"at":now()}),
        )?;
        s.publish_value(event)?;
        Ok(next)
    }
    pub(super) fn snapshot(&self) -> Result<Value, ApiError> {
        Ok(json!({"jobs":self.list_raw()?.iter().map(public).collect::<Vec<_>>()}))
    }
    pub(super) fn create(self: &Arc<Self>, b: &Value) -> Result<Value, ApiError> {
        require(
            b["consent"] == true,
            403,
            "送信先と生成内容への確認が必要です。",
        )?;
        let mut life = self.life.lock().map_err(error)?;
        require(!life.closed, 503, "Service closing")?;
        let kind = b["kind"].as_str().unwrap_or("");
        require(
            ["tts", "image", "image_edit", "video"].contains(&kind),
            400,
            "Unsupported generation kind",
        )?;
        let max = if kind == "tts" { 4096 } else { 12000 };
        let prompt = b["prompt"].as_str().unwrap_or("");
        require(
            json_codec::utf16_units(prompt).iter().any(|u| !matches!(*u,
                0x0009..=0x000d|0x0020|0x00a0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff))
                && json_codec::utf16_units(prompt).len() <= max,
            400,
            &format!("prompt: 1–{max} characters required"),
        )?;
        let request = b["requestId"].as_str().unwrap_or("");
        require(token(request), 400, "A unique request ID is required")?;
        let options = b.get("options").cloned().unwrap_or_else(|| json!({}));
        require(
            options.as_object().is_some_and(|o| {
                o.keys()
                    .all(|k| ["size", "duration", "aspectRatio"].contains(&k.as_str()))
            }) || options.as_array().is_some_and(|v| v.is_empty())
                || (options.is_boolean() || options.is_number()) && truth(&options),
            400,
            "Unsupported generation option",
        )?;
        if truth(&options["size"]) {
            require(
                ["1024x1024", "1536x1024", "1024x1536"]
                    .contains(&options["size"].as_str().unwrap_or("")),
                400,
                "Unsupported size",
            )?;
        }
        if let Some(v) = options.get("duration") {
            require(
                safe_integer(v).is_some_and(|v| (1..=15).contains(&v)),
                400,
                "Use 1–15 seconds",
            )?;
        }
        if truth(&options["aspectRatio"]) {
            require(
                ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"]
                    .contains(&options["aspectRatio"].as_str().unwrap_or("")),
                400,
                "Invalid aspect ratio",
            )?;
        }
        let input = b.get("inputId").cloned().unwrap_or(Value::Null);
        let source = b.get("sourceAssetId").cloned().unwrap_or(Value::Null);
        let id = hash(format!("user:{request}").as_bytes());
        let intent=hash(json_codec::stringify_js(&json!({"kind":kind,"prompt":prompt,"inputId":input,"sourceAssetId":source,"options":options})).map_err(error)?.as_bytes());
        let old = self.get(&id)?;
        if !old.is_null() {
            require(
                old["intentHash"] == intent,
                409,
                "Request ID reused with different content",
            )?;
            return Ok(public(&old));
        }
        let profile = self.capabilities.pin(kind).map_err(ApiError::from)?;
        require(
            b["profileIdentity"] == profile["identity"],
            409,
            "生成先を確認してから開始してください。",
        )?;
        require(
            self.list_raw()?.iter().filter(|j| active(j)).count() < 16,
            429,
            "生成待ちがいっぱいです。",
        )?;
        require(
            Domain::parse(profile["domain"].as_str().unwrap_or(""))
                .is_some_and(|d| self.network.policy().permitted(d, Purpose::Model)),
            403,
            "現在の通信モードでは生成先を利用できません。",
        )?;
        require(
            !truth(&input) && !truth(&source) || ["image_edit", "video"].contains(&kind),
            400,
            "この生成種類には画像を添付できません。",
        )?;
        require(
            !(truth(&input) && truth(&source)),
            400,
            "Select one input image",
        )?;
        require(
            kind != "image_edit" || truth(&input) || truth(&source),
            400,
            "編集する画像を選んでください。",
        )?;
        let mut sha = Value::Null;
        if truth(&input) {
            let d = self
                .state
                .lock()?
                .get("input-file", input.as_str().unwrap_or(""))?;
            require(
                d["kind"] == "image" && !truth(&d["revoked"]),
                404,
                "選択した画像がありません。",
            )?;
            sha = d["sha256"].clone();
        }
        if truth(&source) {
            let d = self
                .state
                .lock()?
                .get("media-asset", source.as_str().unwrap_or(""))?;
            require(
                d["mime"].as_str().is_some_and(|m| m.starts_with("image/")),
                404,
                "生成済みの画像を選んでください。",
            )?;
            sha = d["sha256"].clone();
        }
        let title = if truth(&b["title"]) {
            b["title"]
                .as_str()
                .ok_or_else(|| ApiError::bad_request("Invalid title"))?
        } else {
            prompt
        };
        let j = json!({"id":id,"intentHash":intent,"requestId":request,"kind":kind,"prompt":prompt,"inputId":input,"sourceAssetId":source,"inputSha256":sha,"options":options,"jobId":null,"title":slice(title,100),"profile":profile,"providerName":profile["name"],"model":profile["model"],"status":"queued","createdAt":now()});
        let j = self.update(
            &j,
            json!({"note":"生成を待っています。会話は続けられます。"}),
        )?;
        self.pump(&mut life)?;
        Ok(public(&j))
    }
    fn pump(self: &Arc<Self>, life: &mut Lifecycle) -> Result<(), ApiError> {
        if life.closed {
            return Ok(());
        }
        life.tasks.retain(|t| !t.is_finished());
        for j in self.list_raw()?.into_iter().rev() {
            let id = j["id"].as_str().unwrap_or("").to_owned();
            if j["status"] != "queued" || life.active.len() >= 2 || life.active.contains_key(&id) {
                continue;
            }
            let cancel = RequestCancellation::new();
            life.active.insert(id.clone(), cancel.clone());
            let this = self.clone();
            life.tasks.push(self.runtime.spawn(async move{
                let result=this.run(j,&cancel).await;
                let mut life=this.life.lock().unwrap_or_else(|e|e.into_inner());
                if let Ok(current)=this.get(&id){
                    if !life.closed&&!matches!(current["status"].as_str(),Some("cancelled"|"paused")) {
                        if let Err(e)=result {
                            let status=if truth(&current["remoteId"])||truth(&current["downloadUrl"]){"paused"}else if current["status"]=="submitting"&&e.known_rejected!=Some(true){"unknown"}else{"failed"};
                            let note=if status=="unknown"{"生成依頼の結果を確認できません。二重課金を避けるため自動で再生成しません。".to_owned()}else{crate::provider::safe_error(&e.message)};
                            let _=this.update(&current,json!({"status":status,"note":note}));
                        }
                    }
                }
                life.active.remove(&id);
                if !life.closed && this.get(&id).is_ok_and(|j|j["status"]=="running") {this.schedule(&mut life,id);}
                let _=this.pump(&mut life);
            }));
        }
        Ok(())
    }
    fn schedule(self: &Arc<Self>, life: &mut Lifecycle, id: String) {
        let cancel = RequestCancellation::new();
        if let Some(old) = life.timers.insert(id.clone(), cancel.clone()) {
            old.cancel();
        }
        let this = self.clone();
        life.tasks.push(self.runtime.spawn(async move{
            tokio::select!{biased; _=cancel.cancelled()=>return,_=tokio::time::sleep(Duration::from_millis(this.poll_ms))=>{}}
            let mut life=this.life.lock().unwrap_or_else(|e|e.into_inner());life.timers.remove(&id);
            if life.closed||life.active.contains_key(&id){return;}
            if let Ok(mut j)=this.get(&id){if j["status"]=="running"{j["status"]=json!("queued");if let Ok(mut s)=this.state.lock(){let _=s.put("media-job",j);}let _=this.pump(&mut life);}}
        }));
    }
    fn change(
        &self,
        id: &str,
        patch: Value,
        cancel: &RequestCancellation,
    ) -> Result<Value, CapabilityError> {
        let life = self
            .life
            .lock()
            .map_err(|_| CapabilityError::new(500, "Media lifecycle unavailable"))?;
        check(
            !life.closed && !cancel.is_cancelled(),
            499,
            "Media generation stopped",
        )?;
        let j = self.get(id)?;
        check(
            !matches!(j["status"].as_str(), Some("cancelled" | "paused")),
            499,
            "Media generation stopped",
        )?;
        self.update(&j, patch).map_err(Into::into)
    }
    fn input(&self, j: &Value) -> Result<Option<(Vec<u8>, String)>, CapabilityError> {
        if let Some(id) = j["inputId"].as_str().filter(|s| !s.is_empty()) {
            let d = self.state.lock()?.get("input-file", id)?;
            check(
                !d.is_null() && !truth(&d["revoked"]) && d["sha256"] == j["inputSha256"],
                409,
                "画像は削除または変更されています。",
            )?;
            return Ok(Some((
                decode64(d["base64"].as_str().unwrap_or(""))?,
                d["mime"].as_str().unwrap_or("").to_owned(),
            )));
        }
        if let Some(id) = j["sourceAssetId"].as_str().filter(|s| !s.is_empty()) {
            let (a, b) = self.read_asset(id)?;
            check(
                a["sha256"] == j["inputSha256"],
                409,
                "元画像は変更されています。",
            )?;
            return Ok(Some((b, a["mime"].as_str().unwrap_or("").to_owned())));
        }
        Ok(None)
    }
    async fn run(&self, mut j: Value, cancel: &RequestCancellation) -> Result<(), CapabilityError> {
        check(
            self.capabilities.current(&j["profile"])?,
            409,
            "生成先が変わっています。",
        )?;
        let id = j["id"].as_str().unwrap_or("").to_owned();
        if let Some(url) = j["downloadUrl"].as_str() {
            return self.download(&j, url, cancel).await;
        }
        if let Some(remote) = j["remoteId"].as_str() {
            check(
                j["polls"].as_u64().unwrap_or(0) < 180,
                409,
                "動画の状態確認を一時停止しました。再開すると同じ依頼を確認します。",
            )?;
            let r = self
                .capabilities
                .request(
                    &j["profile"],
                    &format!("/videos/{remote}"),
                    CapabilityRequest {
                        method: hyper::Method::GET,
                        ..Default::default()
                    },
                    cancel,
                )
                .await?
                .json()?;
            check(!cancel.is_cancelled(), 499, "Media generation stopped")?;
            if r["status"] == "pending" {
                self.change(&id,json!({"status":"running","polls":j["polls"].as_u64().unwrap_or(0)+1,"note":"動画の完成を待っています。"}),cancel)?;
                return Ok(());
            }
            if matches!(r["status"].as_str(), Some("failed" | "expired")) {
                self.change(&id,json!({"status":"failed","providerMayContinue":false,"note":"動画の生成に失敗、または受付が失効しました。"}),cancel)?;
                return Ok(());
            }
            check(
                r["status"] == "done" && r["video"]["url"].is_string(),
                502,
                "Invalid video status",
            )?;
            check(
                r["video"]["respect_moderation"] != false,
                403,
                "動画サービスが配信を許可していません。",
            )?;
            j=self.change(&id,json!({"downloadUrl":r["video"]["url"],"status":"awaiting-download","note":"生成済みの動画を保存しています。"}),cancel)?;
            return self
                .download(&j, r["video"]["url"].as_str().unwrap(), cancel)
                .await;
        }
        let input = self.input(&j)?;
        check(!cancel.is_cancelled(), 499, "Media generation stopped")?;
        let kind = j["kind"].as_str().unwrap_or("");
        let mut request = CapabilityRequest {
            max_bytes: 24 * 1024 * 1024,
            ..Default::default()
        };
        let route = match kind {
            "tts" => {
                request.json = Some(
                    json!({"model":j["model"],"input":j["prompt"],"voice":j["profile"]["voice"],"response_format":"mp3"}),
                );
                "/audio/speech"
            }
            "image" => {
                request.json = Some(
                    json!({"model":j["model"],"prompt":j["prompt"],"n":1,"size":if truth(&j["options"]["size"]){j["options"]["size"].clone()}else{json!("1024x1024")}}),
                );
                "/images/generations"
            }
            "image_edit" => {
                let (bytes, mime) = input
                    .ok_or_else(|| CapabilityError::new(409, "編集する画像を選んでください。"))?;
                request.body = multipart(&j, &bytes, &mime);
                "/images/edits"
            }
            "video" => {
                let mut body = json!({"model":j["model"],"prompt":j["prompt"],"duration":if truth(&j["options"]["duration"]){j["options"]["duration"].clone()}else{json!(5)},"aspect_ratio":if truth(&j["options"]["aspectRatio"]){j["options"]["aspectRatio"].clone()}else{json!("16:9")}});
                if let Some((bytes, mime)) = input {
                    body["image"] = json!({"url":format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes))});
                }
                request.json = Some(body);
                "/videos/generations"
            }
            _ => return Err(CapabilityError::new(400, "Unsupported generation kind")),
        };
        self.change(&id,json!({"status":"submitting","note":"生成先へ依頼しています。","providerMayContinue":true}),cancel)?;
        let response = self
            .capabilities
            .request(&j["profile"], route, request, cancel)
            .await?;
        check(!cancel.is_cancelled(), 499, "Media generation stopped")?;
        if kind == "tts" {
            return self.finish(&j, &response.bytes, cancel);
        }
        let result = response.json()?;
        if kind == "video" {
            check(
                result["request_id"].as_str().is_some_and(token),
                502,
                "動画の受付IDがありません。",
            )?;
            self.change(&id,json!({"remoteId":result["request_id"],"status":"running","polls":0,"note":"動画を生成しています。画面を切り替えても状態は残ります。"}),cancel)?;
            return Ok(());
        }
        let first = &result["data"][0];
        check(truth(first), 502, "生成画像がありません。")?;
        if truth(&first["b64_json"]) {
            let encoded = first["b64_json"]
                .as_str()
                .ok_or_else(|| CapabilityError::new(400, "Invalid generated image"))?;
            check(
                encoded.len() < 24 * 1024 * 1024 && valid64(encoded),
                400,
                "Invalid generated image",
            )?;
            self.finish(&j, &decode64(encoded)?, cancel)
        } else if let Some(url) = first["url"].as_str() {
            j=self.change(&id,json!({"downloadUrl":url,"status":"awaiting-download","note":"生成済みファイルを取得します。"}),cancel)?;
            self.download(&j, url, cancel).await
        } else {
            Err(CapabilityError::new(500, "Unsupported image response"))
        }
    }
    async fn download(
        &self,
        j: &Value,
        url: &str,
        cancel: &RequestCancellation,
    ) -> Result<(), CapabilityError> {
        let result = self
            .capabilities
            .download(&j["profile"], url, cancel)
            .await?;
        self.finish(j, &result.bytes, cancel)
    }
    fn finish(
        &self,
        j: &Value,
        bytes: &[u8],
        cancel: &RequestCancellation,
    ) -> Result<(), CapabilityError> {
        let life = self
            .life
            .lock()
            .map_err(|_| CapabilityError::new(500, "Media lifecycle unavailable"))?;
        check(
            !life.closed && !cancel.is_cancelled(),
            499,
            "Media generation stopped",
        )?;
        let mime = media_type(bytes)?;
        check(
            mime.starts_with(match j["kind"].as_str() {
                Some("tts") => "audio/",
                Some("video") => "video/",
                _ => "image/",
            }),
            502,
            "Output modality mismatch",
        )?;
        check(
            !bytes.is_empty() && bytes.len() <= MAX_BYTES,
            413,
            "Media exceeds local size budget",
        )?;
        let (dir, total) = {
            let mut s = self.state.lock()?;
            (
                s.dir.join("media"),
                s.list("media-asset")?
                    .iter()
                    .map(|v| v["bytes"].as_u64().unwrap_or(0))
                    .sum::<u64>(),
            )
        };
        check(
            total + bytes.len() as u64 <= 512 * 1024 * 1024,
            413,
            "保存容量512MBに達しました。不要な生成物を削除してください。",
        )?;
        fs::create_dir_all(&dir).map_err(error)?;
        let id = Uuid::new_v4().to_string();
        let file = dir.join(&id);
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        opts.open(&file)
            .and_then(|mut f| f.write_all(bytes))
            .map_err(error)?;
        let asset = json!({"id":id,"mime":mime,"bytes":bytes.len(),"sha256":hash(bytes),"jobId":j["jobId"],"generationId":j["id"],"title":j["title"],"createdAt":now()});
        if let Err(e) = self.state.lock()?.put("media-asset", asset.clone()) {
            let _ = fs::remove_file(file);
            return Err(e.into());
        }
        let current = self.get(j["id"].as_str().unwrap_or(""))?;
        self.update(&current,json!({"status":"ready","asset":asset,"providerMayContinue":false,"note":"生成物を保存しました。内容と品質は確認してください。","downloadUrl":null}))?;
        Ok(())
    }
    pub(super) fn read_asset(&self, id: &str) -> Result<(Value, Vec<u8>), ApiError> {
        require(
            id.len() == 36
                && id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-'),
            400,
            "Invalid asset",
        )?;
        let (a, file) = {
            let mut s = self.state.lock()?;
            (s.get("media-asset", id)?, s.dir.join("media").join(id))
        };
        require(!a.is_null(), 404, "生成物がありません。")?;
        let length = fs::metadata(&file).map_err(error)?.len();
        require(
            Some(length) == a["bytes"].as_u64() && length <= MAX_BYTES as u64,
            409,
            "Media integrity check failed",
        )?;
        let bytes = fs::read(file).map_err(error)?;
        require(hash(&bytes) == a["sha256"], 409, "Media was modified")?;
        Ok((a, bytes))
    }
    pub(super) fn cancel(&self, id: &str) -> Result<Value, ApiError> {
        let mut life = self.life.lock().map_err(error)?;
        self.cancel_locked(&mut life, id)
    }
    fn cancel_locked(&self, life: &mut Lifecycle, id: &str) -> Result<Value, ApiError> {
        let j = self.get(id)?;
        require(!j.is_null(), 404, "Unknown media job")?;
        if matches!(j["status"].as_str(), Some("ready" | "failed" | "cancelled")) {
            return Ok(public(&j));
        }
        if let Some(c) = life.active.get(id) {
            c.cancel();
        }
        if let Some(t) = life.timers.remove(id) {
            t.cancel();
        }
        Ok(public(&self.update(&j,json!({"status":"cancelled","note":"Tepora側の処理を停止しました。送信済みの生成処理・課金は先方で続く場合があります。"}))?))
    }
    pub(super) fn resume(self: &Arc<Self>, id: &str) -> Result<Value, ApiError> {
        let mut life = self.life.lock().map_err(error)?;
        require(!life.closed, 503, "Service closing")?;
        let j = self.get(id)?;
        require(
            matches!(j["status"].as_str(), Some("paused" | "awaiting-download"))
                && (truth(&j["remoteId"]) || truth(&j["downloadUrl"]) || truth(&j["notSubmitted"])),
            409,
            "再送なしで確認できる受付IDがありません。",
        )?;
        require(
            self.capabilities
                .current(&j["profile"])
                .map_err(ApiError::from)?,
            409,
            "接続先が変更されています。元の設定を確認してください。",
        )?;
        let j = self.update(&j, json!({"status":"queued","polls":0}))?;
        self.pump(&mut life)?;
        Ok(public(&j))
    }
    pub(super) fn remove(&self, id: &str) -> Result<Value, ApiError> {
        let life = self.life.lock().map_err(error)?;
        let j = self.get(id)?;
        require(
            !j.is_null() && !life.active.contains_key(id) && !active(&j),
            409,
            "処理を停止してから削除してください。",
        )?;
        if let Some(asset) = j["asset"]["id"].as_str() {
            let file = self.state.lock()?.dir.join("media").join(asset);
            match fs::remove_file(file) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(error(e)),
            };
            self.state
                .lock()?
                .call("document.remove", json!({"kind":"media-asset","id":asset}))?;
        }
        let mut s = self.state.lock()?;
        s.call("document.remove", json!({"kind":"media-job","id":id}))?;
        let e = s.call(
            "event.append",
            json!({"type":"media.deleted","data":{"id":id},"at":now()}),
        )?;
        s.publish_value(e)?;
        Ok(json!({"deleted":true}))
    }
    pub(super) fn stop_all(&self) -> Result<(), ApiError> {
        let mut life = self.life.lock().map_err(error)?;
        for j in self.list_raw()? {
            if active(&j) {
                self.cancel_locked(&mut life, j["id"].as_str().unwrap_or(""))?;
            }
        }
        Ok(())
    }
    pub(super) fn begin_close(&self) -> Result<(), ApiError> {
        let mut life = self.life.lock().map_err(error)?;
        if life.closed {
            return Ok(());
        }
        life.closed = true;
        for (_, timer) in life.timers.drain() {
            timer.cancel();
        }
        for j in self.list_raw()? {
            if active(&j) {
                self.update(&j,json!({"status":if j["status"]=="submitting"&&!truth(&j["remoteId"]){"unknown"}else{"paused"},"notSubmitted":j["status"]=="queued"&&!truth(&j["remoteId"])&&!truth(&j["downloadUrl"]),"note":"停止前の受付状態を保存しました。再開はユーザーが選べます。"}))?;
            }
        }
        for cancel in life.active.values() {
            cancel.cancel();
        }
        Ok(())
    }
    pub(super) async fn drain(&self) {
        let tasks = {
            let mut life = self.life.lock().unwrap_or_else(|e| e.into_inner());
            std::mem::take(&mut life.tasks)
        };
        for task in tasks {
            let _ = task.await;
        }
    }
}
fn valid64(s: &str) -> bool {
    let no_pad = s.trim_end_matches('=');
    s.len() - no_pad.len() <= 2
        && no_pad
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+/".contains(&b))
}
fn decode64(s: &str) -> Result<Vec<u8>, CapabilityError> {
    let config = base64::engine::GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent);
    base64::engine::GeneralPurpose::new(&base64::alphabet::STANDARD, config)
        .decode(s)
        .map_err(|_| CapabilityError::new(400, "Invalid generated image"))
}
fn multipart(j: &Value, bytes: &[u8], mime: &str) -> CapabilityBody {
    let boundary = format!("----tepora{}", Uuid::new_v4().simple());
    let mut body = Vec::new();
    for (k, v) in [
        ("model", j["model"].as_str().unwrap_or("")),
        ("prompt", j["prompt"].as_str().unwrap_or("")),
        ("n", "1"),
    ] {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{}\r\n",
                json_codec::sql_text(v)
            )
            .as_bytes(),
        );
    }
    let filename = if mime == "image/jpeg" {
        "input.jpg"
    } else {
        "input.png"
    };
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n").as_bytes());
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    CapabilityBody::EncodedMedia {
        bytes: body.into(),
        content_type: format!("multipart/form-data; boundary={boundary}"),
    }
}
#[cfg(test)]
mod tests;
