use crate::ApiError;
use serde_json::Value;
use tepora_core::json_codec;

/// Strict, incremental UTF-8 NDJSON with the source's 262144 UTF-16-unit
/// pending-frame bound. It cannot silently replace a broken UTF-8 sequence.
#[derive(Default)]
pub struct PullPackets {
    text: String,
    tail: Vec<u8>,
    units: usize,
    started: bool,
}
impl PullPackets {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, ApiError> {
        self.tail.extend_from_slice(bytes);
        let valid = match std::str::from_utf8(&self.tail) {
            Ok(_) => self.tail.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => return Err(ApiError::new(502, "Invalid UTF-8 download progress")),
        };
        let mut text = std::str::from_utf8(&self.tail[..valid]).unwrap();
        if !self.started && !text.is_empty() {
            self.started = true;
            text = text.strip_prefix('\u{feff}').unwrap_or(text);
        }
        self.units += text.chars().map(char::len_utf16).sum::<usize>();
        if self.units > 262144 {
            return Err(ApiError::new(502, "Download progress frame is too large"));
        }
        self.text.push_str(text);
        self.tail.drain(..valid);
        let mut packets = vec![];
        let mut end = 0;
        for (index, _) in self.text.match_indices('\n') {
            let line = &self.text[end..index];
            let line = line.trim_matches(super::manager::js_whitespace);
            if !line.is_empty() {
                packets.push(
                    json_codec::parse(line)
                        .map_err(|_| ApiError::new(502, "Invalid download progress JSON"))?,
                );
            }
            end = index + 1;
        }
        if end > 0 {
            self.units -= self.text[..end].chars().map(char::len_utf16).sum::<usize>();
            self.text.drain(..end);
        }
        Ok(packets)
    }
    pub fn finish(mut self) -> Result<Vec<Value>, ApiError> {
        if !self.tail.is_empty() {
            return Err(ApiError::new(502, "Invalid UTF-8 download progress"));
        }
        let last = self.text.trim_matches(super::manager::js_whitespace);
        if last.is_empty() {
            Ok(vec![])
        } else {
            let value = json_codec::parse(last)
                .map_err(|_| ApiError::new(502, "Invalid download progress JSON"))?;
            self.text.clear();
            Ok(vec![value])
        }
    }
}
