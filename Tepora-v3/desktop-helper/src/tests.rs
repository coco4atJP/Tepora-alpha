//! OS-independent unit tests: contract and roles, key parsing, the JSON-lines protocol against a fake backend,
//! element formatting, image scaling, and the pure Windows/Linux mappings.
use crate::contract::{Contract, Platform, CONTRACT_JSON};
use crate::image::{jpeg, to_rgb, Pixels};
use crate::keys::{parse_combo, Combo, Key, Modifier, Named};
use crate::protocol::*;
use crate::win_map::*;
use serde_json::{json, Value};

fn c() -> &'static Contract {
    Contract::get()
}

#[test]
fn contract_parses_and_lists_every_command() {
    let k = Contract::parse(CONTRACT_JSON).unwrap();
    for cmd in ["status", "windows", "observe", "matches", "press", "click", "setText", "type", "choose", "key", "scroll", "screenshot", "open"] {
        assert!(k.commands.iter().any(|c| c == cmd), "{cmd}");
    }
    assert!(Contract::parse("{}").is_err());
    assert!(Contract::parse("not json").is_err());
}

#[test]
fn every_table_maps_onto_known_roles() {
    let k = c();
    for (native, role) in k.mac_table() {
        assert!(k.roles.contains(role), "{native} -> {role}");
    }
    for r in k.value_roles.iter().chain(k.toggle_roles.iter()) {
        assert!(k.roles.contains(r), "{r}");
    }
}

#[test]
fn mac_table_matches_ax_helper_swift() {
    // The swift role table is the reference; the contract copy must stay identical to it.
    let swift = include_str!("../../core/computer/ax-helper.swift");
    let k = c();
    for (native, role) in k.mac_table() {
        assert!(swift.contains(&format!("\"{native}\": \"{role}\"")), "{native}: {role} not in ax-helper.swift");
    }
    assert!(swift.matches("\": \"").count() >= k.mac_table().len());
}

#[test]
fn roles_follow_the_swift_rules() {
    let k = c();
    assert_eq!(k.role(Platform::Uia, "Button", false).as_deref(), Some("button"));
    assert_eq!(k.role(Platform::Uia, "Edit", false).as_deref(), Some("textbox"));
    assert_eq!(k.role(Platform::Atspi, "push button", false).as_deref(), Some("button"));
    assert_eq!(k.role(Platform::Atspi, "password text", false).as_deref(), Some("password"));
    assert_eq!(k.role(Platform::Atspi, "spin button", false).as_deref(), Some("slider"));
    // Images only count when they can be pressed.
    assert_eq!(k.role(Platform::Uia, "Image", false), None);
    assert_eq!(k.role(Platform::Uia, "Image", true).as_deref(), Some("image"));
    assert_eq!(k.role(Platform::Atspi, "icon", true).as_deref(), Some("image"));
    // Unknown but pressable becomes a button, except text, groups and windows.
    assert_eq!(k.role(Platform::Uia, "Custom", true).as_deref(), Some("button"));
    assert_eq!(k.role(Platform::Uia, "Custom", false), None);
    assert_eq!(k.role(Platform::Uia, "Text", true), None);
    assert_eq!(k.role(Platform::Uia, "Group", true), None);
    assert_eq!(k.role(Platform::Atspi, "label", true), None);
    assert_eq!(k.role(Platform::Atspi, "frame", true), None);
    assert_eq!(k.role(Platform::Atspi, "unknown", true).as_deref(), Some("button"));
    assert!(!k.press_matters(Platform::Atspi, "label"));
    assert!(k.press_matters(Platform::Atspi, "unknown"));
    assert!(k.is_text(Platform::Uia, "Text"));
    assert!(k.is_text(Platform::Atspi, "heading"));
    assert!(!k.is_text(Platform::Atspi, "push button"));
}

#[test]
fn uia_roles_cover_passwords_and_documents() {
    let k = c();
    assert_eq!(uia_role(k, "Edit", false, true, true).as_deref(), Some("password"));
    assert_eq!(uia_role(k, "Edit", false, false, true).as_deref(), Some("textbox"));
    assert_eq!(uia_role(k, "Document", false, false, true).as_deref(), Some("textbox"));
    assert_eq!(uia_role(k, "Document", false, false, false), None);
    assert_eq!(control_type_name(50000), "Button");
    assert_eq!(control_type_name(50004), "Edit");
    assert_eq!(control_type_name(50030), "Document");
    assert_eq!(control_type_name(1), "");
    // Every UIA table key is a control type name the backend can produce.
    let names: Vec<&str> = (50000..=50040).map(control_type_name).collect();
    for native in ["Button", "CheckBox", "RadioButton", "ComboBox", "Edit", "Hyperlink", "MenuItem", "SplitButton", "Slider", "Spinner", "TreeItem", "ListItem", "DataItem", "TabItem", "Calendar", "HeaderItem", "Image"] {
        assert!(names.contains(&native), "{native}");
        assert!(k.role(Platform::Uia, native, true).is_some(), "{native}");
    }
}

#[test]
fn key_combos_parse() {
    assert_eq!(parse_combo("Enter").unwrap(), Combo { modifiers: vec![], key: Key::Named(Named::Enter) });
    assert_eq!(parse_combo("Mod+L").unwrap(), Combo { modifiers: vec![Modifier::Control], key: Key::Char('l') });
    assert_eq!(parse_combo("Control+Shift+Tab").unwrap().modifiers, vec![Modifier::Control, Modifier::Shift]);
    assert_eq!(parse_combo("Cmd+Option+Escape").unwrap().modifiers, vec![Modifier::Meta, Modifier::Alt]);
    assert_eq!(parse_combo("ArrowDown").unwrap().key, Key::Named(Named::Down));
    assert_eq!(parse_combo("F5").unwrap().key, Key::Named(Named::F(5)));
    assert_eq!(parse_combo("F12").unwrap().key, Key::Named(Named::F(12)));
    assert_eq!(parse_combo("Ctrl+Ctrl+a").unwrap().modifiers, vec![Modifier::Control]);
    assert_eq!(parse_combo("").unwrap_err().0, "keys is empty");
    assert_eq!(parse_combo("Hyper+a").unwrap_err().0, "Unknown modifier Hyper");
    assert_eq!(parse_combo("F13").unwrap_err().0, "Unknown key F13");
    assert_eq!(parse_combo("Control+").unwrap_err().0, "keys is empty");
    assert!(parse_combo("ab").is_err());
}

#[test]
fn windows_virtual_keys() {
    assert_eq!(vk_for(Key::Char('a')), (0x41, false));
    assert_eq!(vk_for(Key::Char('7')), (0x37, false));
    assert_eq!(vk_for(Key::Named(Named::Left)), (0x25, true));
    assert_eq!(vk_for(Key::Named(Named::F(1))), (0x70, false));
    assert_eq!(vk_for(Key::Named(Named::F(12))), (0x7B, false));
    let seq = combo_inputs(&parse_combo("Control+Shift+Home").unwrap());
    assert_eq!(seq, vec![(0x11, false, false), (0x10, false, false), (0x24, true, false), (0x24, true, true), (0x10, false, true), (0x11, false, true)]);
    assert_eq!(text_units("a\r\nü😀\t"), vec![TypeUnit::Unit(97), TypeUnit::Vk(0x0D), TypeUnit::Unit(0xFC), TypeUnit::Unit(0xD83D), TypeUnit::Unit(0xDE00), TypeUnit::Vk(0x09)]);
}

fn node(role: &str) -> Node {
    Node { role: role.into(), name: "Name".into(), frame: Rect { x: 110.0, y: 220.0, w: 40.0, h: 20.0 }, ..Default::default() }
}
const WIN: Rect = Rect { x: 100.0, y: 200.0, w: 400.0, h: 300.0 };

#[test]
fn elements_look_like_the_macos_helper() {
    let mut n = node("textbox");
    n.value = Some("hello".into());
    n.focused = true;
    let e = element(c(), 3, &n, &WIN, 1.0).unwrap();
    assert_eq!(e, json!({"ref": "a3", "role": "textbox", "name": "Name", "x": 30, "y": 30, "inView": true, "value": "hello", "focused": true}));
    // HiDPI: coordinates are logical points.
    let e = element(c(), 0, &n, &WIN, 2.0).unwrap();
    assert_eq!((e["x"].clone(), e["y"].clone()), (json!(15), json!(15)));
    assert_eq!(to_screen(&WIN, 2.0, 15.0, 15.0), (130.0, 230.0));
    // Outside the window.
    let mut far = node("button");
    far.frame.x = 2000.0;
    assert_eq!(element(c(), 0, &far, &WIN, 1.0).unwrap()["inView"], json!(false));
    // Zero-size controls are dropped.
    let mut tiny = node("button");
    tiny.frame.w = 0.0;
    assert!(element(c(), 0, &tiny, &WIN, 1.0).is_none());
}

#[test]
fn passwords_are_masked_and_long_values_truncated() {
    let mut p = node("password");
    p.value = Some("secret".into());
    let e = element(c(), 0, &p, &WIN, 1.0).unwrap();
    assert_eq!(e["value"], json!("••••"));
    assert_eq!(e["valueMasked"], json!(true));
    assert!(!e.to_string().contains("secret"));
    p.value = Some(String::new());
    assert_eq!(element(c(), 0, &p, &WIN, 1.0).unwrap()["value"], json!(""));
    let mut t = node("textbox");
    t.value = Some("x".repeat(250));
    let e = element(c(), 0, &t, &WIN, 1.0).unwrap();
    assert_eq!(e["value"].as_str().unwrap().len(), 200);
    assert_eq!(e["valueTruncated"], json!(true));
    let mut long = node("button");
    long.name = "n".repeat(300);
    assert_eq!(element(c(), 0, &long, &WIN, 1.0).unwrap()["name"].as_str().unwrap().len(), 140);
}

#[test]
fn toggles_and_flags() {
    let mut b = node("checkbox");
    b.checked = Some(true);
    b.disabled = true;
    b.expanded = Some(false);
    b.selected = true;
    let e = element(c(), 0, &b, &WIN, 1.0).unwrap();
    assert_eq!(e["checked"], json!(true));
    assert_eq!(e["disabled"], json!(true));
    assert_eq!(e["expanded"], json!(false));
    assert_eq!(e["selected"], json!(true));
    let e = element(c(), 0, &node("radio"), &WIN, 1.0).unwrap();
    assert_eq!(e["checked"], json!(false));
    let e = element(c(), 0, &node("button"), &WIN, 1.0).unwrap();
    assert!(e.get("checked").is_none() && e.get("value").is_none());
}

#[test]
fn observation_frame_and_text() {
    let mut t = TextLines::default();
    t.push("  first ");
    t.push("");
    t.push("second");
    let o = observation("Title", vec![], &t, &WIN, 7, 2.0);
    assert_eq!(o, json!({"title": "Title", "elements": [], "text": "first\nsecond", "frame": {"x": 50.0, "y": 100.0, "w": 200.0, "h": 150.0}, "visited": 7}));
    let mut big = TextLines::default();
    for _ in 0..100 {
        big.push(&"y".repeat(100));
    }
    assert!(big.join().len() < 4200);
    assert_eq!(fmt_number(3.0), "3");
    assert_eq!(fmt_number(2.5), "2.5");
}

#[derive(Default)]
struct Fake {
    calls: Vec<String>,
}
impl Backend for Fake {
    fn status(&mut self) -> Value {
        json!({"backend": "fake"})
    }
    fn windows(&mut self) -> Result<Vec<WindowInfo>> {
        Ok(vec![WindowInfo { pid: 7, app: "Calc".into(), title: "Calculator".into(), window_id: 42, active: true }])
    }
    fn observe(&mut self, pid: u32, title: &str, max: usize) -> Result<Value> {
        self.calls.push(format!("observe {pid} {title} {max}"));
        Ok(json!({"title": title}))
    }
    fn value(&mut self, _pid: u32, reference: &str) -> Result<Option<String>> {
        match reference {
            "a0" => Ok(Some("hi".into())),
            "a1" => Ok(None),
            _ => Err(HelperError::new(format!("Control {reference} is not in the latest observation. Observe again."))),
        }
    }
    fn press(&mut self, pid: u32, reference: &str) -> Result<()> {
        self.calls.push(format!("press {pid} {reference}"));
        Ok(())
    }
    fn click(&mut self, pid: u32, x: f64, y: f64, title: &str) -> Result<()> {
        self.calls.push(format!("click {pid} {x} {y} {title}"));
        Ok(())
    }
    fn set_text(&mut self, pid: u32, reference: &str, text: &str) -> Result<()> {
        self.calls.push(format!("setText {pid} {reference} {text}"));
        Ok(())
    }
    fn type_text(&mut self, pid: u32, text: &str) -> Result<()> {
        self.calls.push(format!("type {pid} {text}"));
        Ok(())
    }
    fn choose(&mut self, pid: u32, reference: &str, option: &str) -> Result<()> {
        self.calls.push(format!("choose {pid} {reference} {option}"));
        Ok(())
    }
    fn key(&mut self, pid: u32, combo: &Combo) -> Result<()> {
        self.calls.push(format!("key {pid} {:?}", combo.key));
        Ok(())
    }
    fn scroll(&mut self, pid: u32, reference: &str, dy: i64) -> Result<()> {
        self.calls.push(format!("scroll {pid} {reference} {dy}"));
        Ok(())
    }
    fn screenshot(&mut self, _pid: u32, _title: &str) -> Result<Shot> {
        Ok(Shot { jpeg: vec![0xff, 0xd8, 0xff], width: 2, height: 1 })
    }
    fn open(&mut self, what: &str) -> Result<()> {
        self.calls.push(format!("open {what}"));
        Err(HelperError::new("nope"))
    }
}

fn ask(f: &mut Fake, line: &str) -> Value {
    serde_json::from_str(&handle_line(f, line).expect("a reply")).unwrap()
}

#[test]
fn json_lines_replies_carry_the_id() {
    let mut f = Fake::default();
    assert_eq!(ask(&mut f, r#"{"id":1,"cmd":"status"}"#), json!({"id": 1, "ok": true, "result": {"backend": "fake"}}));
    assert_eq!(ask(&mut f, r#"{"id":"x","cmd":"windows"}"#)["result"], json!({"windows": [{"pid": 7, "app": "Calc", "title": "Calculator", "windowId": 42, "active": true}]}));
    assert_eq!(ask(&mut f, r#"{"id":2,"cmd":"nope"}"#), json!({"id": 2, "ok": false, "error": "Unknown command nope"}));
    assert_eq!(ask(&mut f, r#"{"cmd":"status"}"#)["id"], Value::Null);
    // Lines that are not JSON objects get no reply.
    assert!(handle_line(&mut f, "garbage").is_none());
    assert!(handle_line(&mut f, "[1,2]").is_none());
    assert!(handle_line(&mut f, "").is_none());
}

#[test]
fn parameters_are_validated() {
    let mut f = Fake::default();
    assert_eq!(ask(&mut f, r#"{"id":1,"cmd":"observe"}"#)["error"], json!("pid is required"));
    assert_eq!(ask(&mut f, r#"{"id":1,"cmd":"press","pid":7}"#)["error"], json!("ref is required"));
    assert_eq!(ask(&mut f, r#"{"id":1,"cmd":"press","pid":7,"ref":"b1"}"#)["error"], json!("Control b1 is not in the latest observation. Observe again."));
    assert_eq!(ask(&mut f, r#"{"id":1,"cmd":"choose","pid":7,"ref":"a1"}"#)["error"], json!("option is required"));
    assert_eq!(ask(&mut f, r#"{"id":1,"cmd":"key","pid":7,"combo":"Hyper+x"}"#)["error"], json!("Unknown modifier Hyper"));
    assert_eq!(ask(&mut f, r#"{"id":1,"cmd":"open","what":"  "}"#)["error"], json!("app or url is required"));
    assert_eq!(ask(&mut f, r#"{"id":1,"cmd":"open","what":"calc"}"#), json!({"id": 1, "ok": false, "error": "nope"}));
    assert_eq!(ask(&mut f, r#"{"id":1,"cmd":"observe","pid":-3}"#)["error"], json!("pid is required"));
    assert!(f.calls.iter().all(|c| !c.starts_with("press")));
}

#[test]
fn commands_reach_the_backend() {
    let mut f = Fake::default();
    for line in [
        r#"{"id":1,"cmd":"observe","pid":7,"title":"T","max":99999}"#,
        r#"{"id":1,"cmd":"observe","pid":7}"#,
        r#"{"id":2,"cmd":"press","pid":7,"ref":"a2"}"#,
        r#"{"id":3,"cmd":"click","pid":7,"x":10.5,"y":4,"title":"T"}"#,
        r#"{"id":4,"cmd":"setText","pid":7,"ref":"a0","text":"abc"}"#,
        r#"{"id":5,"cmd":"type","pid":7,"text":"z"}"#,
        r#"{"id":6,"cmd":"choose","pid":7,"ref":"a1","option":"Two"}"#,
        r#"{"id":7,"cmd":"key","pid":7,"combo":"Mod+L"}"#,
        r#"{"id":8,"cmd":"scroll","pid":7,"ref":"","dy":-300}"#,
        r#"{"id":9,"cmd":"scroll","pid":7}"#,
    ] {
        assert_eq!(ask(&mut f, line)["ok"], json!(true), "{line}");
    }
    assert_eq!(
        f.calls,
        vec![
            "observe 7 T 5000",
            "observe 7  1500",
            "press 7 a2",
            "click 7 10.5 4 T",
            "setText 7 a0 abc",
            "type 7 z",
            "choose 7 a1 Two",
            "key 7 Char('l')",
            "scroll 7  -300",
            "scroll 7  600"
        ]
    );
    assert_eq!(ask(&mut f, r#"{"id":10,"cmd":"matches","pid":7,"checks":[{"ref":"a0","value":"hi"},{"ref":"a0","value":"no"},{"ref":"a1","value":""}]}"#)["result"], json!([true, false, false]));
    assert_eq!(ask(&mut f, r#"{"id":11,"cmd":"matches","pid":7,"checks":[{"ref":"a9","value":"x"}]}"#)["ok"], json!(false));
    assert_eq!(ask(&mut f, r#"{"id":12,"cmd":"screenshot","pid":7}"#)["result"], json!({"base64": "/9j/", "width": 2, "height": 1, "mime": "image/jpeg"}));
}

#[test]
fn images_scale_to_points_and_encode() {
    // 4x2 BGRA: left half blue-ish, right half red.
    let mut data = Vec::new();
    for _y in 0..2 {
        for x in 0..4 {
            data.extend_from_slice(if x < 2 { &[255, 0, 0, 255] } else { &[0, 0, 255, 255] });
        }
    }
    let p = Pixels { data: &data, width: 4, height: 2, stride: 16 };
    assert_eq!(to_rgb(&p, 2, 1).unwrap(), vec![0, 0, 255, 255, 0, 0]);
    assert_eq!(to_rgb(&p, 4, 2).unwrap().len(), 24);
    assert_eq!(to_rgb(&p, 40, 20).unwrap().len(), 24, "never upscales");
    let short = Pixels { data: &data[..10], width: 4, height: 2, stride: 16 };
    assert!(to_rgb(&short, 4, 2).is_err());
    let empty = Pixels { data: &[], width: 0, height: 0, stride: 0 };
    assert!(to_rgb(&empty, 1, 1).is_err());
    let shot = jpeg(&p, 2.0).unwrap();
    assert_eq!((shot.width, shot.height), (2, 1));
    assert_eq!(&shot.jpeg[..2], &[0xff, 0xd8]);
    let shot = jpeg(&p, f64::NAN).unwrap();
    assert_eq!((shot.width, shot.height), (4, 2));
}

#[cfg(target_os = "linux")]
mod linux {
    use crate::keys::{Key, Modifier, Named};
    use crate::linux::apps::{exec_argv, find, is_url, parse_entry};
    use crate::linux::atspi::{press_action, state, States};
    use crate::linux::session_problem;
    use crate::linux::x11::*;
    use std::path::Path;

    #[test]
    fn wayland_and_missing_display_are_reported() {
        assert!(session_problem(Some("wayland"), Some("wayland-0"), Some(":0")).unwrap().contains("Wayland"));
        assert!(session_problem(None, Some("wayland-0"), None).unwrap().contains("Wayland"));
        assert!(session_problem(Some("tty"), None, None).unwrap().contains("DISPLAY"));
        assert!(session_problem(Some("x11"), None, Some("")).is_some());
        assert_eq!(session_problem(Some("x11"), None, Some(":0")), None);
        // XWayland-less X11 session that still exports WAYLAND_DISPLAY with DISPLAY works through X11.
        assert_eq!(session_problem(None, Some("wayland-0"), Some(":1")), None);
    }

    #[test]
    fn keysyms() {
        assert_eq!(char_keysym('a'), 0x61);
        assert_eq!(char_keysym('\n'), 0xff0d);
        assert_eq!(char_keysym('é'), 0xe9);
        assert_eq!(char_keysym('あ'), 0x0100_3042);
        assert_eq!(key_keysym(Key::Named(Named::F(1))), 0xffbe);
        assert_eq!(key_keysym(Key::Named(Named::F(12))), 0xffc9);
        assert_eq!(key_keysym(Key::Named(Named::Escape)), 0xff1b);
        assert_eq!(key_keysym(Key::Char('l')), 0x6c);
        assert_eq!(modifier_keysym(Modifier::Control), 0xffe3);
        let map = Keymap { min: 8, per: 2, syms: vec![0x61, 0x41, 0x62, 0x42, 0, 0, 0, 0, 0x63, 0] };
        assert_eq!(map.find(0x61), Some((8, 0)));
        assert_eq!(map.find(0x42), Some((9, 1)));
        assert_eq!(map.find(0x7a), None);
        assert_eq!(map.scratch(), Some(11));
        assert_eq!(Keymap { min: 8, per: 0, syms: vec![] }.find(1), None);
        assert_eq!(wheel_notches(600), 5);
        assert_eq!(wheel_notches(10), 1);
        assert_eq!(wheel_notches(-1_000_000), 50);
    }

    #[test]
    fn atspi_states_and_actions() {
        let s = States::from_words(&[1 << state::FOCUSED | 1 << state::SHOWING, 0]);
        assert!(s.has(state::FOCUSED) && s.has(state::SHOWING) && !s.has(state::CHECKED));
        assert!(!s.has(70));
        let hi = States::from_words(&[0, 1]);
        assert!(hi.has(32));
        let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(press_action(&names(&["expand or contract", "activate"])), Some(1));
        assert_eq!(press_action(&names(&["Press"])), Some(0));
        assert_eq!(press_action(&names(&["custom"])), Some(0));
        assert_eq!(press_action(&[]), None);
    }

    #[test]
    fn desktop_entries() {
        let text = "[Desktop Entry]\nType=Application\nName=Calculator\nExec=gnome-calculator %U\n[Desktop Action new]\nExec=other\n";
        let e = parse_entry("org.gnome.Calculator", Path::new("/x.desktop"), text).unwrap();
        assert_eq!((e.name.as_str(), e.exec.as_str()), ("Calculator", "gnome-calculator %U"));
        assert!(parse_entry("h", Path::new("/h"), "[Desktop Entry]\nName=H\nExec=h\nNoDisplay=true\n").is_none());
        assert!(parse_entry("l", Path::new("/l"), "[Desktop Entry]\nType=Link\nName=L\nExec=l\n").is_none());
        let other = parse_entry("org.gnome.TextEditor", Path::new("/t"), "[Desktop Entry]\nName=Text Editor\nExec=gnome-text-editor\n").unwrap();
        let list = vec![e.clone(), other.clone()];
        assert_eq!(find(&list, "Calculator"), Some(&e));
        assert_eq!(find(&list, "calculator.desktop"), Some(&e));
        assert_eq!(find(&list, "texteditor"), Some(&other));
        assert_eq!(find(&list, "text"), Some(&other));
        assert_eq!(find(&list, "  "), None);
        assert_eq!(find(&list, "firefox"), None);
        assert_eq!(exec_argv("gnome-calculator %U"), vec!["gnome-calculator"]);
        assert_eq!(exec_argv(r#""/opt/My App/app" --flag "a \"b\"" 100%%"#), vec!["/opt/My App/app", "--flag", "a \"b\"", "100%"]);
        assert_eq!(exec_argv("sh -c 'rm -rf /' ; x"), vec!["sh", "-c", "'rm", "-rf", "/'", ";", "x"], "no shell interpretation, just argv");
        assert!(is_url("https://example.com") && is_url("HTTP://x"));
        assert!(!is_url("file:///etc/passwd") && !is_url("javascript:alert(1)"));
    }
}
