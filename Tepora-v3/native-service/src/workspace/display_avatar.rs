//! Display and avatar configuration only. Asset metadata can constrain a look;
//! no upload, file serving, image inspection or photo-frame effect is provided.
use super::preferences::{ordered_keys, plus_one, spread, strict_equal};
use super::*;
#[path = "display_avatar/date.rs"]
mod date;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VisualAction {
    Get,
    Change,
    Undo,
    Reset,
    Export,
    Import,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Display,
    Avatar,
}
impl Kind {
    fn key(self) -> &'static str {
        match self {
            Self::Display => "display",
            Self::Avatar => "avatar",
        }
    }
}
fn constants() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        json_codec::parse(include_str!("display_avatar/constants.json"))
            .expect("frozen visual constants")
    })
}
fn default_config(kind: Kind) -> Value {
    constants()[match kind {
        Kind::Display => "displayDefault",
        Kind::Avatar => "avatarDefault",
    }]
    .clone()
}
fn own_merge(old: &Value, patch: &Value) -> Value {
    let mut map = spread(old);
    for (key, value) in spread(patch) {
        map.insert(key, value);
    }
    Value::Object(map)
}
fn member(value: &Value, choices: &[&str]) -> bool {
    value.as_str().is_some_and(|s| choices.contains(&s))
}
fn listed(value: &Value, key: &str) -> bool {
    constants()[key]
        .as_array()
        .is_some_and(|a| a.contains(value))
}
fn rounded(value: &Value, scale: f64) -> Value {
    let n = (value.as_f64().unwrap() * scale).round() / scale;
    if n.fract() == 0. {
        json!(n as i64)
    } else {
        json!(n)
    }
}
fn finite(value: &Value, min: f64, max: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n.is_finite() && (min..=max).contains(&n))
}
fn validate_display(input: &Value, previous: &Value) -> Result<Value, ApiError> {
    require(input.is_object(), 400, "Invalid display settings")?;
    for key in ordered_keys(input) {
        require(
            ["theme", "textScale", "widgets", "hiddenUntil", "ambient"].contains(&key.as_str()),
            400,
            &format!("Display cannot change {key}"),
        )?;
    }
    let mut next = own_merge(previous, input);
    require(
        member(&next["theme"], &["system", "light", "dark"]),
        400,
        "Invalid theme",
    )?;
    require(
        finite(&next["textScale"], 0.8, 1.8),
        400,
        "Invalid text scale",
    )?;
    require(
        next["widgets"].as_array().is_some_and(|widgets| {
            widgets.len() <= 7
                && widgets.iter().all(|w| listed(w, "widgets"))
                && widgets
                    .iter()
                    .enumerate()
                    .all(|(i, w)| !widgets[..i].contains(w))
        }),
        400,
        "Invalid widgets",
    )?;
    require(
        next["hiddenUntil"].is_object(),
        400,
        "Invalid temporary visibility",
    )?;
    for key in ordered_keys(&next["hiddenUntil"]) {
        require(
            listed(&json!(key), "widgets")
                && next["hiddenUntil"][&key].as_str().is_some_and(date::valid),
            400,
            "Invalid hide-until time",
        )?;
    }
    let ambient = own_merge(&constants()["ambientDefault"], &next["ambient"]);
    require(
        next.get("ambient").is_none() || next["ambient"].is_object(),
        400,
        "Invalid idle screen settings",
    )?;
    for key in ordered_keys(&ambient) {
        require(
            constants()["ambientDefault"].get(&key).is_some(),
            400,
            &format!("Display cannot change ambient.{key}"),
        )?;
    }
    require(
        ambient["idleMinutes"]
            .as_f64()
            .is_some_and(|n| [0., 1., 3., 5., 10., 30.].contains(&n)),
        400,
        "Invalid idle time",
    )?;
    require(
        safe_integer(&ambient["rotateSeconds"]).is_some_and(|n| (6..=120).contains(&n)),
        400,
        "Invalid card interval",
    )?;
    require(
        ambient["nightDim"].is_boolean(),
        400,
        "Invalid night setting",
    )?;
    require(
        member(
            &ambient["wallpaper"],
            &["room", "plain", "drift", "stars", "photos"],
        ),
        400,
        "Invalid wallpaper",
    )?;
    require(
        ambient["keepAwake"].is_boolean(),
        400,
        "Invalid keep-awake setting",
    )?;
    require(
        ambient["frameSeconds"]
            .as_f64()
            .is_some_and(|n| [10., 30., 60., 300., 900., 3600.].contains(&n)),
        400,
        "Invalid photo interval",
    )?;
    require(
        ambient["frameShuffle"].is_boolean(),
        400,
        "Invalid photo order",
    )?;
    require(
        member(&ambient["frameFit"], &["cover", "contain", "mat"]),
        400,
        "Invalid photo fit",
    )?;
    require(
        ambient["frameMotion"].is_boolean(),
        400,
        "Invalid photo motion",
    )?;
    require(
        member(&ambient["frameClock"], &["off", "small", "large"]),
        400,
        "Invalid photo clock",
    )?;
    require(
        ambient["frameCreated"].is_boolean(),
        400,
        "Invalid created-images setting",
    )?;
    next["ambient"] = ambient;
    Ok(next)
}
fn body(id: &Value) -> Option<&'static Value> {
    constants()["bodies"]
        .as_array()?
        .iter()
        .find(|b| b["id"] == *id)
}
fn default_avatar(id: &Value) -> Value {
    constants()["defaults"][body(id)
        .map(|b| b["id"].as_str().unwrap())
        .unwrap_or("shiro")]
    .clone()
}
fn needs(spec: &Value) -> Option<&'static str> {
    body(&spec["body"]).and_then(|b| b["needs"].as_str())
}
fn switch_body(previous: &Value, id: &Value) -> Result<Value, ApiError> {
    let old =
        body(&previous["body"]).ok_or_else(|| ApiError::new(500, "Invalid saved avatar body"))?;
    let def = body(id).ok_or_else(|| ApiError::bad_request("Invalid body"))?;
    let mut next = default_avatar(id);
    require(
        previous["lamp"].is_object() && previous["face"].is_object(),
        500,
        "Invalid saved avatar groups",
    )?;
    let own_palette = previous["palette"]
        != old
            .get("palette")
            .cloned()
            .unwrap_or_else(|| json!("washi"));
    let own_shape = previous["lamp"]["shape"]
        != old
            .get("lampShape")
            .cloned()
            .unwrap_or_else(|| json!("bead"));
    if own_palette {
        next["palette"] = previous["palette"].clone();
    }
    next["hue"] = previous["hue"].clone();
    if own_shape && (def["kind"] != "svg" || previous["lamp"]["shape"] != "none") {
        next["lamp"]["shape"] = previous["lamp"]["shape"].clone();
    }
    next["lamp"]["hue"] = previous["lamp"]["hue"].clone();
    next["face"]["cheeks"] = previous["face"]["cheeks"].clone();
    next["face"]["brows"] = previous["face"]["brows"].clone();
    next["props"] = Value::Object(spread(&previous["props"]));
    for key in ["motion", "size"] {
        next[key] = previous[key].clone();
    }
    next["render"] = if def["modes"]
        .as_array()
        .is_some_and(|a| a.contains(&previous["render"]))
    {
        previous["render"].clone()
    } else {
        json!("flat")
    };
    if let Some(revision) = previous.get("revision") {
        next["revision"] = revision.clone();
    }
    Ok(next)
}
fn asset_id(value: &str) -> bool {
    value.len() == 36
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
}

fn validate_avatar(input: &Value, previous: &Value) -> Result<Value, ApiError> {
    require(input.is_object(), 400, "Invalid avatar settings")?;
    for key in ordered_keys(input) {
        require(
            [
                "body", "render", "palette", "hue", "lamp", "face", "parts", "props", "slots",
                "motion", "size", "asset",
            ]
            .contains(&key.as_str()),
            400,
            &format!("Avatar cannot change {key}"),
        )?;
    }
    let mut next = previous.clone();
    if let Some(id) = input.get("body") {
        if !strict_equal(Some(id), previous.get("body")) {
            require(id.is_string() && body(id).is_some(), 400, "Invalid body")?;
            next = switch_body(previous, id)?;
        }
    }
    require(next.is_object(), 500, "Invalid saved avatar")?;
    for key in ["render", "palette", "hue", "motion", "size", "asset"] {
        if let Some(value) = input.get(key) {
            next[key] = value.clone();
        }
    }
    for (key, allowed) in [
        ("lamp", &["hue", "shape"][..]),
        ("face", &["eyes", "cheeks", "brows"][..]),
        ("parts", &["ears"][..]),
        ("props", &["season", "hobby"][..]),
    ] {
        if let Some(group) = input.get(key) {
            require(group.is_object(), 400, &format!("Invalid {key}"))?;
            for field in ordered_keys(group) {
                require(
                    allowed.contains(&field.as_str()),
                    400,
                    &format!("Avatar cannot change {key}.{field}"),
                )?;
            }
            require(next[key].is_object(), 500, "Invalid saved avatar groups")?;
            next[key] = own_merge(&next[key], group);
        }
    }
    let def = body(&next["body"]).ok_or_else(|| ApiError::bad_request("Invalid body"))?;
    require(
        def["modes"]
            .as_array()
            .is_some_and(|a| a.contains(&next["render"])),
        400,
        "Invalid render mode for this body",
    )?;
    require(listed(&next["palette"], "palettes"), 400, "Invalid palette")?;
    require(finite(&next["hue"], 0., 360.), 400, "Invalid hue")?;
    next["hue"] = rounded(&next["hue"], 10.);
    require(
        listed(&next["lamp"]["hue"], "lamps"),
        400,
        "Invalid lamp colour",
    )?;
    require(
        listed(&next["lamp"]["shape"], "lampShapes")
            && (next["lamp"]["shape"] != "none" || def["kind"] != "svg"),
        400,
        "Invalid lamp shape",
    )?;
    require(listed(&next["face"]["eyes"], "eyes"), 400, "Invalid eyes")?;
    require(
        next["face"]["cheeks"].is_boolean() && next["face"]["brows"].is_boolean(),
        400,
        "Invalid face",
    )?;
    require(
        listed(&next["parts"]["ears"], "ears")
            && (next["parts"]["ears"] == "none"
                || def["parts"]
                    .as_array()
                    .is_some_and(|a| a.contains(&json!("ears")))),
        400,
        "Invalid ears",
    )?;
    require(
        listed(&next["props"]["season"], "seasons"),
        400,
        "Invalid season prop",
    )?;
    require(
        listed(&next["props"]["hobby"], "hobbies"),
        400,
        "Invalid hobby prop",
    )?;
    require(listed(&next["motion"], "motions"), 400, "Invalid motion")?;
    require(finite(&next["size"], 0.8, 1.25), 400, "Invalid size")?;
    next["size"] = rounded(&next["size"], 100.);
    if let Some(slots) = input.get("slots") {
        require(slots.is_object(), 400, "Invalid slots")?;
        for key in ordered_keys(slots) {
            let slot = def["slots"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["key"] == key)
                .ok_or_else(|| ApiError::bad_request(format!("This body has no {key} setting")))?;
            require(
                slot["opts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|o| o[0] == slots[&key]),
                400,
                &format!("Invalid {key}"),
            )?;
            require(next["slots"].is_object(), 500, "Invalid saved avatar slots")?;
            next["slots"][&key] = slots[&key].clone();
        }
    }
    require(
        next.get("asset")
            .is_some_and(|a| a.is_null() || a.as_str().is_some_and(asset_id)),
        400,
        "Invalid asset",
    )?;
    require(
        truth(&def["needs"]) || next["asset"].is_null(),
        400,
        "This body does not use an uploaded file",
    )?;
    next["schema"] = json!(1);
    Ok(next)
}
fn exported(kind: Kind, current: &Value) -> Value {
    let mut settings = spread(current);
    for key in ["schema", "revision"] {
        settings.shift_remove(key);
    }
    if kind == Kind::Avatar {
        settings.shift_remove("asset");
    }
    json!({"format":format!("tepora-{}",kind.key()),"version":1,"settings":settings})
}
fn imported(kind: Kind, preset: &Value) -> Result<Value, ApiError> {
    let error = match kind {
        Kind::Display => "Unsupported display preset",
        Kind::Avatar => "Unsupported avatar preset",
    };
    require(
        (kind == Kind::Display || preset.is_object())
            && preset["format"] == format!("tepora-{}", kind.key())
            && preset["version"].as_f64() == Some(1.),
        400,
        error,
    )?;
    require(
        ordered_keys(preset)
            .iter()
            .all(|k| ["format", "version", "settings"].contains(&k.as_str())),
        400,
        "Presets cannot include capabilities",
    )?;
    let mut settings = preset["settings"].clone();
    if kind == Kind::Avatar {
        require(settings.is_object(), 400, "Invalid avatar preset")?;
        require(
            settings.get("asset").is_none_or(Value::is_null),
            400,
            "Presets cannot name an uploaded file",
        )?;
        settings.as_object_mut().unwrap().shift_remove("asset");
    }
    Ok(settings)
}
fn usable(spec: &Value, assets: &Value) -> Result<(), ApiError> {
    if let Some(kind) = needs(spec) {
        require(truth(&spec["asset"]), 409, "素材を選んでください。")?;
        require(
            assets.as_array().is_some_and(|a| {
                a.iter()
                    .any(|a| a["id"] == spec["asset"] && a["kind"] == kind)
            }),
            409,
            "選んだ素材が見つかりません。",
        )?;
    }
    Ok(())
}
fn history(raw: &Value) -> Result<Vec<Value>, ApiError> {
    if !truth(raw) {
        return Ok(vec![]);
    }
    if let Some(array) = raw.as_array() {
        return Ok(array.clone());
    }
    if let Some(text) = raw.as_str() {
        let units = json_codec::utf16_units(text);
        let mut out = Vec::new();
        let mut i = 0;
        while i < units.len() {
            let count = if (0xd800..=0xdbff).contains(&units[i])
                && units
                    .get(i + 1)
                    .is_some_and(|u| (0xdc00..=0xdfff).contains(u))
            {
                2
            } else {
                1
            };
            out.push(json!(json_codec::from_utf16_units(&units[i..i + count])));
            i += count;
        }
        return Ok(out);
    }
    Err(ApiError::new(500, "history is not iterable"))
}
struct Plan {
    value: Value,
    mutation: Option<(Value, Value)>,
}
fn plan(
    kind: Kind,
    action: VisualAction,
    body: &Value,
    current: &Value,
    old_history: &Value,
    assets: &Value,
) -> Result<Plan, ApiError> {
    if action == VisualAction::Get {
        return Ok(Plan {
            value: current.clone(),
            mutation: None,
        });
    }
    if action == VisualAction::Export {
        return Ok(Plan {
            value: exported(kind, current),
            mutation: None,
        });
    }
    let expected = body.get("expectedRevision");
    let change_error = match kind {
        Kind::Display => "The display changed in another window. Reload before saving.",
        Kind::Avatar => "The character changed in another window. Reload before saving.",
    };
    if action == VisualAction::Undo {
        require(
            strict_equal(current.get("revision"), expected),
            409,
            if kind == Kind::Display {
                "Display revision conflict"
            } else {
                "Avatar revision conflict"
            },
        )?;
        let has_history = if !truth(old_history) {
            false
        } else {
            match old_history {
                Value::Array(a) => !a.is_empty(),
                Value::String(s) => !s.is_empty(),
                _ => truth(&old_history["length"]),
            }
        };
        require(has_history, 409, "Nothing to undo")?;
        let mut history = old_history
            .as_array()
            .cloned()
            .ok_or_else(|| ApiError::new(500, "history.pop is not a function"))?;
        let mut previous = history.pop().unwrap();
        if kind == Kind::Avatar && usable(&previous, assets).is_err() {
            previous = default_avatar(&json!("shiro"));
        }
        let mut next = Value::Object(spread(&previous));
        next["revision"] = plus_one(current.get("revision"));
        return Ok(Plan {
            value: next.clone(),
            mutation: Some((next, json!(history))),
        });
    }
    let mut patch = match action {
        VisualAction::Change => body["patch"].clone(),
        VisualAction::Reset => {
            let mut p = default_config(kind);
            p.as_object_mut().unwrap().shift_remove("schema");
            p.as_object_mut().unwrap().shift_remove("revision");
            p
        }
        VisualAction::Import => imported(kind, &body["preset"])?,
        _ => unreachable!(),
    };
    if kind == Kind::Avatar && action == VisualAction::Import {
        let probe = validate_avatar(&patch, current)?;
        if let Some(need) = needs(&probe) {
            if !truth(&probe["asset"]) {
                let latest = assets
                    .as_array()
                    .and_then(|a| a.iter().rev().find(|a| a["kind"] == need))
                    .ok_or_else(|| {
                        ApiError::new(
                            409,
                            "この設定には、先に素材（3Dモデル・画像など）の追加が必要です。",
                        )
                    })?;
                patch["asset"] = latest["id"].clone();
            }
        }
    }
    require(
        strict_equal(expected, current.get("revision")),
        409,
        change_error,
    )?;
    let mut next = match kind {
        Kind::Display => validate_display(&patch, current)?,
        Kind::Avatar if action == VisualAction::Reset => default_avatar(&json!("shiro")),
        Kind::Avatar => {
            let next = validate_avatar(&patch, current)?;
            usable(&next, assets)?;
            next
        }
    };
    next["revision"] = plus_one(current.get("revision"));
    let mut history = history(old_history)?;
    history.push(current.clone());
    if history.len() > 20 {
        history.drain(..history.len() - 20);
    }
    Ok(Plan {
        value: next.clone(),
        mutation: Some((next, json!(history))),
    })
}
impl Workspace {
    pub(super) fn execute_visual(&self, op: &Operation) -> Result<Option<Reply>, ApiError> {
        let (kind, action, body) = match op {
            Operation::Display { action, body } => (Kind::Display, *action, body),
            Operation::Avatar { action, body } => (Kind::Avatar, *action, body),
            _ => return Ok(None),
        };
        let mut state = self.lock()?;
        require(!state.closed && !state.closing, 503, "Service closing")?;
        let raw = state.value(kind.key())?;
        let current = if truth(&raw) {
            raw
        } else {
            default_config(kind)
        };
        let history_key = format!("{}-history", kind.key());
        let old_history = state.value(&history_key)?;
        let assets = if kind == Kind::Avatar {
            state.value("avatar-assets")?
        } else {
            Value::Null
        };
        let planned = plan(kind, action, body, &current, &old_history, &assets)?;
        if let Some((next, history)) = planned.mutation {
            state.call("exec", json!({"sql":"SAVEPOINT native_visual_config"}))?;
            let committed = (|| -> Result<Value, ApiError> {
                state.set_value(&history_key, history)?;
                state.set_value(kind.key(), next.clone())?;
                let event = state.call(
                    "event.append",
                    json!({"type":format!("{}.updated",kind.key()),"data":next,"at":now()}),
                )?;
                state.call("exec", json!({"sql":"RELEASE native_visual_config"}))?;
                Ok(event)
            })();
            match committed {
                Ok(event) => state.publish_value(event)?,
                Err(error) => {
                    let _=state.call("exec",json!({"sql":"ROLLBACK TO native_visual_config; RELEASE native_visual_config"}));
                    return Err(error);
                }
            }
        }
        Ok(Some(Reply::Json(planned.value)))
    }
}
#[cfg(test)]
#[path = "display_avatar/tests.rs"]
mod tests;
