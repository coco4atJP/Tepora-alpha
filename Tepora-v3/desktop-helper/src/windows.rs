//! Windows backend: UI Automation for the control tree and patterns, SendInput for mouse and keyboard,
//! PrintWindow for window pictures. The process is per-monitor DPI aware, so UIA rectangles, cursor positions
//! and window bounds are all physical pixels; observations report logical points (pixels / (DPI / 96)).
#![allow(non_upper_case_globals)]
use crate::contract::{Contract, Platform};
use crate::keys::{parse_combo, Combo};
use crate::win_map::{combo_inputs, control_type_name, text_units, uia_role, TypeUnit};
use crate::protocol::{element, observation, to_screen, Backend, HelperError, Node, Rect, Result, Shot, Snapshots, TextLines, WindowInfo};
use serde_json::{json, Value};
use std::time::Duration;
use windows::core::{BOOL, BSTR, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::System::Variant::{VariantClear, VARIANT, VT_BOOL, VT_BSTR, VT_I4, VT_R8};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::HiDpi::{GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::*;

struct Var(VARIANT);
impl Drop for Var {
    fn drop(&mut self) {
        unsafe {
            let _ = VariantClear(&mut self.0);
        }
    }
}
impl Var {
    fn bool(&self) -> Option<bool> {
        unsafe {
            let a = &self.0.Anonymous.Anonymous;
            (a.vt == VT_BOOL).then(|| a.Anonymous.boolVal.as_bool())
        }
    }
    fn i32(&self) -> Option<i32> {
        unsafe {
            let a = &self.0.Anonymous.Anonymous;
            (a.vt == VT_I4).then(|| a.Anonymous.lVal)
        }
    }
    fn f64(&self) -> Option<f64> {
        unsafe {
            let a = &self.0.Anonymous.Anonymous;
            (a.vt == VT_R8).then(|| a.Anonymous.dblVal)
        }
    }
    fn string(&self) -> Option<String> {
        unsafe {
            let a = &self.0.Anonymous.Anonymous;
            (a.vt == VT_BSTR).then(|| a.Anonymous.bstrVal.to_string())
        }
    }
}

fn cached(el: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<Var> {
    unsafe { el.GetCachedPropertyValue(id).ok().map(Var) }
}

#[derive(Clone)]
struct Win {
    hwnd: HWND,
    pid: u32,
    app: String,
    title: String,
}

fn window_text(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}
fn pid_of(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}
fn process_name(pid: u32) -> String {
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        if !ok {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        std::path::Path::new(&path).file_stem().and_then(|s| s.to_str()).unwrap_or("").to_owned()
    }
}
fn cloaked(hwnd: HWND) -> bool {
    let mut v = 0u32;
    unsafe { DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut v as *mut u32 as *mut _, 4).is_ok() && v != 0 }
}
fn frame_rect(hwnd: HWND) -> Option<Rect> {
    let mut r = RECT::default();
    unsafe {
        if DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as *mut _, std::mem::size_of::<RECT>() as u32).is_err() {
            GetWindowRect(hwnd, &mut r).ok()?;
        }
    }
    Some(Rect { x: r.left as f64, y: r.top as f64, w: (r.right - r.left) as f64, h: (r.bottom - r.top) as f64 })
}
fn scale_of(hwnd: HWND) -> f64 {
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 {
        1.0
    } else {
        dpi as f64 / 96.0
    }
}

unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam.0 as *mut Vec<HWND>);
    list.push(hwnd);
    BOOL(1)
}
unsafe extern "system" fn first_foreign_child(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let state = &mut *(lparam.0 as *mut (u32, u32));
    let pid = pid_of(hwnd);
    if pid != state.0 {
        state.1 = pid;
        return BOOL(0);
    }
    BOOL(1)
}

/// Visible, uncloaked, unowned top-level windows with a title. UWP apps run inside ApplicationFrameHost; the
/// app's own process is the pid of its CoreWindow child.
fn top_windows() -> Vec<Win> {
    let mut hwnds: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut hwnds as *mut _ as isize));
    }
    hwnds
        .into_iter()
        .filter_map(|h| unsafe {
            if !IsWindowVisible(h).as_bool() || cloaked(h) {
                return None;
            }
            if GetWindow(h, GW_OWNER).map(|o| !o.is_invalid()).unwrap_or(false) {
                return None;
            }
            let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
            if ex & WS_EX_TOOLWINDOW.0 != 0 {
                return None;
            }
            let title = window_text(h);
            if title.is_empty() {
                return None;
            }
            let mut pid = pid_of(h);
            let mut app = process_name(pid);
            if app.eq_ignore_ascii_case("ApplicationFrameHost") {
                let mut state = (pid, 0u32);
                let _ = EnumChildWindows(Some(h), Some(first_foreign_child), LPARAM(&mut state as *mut _ as isize));
                if state.1 != 0 {
                    pid = state.1;
                    app = process_name(pid);
                }
            }
            Some(Win { hwnd: h, pid, app, title })
        })
        .collect()
}

fn send(inputs: &[INPUT]) -> Result<()> {
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return Err(HelperError::new("Windows blocked the input (the target app may run as administrator; Tepora cannot control it unless it runs elevated too)."));
    }
    Ok(())
}
fn key_input(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
}
fn mouse_input(flags: MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
    INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
}
pub struct WindowsBackend {
    uia: Option<IUIAutomation>,
    snaps: Snapshots<IUIAutomationElement>,
    frames: std::collections::HashMap<u32, (Rect, f64)>,
}

impl WindowsBackend {
    pub fn new() -> Self {
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        WindowsBackend { uia: None, snaps: Snapshots::default(), frames: Default::default() }
    }
    fn uia(&mut self) -> Result<IUIAutomation> {
        if self.uia.is_none() {
            let u: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.map_err(|e| HelperError::new(format!("UI Automation is not available ({e}).")))?;
            self.uia = Some(u);
        }
        Ok(self.uia.clone().unwrap())
    }
    fn window(&self, pid: u32, title: &str) -> Result<Win> {
        let mine: Vec<Win> = top_windows().into_iter().filter(|w| w.pid == pid).collect();
        if !title.is_empty() {
            if let Some(w) = mine.iter().find(|w| w.title.contains(title)) {
                return Ok(w.clone());
            }
        }
        let fg = unsafe { GetForegroundWindow() };
        mine.iter().find(|w| w.hwnd == fg).or(mine.first()).cloned().ok_or_else(|| HelperError::new("The app has no open window. Open one first."))
    }
    fn activate(&self, hwnd: HWND) {
        unsafe {
            if GetForegroundWindow() == hwnd {
                return;
            }
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            // Windows lets a process take the foreground right after it sent input; a lone Alt tap is harmless.
            let _ = send(&[key_input(0x12, 0, KEYBD_EVENT_FLAGS(0)), key_input(0x12, 0, KEYEVENTF_KEYUP)]);
            let _ = SetForegroundWindow(hwnd);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    fn activate_pid(&self, pid: u32) -> Result<()> {
        let w = self.window(pid, "")?;
        self.activate(w.hwnd);
        Ok(())
    }
    fn click_at(&self, x: f64, y: f64) -> Result<()> {
        unsafe { SetCursorPos(x.round() as i32, y.round() as i32)? };
        std::thread::sleep(Duration::from_millis(30));
        send(&[mouse_input(MOUSEEVENTF_LEFTDOWN, 0), mouse_input(MOUSEEVENTF_LEFTUP, 0)])
    }
    fn key_combo(&self, combo: &Combo) -> Result<()> {
        let inputs: Vec<INPUT> = combo_inputs(combo)
            .into_iter()
            .map(|(vk, ext, up)| {
                let mut f = KEYBD_EVENT_FLAGS(0);
                if ext {
                    f |= KEYEVENTF_EXTENDEDKEY;
                }
                if up {
                    f |= KEYEVENTF_KEYUP;
                }
                key_input(vk, 0, f)
            })
            .collect();
        send(&inputs)
    }
    fn type_units(&self, text: &str) -> Result<()> {
        let mut inputs = Vec::new();
        for u in text_units(text) {
            match u {
                TypeUnit::Vk(vk) => {
                    inputs.push(key_input(vk, 0, KEYBD_EVENT_FLAGS(0)));
                    inputs.push(key_input(vk, 0, KEYEVENTF_KEYUP));
                }
                TypeUnit::Unit(u) => {
                    inputs.push(key_input(0, u, KEYEVENTF_UNICODE));
                    inputs.push(key_input(0, u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
                }
            }
        }
        for chunk in inputs.chunks(64) {
            send(chunk)?;
        }
        Ok(())
    }
    fn center(el: &IUIAutomationElement) -> Result<(f64, f64)> {
        let r = unsafe { el.CurrentBoundingRectangle()? };
        if r.right <= r.left || r.bottom <= r.top {
            return Err(HelperError::new("The control has no position on screen."));
        }
        Ok(((r.left + r.right) as f64 / 2.0, (r.top + r.bottom) as f64 / 2.0))
    }
    fn click_element(&self, pid: u32, el: &IUIAutomationElement) -> Result<()> {
        let (x, y) = Self::center(el)?;
        self.activate_pid(pid)?;
        self.click_at(x, y)
    }
    fn pattern<T: windows::core::Interface>(el: &IUIAutomationElement, id: UIA_PATTERN_ID) -> Option<T> {
        unsafe { el.GetCurrentPatternAs::<T>(id).ok() }
    }
    fn current_value(el: &IUIAutomationElement) -> Option<String> {
        if let Some(v) = Self::pattern::<IUIAutomationValuePattern>(el, UIA_ValuePatternId) {
            return unsafe { v.CurrentValue().ok().map(|b| b.to_string()) };
        }
        Self::pattern::<IUIAutomationRangeValuePattern>(el, UIA_RangeValuePatternId).and_then(|r| unsafe { r.CurrentValue().ok() }).map(crate::protocol::fmt_number)
    }
}

const CACHED: [UIA_PROPERTY_ID; 18] = [
    UIA_ControlTypePropertyId,
    UIA_NamePropertyId,
    UIA_BoundingRectanglePropertyId,
    UIA_IsEnabledPropertyId,
    UIA_HasKeyboardFocusPropertyId,
    UIA_IsPasswordPropertyId,
    UIA_IsInvokePatternAvailablePropertyId,
    UIA_IsValuePatternAvailablePropertyId,
    UIA_ValueValuePropertyId,
    UIA_ValueIsReadOnlyPropertyId,
    UIA_IsTogglePatternAvailablePropertyId,
    UIA_ToggleToggleStatePropertyId,
    UIA_IsExpandCollapsePatternAvailablePropertyId,
    UIA_ExpandCollapseExpandCollapseStatePropertyId,
    UIA_IsSelectionItemPatternAvailablePropertyId,
    UIA_SelectionItemIsSelectedPropertyId,
    UIA_RangeValueValuePropertyId,
    UIA_HelpTextPropertyId,
];

impl Backend for WindowsBackend {
    fn status(&mut self) -> Value {
        let ok = self.uia().is_ok();
        json!({"backend": "windows", "accessibility": ok, "input": true, "capture": true, "needsPortal": false})
    }
    fn windows(&mut self) -> Result<Vec<WindowInfo>> {
        let fg = unsafe { GetForegroundWindow() };
        Ok(top_windows().into_iter().map(|w| WindowInfo { pid: w.pid, app: w.app, title: w.title, window_id: w.hwnd.0 as usize as u64, active: w.hwnd == fg }).collect())
    }
    fn observe(&mut self, pid: u32, title: &str, max: usize) -> Result<Value> {
        let uia = self.uia()?;
        let win = self.window(pid, title)?;
        let contract = Contract::get();
        let wf = frame_rect(win.hwnd).ok_or_else(|| HelperError::new("The window has no frame."))?;
        let scale = scale_of(win.hwnd);
        let (mut items, mut refs, mut text) = (Vec::new(), Vec::new(), TextLines::default());
        let visited;
        unsafe {
            let root = uia.ElementFromHandle(win.hwnd)?;
            let cache = uia.CreateCacheRequest()?;
            for id in CACHED {
                cache.AddProperty(id)?;
            }
            let cond = uia.ControlViewCondition()?;
            let all = root.FindAllBuildCache(TreeScope_Descendants, &cond, &cache)?;
            let n = all.Length()?.max(0) as usize;
            visited = n.min(max);
            for i in 0..visited {
                let Ok(el) = all.GetElement(i as i32) else { continue };
                let control = control_type_name(el.CachedControlType().map(|c| c.0).unwrap_or(0));
                let name = el.CachedName().map(|b| b.to_string()).unwrap_or_default();
                if contract.is_text(Platform::Uia, control) {
                    text.push(&name);
                }
                let flag = |id| cached(&el, id).and_then(|v| v.bool()).unwrap_or(false);
                let pressable = flag(UIA_IsInvokePatternAvailablePropertyId);
                let has_value = flag(UIA_IsValuePatternAvailablePropertyId);
                let writable = has_value && !flag(UIA_ValueIsReadOnlyPropertyId);
                let Some(role) = uia_role(contract, control, pressable, flag(UIA_IsPasswordPropertyId), writable) else { continue };
                let r = el.CachedBoundingRectangle().unwrap_or_default();
                let frame = Rect { x: r.left as f64, y: r.top as f64, w: (r.right - r.left) as f64, h: (r.bottom - r.top) as f64 };
                let value = if role == "password" {
                    None
                } else if has_value {
                    cached(&el, UIA_ValueValuePropertyId).and_then(|v| v.string())
                } else {
                    cached(&el, UIA_RangeValueValuePropertyId).and_then(|v| v.f64()).map(crate::protocol::fmt_number)
                };
                let value = if role == "password" {
                    // Never read a password; UIA does not expose it anyway. Masked as non-empty when unknown.
                    Some(String::new())
                } else {
                    value.or_else(|| (role == "combobox").then(|| name.clone()))
                };
                let node = Node {
                    checked: flag(UIA_IsTogglePatternAvailablePropertyId).then(|| cached(&el, UIA_ToggleToggleStatePropertyId).and_then(|v| v.i32()) == Some(ToggleState_On.0)),
                    selected: flag(UIA_IsSelectionItemPatternAvailablePropertyId) && flag(UIA_SelectionItemIsSelectedPropertyId),
                    disabled: !flag(UIA_IsEnabledPropertyId),
                    focused: flag(UIA_HasKeyboardFocusPropertyId),
                    expanded: if flag(UIA_IsExpandCollapsePatternAvailablePropertyId) {
                        match cached(&el, UIA_ExpandCollapseExpandCollapseStatePropertyId).and_then(|v| v.i32()) {
                            Some(s) if s == ExpandCollapseState_Expanded.0 || s == ExpandCollapseState_PartiallyExpanded.0 => Some(true),
                            Some(s) if s == ExpandCollapseState_Collapsed.0 => Some(false),
                            _ => None,
                        }
                    } else {
                        None
                    },
                    name: if name.trim().is_empty() { cached(&el, UIA_HelpTextPropertyId).and_then(|v| v.string()).unwrap_or_default() } else { name },
                    value,
                    role,
                    frame,
                };
                if let Some(item) = element(contract, refs.len(), &node, &wf, scale) {
                    items.push(item);
                    refs.push(el.clone());
                }
            }
        }
        self.snaps.replace(pid, refs);
        self.frames.insert(pid, (wf, scale));
        Ok(observation(&win.title, items, &text, &wf, visited, scale))
    }
    fn value(&mut self, pid: u32, reference: &str) -> Result<Option<String>> {
        Ok(Self::current_value(self.snaps.get(pid, reference)?))
    }
    fn press(&mut self, pid: u32, reference: &str) -> Result<()> {
        let el = self.snaps.get(pid, reference)?.clone();
        unsafe {
            if let Some(p) = Self::pattern::<IUIAutomationInvokePattern>(&el, UIA_InvokePatternId) {
                if p.Invoke().is_ok() {
                    return Ok(());
                }
            }
            if let Some(p) = Self::pattern::<IUIAutomationTogglePattern>(&el, UIA_TogglePatternId) {
                if p.Toggle().is_ok() {
                    return Ok(());
                }
            }
            if let Some(p) = Self::pattern::<IUIAutomationSelectionItemPattern>(&el, UIA_SelectionItemPatternId) {
                if p.Select().is_ok() {
                    return Ok(());
                }
            }
            if let Some(p) = Self::pattern::<IUIAutomationExpandCollapsePattern>(&el, UIA_ExpandCollapsePatternId) {
                let expanded = p.CurrentExpandCollapseState().map(|s| s == ExpandCollapseState_Expanded).unwrap_or(false);
                if (if expanded { p.Collapse() } else { p.Expand() }).is_ok() {
                    return Ok(());
                }
            }
        }
        self.click_element(pid, &el)
    }
    fn click(&mut self, pid: u32, x: f64, y: f64, title: &str) -> Result<()> {
        let win = self.window(pid, title)?;
        let wf = frame_rect(win.hwnd).or_else(|| self.frames.get(&pid).map(|f| f.0)).ok_or_else(|| HelperError::new("The window has no frame."))?;
        let (sx, sy) = to_screen(&wf, scale_of(win.hwnd), x, y);
        self.activate(win.hwnd);
        self.click_at(sx, sy)
    }
    fn set_text(&mut self, pid: u32, reference: &str, text: &str) -> Result<()> {
        let el = self.snaps.get(pid, reference)?.clone();
        unsafe {
            let _ = el.SetFocus();
            if let Some(p) = Self::pattern::<IUIAutomationValuePattern>(&el, UIA_ValuePatternId) {
                if p.SetValue(&BSTR::from(text)).is_ok() && p.CurrentValue().map(|v| v.to_string() == text).unwrap_or(false) {
                    return Ok(());
                }
            }
        }
        // Fields that do not take a value directly get it typed, after selecting what is there.
        self.activate_pid(pid)?;
        unsafe {
            let _ = el.SetFocus();
        }
        self.key_combo(&parse_combo("Control+a")?)?;
        self.type_units(text)
    }
    fn type_text(&mut self, pid: u32, text: &str) -> Result<()> {
        self.activate_pid(pid)?;
        self.type_units(text)
    }
    fn choose(&mut self, pid: u32, reference: &str, option: &str) -> Result<()> {
        let el = self.snaps.get(pid, reference)?.clone();
        let uia = self.uia()?;
        unsafe {
            let ec = Self::pattern::<IUIAutomationExpandCollapsePattern>(&el, UIA_ExpandCollapsePatternId);
            match &ec {
                Some(p) => {
                    let _ = p.Expand();
                }
                None => {
                    if let Some(p) = Self::pattern::<IUIAutomationInvokePattern>(&el, UIA_InvokePatternId) {
                        let _ = p.Invoke();
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(300));
            let cond = uia.CreatePropertyCondition(UIA_NamePropertyId, &VARIANT::from(BSTR::from(option)))?;
            let found = el.FindFirst(TreeScope_Descendants, &cond).ok();
            if let Some(item) = found {
                if let Some(p) = Self::pattern::<IUIAutomationSelectionItemPattern>(&item, UIA_SelectionItemPatternId) {
                    if p.Select().is_ok() {
                        if let Some(p) = &ec {
                            let _ = p.Collapse();
                        }
                        return Ok(());
                    }
                }
                if let Some(p) = Self::pattern::<IUIAutomationInvokePattern>(&item, UIA_InvokePatternId) {
                    if p.Invoke().is_ok() {
                        return Ok(());
                    }
                }
                return self.click_element(pid, &item);
            }
            if let Some(p) = &ec {
                let _ = p.Collapse();
            }
        }
        Err(HelperError::new(format!("No option \"{option}\" in {reference}.")))
    }
    fn key(&mut self, pid: u32, combo: &Combo) -> Result<()> {
        self.activate_pid(pid)?;
        self.key_combo(combo)
    }
    fn scroll(&mut self, pid: u32, reference: &str, dy: i64, dx: i64) -> Result<()> {
        let at = if reference.is_empty() { None } else { Some(self.snaps.get(pid, reference)?.clone()) };
        let win = self.window(pid, "")?;
        let (x, y) = match at.as_ref().map(Self::center) {
            Some(Ok(p)) => p,
            _ => frame_rect(win.hwnd).map(|r| r.mid()).ok_or_else(|| HelperError::new("The window has no frame."))?,
        };
        self.activate(win.hwnd);
        unsafe { SetCursorPos(x.round() as i32, y.round() as i32)? };
        // One wheel notch (120) scrolls about 100 px in most apps; negative dy scrolls up, positive dx right.
        let notch = |d: i64| (d as f64 * 1.2).round().clamp(-12000.0, 12000.0) as i32;
        let mut inputs = Vec::new();
        if dy != 0 {
            inputs.push(mouse_input(MOUSEEVENTF_WHEEL, notch(-dy)));
        }
        if dx != 0 {
            inputs.push(mouse_input(MOUSEEVENTF_HWHEEL, notch(dx)));
        }
        send(&inputs)
    }
    fn drag(&mut self, pid: u32, from: (f64, f64), to: (f64, f64), title: &str) -> Result<()> {
        let win = self.window(pid, title)?;
        let wf = frame_rect(win.hwnd).or_else(|| self.frames.get(&pid).map(|f| f.0)).ok_or_else(|| HelperError::new("The window has no frame."))?;
        let scale = scale_of(win.hwnd);
        let ((ax, ay), (bx, by)) = (to_screen(&wf, scale, from.0, from.1), to_screen(&wf, scale, to.0, to.1));
        self.activate(win.hwnd);
        unsafe { SetCursorPos(ax.round() as i32, ay.round() as i32)? };
        std::thread::sleep(Duration::from_millis(30));
        send(&[mouse_input(MOUSEEVENTF_LEFTDOWN, 0)])?;
        for i in 1..=5 {
            let t = i as f64 / 5.0;
            unsafe { SetCursorPos((ax + (bx - ax) * t).round() as i32, (ay + (by - ay) * t).round() as i32)? };
            std::thread::sleep(Duration::from_millis(20));
        }
        send(&[mouse_input(MOUSEEVENTF_LEFTUP, 0)])
    }
    fn screenshot(&mut self, pid: u32, title: &str) -> Result<Shot> {
        let win = self.window(pid, title)?;
        let scale = scale_of(win.hwnd);
        let mut wr = RECT::default();
        unsafe { GetWindowRect(win.hwnd, &mut wr)? };
        let frame = frame_rect(win.hwnd).unwrap_or(Rect { x: wr.left as f64, y: wr.top as f64, w: (wr.right - wr.left) as f64, h: (wr.bottom - wr.top) as f64 });
        let (ww, wh) = ((wr.right - wr.left).max(1), (wr.bottom - wr.top).max(1));
        unsafe {
            let screen = GetDC(None);
            let mem = CreateCompatibleDC(Some(screen));
            let mut info = BITMAPINFO::default();
            info.bmiHeader = BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: ww, biHeight: -wh, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() };
            let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
            let bmp = CreateDIBSection(Some(mem), &info, DIB_RGB_COLORS, &mut bits, None, 0);
            let result = match bmp {
                Ok(bmp) => {
                    let old = SelectObject(mem, bmp.into());
                    // PW_RENDERFULLCONTENT (2) captures DirectComposition content too (browsers, UWP).
                    let ok = PrintWindow(win.hwnd, mem, PRINT_WINDOW_FLAGS(2)).as_bool();
                    let out = if ok && !bits.is_null() {
                        let data = std::slice::from_raw_parts(bits as *const u8, ww as usize * wh as usize * 4);
                        // Crop to the visible frame (GetWindowRect includes the invisible resize borders).
                        let (ox, oy) = (((frame.x as i32) - wr.left).clamp(0, ww - 1) as usize, ((frame.y as i32) - wr.top).clamp(0, wh - 1) as usize);
                        let (cw, ch) = ((frame.w as usize).min(ww as usize - ox).max(1), (frame.h as usize).min(wh as usize - oy).max(1));
                        let start = (oy * ww as usize + ox) * 4;
                        crate::image::jpeg(&crate::image::Pixels { data: &data[start..], width: cw as u32, height: ch as u32, stride: ww as usize * 4 }, scale)
                    } else {
                        Err(HelperError::new("The screenshot failed (PrintWindow)."))
                    };
                    SelectObject(mem, old);
                    let _ = DeleteObject(bmp.into());
                    out
                }
                Err(e) => Err(HelperError::new(format!("The screenshot failed ({e})."))),
            };
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            result
        }
    }
    fn open(&mut self, what: &str) -> Result<()> {
        let lower = what.to_ascii_lowercase();
        if what.contains("://") && !(lower.starts_with("http://") || lower.starts_with("https://")) {
            return Err(HelperError::new("Only http and https URLs can be opened."));
        }
        let wide: Vec<u16> = what.encode_utf16().chain(Some(0)).collect();
        let verb: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let r = unsafe { ShellExecuteW(None, PCWSTR(verb.as_ptr()), PCWSTR(wide.as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
        if (r.0 as isize) <= 32 {
            return Err(HelperError::new(format!("Windows could not open \"{what}\".")));
        }
        Ok(())
    }
}
