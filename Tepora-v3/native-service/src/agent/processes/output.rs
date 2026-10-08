//! Source-exact UTF-8 collection / UTF-16 bounded output and terminal rendering.
use regex::Regex;
use std::{collections::VecDeque, sync::OnceLock};
use tepora_core::json_codec::{from_utf16_units, utf16_units};
pub const HEAD: usize = 200_000;
pub const TAIL: usize = 800_000;
#[derive(Debug, Default)]
pub struct Utf8Decoder {
    pending: Vec<u8>,
}
impl Utf8Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut output = String::new();
        let mut consumed = 0;
        while consumed < self.pending.len() {
            match std::str::from_utf8(&self.pending[consumed..]) {
                Ok(valid) => {
                    output.push_str(valid);
                    consumed = self.pending.len();
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    if valid > 0 {
                        output.push_str(unsafe {
                            std::str::from_utf8_unchecked(&self.pending[consumed..consumed + valid])
                        });
                        consumed += valid;
                    }
                    match error.error_len() {
                        Some(len) => {
                            output.push('\u{fffd}');
                            consumed += len;
                        }
                        None => break,
                    }
                }
            }
        }
        self.pending.drain(..consumed);
        output
    }
    pub fn finish(&mut self) -> String {
        let result = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        result
    }
}
#[derive(Debug, Default)]
pub struct Output {
    head: Vec<u16>,
    tail: VecDeque<u16>,
    pub dropped: u64,
    pub total: u64,
    pub cursor: u64,
}
impl Output {
    /// raw is decoded OS output, not an internally encoded JSON string.
    pub fn take(&mut self, raw: &str) -> bool {
        static ANSI: OnceLock<Regex> = OnceLock::new();
        let ansi = ANSI.get_or_init(|| {
            Regex::new(
                r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>]",
            )
            .unwrap()
        });
        let text = ansi.replace_all(raw, "");
        if text.is_empty() {
            return false;
        }
        let units = text.encode_utf16().collect::<Vec<_>>();
        self.total = self.total.saturating_add(units.len() as u64);
        let room = HEAD.saturating_sub(self.head.len());
        let take = room.min(units.len());
        self.head.extend_from_slice(&units[..take]);
        self.tail.extend(units[take..].iter().copied());
        if self.tail.len() > TAIL {
            let cut = self.tail.len() - TAIL;
            self.tail.drain(..cut);
            self.dropped = self.dropped.saturating_add(cut as u64);
        }
        true
    }
    pub fn read(&self, from: u64) -> String {
        let head_end = self.head.len() as u64;
        let tail_start = self.total - self.tail.len() as u64;
        let mut units = vec![];
        if from < head_end {
            units.extend_from_slice(&self.head[from as usize..]);
            if self.dropped > 0 {
                units.extend(format!("\n…[{} characters dropped]…\n", self.dropped).encode_utf16());
            }
            units.extend(self.tail.iter().copied());
        } else {
            units.extend(
                self.tail
                    .iter()
                    .skip(from.saturating_sub(tail_start).min(self.tail.len() as u64) as usize)
                    .copied(),
            );
        }
        from_utf16_units(&units)
    }
    pub fn poll(&mut self) -> String {
        let output = self.read(self.cursor);
        self.cursor = self.total;
        output
    }
}
fn js_whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
pub fn terminal_text(raw: &str) -> String {
    static CRLF: OnceLock<Regex> = OnceLock::new();
    let fixed = CRLF
        .get_or_init(|| Regex::new(r"\r+\n").unwrap())
        .replace_all(raw, "\n");
    let mut output = vec![];
    let mut previous: Option<&str> = None;
    let mut runs = 0usize;
    fn close(output: &mut Vec<String>, runs: usize) {
        if runs > 1 {
            output.push(format!(
                "… (line above repeated {} more time{})",
                runs - 1,
                if runs > 2 { "s" } else { "" }
            ));
        }
    }
    for raw_line in fixed.split('\n') {
        let line = if raw_line.contains('\r') {
            raw_line
                .split('\r')
                .rev()
                .find(|s| !s.is_empty())
                .unwrap_or("")
        } else {
            raw_line
        };
        if previous == Some(line) && !line.trim_matches(js_whitespace).is_empty() {
            runs += 1;
            continue;
        }
        close(&mut output, runs);
        output.push(line.into());
        previous = Some(line);
        runs = 1;
    }
    close(&mut output, runs);
    output.join("\n")
}
/// Positive f64.toFixed(1) with JavaScript's exact binary-value rounding. Rust's
/// formatter uses ties-to-even; multiplying first also changes 0.15's result.
pub fn fixed_one(value: f64) -> String {
    if !value.is_finite() {
        return if value.is_nan() {
            "NaN".into()
        } else if value.is_sign_negative() {
            "-Infinity".into()
        } else {
            "Infinity".into()
        };
    }
    if value.abs() >= 1e21 {
        return value.to_string();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    let value = value.abs();
    if value == 0.0 {
        return "0.0".into();
    }
    let bits = value.to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = (bits & ((1u64 << 52) - 1)) | if exponent == 0 { 0 } else { 1u64 << 52 };
    let shift = if exponent == 0 {
        -1074
    } else {
        exponent - 1023 - 52
    };
    let numerator = u128::from(mantissa) * 10;
    let scaled = if shift >= 0 {
        numerator.checked_shl(shift as u32).unwrap_or(u128::MAX)
    } else {
        let bits = (-shift) as u32;
        if bits >= 128 {
            0
        } else {
            let q = numerator >> bits;
            let remainder = numerator - (q << bits);
            q + u128::from(remainder >= (1u128 << (bits - 1)))
        }
    };
    format!("{sign}{}.{}", scaled / 10, scaled % 10)
}
pub fn slice_internal(value: &str, max: usize) -> String {
    let units = utf16_units(value);
    from_utf16_units(&units[..units.len().min(max)])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_utf8_decoders_preserve_split_and_invalid_units() {
        let mut a = Utf8Decoder::default();
        let mut b = Utf8Decoder::default();
        assert_eq!(a.push(&[0xf0, 0x9f]), "");
        assert_eq!(b.push(b"stderr"), "stderr");
        assert_eq!(a.push(&[0x8c, 0xb1]), "🌱");
        assert_eq!(a.push(&[0xe2, 0x28, 0xa1]), "�(�");
        assert_eq!(a.push(&[0xe2, 0x82]), "");
        assert_eq!(a.finish(), "�");
        assert_eq!(b.finish(), "");
    }
    #[test]
    fn head_tail_and_cursors_use_js_utf16_lengths() {
        let mut output = Output::default();
        output.take(&"a".repeat(HEAD - 1));
        output.take("🌱");
        assert_eq!(output.total, HEAD as u64 + 1);
        let units = utf16_units(&output.read(0));
        assert_eq!(&units[HEAD - 1..], &[0xd83c, 0xdf31]);
        output.take(&"b".repeat(TAIL + 23));
        assert_eq!(output.dropped, 24);
        assert!(output.read(0).contains("…[24 characters dropped]…"));
        assert_eq!(output.read((HEAD + 1) as u64), "b".repeat(TAIL));
        let first = output.poll();
        assert!(!first.is_empty());
        assert!(output.poll().is_empty());
        output.take("new");
        assert_eq!(output.poll(), "new");
    }
    #[test]
    fn ansi_chunk_boundaries_are_preserved_not_reinterpreted() {
        let mut out = Output::default();
        out.take("\x1b[31mred\x1b[0m\x1b]0;title\x07!\x1b(B\x1b=");
        assert_eq!(out.read(0), "red!");
        let mut split = Output::default();
        split.take("\x1b[");
        split.take("31mred");
        assert_eq!(split.read(0), "\x1b[31mred");
    }
    #[test]
    fn terminal_progress_and_repeat_counts_match_source() {
        assert_eq!(
            terminal_text("start\r10%\r20%\r\nline\nline\nline\n\n\n"),
            "20%\nline\n… (line above repeated 2 more times)\n\n\n"
        );
        assert_eq!(
            terminal_text("a\ra\nlast\nlast"),
            "a\nlast\n… (line above repeated 1 more time)"
        );
    }
    #[test]
    fn javascript_fixed_rounding_is_not_rust_ties_to_even() {
        assert_eq!(fixed_one(0.15), "0.1");
        assert_eq!(fixed_one(0.25), "0.3");
        assert_eq!(fixed_one(1.25), "1.3");
        assert_eq!(fixed_one(2.55), "2.5");
        assert_eq!(fixed_one(1.0), "1.0");
    }
}
