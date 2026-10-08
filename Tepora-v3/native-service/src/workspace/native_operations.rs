//! HTTP domain admission; never holds the state mutex while calling the actor
//! or awaiting model transport. The offline development host stays effect-free.
use super::*;
use crate::agent::AgentRequest;
impl Workspace {
    pub(super) fn execute_native(&self, op: &Operation) -> Result<Option<Reply>, ApiError> {
        if !matches!(
            op,
            Operation::MediaEmbed { .. } | Operation::MediaView { .. } | Operation::SpeechStart | Operation::SpeechChunk {..} | Operation::SpeechFinish {..} | Operation::SpeechCancel {..} | Operation::MediaJobs | Operation::MediaCreate {..} | Operation::MediaCancel {..} | Operation::MediaResume {..} | Operation::MediaDelete {..} | Operation::MediaRead {..} | Operation::ModelCatalogSearch{..}
                | Operation::ModelCatalogImport{..}
                | Operation::ModelCatalogRefresh
                | Operation::Setup
                | Operation::SetupScan
                | Operation::SetupDismiss
                | Operation::SetupSelect{..}
                | Operation::SetupInstall{..}
                | Operation::SetupStop
                | Operation::SetupInstallHelp
                | Operation::RuntimeDiscover
                | Operation::SkillCreate { .. }
                | Operation::SkillPatch { .. }
                | Operation::SkillDelete { .. }
                | Operation::DialoguePersonas
                | Operation::DialoguePersonasSave { .. }
                | Operation::SettingsPatch { .. }
                | Operation::AgentInput { .. }
                | Operation::SearchKey { .. }
                | Operation::SessionAccept { .. }
                | Operation::SessionDelete { .. }
                | Operation::AgentSpawn { .. }
                | Operation::SessionMessage { .. }
                | Operation::SessionStop { .. }
                | Operation::SessionResume { .. }
                | Operation::AgentSettings
                | Operation::AgentSettingsPatch { .. }
                | Operation::Approvals
                | Operation::ApprovalsDecide { .. }
                | Operation::ApprovalDecide { .. }
                | Operation::Capabilities
                | Operation::CapabilitiesSave { .. }
                | Operation::CapabilityKey { .. }
                | Operation::Providers
                | Operation::ProvidersSave { .. }
                | Operation::ProviderKey { .. }
                | Operation::ProviderProbe { .. }
                | Operation::Network
                | Operation::NetworkPatch { .. }
                | Operation::StopAll
        ) {
            return Ok(None);
        }
        let native = self
            .native
            .get()
            .ok_or_else(|| ApiError::unavailable("This effect requires --dev-native --agent"))?;
        {
            let state = self.lock()?;
            require(!state.closed && !state.closing, 503, "Service closing")?;
        }
        let request = |r| native.agent.request(r);
        let value = match op {
            Operation::MediaEmbed { body } => self.media_embed(body, &native.network)?,
            Operation::MediaView { token } => return self.media_view(token, &native.network).map(Some),
            Operation::SpeechStart => {let settings=self.lock()?.settings()?;native.speech.start(&settings)?},
            Operation::SpeechChunk {body} => native.speech.chunk(body)?,
            Operation::SpeechFinish {body} => native.speech.finish(body)?,
            Operation::SpeechCancel {body} => native.speech.cancel(Some(body["id"].as_str().unwrap_or("")),false)?,
            Operation::MediaJobs => native.media.snapshot()?,
            Operation::MediaCreate {body} => native.media.create(body)?,
            Operation::MediaCancel {id} => native.media.cancel(id)?,
            Operation::MediaResume {id} => native.media.resume(id)?,
            Operation::MediaDelete {id} => native.media.remove(id)?,
            Operation::MediaRead {id} => {let (asset,bytes)=native.media.read_asset(id)?;return Ok(Some(Reply::Media{bytes,mime:asset["mime"].as_str().unwrap_or("").to_owned()}));},
            Operation::ModelCatalogRefresh | Operation::SetupScan | Operation::SetupSelect { .. } | Operation::RuntimeDiscover => return Err(ApiError::unavailable("Setup network operations require the asynchronous backend")),
            Operation::ModelCatalogSearch{query}=>native.catalog.search(query)?,
            Operation::ModelCatalogImport{body}=>native.catalog.import(body)?,
            Operation::Setup=>native.setup.snapshot()?,
            Operation::SetupDismiss=>native.setup.dismiss()?,
            Operation::SetupInstall{body}=>native.setup.install(body)?,
            Operation::SetupStop=>native.setup.stop(),
            Operation::SetupInstallHelp=>crate::setup::open_installer_page()?,
            Operation::SkillCreate { .. } | Operation::SkillPatch { .. } | Operation::SkillDelete { .. } => self.change_skill(op, || {
                native.agent.request(AgentRequest::RefreshPrompts).map(|_| ())
            })?,
            Operation::DialoguePersonas => self.preference_personas()?,
            Operation::DialoguePersonasSave { body } => self.change_personas(body, || {
                native.agent.request(AgentRequest::RefreshPrompts).map(|_| ())
            })?,
            Operation::SettingsPatch { body } => self.change_preferences(body, &native.network)?,
            Operation::SearchKey { body } => {
                let key = body["key"].as_str()
                    .ok_or_else(|| ApiError::bad_request("Invalid key"))?;
                require(body["provider"] == "brave" && json_codec::utf16_units(key).len() <= 500,
                    400, "Invalid key")?;
                {
                    let mut state = self.lock()?;
                    let old = state.value("search-keys")?;
                    let mut keys = old.as_object().cloned().unwrap_or_default();
                    if key.is_empty() {
                        keys.shift_remove("brave");
                    } else {
                        keys.insert("brave".into(), json!(key));
                    }
                    state.set_value("search-keys", Value::Object(keys))?;
                }
                // Credentials never appear in a durable/public event. Revoke
                // the previous web binding before acknowledging this change.
                native.host.invalidate_web()?;
                json!({"provider":"brave","keyPresent":!key.is_empty()})
            }
            Operation::SessionDelete { id } => request(AgentRequest::DeleteSession { id: id.clone() })?,
            Operation::SessionAccept { id } => {
                let session = self.access().agent_state("session.get", json!({"id":id}))?;
                require(!session.is_null(), 404, "Session not found")?;
                self.project_job(self.access().agent_state(
                    "session.update",
                    json!({"id":id,"patch":{"accepted":true,"acceptedAt":now()}}),
                )?)?
            }
            Operation::AgentInput { body } => request(AgentRequest::Input { body: body.clone() })?,
            Operation::AgentSpawn { body } => {
                self.project_job(request(AgentRequest::Spawn { body: body.clone() })?)?
            }
            Operation::SessionMessage { id, body } => {
                self.project_job(request(AgentRequest::Send {
                    id: id.clone(),
                    body: body.clone(),
                })?)?
            }
            Operation::SessionStop { id } => {
                let s = self.lock()?.get("session", id)?;
                require(!s.is_null(), 404, "Session not found")?;
                let main = s["kind"] == "main";
                let stopped = request(AgentRequest::Stop {
                    id: id.clone(),
                    reason: "あなたが止めました".into(),
                    rearm_main: main,
                })?;
                if main {
                    json!({"stopped":true})
                } else {
                    self.project_job(stopped)?
                }
            }
            Operation::SessionResume { id } => {
                self.project_job(request(AgentRequest::Resume { id: id.clone() })?)?
            }
            Operation::AgentSettings => {
                let mut s = self.lock()?.agent_settings()?;
                s["sandboxAvailable"] = sandbox();
                s
            }
            Operation::AgentSettingsPatch { body } => {
                let mut patch = body.clone();
                require(patch.is_object(), 400, "Invalid agent settings")?;
                if truth(&patch["policy"]) {
                    let rules = patch["policy"]
                        .get("rules")
                        .filter(|v| truth(v))
                        .cloned()
                        .unwrap_or_else(|| json!([]));
                    patch["policy"] = json!({"rules":crate::agent::policy::CompiledPolicy::validate(&rules)?.normalized_rules()});
                }
                request(AgentRequest::Configure { patch })?
            }
            Operation::Approvals => {
                let approvals = self.lock()?.list("approval")?;
                let p = json!({"approvals":approvals});
                let list = json_codec::parse(
                    &projection::project_json(
                        "ui.approvals",
                        &json_codec::stringify_js(&p).map_err(error)?,
                    )
                    .map_err(error)?,
                )
                .map_err(error)?;
                json!({"approvals":list})
            }
            Operation::ApprovalDecide { id, body } => {
                let allow = body["allow"]
                    .as_bool()
                    .ok_or_else(|| ApiError::bad_request("allow must be boolean"))?;
                request(AgentRequest::DecideApproval {
                    id: id.clone(),
                    allow,
                })?
            }
            Operation::ApprovalsDecide { body } => {
                let ids = body["ids"]
                    .as_array()
                    .filter(|a| !a.is_empty() && a.len() <= 50)
                    .ok_or_else(|| ApiError::bad_request("Approval ids are required"))?;
                let allow = body["allow"]
                    .as_bool()
                    .ok_or_else(|| ApiError::bad_request("allow must be boolean"))?;
                // Preserve per-ID failures instead of rejecting the whole batch.
                let results = ids
                    .iter()
                    .map(|id| {
                        match id.as_str().map(|id| {
                            request(AgentRequest::DecideApproval {
                                id: id.into(),
                                allow,
                            })
                        }) {
                            Some(Ok(_)) => json!({"id":id,"ok":true}),
                            Some(Err(e)) => json!({"id":id,"ok":false,"error":e.message}),
                            None => {
                                json!({"id":id,"ok":false,"error":"この承認はもう待っていません。"})
                            }
                        }
                    })
                    .collect::<Vec<_>>();
                json!({"results":results})
            }
            Operation::Capabilities => native.capabilities.snapshot().map_err(ApiError::from)?,
            Operation::CapabilitiesSave { body } => {
                // Source CAS is strict: malformed/missing revision is a stale
                // revision error, checked before registry validation.
                let expected = safe_integer(&body["expectedRevision"])
                    .filter(|n| *n >= 0)
                    .ok_or_else(|| {
                        ApiError::new(409, "Capability settings changed. Reload before saving.")
                    })?;
                require(
                    native.capabilities.get().map_err(ApiError::from)?["revision"].as_u64()
                        == Some(expected as u64),
                    409,
                    "Capability settings changed. Reload before saving.",
                )?;
                native
                    .capabilities
                    .save(&body["config"], expected as u64)
                    .map_err(ApiError::from)?
            }
            Operation::CapabilityKey { id, body } => native
                .capabilities
                .set_key(id, &body["key"], &body["identity"])
                .map_err(ApiError::from)?,
            Operation::Providers => native.provider.public_snapshot()?,
            Operation::ProvidersSave { body } => {
                let expected = safe_integer(&body["expectedRevision"])
                    .filter(|n| *n >= 0)
                    .ok_or_else(|| ApiError::bad_request("Invalid registry revision"))?;
                native.provider.save(&body["config"], expected as u64)?
            }
            Operation::ProviderKey { id, body } => {
                let key = body["key"]
                    .as_str()
                    .ok_or_else(|| ApiError::bad_request("Invalid provider key"))?;
                native.provider.set_key(id, &json_codec::sql_text(key))?
            }
            Operation::ProviderProbe { id } => self.run_probe(id, self.probe_cancellation())?,
            Operation::Network => {
                let raw = self.lock()?.value("network-policy")?;
                if raw.is_null() {
                    json!({"schema":1,"revision":0,"mode":"online","internetTools":true})
                } else {
                    raw
                }
            }
            Operation::NetworkPatch { body } => {
                let mut s = self.lock()?;
                let raw = s.value("network-policy")?;
                let old = if raw.is_null() {
                    json!({"schema":1,"revision":0,"mode":"online","internetTools":true})
                } else {
                    raw
                };
                require(
                    safe_integer(&old["revision"]).is_some()
                        && safe_integer(&old["revision"])
                            == safe_integer(&body["expectedRevision"]),
                    409,
                    "通信設定が更新されています。開き直してください。",
                )?;
                require(
                    body["patch"].as_object().is_some_and(|p| {
                        p.keys()
                            .all(|k| ["mode", "internetTools"].contains(&k.as_str()))
                    }),
                    400,
                    "通信設定以外は変更できません。",
                )?;
                let mut next = merge(&old, &body["patch"]);
                next["revision"] = json!(old["revision"].as_u64().unwrap_or(0) + 1);
                let policy =
                    crate::network::NetworkPolicy::from_value(&next).map_err(ApiError::from)?;
                s.set_value("network-policy", next.clone())?;
                native.network.update_policy(policy);
                let event = s.call(
                    "event.append",
                    json!({"type":"network.updated","data":next,"at":now()}),
                )?;
                s.publish_value(event)?;
                if body["patch"].get("internetTools").is_some() {
                    let mut settings = s.settings()?;
                    settings["allowNetwork"] = next["internetTools"].clone();
                    s.set_value("settings", settings.clone())?;
                    let event = s.call(
                        "event.append",
                        json!({"type":"settings.updated","data":settings,"at":now()}),
                    )?;
                    s.publish_value(event)?;
                }
                next["note"] =
                    json!("Tepora管理の通信に適用します。OS全体のファイアウォールではありません。");
                // Cancel selection while State still excludes its final commit.
                if next["mode"]!="online" {native.setup.stop();s.media_frames.clear();}
                drop(s);
                next
            }
            Operation::StopAll => {
                let _speech_drain = native.speech.stop_barrier(false)?;
                let _voice_drain = native.voice.stop_barrier(false)?;
                let _feed_drain = native.feeds.stop_barrier(false)?;
                native.media.stop_all()?;
                native.semantic.cancel_all();
                native.setup.stop();
                self.cancel_probes()?;
                native.provider.cancel_all();
                let sessions = self.lock()?.list("session")?;
                for s in sessions {
                    let id = s["id"].as_str().unwrap_or("");
                    let running = native.agent.state(id)?;
                    if matches!(s["status"].as_str(), Some("running" | "waiting"))
                        || running["active"] == true
                    {
                        request(AgentRequest::Stop {
                            id: id.into(),
                            reason: "すべて停止しました".into(),
                            rearm_main: s["kind"] == "main",
                        })?;
                    }
                }
                json!({"stopped":true})
            }
            _ => unreachable!("native operation dispatch is exhaustive"),
        };
        Ok(Some(Reply::Json(value)))
    }
    pub(super) fn run_probe(
        &self,
        id: &str,
        cancel: crate::network::RequestCancellation,
    ) -> Result<Value, ApiError> {
        let native = self
            .native
            .get()
            .ok_or_else(|| ApiError::unavailable("This effect requires --dev-native --agent"))?;
        {
            let state = self.lock()?;
            require(!state.closed && !state.closing, 503, "Service closing")?;
        }
        if cancel.is_cancelled() {
            return Err(ApiError::new(
                499,
                "Provider probe was stopped before dispatch",
            ));
        }
        native.runtime.block_on(async {
            match tokio::time::timeout(
                std::time::Duration::from_secs(90),
                native.provider.probe(id, &cancel),
            )
            .await
            {
                Ok(result) => result.map_err(|e| ApiError {
                    status: e.status,
                    message: e.message,
                    blocked: e.blocked,
                }),
                Err(_) => {
                    cancel.cancel();
                    Err(ApiError::new(504, "Provider probe timed out"))
                }
            }
        })
    }
    fn project_job(&self, session: Value) -> Result<Value, ApiError> {
        let count = self
            .lock()?
            .list("approval")?
            .iter()
            .filter(|a| a["sessionId"] == session["id"] && a["status"] == "pending")
            .count();
        json_codec::parse(
            &projection::project_json(
                "ui.job",
                &json_codec::stringify_js(&json!({"session":session,"approvals":count}))
                    .map_err(error)?,
            )
            .map_err(error)?,
        )
        .map_err(error)
    }
}
