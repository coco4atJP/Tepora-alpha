//! Key combinations as the agent writes them ("Enter", "Control+A", "Mod+L"), parsed once for every OS.
use crate::protocol::{HelperError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Modifier {
    Control,
    Alt,
    Shift,
    /// The Windows/Super key.
    Meta,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Named {
    Enter,
    Tab,
    Space,
    Backspace,
    Escape,
    Delete,
    Home,
    End,
    PageUp,
    PageDown,
    Left,
    Right,
    Up,
    Down,
    F(u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    /// A lowercase ASCII letter or digit.
    Char(char),
    Named(Named),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    pub modifiers: Vec<Modifier>,
    pub key: Key,
}

fn named(s: &str) -> Option<Named> {
    Some(match s.to_ascii_lowercase().as_str() {
        "enter" | "return" => Named::Enter,
        "tab" => Named::Tab,
        "space" => Named::Space,
        "backspace" => Named::Backspace,
        "escape" | "esc" => Named::Escape,
        "delete" => Named::Delete,
        "home" => Named::Home,
        "end" => Named::End,
        "pageup" => Named::PageUp,
        "pagedown" => Named::PageDown,
        "arrowleft" | "left" => Named::Left,
        "arrowright" | "right" => Named::Right,
        "arrowup" | "up" => Named::Up,
        "arrowdown" | "down" => Named::Down,
        f if f.len() >= 2 && f.starts_with('f') => match f[1..].parse::<u8>() {
            Ok(n @ 1..=12) => Named::F(n),
            _ => return None,
        },
        _ => return None,
    })
}

/// "Mod" is Control off macOS (as in the browser surface); "Meta"/"Cmd" are the Windows/Super key.
pub fn parse_combo(combo: &str) -> Result<Combo> {
    let mut parts: Vec<&str> = combo.split('+').map(str::trim).collect();
    let last = match parts.pop() {
        Some(l) if !l.is_empty() => l,
        _ => return Err(HelperError::new("keys is empty")),
    };
    let mut modifiers = Vec::new();
    for p in parts {
        let m = match p.to_ascii_lowercase().as_str() {
            "mod" | "control" | "ctrl" => Modifier::Control,
            "alt" | "option" => Modifier::Alt,
            "shift" => Modifier::Shift,
            "meta" | "cmd" | "command" | "super" | "win" => Modifier::Meta,
            _ => return Err(HelperError::new(format!("Unknown modifier {p}"))),
        };
        if !modifiers.contains(&m) {
            modifiers.push(m);
        }
    }
    let key = if let Some(n) = named(last) {
        Key::Named(n)
    } else {
        let mut chars = last.chars();
        match (chars.next(), chars.next()) {
            (Some(c), None) if c.is_ascii_alphanumeric() => Key::Char(c.to_ascii_lowercase()),
            _ => return Err(HelperError::new(format!("Unknown key {last}"))),
        }
    };
    Ok(Combo { modifiers, key })
}
