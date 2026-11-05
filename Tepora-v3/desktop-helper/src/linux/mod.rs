//! Linux X11 backend: AT-SPI2 for the accessibility tree and actions, XTest for input, EWMH for windows.
//! Wayland sessions are reported unsupported (they need the desktop portals, a later phase).
pub mod apps;
pub mod atspi;
pub mod x11;

use crate::contract::{Contract, Platform};
use crate::keys::{parse_combo, Combo};
use crate::protocol::{element, fmt_number, observation, to_screen, Backend, HelperError, Node, Rect, Result, Shot, Snapshots, TextLines, WindowInfo};
use atspi::{press_action, state, Atspi, Obj};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::time::Duration;
use x11::X11;

/// Why this session cannot be driven, if it cannot: Wayland, or no X display at all.
pub fn session_problem(session_type: Option<&str>, wayland_display: Option<&str>, display: Option<&str>) -> Option<&'static str> {
    let has = |v: Option<&str>| v.map(|s| !s.is_empty()).unwrap_or(false);
    if session_type.map(|s| s.eq_ignore_ascii_case("wayland")).unwrap_or(false) || (has(wayland_display) && !has(display)) {
        return Some("Desktop apps cannot be operated in a Wayland session yet (it needs the desktop portals). Sign in to an X11 session (\"GNOME on Xorg\" or similar) to use them.");
    }
    if !has(display) {
        return Some("No X11 display (DISPLAY is not set), so desktop apps cannot be operated here.");
    }
    None
}

fn env_problem() -> Option<&'static str> {
    let get = |k: &str| std::env::var(k).ok();
    session_problem(get("XDG_SESSION_TYPE").as_deref(), get("WAYLAND_DISPLAY").as_deref(), get("DISPLAY").as_deref())
}

#[derive(Default)]
pub struct LinuxBackend {
    x: Option<X11>,
    a11y: Option<Atspi>,
    snaps: Snapshots<Obj>,
    frames: HashMap<u32, Rect>,
}

const CONTROL_DEPTH: usize = 40;
const WINDOW_ROLES: [&str; 4] = ["frame", "window", "dialog", "alert"];

impl LinuxBackend {
    pub fn new() -> Self {
        Self::default()
    }
    fn x(&mut self) -> Result<&X11> {
        if let Some(p) = env_problem() {
            return Err(HelperError::new(p));
        }
        if self.x.is_none() {
            self.x = Some(X11::connect()?);
        }
        Ok(self.x.as_ref().unwrap())
    }
    fn a11y(&mut self) -> Result<&Atspi> {
        if let Some(p) = env_problem() {
            return Err(HelperError::new(p));
        }
        if self.a11y.is_none() {
            self.a11y = Some(Atspi::connect().map_err(|e| {
                HelperError::new(format!("{} Accessibility must be on (GNOME: Settings → Accessibility; or set GTK_MODULES=gail:atk-bridge for older apps).", e.0))
            })?);
        }
        Ok(self.a11y.as_ref().unwrap())
    }
    /// The app's accessible window, the way the macOS helper chooses: by title, then the active one, then the first showing.
    fn app_window(&mut self, pid: u32, title: &str) -> Result<Obj> {
        let a = self.a11y()?;
        let app = a.app(pid).ok_or_else(|| HelperError::new("This app does not expose accessibility (AT-SPI). It may not support it, or it was started before accessibility was on."))?;
        let wins: Vec<(Obj, String, atspi::States)> = a
            .children(&app)
            .into_iter()
            .filter(|w| WINDOW_ROLES.contains(&a.role(w).as_str()))
            .map(|w| {
                let n = a.name(&w);
                let s = a.states(&w);
                (w, n, s)
            })
            .collect();
        if !title.is_empty() {
            if let Some((w, _, _)) = wins.iter().find(|(_, n, _)| n.contains(title)) {
                return Ok(w.clone());
            }
        }
        wins.iter()
            .find(|(_, _, s)| s.has(state::ACTIVE))
            .or_else(|| wins.iter().find(|(_, _, s)| s.has(state::SHOWING)))
            .map(|(w, _, _)| w.clone())
            .ok_or_else(|| HelperError::new("The app has no open window. Open one first."))
    }
    /// The window rectangle in screen pixels: AT-SPI's frame (what element coordinates are relative to), or the
    /// X11 window when the app has no accessibility.
    fn window_rect(&mut self, pid: u32, title: &str) -> Result<Rect> {
        let from_a11y = match self.app_window(pid, title) {
            Ok(w) => self.a11y.as_ref().and_then(|a| a.extents(&w)),
            Err(_) => None,
        };
        let rect = match from_a11y.filter(|r| r.w >= 1.0 && r.h >= 1.0) {
            Some(r) => r,
            None => {
                let x = self.x()?;
                let w = x.window_of(pid, title).ok_or_else(|| HelperError::new("The app has no open window. Open one first."))?;
                x.geometry(w).ok_or_else(|| HelperError::new("The window has no frame."))?
            }
        };
        self.frames.insert(pid, rect);
        Ok(rect)
    }
    fn activate(&mut self, pid: u32, title: &str) -> Result<()> {
        let x = self.x()?;
        if let Some(w) = x.window_of(pid, title) {
            if x.active() != Some(w) {
                x.activate(w);
            }
        }
        Ok(())
    }
    fn node_name(a: &Atspi, obj: &Obj, role: &str, raw_role: &str) -> String {
        let n = a.name(obj);
        if !n.trim().is_empty() {
            return n;
        }
        let d = a.description(obj);
        if !d.trim().is_empty() {
            return d;
        }
        if let Some(l) = a.labelled_by(obj) {
            return l;
        }
        if role == "cell" || role == "row" || raw_role == "table cell" {
            for c in a.children(obj).iter().take(8) {
                let s = a.name(c);
                if !s.trim().is_empty() {
                    return s;
                }
            }
        }
        String::new()
    }
    fn node_value(a: &Atspi, obj: &Obj, role: &str, name: &str) -> Option<String> {
        match role {
            // The password itself is never read: only whether it is empty.
            "password" => Some(if a.char_count(obj).unwrap_or(0) > 0 { "x".into() } else { String::new() }),
            "slider" => a.current_value(obj).map(fmt_number).or_else(|| a.text(obj)),
            "combobox" => a.text(obj).filter(|s| !s.is_empty()).or_else(|| Some(name.to_owned())),
            _ => a.text(obj),
        }
    }
    fn with_target<T>(&mut self, pid: u32, reference: &str, f: impl FnOnce(&Atspi, &Obj) -> Result<T>) -> Result<T> {
        let obj = self.snaps.get(pid, reference)?.clone();
        let a = self.a11y()?;
        f(a, &obj)
    }
    fn click_center(&mut self, pid: u32, obj: &Obj) -> Result<()> {
        let r = self.a11y()?.extents(obj).ok_or_else(|| HelperError::new("The control has no position on screen."))?;
        self.activate(pid, "")?;
        let (x, y) = r.mid();
        self.x()?.click(x, y)
    }
}


impl Backend for LinuxBackend {
    fn status(&mut self) -> Value {
        let problem = env_problem();
        let (accessibility, input, capture) = if problem.is_some() {
            (false, false, false)
        } else {
            let a = self.a11y().is_ok();
            let (i, c) = match self.x() {
                Ok(x) => (x.xtest, true),
                Err(_) => (false, false),
            };
            (a, i, c)
        };
        json!({"backend": "linux-x11", "accessibility": accessibility, "input": input, "capture": capture, "needsPortal": false,
            "problem": problem})
    }
    fn windows(&mut self) -> Result<Vec<WindowInfo>> {
        Ok(self.x()?.windows())
    }
    fn observe(&mut self, pid: u32, title: &str, max: usize) -> Result<Value> {
        let win = self.app_window(pid, title)?;
        let contract = Contract::get();
        let a = self.a11y.as_ref().unwrap();
        let wf = a.extents(&win).unwrap_or_default();
        let win_title = a.name(&win);
        let (mut items, mut refs, mut text, mut visited) = (Vec::new(), Vec::new(), TextLines::default(), 0usize);
        let mut queue: VecDeque<(Obj, usize)> = VecDeque::from([(win, 0)]);
        while let Some((obj, depth)) = queue.pop_front() {
            if visited >= max {
                break;
            }
            visited += 1;
            let st = a.states(&obj);
            if depth > 0 && !st.has(state::SHOWING) {
                continue;
            }
            let raw = a.role(&obj);
            if contract.is_text(Platform::Atspi, &raw) {
                let s = a.name(&obj);
                let s = if s.trim().is_empty() { a.text(&obj).unwrap_or_default() } else { s };
                text.push(&s);
            }
            // Ask for actions only when the answer can change the role (unmapped controls, images).
            let role = contract
                .role(Platform::Atspi, &raw, false)
                .or_else(|| (contract.press_matters(Platform::Atspi, &raw) && !a.actions(&obj).is_empty()).then(|| contract.role(Platform::Atspi, &raw, true)).flatten());
            if let Some(role) = role {
                if let Some(frame) = a.extents(&obj) {
                    let name = Self::node_name(a, &obj, &role, &raw);
                    let node = Node {
                        value: if contract.value_roles.contains(&role) { Self::node_value(a, &obj, &role, &name) } else { None },
                        checked: contract.toggle_roles.contains(&role).then(|| st.has(state::CHECKED) || st.has(state::PRESSED)),
                        selected: st.has(state::SELECTED),
                        disabled: !st.has(state::SENSITIVE) && !st.has(state::ENABLED),
                        focused: st.has(state::FOCUSED),
                        expanded: st.has(state::EXPANDABLE).then(|| st.has(state::EXPANDED)),
                        role,
                        name,
                        frame,
                    };
                    if let Some(item) = element(contract, refs.len(), &node, &wf, 1.0) {
                        items.push(item);
                        refs.push(obj.clone());
                    }
                }
            }
            if depth < CONTROL_DEPTH && raw != "menu bar" {
                for c in a.children(&obj) {
                    queue.push_back((c, depth + 1));
                }
            }
        }
        self.snaps.replace(pid, refs);
        self.frames.insert(pid, wf);
        Ok(observation(&win_title, items, &text, &wf, visited, 1.0))
    }
    fn value(&mut self, pid: u32, reference: &str) -> Result<Option<String>> {
        self.with_target(pid, reference, |a, o| Ok(a.text(o).or_else(|| a.current_value(o).map(fmt_number))))
    }
    fn press(&mut self, pid: u32, reference: &str) -> Result<()> {
        let obj = self.snaps.get(pid, reference)?.clone();
        let a = self.a11y()?;
        if let Some(i) = press_action(&a.actions(&obj)) {
            if a.do_action(&obj, i) {
                return Ok(());
            }
        }
        self.click_center(pid, &obj)
    }
    fn click(&mut self, pid: u32, x: f64, y: f64, title: &str) -> Result<()> {
        let wf = self.window_rect(pid, title).or_else(|e| self.frames.get(&pid).copied().ok_or(e))?;
        self.activate(pid, title)?;
        let (sx, sy) = to_screen(&wf, 1.0, x, y);
        self.x()?.click(sx, sy)
    }
    fn set_text(&mut self, pid: u32, reference: &str, text: &str) -> Result<()> {
        let obj = self.snaps.get(pid, reference)?.clone();
        let a = self.a11y()?;
        a.grab_focus(&obj);
        if a.set_text(&obj, text) && a.text(&obj).as_deref() == Some(text) {
            return Ok(());
        }
        // Fields that do not take a value directly get it typed, after selecting what is there.
        self.activate(pid, "")?;
        let x = self.x()?;
        x.key(&parse_combo("Control+a")?)?;
        x.type_text(text)
    }
    fn type_text(&mut self, pid: u32, text: &str) -> Result<()> {
        self.activate(pid, "")?;
        self.x()?.type_text(text)
    }
    fn choose(&mut self, pid: u32, reference: &str, option: &str) -> Result<()> {
        let obj = self.snaps.get(pid, reference)?.clone();
        let a = self.a11y()?;
        if let Some(i) = press_action(&a.actions(&obj)) {
            a.do_action(&obj, i);
        }
        std::thread::sleep(Duration::from_millis(300));
        let mut queue: VecDeque<Obj> = a.children(&obj).into();
        let mut seen = 0;
        while let Some(c) = queue.pop_front() {
            if seen >= 400 {
                break;
            }
            seen += 1;
            let role = a.role(&c);
            if matches!(role.as_str(), "menu item" | "check menu item" | "radio menu item" | "list item" | "table cell" | "option") && a.name(&c) == option {
                if let Some(i) = press_action(&a.actions(&c)) {
                    if a.do_action(&c, i) {
                        return Ok(());
                    }
                }
                return self.click_center(pid, &c);
            }
            queue.extend(a.children(&c));
        }
        let _ = self.key(pid, &parse_combo("Escape")?);
        Err(HelperError::new(format!("No option \"{option}\" in {reference}.")))
    }
    fn key(&mut self, pid: u32, combo: &Combo) -> Result<()> {
        self.activate(pid, "")?;
        self.x()?.key(combo)
    }
    fn scroll(&mut self, pid: u32, reference: &str, dy: i64) -> Result<()> {
        let at = if reference.is_empty() { None } else { Some(self.snaps.get(pid, reference)?.clone()) };
        let point = match at.and_then(|o| self.a11y.as_ref().and_then(|a| a.extents(&o))) {
            Some(r) => r.mid(),
            None => self.frames.get(&pid).copied().map(|r| r.mid()).unwrap_or((0.0, 0.0)),
        };
        let point = if point == (0.0, 0.0) { self.window_rect(pid, "")?.mid() } else { point };
        self.activate(pid, "")?;
        self.x()?.wheel(point.0, point.1, dy)
    }
    fn screenshot(&mut self, pid: u32, title: &str) -> Result<Shot> {
        let wf = self.window_rect(pid, title)?;
        self.activate(pid, title)?;
        let (data, w, h) = self.x()?.capture(&wf)?;
        crate::image::jpeg(&crate::image::Pixels { data: &data, width: w, height: h, stride: w as usize * 4 }, 1.0)
    }
    fn open(&mut self, what: &str) -> Result<()> {
        if let Some(p) = env_problem() {
            return Err(HelperError::new(p));
        }
        apps::open(what)
    }
}
