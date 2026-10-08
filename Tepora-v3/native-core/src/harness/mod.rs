//! Pure native ports of the agent harness. All inputs are snapshots; effects and
//! clocks belong to the host. Strings retain the core's lossless UTF-16 encoding.
use crate::{
    invalid,
    js_value::{js_string, truthy},
    json_codec,
    tokens::Estimator,
    CoreResult,
};
use serde_json::{json, Map, Value};
mod compaction;
mod format;
mod metacog;
mod prompts;

pub fn call_json(op: &str, payload_json: &str) -> CoreResult<String> {
    json_codec::stringify(&call(op, &json_codec::parse(payload_json)?)?)
}
pub(crate) fn call(op: &str, p: &Value) -> CoreResult<Value> {
    let op = op.strip_prefix("harness.").unwrap_or(op);
    match op.split_once('.') {
        Some(("format", op)) => format::call(op, p),
        Some(("prompts", op)) => prompts::call(op, p),
        Some(("compaction", op)) => compaction::call(op, p),
        Some(("metacog", op)) => metacog::call(op, p),
        _ => Err(invalid(format!("Unknown harness operation: {op}"))),
    }
}
fn text(v: &Value, k: &str) -> String {
    js_string(v.get(k))
}
fn js(v: &Value) -> String {
    js_string(Some(v))
}
fn truth(v: &Value, k: &str) -> bool {
    v.get(k).is_some_and(truthy)
}
fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn num(v: &Value, k: &str, default: f64) -> f64 {
    v.get(k).map(number).unwrap_or(default)
}
fn number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.,
        Value::Bool(b) => {
            if *b {
                1.
            } else {
                0.
            }
        }
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let s = trim(s);
            if s.is_empty() {
                0.
            } else {
                s.parse().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}
fn round(n: f64) -> f64 {
    if !n.is_finite() {
        return n;
    }
    let floor = n.floor();
    if n - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    }
}
fn tokens(p: &Value) -> Estimator {
    Estimator::from_payload(p)
}
fn whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn trim(s: &str) -> &str {
    s.trim_matches(whitespace)
}
fn len(s: &str) -> usize {
    json_codec::utf16_units(s).len()
}
fn slice(s: &str, start: usize, end: usize) -> String {
    let u = json_codec::utf16_units(s);
    json_codec::from_utf16_units(&u[start.min(u.len())..end.min(u.len()).max(start.min(u.len()))])
}
fn one_line(v: Option<&Value>, max: usize) -> String {
    format::one_line(v, max)
}
fn grouped(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}
fn entries(v: &Value) -> Vec<(String, Value)> {
    let mut out: Vec<_> = match v {
        Value::Object(m) => m.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        Value::Array(a) => a
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        _ => Vec::new(),
    };
    out.sort_by_key(|(k, _)| {
        let n = k
            .parse::<u32>()
            .ok()
            .filter(|&n| n < u32::MAX && n.to_string() == *k);
        n.map(|n| (false, n)).unwrap_or((true, 0))
    });
    out
}
