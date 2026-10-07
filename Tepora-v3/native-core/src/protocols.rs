//! Pure provider wire encoding and incremental response state. HTTP, credentials,
//! admission, cancellation and transport framing remain outside this module.
use crate::{json_codec, CoreError, CoreResult};
use serde_json::{json, Map, Value};

const NULL: Value = Value::Null;
fn get<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&NULL)
}
fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn strv(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn truthy(value: &Value) -> bool {
    crate::js_value::truthy(value)
}
fn fallback<'a>(value: &'a Value, default: &'a Value) -> &'a Value {
    if truthy(value) {
        value
    } else {
        default
    }
}
fn invalid(message: &str) -> CoreError {
    CoreError(format!("[400] {message}"))
}
fn limit_error(message: &str) -> CoreError {
    CoreError(format!("[502] {message}"))
}
fn opt(options: &Value, key: &str, default: Value) -> Value {
    options.get(key).cloned().unwrap_or(default)
}
fn object() -> Value {
    json!({})
}
fn front(value: &mut Value, keys: &[&str]) {
    let Some(original) = value.as_object_mut() else {
        return;
    };
    let mut ordered = Map::new();
    for key in keys {
        if let Some(v) = original.shift_remove(*key) {
            ordered.insert((*key).into(), v);
        }
    }
    ordered.extend(std::mem::take(original));
    *original = ordered;
}
fn put(body: &mut Value, key: &str, value: &Value, drop: &[Value]) {
    if !value.is_null() && !drop.iter().any(|v| v.as_str() == Some(key)) {
        body[key] = value.clone();
    }
}
fn copy_present(target: &mut Value, source: &Value, key: &str) {
    if let Some(v) = source.get(key) {
        target[key] = v.clone();
    }
}
fn js_json(value: &Value) -> CoreResult<String> {
    Ok(json_codec::encode_text(&json_codec::stringify_js(value)?))
}
fn js_string(value: &Value) -> String {
    crate::js_value::js_string(Some(value))
}
fn string_field(value: &Value, key: &str) -> String {
    crate::js_value::js_string(value.get(key))
}
fn units(text: &str) -> Vec<u16> {
    json_codec::utf16_units(text)
}
fn from_units(value: &[u16]) -> String {
    json_codec::from_utf16_units(value)
}
fn truncate(text: &str, n: usize) -> String {
    from_units(&units(text).into_iter().take(n).collect::<Vec<_>>())
}
fn parse_args(value: &Value) -> Value {
    let raw = if truthy(value) {
        js_string(value)
    } else {
        "{}".into()
    };
    json_codec::parse_js_text(&raw)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(object)
}
fn content_parts(value: &Value) -> CoreResult<Vec<Value>> {
    if let Some(text) = value.as_str() {
        return Ok(if text.is_empty() {
            vec![]
        } else {
            vec![json!({"type":"text","text":text})]
        });
    }
    if value.is_null() {
        return Ok(vec![]);
    }
    let parts = value
        .as_array()
        .filter(|v| v.len() <= 40)
        .ok_or_else(|| invalid("Invalid canonical content"))?;
    parts
        .iter()
        .map(|p| {
            if !p.is_object() {
                return Err(invalid("Invalid content part"));
            }
            if get(p, "type") == "text" {
                return Ok(json!({"type":"text","text":string_field(p,"text")}));
            }
            let url = strv(get(get(p, "image_url"), "url"));
            let valid = url
                .strip_prefix("data:image/")
                .and_then(|s| s.split_once(";base64,"))
                .is_some_and(|(mime, data)| {
                    ["png", "jpeg", "webp", "gif"].contains(&mime)
                        && !data.trim_end_matches('=').is_empty()
                        && data
                            .trim_end_matches('=')
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
                });
            if get(p, "type") != "image_url" || !valid {
                return Err(invalid("Only inlined images are allowed"));
            }
            Ok(p.clone())
        })
        .collect()
}
fn as_text(value: &Value) -> CoreResult<String> {
    Ok(content_parts(value)?
        .iter()
        .map(|p| {
            if get(p, "type") == "text" {
                strv(get(p, "text"))
            } else {
                "[image]"
            }
        })
        .collect::<Vec<_>>()
        .join("\n"))
}
fn image_part(part: &Value, protocol: &str) -> Value {
    let url = strv(get(get(part, "image_url"), "url"));
    let (mime, data) = url
        .strip_prefix("data:")
        .unwrap_or("")
        .split_once(";base64,")
        .unwrap_or(("", ""));
    match protocol {
        "anthropic" => {
            json!({"type":"image","source":{"type":"base64","media_type":mime,"data":data}})
        }
        "gemini" => json!({"inlineData":{"mimeType":mime,"data":data}}),
        _ => json!({"type":"input_image","image_url":url}),
    }
}
fn same_native(message: &Value, profile: &Value) -> bool {
    get(message, "_native").get("identity") == profile.get("identity")
        && get(get(message, "_native"), "items").is_array()
}
fn tool_calls(message: &Value) -> &[Value] {
    array(get(message, "tool_calls"))
}
fn function(call: &Value) -> &Value {
    get(call, "function")
}
fn tool_defs(tools: &[Value], protocol: &str) -> Vec<Value> {
    tools
        .iter()
        .map(|t| {
            let f = function(t);
            let mut result = object();
            if protocol == "responses" {
                result["type"] = json!("function");
            }
            copy_present(&mut result, f, "name");
            copy_present(&mut result, f, "description");
            if let Some(p) = f.get("parameters") {
                result[match protocol {
                    "anthropic" => "input_schema",
                    "gemini" => "parametersJsonSchema",
                    _ => "parameters",
                }] = p.clone();
            }
            if protocol == "responses" {
                result["strict"] = json!(false);
            }
            result
        })
        .collect()
}
fn append_message(out: &mut Vec<Value>, role: &str, parts: Vec<Value>, key: &str, mark: bool) {
    if parts.is_empty() {
        return;
    }
    if out.last().is_some_and(|v| get(v, "role") == role) {
        out.last_mut().unwrap()[key]
            .as_array_mut()
            .unwrap()
            .extend(parts);
    } else {
        let mut message = json!({"role":role});
        message[key] = json!(parts);
        out.push(message);
    }
    if mark {
        out.last_mut().unwrap()["mark"] = json!(true);
    }
}
/// JSON-compatible canonical request encoding. The caller supplies validated profiles.
pub fn encode_request(
    profile: &Value,
    messages: &[Value],
    options: &Value,
    ollama: bool,
) -> CoreResult<Value> {
    let protocol = strv(get(profile, "protocol"));
    if ollama {
        return encode_ollama(profile, messages, options);
    }
    if !["chat-completions", "responses", "anthropic", "gemini"].contains(&protocol) {
        return Err(invalid("Unsupported provider protocol"));
    }
    let tools = array(get(options, "tools"));
    let max = opt(options, "maxTokens", json!(4096));
    let choice = opt(options, "toolChoice", json!("auto"));
    let cache = get(options, "cacheKey");
    let long = get(options, "cacheRetention") == "long";
    let sampling = get(options, "sampling");
    let drop = array(get(get(options, "compat"), "drop"));
    let systems = messages
        .iter()
        .filter(|m| get(m, "role") == "system")
        .map(|m| as_text(get(m, "content")))
        .collect::<CoreResult<Vec<_>>>()?
        .join("\n\n");
    if protocol == "chat-completions" {
        let encoded = messages
            .iter()
            .map(|m| {
                let content = get(m, "content");
                let mut out = object();
                copy_present(&mut out, m, "role");
                out["content"] = if content.is_array() {
                    json!(content_parts(content)?)
                } else if !content.is_null() {
                    content.clone()
                } else if truthy(get(m, "tool_calls")) {
                    Value::Null
                } else {
                    json!("")
                };
                if truthy(get(m, "tool_calls")) {
                    out["tool_calls"] = json!(tool_calls(m)
                        .iter()
                        .map(|c| {
                            let mut v = json!({"type":"function","function":{}});
                            copy_present(&mut v, c, "id");
                            copy_present(&mut v["function"], function(c), "name");
                            copy_present(&mut v["function"], function(c), "arguments");
                            front(&mut v, &["id", "type", "function"]);
                            v
                        })
                        .collect::<Vec<_>>());
                }
                if truthy(get(m, "tool_call_id")) {
                    out["tool_call_id"] = get(m, "tool_call_id").clone();
                }
                Ok(out)
            })
            .collect::<CoreResult<Vec<_>>>()?;
        let mut body = json!({"stream":true,"messages":encoded});
        copy_present(&mut body, profile, "model");
        put(
            &mut body,
            if drop.iter().any(|v| v == "max_tokens") {
                "max_completion_tokens"
            } else {
                "max_tokens"
            },
            &max,
            drop,
        );
        if !tools.is_empty() {
            body["tools"] = json!(tools);
            put(&mut body, "tool_choice", &choice, drop);
        }
        put(
            &mut body,
            "stream_options",
            &json!({"include_usage":true}),
            drop,
        );
        for k in [
            "temperature",
            "top_p",
            "top_k",
            "min_p",
            "presence_penalty",
            "frequency_penalty",
            "repeat_penalty",
            "seed",
        ] {
            put(&mut body, k, get(sampling, k), drop);
        }
        if truthy(cache) && get(profile, "domain") == "cloud" {
            put(&mut body, "prompt_cache_key", cache, drop);
        }
        if long && get(profile, "domain") == "cloud" {
            put(&mut body, "prompt_cache_retention", &json!("24h"), drop);
        }
        if get(profile, "server") == "llama.cpp" {
            put(&mut body, "cache_prompt", &json!(true), drop);
            put(&mut body, "return_progress", &json!(true), drop);
            let slot = get(options, "slot");
            if slot
                .as_f64()
                .is_some_and(|v| v.is_finite() && v.fract() == 0.0)
            {
                put(&mut body, "id_slot", slot, drop);
            }
        }
        if truthy(get(profile, "reasoningEffort")) {
            put(
                &mut body,
                "reasoning_effort",
                get(profile, "reasoningEffort"),
                drop,
            );
        }
        front(&mut body, &["model"]);
        return Ok(body);
    }
    if protocol == "responses" {
        let mut input = vec![];
        for m in messages {
            if get(m, "role") == "system" {
                continue;
            }
            if get(m, "role") == "assistant" && same_native(m, profile) {
                input.extend(array(get(get(m, "_native"), "items")).iter().cloned());
                continue;
            }
            if get(m, "role") == "tool" {
                let mut v =
                    json!({"type":"function_call_output","output":string_field(m,"content")});
                if let Some(id) = m.get("tool_call_id") {
                    v["call_id"] = id.clone();
                }
                front(&mut v, &["type", "call_id", "output"]);
                input.push(v);
                continue;
            }
            if truthy(get(m, "content")) {
                let mut v = object();
                copy_present(&mut v, m, "role");
                v["content"] = if get(m, "role") == "assistant" {
                    json!(as_text(get(m, "content"))?)
                } else {
                    json!(content_parts(get(m, "content"))?
                        .iter()
                        .map(|p| if get(p, "type") == "text" {
                            json!({"type":"input_text","text":get(p,"text")})
                        } else {
                            image_part(p, protocol)
                        })
                        .collect::<Vec<_>>())
                };
                input.push(v);
            }
            for c in tool_calls(m) {
                let mut v = json!({"type":"function_call"});
                if let Some(id) = c.get("id") {
                    v["call_id"] = id.clone();
                }
                copy_present(&mut v, function(c), "name");
                copy_present(&mut v, function(c), "arguments");
                input.push(v);
            }
        }
        let mut body = json!({"store":false,"stream":true,"input":input,"instructions":systems});
        copy_present(&mut body, profile, "model");
        put(&mut body, "max_output_tokens", &max, drop);
        put(
            &mut body,
            "include",
            &json!(["reasoning.encrypted_content"]),
            drop,
        );
        if !tools.is_empty() {
            body["tools"] = json!(tool_defs(tools, protocol));
            put(&mut body, "tool_choice", &choice, drop);
        }
        if truthy(get(profile, "reasoningEffort")) {
            put(
                &mut body,
                "reasoning",
                &json!({"effort":get(profile,"reasoningEffort"),"summary":"auto"}),
                drop,
            );
        }
        for k in ["temperature", "top_p"] {
            put(&mut body, k, get(sampling, k), drop);
        }
        if truthy(cache) {
            put(&mut body, "prompt_cache_key", cache, drop);
        }
        if long {
            put(&mut body, "prompt_cache_retention", &json!("24h"), drop);
        }
        front(&mut body, &["model"]);
        return Ok(body);
    }
    let mut names = Map::new();
    for m in messages {
        for c in tool_calls(m) {
            names.insert(string_field(c, "id"), get(function(c), "name").clone());
        }
    }
    if protocol == "anthropic" {
        let mut out = vec![];
        for m in messages {
            if get(m, "role") == "system" {
                continue;
            }
            if get(m, "role") == "tool" {
                let mut b = json!({"type":"tool_result","content":js_string(fallback(get(m,"content"),&json!("(empty)")))});
                if let Some(id) = m.get("tool_call_id") {
                    b["tool_use_id"] = id.clone();
                }
                front(&mut b, &["type", "tool_use_id", "content"]);
                append_message(
                    &mut out,
                    "user",
                    vec![b],
                    "content",
                    truthy(get(m, "cache")),
                );
                continue;
            }
            if get(m, "role") == "assistant" && same_native(m, profile) {
                append_message(
                    &mut out,
                    "assistant",
                    array(get(get(m, "_native"), "items")).to_vec(),
                    "content",
                    truthy(get(m, "cache")),
                );
                continue;
            }
            let mut blocks = content_parts(get(m, "content"))?
                .iter()
                .map(|p| {
                    if get(p, "type") == "text" {
                        json!({"type":"text","text":get(p,"text")})
                    } else {
                        image_part(p, protocol)
                    }
                })
                .filter(|b| get(b, "type") != "text" || truthy(get(b, "text")))
                .collect::<Vec<_>>();
            for c in tool_calls(m) {
                let mut b =
                    json!({"type":"tool_use","input":parse_args(get(function(c),"arguments"))});
                copy_present(&mut b, c, "id");
                copy_present(&mut b, function(c), "name");
                front(&mut b, &["type", "id", "name", "input"]);
                blocks.push(b);
            }
            append_message(
                &mut out,
                if get(m, "role") == "assistant" {
                    "assistant"
                } else {
                    "user"
                },
                blocks,
                "content",
                truthy(get(m, "cache")),
            );
        }
        let mut system = if systems.is_empty() {
            vec![]
        } else {
            vec![json!({"type":"text","text":systems})]
        };
        let mut control = json!({"type":"ephemeral"});
        if long {
            control["ttl"] = json!("1h");
        }
        if get(profile, "cache") != false {
            if let Some(b) = system.first_mut() {
                b["cache_control"] = control.clone();
            }
            let marks = out
                .iter()
                .enumerate()
                .filter(|(_, m)| truthy(get(m, "mark")))
                .map(|(i, _)| i)
                .collect::<Vec<_>>();
            for i in marks.into_iter().rev().take(3) {
                if let Some(b) = out[i]["content"].as_array_mut().and_then(|v| v.last_mut()) {
                    // JS skips falsy blocks; extra properties on array blocks
                    // are not serialized. Never index a scalar native item.
                    if !truthy(b) || b.is_array() {
                        continue;
                    }
                    if !b.is_object() {
                        return Err(invalid("Invalid native content block"));
                    }
                    b["cache_control"] = control.clone();
                }
            }
        }
        for m in &mut out {
            m.as_object_mut().unwrap().shift_remove("mark");
        }
        let mut body = json!({"messages":out,"max_tokens":max,"stream":true});
        copy_present(&mut body, profile, "model");
        if !system.is_empty() {
            body["system"] = json!(system);
        }
        if !tools.is_empty() {
            body["tools"] = json!(tool_defs(tools, protocol));
            put(
                &mut body,
                "tool_choice",
                &json!({"type":if choice=="required"{json!("any")}else{choice}}),
                drop,
            );
        }
        if truthy(get(profile, "thinkingBudget")) {
            put(
                &mut body,
                "thinking",
                &json!({"type":"enabled","budget_tokens":get(profile,"thinkingBudget")}),
                drop,
            );
        } else {
            for k in ["temperature", "top_p", "top_k"] {
                put(&mut body, k, get(sampling, k), drop);
            }
        }
        front(&mut body, &["model"]);
        return Ok(body);
    }
    let mut contents = vec![];
    for m in messages {
        if get(m, "role") == "system" {
            continue;
        }
        if get(m, "role") == "tool" {
            let content = get(m, "content");
            let result =
                json_codec::parse_js_text(&js_string(content)).unwrap_or_else(|_| content.clone());
            let name = names
                .get(&string_field(m, "tool_call_id"))
                .filter(|v| truthy(v))
                .cloned()
                .unwrap_or(json!("tool"));
            let mut response = object();
            if m.get("content").is_some() {
                response["result"] = result;
            }
            append_message(
                &mut contents,
                "user",
                vec![json!({"functionResponse":{"name":name,"response":response}})],
                "parts",
                false,
            );
            continue;
        }
        if get(m, "role") == "assistant" && same_native(m, profile) {
            append_message(
                &mut contents,
                "model",
                array(get(get(m, "_native"), "items")).to_vec(),
                "parts",
                false,
            );
            continue;
        }
        let mut parts = content_parts(get(m, "content"))?
            .iter()
            .map(|p| {
                if get(p, "type") == "text" {
                    json!({"text":get(p,"text")})
                } else {
                    image_part(p, protocol)
                }
            })
            .filter(|p| get(p, "text") != "")
            .collect::<Vec<_>>();
        for c in tool_calls(m) {
            let mut f = json!({"args":parse_args(get(function(c),"arguments"))});
            copy_present(&mut f, function(c), "name");
            front(&mut f, &["name", "args"]);
            parts.push(json!({"functionCall":f}));
        }
        append_message(
            &mut contents,
            if get(m, "role") == "assistant" {
                "model"
            } else {
                "user"
            },
            parts,
            "parts",
            false,
        );
    }
    let mut config = json!({"maxOutputTokens":max});
    copy_present(&mut config, sampling, "temperature");
    if let Some(p) = sampling.get("top_p") {
        config["topP"] = p.clone();
    }
    if (truthy(get(profile, "thinkingBudget")) || truthy(get(profile, "reasoningEffort")))
        && !drop.iter().any(|v| v == "thinkingConfig")
    {
        config["thinkingConfig"] = json!({"includeThoughts":true});
        if truthy(get(profile, "thinkingBudget")) {
            config["thinkingConfig"]["thinkingBudget"] = get(profile, "thinkingBudget").clone();
        }
    }
    let mut body = json!({"contents":contents,"generationConfig":config});
    if !systems.is_empty() {
        body["systemInstruction"] = json!({"parts":[{"text":systems}]});
    }
    if !tools.is_empty() {
        body["tools"] = json!([{"functionDeclarations":tool_defs(tools,protocol)}]);
        body["toolConfig"] = json!({"functionCallingConfig":{"mode":if choice=="none"{"NONE"}else if choice=="required"{"ANY"}else{"AUTO"}}});
    }
    front(
        &mut body,
        &["contents", "systemInstruction", "generationConfig"],
    );
    Ok(body)
}
fn encode_ollama(profile: &Value, messages: &[Value], options: &Value) -> CoreResult<Value> {
    let tools = array(get(options, "tools"));
    let sampling = get(options, "sampling");
    let drop = array(get(get(options, "compat"), "drop"));
    let mut names = Map::new();
    for m in messages {
        for c in tool_calls(m) {
            names.insert(string_field(c, "id"), get(function(c), "name").clone());
        }
    }
    let out=messages.iter().map(|m|{
        if get(m,"role")=="system"{return Ok(json!({"role":"system","content":as_text(get(m,"content"))?}));}
        if get(m,"role")=="tool"{let mut out=json!({"role":"tool","content":if get(m,"content").is_null(){String::new()}else{js_string(get(m,"content"))}});if let Some(name)=names.get(&string_field(m,"tool_call_id")){out["tool_name"]=name.clone();}return Ok(out);}
        let parts=content_parts(get(m,"content"))?;let images=parts.iter().filter(|p|get(p,"type")=="image_url").map(|p|strv(get(get(p,"image_url"),"url")).split_once(";base64,").unwrap().1).collect::<Vec<_>>();
        let mut out=json!({"role":if get(m,"role")=="assistant"{"assistant"}else{"user"},"content":parts.iter().filter(|p|get(p,"type")=="text").map(|p|strv(get(p,"text"))).collect::<Vec<_>>().join("\n")});
        if !images.is_empty(){out["images"]=json!(images);}if !tool_calls(m).is_empty(){out["tool_calls"]=json!(tool_calls(m).iter().map(|c|{let mut f=json!({"arguments":parse_args(get(function(c),"arguments"))});copy_present(&mut f,function(c),"name");front(&mut f, &["name", "arguments"]);json!({"function":f})}).collect::<Vec<_>>());}Ok(out)
    }).collect::<CoreResult<Vec<_>>>()?;
    let mut opts = json!({"num_predict":opt(options,"maxTokens",json!(4096))});
    if truthy(get(options, "numCtx")) {
        opts["num_ctx"] = get(options, "numCtx").clone();
    }
    for k in [
        "temperature",
        "top_p",
        "top_k",
        "min_p",
        "repeat_penalty",
        "seed",
        "presence_penalty",
        "frequency_penalty",
    ] {
        copy_present(&mut opts, sampling, k);
    }
    let mut body = json!({"messages":out,"stream":true,"options":opts});
    copy_present(&mut body, profile, "model");
    if !drop.iter().any(|v| v == "keep_alive") {
        body["keep_alive"] = json!("30m");
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    if truthy(get(profile, "reasoningEffort")) && !drop.iter().any(|v| v == "think") {
        body["think"] = if get(profile, "reasoningEffort") == "minimal" {
            json!(false)
        } else {
            get(profile, "reasoningEffort").clone()
        };
    }
    front(&mut body, &["model"]);
    Ok(body)
}

fn event(events: &mut Vec<Value>, kind: &str, value: Value) {
    events.push(json!({"type":kind,"value":value}));
}
fn whitespace(c: u16) -> bool {
    matches!(c,0x0009..=0x000d|0x0020|0x00a0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
}
#[derive(Default)]
pub struct ThinkSplitter {
    mode: u8,
    buffer: Vec<u16>,
    text: Vec<u16>,
    reasoning: Vec<u16>,
}
impl ThinkSplitter {
    pub fn push(&mut self, chunk: &str, events: &mut Vec<Value>) {
        self.buffer.extend(units(chunk));
        loop {
            if self.mode == 0 {
                let at = self
                    .buffer
                    .iter()
                    .position(|c| !whitespace(*c))
                    .unwrap_or(self.buffer.len());
                let t = &self.buffer[at..];
                let start = [60, 116, 104, 105, 110, 107, 62];
                if t.len() < 7 && start.starts_with(t) {
                    return;
                }
                if t.starts_with(&start) {
                    self.mode = 1;
                    self.buffer.drain(..at + 7);
                    continue;
                }
                self.mode = 2;
                continue;
            }
            if self.mode == 1 {
                let end = [60, 47, 116, 104, 105, 110, 107, 62];
                if let Some(i) = self.buffer.windows(8).position(|w| w == end) {
                    let part = self.buffer.drain(..i).collect::<Vec<_>>();
                    self.emit_reasoning(part, events);
                    self.buffer.drain(..8);
                    let at = self
                        .buffer
                        .iter()
                        .position(|c| !whitespace(*c))
                        .unwrap_or(self.buffer.len());
                    self.buffer.drain(..at);
                    self.mode = 2;
                    continue;
                }
                let count = self.buffer.len().saturating_sub(8);
                let part = self.buffer.drain(..count).collect::<Vec<_>>();
                self.emit_reasoning(part, events);
                return;
            }
            if !self.buffer.is_empty() {
                let part = std::mem::take(&mut self.buffer);
                self.text.extend_from_slice(&part);
                event(events, "text", json!(from_units(&part)));
            }
            return;
        }
    }
    fn emit_reasoning(&mut self, part: Vec<u16>, events: &mut Vec<Value>) {
        if !part.is_empty() {
            self.reasoning.extend_from_slice(&part);
            event(events, "reasoning", json!(from_units(&part)));
        }
    }
    pub fn finish(&mut self, events: &mut Vec<Value>) {
        let part = std::mem::take(&mut self.buffer);
        if self.mode == 1 {
            self.emit_reasoning(part, events);
        } else if !part.is_empty() {
            self.text.extend_from_slice(&part);
            event(events, "text", json!(from_units(&part)));
        }
    }
    pub fn text(&self) -> String {
        from_units(&self.text)
    }
    pub fn reasoning(&self) -> String {
        from_units(&self.reasoning)
    }
    fn snapshot(&self, events: Vec<Value>) -> Value {
        json!({"events":events,"text":self.text(),"reasoning":self.reasoning()})
    }
}
fn is_overflow(text: &str) -> bool {
    let s = text.to_lowercase();
    if [
        "maximum context",
        "too many tokens",
        "prompt is too long",
        "prompt too long",
        "input is too long",
        "n_ctx",
        "reduce the length",
        "longer than the model",
        "too large for model",
        "context limit",
    ]
    .iter()
    .any(|p| s.contains(p))
    {
        return true;
    }
    for suffix in ["length", "window", "size"] {
        for sep in ["", "_", " ", "-"] {
            if s.contains(&format!("context{sep}{suffix}")) {
                return true;
            }
        }
    }
    for verb in ["exceed ", "exceeds "] {
        for a in ["", "the "] {
            for b in ["", "available ", "model ", "models ", "model' ", "model's "] {
                if s.contains(&format!("{verb}{a}{b}context")) {
                    return true;
                }
            }
        }
    }
    false
}
fn provider_error(kind: &str, message: &str) -> CoreError {
    CoreError(format!(
        "[provider]{}",
        json_codec::stringify_js(&json!({"kind":kind,"message":truncate(message,300)}))
            .unwrap_or_default()
    ))
}
/// Fail closed on malformed collections that could otherwise discard tool data.
/// Missing, null and other falsy values retain the legacy `value || []` fallback.
fn checked_upstream_array<'a>(value: &'a Value, field: &str) -> CoreResult<&'a [Value]> {
    if !truthy(value) {
        return Ok(&[]);
    }
    let values = value.as_array().ok_or_else(|| {
        provider_error("transient", &format!("Invalid {field}: expected an array"))
    })?;
    if values.iter().any(Value::is_null) {
        return Err(provider_error(
            "transient",
            &format!("Invalid {field}: null item"),
        ));
    }
    Ok(values.as_slice())
}
fn usage() -> Value {
    json!({"input":0,"output":0,"cacheRead":0,"cacheWrite":0})
}
fn zero(v: &Value) -> Value {
    if truthy(v) {
        v.clone()
    } else {
        json!(0)
    }
}
fn plus(a: &Value, b: &Value) -> Value {
    if a.is_string() || b.is_string() {
        json!(format!("{}{}", js_string(a), js_string(b)))
    } else {
        json!(a.as_f64().unwrap_or(0.0) + b.as_f64().unwrap_or(0.0))
    }
}
fn canonical_call(id: Option<Value>, name: Option<Value>, arguments: String) -> Value {
    let mut out = json!({"type":"function","function":{"arguments":arguments}});
    if let Some(id) = id {
        out["id"] = id;
    }
    if let Some(name) = name {
        out["function"]["name"] = name;
    }
    front(&mut out["function"], &["name", "arguments"]);
    front(&mut out, &["id", "type", "function"]);
    out
}
/// Stateful protocol decoder, usable without Node. `id_prefix` is one fresh
/// collision-resistant response identity supplied by the host (UUID in Node).
pub struct Decoder {
    profile: Value,
    kind: String,
    id_prefix: String,
    split: ThinkSplitter,
    content: String,
    reasoning: String,
    stop: Option<String>,
    calls: Vec<(i64, Value)>,
    usage: Value,
    done: Option<Value>,
    native: Vec<Value>,
    blocks: std::collections::BTreeMap<u64, Value>,
    partial: std::collections::BTreeMap<u64, String>,
    blocked: bool,
}
impl Decoder {
    pub fn new(profile: Value, kind: &str, id_prefix: &str) -> CoreResult<Self> {
        if ![
            "chat-completions",
            "responses",
            "anthropic",
            "gemini",
            "ollama",
        ]
        .contains(&kind)
        {
            return Err(invalid("Unsupported provider protocol"));
        }
        Ok(Self {
            profile,
            kind: kind.into(),
            id_prefix: id_prefix.into(),
            split: ThinkSplitter::default(),
            content: String::new(),
            reasoning: String::new(),
            stop: None,
            calls: vec![],
            usage: usage(),
            done: None,
            native: vec![],
            blocks: Default::default(),
            partial: Default::default(),
            blocked: false,
        })
    }
    pub fn push(&mut self, packet: &Value, streamed: bool) -> CoreResult<Vec<Value>> {
        if packet.is_null() {
            return Err(provider_error(
                "transient",
                "Invalid provider response: null packet",
            ));
        }
        let mut events = vec![];
        match self.kind.as_str() {
            "responses" => self.responses(packet, streamed, &mut events)?,
            "anthropic" => self.anthropic(packet, streamed, &mut events)?,
            "gemini" => {
                if streamed {
                    if truthy(get(packet, "error")) {
                        let err = get(packet, "error");
                        let message = string_field(err, "message");
                        return Err(provider_error(
                            if is_overflow(strv(get(err, "message"))) {
                                "overflow"
                            } else {
                                "transient"
                            },
                            &message,
                        ));
                    }
                    self.gemini(packet, &mut events)?;
                } else if let Some(packets) = packet.as_array() {
                    for p in packets {
                        self.gemini(p, &mut events)?;
                    }
                } else {
                    self.gemini(packet, &mut events)?;
                }
            }
            "ollama" => self.ollama(packet, &mut events)?,
            _ => self.chat(packet, &mut events)?,
        };
        Ok(events)
    }
    fn chat(&mut self, p: &Value, events: &mut Vec<Value>) -> CoreResult<()> {
        if truthy(get(p, "error")) {
            let err = get(p, "error");
            return Err(provider_error(
                if is_overflow(&js_json(err)?) {
                    "overflow"
                } else {
                    "transient"
                },
                &js_string(fallback(get(err, "message"), err)),
            ));
        }
        if truthy(get(p, "prompt_progress")) {
            event(events, "progress", get(p, "prompt_progress").clone());
        }
        if truthy(get(p, "usage")) {
            let u = get(p, "usage");
            self.usage["input"] = zero(get(u, "prompt_tokens"));
            self.usage["output"] = zero(get(u, "completion_tokens"));
            self.usage["cacheRead"] = zero(fallback(
                get(get(u, "prompt_tokens_details"), "cached_tokens"),
                get(u, "cache_read_input_tokens"),
            ));
        } else if get(p, "timings").get("prompt_n").is_some() {
            let t = get(p, "timings");
            self.usage["input"] = plus(&zero(get(t, "prompt_n")), &zero(get(t, "cache_n")));
            self.usage["output"] = zero(get(t, "predicted_n"));
            self.usage["cacheRead"] = zero(get(t, "cache_n"));
        }
        let Some(c) = array(get(p, "choices")).first() else {
            return Ok(());
        };
        let delta = fallback(get(c, "delta"), get(c, "message"));
        if let Some(s) = get(delta, "content").as_str() {
            self.split.push(s, events);
        }
        let r = delta
            .get("reasoning_content")
            .filter(|v| !v.is_null())
            .unwrap_or(get(delta, "reasoning"));
        if let Some(s) = r.as_str().filter(|s| !s.is_empty()) {
            self.reasoning.push_str(s);
            event(events, "reasoning", json!(s));
        }
        if truthy(get(delta, "refusal")) {
            self.stop = Some("refusal".into());
        }
        for call in checked_upstream_array(
            get(delta, "tool_calls"),
            "Chat Completions delta.tool_calls",
        )? {
            let index = get(call, "index")
                .as_f64()
                .filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
                .map(|n| n as i64)
                .unwrap_or(self.calls.len() as i64);
            let pos = self.calls.iter().position(|(i, _)| *i == index);
            let mut item = pos
                .map(|i| self.calls[i].1.clone())
                .unwrap_or_else(|| canonical_call(Some(json!("")), Some(json!("")), String::new()));
            if truthy(get(call, "id")) {
                item["id"] = get(call, "id").clone();
            }
            if truthy(get(function(call), "name")) {
                item["function"]["name"] = json!(format!(
                    "{}{}",
                    strv(get(function(&item), "name")),
                    js_string(get(function(call), "name"))
                ));
            }
            if let Some(args) = function(call).get("arguments") {
                let arg = if let Some(s) = args.as_str() {
                    s.to_string()
                } else {
                    js_json(args)?
                };
                item["function"]["arguments"] = json!(format!(
                    "{}{}",
                    strv(get(function(&item), "arguments")),
                    arg
                ));
            }
            if units(strv(get(function(&item), "arguments"))).len() >= 1_000_000 {
                return Err(limit_error("Tool arguments exceeded limit"));
            }
            if let Some(i) = pos {
                self.calls[i].1 = item;
            } else {
                self.calls.push((index, item));
            }
        }
        if truthy(get(c, "finish_reason")) {
            self.stop = Some(js_string(get(c, "finish_reason")));
        }
        Ok(())
    }
    fn responses(&mut self, e: &Value, streamed: bool, events: &mut Vec<Value>) -> CoreResult<()> {
        if !streamed {
            self.done = Some(e.clone());
            self.stop = Some(
                if get(e, "status") == "completed" {
                    "stop"
                } else if get(get(e, "incomplete_details"), "reason") == "content_filter" {
                    "refusal"
                } else {
                    "length"
                }
                .into(),
            );
            return Ok(());
        }
        match strv(get(e, "type")) {
            "response.output_text.delta" => {
                self.content.push_str(&string_field(e, "delta"));
                event(events, "text", get(e, "delta").clone());
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                event(events, "reasoning", get(e, "delta").clone())
            }
            "response.completed" | "response.incomplete" => {
                self.done = Some(get(e, "response").clone());
                self.stop = Some(
                    if get(e, "type") == "response.completed" {
                        "stop"
                    } else if get(get(get(e, "response"), "incomplete_details"), "reason")
                        == "content_filter"
                    {
                        "refusal"
                    } else {
                        "length"
                    }
                    .into(),
                );
            }
            "response.failed" | "error" => {
                let err = fallback(
                    get(get(e, "response"), "error"),
                    fallback(get(e, "error"), e),
                );
                return Err(provider_error(
                    if is_overflow(&js_json(err)?) {
                        "overflow"
                    } else if get(err, "code") == "rate_limit_exceeded" {
                        "rate"
                    } else {
                        "transient"
                    },
                    &js_string(fallback(
                        get(err, "message"),
                        &json!("Responses stream failed"),
                    )),
                ));
            }
            _ => {}
        }
        Ok(())
    }
    fn anthropic(&mut self, e: &Value, streamed: bool, events: &mut Vec<Value>) -> CoreResult<()> {
        if !streamed {
            self.stop = e.get("stop_reason").filter(|v| truthy(v)).map(js_string);
            for (i, b) in checked_upstream_array(get(e, "content"), "Anthropic content")?
                .iter()
                .enumerate()
            {
                self.blocks.insert(i as u64, b.clone());
                if get(b, "type") == "text" {
                    event(events, "text", get(b, "text").clone());
                }
            }
            let u = get(e, "usage");
            self.usage["input"] = plus(
                &plus(
                    &zero(get(u, "input_tokens")),
                    &zero(get(u, "cache_read_input_tokens")),
                ),
                &zero(get(u, "cache_creation_input_tokens")),
            );
            self.usage["cacheRead"] = zero(get(u, "cache_read_input_tokens"));
            self.usage["output"] = zero(get(u, "output_tokens"));
            return Ok(());
        }
        match strv(get(e, "type")) {
            "message_start" => {
                let u = get(get(e, "message"), "usage");
                self.usage["input"] = plus(
                    &plus(
                        &zero(get(u, "input_tokens")),
                        &zero(get(u, "cache_read_input_tokens")),
                    ),
                    &zero(get(u, "cache_creation_input_tokens")),
                );
                self.usage["cacheRead"] = zero(get(u, "cache_read_input_tokens"));
                self.usage["cacheWrite"] = zero(get(u, "cache_creation_input_tokens"));
                self.usage["output"] = zero(get(u, "output_tokens"));
            }
            "content_block_start" => {
                let b = get(e, "content_block").clone();
                if b.is_null() {
                    return Err(provider_error(
                        "transient",
                        "Invalid Anthropic content block",
                    ));
                }
                if let Some(i) = block_index(get(e, "index")) {
                    if get(&b, "type") == "tool_use" {
                        self.partial.insert(i, String::new());
                    }
                    self.blocks.insert(i, b);
                }
            }
            "content_block_delta" => {
                if let Some(i) = block_index(get(e, "index")) {
                    if let Some(b) = self.blocks.get_mut(&i) {
                        // Provider blocks are untrusted JSON. Indexing a scalar
                        // Value would panic across the native boundary.
                        if !truthy(b) {
                            return Ok(());
                        }
                        let d = get(e, "delta");
                        if matches!(
                            strv(get(d, "type")),
                            "text_delta" | "thinking_delta" | "signature_delta"
                        ) && !b.is_object()
                        {
                            return Err(provider_error(
                                "transient",
                                "Invalid Anthropic content block",
                            ));
                        }
                        match strv(get(d, "type")) {
                            "text_delta" => {
                                b["text"] = json!(format!(
                                    "{}{}",
                                    js_string(fallback(get(b, "text"), &json!(""))),
                                    string_field(d, "text")
                                ));
                                event(events, "text", get(d, "text").clone());
                            }
                            "input_json_delta" => {
                                let prev = self
                                    .partial
                                    .get(&i)
                                    .cloned()
                                    .unwrap_or_else(|| "undefined".into());
                                self.partial.insert(
                                    i,
                                    format!("{}{}", prev, string_field(d, "partial_json")),
                                );
                            }
                            "thinking_delta" => {
                                b["thinking"] = json!(format!(
                                    "{}{}",
                                    js_string(fallback(get(b, "thinking"), &json!(""))),
                                    string_field(d, "thinking")
                                ));
                                event(events, "reasoning", get(d, "thinking").clone());
                            }
                            "signature_delta" => {
                                b["signature"] = json!(format!(
                                    "{}{}",
                                    js_string(fallback(get(b, "signature"), &json!(""))),
                                    string_field(d, "signature")
                                ));
                            }
                            _ => {}
                        }
                    }
                }
            }
            "message_delta" => {
                if truthy(get(get(e, "delta"), "stop_reason")) {
                    self.stop = Some(js_string(get(get(e, "delta"), "stop_reason")));
                }
                if truthy(get(get(e, "usage"), "output_tokens")) {
                    self.usage["output"] = get(get(e, "usage"), "output_tokens").clone();
                }
            }
            "error" => {
                let err = get(e, "error");
                return Err(provider_error(
                    if get(err, "type") == "overloaded_error" {
                        "transient"
                    } else if get(err, "type") == "rate_limit_error" {
                        "rate"
                    } else if is_overflow(strv(get(err, "message"))) {
                        "overflow"
                    } else {
                        "transient"
                    },
                    &js_string(fallback(
                        get(err, "message"),
                        &json!("Anthropic stream error"),
                    )),
                ));
            }
            _ => {}
        }
        Ok(())
    }
    fn gemini(&mut self, p: &Value, events: &mut Vec<Value>) -> CoreResult<()> {
        if p.is_null() {
            return Err(provider_error(
                "transient",
                "Invalid Gemini response: null packet",
            ));
        }
        if truthy(get(get(p, "promptFeedback"), "blockReason")) {
            self.blocked = true;
        }
        let c = array(get(p, "candidates")).first().unwrap_or(&NULL);
        for part in checked_upstream_array(get(get(c, "content"), "parts"), "Gemini content.parts")?
        {
            self.native.push(part.clone());
            if let Some(s) = get(part, "text").as_str() {
                if truthy(get(part, "thought")) {
                    self.reasoning.push_str(s);
                    event(events, "reasoning", json!(s));
                } else {
                    self.content.push_str(s);
                    event(events, "text", json!(s));
                }
            }
        }
        if truthy(get(c, "finishReason")) {
            self.stop = Some(js_string(get(c, "finishReason")));
        }
        if truthy(get(p, "usageMetadata")) {
            let u = get(p, "usageMetadata");
            self.usage["input"] = zero(get(u, "promptTokenCount"));
            self.usage["output"] = plus(
                &zero(get(u, "candidatesTokenCount")),
                &zero(get(u, "thoughtsTokenCount")),
            );
            self.usage["cacheRead"] = zero(get(u, "cachedContentTokenCount"));
        }
        Ok(())
    }
    fn ollama(&mut self, p: &Value, events: &mut Vec<Value>) -> CoreResult<()> {
        if truthy(get(p, "error")) {
            let message = js_string(get(p, "error"));
            return Err(provider_error(
                if is_overflow(&message) {
                    "overflow"
                } else {
                    "transient"
                },
                &message,
            ));
        }
        let m = get(p, "message");
        if let Some(s) = get(m, "thinking").as_str().filter(|s| !s.is_empty()) {
            self.reasoning.push_str(s);
            event(events, "reasoning", json!(s));
        }
        if let Some(s) = get(m, "content").as_str().filter(|s| !s.is_empty()) {
            self.split.push(s, events);
        }
        for c in checked_upstream_array(get(m, "tool_calls"), "Ollama message.tool_calls")? {
            let i = self.calls.len();
            let id = if truthy(get(c, "id")) {
                get(c, "id").clone()
            } else {
                json!(format!("call_{}_{i}", self.id_prefix))
            };
            let f = function(c);
            let args = if let Some(s) = get(f, "arguments").as_str() {
                s.to_string()
            } else {
                js_json(fallback(get(f, "arguments"), &object()))?
            };
            self.calls.push((
                i as i64,
                canonical_call(
                    Some(id),
                    Some(json!(js_string(fallback(get(f, "name"), &json!(""))))),
                    args,
                ),
            ));
        }
        if truthy(get(p, "done")) {
            self.stop = Some(js_string(fallback(get(p, "done_reason"), &json!("stop"))));
            self.usage["input"] = zero(get(p, "prompt_eval_count"));
            self.usage["output"] = zero(get(p, "eval_count"));
            self.usage["uncachedOnly"] = json!(true);
        }
        Ok(())
    }
    pub fn finish(&mut self) -> CoreResult<Value> {
        let mut events = vec![];
        let mut calls = vec![];
        let mut native = vec![];
        let mut text = self.content.clone();
        let mut reasoning = self.reasoning.clone();
        let stop = self.stop.as_deref().unwrap_or("");
        let finish: String;
        match self.kind.as_str() {
            "responses" => {
                let done = self.done.as_ref().filter(|d| truthy(d)).ok_or_else(|| {
                    provider_error("transient", "Responses stream ended before completion")
                })?;
                native = array(get(done, "output")).to_vec();
                if native.iter().any(Value::is_null) {
                    return Err(provider_error(
                        "transient",
                        "Invalid Responses output: null item",
                    ));
                }
                let mut output = String::new();
                reasoning.clear();
                let mut kind = if stop.is_empty() { "other" } else { stop }.to_string();
                for item in &native {
                    match strv(get(item, "type")) {
                        "message" => {
                            for part in checked_upstream_array(
                                get(item, "content"),
                                "Responses message.content",
                            )? {
                                if get(part, "type") == "output_text" {
                                    output.push_str(&string_field(part, "text"));
                                }
                                if get(part, "type") == "refusal" {
                                    kind = "refusal".into();
                                }
                            }
                        }
                        "reasoning" => reasoning.push_str(
                            &checked_upstream_array(
                                get(item, "summary"),
                                "Responses reasoning.summary",
                            )?
                            .iter()
                            .map(|s| js_string(fallback(get(s, "text"), &json!(""))))
                            .collect::<Vec<_>>()
                            .join("\n"),
                        ),
                        "function_call" => {
                            let args = if let Some(s) = get(item, "arguments").as_str() {
                                s.into()
                            } else {
                                js_json(fallback(get(item, "arguments"), &object()))?
                            };
                            calls.push(canonical_call(
                                item.get("call_id").cloned(),
                                item.get("name").cloned(),
                                args,
                            ));
                        }
                        _ => {}
                    }
                }
                if !output.is_empty() {
                    if text.is_empty() {
                        event(&mut events, "text", json!(output));
                    }
                    text = output;
                }
                let u = get(done, "usage");
                self.usage["input"] = zero(get(u, "input_tokens"));
                self.usage["output"] = zero(get(u, "output_tokens"));
                self.usage["cacheRead"] =
                    zero(get(get(u, "input_tokens_details"), "cached_tokens"));
                finish = if kind == "stop" && !calls.is_empty() {
                    "tool_calls".into()
                } else {
                    kind
                };
            }
            "anthropic" => {
                text.clear();
                reasoning.clear();
                for (i, block) in &self.blocks {
                    if !truthy(block) {
                        continue;
                    }
                    let mut b = block.clone();
                    if get(&b, "type") == "tool_use" {
                        let raw = match self.partial.get(i) {
                            Some(s) => s.clone(),
                            None => js_json(fallback(get(&b, "input"), &object()))?,
                        };
                        let input = if raw.is_empty() {
                            object()
                        } else {
                            json_codec::parse_js_text(&raw).unwrap_or_else(|_| object())
                        };
                        calls.push(canonical_call(
                            b.get("id").cloned(),
                            b.get("name").cloned(),
                            if raw.is_empty() { "{}".into() } else { raw },
                        ));
                        b["input"] = input;
                    } else if get(&b, "type") == "text" {
                        text.push_str(&js_string(fallback(get(&b, "text"), &json!(""))));
                    } else if get(&b, "type") == "thinking" {
                        reasoning.push_str(&js_string(fallback(get(&b, "thinking"), &json!(""))));
                    }
                    native.push(b);
                }
                finish = if stop == "max_tokens" {
                    "length"
                } else if stop == "refusal" {
                    "refusal"
                } else if stop == "tool_use" || !calls.is_empty() {
                    "tool_calls"
                } else if !stop.is_empty() {
                    "stop"
                } else {
                    "other"
                }
                .into();
            }
            "gemini" => {
                native = self.native.clone();
                for (i, p) in native
                    .iter()
                    .filter(|p| truthy(get(p, "functionCall")))
                    .enumerate()
                {
                    let f = get(p, "functionCall");
                    calls.push(canonical_call(
                        Some(if truthy(get(f, "id")) {
                            get(f, "id").clone()
                        } else {
                            json!(format!("g_{}_{i}", self.id_prefix))
                        }),
                        f.get("name").cloned(),
                        js_json(fallback(get(f, "args"), &object()))?,
                    ));
                }
                finish = if self.blocked
                    || [
                        "SAFETY",
                        "RECITATION",
                        "BLOCKLIST",
                        "PROHIBITED_CONTENT",
                        "SPII",
                    ]
                    .contains(&stop)
                {
                    "refusal"
                } else if stop == "MAX_TOKENS" {
                    "length"
                } else if !calls.is_empty() {
                    "tool_calls"
                } else if stop == "STOP" {
                    "stop"
                } else {
                    "other"
                }
                .into();
            }
            _ => {
                self.split.finish(&mut events);
                text = self.split.text();
                reasoning.push_str(&self.split.reasoning());
                for (_, c) in &self.calls {
                    if truthy(get(function(c), "name")) {
                        let mut c = c.clone();
                        if !truthy(get(&c, "id")) {
                            c["id"] = json!(format!("call_{}_{}", self.id_prefix, calls.len()));
                        }
                        calls.push(c);
                    }
                }
                finish = if stop == "length" {
                    "length"
                } else if self.kind != "ollama" && (stop == "content_filter" || stop == "refusal") {
                    "refusal"
                } else if !calls.is_empty() {
                    "tool_calls"
                } else if !stop.is_empty() {
                    "stop"
                } else {
                    "other"
                }
                .into();
            }
        }
        let mut result = json!({"role":"assistant","content":if text.is_empty(){Value::Null}else{json!(text)},"reasoning":if reasoning.is_empty(){Value::Null}else{json!(reasoning)},"finish":finish,"usage":self.usage});
        if !calls.is_empty() {
            result["tool_calls"] = json!(calls);
        }
        if !native.is_empty() {
            let mut state = json!({"items":native});
            copy_present(&mut state, &self.profile, "identity");
            front(&mut state, &["identity", "items"]);
            result["_native"] = state;
        }
        front(
            &mut result,
            &[
                "role",
                "content",
                "reasoning",
                "tool_calls",
                "finish",
                "usage",
                "_native",
            ],
        );
        Ok(json!({"events":events,"result":result}))
    }
}
fn block_index(value: &Value) -> Option<u64> {
    let n = if let Some(s) = value.as_str() {
        if s.is_empty() || (s.len() > 1 && s.starts_with('0')) {
            return None;
        }
        s.parse::<u64>().ok()?
    } else {
        value.as_u64()?
    };
    (n < 4_294_967_295).then_some(n)
}

#[cfg(feature = "node")]
mod binding {
    use super::*;
    use napi_derive::napi;
    fn native<T>(result: CoreResult<T>) -> napi::Result<T> {
        result.map_err(|e| napi::Error::from_reason(e.to_string()))
    }
    #[napi(js_name = "encodeProtocolRequest")]
    pub fn encode_protocol_request(payload_json: String) -> napi::Result<String> {
        native((|| {
            let p = json_codec::parse(&payload_json)?;
            let result = encode_request(
                get(&p, "profile"),
                array(get(&p, "messages")),
                get(&p, "options"),
                get(&p, "ollama") == true,
            )?;
            json_codec::stringify_js(&result)
        })())
    }
    #[napi]
    pub struct ProtocolDecoderCore {
        decoder: Decoder,
    }
    #[napi]
    impl ProtocolDecoderCore {
        #[napi(constructor)]
        pub fn new(profile_json: String, kind: String, id_prefix: String) -> napi::Result<Self> {
            native((|| {
                Ok(Self {
                    decoder: Decoder::new(json_codec::parse(&profile_json)?, &kind, &id_prefix)?,
                })
            })())
        }
        #[napi]
        pub fn push(&mut self, packet_json: String, streamed: bool) -> napi::Result<String> {
            native((|| {
                let packet = json_codec::parse(&packet_json)?;
                let events = self.decoder.push(&packet, streamed)?;
                json_codec::stringify_js(&json!(events))
            })())
        }
        #[napi]
        pub fn finish(&mut self) -> napi::Result<String> {
            native(
                self.decoder
                    .finish()
                    .and_then(|v| json_codec::stringify_js(&v)),
            )
        }
    }
    #[napi]
    pub struct ThinkSplitterCore {
        splitter: ThinkSplitter,
    }
    #[napi]
    impl ThinkSplitterCore {
        #[napi(constructor)]
        pub fn new() -> Self {
            Self {
                splitter: ThinkSplitter::default(),
            }
        }
        #[napi]
        pub fn push(&mut self, chunk_json: String) -> napi::Result<String> {
            native((|| {
                let chunk = json_codec::parse(&chunk_json)?;
                let mut events = vec![];
                self.splitter.push(&js_string(&chunk), &mut events);
                json_codec::stringify_js(&self.splitter.snapshot(events))
            })())
        }
        #[napi]
        pub fn finish(&mut self) -> napi::Result<String> {
            let mut events = vec![];
            self.splitter.finish(&mut events);
            native(json_codec::stringify_js(&self.splitter.snapshot(events)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile(protocol: &str) -> Value {
        json!({"protocol":protocol,"model":"test-model","identity":"provider-one","domain":"cloud"})
    }
    fn decoder(protocol: &str) -> Decoder {
        Decoder::new(profile(protocol), protocol, "12345678-abcd").unwrap()
    }
    fn finish(decoder: &mut Decoder) -> Value {
        decoder.finish().unwrap()["result"].clone()
    }
    #[test]
    fn encoders_preserve_native_items_only_for_exact_identity() {
        for protocol in ["responses", "anthropic", "gemini"] {
            let p = profile(protocol);
            let native = match protocol {
                "anthropic" => {
                    json!({"type":"thinking","thinking":"hidden","signature":"opaque-secret"})
                }
                "gemini" => {
                    json!({"thoughtSignature":"opaque-secret","functionCall":{"name":"read","args":{}}})
                }
                _ => json!({"type":"reasoning","encrypted_content":"opaque-secret"}),
            };
            let message = json!({"role":"assistant","content":"fallback","_native":{"identity":"provider-one","items":[native]}});
            assert!(
                js_json(&encode_request(&p, &[message.clone()], &object(), false).unwrap())
                    .unwrap()
                    .contains("opaque-secret")
            );
            let mut other = p.clone();
            other["identity"] = json!("provider-two");
            assert!(
                !js_json(&encode_request(&other, &[message], &object(), false).unwrap())
                    .unwrap()
                    .contains("opaque-secret")
            );
        }
    }
    #[test]
    fn malformed_tool_arguments_encode_as_empty_objects_but_chat_keeps_raw() {
        let messages = json!([{"role":"assistant","content":null,"tool_calls":[{"id":"a","function":{"name":"read","arguments":"{broken"}}]},{"role":"tool","tool_call_id":"a","content":"[1,2]"}]);
        for protocol in ["chat-completions", "responses", "anthropic", "gemini"] {
            let body = encode_request(
                &profile(protocol),
                messages.as_array().unwrap(),
                &object(),
                false,
            )
            .unwrap();
            match protocol {
                "chat-completions" => assert_eq!(
                    body["messages"][0]["tool_calls"][0]["function"]["arguments"],
                    "{broken"
                ),
                "responses" => assert_eq!(body["input"][0]["arguments"], "{broken"),
                "anthropic" => assert_eq!(body["messages"][0]["content"][0]["input"], object()),
                _ => {
                    assert_eq!(
                        body["contents"][0]["parts"][0]["functionCall"]["args"],
                        object()
                    );
                    assert_eq!(
                        body["contents"][1]["parts"][0]["functionResponse"]["response"]["result"],
                        json!([1, 2])
                    );
                }
            }
        }
    }
    #[test]
    fn request_controls_and_image_validation_remain_protocol_specific() {
        let mut p = profile("chat-completions");
        p["server"] = json!("llama.cpp");
        let options = json!({"maxTokens":99,"slot":2,"cacheKey":"session","cacheRetention":"long","compat":{"drop":["max_tokens","stream_options"]},"sampling":{"temperature":0.4}});
        let body = encode_request(
            &p,
            &[json!({"role":"user","content":"hi"})],
            &options,
            false,
        )
        .unwrap();
        assert_eq!(body["max_completion_tokens"], 99);
        assert!(body.get("max_tokens").is_none());
        assert!(body.get("stream_options").is_none());
        assert_eq!(body["id_slot"], 2);
        assert_eq!(body["return_progress"], true);
        assert_eq!(body["prompt_cache_retention"], "24h");
        let image = json!({"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,YQ=="}}]});
        assert_eq!(
            encode_request(&profile("gemini"), &[image.clone()], &object(), false).unwrap()
                ["contents"][0]["parts"][0]["inlineData"]["data"],
            "YQ=="
        );
        let mut bad = image;
        bad["content"][0]["image_url"]["url"] = json!("https://example.com/private.png");
        assert!(encode_request(&profile("responses"), &[bad], &object(), false).is_err());
    }
    #[test]
    fn anthropic_cache_has_system_and_latest_three_marked_breakpoints() {
        let mut messages = vec![json!({"role":"system","content":"system"})];
        for i in 0..8 {
            messages.push(json!({"role":if i%2==0{"user"}else{"assistant"},"content":format!("message {i}"),"cache":true}));
        }
        let body = encode_request(
            &profile("anthropic"),
            &messages,
            &json!({"cacheRetention":"long"}),
            false,
        )
        .unwrap();
        assert_eq!(body["system"][0]["cache_control"]["ttl"], "1h");
        assert_eq!(
            array(&body["messages"])
                .iter()
                .filter(|m| m["content"][0].get("cache_control").is_some())
                .count(),
            3
        );
        assert!(array(&body["messages"])
            .iter()
            .all(|m| m.get("mark").is_none()));
    }
    #[test]
    fn think_splitter_preserves_utf16_and_callback_order() {
        let mut split = ThinkSplitter::default();
        let mut events = vec![];
        for chunk in ["<th", "ink>考える", "😀</th", "ink>\n\n答え", "です"] {
            split.push(chunk, &mut events);
        }
        split.finish(&mut events);
        assert_eq!(split.text(), "答えです");
        assert_eq!(split.reasoning(), "考える😀");
        assert_eq!(events.last().unwrap()["value"], "です");
        let high = json_codec::parse(r#""\ud83d""#).unwrap();
        let low = json_codec::parse(r#""\ude00""#).unwrap();
        let mut split = ThinkSplitter::default();
        let mut e = vec![];
        split.push(strv(&high), &mut e);
        split.push(strv(&low), &mut e);
        split.finish(&mut e);
        assert_eq!(units(&split.text()), vec![0xd83d, 0xde00]);
        let mut truncated = ThinkSplitter::default();
        truncated.push("<think>unfinished", &mut vec![]);
        truncated.finish(&mut vec![]);
        assert_eq!(truncated.reasoning(), "unfinished");
        assert_eq!(truncated.text(), "");
    }
    #[test]
    fn chat_preserves_interleaved_call_order_raw_arguments_and_length_finish() {
        let mut d = decoder("chat-completions");
        let events=d.push(&json!({"prompt_progress":{"progress":0.2},"choices":[{"delta":{"content":"hi","reasoning_content":"thinking","tool_calls":[{"index":9,"id":"provided","function":{"name":"fi","arguments":"{\"a\":"}},{"index":2,"function":{"name":"second","arguments":{}}}]}}]}),true).unwrap();
        assert_eq!(
            events.iter().map(|v| strv(&v["type"])).collect::<Vec<_>>(),
            vec!["progress", "text", "reasoning"]
        );
        d.push(&json!({"choices":[{"delta":{"tool_calls":[{"index":9,"function":{"name":"rst","arguments":"unclosed"}}]},"finish_reason":"length"}]}),true).unwrap();
        let r = finish(&mut d);
        assert_eq!(r["finish"], "length");
        assert_eq!(r["tool_calls"][0]["id"], "provided");
        assert_eq!(r["tool_calls"][0]["function"]["name"], "first");
        assert_eq!(
            r["tool_calls"][0]["function"]["arguments"],
            "{\"a\":unclosed"
        );
        assert_eq!(r["tool_calls"][1]["id"], "call_12345678-abcd_1");
    }
    #[test]
    fn responses_requires_terminal_event_and_keeps_opaque_output() {
        let mut d = decoder("responses");
        d.push(
            &json!({"type":"response.output_text.delta","delta":"partial"}),
            true,
        )
        .unwrap();
        assert!(d
            .finish()
            .unwrap_err()
            .to_string()
            .contains("ended before completion"));
        d.push(&json!({"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"reasoning","encrypted_content":"opaque","summary":[{"text":"reason"}]},{"type":"function_call","name":"read","call_id":"id","arguments":"{cut"}],"usage":{"input_tokens":40,"output_tokens":4}}}),true).unwrap();
        let r = finish(&mut d);
        assert_eq!(r["content"], "partial");
        assert_eq!(r["reasoning"], "reason");
        assert_eq!(r["finish"], "length");
        assert_eq!(r["tool_calls"][0]["function"]["arguments"], "{cut");
        assert_eq!(r["_native"]["items"][0]["encrypted_content"], "opaque");
    }
    #[test]
    fn anthropic_sparse_blocks_keep_raw_broken_args_and_signatures() {
        let mut d = decoder("anthropic");
        for p in [
            json!({"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":5}}}),
            json!({"type":"content_block_start","index":7,"content_block":{"type":"tool_use","id":"t1","name":"write","input":{}}}),
            json!({"type":"content_block_start","index":2,"content_block":{"type":"thinking","thinking":"a"}}),
            json!({"type":"content_block_delta","index":2,"delta":{"type":"signature_delta","signature":"signed"}}),
            json!({"type":"content_block_delta","index":7,"delta":{"type":"input_json_delta","partial_json":"{broken"}}),
            json!({"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":9}}),
        ] {
            d.push(&p, true).unwrap();
        }
        let r = finish(&mut d);
        assert_eq!(r["tool_calls"][0]["function"]["arguments"], "{broken");
        assert_eq!(r["_native"]["items"][1]["input"], object());
        assert_eq!(r["_native"]["items"][0]["signature"], "signed");
        assert_eq!(r["finish"], "length");
        assert_eq!(r["usage"]["input"].as_f64(), Some(115.0));
        assert_eq!(r["usage"]["cacheWrite"], 5);
    }
    #[test]
    fn gemini_native_signature_reasoning_usage_and_safety() {
        let mut d = decoder("gemini");
        let events=d.push(&json!({"candidates":[{"content":{"parts":[{"thought":true,"text":"think"},{"text":"answer"},{"functionCall":{"name":"read","args":{"path":"a"}},"thoughtSignature":"secret"}]},"finishReason":"SAFETY"}],"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":3,"thoughtsTokenCount":4}}),true).unwrap();
        assert_eq!(events.len(), 2);
        let r = finish(&mut d);
        assert_eq!(r["finish"], "refusal");
        assert_eq!(r["reasoning"], "think");
        assert_eq!(r["usage"]["output"].as_f64(), Some(7.0));
        assert_eq!(r["_native"]["items"][2]["thoughtSignature"], "secret");
        assert!(strv(&r["tool_calls"][0]["id"]).starts_with("g_"));
    }
    #[test]
    fn ollama_native_context_images_tools_and_uncached_usage() {
        let mut p = profile("chat-completions");
        p["reasoningEffort"] = json!("minimal");
        let request = encode_request(
            &p,
            &[json!({"role":"user","content":"hello"})],
            &json!({"numCtx":8192,"maxTokens":2048}),
            true,
        )
        .unwrap();
        assert_eq!(request["options"]["num_ctx"], 8192);
        assert_eq!(request["think"], false);
        let mut d = decoder("ollama");
        d.push(&json!({"message":{"content":"<think>x</think>answer","tool_calls":[{"function":{"name":"read","arguments":{"path":"a"}}}]},"done":true,"done_reason":"stop","prompt_eval_count":4,"eval_count":2}),true).unwrap();
        let r = finish(&mut d);
        assert_eq!(r["content"], "answer");
        assert_eq!(r["reasoning"], "x");
        assert_eq!(r["finish"], "tool_calls");
        assert_eq!(r["usage"]["uncachedOnly"], true);
    }
    #[test]
    fn stream_errors_keep_recovery_kinds() {
        for (kind, p, expected) in [
            (
                "chat-completions",
                json!({"error":{"message":"maximum context length exceeded"}}),
                "overflow",
            ),
            (
                "responses",
                json!({"type":"error","error":{"code":"rate_limit_exceeded","message":"wait"}}),
                "rate",
            ),
            (
                "anthropic",
                json!({"type":"error","error":{"type":"overloaded_error","message":"busy"}}),
                "transient",
            ),
            (
                "gemini",
                json!({"error":{"message":"prompt too long"}}),
                "overflow",
            ),
            ("ollama", json!({"error":"connection lost"}), "transient"),
        ] {
            let mut d = decoder(kind);
            let error = d.push(&p, true).unwrap_err().to_string();
            let v: Value = serde_json::from_str(error.strip_prefix("[provider]").unwrap()).unwrap();
            assert_eq!(v["kind"], expected);
        }
    }
    #[test]
    fn malformed_anthropic_blocks_never_panic_in_delta_or_cache_replay() {
        for block in [json!(1), json!(true), json!("bad"), json!([])] {
            for delta in ["text_delta", "thinking_delta", "signature_delta"] {
                let mut d = decoder("anthropic");
                d.push(
                    &json!({"type":"content_block_start","index":0,"content_block":block}),
                    true,
                )
                .unwrap();
                let err=d.push(&json!({"type":"content_block_delta","index":0,"delta":{"type":delta,"text":"x","thinking":"x","signature":"x"}}),true).unwrap_err();
                assert!(err.to_string().contains("Invalid Anthropic content block"));
            }
        }
        for block in [json!(false), json!(0), json!("")] {
            let mut d = decoder("anthropic");
            d.push(
                &json!({"type":"content_block_start","index":0,"content_block":block}),
                true,
            )
            .unwrap();
            assert!(d.push(&json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}),true).unwrap().is_empty());
            assert!(finish(&mut d)["content"].is_null());
        }
        for block in [Value::Null, json!(false), json!([]), json!(1), json!("bad")] {
            let message = json!({"role":"assistant","content":null,"cache":true,"_native":{"identity":"provider-one","items":[block.clone()]}});
            let encoded = encode_request(&profile("anthropic"), &[message], &object(), false);
            if truthy(&block) && !block.is_array() {
                assert!(encoded
                    .unwrap_err()
                    .to_string()
                    .contains("Invalid native content block"));
            } else {
                assert_eq!(encoded.unwrap()["messages"][0]["content"][0], block);
            }
        }
    }
    #[test]
    fn anthropic_huge_sparse_indices_do_not_allocate_missing_blocks() {
        let mut d = decoder("anthropic");
        for index in [json!(4_294_967_294_u64), json!(2)] {
            d.push(&json!({"type":"content_block_start","index":index,"content_block":{"type":"text","text":""}}),true).unwrap();
            d.push(&json!({"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":"x"}}),true).unwrap();
        }
        d.push(&json!({"type":"content_block_start","index":4_294_967_295_u64,"content_block":{"type":"text","text":"ignored"}}),true).unwrap();
        assert_eq!(d.blocks.len(), 2);
        let result = finish(&mut d);
        assert_eq!(result["content"], "xx");
        assert_eq!(result["_native"]["items"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn malformed_upstream_collections_fail_closed_instead_of_losing_tool_data() {
        for value in [
            json!({}),
            json!("invalid"),
            json!(true),
            json!(7),
            json!([null]),
        ] {
            for (kind, packet, streamed, field) in [
                (
                    "chat-completions",
                    json!({"choices":[{"delta":{"content":"text","tool_calls":value},"finish_reason":"stop"}]}),
                    true,
                    "delta.tool_calls",
                ),
                (
                    "ollama",
                    json!({"message":{"content":"text","tool_calls":value},"done":true}),
                    true,
                    "message.tool_calls",
                ),
                (
                    "anthropic",
                    json!({"content":value,"stop_reason":"end_turn"}),
                    false,
                    "Anthropic content",
                ),
                (
                    "gemini",
                    json!({"candidates":[{"content":{"parts":value},"finishReason":"STOP"}]}),
                    true,
                    "content.parts",
                ),
            ] {
                let mut d = decoder(kind);
                let error = d.push(&packet, streamed).unwrap_err().to_string();
                assert!(error.contains(field), "{error}");
                assert!(error.contains("transient"));
            }
            for (item, field) in [
                (json!({"type":"message","content":value}), "message.content"),
                (
                    json!({"type":"reasoning","summary":value}),
                    "reasoning.summary",
                ),
            ] {
                let mut d = decoder("responses");
                d.push(&json!({"status":"completed","output":[item]}), false)
                    .unwrap();
                let error = d.finish().unwrap_err().to_string();
                assert!(error.contains(field), "{error}");
                assert!(error.contains("transient"));
            }
        }
        for value in [Value::Null, json!(false), json!(0), json!("")] {
            assert!(checked_upstream_array(&value, "field").unwrap().is_empty());
        }
    }
    #[test]
    fn null_upstream_packets_blocks_and_output_items_are_retryable_failures() {
        for protocol in [
            "chat-completions",
            "responses",
            "anthropic",
            "gemini",
            "ollama",
        ] {
            for streamed in [true, false] {
                let mut d = decoder(protocol);
                let error = d.push(&Value::Null, streamed).unwrap_err().to_string();
                assert!(error.contains("transient"));
            }
        }
        let mut d = decoder("gemini");
        assert!(d
            .push(&json!([null]), false)
            .unwrap_err()
            .to_string()
            .contains("transient"));
        let mut d = decoder("anthropic");
        assert!(d
            .push(
                &json!({"type":"content_block_start","index":0,"content_block":null}),
                true
            )
            .unwrap_err()
            .to_string()
            .contains("transient"));
        let mut d = decoder("responses");
        d.push(&json!({"status":"completed","output":[null]}), false)
            .unwrap();
        assert!(d
            .finish()
            .unwrap_err()
            .to_string()
            .contains("Invalid Responses output"));
    }
}
