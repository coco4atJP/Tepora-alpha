//! JSON-lines request handling, independent of the operating system. Each backend implements [`Backend`];
//! [`handle_line`] validates a request, calls the backend and formats the reply exactly like ax-helper.swift.
use crate::contract::Contract;
use crate::keys::{parse_combo, Combo};
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct HelperError(pub String);
impl HelperError {
    pub fn new(message: impl Into<String>) -> Self {
        HelperError(message.into())
    }
}
impl<E: std::fmt::Display> From<E> for HelperError {
    fn from(e: E) -> Self {
        HelperError(e.to_string())
    }
}
pub type Result<T> = std::result::Result<T, HelperError>;

/// A screen rectangle in the backend's coordinate space (pixels on Windows and X11).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}
impl Rect {
    pub fn mid(&self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }
    pub fn intersects(&self, o: &Rect) -> bool {
        self.x < o.x + o.w && o.x < self.x + self.w && self.y < o.y + o.h && o.y < self.y + self.h
    }
}

/// One control as a backend read it, before it becomes an observation element.
#[derive(Debug, Clone, Default)]
pub struct Node {
    pub role: String,
    pub name: String,
    pub frame: Rect,
    pub value: Option<String>,
    pub checked: Option<bool>,
    pub selected: bool,
    pub disabled: bool,
    pub focused: bool,
    pub expanded: Option<bool>,
}

/// The element JSON the macOS helper produces for the same control (ref, role, name, center x/y relative to
/// the window, inView, value for fields, checked for toggles, flags). `scale` is device pixels per logical
/// point (Windows DPI / 96, 1 on X11), so coordinates mean the same thing as the macOS helper's points.
pub fn element(contract: &Contract, index: usize, node: &Node, window: &Rect, scale: f64) -> Option<Value> {
    if node.frame.w < 1.0 || node.frame.h < 1.0 {
        return None;
    }
    let (mx, my) = node.frame.mid();
    let mut item = Map::new();
    item.insert("ref".into(), json!(format!("a{index}")));
    item.insert("role".into(), json!(node.role));
    item.insert("name".into(), json!(truncate(&node.name, 140)));
    item.insert("x".into(), json!(((mx - window.x) / scale) as i64));
    item.insert("y".into(), json!(((my - window.y) / scale) as i64));
    item.insert("inView".into(), json!(window.intersects(&node.frame)));
    if contract.value_roles.contains(&node.role) {
        let raw = node.value.clone().unwrap_or_default();
        if node.role == "password" {
            item.insert("value".into(), json!(if raw.is_empty() { "" } else { "••••" }));
            item.insert("valueMasked".into(), json!(true));
        } else {
            item.insert("value".into(), json!(truncate(&raw, 200)));
            if raw.chars().count() > 200 {
                item.insert("valueTruncated".into(), json!(true));
            }
        }
    }
    if contract.toggle_roles.contains(&node.role) {
        item.insert("checked".into(), json!(node.checked.unwrap_or(false)));
    }
    if node.selected {
        item.insert("selected".into(), json!(true));
    }
    if node.disabled {
        item.insert("disabled".into(), json!(true));
    }
    if node.focused {
        item.insert("focused".into(), json!(true));
    }
    if let Some(ex) = node.expanded {
        item.insert("expanded".into(), json!(ex));
    }
    Some(Value::Object(item))
}

pub fn fmt_number(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

pub fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Collects observed text the way the macOS helper does: lines until about 4000 characters.
#[derive(Default)]
pub struct TextLines {
    lines: Vec<String>,
    size: usize,
}
impl TextLines {
    pub fn push(&mut self, s: &str) {
        let s = s.trim();
        if !s.is_empty() && self.size < 4000 {
            self.size += s.chars().count();
            self.lines.push(s.to_owned());
        }
    }
    pub fn join(&self) -> String {
        self.lines.join("\n")
    }
}

/// The observation reply: title, elements, text, window frame (in points), nodes visited.
pub fn observation(title: &str, elements: Vec<Value>, text: &TextLines, window: &Rect, visited: usize, scale: f64) -> Value {
    json!({"title": title, "elements": elements, "text": text.join(),
        "frame": {"x": window.x / scale, "y": window.y / scale, "w": window.w / scale, "h": window.h / scale}, "visited": visited})
}

/// A window-relative point in logical points to a screen pixel.
pub fn to_screen(window: &Rect, scale: f64, x: f64, y: f64) -> (f64, f64) {
    (window.x + x * scale, window.y + y * scale)
}

pub struct Shot {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowInfo {
    pub pid: u32,
    pub app: String,
    pub title: String,
    pub window_id: u64,
    pub active: bool,
}

pub struct Check {
    pub reference: String,
    pub value: Option<String>,
}

/// What every OS helper provides; parameters arrive validated.
pub trait Backend {
    fn status(&mut self) -> Value;
    fn windows(&mut self) -> Result<Vec<WindowInfo>>;
    fn observe(&mut self, pid: u32, title: &str, max: usize) -> Result<Value>;
    /// The current value of a control from the latest observation (for matches).
    fn value(&mut self, pid: u32, reference: &str) -> Result<Option<String>>;
    fn press(&mut self, pid: u32, reference: &str) -> Result<()>;
    fn click(&mut self, pid: u32, x: f64, y: f64, title: &str) -> Result<()>;
    fn set_text(&mut self, pid: u32, reference: &str, text: &str) -> Result<()>;
    fn type_text(&mut self, pid: u32, text: &str) -> Result<()>;
    fn choose(&mut self, pid: u32, reference: &str, option: &str) -> Result<()>;
    fn key(&mut self, pid: u32, combo: &Combo) -> Result<()>;
    fn scroll(&mut self, pid: u32, reference: &str, dy: i64) -> Result<()>;
    fn screenshot(&mut self, pid: u32, title: &str) -> Result<Shot>;
    fn open(&mut self, what: &str) -> Result<()>;
}

/// Refs are "a<index>" into the latest observation of that app, as on macOS.
pub fn ref_index(reference: &str) -> Result<usize> {
    reference
        .strip_prefix('a')
        .and_then(|n| n.parse::<usize>().ok())
        .ok_or_else(|| HelperError::new(format!("Control {reference} is not in the latest observation. Observe again.")))
}

/// Per-app element snapshots from the latest observation.
pub struct Snapshots<T> {
    by_pid: std::collections::HashMap<u32, Vec<T>>,
}
impl<T> Default for Snapshots<T> {
    fn default() -> Self {
        Snapshots { by_pid: Default::default() }
    }
}
impl<T> Snapshots<T> {
    pub fn replace(&mut self, pid: u32, items: Vec<T>) {
        self.by_pid.insert(pid, items);
    }
    pub fn get(&self, pid: u32, reference: &str) -> Result<&T> {
        let i = ref_index(reference)?;
        self.by_pid
            .get(&pid)
            .and_then(|list| list.get(i))
            .ok_or_else(|| HelperError::new(format!("Control {reference} is not in the latest observation. Observe again.")))
    }
}

fn str_param<'a>(req: &'a Value, key: &str) -> &'a str {
    req.get(key).and_then(Value::as_str).unwrap_or("")
}
fn num_param(req: &Value, key: &str) -> Option<f64> {
    req.get(key).and_then(Value::as_f64).filter(|n| n.is_finite())
}
fn need_ref(req: &Value) -> Result<&str> {
    let r = str_param(req, "ref");
    if r.is_empty() {
        return Err(HelperError::new("ref is required"));
    }
    ref_index(r)?;
    Ok(r)
}
fn pid_param(req: &Value) -> Result<u32> {
    match req.get("pid").and_then(Value::as_u64) {
        Some(p) if p > 0 && p <= u32::MAX as u64 => Ok(p as u32),
        _ => Err(HelperError::new("pid is required")),
    }
}

pub fn handle(backend: &mut dyn Backend, req: &Value) -> Result<Value> {
    let cmd = str_param(req, "cmd");
    let title = str_param(req, "title");
    match cmd {
        "status" => Ok(backend.status()),
        "windows" => Ok(json!({"windows": backend.windows()?.into_iter().map(|w| json!({
            "pid": w.pid, "app": w.app, "title": w.title, "windowId": w.window_id, "active": w.active})).collect::<Vec<_>>()})),
        "observe" => {
            let max = req.get("max").and_then(Value::as_u64).unwrap_or(1500).clamp(1, 5000) as usize;
            backend.observe(pid_param(req)?, title, max)
        }
        "matches" => {
            let pid = pid_param(req)?;
            let checks: Vec<Check> = req
                .get("checks")
                .and_then(Value::as_array)
                .map(|a| a.iter().map(|c| Check { reference: str_param(c, "ref").to_owned(), value: c.get("value").and_then(Value::as_str).map(str::to_owned) }).collect())
                .unwrap_or_default();
            let mut out = Vec::new();
            for c in checks {
                let actual = backend.value(pid, &c.reference)?;
                out.push(json!(matches!((&c.value, &actual), (Some(e), Some(a)) if e == a)));
            }
            Ok(Value::Array(out))
        }
        "press" => {
            let pid = pid_param(req)?;
            backend.press(pid, need_ref(req)?)?;
            Ok(json!(true))
        }
        "click" => {
            let pid = pid_param(req)?;
            let (x, y) = (num_param(req, "x").unwrap_or(0.0), num_param(req, "y").unwrap_or(0.0));
            backend.click(pid, x, y, title)?;
            Ok(json!(true))
        }
        "setText" => {
            let pid = pid_param(req)?;
            backend.set_text(pid, need_ref(req)?, str_param(req, "text"))?;
            Ok(json!(true))
        }
        "type" => {
            backend.type_text(pid_param(req)?, str_param(req, "text"))?;
            Ok(json!(true))
        }
        "choose" => {
            let pid = pid_param(req)?;
            let option = str_param(req, "option");
            if option.is_empty() {
                return Err(HelperError::new("option is required"));
            }
            backend.choose(pid, need_ref(req)?, option)?;
            Ok(json!(true))
        }
        "key" => {
            let pid = pid_param(req)?;
            let combo = parse_combo(str_param(req, "combo"))?;
            backend.key(pid, &combo)?;
            Ok(json!(true))
        }
        "scroll" => {
            let pid = pid_param(req)?;
            let r = str_param(req, "ref");
            if !r.is_empty() {
                ref_index(r)?;
            }
            let dy = req.get("dy").and_then(Value::as_i64).unwrap_or(600).clamp(-100_000, 100_000);
            backend.scroll(pid, r, dy)?;
            Ok(json!(true))
        }
        "screenshot" => {
            use base64::Engine;
            let shot = backend.screenshot(pid_param(req)?, title)?;
            Ok(json!({"base64": base64::engine::general_purpose::STANDARD.encode(&shot.jpeg), "width": shot.width, "height": shot.height, "mime": "image/jpeg"}))
        }
        "open" => {
            let what = str_param(req, "what").trim();
            if what.is_empty() {
                return Err(HelperError::new("app or url is required"));
            }
            backend.open(what)?;
            Ok(json!(true))
        }
        other => Err(HelperError::new(format!("Unknown command {other}"))),
    }
}

/// One request line in, one reply line out; lines that are not JSON objects get no reply (as on macOS).
pub fn handle_line(backend: &mut dyn Backend, line: &str) -> Option<String> {
    let req: Value = serde_json::from_str(line).ok()?;
    if !req.is_object() {
        return None;
    }
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let reply = match handle(backend, &req) {
        Ok(result) => json!({"id": id, "ok": true, "result": result}),
        Err(HelperError(e)) => json!({"id": id, "ok": false, "error": e}),
    };
    Some(reply.to_string())
}
