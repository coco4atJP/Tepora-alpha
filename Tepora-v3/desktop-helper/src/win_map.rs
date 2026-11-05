//! Pure Windows mappings (UIA control types, roles, virtual keys, typed text), kept OS-independent so they
//! are unit-tested on every platform; windows.rs uses them.
#![cfg_attr(not(windows), allow(dead_code))]
use crate::contract::{Contract, Platform};
use crate::keys::{Combo, Key, Modifier, Named};

/// UIA control type ids (UIA_*ControlTypeId) by the names the contract uses.
pub fn control_type_name(id: i32) -> &'static str {
    match id {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        50039 => "SemanticZoom",
        50040 => "AppBar",
        _ => "",
    }
}

/// The common role of a UIA element. Edit fields that hide their text are passwords; a Document is a field only
/// when it takes a value (a rich edit), not a web page or a read-only viewer.
pub fn uia_role(contract: &Contract, control: &str, pressable: bool, password: bool, writable_value: bool) -> Option<String> {
    if control == "Edit" && password {
        return Some("password".into());
    }
    if control == "Document" && !writable_value {
        return None;
    }
    contract.role(Platform::Uia, control, pressable)
}

pub fn vk_for(key: Key) -> (u16, bool) {
    match key {
        Key::Char(c) => (c.to_ascii_uppercase() as u16, false),
        Key::Named(n) => match n {
            Named::Enter => (0x0D, false),
            Named::Tab => (0x09, false),
            Named::Space => (0x20, false),
            Named::Backspace => (0x08, false),
            Named::Escape => (0x1B, false),
            Named::Delete => (0x2E, true),
            Named::Home => (0x24, true),
            Named::End => (0x23, true),
            Named::PageUp => (0x21, true),
            Named::PageDown => (0x22, true),
            Named::Left => (0x25, true),
            Named::Up => (0x26, true),
            Named::Right => (0x27, true),
            Named::Down => (0x28, true),
            Named::F(n) => (0x6F + n as u16, false),
        },
    }
}
pub fn vk_modifier(m: Modifier) -> u16 {
    match m {
        Modifier::Control => 0x11,
        Modifier::Alt => 0x12,
        Modifier::Shift => 0x10,
        Modifier::Meta => 0x5B,
    }
}

/// Key events for a combo: modifiers down, key down/up, modifiers up in reverse.
pub fn combo_inputs(combo: &Combo) -> Vec<(u16, bool, bool)> {
    let (vk, ext) = vk_for(combo.key);
    let mut out: Vec<(u16, bool, bool)> = combo.modifiers.iter().map(|m| (vk_modifier(*m), false, false)).collect();
    out.push((vk, ext, false));
    out.push((vk, ext, true));
    out.extend(combo.modifiers.iter().rev().map(|m| (vk_modifier(*m), false, true)));
    out
}
/// UTF-16 units typed as KEYEVENTF_UNICODE; newlines become Enter.
pub fn text_units(text: &str) -> Vec<TypeUnit> {
    let mut out = Vec::new();
    for c in text.chars() {
        match c {
            '\r' => {}
            '\n' => out.push(TypeUnit::Vk(0x0D)),
            '\t' => out.push(TypeUnit::Vk(0x09)),
            c => {
                let mut buf = [0u16; 2];
                for u in c.encode_utf16(&mut buf) {
                    out.push(TypeUnit::Unit(*u));
                }
            }
        }
    }
    out
}
#[derive(Debug, PartialEq)]
pub enum TypeUnit {
    Vk(u16),
    Unit(u16),
}

