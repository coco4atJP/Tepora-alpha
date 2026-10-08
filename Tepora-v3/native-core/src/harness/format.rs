use super::*;

pub(super) fn one_line(value: Option<&Value>, max: usize) -> String {
    let s = value
        .filter(|v| !v.is_null())
        .map(|v| js(v))
        .unwrap_or_default();
    let mut out = String::new();
    let mut space = false;
    for c in s.chars() {
        if whitespace(c) {
            if !out.is_empty() {
                space = true;
            }
        } else {
            if space {
                out.push(' ');
                space = false;
            }
            out.push(c);
        }
    }
    if len(&out) > max {
        format!(
            "{}…",
            slice(
                &out,
                0,
                if max == 0 {
                    len(&out).saturating_sub(1)
                } else {
                    max - 1
                }
            )
        )
    } else {
        out
    }
}
fn pretty(v: &Value, depth: usize) -> String {
    match v {
        Value::Array(a) if !a.is_empty() => format!(
            "[\n{}\n{}]",
            a.iter()
                .map(|x| format!("{}{}", " ".repeat(depth + 1), pretty(x, depth + 1)))
                .collect::<Vec<_>>()
                .join(",\n"),
            " ".repeat(depth)
        ),
        Value::Object(a) if !a.is_empty() => format!(
            "{{\n{}\n{}}}",
            entries(v)
                .iter()
                .map(|(k, x)| format!(
                    "{}{}: {}",
                    " ".repeat(depth + 1),
                    quoted(k),
                    pretty(x, depth + 1)
                ))
                .collect::<Vec<_>>()
                .join(",\n"),
            " ".repeat(depth)
        ),
        _ => json_codec::encode_text(&json_codec::stringify_js(v).unwrap_or_default()),
    }
}
fn quoted(s: &str) -> String {
    json_codec::encode_text(&json_codec::stringify_js(&json!(s)).unwrap_or_default())
}
pub(super) fn to_text(v: Option<&Value>) -> String {
    let Some(v) = v else {
        return "(no output)".into();
    };
    if v.is_null() {
        return "(no output)".into();
    }
    if let Some(s) = v.as_str() {
        return s.into();
    }
    if let Some(s) = v.get("text").and_then(Value::as_str) {
        if entries(v)
            .iter()
            .all(|(k, _)| matches!(k.as_str(), "text" | "data" | "images"))
        {
            return s.into();
        }
    }
    pretty(v, 0)
}
pub(super) fn fit(text: &str, max: f64, reference: &str, e: Estimator) -> Value {
    let total = e.raw_text_tokens(text) as f64;
    if total <= max {
        return json!({"text":text,"truncated":false});
    }
    let length = len(text);
    let keep = (max * length as f64 / total).floor().max(200.) as usize;
    let head = (keep as f64 * 0.7).floor() as usize;
    let tail = keep - head;
    let cut = length as i64 - head as i64 - tail as i64;
    let cut = if cut < 0 {
        format!("-{}", grouped((-cut) as usize))
    } else {
        grouped(cut as usize)
    };
    // JS slice with a negative start counts backwards from the end.
    let start = if tail > length {
        length.saturating_sub(tail - length)
    } else {
        length - tail
    };
    json!({"text":format!("{}\n…[{} characters omitted of {}; recall(\"{}\", offset={}) reads the rest]…\n{}",slice(text,0,head),cut,grouped(length),reference,head,slice(text,start,length)),"truncated":true})
}
pub(super) fn args_label(args: &Value) -> String {
    if !args.is_object() && !args.is_array() {
        return String::new();
    }
    let mut parts = Vec::new();
    for (k, v) in entries(args) {
        if v.is_null() || v.as_str() == Some("") {
            continue;
        }
        let s = match &v {
            Value::String(s) => quoted(&if len(s) > 60 {
                format!("{}…", slice(s, 0, 57))
            } else {
                s.clone()
            }),
            Value::Array(a) => format!("[{}]", a.len()),
            Value::Object(_) => "{…}".into(),
            _ => js(&v),
        };
        parts.push(format!("{k}={s}"));
        if len(&parts.join(" ")) > 110 {
            break;
        }
    }
    one_line(Some(&json!(parts.join(" "))), 120)
}
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Object(_), _)
        | (_, Value::Object(_))
        | (Value::Array(_), _)
        | (_, Value::Array(_)) => false,
        _ => a == b,
    }
}
fn check(schema: &Value, args: Option<&Value>, path: &str) -> Option<String> {
    if !schema.is_object() && !schema.is_array() {
        return None;
    }
    if schema["type"] == "object" {
        let Some(args) = args.filter(|a| a.is_object()) else {
            return Some(format!("{path} must be an object"));
        };
        for key in arr(schema, "required") {
            let k = js(key);
            if args.get(&k).is_none() {
                return Some(format!("{path}.{k} is required"));
            }
        }
        for (k, v) in entries(args) {
            let sub = schema.get("properties").and_then(|s| s.get(&k));
            if sub.is_none_or(|v| !truthy(v)) {
                if schema["additionalProperties"] == false {
                    return Some(format!(
                        "{path}.{k} is not a known parameter (expected: {})",
                        entries(&schema["properties"])
                            .iter()
                            .map(|(k, _)| k.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
                continue;
            }
            if let Some(e) = check(sub.unwrap(), Some(&v), &format!("{path}.{k}")) {
                return Some(e);
            }
        }
        return None;
    }
    let Some(args) = args.filter(|v| !v.is_null()) else {
        return None;
    };
    if truth(schema, "enum") && !arr(schema, "enum").iter().any(|x| same(x, args)) {
        return Some(format!(
            "{path} must be one of {}",
            arr(schema, "enum")
                .iter()
                .map(|x| json_codec::encode_text(&json_codec::stringify_js(x).unwrap()))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    let bad = match schema["type"].as_str().unwrap_or("") {
        "string" if !args.is_string() => Some("a string"),
        "integer"
            if !args
                .as_f64()
                .is_some_and(|n| n.is_finite() && n.fract() == 0.) =>
        {
            Some("an integer")
        }
        "number" if !args.is_number() => Some("a number"),
        "boolean" if !args.is_boolean() => Some("true or false"),
        "array" if !args.is_array() => Some("an array"),
        _ => None,
    };
    if let Some(bad) = bad {
        return Some(format!("{path} must be {bad}"));
    }
    if schema["type"] == "array" && truth(schema, "items") {
        for (i, v) in args.as_array().unwrap().iter().enumerate() {
            if let Some(e) = check(&schema["items"], Some(v), &format!("{path}[{i}]")) {
                return Some(e);
            }
        }
    }
    if let Some(n) = args.as_f64() {
        if let Some(min) = schema.get("minimum") {
            if n < number(min) {
                return Some(format!("{path} must be ≥ {}", js(min)));
            }
        }
        if let Some(max) = schema.get("maximum") {
            if n > number(max) {
                return Some(format!("{path} must be ≤ {}", js(max)));
            }
        }
    }
    None
}
pub(super) fn repair(text: &str) -> Option<String> {
    let mut s = text.to_string();
    if s.starts_with("```") {
        s = s[3..].into();
        if s.get(..4).is_some_and(|x| x.eq_ignore_ascii_case("json")) {
            s = s[4..].into()
        }
        s = s.trim_start_matches(whitespace).into()
    }
    if s.ends_with("```") {
        s = s[..s.len() - 3].trim_end_matches(whitespace).into()
    }
    s = trim(&s).into();
    s = s[s.find('{')?..].into();
    // Deliberately matches the original permissive repair, even inside quoted data.
    let re=regex::Regex::new(r",[\x09-\x0d \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*([}\]])").unwrap();
    s = re.replace_all(&s, "$1").into_owned();
    let mut stack = Vec::new();
    let mut quoted = false;
    let mut escape = false;
    let mut end = None;
    for (i, c) in s.char_indices() {
        if quoted {
            if escape {
                escape = false
            } else if c == '\\' {
                escape = true
            } else if c == '"' {
                quoted = false
            }
            continue;
        }
        match c {
            '"' => quoted = true,
            '{' => stack.push('}'),
            '[' => stack.push(']'),
            '}' | ']' => {
                if stack.pop() != Some(c) {
                    return None;
                }
                if stack.is_empty() {
                    end = Some(i + c.len_utf8());
                    break;
                }
            }
            _ => {}
        }
    }
    if let Some(end) = end {
        return Some(s[..end].into());
    }
    if quoted {
        s.push('"')
    }
    let t = s.trim_end_matches(whitespace);
    if let Some(x) = t.strip_suffix(',') {
        s = x.into()
    }
    for c in stack.into_iter().rev() {
        s.push(c)
    }
    Some(s)
}
pub(super) fn call(op: &str, p: &Value) -> CoreResult<Value> {
    Ok(match op {
        "toText" => json!(to_text(p.get("result"))),
        "fitTokens" => fit(
            &text(p, "text"),
            num(p, "maxTokens", f64::NAN),
            &text(p, "ref"),
            tokens(p),
        ),
        "oneLine" => json!(one_line(
            p.get("value"),
            num(p, "max", 90.).max(0.) as usize
        )),
        "argsLabel" => json!(args_label(&p["args"])),
        "defaultStub" => {
            let t = text(p, "text");
            let head = if truth(p, "error") {
                format!("error: {}", one_line(p.get("error"), 80))
            } else {
                one_line(
                    Some(&json!(t
                        .split('\n')
                        .find(|l| !trim(l).is_empty())
                        .unwrap_or(""))),
                    70,
                )
            };
            json!(format!(
                "{}({}) → {} [{} chars]",
                text(p, "name"),
                args_label(&p["args"]),
                head,
                grouped(len(&t))
            ))
        }
        "checkArgs" => json!(check(
            &p["schema"],
            p.get("args"),
            p["path"].as_str().unwrap_or("arguments")
        )),
        "repairJSON" => json!(repair(&text(p, "text"))),
        "parseArgs" => {
            let source = js_string(p.get("raw").filter(|v| !v.is_null()).or(Some(&json!(""))));
            let source = trim(&source);
            if source.is_empty() {
                json!({"args":{},"repaired":false})
            } else if let Ok(v) = json_codec::parse_js_text(source) {
                if v.is_object() {
                    json!({"args":v,"repaired":false})
                } else {
                    json!({"error":"arguments must be a JSON object"})
                }
            } else if let Some(v) = repair(source)
                .and_then(|s| json_codec::parse_js_text(&s).ok())
                .filter(Value::is_object)
            {
                json!({"args":v,"repaired":true})
            } else {
                json!({"error":format!("arguments are not valid JSON ({})",slice(&json_error(source),0,120))})
            }
        }
        _ => return Err(invalid(format!("Unknown format operation: {op}"))),
    })
}

// V8 JSON diagnostics are part of the model-visible repair feedback. Scan UTF-16
// units so positions and columns stay identical for astral and lone surrogates.
fn json_error(source: &str) -> String {
    struct Scan<'a> {
        u: Vec<u16>,
        i: usize,
        source: &'a str,
    }
    impl Scan<'_> {
        fn ws(&mut self) {
            while self
                .u
                .get(self.i)
                .is_some_and(|c| matches!(*c, 9 | 10 | 13 | 32))
            {
                self.i += 1;
            }
        }
        fn pos(&self, label: &str) -> String {
            let mut line = 1;
            let mut col = 1;
            let mut i = 0;
            while i < self.i.min(self.u.len()) {
                match self.u[i] {
                    13 => {
                        line += 1;
                        col = 1;
                        if self.u.get(i + 1) == Some(&10) && i + 1 < self.i {
                            i += 1
                        }
                    }
                    10 => {
                        line += 1;
                        col = 1
                    }
                    _ => col += 1,
                }
                i += 1;
            }
            format!(
                "{label}{} at position {} (line {line} column {col})",
                if label.ends_with("after JSON") {
                    ""
                } else {
                    " in JSON"
                },
                self.i
            )
        }
        fn unexpected(&self) -> String {
            let Some(&c) = self.u.get(self.i) else {
                return "Unexpected end of JSON input".into();
            };
            if matches!(
                self.source,
                "undefined" | "NaN" | "Infinity" | "[object Object]"
            ) {
                return format!("\"{}\" is not valid JSON", self.source);
            }
            if matches!(c, 45 | 48..=57) {
                return self.pos("Unexpected number");
            }
            if c == 34 {
                return self.pos("Unexpected string");
            }
            let n = self.u.len();
            let (start, end) = if n <= 20 {
                (0, n)
            } else {
                (self.i.saturating_sub(10), (self.i + 10).min(n))
            };
            let excerpt = format!(
                "{}\"{}\"{}",
                if n > 20 && self.i >= 10 { "..." } else { "" },
                json_codec::from_utf16_units(&self.u[start..end]),
                if end < n { "..." } else { "" }
            );
            format!(
                "Unexpected token '{}', {} is not valid JSON",
                json_codec::from_utf16_units(&[c]),
                excerpt
            )
        }
        fn string(&mut self) -> Result<(), String> {
            self.i += 1;
            loop {
                let Some(&c) = self.u.get(self.i) else {
                    return Err(self.pos("Unterminated string"));
                };
                if c == 34 {
                    self.i += 1;
                    return Ok(());
                }
                if c < 32 {
                    return Err(self.pos("Bad control character in string literal"));
                }
                if c == 92 {
                    self.i += 1;
                    let Some(&c) = self.u.get(self.i) else {
                        return Err(self.pos("Unterminated string"));
                    };
                    if c == 117 {
                        for _ in 0..4 {
                            self.i += 1;
                            if !self
                                .u
                                .get(self.i)
                                .is_some_and(|c| matches!(*c,48..=57|65..=70|97..=102))
                            {
                                return Err(self.pos("Bad Unicode escape"));
                            }
                        }
                    } else if !matches!(c, 34 | 92 | 47 | 98 | 102 | 110 | 114 | 116) {
                        return Err(if c > 255 {
                            self.unexpected()
                        } else {
                            self.pos("Bad escaped character")
                        });
                    }
                }
                self.i += 1;
            }
        }
        fn value(&mut self) -> Result<(), String> {
            self.ws();
            match self.u.get(self.i).copied() {
                Some(123) => {
                    self.i += 1;
                    self.ws();
                    if self.u.get(self.i) == Some(&125) {
                        self.i += 1;
                        return Ok(());
                    }
                    if self.u.get(self.i) != Some(&34) {
                        return Err(self.pos("Expected property name or '}'"));
                    }
                    loop {
                        self.string()?;
                        self.ws();
                        if self.u.get(self.i) != Some(&58) {
                            return Err(self.pos("Expected ':' after property name"));
                        }
                        self.i += 1;
                        self.value()?;
                        self.ws();
                        match self.u.get(self.i) {
                            Some(125) => {
                                self.i += 1;
                                return Ok(());
                            }
                            Some(44) => {
                                self.i += 1;
                                self.ws();
                                if self.u.get(self.i) != Some(&34) {
                                    return Err(self.pos("Expected double-quoted property name"));
                                }
                            }
                            _ => return Err(self.pos("Expected ',' or '}' after property value")),
                        }
                    }
                }
                Some(91) => {
                    self.i += 1;
                    self.ws();
                    if self.u.get(self.i) == Some(&93) {
                        self.i += 1;
                        return Ok(());
                    }
                    loop {
                        self.value()?;
                        self.ws();
                        match self.u.get(self.i) {
                            Some(93) => {
                                self.i += 1;
                                return Ok(());
                            }
                            Some(44) => self.i += 1,
                            _ => return Err(self.pos("Expected ',' or ']' after array element")),
                        }
                    }
                }
                Some(34) => self.string(),
                Some(116) | Some(102) | Some(110) => {
                    let expected = match self.u[self.i] {
                        116 => "true",
                        102 => "false",
                        _ => "null",
                    };
                    for c in expected.encode_utf16() {
                        if self.u.get(self.i) != Some(&c) {
                            return Err(self.unexpected());
                        }
                        self.i += 1;
                    }
                    Ok(())
                }
                Some(45) | Some(48..=57) => {
                    if self.u[self.i] == 45 {
                        self.i += 1;
                        if !self.u.get(self.i).is_some_and(|c| matches!(*c, 48..=57)) {
                            return Err(self.pos("No number after minus sign"));
                        }
                    }
                    if self.u.get(self.i) == Some(&48) {
                        self.i += 1;
                        if self.u.get(self.i).is_some_and(|c| matches!(*c, 48..=57)) {
                            return Err(self.pos("Unexpected number"));
                        }
                    } else {
                        while self.u.get(self.i).is_some_and(|c| matches!(*c, 48..=57)) {
                            self.i += 1
                        }
                    }
                    if self.u.get(self.i) == Some(&46) {
                        self.i += 1;
                        if !self.u.get(self.i).is_some_and(|c| matches!(*c, 48..=57)) {
                            return Err(self.pos("Unterminated fractional number"));
                        }
                        while self.u.get(self.i).is_some_and(|c| matches!(*c, 48..=57)) {
                            self.i += 1
                        }
                    }
                    if self.u.get(self.i).is_some_and(|c| matches!(*c, 69 | 101)) {
                        self.i += 1;
                        if self.u.get(self.i).is_some_and(|c| matches!(*c, 43 | 45)) {
                            self.i += 1
                        }
                        if !self.u.get(self.i).is_some_and(|c| matches!(*c, 48..=57)) {
                            return Err(self.pos("Exponent part is missing a number"));
                        }
                        while self.u.get(self.i).is_some_and(|c| matches!(*c, 48..=57)) {
                            self.i += 1
                        }
                    }
                    Ok(())
                }
                _ => Err(self.unexpected()),
            }
        }
    }
    let mut s = Scan {
        u: json_codec::utf16_units(source),
        i: 0,
        source,
    };
    match s.value() {
        Err(e) => e,
        Ok(()) => {
            s.ws();
            if s.i < s.u.len() {
                s.pos("Unexpected non-whitespace character after JSON")
            } else {
                "Unexpected end of JSON input".into()
            }
        }
    }
}
