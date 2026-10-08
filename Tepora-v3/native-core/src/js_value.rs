//! JavaScript primitive coercion shared by JSON-backed compatibility domains.
//!
//! Strings use `json_codec`'s internal encoding throughout. These helpers model
//! ordinary JSON data; executable properties, Symbols and custom prototypes
//! cannot cross the JSON boundary and are not interpreted here.
use super::{json_codec, Value};

pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `String(value)` for ordinary JSON data; `None` represents `undefined`.
/// Array null entries become empty fields, matching `Array.prototype.join`.
/// Object properties named `toString` are data, not executable overrides.
pub fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Number(value)) => json_codec::number_text(value),
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(Some(value))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn truthiness_matches_javascript_json_values() {
        for value in [Value::Null, json!(false), json!(0), json!(-0.0), json!("")] {
            assert!(!truthy(&value), "{value}");
        }
        for value in [
            json!(true),
            json!(1),
            json!(-1),
            json!("0"),
            json!([]),
            json!({}),
        ] {
            assert!(truthy(&value), "{value}");
        }
    }

    #[test]
    fn string_coercion_preserves_internal_strings_and_array_join_semantics() {
        assert_eq!(js_string(None), "undefined");
        for (value, expected) in [
            (json!(null), "null"),
            (json!(false), "false"),
            (json!(true), "true"),
            (json!(-0.0), "0"),
            (json!(1e21), "1e+21"),
            (json!({}), "[object Object]"),
            (json!([]), ""),
            (
                json!([null, [1, null, [2, 3]], {}, false, []]),
                ",1,,2,3,[object Object],false,",
            ),
        ] {
            assert_eq!(js_string(Some(&value)), expected);
        }
        let value = json_codec::parse(r#""\ue000\ue100\ud800""#).unwrap();
        assert_eq!(
            json_codec::utf16_units(&js_string(Some(&value))),
            [0xe000, 0xe100, 0xd800]
        );
    }
}
