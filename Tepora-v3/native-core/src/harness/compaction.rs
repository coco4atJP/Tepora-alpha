use super::*;
use super::{
    format::fit,
    metacog::render_reflection,
    prompts::{MAIN_BRIEF_HEADINGS, SUMMARY_HEADINGS},
};
fn empty() -> Value {
    json!({"task":null,"instructions":[],"omittedInstructions":0,"files":{},"reads":{},"sources":{},"searches":[],"artifacts":{},"sessions":{},"processes":{},"errors":[],"evidence":[]})
}
fn limits(b: f64) -> Value {
    json!({"instructionTokens":round((b*0.06).max(600.).min(6000.)),"evidence":round((b*0.03/30.).max(8.).min(40.)),"maxTokens":round((b*0.1).max(500.).min(8000.))})
}
/// The handoff brief: 0.06B, 400–4000 tokens (COMPACTION.brief*).
fn brief_budget(b: f64) -> f64 {
    round((b * 0.06).max(400.).min(4000.))
}
fn done_steps(todo: &Value) -> usize {
    arr_value(todo)
        .iter()
        .filter(|t| t["status"] == "done")
        .count()
}
fn arr_value(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}
/// A checklist step finished since the last handoff while work is still open.
fn step_finished(todo: &Value, checkpoint: &Value) -> bool {
    let done = done_steps(todo);
    done as f64 > num(checkpoint, "stepsDone", 0.) && done < arr_value(todo).len()
}
fn pick(v: &Value, keys: &[&str]) -> Map<String, Value> {
    keys.iter()
        .filter_map(|k| v.get(*k).map(|v| ((*k).into(), v.clone())))
        .collect()
}
fn push(l: &mut Value, k: &str, v: Value) {
    if let Some(a) = l[k].as_array_mut() {
        a.push(v)
    }
}
fn record(l: &mut Value, k: &str, key: String, v: Value, reorder: bool) {
    if let Some(o) = l[k].as_object_mut() {
        if reorder {
            o.shift_remove(&key);
        }
        o.insert(key, v);
    }
}
fn tail(v: &mut Value, n: usize) {
    if let Some(a) = v.as_array_mut() {
        if n > 0 && a.len() > n {
            a.drain(..a.len() - n);
        }
    }
}
fn fold(p: &Value) -> Value {
    let mut l = empty();
    if let Some(o) = p["previous"].as_object() {
        for (k, v) in o {
            l[k] = v.clone()
        }
    }
    for e in arr(p, "entries") {
        if e["type"] == "input" {
            let mut item = pick(e, &["seq", "at"]);
            item.insert(
                "from".into(),
                e.get("from")
                    .filter(|v| truthy(v))
                    .cloned()
                    .unwrap_or(json!("user")),
            );
            item.insert(
                "header".into(),
                e.get("header")
                    .filter(|v| truthy(v))
                    .cloned()
                    .unwrap_or(json!("")),
            );
            if let Some(t) = e.get("text") {
                item.insert("text".into(), t.clone());
            }
            if e["kind"] == "task" && !truth(&l, "task") {
                l["task"] = Value::Object(item)
            } else if matches!(
                e.get("kind")
                    .filter(|v| truthy(v))
                    .and_then(Value::as_str)
                    .unwrap_or("message"),
                "task" | "message"
            ) && !e["from"].as_str().is_some_and(|s| s.starts_with("child:"))
            {
                push(&mut l, "instructions", Value::Object(item));
            }
            if e["kind"] == "report" && truth(e, "sessionId") {
                let id = text(e, "sessionId");
                let mut x = l["sessions"][&id].as_object().cloned().unwrap_or_default();
                let title = e
                    .get("title")
                    .filter(|v| truthy(v))
                    .cloned()
                    .or_else(|| x.get("title").filter(|v| truthy(v)).cloned())
                    .unwrap_or(json!(""));
                x.insert("title".into(), title);
                x.insert(
                    "status".into(),
                    e.get("status")
                        .filter(|v| truthy(v))
                        .cloned()
                        .unwrap_or(json!("reported")),
                );
                if let Some(seq) = e.get("seq") {
                    x.insert("seq".into(), seq.clone());
                }
                record(&mut l, "sessions", id, Value::Object(x), false);
            }
        }
        if e["type"] != "tool" {
            continue;
        }
        let d = &e["data"];
        let name = e["name"].as_str().unwrap_or("");
        if truth(e, "error") {
            let mut x = pick(e, &["seq"]);
            if let Some(n) = e.get("name") {
                x.insert("tool".into(), n.clone());
            }
            x.insert(
                "error".into(),
                json!(one_line(
                    e.get("errorText")
                        .filter(|v| truthy(v))
                        .or(e.get("content")),
                    160
                )),
            );
            push(&mut l, "errors", Value::Object(x));
        }
        if matches!(name, "write" | "edit") && truth(d, "path") {
            let mut x = pick(d, &["op", "bytes", "sha"]);
            if let Some(seq) = e.get("seq") {
                x.insert("seq".into(), seq.clone());
            }
            record(&mut l, "files", text(d, "path"), Value::Object(x), false);
        }
        if name == "artifact" && truth(d, "id") {
            let mut x = pick(d, &["title", "version"]);
            if let Some(seq) = e.get("seq") {
                x.insert("seq".into(), seq.clone());
            }
            record(&mut l, "artifacts", text(d, "id"), Value::Object(x), false);
        }
        if name == "sessions_spawn" && truth(d, "sessionId") {
            let id = text(d, "sessionId");
            let mut x = l["sessions"][&id].as_object().cloned().unwrap_or_default();
            if let Some(title) = d.get("title") {
                x.insert("title".into(), title.clone());
            } else {
                x.shift_remove("title");
            }
            x.insert("status".into(), json!("started"));
            if let Some(seq) = e.get("seq") {
                x.insert("seq".into(), seq.clone());
            }
            record(&mut l, "sessions", id, Value::Object(x), false);
        }
        if name == "exec" && truth(d, "processId") {
            let mut x = Map::new();
            x.insert(
                "command".into(),
                json!(one_line(e["args"].get("command"), 100)),
            );
            if let Some(seq) = e.get("seq") {
                x.insert("seq".into(), seq.clone());
            }
            record(
                &mut l,
                "processes",
                text(d, "processId"),
                Value::Object(x),
                false,
            );
        }
        if name == "read" && truth(&e["args"], "path") && !truth(e, "error") {
            record(
                &mut l,
                "reads",
                text(&e["args"], "path"),
                e["seq"].clone(),
                true,
            );
        }
        if name == "web_fetch"
            && (truth(d, "url") || truth(&e["args"], "url"))
            && !truth(e, "error")
        {
            let url = if truth(d, "url") {
                text(d, "url")
            } else {
                text(&e["args"], "url")
            };
            let content = e["content"].as_str().unwrap_or("");
            let title = content
                .split('\n')
                .find_map(|s| s.strip_prefix("# ").filter(|s| !s.is_empty()))
                .unwrap_or("");
            record(
                &mut l,
                "sources",
                url,
                json!({"title":one_line(Some(&json!(title)),90),"seq":e["seq"]}),
                true,
            );
        }
        if name == "web_search" && truth(&e["args"], "query") {
            push(
                &mut l,
                "searches",
                json!({"query":one_line(e["args"].get("query"),90),"seq":e["seq"]}),
            );
        }
        if !truth(e, "ephemeralKey") {
            let mut x = pick(e, &["seq"]);
            if let Some(stub) = e.get("stub").filter(|v| truthy(v)).or(e.get("name")) {
                x.insert("stub".into(), stub.clone());
            }
            push(&mut l, "evidence", Value::Object(x));
        }
    }
    tail(&mut l["errors"], 8);
    tail(&mut l["evidence"], num(p, "evidence", 40.).max(0.) as usize);
    tail(&mut l["searches"], 12);
    for k in ["reads", "sources"] {
        let es = entries(&l[k]);
        l[k] = Value::Object(
            es.into_iter()
                .rev()
                .take(40)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect(),
        );
    }
    let instructions = arr(&l, "instructions");
    let count = instructions.len();
    let keep = if p["kind"] == "main" {
        count.min(12)
    } else {
        let mut total = 0.;
        let mut keep = 0;
        for i in instructions.iter().rev() {
            total += tokens(p).raw_tokens(i.get("text")) as f64;
            if total > num(p, "instructionTokens", 4000.) && keep > 0 {
                break;
            }
            keep += 1;
        }
        keep
    };
    let over = count - keep;
    if over > 0 {
        l["omittedInstructions"] = json!(num(&l, "omittedInstructions", 0.) + over as f64);
        if let Some(a) = l["instructions"].as_array_mut() {
            a.drain(..over);
        }
    }
    l
}
fn todo_text(items: &[Value]) -> String {
    if items.is_empty() {
        return "(empty)".into();
    }
    items
        .iter()
        .enumerate()
        .map(|(i, t)| {
            format!(
                "{} {}. {}",
                match t["status"].as_str().unwrap_or("") {
                    "done" => "[x]",
                    "in_progress" => "[>]",
                    "blocked" => "[!]",
                    _ => "[ ]",
                },
                i + 1,
                text(t, "text")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
fn bytes(v: Option<&Value>) -> String {
    let Some(v) = v else { return String::new() };
    let n = number(v);
    if n < 1024. {
        format!("{} B", js(v))
    } else if n < 1048576. {
        format!("{} KB", fixed_one(n / 1024.))
    } else {
        format!("{} MB", fixed_one(n / 1048576.))
    }
}
fn ledger_sections(l: &Value, p: &Value, evidence: usize, file_count: usize) -> String {
    let mut s = Vec::new();
    let todo = arr(p, "todo");
    let live = &p["live"];
    let with_task = p.get("task").is_none_or(truthy);
    if with_task && truth(l, "task") {
        s.push(format!(
            "### Task (verbatim, #{})\n{}",
            text(&l["task"], "seq"),
            text(&l["task"], "text")
        ));
    }
    if !arr(l, "instructions").is_empty() {
        s.push(format!(
            "### Instructions received (verbatim, oldest first{})\n{}",
            if truth(l, "omittedInstructions") {
                format!(
                    "; {} older ones only in the brief and recall",
                    text(l, "omittedInstructions")
                )
            } else {
                String::new()
            },
            arr(l, "instructions")
                .iter()
                .map(|i| format!(
                    "- #{} {} {}",
                    text(i, "seq"),
                    if truth(i, "header") {
                        text(i, "header")
                    } else {
                        format!("[{}]", text(i, "from"))
                    },
                    text(i, "text")
                ))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if !todo.is_empty() {
        s.push(format!("### Checklist\n{}", todo_text(todo)));
    }
    if truth(p, "reflection") {
        s.push(format!(
            "### Self-assessment (your reflect notes, verbatim)\n{}",
            render_reflection(&p["reflection"])
        ));
    }
    let files = entries(&l["files"]);
    if !files.is_empty() {
        s.push(format!(
            "### Files written or edited{}\n{}",
            if files.len() > file_count {
                format!(" (latest {} of {})", file_count, files.len())
            } else {
                String::new()
            },
            files
                .iter()
                .skip(files.len().saturating_sub(file_count))
                .map(|(path, f)| format!(
                    "- {} ({}, {}, sha {}, #{})",
                    path,
                    text(f, "op"),
                    bytes(f.get("bytes")),
                    text(f, "sha"),
                    text(f, "seq")
                ))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    let reads: Vec<_> = entries(&l["reads"])
        .into_iter()
        .filter(|(path, _)| !truth(&l["files"], path))
        .collect();
    if !reads.is_empty() {
        s.push(format!(
            "### Files read\n{}",
            reads
                .iter()
                .skip(reads.len().saturating_sub(file_count.min(30)))
                .map(|(path, seq)| format!("- {path} (#{})", js(seq)))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    let sources = entries(&l["sources"]);
    if !sources.is_empty() {
        s.push(format!(
            "### Web pages read\n{}{}",
            sources
                .iter()
                .skip(sources.len().saturating_sub(file_count.min(30)))
                .map(|(url, x)| format!(
                    "- {}{} (#{})",
                    url,
                    if truth(x, "title") {
                        format!(" \"{}\"", text(x, "title"))
                    } else {
                        String::new()
                    },
                    text(x, "seq")
                ))
                .collect::<Vec<_>>()
                .join("\n"),
            if !arr(l, "searches").is_empty() {
                format!(
                    "\nSearches: {}",
                    arr(l, "searches")
                        .iter()
                        .map(|q| json_codec::encode_text(
                            &json_codec::stringify_js(&q["query"]).unwrap()
                        ))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            } else {
                String::new()
            }
        ));
    }
    let arts = entries(&l["artifacts"]);
    if !arts.is_empty() {
        s.push(format!(
            "### Artifacts\n{}",
            arts.iter()
                .map(|(id, a)| format!(
                    "- {} \"{}\" v{} (#{})",
                    id,
                    text(a, "title"),
                    text(a, "version"),
                    text(a, "seq")
                ))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    let sessions = entries(&l["sessions"]);
    if !sessions.is_empty() {
        s.push(format!(
            "### Agent sessions\n{}",
            sessions
                .iter()
                .map(|(id, x)| format!(
                    "- {} \"{}\" [{}]",
                    id,
                    x.get("title")
                        .filter(|v| truthy(v))
                        .map(js)
                        .unwrap_or_default(),
                    live["sessions"]
                        .get(id)
                        .filter(|v| truthy(v))
                        .map(js)
                        .unwrap_or_else(|| text(x, "status"))
                ))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    let procs = entries(&l["processes"]);
    if !procs.is_empty() {
        s.push(format!(
            "### Background processes\n{}",
            procs
                .iter()
                .map(|(id, x)| format!(
                    "- {} {} [{}]",
                    id,
                    json_codec::encode_text(&json_codec::stringify_js(&x["command"]).unwrap()),
                    live["processes"]
                        .get(id)
                        .filter(|v| truthy(v))
                        .map(js)
                        .unwrap_or("unknown".into())
                ))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if !arr(l, "errors").is_empty() {
        s.push(format!(
            "### Recent errors\n{}",
            arr(l, "errors")
                .iter()
                .map(|e| format!(
                    "- #{} {}: {}",
                    text(e, "seq"),
                    text(e, "tool"),
                    text(e, "error")
                ))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if evidence > 0 {
        let a = arr(l, "evidence");
        s.push(format!(
            "### Evidence index (recall(\"#n\") reads one in full)\n{}",
            a.iter()
                .skip(a.len().saturating_sub(evidence))
                .map(|e| format!("- #{} {}", text(e, "seq"), text(e, "stub")))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if s.is_empty() {
        "(nothing recorded yet)".into()
    } else {
        s.join("\n\n")
    }
}
fn render_ledger(p: &Value) -> String {
    let l = &p["ledger"];
    let (mut evidence, mut files) = (arr(l, "evidence").len(), 60);
    loop {
        let text = ledger_sections(l, p, evidence, files);
        if tokens(p).raw_text_tokens(&text) as f64 <= num(p, "maxTokens", f64::INFINITY)
            || (evidence == 0 && files <= 5)
        {
            return text;
        }
        if evidence > 0 {
            evidence /= 2
        } else {
            files = (files / 2).max(5)
        }
    }
}
/// A fresh conversation: the exact ledger and the brief, with a work agent's original task verbatim. The
/// character has no task; its latest exchanges follow the handoff verbatim instead.
fn handoff(p: &Value) -> String {
    let task = &p["task"];
    let main = p["kind"] == "main";
    format!("<handoff covers=\"#1–#{}\" made=\"{}\" method=\"{}\" reason=\"{}\">\n{}: recall(\"#n\") reads any entry exactly and history_search finds older details.\n{}\n## Ledger (exact, kept by the harness)\n{}\n\n## Brief (written at the handoff)\n{}\n</handoff>",
        text(p, "upTo"), text(p, "at"), text(p, "method"), text(p, "reason"),
        if main { "This is a fresh conversation continuing your conversation with the user; the latest exchanges follow this message verbatim. Earlier turns are stored in full" } else { "This is a fresh conversation continuing the task below. Earlier conversations are stored in full" },
        if main { String::new() } else { format!("\n## Original task (verbatim{})\n{}\n",
            if truthy(task) { format!(", #{}", text(task, "seq")) } else { String::new() },
            if truthy(task) { text(task, "text") } else { "(not recorded)".into() }) },
        text(p, "ledger"), text(p, "brief"))
}
/// `fork`: the requester's ledger and latest brief in the handoff shape, plus its turns since that brief.
fn fork_context(p: &Value) -> String {
    let checkpoint = &p["checkpoint"];
    let unicode = p.get("unicodeVersion").cloned().unwrap_or(json!(16));
    let ledger = fold(&json!({"previous":checkpoint["ledger"],"entries":p["entries"],"kind":p["kind"],"instructionTokens":1500,"evidence":8,"unicodeVersion":unicode}));
    let all = arr(p, "entries");
    let recent: Vec<_> = all
        .iter()
        .filter(|e| matches!(e["type"].as_str(), Some("input" | "assistant")))
        .cloned()
        .collect();
    let recent = &recent[recent.len().saturating_sub(30)..];
    let ledger = render_ledger(&json!({"ledger":ledger,"todo":p["todo"],"reflection":p["reflection"],"maxTokens":2500,"unicodeVersion":unicode}));
    let fitted = |s: &str, reference: &str| {
        fit(s, 2500., reference, tokens(p))["text"]
            .as_str()
            .unwrap_or("")
            .to_string()
    };
    let brief = if truth(checkpoint, "summary") {
        fitted(&text(checkpoint, "summary"), &format!("#{}", text(checkpoint, "seq")))
    } else {
        "(none yet)".into()
    };
    let since = if recent.is_empty() {
        String::new()
    } else {
        format!(
            "\n\n## Since the brief\n{}",
            fitted(
                &transcript(&json!({"entries":recent,"unicodeVersion":unicode})),
                "recent"
            )
        )
    };
    format!(
        "--- Context from your requester (quoted, for reference; #n refers to its log: recall(\"{}#n\")) ---\n## Requester's ledger\n{}\n\n## Requester's brief{}\n{}{}",
        text(p, "parentId"),
        ledger,
        if truthy(checkpoint) {
            format!(" (#{})", text(checkpoint, "seq"))
        } else {
            String::new()
        },
        brief,
        since
    )
}
fn line_starts(s: &str) -> Vec<usize> {
    std::iter::once(0)
        .chain(
            s.char_indices()
                .filter(|(_, c)| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
                .map(|(i, c)| i + c.len_utf8()),
        )
        .collect()
}
fn fixed_one(v: f64) -> String {
    if v.abs() >= 1e21 || !v.is_finite() {
        return js(&json!(v));
    }
    let bits = v.abs().to_bits();
    let exp_bits = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = (bits & ((1u64 << 52) - 1)) | if exp_bits == 0 { 0 } else { 1u64 << 52 };
    let exponent = if exp_bits == 0 {
        -1074
    } else {
        exp_bits - 1023 - 52
    };
    let product = mantissa as u128 * 10;
    let rounded = if exponent >= 0 {
        product << exponent
    } else if -exponent >= 128 {
        0
    } else {
        let shift = -exponent as u32;
        (product >> shift)
            + u128::from((product & ((1u128 << shift) - 1)) >= (1u128 << (shift - 1)))
    };
    format!(
        "{}{}.{}",
        if v < 0. { "-" } else { "" },
        rounded / 10,
        rounded % 10
    )
}

fn identifiers(p: &Value) -> Value {
    let urls = regex::Regex::new(r#"https?://[^\x09-\x0d \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff})>\]"'`<]+"#).unwrap();
    let paths = regex::Regex::new(
        r#"(?:^|[\x09-\x0d \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}"'`(=])((?:~|/)(?:[A-Za-z0-9_.@+-]+/)+[A-Za-z0-9_.@+-]+\.[A-Za-z0-9]{1,8})(?-u:\b)"#,
    )
    .unwrap();
    let mut seen = Map::new();
    for e in arr(p, "entries") {
        let t = match e["type"].as_str().unwrap_or("") {
            "assistant" => {
                let mut a = vec![e
                    .get("content")
                    .filter(|v| !v.is_null())
                    .map(js)
                    .unwrap_or_default()];
                a.extend(arr(e, "toolCalls").iter().map(|c| {
                    c.get("arguments")
                        .filter(|v| !v.is_null())
                        .map(js)
                        .unwrap_or_default()
                }));
                a.join("\n")
            }
            "tool" => slice(
                &e.get("content")
                    .filter(|v| truthy(v))
                    .map(js)
                    .unwrap_or_default(),
                0,
                20000,
            ),
            "input" => e
                .get("text")
                .filter(|v| truthy(v))
                .map(js)
                .unwrap_or_default(),
            _ => String::new(),
        };
        for m in urls.find_iter(&t) {
            let u = m.as_str().trim_end_matches(['.', ',', ';', ':', '!', '?']);
            if len(u) < 300 {
                seen.insert(u.into(), e["seq"].clone());
            }
        }
        for m in paths.captures_iter(&t) {
            let path = &m[1];
            if len(path) < 240 {
                seen.insert(path.into(), e["seq"].clone());
            }
        }
    }
    let known = text(p, "known");
    let found: Vec<_> = seen
        .iter()
        .filter(|(id, _)| !known.contains(id.as_str()))
        .collect();
    let n = num(p, "limit", 25.).max(0.) as usize;
    let start = if n == 0 {
        0
    } else {
        found.len().saturating_sub(n)
    };
    json!(found[start..]
        .iter()
        .map(|(id, seq)| format!("- {} (#{})", id, js(seq)))
        .collect::<Vec<_>>())
}
fn valid(p: &Value) -> bool {
    let t = p
        .get("text")
        .filter(|v| truthy(v))
        .map(js)
        .unwrap_or_default();
    let t = trim(&t);
    if len(t) < 60 {
        return false;
    }
    let heading = regex::Regex::new(r"^#{1,3} +[^\x09-\x0d \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]").unwrap();
    let headings = line_starts(t)
        .iter()
        .filter(|&&i| heading.is_match(&t[i..]))
        .count();
    let lower = t.to_lowercase();
    let list: &[&str] = if p["kind"] == "main" {
        &MAIN_BRIEF_HEADINGS
    } else {
        &SUMMARY_HEADINGS
    };
    let named = list
        .iter()
        .filter(|h| lower.contains(&h.to_lowercase()))
        .count();
    (named >= 5 || headings >= 5)
        && tokens(p).raw_text_tokens(t) as f64 <= num(p, "maxTokens", f64::NAN) * 2.
}
fn transcript(p: &Value) -> String {
    arr(p, "entries")
        .iter()
        .map(|e| {
            let seq = text(e, "seq");
            let ft = |s: &str, n: f64| {
                fit(s, n, &format!("#{seq}"), tokens(p))["text"]
                    .as_str()
                    .unwrap_or("")
                    .to_string()
            };
            match e["type"].as_str().unwrap_or("") {
                "input" => format!(
                    "#{} {} {}",
                    seq,
                    if truth(e, "header") {
                        text(e, "header")
                    } else {
                        format!(
                            "[{}]",
                            e.get("from")
                                .filter(|v| truthy(v))
                                .map(js)
                                .unwrap_or("user".into())
                        )
                    },
                    ft(&text(e, "text"), 1500.)
                ),
                "notice" => format!("#{seq} [harness] {}", one_line(e.get("text"), 300)),
                "assistant" => format!(
                    "#{seq} assistant: {}{}",
                    ft(
                        &e.get("content")
                            .filter(|v| truthy(v))
                            .map(js)
                            .unwrap_or_default(),
                        1000.
                    ),
                    arr(e, "toolCalls")
                        .iter()
                        .map(|c| format!(
                            "\n  → {}({})",
                            text(c, "name"),
                            one_line(c.get("arguments"), 200)
                        ))
                        .collect::<Vec<_>>()
                        .join("")
                ),
                "tool" => format!(
                    "#{seq} result: {}",
                    if (num(e, "seq", f64::NAN) <= num(p, "clearUpTo", 0.) && !truth(e, "keep"))
                        || truth(e, "ephemeralKey")
                    {
                        text(e, "stub")
                    } else {
                        ft(
                            &e.get("content")
                                .filter(|v| truthy(v))
                                .map(js)
                                .unwrap_or_default(),
                            500.,
                        )
                    }
                ),
                _ => String::new(),
            }
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}
fn chunks(p: &Value) -> Value {
    let t = text(p, "text");
    let mut out = Vec::new();
    let mut cur = Vec::new();
    let mut size = 0.;
    for line in t.split('\n') {
        let n = tokens(p).raw_text_tokens(line) as f64 + 1.;
        if size + n > num(p, "maxTokens", f64::NAN) && !cur.is_empty() {
            out.push(cur.join("\n"));
            cur.clear();
            size = 0.;
        }
        cur.push(line);
        size += n;
    }
    if !cur.is_empty() {
        out.push(cur.join("\n"));
    }
    json!(out)
}
fn images_in(x: &Value) -> usize {
    arr(&x["message"], "content")
        .iter()
        .filter(|p| p["type"] == "image_url")
        .count()
}
fn count_images(r: &[Value]) -> usize {
    r.iter().map(images_in).sum()
}
/// The seq of the entry holding the 3rd newest image (COMPACTION.keepImages): an image clear stops below it.
fn keep_images_from(r: &[Value]) -> f64 {
    let mut n = 0;
    for x in r.iter().rev() {
        n += images_in(x);
        if n >= 3 {
            return num(&x["entry"], "seq", f64::NAN);
        }
    }
    f64::NEG_INFINITY
}
fn clear_candidate(p: &Value) -> CoreResult<Value> {
    clear_candidate_before(p, f64::INFINITY)
}
fn clear_candidate_before(p: &Value, before: f64) -> CoreResult<Value> {
    let b = &p["built"];
    let r = arr(b, "rendered");
    let assistants: Vec<_> = r
        .iter()
        .filter(|x| x["entry"]["type"] == "assistant")
        .collect();
    let hot = if assistants.len() >= 2 {
        num(&assistants[assistants.len() - 2]["entry"], "seq", f64::NAN)
    } else {
        f64::INFINITY
    };
    let below: Vec<_> = r
        .iter()
        .filter(|x| {
            let seq = num(&x["entry"], "seq", f64::NAN);
            seq > num(&b["view"], "clearUpTo", 0.) && seq < hot.min(before)
        })
        .collect();
    let Some(last) = below.last() else {
        return Ok(Value::Null);
    };
    let up_to = last["entry"]["seq"].clone();
    let preview = crate::context::call(
        "context.renderEntries",
        json!({"view":b["view"],"clearUpTo":up_to,"vision":b["vision"],"unicodeVersion":p.get("unicodeVersion").cloned().unwrap_or(json!(16))}),
    )?;
    let before = r.iter().map(|x| num(x, "tokens", 0.)).sum::<f64>();
    let after = preview
        .as_array()
        .unwrap()
        .iter()
        .map(|x| num(x, "tokens", 0.))
        .sum::<f64>();
    let savings = ((before - after) * num(p, "ratio", 1.)).max(0.);
    Ok(if savings > 0. {
        json!({"savings":savings,"upTo":up_to,"images":count_images(preview.as_array().unwrap())})
    } else {
        Value::Null
    })
}
/// A handoff drops the whole conversation up to the end of the last step; only later input stays in view.
fn handoff_boundary(p: &Value) -> Value {
    let r = arr(&p["built"], "rendered");
    match r
        .iter()
        .rposition(|x| matches!(x["entry"]["type"].as_str(), Some("assistant" | "tool")))
    {
        None => Value::Null,
        Some(last) => {
            json!({"upTo":r[last]["entry"]["seq"],"tailFrom":r.get(last+1).map(|x|x["entry"]["seq"].clone()).unwrap_or(Value::Null)})
        }
    }
}
fn boundary(p: &Value) -> Value {
    let r = arr(&p["built"], "rendered");
    if r.len() < 2 {
        return Value::Null;
    }
    // The character's last three exchanges (an exchange starts at an input after anything else), within the tail share.
    let starts = |i: usize| r[i]["entry"]["type"] == "input" && (i == 0 || r[i - 1]["entry"]["type"] != "input");
    let mut size = 0.;
    let mut i = r.len();
    let mut turns = 0;
    while i > 0
        && turns < 3
        && size + num(&r[i - 1], "tokens", 0.) * num(p, "ratio", 1.)
            <= num(p, "tailShare", 0.15) * num(p, "B", f64::NAN)
    {
        i -= 1;
        size += num(&r[i], "tokens", 0.) * num(p, "ratio", 1.);
        if starts(i) {
            turns += 1;
        }
    }
    let last = r
        .iter()
        .rposition(|x| x["entry"]["type"] == "assistant")
        .or_else(|| r.iter().rposition(|x| x["entry"]["type"] != "tool"));
    let Some(last) = last else { return Value::Null };
    if i > last {
        i = last
    }
    while i > 0 && r[i]["entry"]["type"] == "tool" {
        i -= 1
    }
    if i == 0 {
        i = r
            .iter()
            .rposition(|x| x["entry"]["type"] == "assistant")
            .filter(|i| *i > 0)
            .unwrap_or(r.len() - 1);
        while i > 0 && r[i]["entry"]["type"] == "tool" {
            i -= 1
        }
    }
    if i == 0 {
        Value::Null
    } else {
        json!({"upTo":r[i-1]["entry"]["seq"],"tailFrom":r[i]["entry"]["seq"]})
    }
}
fn plan(p: &Value) -> CoreResult<Value> {
    let b = num(p, "B", f64::NAN);
    let used = num(&p["built"], "tokens", 0.) * num(p, "ratio", 1.);
    if truth(p, "force") {
        return Ok(json!({"action":"compact","used":used,"forced":true}));
    }
    if truth(p, "idle") {
        return Ok(json!({"action":if used>0.55*b{"compact"}else{"none"},"used":used}));
    }
    let session = &p["session"];
    let main = session["kind"] == "main";
    if truthy(session)
        && !main
        && step_finished(&session["todo"], &p["built"]["view"]["checkpoint"])
        && arr(&p["built"], "rendered")
            .iter()
            .map(|x| num(x, "tokens", 0.))
            .sum::<f64>()
            * num(p, "ratio", 1.)
            >= 2. * brief_budget(b)
    {
        return Ok(json!({"action":"compact","used":used,"reason":"step"}));
    }
    let images = count_images(arr(&p["built"], "rendered"));
    if images > 6 {
        let c = clear_candidate_before(p, keep_images_from(arr(&p["built"], "rendered")))?;
        if !c.is_null() && num(&c, "images", 0.) < (images as f64) {
            let mut out = json!({"action":"clear","used":used});
            for (k, v) in entries(&c) {
                out[k] = v;
            }
            out["images"] = json!(images);
            return Ok(out);
        }
    }
    if used <= 0.72 * b {
        return Ok(json!({"action":"none","used":used}));
    }
    let clear = clear_candidate(p)?;
    let sufficient = !clear.is_null() && num(&clear, "savings", 0.) >= (0.15 * b).max(500.);
    // The character hands off between turns (idle); inside a turn only when it is about to overflow.
    let hard = if main { 0.9 } else { 0.8 } * b;
    if sufficient && used - num(&clear, "savings", 0.) <= hard {
        let mut out = json!({"action":"clear","used":used});
        for (k, v) in entries(&clear) {
            out[k] = v;
        }
        return Ok(out);
    }
    if used > hard {
        return Ok(json!({"action":"compact","used":used,"clear":clear}));
    }
    if sufficient {
        let mut out = json!({"action":"clear","used":used});
        for (k, v) in entries(&clear) {
            out[k] = v;
        }
        return Ok(out);
    }
    Ok(json!({"action":"none","used":used}))
}

pub(super) fn call(op: &str, p: &Value) -> CoreResult<Value> {
    Ok(match op {
        "ledgerLimits" => limits(num(p, "B", f64::NAN)),
        "emptyLedger" => empty(),
        "foldLedger" => fold(p),
        "renderLedger" => json!(render_ledger(p)),
        "handoffText" => json!(handoff(p)),
        "forkContext" => json!(fork_context(p)),
        "briefBudget" => json!(brief_budget(num(p, "B", f64::NAN))),
        "handoffBoundary" => handoff_boundary(p),
        "missingIdentifiers" => identifiers(p),
        "validSummary" => json!(valid(p)),
        "transcriptText" => json!(transcript(p)),
        "chunks" => chunks(p),
        "clearCandidate" => clear_candidate(p)?,
        "boundary" => boundary(p),
        "plan" => plan(p)?,
        "prepare" => prepare(p)?,
        "finalize" => finalize(p)?,
        _ => return Err(invalid(format!("Unknown compaction operation: {op}"))),
    })
}

/// Snapshot the exact work required for a checkpoint. The host performs real
/// provider calls, checks cancellation, then invokes finalize before persisting.
fn prepare(p: &Value) -> CoreResult<Value> {
    let kind = &p["session"]["kind"];
    let main = kind == "main";
    let bound = if main {
        boundary(p)
    } else {
        handoff_boundary(p)
    };
    if bound.is_null() {
        return Ok(Value::Null);
    }
    let built = &p["built"];
    let prev = &built["view"]["checkpoint"];
    let b = num(p, "B", f64::NAN);
    let up_to = num(&bound, "upTo", 0.);
    let from = num(prev, "upTo", 0.) + 1.;
    let folded: Vec<_> = arr(p, "entries")
        .iter()
        .filter(|e| {
            let seq = num(e, "seq", 0.);
            seq >= from
                && seq <= up_to
                && matches!(
                    e["type"].as_str().unwrap_or(""),
                    "input" | "notice" | "assistant" | "tool"
                )
        })
        .cloned()
        .collect();
    let mut f = limits(b);
    f["previous"] = prev["ledger"].clone();
    f["entries"] = json!(folded);
    f["kind"] = p["session"]["kind"].clone();
    f["unicodeVersion"] = p.get("unicodeVersion").cloned().unwrap_or(json!(16));
    let ledger = fold(&f);
    let mut render = json!({"ledger":ledger,"maxTokens":f["maxTokens"],"todo":p["todo"],"reflection":p["reflection"],"live":p["live"],"task":main,"unicodeVersion":f["unicodeVersion"]});
    let ledger_text = render_ledger(&render);
    let max = brief_budget(b);
    let transcript = transcript(
        &json!({"entries":folded,"clearUpTo":built["view"]["clearUpTo"],"unicodeVersion":f["unicodeVersion"]}),
    );
    let parts = chunks(
        &json!({"text":transcript,"maxTokens":(b*0.45).floor().max(1500.),"unicodeVersion":f["unicodeVersion"]}),
    );
    render = json!({"ledger":ledger_text,"previous":truthy(prev),"maxTokens":max,"kind":kind});
    let instruction = prompts::compaction_instruction(&render);
    Ok(
        json!({"kind":kind,"stepsDone":done_steps(&p["todo"]),"bound":bound,"from":from,"folded":folded,"ledger":ledger,"ledgerText":ledger_text,"maxTokens":max,"requestMaxTokens":round(max*1.5)+512.,"chunks":parts,"previousSummary":prev.get("summary").cloned().unwrap_or(json!("")),"instruction":instruction,"retryInstruction":format!("{instruction}\n\nYour previous attempt did not follow the required headings. Use exactly the headings listed."),"summarizerSystem":prompts::SUMMARIZER_SYSTEM,"inContextAttempts":if p["reason"]=="overflow"{0}else{2},"priority":if p["session"]["kind"]=="main"{5}else{0}}),
    )
}
fn finalize(p: &Value) -> CoreResult<Value> {
    let prepared = &p["prepared"];
    if prepared.is_null() {
        return Ok(Value::Null);
    }
    let built = &p["built"];
    let prev = &built["view"]["checkpoint"];
    let folded = arr(prepared, "folded");
    let max = num(prepared, "maxTokens", 600.);
    let reference = format!("#{}", text(&prepared["bound"], "upTo"));
    let mut method = p.get("method").map(js).unwrap_or("in-context".into());
    let mut summary = p
        .get("summary")
        .filter(|v| truthy(v))
        .map(js)
        .unwrap_or_default();
    if summary.is_empty() {
        method = "deterministic".into();
        let es: Vec<_> = folded
            .iter()
            .filter(|e| e["type"] != "tool" || truth(e, "error") || !truth(e, "ephemeralKey"))
            .cloned()
            .collect();
        let steps = transcript(
            &json!({"entries":es,"clearUpTo":built["view"]["clearUpTo"],"unicodeVersion":p.get("unicodeVersion").cloned().unwrap_or(json!(16))}),
        );
        let steps = steps
            .split('\n')
            .map(|l| one_line(Some(&json!(l)), 240))
            .collect::<Vec<_>>()
            .join("\n");
        let t=format!("{}## Steps since the previous checkpoint (automatic list; the model summary failed)\n{}",if truth(prev,"summary"){format!("{}\n\n",text(prev,"summary"))}else{String::new()},steps);
        summary = fit(&t, max, &reference, tokens(p))["text"]
            .as_str()
            .unwrap()
            .into();
    }
    let at_ref = &p["at"];
    let tokens_before = round(num(built, "tokens", 0.) * num(p, "ratio", 1.));
    let reason = p.get("reason").cloned().unwrap_or(json!("budget"));
    let previous = prev
        .get("seq")
        .filter(|v| truthy(v))
        .cloned()
        .unwrap_or(Value::Null);
    summary = fit(&summary, max * 2., &reference, tokens(p))["text"]
        .as_str()
        .unwrap()
        .into();
    let extra = identifiers(
        &json!({"entries":folded,"known":format!("{}\n{}",text(prepared,"ledgerText"),summary)}),
    );
    let lines = extra.as_array().unwrap();
    let full_ledger = format!(
        "{}{}",
        text(prepared, "ledgerText"),
        if lines.is_empty() {
            String::new()
        } else {
            format!(
                "\n\n### Links and paths seen in this stretch but not in the brief\n{}",
                lines.iter().map(js).collect::<Vec<_>>().join("\n")
            )
        }
    );
    let main = prepared["kind"] == "main";
    let text = handoff(
        &json!({"kind":prepared["kind"],"upTo":prepared["bound"]["upTo"],"at":at_ref,"method":method,"reason":reason,"task":prepared["ledger"]["task"],"ledger":full_ledger,"brief":summary}),
    );
    Ok(
        json!({"checkpoint":{"upTo":prepared["bound"]["upTo"],"text":text,"summary":summary,"ledger":prepared["ledger"],"method":method,"reason":reason,"previous":previous,"tokensBefore":tokens_before,"stepsDone":prepared["stepsDone"]},"notice":prompts::notice(if main {"conversationHandedOff"} else {"handedOff"},&[prepared["bound"]["upTo"].clone()])?}),
    )
}
