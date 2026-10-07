//! Lossless JavaScript JSON string transport, including unpaired UTF-16 units.
//!
//! Rust strings are Unicode scalar values. Internally a private-use marker is
//! escaped (doubled) and a lone surrogate is represented by marker + mapped unit.
//! The encoding never appears in database JSON or in the public wire protocol.
//! Ordinary SQLite TEXT uses UTF-8, matching Node's replacement of lone units.
use super::{CoreResult, Map, Value};

const MARKER: char = '\u{e000}';
const UNIT_START: u32 = 0xe100;

pub fn encode_text(text: &str) -> String {
    text.replace(MARKER, "\u{e000}\u{e000}")
}

pub fn sql_text(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != MARKER {
            out.push(ch);
            continue;
        }
        match chars.peek().copied() {
            Some(MARKER) => {
                chars.next();
                out.push(MARKER);
            }
            Some(unit) if (UNIT_START..UNIT_START + 0x800).contains(&(unit as u32)) => {
                chars.next();
                out.push('\u{fffd}');
            }
            _ => out.push(MARKER),
        }
    }
    out
}

pub fn encode_value(value: Value) -> Value {
    match value {
        Value::String(s) => Value::String(encode_text(&s)),
        Value::Array(values) => Value::Array(values.into_iter().map(encode_value).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(k, v)| (encode_text(&k), encode_value(v)))
                .collect::<Map<_, _>>(),
        ),
        other => other,
    }
}

fn hex_unit(bytes: &[u8], at: usize) -> Option<u16> {
    if bytes.get(at..at + 2)? != b"\\u" {
        return None;
    }
    let mut value = 0;
    for digit in bytes.get(at + 2..at + 6)? {
        value = value * 16 + (*digit as char).to_digit(16)? as u16;
    }
    Some(value)
}

pub fn parse(text: &str) -> CoreResult<Value> {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut quoted = false;
    while i < bytes.len() {
        let ch = text[i..].chars().next().unwrap();
        if ch == '"' {
            quoted = !quoted;
            out.push(ch);
            i += 1;
            continue;
        }
        if quoted && ch == '\\' {
            if let Some(unit) = hex_unit(bytes, i) {
                if (0xd800..=0xdbff).contains(&unit)
                    && hex_unit(bytes, i + 6).is_some_and(|low| (0xdc00..=0xdfff).contains(&low))
                {
                    out.push_str(&text[i..i + 12]);
                    i += 12;
                    continue;
                }
                if (0xd800..=0xdfff).contains(&unit) {
                    out.push(MARKER);
                    out.push(char::from_u32(UNIT_START + u32::from(unit - 0xd800)).unwrap());
                    i += 6;
                    continue;
                }
                if unit == MARKER as u16 {
                    out.push(MARKER);
                    out.push(MARKER);
                    i += 6;
                    continue;
                }
                out.push_str(&text[i..i + 6]);
                i += 6;
                continue;
            }
            // Keep escaped quotes/backslashes together so they cannot change the
            // scanner's string state. Invalid escapes are rejected by serde.
            out.push(ch);
            i += 1;
            if i < bytes.len() {
                let escaped = text[i..].chars().next().unwrap();
                out.push(escaped);
                i += escaped.len_utf8();
            }
            continue;
        }
        out.push(ch);
        if quoted && ch == MARKER {
            out.push(MARKER);
        }
        i += ch.len_utf8();
    }
    Ok(serde_json::from_str(&out)?)
}

pub fn stringify(value: &Value) -> CoreResult<String> {
    let text = serde_json::to_string(value)?;
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != MARKER {
            out.push(ch);
            continue;
        }
        match chars.peek().copied() {
            Some(MARKER) => {
                chars.next();
                out.push(MARKER);
            }
            Some(unit) if (UNIT_START..UNIT_START + 0x800).contains(&(unit as u32)) => {
                chars.next();
                out.push_str(&format!("\\u{:04x}", 0xd800 + unit as u32 - UNIT_START));
            }
            _ => out.push(MARKER),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_lone_pairs_literal_escapes_and_collision_characters() {
        for input in [
            r#"{"text":"\ud83e"}"#,
            r#"{"text":"\udc00"}"#,
            r#"{"text":"\ud83e\udd80"}"#,
            r#"{"text":"\\ud83e"}"#,
            r#"{"text":"\\\"\ud83e"}"#,
            r#"{"text":"\ue000\ue13e\ud83e\ue000\ue000"}"#,
            "{\"\u{e000}\u{e13e}\":\"\u{e000}\u{e100} literal\"}",
        ] {
            let encoded = parse(input).unwrap();
            let wire = stringify(&encoded).unwrap();
            assert_eq!(parse(&wire).unwrap(), encoded, "{input}");
        }
        assert_eq!(
            stringify(&parse(r#""\ud83e""#).unwrap()).unwrap(),
            r#""\ud83e""#
        );
        assert_eq!(
            stringify(&parse(r#""\ud83e\udd80""#).unwrap()).unwrap(),
            "\"🦀\""
        );
        let collision = "\u{e000}\u{e13e}\u{e000}";
        assert_eq!(sql_text(&encode_text(collision)), collision);
    }

    #[test]
    fn malformed_json_is_still_rejected() {
        for input in [r#""\u12""#, r#""\ud83x""#, r#""\q""#, "\"unterminated"] {
            assert!(parse(input).is_err(), "{input}");
        }
    }
}
