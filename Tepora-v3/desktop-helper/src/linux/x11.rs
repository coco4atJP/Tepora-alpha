//! X11 side of the Linux backend: EWMH window list and activation, XTest input, and root-window capture.
use crate::keys::{Combo, Key, Modifier, Named};
use crate::protocol::{HelperError, Rect, Result, WindowInfo};
use std::time::Duration;
use x11rb::connection::{Connection as _, RequestConnection as _};
use x11rb::protocol::xproto::{self, Atom, AtomEnum, ClientMessageEvent, ConfigureWindowAux, ConnectionExt as _, EventMask, ImageFormat, InputFocus, MapState, StackMode, Window};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

/// Keysym of a typed character: Latin-1 maps directly, everything else uses the Unicode keysym range.
pub fn char_keysym(c: char) -> u32 {
    match c {
        '\n' | '\r' => 0xff0d,
        '\t' => 0xff09,
        '\u{8}' => 0xff08,
        c if (' '..='~').contains(&c) || ('\u{a0}'..='\u{ff}').contains(&c) => c as u32,
        c => 0x0100_0000 | c as u32,
    }
}

pub fn key_keysym(key: Key) -> u32 {
    match key {
        Key::Char(c) => c as u32,
        Key::Named(n) => match n {
            Named::Enter => 0xff0d,
            Named::Tab => 0xff09,
            Named::Space => 0x20,
            Named::Backspace => 0xff08,
            Named::Escape => 0xff1b,
            Named::Delete => 0xffff,
            Named::Home => 0xff50,
            Named::End => 0xff57,
            Named::PageUp => 0xff55,
            Named::PageDown => 0xff56,
            Named::Left => 0xff51,
            Named::Up => 0xff52,
            Named::Right => 0xff53,
            Named::Down => 0xff54,
            Named::F(n) => 0xffbd + n as u32,
        },
    }
}

pub fn modifier_keysym(m: Modifier) -> u32 {
    match m {
        Modifier::Control => 0xffe3,
        Modifier::Shift => 0xffe1,
        Modifier::Alt => 0xffe9,
        Modifier::Meta => 0xffeb,
    }
}

/// The server's keycode → keysym table.
pub struct Keymap {
    pub min: u8,
    pub per: usize,
    pub syms: Vec<u32>,
}
impl Keymap {
    /// The keycode and shift level (0 or 1) that produce a keysym without other modifiers.
    pub fn find(&self, sym: u32) -> Option<(u8, usize)> {
        if self.per == 0 {
            return None;
        }
        for level in 0..self.per.min(2) {
            for (i, chunk) in self.syms.chunks(self.per).enumerate() {
                if chunk[level] == sym {
                    return Some((self.min.wrapping_add(i as u8), level));
                }
            }
        }
        None
    }
    /// An unused keycode to borrow for characters the layout cannot type, from the top of the table.
    pub fn scratch(&self) -> Option<u8> {
        if self.per == 0 {
            return None;
        }
        self.syms.chunks(self.per).enumerate().rev().find(|(_, c)| c.iter().all(|s| *s == 0)).map(|(i, _)| self.min.wrapping_add(i as u8))
    }
}

struct Atoms {
    client_list: Atom,
    wm_pid: Atom,
    wm_name: Atom,
    utf8: Atom,
    active: Atom,
    supported: Atom,
}

pub struct X11 {
    conn: RustConnection,
    root: Window,
    pub screen: Rect,
    atoms: Atoms,
    pub xtest: bool,
    depth_ok: bool,
}

const KEY_PRESS: u8 = xproto::KEY_PRESS_EVENT;
const KEY_RELEASE: u8 = xproto::KEY_RELEASE_EVENT;
const BUTTON_PRESS: u8 = xproto::BUTTON_PRESS_EVENT;
const BUTTON_RELEASE: u8 = xproto::BUTTON_RELEASE_EVENT;
const MOTION: u8 = xproto::MOTION_NOTIFY_EVENT;

impl X11 {
    pub fn connect() -> Result<X11> {
        let (conn, n) = RustConnection::connect(None).map_err(|e| HelperError::new(format!("Cannot connect to the X11 display ({e}).")))?;
        let setup = conn.setup();
        let screen = &setup.roots[n];
        let root = screen.root;
        let rect = Rect { x: 0.0, y: 0.0, w: screen.width_in_pixels as f64, h: screen.height_in_pixels as f64 };
        let depth_ok = setup.pixmap_formats.iter().any(|f| f.depth == screen.root_depth && f.bits_per_pixel == 32)
            && setup.image_byte_order == xproto::ImageOrder::LSB_FIRST
            && (screen.root_depth == 24 || screen.root_depth == 32);
        let atom = |name: &str| -> Result<Atom> { Ok(conn.intern_atom(false, name.as_bytes())?.reply()?.atom) };
        let atoms = Atoms {
            client_list: atom("_NET_CLIENT_LIST")?,
            wm_pid: atom("_NET_WM_PID")?,
            wm_name: atom("_NET_WM_NAME")?,
            utf8: atom("UTF8_STRING")?,
            active: atom("_NET_ACTIVE_WINDOW")?,
            supported: atom("_NET_SUPPORTED")?,
        };
        let xtest = conn.extension_information(x11rb::protocol::xtest::X11_EXTENSION_NAME)?.is_some();
        Ok(X11 { conn, root, screen: rect, atoms, xtest, depth_ok })
    }

    fn prop32(&self, w: Window, prop: Atom, ty: impl Into<Atom>) -> Vec<u32> {
        self.conn
            .get_property(false, w, prop, ty.into(), 0, 4096)
            .ok()
            .and_then(|c| c.reply().ok())
            .and_then(|r| r.value32().map(|v| v.collect()))
            .unwrap_or_default()
    }
    fn prop_bytes(&self, w: Window, prop: impl Into<Atom>, ty: impl Into<Atom>) -> Vec<u8> {
        self.conn.get_property(false, w, prop.into(), ty.into(), 0, 4096).ok().and_then(|c| c.reply().ok()).map(|r| r.value).unwrap_or_default()
    }
    pub fn pid(&self, w: Window) -> Option<u32> {
        self.prop32(w, self.atoms.wm_pid, AtomEnum::CARDINAL).first().copied()
    }
    pub fn title(&self, w: Window) -> String {
        let utf = self.prop_bytes(w, self.atoms.wm_name, self.atoms.utf8);
        let raw = if utf.is_empty() { self.prop_bytes(w, AtomEnum::WM_NAME, AtomEnum::STRING) } else { utf };
        String::from_utf8_lossy(&raw).into_owned()
    }
    pub fn class(&self, w: Window) -> String {
        let raw = self.prop_bytes(w, AtomEnum::WM_CLASS, AtomEnum::STRING);
        let parts: Vec<&[u8]> = raw.split(|b| *b == 0).filter(|p| !p.is_empty()).collect();
        parts.last().map(|p| String::from_utf8_lossy(p).into_owned()).unwrap_or_default()
    }
    fn has_wm(&self) -> bool {
        !self.prop32(self.root, self.atoms.supported, AtomEnum::ATOM).is_empty()
    }
    pub fn active(&self) -> Option<Window> {
        self.prop32(self.root, self.atoms.active, AtomEnum::WINDOW).first().copied().filter(|w| *w != 0)
    }
    /// Top-level app windows: the window manager's client list, or mapped root children that carry a pid
    /// when no EWMH window manager runs.
    pub fn clients(&self) -> Vec<Window> {
        let list = self.prop32(self.root, self.atoms.client_list, AtomEnum::WINDOW);
        if !list.is_empty() {
            return list;
        }
        let Ok(tree) = self.conn.query_tree(self.root).map_err(HelperError::from).and_then(|c| c.reply().map_err(HelperError::from)) else { return vec![] };
        tree.children
            .into_iter()
            .filter(|w| {
                self.conn.get_window_attributes(*w).ok().and_then(|c| c.reply().ok()).map(|a| a.map_state == MapState::VIEWABLE).unwrap_or(false)
                    && self.pid(*w).is_some()
            })
            .collect()
    }
    pub fn windows(&self) -> Vec<WindowInfo> {
        let active = self.active();
        self.clients()
            .into_iter()
            .filter_map(|w| {
                let pid = self.pid(w)?;
                let app = Some(self.class(w)).filter(|c| !c.is_empty()).unwrap_or_else(|| proc_name(pid));
                Some(WindowInfo { pid, app, title: self.title(w), window_id: w as u64, active: active == Some(w) })
            })
            .collect()
    }
    /// The top-level window of a process, preferring one whose title contains `title`.
    pub fn window_of(&self, pid: u32, title: &str) -> Option<Window> {
        let mine: Vec<Window> = self.clients().into_iter().filter(|w| self.pid(*w) == Some(pid)).collect();
        if !title.is_empty() {
            if let Some(w) = mine.iter().find(|w| self.title(**w).contains(title)) {
                return Some(*w);
            }
        }
        let active = self.active();
        mine.iter().find(|w| Some(**w) == active).or(mine.first()).copied()
    }
    pub fn geometry(&self, w: Window) -> Option<Rect> {
        let g = self.conn.get_geometry(w).ok()?.reply().ok()?;
        let t = self.conn.translate_coordinates(w, self.root, 0, 0).ok()?.reply().ok()?;
        Some(Rect { x: t.dst_x as f64, y: t.dst_y as f64, w: g.width as f64, h: g.height as f64 })
    }
    /// Raise and focus a window: through the window manager when there is one, directly otherwise.
    pub fn activate(&self, w: Window) {
        if self.has_wm() {
            let ev = ClientMessageEvent::new(32, w, self.atoms.active, [2u32, 0, 0, 0, 0]);
            let _ = self.conn.send_event(false, self.root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, ev);
        } else {
            let _ = self.conn.configure_window(w, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE));
            let _ = self.conn.set_input_focus(InputFocus::PARENT, w, x11rb::CURRENT_TIME);
        }
        let _ = self.conn.sync();
        std::thread::sleep(Duration::from_millis(200));
    }
    fn need_xtest(&self) -> Result<()> {
        if self.xtest {
            Ok(())
        } else {
            Err(HelperError::new("The X server has no XTest extension, so Tepora cannot send input."))
        }
    }
    fn fake(&self, kind: u8, detail: u8, x: i16, y: i16) -> Result<()> {
        self.conn.xtest_fake_input(kind, detail, x11rb::CURRENT_TIME, self.root, x, y, 0)?;
        Ok(())
    }
    fn clamp_point(&self, x: f64, y: f64) -> (i16, i16) {
        (x.round().clamp(0.0, (self.screen.w - 1.0).max(0.0)) as i16, y.round().clamp(0.0, (self.screen.h - 1.0).max(0.0)) as i16)
    }
    pub fn click(&self, x: f64, y: f64) -> Result<()> {
        self.need_xtest()?;
        let (x, y) = self.clamp_point(x, y);
        self.fake(MOTION, 0, x, y)?;
        self.conn.sync()?;
        std::thread::sleep(Duration::from_millis(30));
        self.fake(BUTTON_PRESS, 1, 0, 0)?;
        self.fake(BUTTON_RELEASE, 1, 0, 0)?;
        self.conn.sync()?;
        Ok(())
    }
    /// Wheel notches at a point: button 4 up, 5 down, about 120 px per notch.
    pub fn wheel(&self, x: f64, y: f64, dy: i64) -> Result<()> {
        self.need_xtest()?;
        let (x, y) = self.clamp_point(x, y);
        self.fake(MOTION, 0, x, y)?;
        let button = if dy < 0 { 4 } else { 5 };
        for _ in 0..wheel_notches(dy) {
            self.fake(BUTTON_PRESS, button, 0, 0)?;
            self.fake(BUTTON_RELEASE, button, 0, 0)?;
        }
        self.conn.sync()?;
        Ok(())
    }
    fn keymap(&self) -> Result<Keymap> {
        let setup = self.conn.setup();
        let (min, max) = (setup.min_keycode, setup.max_keycode);
        let r = self.conn.get_keyboard_mapping(min, max - min + 1)?.reply()?;
        Ok(Keymap { min, per: r.keysyms_per_keycode as usize, syms: r.keysyms })
    }
    fn code_for(&self, map: &Keymap, sym: u32) -> Result<u8> {
        map.find(sym).map(|(c, _)| c).ok_or_else(|| HelperError::new(format!("The keyboard layout has no key for keysym 0x{sym:x}.")))
    }
    pub fn key(&self, combo: &Combo) -> Result<()> {
        self.need_xtest()?;
        let map = self.keymap()?;
        let mods: Vec<u8> = combo.modifiers.iter().map(|m| self.code_for(&map, modifier_keysym(*m))).collect::<Result<_>>()?;
        let code = self.code_for(&map, key_keysym(combo.key))?;
        for m in &mods {
            self.fake(KEY_PRESS, *m, 0, 0)?;
        }
        self.fake(KEY_PRESS, code, 0, 0)?;
        self.fake(KEY_RELEASE, code, 0, 0)?;
        for m in mods.iter().rev() {
            self.fake(KEY_RELEASE, *m, 0, 0)?;
        }
        self.conn.sync()?;
        Ok(())
    }
    /// Types text with XTest. Characters the layout lacks are typed through a borrowed spare keycode.
    pub fn type_text(&self, text: &str) -> Result<()> {
        self.need_xtest()?;
        let map = self.keymap()?;
        let shift = self.code_for(&map, 0xffe1).ok();
        let scratch = map.scratch();
        let mut remapped = false;
        for c in text.chars() {
            let sym = char_keysym(c);
            match map.find(sym) {
                Some((code, level)) if level == 0 || shift.is_some() => {
                    if level == 1 {
                        self.fake(KEY_PRESS, shift.unwrap_or(0), 0, 0)?;
                    }
                    self.fake(KEY_PRESS, code, 0, 0)?;
                    self.fake(KEY_RELEASE, code, 0, 0)?;
                    if level == 1 {
                        self.fake(KEY_RELEASE, shift.unwrap_or(0), 0, 0)?;
                    }
                }
                _ => {
                    let code = scratch.ok_or_else(|| HelperError::new("The keyboard has no spare key to type this character."))?;
                    let syms = vec![sym; map.per.max(1)];
                    self.conn.change_keyboard_mapping(1, code, map.per.max(1) as u8, &syms)?;
                    self.conn.sync()?;
                    std::thread::sleep(Duration::from_millis(40));
                    self.fake(KEY_PRESS, code, 0, 0)?;
                    self.fake(KEY_RELEASE, code, 0, 0)?;
                    self.conn.sync()?;
                    std::thread::sleep(Duration::from_millis(20));
                    remapped = true;
                }
            }
        }
        self.conn.sync()?;
        if let (true, Some(code)) = (remapped, scratch) {
            std::thread::sleep(Duration::from_millis(40));
            let none = vec![0u32; map.per.max(1)];
            self.conn.change_keyboard_mapping(1, code, map.per.max(1) as u8, &none)?;
            self.conn.sync()?;
        }
        Ok(())
    }
    /// What is on screen inside a rectangle, as BGRX rows (clipped to the screen).
    pub fn capture(&self, r: &Rect) -> Result<(Vec<u8>, u32, u32)> {
        if !self.depth_ok {
            return Err(HelperError::new("This X server's pixel format is not supported for screenshots."));
        }
        let x0 = r.x.max(0.0).floor();
        let y0 = r.y.max(0.0).floor();
        let x1 = (r.x + r.w).min(self.screen.w).ceil();
        let y1 = (r.y + r.h).min(self.screen.h).ceil();
        if x1 - x0 < 1.0 || y1 - y0 < 1.0 {
            return Err(HelperError::new("The window is not on screen."));
        }
        let (w, h) = ((x1 - x0) as u16, (y1 - y0) as u16);
        let img = self.conn.get_image(ImageFormat::Z_PIXMAP, self.root, x0 as i16, y0 as i16, w, h, !0)?.reply()?;
        Ok((img.data, w as u32, h as u32))
    }
}

pub fn wheel_notches(dy: i64) -> u32 {
    ((dy.unsigned_abs() as f64 / 120.0).round() as u32).clamp(1, 50)
}

pub fn proc_name(pid: u32) -> String {
    std::fs::read_to_string(format!("/proc/{pid}/comm")).map(|s| s.trim().to_owned()).unwrap_or_default()
}
