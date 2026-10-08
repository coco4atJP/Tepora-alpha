//! Deterministic context token estimates and calibration, without a provider or store.
//!
//! All strings use the crate's lossless JavaScript UTF-16 transport. In particular
//! an astral character occupies two units in the length estimate, while the script
//! test visits one Unicode scalar, exactly as JavaScript's `for ... of` does.
use super::{invalid, json_codec, truthy, CoreResult};
use serde_json::{json, Value};

use super::js_value::js_string;

// The four Unicode Script properties used by the existing estimator, plus its
// explicit U+3000..303F and U+FF00..FFEF ranges (Unicode 17). Do not broaden these
// to all East Asian Width characters: punctuation, emoji and combining marks
// have deliberately different costs in the existing estimate.
const WIDE: &[(u32, u32)] = &[
    (0x1100, 0x11ff),
    (0x2e80, 0x2e99),
    (0x2e9b, 0x2ef3),
    (0x2f00, 0x2fd5),
    (0x3000, 0x303f),
    (0x3041, 0x3096),
    (0x309d, 0x309f),
    (0x30a1, 0x30fa),
    (0x30fd, 0x30ff),
    (0x3131, 0x318e),
    (0x31f0, 0x321e),
    (0x3260, 0x327e),
    (0x32d0, 0x32fe),
    (0x3300, 0x3357),
    (0x3400, 0x4dbf),
    (0x4e00, 0x9fff),
    (0xa960, 0xa97c),
    (0xac00, 0xd7a3),
    (0xd7b0, 0xd7c6),
    (0xd7cb, 0xd7fb),
    (0xf900, 0xfa6d),
    (0xfa70, 0xfad9),
    (0xff00, 0xffef),
    (0x16fe2, 0x16fe3),
    (0x16ff0, 0x16ff6),
    (0x1aff0, 0x1aff3),
    (0x1aff5, 0x1affb),
    (0x1affd, 0x1affe),
    (0x1b000, 0x1b122),
    (0x1b132, 0x1b132),
    (0x1b150, 0x1b152),
    (0x1b155, 0x1b155),
    (0x1b164, 0x1b167),
    (0x1f200, 0x1f200),
    (0x20000, 0x2a6df),
    (0x2a700, 0x2b81d),
    (0x2b820, 0x2cead),
    (0x2ceb0, 0x2ebe0),
    (0x2ebf0, 0x2ee5d),
    (0x2f800, 0x2fa1d),
    (0x30000, 0x3134a),
    (0x31350, 0x33479),
];

// Script assignments added between Node 22's Unicode 16 and Node 24's Unicode
// 17. Runtime version is an explicit input, never mutable global process state.
const WIDE_ADDED_17: &[(u32, u32)] = &[
    (0x16ff2, 0x16ff6),
    (0x2b73a, 0x2b73f),
    (0x2cea2, 0x2cead),
    (0x323b0, 0x33479),
];
#[derive(Clone, Copy)]
pub(crate) struct Estimator {
    unicode: u32,
}
impl Default for Estimator {
    fn default() -> Self {
        Self { unicode: 16 }
    }
}
impl Estimator {
    pub(crate) fn from_payload(payload: &Value) -> Self {
        let unicode = payload
            .get("unicodeVersion")
            .and_then(|value| {
                value.as_u64().map(|value| value as u32).or_else(|| {
                    value
                        .as_str()
                        .and_then(|value| value.split('.').next()?.parse().ok())
                })
            })
            .unwrap_or(16);
        Self { unicode }
    }
    pub(crate) fn raw_text_tokens(&self, text: &str) -> u64 {
        let units = json_codec::utf16_units(text);
        let wide = char::decode_utf16(units.iter().copied())
            .filter(|value| {
                value.as_ref().is_ok_and(|ch| {
                    WIDE.iter()
                        .any(|&(start, end)| (start..=end).contains(&(*ch as u32)))
                        && (self.unicode >= 17
                            || !WIDE_ADDED_17
                                .iter()
                                .any(|&(start, end)| (start..=end).contains(&(*ch as u32))))
                })
            })
            .count();
        (wide as f64 + (units.len() - wide) as f64 / 3.2).ceil() as u64
    }

    pub(crate) fn raw_tokens(&self, value: Option<&Value>) -> u64 {
        match value {
            None | Some(Value::Null) => 0,
            value => self.raw_text_tokens(&js_string(value)),
        }
    }

    pub(crate) fn message_tokens(&self, message: &Value) -> u64 {
        let mut n = 4;
        match message.get("content") {
            Some(Value::String(text)) => n += self.raw_text_tokens(text),
            Some(Value::Array(parts)) => {
                for part in parts {
                    n += match part.get("type").and_then(Value::as_str) {
                        Some("text") => self.raw_tokens(part.get("text")),
                        Some("image_url") => {
                            image_tokens(part.get("image_url").and_then(|p| p.get("url")))
                        }
                        _ => 0,
                    };
                }
            }
            _ => {}
        }
        if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let function = call.get("function");
                n += 8
                    + self.raw_tokens(function.and_then(|f| f.get("name")))
                    + self.raw_tokens(function.and_then(|f| f.get("arguments")));
            }
        }
        n
    }

    pub(crate) fn messages_tokens(&self, messages: &[Value]) -> u64 {
        messages
            .iter()
            .map(|message| self.message_tokens(message))
            .sum()
    }

    pub(crate) fn tools_tokens(&self, tools: Option<&Value>) -> CoreResult<u64> {
        let Some(Value::Array(values)) = tools else {
            return Ok(0);
        };
        if values.is_empty() {
            return Ok(0);
        }
        // JSON.stringify produces a new ordinary JS string, so escape our transport
        // marker before measuring it as a string in the encoded value domain.
        let text = json_codec::encode_text(&json_codec::stringify_js(tools.unwrap())?);
        Ok(self.raw_text_tokens(&text) + values.len() as u64 * 6)
    }
}
#[cfg(test)]
pub(crate) fn raw_text_tokens(text: &str) -> u64 {
    Estimator::default().raw_text_tokens(text)
}
#[cfg(test)]
pub(crate) fn raw_tokens(value: Option<&Value>) -> u64 {
    Estimator::default().raw_tokens(value)
}
#[cfg(test)]
pub(crate) fn message_tokens(message: &Value) -> u64 {
    Estimator::default().message_tokens(message)
}
#[cfg(test)]
pub(crate) fn messages_tokens(messages: &[Value]) -> u64 {
    Estimator::default().messages_tokens(messages)
}
#[cfg(test)]
pub(crate) fn tools_tokens(tools: Option<&Value>) -> CoreResult<u64> {
    Estimator::default().tools_tokens(tools)
}

/// Node's base64 decoder accepts whitespace, URL-safe symbols and omitted
/// padding, and ignores non-alphabet characters. Only the image header is read.
fn decode_base64(text: &[u16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() * 3 / 4);
    let mut bits = 0u32;
    let mut count = 0;
    for &unit in text {
        let digit = match unit {
            65..=90 => unit - 65,
            97..=122 => unit - 97 + 26,
            48..=57 => unit - 48 + 52,
            43 | 45 => 62,
            47 | 95 => 63,
            61 => break,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(digit);
        count += 6;
        if count >= 8 {
            count -= 8;
            bytes.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    bytes
}

fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 12 {
        return None;
    }
    let be16 = |at: usize| -> Option<u32> {
        Some(u32::from(u16::from_be_bytes(
            bytes.get(at..at + 2)?.try_into().ok()?,
        )))
    };
    let le16 = |at: usize| -> Option<u32> {
        Some(u32::from(u16::from_le_bytes(
            bytes.get(at..at + 2)?.try_into().ok()?,
        )))
    };
    let be32 = |at: usize| -> Option<u32> {
        Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
    };
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47]) && bytes.len() >= 24 {
        return Some((be32(16)?, be32(20)?));
    }
    if bytes.starts_with(b"GIF") {
        return Some((le16(6)?, le16(8)?));
    }
    if bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" && bytes.len() >= 30 {
        return match &bytes[12..16] {
            b"VP8X" => Some((
                1 + u32::from_le_bytes([bytes[24], bytes[25], bytes[26], 0]),
                1 + u32::from_le_bytes([bytes[27], bytes[28], bytes[29], 0]),
            )),
            b"VP8L" => {
                let bits = u32::from_le_bytes(bytes[21..25].try_into().ok()?);
                Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
            }
            _ => Some((le16(26)? & 0x3fff, le16(28)? & 0x3fff)),
        };
    }
    if bytes.starts_with(&[0xff, 0xd8]) {
        let mut at = 2;
        while at + 9 < bytes.len() {
            if bytes[at] != 0xff {
                at += 1;
                continue;
            }
            let marker = bytes[at + 1];
            if marker == 0xd8 || marker == 1 || (0xd0..=0xd7).contains(&marker) {
                at += 2;
                continue;
            }
            let len = be16(at + 2)? as usize;
            if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
                return Some((be16(at + 7)?, be16(at + 5)?));
            }
            at += 2 + len;
        }
        return Some((0, 0));
    }
    None
}

/// Decode only the bounded image header, never allocate UTF-16 for the entire
/// multi-megabyte image. A doubled transport marker consumes at most two chars
/// per UTF-16 unit, so the non-ASCII fallback is bounded as well.
fn header_units(source: &str) -> Vec<u16> {
    let prefix = &source.as_bytes()[..source.len().min(131_072)];
    if prefix.is_ascii() {
        return prefix.iter().map(|&byte| u16::from(byte)).collect();
    }
    let end = source
        .char_indices()
        .nth(262_144)
        .map(|(at, _)| at)
        .unwrap_or(source.len());
    let mut units = json_codec::utf16_units(&source[..end]);
    units.truncate(131_072);
    units
}
pub(crate) fn image_tokens(url: Option<&Value>) -> u64 {
    let owned;
    let text = match url {
        Some(Value::String(text)) => text.as_str(),
        Some(value) if truthy(value) => {
            owned = js_string(Some(value));
            &owned
        }
        _ => "",
    };
    if let Some(comma) = text.find(',').filter(|&n| n > 0) {
        let head = decode_base64(&header_units(&text[comma + 1..]));
        if let Some((width, height)) = image_dimensions(&head) {
            if width != 0 && height != 0 {
                return ((f64::from(width) * f64::from(height) / 750.0).ceil() as u64)
                    .clamp(85, 1600);
            }
        }
    }
    1200
}

fn ratio(payload: &Value) -> f64 {
    payload
        .get("ratio")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(1.0)
}

pub(crate) fn call(op: &str, payload: Value) -> CoreResult<Value> {
    let estimator = Estimator::from_payload(&payload);
    Ok(match op {
        "tokens.raw" => json!(estimator.raw_tokens(payload.get("text"))),
        "tokens.message" => {
            json!(estimator.message_tokens(payload.get("message").unwrap_or(&Value::Null)))
        }
        "tokens.messages" => json!(estimator.messages_tokens(
            payload
                .get("messages")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid("messages must be an array"))?
        )),
        "tokens.tools" => json!(estimator.tools_tokens(payload.get("tools"))?),
        "tokens.image" => json!(image_tokens(payload.get("url"))),
        "tokens.estimate" => json!((payload.get("raw").and_then(Value::as_f64).unwrap_or(0.0)
            * ratio(&payload))
        .ceil()),
        "tokens.observe" => {
            let has_identity = payload.get("identity").is_some_and(truthy);
            let old = if has_identity { ratio(&payload) } else { 1.0 };
            let estimated = payload
                .get("estimated")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let actual = payload.get("actual").and_then(Value::as_f64).unwrap_or(0.0);
            if !has_identity || estimated <= 200.0 || actual <= 0.0 {
                json!(old)
            } else {
                json!(old + ((actual / estimated).clamp(0.35, 2.5) - old) * 0.3)
            }
        }
        _ => return Err(invalid(format!("unknown token operation: {op}"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_and_utf16_match_js_estimator() {
        for (text, tokens) in [
            ("", 0),
            ("こんにちは世界", 7),
            ("abcd", 2),
            ("😀😀😀😀", 3),
            ("𠀀", 2),
            ("한글", 2),
            ("カタカナ", 4),
            ("\u{3099}\u{3099}", 1),
        ] {
            assert_eq!(raw_text_tokens(text), tokens, "{text}");
        }
        let lone = json_codec::parse(r#""\ud800\ue000\udfff""#).unwrap();
        assert_eq!(raw_tokens(Some(&lone)), 1);
        assert_eq!(raw_tokens(Some(&json!([1, null, "漢"]))), 2);
        assert_eq!(raw_tokens(Some(&json!({}))), 5);
    }

    #[test]
    fn unicode_assignments_follow_explicit_host_version() {
        for (first, last) in WIDE_ADDED_17 {
            for codepoint in [*first, *last] {
                let text = char::from_u32(codepoint).unwrap().to_string().repeat(4);
                assert_eq!(Estimator::default().raw_text_tokens(&text), 3);
                assert_eq!(Estimator { unicode: 17 }.raw_text_tokens(&text), 6);
                assert_eq!(
                    call("tokens.raw", json!({"text":text,"unicodeVersion":"16.0"})).unwrap(),
                    json!(3)
                );
                assert_eq!(
                    call("tokens.raw", json!({"text":text,"unicodeVersion":"17.0"})).unwrap(),
                    json!(6)
                );
            }
        }
        assert_eq!(header_units(&"a".repeat(500_000)).len(), 131_072);
        let marker = json_codec::encode_text(&"\u{e000}".repeat(200_000));
        assert_eq!(header_units(&marker), vec![0xe000; 131_072]);
    }

    #[test]
    fn messages_include_tool_overhead_but_not_native_replay_or_cache_metadata() {
        let message = json!({"role":"assistant","content":"hello","tool_calls":[
            {"id":"a","function":{"name":"read","arguments":"{}"}}],
            "_native":{"items":[{"text":"x".repeat(10000)}]},"cache":true});
        assert_eq!(message_tokens(&message), 17);
        assert_eq!(
            message_tokens(&json!({"content":[{"type":"text","text":"漢字"},
            {"type":"image_url","image_url":{"url":"https://example.test/a.png"}}]})),
            1206
        );
        assert_eq!(tools_tokens(Some(&json!([]))).unwrap(), 0);
    }

    #[test]
    fn image_headers_cover_png_gif_jpeg_and_webp() {
        const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
        assert_eq!(
            image_tokens(Some(&json!(format!("data:image/png;base64,{PNG}")))),
            85
        );
        assert_eq!(image_tokens(Some(&json!("data:image/png;base64,AA"))), 1200);
        assert_eq!(
            image_tokens(Some(&json!("https://example.test/x.png"))),
            1200
        );
        let mut png = vec![0; 24];
        png[..4].copy_from_slice(&[0x89, 0x50, 0x4e, 0x47]);
        png[16..20].copy_from_slice(&1600u32.to_be_bytes());
        png[20..24].copy_from_slice(&900u32.to_be_bytes());
        assert_eq!(image_dimensions(&png), Some((1600, 900)));
        let mut gif = vec![0; 12];
        gif[..3].copy_from_slice(b"GIF");
        gif[6..8].copy_from_slice(&600u16.to_le_bytes());
        gif[8..10].copy_from_slice(&400u16.to_le_bytes());
        assert_eq!(image_dimensions(&gif), Some((600, 400)));
        let jpeg = [0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 1, 0, 2, 0, 0];
        assert_eq!(image_dimensions(&jpeg), Some((512, 256)));
        let mut webp = vec![0; 30];
        webp[..4].copy_from_slice(b"RIFF");
        webp[8..12].copy_from_slice(b"WEBP");
        webp[12..16].copy_from_slice(b"VP8X");
        webp[24] = 255;
        webp[27] = 127;
        assert_eq!(image_dimensions(&webp), Some((256, 128)));
        webp[12..16].copy_from_slice(b"VP8L");
        webp[21..25].copy_from_slice(&(63u32 | (31 << 14)).to_le_bytes());
        assert_eq!(image_dimensions(&webp), Some((64, 32)));
        assert_eq!(
            decode_base64(&" Z m\n9v===ignored".encode_utf16().collect::<Vec<_>>()),
            b"foo"
        );
    }

    #[test]
    fn same_length_images_with_equal_suffixes_do_not_alias_token_costs() {
        fn url(width: u32, height: u32) -> String {
            let mut png = vec![0; 120];
            png[..4].copy_from_slice(&[0x89, 0x50, 0x4e, 0x47]);
            png[16..20].copy_from_slice(&width.to_be_bytes());
            png[20..24].copy_from_slice(&height.to_be_bytes());
            let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let mut encoded = String::from("data:image/png;base64,");
            for part in png.chunks_exact(3) {
                let bits =
                    (u32::from(part[0]) << 16) | (u32::from(part[1]) << 8) | u32::from(part[2]);
                for shift in [18, 12, 6, 0] {
                    encoded.push(alphabet[((bits >> shift) & 63) as usize] as char);
                }
            }
            encoded
        }
        let small = url(1, 1);
        let large = url(1600, 900);
        assert_eq!(small.len(), large.len());
        assert_eq!(&small[small.len() - 48..], &large[large.len() - 48..]);
        // The old JavaScript cache used only length and suffix. Computing the
        // real header deliberately fixes collisions between unrelated images.
        assert_eq!(image_tokens(Some(&json!(small))), 85);
        assert_eq!(image_tokens(Some(&json!(large))), 1600);
        assert_eq!(image_tokens(Some(&json!(small))), 85);
    }

    #[test]
    fn calibration_preserves_guards_clamps_and_smoothing() {
        assert_eq!(
            call(
                "tokens.observe",
                json!({"identity":"m","estimated":1000,"actual":1500})
            )
            .unwrap(),
            json!(1.15)
        );
        assert_eq!(
            call(
                "tokens.observe",
                json!({"identity":"m","estimated":200,"actual":999,"ratio":1.7})
            )
            .unwrap(),
            json!(1.7)
        );
        assert_eq!(
            call(
                "tokens.observe",
                json!({"identity":"","estimated":1000,"actual":999,"ratio":1.7})
            )
            .unwrap(),
            json!(1.0)
        );
        assert_eq!(
            call(
                "tokens.observe",
                json!({"identity":"m","estimated":1000,"actual":10000})
            )
            .unwrap(),
            json!(1.45)
        );
        assert_eq!(
            call(
                "tokens.observe",
                json!({"identity":"m","estimated":1000,"actual":1})
            )
            .unwrap(),
            json!(0.8049999999999999)
        );
        assert_eq!(
            call("tokens.estimate", json!({"raw":101,"ratio":1.2})).unwrap(),
            json!(122.0)
        );
    }
}
