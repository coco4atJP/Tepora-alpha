//! Mechanical HTML extractor for core/tools/html.mjs. Input/output strings use
//! the internal JSON codec; only URL's USVString boundary replaces lone units.
use regex::{Captures, Regex};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tepora_core::json_codec::{encode_text, from_utf16_units, sql_text, utf16_units};
use url::Url;

const WS: &str =
    r"[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]";
fn re(pattern: &str) -> Regex {
    static CACHE: OnceLock<Mutex<HashMap<String, Regex>>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    cache
        .entry(pattern.into())
        .or_insert_with(|| Regex::new(pattern).expect("fixed HTML regex"))
        .clone()
}
fn ci(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphabetic() {
                format!("[{}{}]", c.to_ascii_lowercase(), c.to_ascii_uppercase())
            } else {
                regex::escape(&c.to_string())
            }
        })
        .collect()
}
fn space(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn trim(s: &str) -> &str {
    s.trim_matches(space)
}
fn collapse(s: &str) -> String {
    re(&format!("{WS}+")).replace_all(s, " ").into_owned()
}
fn len(s: &str) -> usize {
    utf16_units(s).len()
}
fn slice(s: &str, max: usize) -> String {
    let u = utf16_units(s);
    from_utf16_units(&u[..u.len().min(max)])
}
fn named(s: &str) -> Option<&'static str> {
    Some(match s {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        "copy" => "©",
        "reg" => "®",
        "trade" => "™",
        "hellip" => "…",
        "mdash" => "—",
        "ndash" => "–",
        "laquo" => "«",
        "raquo" => "»",
        "ldquo" => "“",
        "rdquo" => "”",
        "lsquo" => "‘",
        "rsquo" => "’",
        "bull" => "•",
        "middot" => "·",
        "times" => "×",
        "divide" => "÷",
        "deg" => "°",
        "yen" => "¥",
        "euro" => "€",
        "pound" => "£",
        "cent" => "¢",
        "sect" => "§",
        "para" => "¶",
        "larr" => "←",
        "rarr" => "→",
        "uarr" => "↑",
        "darr" => "↓",
        "zwj" | "zwnj" | "shy" => "",
        _ => return None,
    })
}
pub fn decode_entities(s: &str) -> String {
    re(r"&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+[0-9]*);?")
        .replace_all(s, |c: &Captures| {
            let e = &c[1];
            if let Some(digits) = e.strip_prefix('#') {
                let (digits, radix) = if digits.starts_with(['x', 'X']) {
                    (&digits[1..], 16)
                } else {
                    (digits, 10)
                };
                match u32::from_str_radix(digits, radix)
                    .ok()
                    .filter(|n| *n > 0 && *n < 0x110000)
                {
                    Some(n) if n <= 0xffff => from_utf16_units(&[n as u16]),
                    Some(n) => encode_text(&char::from_u32(n).unwrap().to_string()),
                    None => c[0].to_owned(),
                }
            } else {
                named(&e.to_ascii_lowercase())
                    .map(str::to_owned)
                    .unwrap_or_else(|| c[0].to_owned())
            }
        })
        .into_owned()
}
fn attr(attrs: &str, name: &str) -> Option<String> {
    let pattern = format!(
        r#"(?:^|{WS}){}{WS}*={WS}*(?:"([^"]*)"|'([^']*)'|([^\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF"'>]+))"#,
        ci(name)
    );
    re(&pattern).captures(attrs).map(|c| {
        decode_entities(
            (1..=3)
                .find_map(|i| c.get(i))
                .map(|m| m.as_str())
                .unwrap_or(""),
        )
    })
}
fn absolute(href: Option<String>, base: &str) -> Option<String> {
    let h = href.filter(|s| !s.is_empty())?;
    let h = trim(&h);
    let lower = h.to_ascii_lowercase();
    if ["javascript:", "data:", "mailto:", "tel:"]
        .iter()
        .any(|p| lower.starts_with(p))
    {
        return h.starts_with("mailto:").then(|| h.into());
    }
    let base = Url::parse(&sql_text(base)).ok()?;
    base.join(&sql_text(h))
        .ok()
        .map(|u| encode_text(u.as_str()))
}
fn strip(mut html: String, tags: &[&str]) -> String {
    for tag in tags {
        let t = ci(tag);
        html = re(&format!(r"<{t}(?-u:\b)[^>]*>[\s\S]*?</{t}{WS}*>"))
            .replace_all(&html, " ")
            .into_owned();
    }
    html
}
fn text_len(s: &str) -> usize {
    len(&collapse(&re(r"<[^>]+>").replace_all(s, "")))
}
fn pick_main(html: &str) -> Result<String, HtmlError> {
    let mut candidates = Vec::new();
    for tag in ["main", "article"] {
        let t = ci(tag);
        for c in re(&format!(r"<{t}(?-u:\b)[^>]*>([\s\S]*?)</{t}{WS}*>")).captures_iter(html) {
            if candidates.len() >= MAX_HTML_NODES {
                return Err(limit("HTML extraction node budget exceeded"));
            }
            let text = c[1].to_owned();
            candidates.push((text_len(&text), text));
        }
    }
    // Compute each candidate's weight once. Comparator rescans would amplify work.
    candidates.sort_by_key(|(size, _)| std::cmp::Reverse(*size));
    let body = re(&format!(
        r"<{}(?-u:\b)[^>]*>([\s\S]*)</{}{WS}*>",
        ci("body"),
        ci("body")
    ))
    .captures(html)
    .map(|c| c[1].to_owned())
    .unwrap_or_else(|| html.into());
    let threshold = (800f64).min(text_len(&body) as f64 * 0.25);
    if let Some((_, best)) = candidates
        .first()
        .filter(|(size, _)| *size as f64 > threshold)
    {
        Ok(best.clone())
    } else {
        Ok(strip(body, &["nav", "footer", "aside", "header", "form"]))
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Markdown {
    pub title: String,
    pub description: String,
    pub markdown: String,
}
impl Markdown {
    pub fn value(&self) -> Value {
        json!({"title":self.title,"description":self.description,"markdown":self.markdown})
    }
}
/// Deliberate safety boundary for untrusted extraction. No truncated success.
pub const MAX_OUTPUT_BYTES: usize = 24 * 1024 * 1024;
pub const MAX_RENDER_DEPTH: usize = 256;
pub const MAX_HTML_NODES: usize = 200_000;
pub const MAX_RENDER_WORK: usize = 2_000_000;
#[derive(Clone, Debug)]
pub struct HtmlError {
    pub status: u16,
    pub message: String,
}
fn limit(message: &str) -> HtmlError {
    HtmlError {
        status: 413,
        message: message.into(),
    }
}
fn checked_sum(values: &[usize]) -> Result<usize, HtmlError> {
    values.iter().try_fold(0usize, |a, b| {
        a.checked_add(*b)
            .ok_or_else(|| limit("HTML extraction output exceeds budget"))
    })
}
#[derive(Default)]
struct State {
    out: Vec<String>,
    line: String,
    pre: usize,
    lists: Vec<(bool, usize)>,
    link: Option<(Option<String>, String)>,
    table: Option<Vec<Vec<String>>>,
    row: Option<usize>,
    cell: Option<Vec<String>>,
    quote: usize,
    out_bytes: usize,
    cell_bytes: usize,
    table_bytes: usize,
    nodes: usize,
    work: usize,
}
impl State {
    fn capacity(&self, additional: usize) -> Result<(), HtmlError> {
        let current = checked_sum(&[
            self.out_bytes,
            self.line.len(),
            self.cell_bytes,
            self.link.as_ref().map_or(0, |(_, s)| s.len()),
            additional,
        ])?;
        if current > MAX_OUTPUT_BYTES {
            Err(limit("HTML extraction output exceeds 24 MiB"))
        } else {
            Ok(())
        }
    }
    fn work(&mut self, amount: usize) -> Result<(), HtmlError> {
        self.work = self
            .work
            .checked_add(amount)
            .ok_or_else(|| limit("HTML extraction work budget exceeded"))?;
        if self.work > MAX_RENDER_WORK {
            return Err(limit("HTML extraction work budget exceeded"));
        }
        Ok(())
    }
    fn node(&mut self) -> Result<(), HtmlError> {
        self.nodes += 1;
        if self.nodes > MAX_HTML_NODES {
            return Err(limit("HTML extraction node budget exceeded"));
        }
        self.work(1)
    }
    fn depth(&self) -> Result<(), HtmlError> {
        if checked_sum(&[self.pre, self.quote, self.lists.len()])? > MAX_RENDER_DEPTH {
            Err(limit("HTML extraction nesting exceeds 256"))
        } else {
            Ok(())
        }
    }
    fn emit(&mut self, s: &str) -> Result<(), HtmlError> {
        self.capacity(s.len())?;
        if let Some(cell) = self.cell.as_mut() {
            cell.push(s.into());
            self.cell_bytes += s.len();
        } else if let Some((_, text)) = self.link.as_mut() {
            text.push_str(s);
        } else {
            self.line.push_str(s);
        }
        Ok(())
    }
    fn push(&mut self, text: String) -> Result<(), HtmlError> {
        let next = checked_sum(&[self.out_bytes, text.len(), 1])?;
        if next > MAX_OUTPUT_BYTES {
            return Err(limit("HTML extraction output exceeds 24 MiB"));
        }
        self.out_bytes = next;
        self.out.push(text);
        Ok(())
    }
    fn flush(&mut self, blank: bool) -> Result<(), HtmlError> {
        let mut text = if self.pre > 0 {
            std::mem::take(&mut self.line)
        } else {
            trim(&re(r"[ \t]+").replace_all(&self.line, " ")).to_owned()
        };
        if self.pre == 0 && !text.is_empty() {
            if let Some(c) = re(r"^( +)(?:-|[0-9]+\.) ").captures(&self.line) {
                let size = checked_sum(&[c[1].len(), text.len()])?;
                if size > MAX_OUTPUT_BYTES {
                    return Err(limit("HTML extraction output exceeds 24 MiB"));
                }
                text = format!("{}{text}", &c[1]);
            }
        }
        self.line.clear();
        if !text.is_empty() {
            let prefix = self
                .quote
                .checked_mul(2)
                .ok_or_else(|| limit("HTML extraction nesting exceeds budget"))?;
            self.capacity(checked_sum(&[prefix, text.len(), 1])?)?;
            self.push(format!("{}{text}", "> ".repeat(self.quote)))?;
        }
        if blank && self.out.last().is_none_or(|s| !s.is_empty()) {
            self.push(String::new())?;
        }
        Ok(())
    }
    fn table_budget(&mut self, rows: &[Vec<String>], width: usize) -> Result<(), HtmlError> {
        let cells = rows
            .len()
            .checked_mul(width)
            .ok_or_else(|| limit("HTML table exceeds work budget"))?;
        self.work(cells)?;
        let text = rows
            .iter()
            .flat_map(|r| r.iter())
            .try_fold(0usize, |n, s| {
                n.checked_add(s.len())
                    .ok_or_else(|| limit("HTML table exceeds output budget"))
            })?;
        let padding = cells
            .checked_mul(3)
            .ok_or_else(|| limit("HTML table exceeds output budget"))?;
        let headers = width
            .checked_mul(6)
            .ok_or_else(|| limit("HTML table exceeds output budget"))?;
        self.capacity(checked_sum(&[text, padding, headers, rows.len() * 2, 3])?)
    }
}
pub fn html_to_markdown(html: &str, url: &str, main: bool) -> Result<Markdown, HtmlError> {
    let html = re(r"<!--[\s\S]*?-->")
        .replace_all(&slice(html, 6_000_000), "")
        .into_owned();
    let html = re(r"<!\[CDATA\[[\s\S]*?\]\]>")
        .replace_all(&html, "")
        .into_owned();
    let title = re(&format!(
        r"<{}(?-u:\b)[^>]*>([\s\S]*?)</{}>",
        ci("title"),
        ci("title")
    ))
    .captures(&html)
    .map(|c| decode_entities(&c[1]))
    .unwrap_or_default();
    let title = trim(&collapse(&title)).to_owned();
    let desc = re(&format!(
        r#"<{}(?-u:\b)[^>]*{}{WS}*={WS}*["']{}["'][^>]*>"#,
        ci("meta"),
        ci("name"),
        ci("description")
    ))
    .find(&html)
    .and_then(|m| attr(m.as_str(), "content"))
    .unwrap_or_default();
    let base = re(&format!(r"<{}(?-u:\b)[^>]*>", ci("base")))
        .find(&html)
        .and_then(|m| attr(m.as_str(), "href"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| url.into());
    let html = strip(
        html,
        &[
            "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object",
            "embed", "head", "select", "button", "dialog",
        ],
    );
    let html = if main { pick_main(&html)? } else { html };
    let mut s = State::default();
    s.out_bytes = checked_sum(&[title.len(), desc.len()])?;
    s.capacity(0)?;
    for m in re(r"<(/?)([a-zA-Z][a-zA-Z0-9_:-]*)([^>]*)>|([^<]+)").captures_iter(&html) {
        s.node()?;
        if let Some(text) = m.get(4) {
            let text = decode_entities(text.as_str());
            s.emit(&if s.pre > 0 { text } else { collapse(&text) })?;
            continue;
        }
        let close = &m[1] == "/";
        let tag = m[2].to_ascii_lowercase();
        let attrs = &m[3];
        if tag.len() == 2 && tag.starts_with('h') && matches!(tag.as_bytes()[1], b'1'..=b'6') {
            s.flush(true)?;
            if !close {
                s.line = "#".repeat((tag.as_bytes()[1] - b'0') as usize) + " ";
            } else {
                s.flush(true)?;
            }
            continue;
        }
        match tag.as_str() {
            "br" => {
                if let Some(c) = s.cell.as_mut() {
                    if s.cell_bytes >= MAX_OUTPUT_BYTES {
                        return Err(limit("HTML extraction output exceeds 24 MiB"));
                    }
                    c.push(" ".into());
                    s.cell_bytes += 1;
                } else {
                    s.flush(false)?;
                }
            }
            "pre" => {
                if !close {
                    s.flush(true)?;
                    s.pre += 1;
                    s.depth()?;
                    s.push("```".into())?;
                } else {
                    s.flush(false)?;
                    s.pre = s.pre.saturating_sub(1);
                    s.push("```".into())?;
                    s.push(String::new())?;
                }
            }
            "code" if s.pre == 0 => s.emit("`")?,
            "blockquote" => {
                s.flush(true)?;
                s.quote = if close {
                    s.quote.saturating_sub(1)
                } else {
                    s.quote + 1
                };
                s.depth()?;
            }
            "ul" | "ol" => {
                s.flush(false)?;
                if !close {
                    s.lists.push((tag == "ol", 0));
                    s.depth()?;
                } else {
                    s.lists.pop();
                    if s.lists.is_empty() {
                        s.flush(true)?;
                    }
                }
            }
            "li" => {
                s.flush(false)?;
                if !close {
                    let indent_len = s
                        .lists
                        .len()
                        .saturating_sub(1)
                        .checked_mul(2)
                        .ok_or_else(|| limit("HTML extraction nesting exceeds budget"))?;
                    s.capacity(indent_len)?;
                    let indent = "  ".repeat(s.lists.len().saturating_sub(1));
                    let marker = if let Some((true, n)) = s.lists.last_mut() {
                        *n += 1;
                        format!("{n}. ")
                    } else {
                        "- ".into()
                    };
                    s.line = indent + &marker;
                }
            }
            "table" => {
                s.flush(true)?;
                if !close {
                    s.table = Some(vec![]);
                    s.table_bytes = 0;
                } else if let Some(table) = s.table.take() {
                    let rows = table
                        .into_iter()
                        .filter(|r| r.iter().any(|c| !c.is_empty()))
                        .collect::<Vec<_>>();
                    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
                    s.table_budget(&rows, width)?;
                    s.table_bytes = 0;
                    for (i, mut row) in rows.into_iter().enumerate() {
                        row.resize(width, String::new());
                        s.push(format!("| {} |", row.join(" | ")))?;
                        if i == 0 {
                            s.push(format!("|{}", " --- |".repeat(width)))?;
                        }
                    }
                    if width > 0 {
                        s.push(String::new())?;
                    }
                }
            }
            "tr" => {
                if let Some(table) = s.table.as_mut() {
                    if !close {
                        s.row = Some(table.len());
                        table.push(vec![]);
                    } else {
                        s.row = None;
                    }
                } else {
                    s.flush(false)?;
                }
            }
            "td" | "th" => {
                if let Some(row) = s.row {
                    if !close {
                        s.cell = Some(vec![]);
                        s.cell_bytes = 0;
                    } else if let Some(cell) = s.cell.take() {
                        s.cell_bytes = 0;
                        if let Some(table) = s.table.as_mut() {
                            if let Some(row) = table.get_mut(row) {
                                let raw = trim(&collapse(&cell.join(""))).to_owned();
                                let escaped_len = checked_sum(&[
                                    raw.len(),
                                    raw.bytes().filter(|b| *b == b'|').count(),
                                ])?;
                                s.table_bytes = checked_sum(&[s.table_bytes, escaped_len])?;
                                if s.table_bytes > MAX_OUTPUT_BYTES {
                                    return Err(limit("HTML table exceeds output budget"));
                                }
                                row.push(raw.replace('|', "\\|"));
                            }
                        }
                    }
                } else {
                    s.emit(" ")?;
                }
            }
            "a" => {
                if !close {
                    s.link = Some((absolute(attr(attrs, "href"), &base), String::new()));
                } else if let Some((href, text)) = s.link.take() {
                    let t = trim(&collapse(&text)).to_owned();
                    if let Some(href) = href.filter(|h| {
                        !t.is_empty()
                            && !h
                                .strip_prefix(&base)
                                .is_some_and(|rest| rest.starts_with('#'))
                            && !attr(attrs, "href").is_some_and(|h| h.starts_with('#'))
                    }) {
                        s.capacity(checked_sum(&[t.len(), href.len(), 4])?)?;
                        s.emit(&format!("[{t}]({href})"))?;
                    } else {
                        s.emit(&t)?;
                    }
                }
            }
            "img" => {
                let alt = attr(attrs, "alt").unwrap_or_default();
                let alt = trim(&alt);
                if !alt.is_empty() {
                    s.capacity(checked_sum(&[alt.len(), 9])?)?;
                    s.emit(&format!("[image: {alt}]"))?;
                }
            }
            "input" | "textarea" => {
                let label = attr(attrs, "placeholder")
                    .filter(|s| !s.is_empty())
                    .or_else(|| attr(attrs, "aria-label").filter(|s| !s.is_empty()))
                    .or_else(|| attr(attrs, "name").filter(|s| !s.is_empty()));
                let typ = attr(attrs, "type")
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "text".into())
                    .to_ascii_lowercase();
                if let Some(label) =
                    label.filter(|_| !matches!(typ.as_str(), "hidden" | "submit" | "button"))
                {
                    s.capacity(checked_sum(&[label.len(), 11])?)?;
                    s.emit(&format!(" [input: {label}] "))?;
                }
            }
            "p" | "div" | "section" | "article" | "main" | "header" | "footer" | "aside"
            | "nav" | "form" | "fieldset" | "figure" | "figcaption" | "address" | "details"
            | "summary" | "dl" | "dt" | "dd" | "center" | "hr" => {
                if !s.lists.is_empty()
                    && re(&format!(r"^{WS}*(?:-|[0-9]+\.){WS}*$")).is_match(&s.line)
                {
                    continue;
                }
                s.flush(matches!(tag.as_str(), "p" | "section" | "article" | "hr"))?;
                if tag == "hr" && !close {
                    s.push("---".into())?;
                }
            }
            _ => {}
        }
    }
    s.flush(false)?;
    let markdown = trim(&re(r"\n{3,}").replace_all(&s.out.join("\n"), "\n\n")).to_owned();
    Ok(Markdown {
        title,
        description: desc,
        markdown,
    })
}
pub fn parse_duckduckgo(html: &str) -> Result<Vec<Value>, String> {
    fn clean(s: &str) -> String {
        trim(&collapse(&decode_entities(
            &re(r"<[^>]+>").replace_all(s, ""),
        )))
        .to_owned()
    }
    let mut results = Vec::new();
    for block in re(r#"class="[^"]*(?-u:\b)result(?-u:\b)[^"]*""#)
        .split(html)
        .skip(1)
    {
        let Some(a) =
            re(r#"<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>"#)
                .captures(block)
        else {
            continue;
        };
        let mut href = decode_entities(&a[1]);
        if let Some(u) = re(r"[?&]uddg=([^&]+)").captures(&href) {
            href = decode_component(&u[1])?;
        } else if href.starts_with("//") {
            href = "https:".to_owned() + &href;
        }
        if re(r"duckduckgo\.com/y\.js").is_match(&href)
            || results
                .iter()
                .any(|r: &Value| r["url"].as_str() == Some(&href))
        {
            continue;
        }
        let snippet = re(r#"class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)</(?:a|div|td)>"#)
            .captures(block)
            .map(|c| clean(&c[1]))
            .unwrap_or_default();
        results.push(json!({"title":clean(&a[2]),"url":href,"snippet":snippet}));
        if results.len() >= 30 {
            break;
        }
    }
    Ok(results)
}
fn decode_component(s: &str) -> Result<String, String> {
    let units = utf16_units(s);
    let mut out = Vec::new();
    let mut i = 0;
    while i < units.len() {
        if units[i] != 37 {
            out.push(units[i]);
            i += 1;
            continue;
        }
        let mut bytes = Vec::new();
        while i < units.len() && units[i] == 37 {
            let pair = units.get(i + 1..i + 3).ok_or("URI malformed")?;
            let hex = pair
                .iter()
                .map(|u| char::from_u32(u32::from(*u)).and_then(|c| c.to_digit(16)))
                .collect::<Option<Vec<_>>>()
                .ok_or("URI malformed")?;
            bytes.push((hex[0] * 16 + hex[1]) as u8);
            i += 3;
        }
        let decoded = std::str::from_utf8(&bytes).map_err(|_| "URI malformed")?;
        out.extend(decoded.encode_utf16());
    }
    Ok(from_utf16_units(&out))
}

#[cfg(test)]
#[path = "html/tests.rs"]
mod tests;
