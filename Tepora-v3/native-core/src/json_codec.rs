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

/// Read JavaScript UTF-16 code units from an internally encoded string.
///
/// Unlike `str::encode_utf16`, this decodes escaped private-use markers and
/// preserves lone surrogates. Use this for JavaScript length and slice logic.
pub fn utf16_units(text: &str) -> Vec<u16> {
    let mut units = Vec::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == MARKER {
            match chars.peek().copied() {
                Some(MARKER) => {
                    chars.next();
                    units.push(MARKER as u16);
                    continue;
                }
                Some(unit) if (UNIT_START..UNIT_START + 0x800).contains(&(unit as u32)) => {
                    chars.next();
                    units.push(0xd800 + (unit as u32 - UNIT_START) as u16);
                    continue;
                }
                _ => {}
            }
        }
        let mut buffer = [0; 2];
        units.extend_from_slice(ch.encode_utf16(&mut buffer));
    }
    units
}

/// Encode JavaScript UTF-16 units in the internal collision-safe representation.
///
/// Valid pairs become Unicode scalars; lone units remain recoverable even when a
/// JavaScript slice splits an emoji. Literal private-use markers are doubled.
pub fn from_utf16_units(units: &[u16]) -> String {
    let mut text = String::with_capacity(units.len());
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(ch) => {
                text.push(ch);
                if ch == MARKER {
                    text.push(MARKER);
                }
            }
            Err(error) => {
                text.push(MARKER);
                text.push(
                    char::from_u32(UNIT_START + u32::from(error.unpaired_surrogate() - 0xd800))
                        .unwrap(),
                );
            }
        }
    }
    text
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

/// `JSON.parse` on an internally encoded JavaScript string containing JSON.
///
/// A lone surrogate occurring literally in a JSON string is legal, but Rust
/// needs it escaped before parsing. It must not repair malformed source, such
/// as a backslash followed by a literal surrogate (an invalid JSON escape).
pub fn parse_js_text(text: &str) -> CoreResult<Value> {
    let units = utf16_units(text);
    let mut source = String::with_capacity(text.len());
    let mut quoted = false;
    let mut escaped = false;
    for decoded in char::decode_utf16(units) {
        match decoded {
            Ok(ch) => {
                source.push(ch);
                if escaped {
                    escaped = false;
                } else if quoted && ch == '\\' {
                    escaped = true;
                } else if ch == '"' {
                    quoted = !quoted;
                }
            }
            Err(error) if quoted && !escaped => {
                source.push_str(&format!("\\u{:04x}", error.unpaired_surrogate()));
            }
            Err(_) => {
                return Err(super::invalid("invalid JSON source: unpaired UTF-16 unit"));
            }
        }
    }
    parse(&source)
}

pub fn stringify(value: &Value) -> CoreResult<String> {
    let text = serde_json::to_string(value)?;
    Ok(restore_surrogates(&text))
}

fn restore_surrogates(text: &str) -> String {
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
    out
}

/// `JSON.stringify` for JSON values, returning ordinary external wire JSON.
///
/// Inputs use this module's internal string encoding. Number values are coerced
/// to JavaScript's binary64 representation, even when serde stored an integer.
/// Index property names come first in numeric order, followed by other keys in
/// insertion order (`serde_json` must enable `preserve_order`).
pub fn stringify_js(value: &Value) -> CoreResult<String> {
    let mut text = String::new();
    write_js(value, &mut text)?;
    Ok(restore_surrogates(&text))
}

fn write_js(value: &Value, text: &mut String) -> CoreResult<()> {
    match value {
        Value::Null => text.push_str("null"),
        Value::Bool(value) => text.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => text.push_str(&number_text(value)),
        Value::String(value) => write_js_string(value, text)?,
        Value::Array(values) => {
            text.push('[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    text.push(',');
                }
                write_js(value, text)?;
            }
            text.push(']');
        }
        Value::Object(values) => {
            let mut properties = values.iter().collect::<Vec<_>>();
            // Stable sorting leaves non-index names in insertion order.
            properties.sort_by_key(|(key, _)| match array_index(key) {
                Some(index) => (false, index),
                None => (true, 0),
            });
            text.push('{');
            for (index, (key, value)) in properties.into_iter().enumerate() {
                if index != 0 {
                    text.push(',');
                }
                write_js_string(key, text)?;
                text.push(':');
                write_js(value, text)?;
            }
            text.push('}');
        }
    }
    Ok(())
}

fn write_js_string(value: &str, text: &mut String) -> CoreResult<()> {
    // Concatenating two slices may reunite a previously split surrogate pair.
    // Canonicalize it so JSON.stringify emits the original scalar, not two
    // surrogate escapes. This also preserves literal private-use collisions.
    let canonical = from_utf16_units(&utf16_units(value));
    text.push_str(&serde_json::to_string(&canonical)?);
    Ok(())
}

pub(super) fn number_text(value: &serde_json::Number) -> String {
    // All serde JSON numbers have a finite binary64 conversion with the enabled
    // feature set (arbitrary_precision is intentionally not enabled).
    let number = value.as_f64().expect("JSON number must fit binary64");
    if number == 0.0 {
        return "0".into();
    }
    ryu_js::Buffer::new().format_finite(number).to_owned()
}

fn array_index(key: &str) -> Option<u32> {
    if key.is_empty()
        || key.len() > 10
        || (key.len() > 1 && key.starts_with('0'))
        || !key.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
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

    #[test]
    fn utf16_slicing_preserves_split_emoji_and_marker_collisions() {
        let original = encode_text("A🦀\u{e000}\u{e100}Z");
        let units = utf16_units(&original);
        assert_eq!(units, [0x41, 0xd83e, 0xdd80, 0xe000, 0xe100, 0x5a]);
        assert_eq!(from_utf16_units(&units), original);
        for start in 0..=units.len() {
            for end in start..=units.len() {
                let sliced = from_utf16_units(&units[start..end]);
                assert_eq!(utf16_units(&sliced), units[start..end]);
            }
        }
        assert_eq!(
            stringify_js(&Value::String(from_utf16_units(&units[1..2]))).unwrap(),
            r#""\ud83e""#
        );
        assert_eq!(
            stringify_js(&Value::String(from_utf16_units(&units[2..3]))).unwrap(),
            r#""\udd80""#
        );
        assert_eq!(from_utf16_units(&units[1..3]), "🦀");
        // String concatenation can rejoin two separately encoded lone units.
        let rejoined = format!(
            "{}{}",
            from_utf16_units(&units[1..2]),
            from_utf16_units(&units[2..3])
        );
        assert_eq!(stringify_js(&Value::String(rejoined)).unwrap(), "\"🦀\"");
    }

    #[test]
    fn utf16_roundtrip_covers_every_code_unit() {
        let every_unit = (0..=u16::MAX).collect::<Vec<_>>();
        assert_eq!(utf16_units(&from_utf16_units(&every_unit)), every_unit);
        for unit in 0xd800..=0xdfff {
            let units = [0xe000, 0xe100, unit, 0xe000, 0xe000];
            let encoded = from_utf16_units(&units);
            assert_eq!(utf16_units(&encoded), units);
            let wire = stringify_js(&Value::String(encoded.clone())).unwrap();
            assert_eq!(parse(&wire).unwrap(), Value::String(encoded));
        }
    }

    #[test]
    fn javascript_number_format_matches_binary64_and_exponent_boundaries() {
        for (value, expected) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-42.0, "-42"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (-1e-7, "-1e-7"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.2345678901234567e20, "123456789012345670000"),
            (f64::MAX, "1.7976931348623157e+308"),
            (f64::MIN, "-1.7976931348623157e+308"),
            (f64::from_bits(1), "5e-324"),
            (-f64::from_bits(1), "-5e-324"),
            (f64::MIN_POSITIVE, "2.2250738585072014e-308"),
            (f64::EPSILON, "2.220446049250313e-16"),
            (1_000_000_000_000_000_100.0, "1000000000000000100"),
        ] {
            assert_eq!(stringify_js(&Value::from(value)).unwrap(), expected);
        }
        for (value, expected) in [
            (Value::from(9_007_199_254_740_993_u64), "9007199254740992"),
            (Value::from(u64::MAX), "18446744073709552000"),
            (Value::from(i64::MIN), "-9223372036854776000"),
        ] {
            assert_eq!(stringify_js(&value).unwrap(), expected);
        }
    }

    #[test]
    fn javascript_object_keys_enumerate_indices_before_other_names() {
        let source = r#"{"b":0,"10":1,"2":2,"01":3,"0":4,"4294967295":5,"4294967294":6,"-0":7,"1e0":8,"1.0":9,"+1":10,"":11,"a":{"3":0,"1":1,"00":2}}"#;
        let value = parse(source).unwrap();
        assert_eq!(
            stringify_js(&value).unwrap(),
            r#"{"0":4,"2":2,"10":1,"4294967294":6,"b":0,"01":3,"4294967295":5,"-0":7,"1e0":8,"1.0":9,"+1":10,"":11,"a":{"1":1,"3":0,"00":2}}"#
        );
        for key in [
            "",
            "00",
            "01",
            "-0",
            "+1",
            "1.0",
            "1e0",
            "4294967295",
            "99999999999",
            "１",
        ] {
            assert_eq!(array_index(key), None, "{key}");
        }
        assert_eq!(array_index("0"), Some(0));
        assert_eq!(array_index("4294967294"), Some(4_294_967_294));
    }

    #[test]
    fn javascript_stringify_preserves_json_escaping_and_literal_markers() {
        let source = "{\"\\ud800\":\"\\u0000\\b\\t\\n\\f\\r\\\"\\\\/\u{2028}\u{2029}\u{e000}\u{e100}\\udfff\",\"x\":[null,true,false,1.0]}";
        let value = parse(source).unwrap();
        let expected = "{\"\\ud800\":\"\\u0000\\b\\t\\n\\f\\r\\\"\\\\/\u{2028}\u{2029}\u{e000}\u{e100}\\udfff\",\"x\":[null,true,false,1]}";
        assert_eq!(stringify_js(&value).unwrap(), expected);
        assert_eq!(stringify_js(&parse(expected).unwrap()).unwrap(), expected);
    }

    #[test]
    fn javascript_parse_accepts_encoded_source_without_corrupting_escapes() {
        let source = from_utf16_units(&[0x22, 0xe000, 0xe100, 0xd800, 0x22]);
        let parsed = parse_js_text(&source).unwrap();
        assert_eq!(
            utf16_units(parsed.as_str().unwrap()),
            [0xe000, 0xe100, 0xd800]
        );
        assert_eq!(
            parse_js_text(&encode_text(r#""\\ud800""#)).unwrap(),
            Value::String("\\ud800".into())
        );
        // A literal surrogate following one backslash is not a JSON escape.
        assert!(parse_js_text(&from_utf16_units(&[0x22, 0x5c, 0xd800, 0x22])).is_err());
        assert!(parse_js_text(&from_utf16_units(&[0xd800])).is_err());
        assert!(parse_js_text(&from_utf16_units(&[0x22, 0x5c, 0x75, 0x31, 0xd800, 0x22])).is_err());
        // An escaped backslash followed by a literal surrogate is valid.
        let parsed = parse_js_text(&from_utf16_units(&[0x22, 0x5c, 0x5c, 0xd800, 0x22])).unwrap();
        assert_eq!(utf16_units(parsed.as_str().unwrap()), [0x5c, 0xd800]);
    }
}
