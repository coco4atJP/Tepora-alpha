//! Native built-in catalog and actor-scoped state tools.
//! Catalog metadata is a frozen build-time extraction; no JavaScript runs here.
// core/tools/agent.mjs SHA-256 3a6740d68610f563b114e03eaf2a49669422f49e6ebed2a70e5ba7da4018dbcd
// core/tools/fs.mjs SHA-256 8b505f0444e48583950d3201234ce9ed67339f47fdaae4b3838cd39d7e6227b3
// core/agent/metacog.mjs SHA-256 0b847013cee7817d09f6135404d7f458a23ea30c0eb2d67f19b88410cf2be704
const CATALOG_JSON: &str = r###"[
  {
    "group": "core",
    "readOnly": true,
    "ephemeral": false,
    "name": "read",
    "description": "Read a text file with line numbers, or look at an image (PNG, JPEG, GIF, WebP, HEIC…). Use offset/limit (lines) for large files. Works on any path; relative paths are inside the session folder.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "path"
      ],
      "properties": {
        "path": {
          "type": "string"
        },
        "offset": {
          "type": "integer",
          "minimum": 1,
          "description": "First line (1-based)."
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 5000,
          "description": "Number of lines (default 800)."
        },
        "question": {
          "type": "string",
          "description": "For an image: what to look for. Used when your own model cannot see images and another model describes it."
        }
      }
    }
  },
  {
    "group": "core",
    "readOnly": false,
    "ephemeral": false,
    "name": "write",
    "description": "Create or overwrite a text file (parent folders are created). To change an existing file, read it and use edit. Set append:true to add to the end instead; write long files in several appends rather than one huge call.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "path",
        "content"
      ],
      "properties": {
        "path": {
          "type": "string"
        },
        "content": {
          "type": "string"
        },
        "append": {
          "type": "boolean"
        }
      }
    }
  },
  {
    "group": "core",
    "readOnly": false,
    "ephemeral": false,
    "name": "edit",
    "description": "Replace an exact piece of text in a file. old_string must match exactly once (include enough surrounding lines), unless replace_all is true. Read the file first.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "path",
        "old_string",
        "new_string"
      ],
      "properties": {
        "path": {
          "type": "string"
        },
        "old_string": {
          "type": "string"
        },
        "new_string": {
          "type": "string"
        },
        "replace_all": {
          "type": "boolean"
        }
      }
    }
  },
  {
    "group": "core",
    "readOnly": false,
    "ephemeral": true,
    "name": "todo",
    "description": "Keep a short checklist for multi-step work. Send the whole list each time (it replaces the previous one). Status: pending, in_progress, done, blocked. Keep exactly one item in_progress while working.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "items"
      ],
      "properties": {
        "items": {
          "type": "array",
          "maxItems": 50,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "text",
              "status"
            ],
            "properties": {
              "text": {
                "type": "string"
              },
              "status": {
                "type": "string",
                "enum": [
                  "pending",
                  "in_progress",
                  "done",
                  "blocked"
                ]
              }
            }
          }
        }
      }
    },
    "ephemeralKey": "todo"
  },
  {
    "group": "core",
    "readOnly": true,
    "ephemeral": false,
    "name": "recall",
    "description": "Read an earlier transcript entry exactly, by its reference: \"#123\" (this session) or \"<session id>#123\". Use it for details that were shortened or compacted away. offset/limit page through long entries.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "ref"
      ],
      "properties": {
        "ref": {
          "type": "string"
        },
        "offset": {
          "type": "integer",
          "minimum": 0
        },
        "limit": {
          "type": "integer",
          "minimum": 100,
          "maximum": 60000
        }
      }
    }
  },
  {
    "group": "core",
    "readOnly": true,
    "ephemeral": false,
    "name": "history_search",
    "description": "Full-text search over this session's whole transcript, including parts compacted out of view. Returns references to read with recall.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "query"
      ],
      "properties": {
        "query": {
          "type": "string"
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 30
        },
        "scope": {
          "type": "string",
          "enum": [
            "session",
            "tree"
          ]
        }
      }
    }
  },
  {
    "group": "core",
    "readOnly": true,
    "ephemeral": false,
    "name": "memory_search",
    "description": "Search long-term memory: facts about the user, their preferences, projects and past decisions saved across conversations.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "query"
      ],
      "properties": {
        "query": {
          "type": "string"
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 20
        }
      }
    }
  },
  {
    "group": "core",
    "readOnly": false,
    "ephemeral": false,
    "name": "memory_write",
    "description": "Save a durable fact to long-term memory (preferences, standing instructions, important facts about the user or their work). One fact per call; write it so it makes sense on its own later.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "content"
      ],
      "properties": {
        "content": {
          "type": "string"
        },
        "title": {
          "type": "string"
        }
      }
    }
  },
  {
    "group": "core",
    "readOnly": false,
    "ephemeral": false,
    "name": "artifact",
    "description": "Publish a document the user sees in Tepora's work view (HTML, Markdown or text), revise it, or read it. publish with an id creates a new version; edit replaces an exact piece of text (expected version required); read returns the current text.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "action"
      ],
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "publish",
            "edit",
            "read",
            "list"
          ]
        },
        "id": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "kind": {
          "type": "string",
          "enum": [
            "html",
            "markdown",
            "text"
          ]
        },
        "content": {
          "type": "string"
        },
        "old_string": {
          "type": "string"
        },
        "new_string": {
          "type": "string"
        },
        "expected_version": {
          "type": "integer",
          "minimum": 0
        }
      }
    }
  },
  {
    "group": "core",
    "readOnly": false,
    "ephemeral": false,
    "name": "sessions_spawn",
    "description": "Start a work agent on a task in the background and return immediately. It works on its own and its final report arrives to you as a message. Give a complete, self-contained task (goal, context, constraints, what to deliver). persistent:true keeps it as a named specialist you can send more tasks to later.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "task"
      ],
      "properties": {
        "task": {
          "type": "string"
        },
        "title": {
          "type": "string",
          "description": "Short name shown to the user."
        },
        "context": {
          "type": "string",
          "enum": [
            "isolated",
            "fork"
          ],
          "description": "fork copies a summary of your current context into the agent."
        },
        "persistent": {
          "type": "boolean"
        },
        "cwd": {
          "type": "string",
          "description": "Folder to work in. By default each agent gets a new folder of its own; pass the folder when the work belongs in a particular place (the user's project, or your own working folder when the user says \"the work folder\")."
        },
        "toolset": {
          "type": "string",
          "enum": [
            "worker",
            "lean"
          ]
        },
        "role": {
          "type": "string",
          "enum": [
            "work",
            "escalation"
          ],
          "description": "escalation uses the stronger configured model."
        }
      }
    }
  },
  {
    "group": "core",
    "readOnly": false,
    "ephemeral": false,
    "name": "sessions_send",
    "description": "Send a message to another session: your requester (\"parent\"), a work agent you started, or a specialist. mode followup starts a new turn (default), steer is delivered at its next step while it works, notify only adds information. wait > 0 waits that many seconds for a message back from that session (its answer via sessions_send, or its final report). To answer a session that asked you something, send your answer to it with sessions_send.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "session",
        "message"
      ],
      "properties": {
        "session": {
          "type": "string",
          "description": "Session id, label, or \"parent\"."
        },
        "message": {
          "type": "string"
        },
        "mode": {
          "type": "string",
          "enum": [
            "followup",
            "steer",
            "notify"
          ]
        },
        "wait": {
          "type": "integer",
          "minimum": 0,
          "maximum": 600
        }
      }
    }
  },
  {
    "group": "core",
    "readOnly": true,
    "ephemeral": false,
    "name": "sessions_list",
    "description": "List sessions you can see (your work agents, specialists, your requester) with their status.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "idle",
            "running",
            "waiting",
            "done",
            "stopped"
          ]
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        }
      }
    },
    "ephemeralKey": "sessions_list"
  },
  {
    "group": "core",
    "readOnly": true,
    "ephemeral": false,
    "name": "sessions_history",
    "description": "Read the recent conversation of another session you can see (tool results are left out unless include_tools).",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "session"
      ],
      "properties": {
        "session": {
          "type": "string"
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        },
        "include_tools": {
          "type": "boolean"
        }
      }
    }
  },
  {
    "group": "core",
    "readOnly": false,
    "ephemeral": false,
    "name": "sessions_stop",
    "description": "Stop a work agent you started (it keeps its transcript and can be resumed with a followup message).",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "session"
      ],
      "properties": {
        "session": {
          "type": "string"
        },
        "reason": {
          "type": "string"
        }
      }
    }
  },
  {
    "group": "core",
    "readOnly": true,
    "ephemeral": false,
    "name": "tools_search",
    "description": "Find additional tools (plugins, MCP servers, rarely used built-ins) by describing what you need. Returns names and parameter schemas to use with tools_call.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "query"
      ],
      "properties": {
        "query": {
          "type": "string"
        }
      }
    }
  },
  {
    "group": "core",
    "readOnly": false,
    "ephemeral": false,
    "name": "tools_call",
    "description": "Call a tool found with tools_search, by its exact name, with arguments matching its schema.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "name"
      ],
      "properties": {
        "name": {
          "type": "string"
        },
        "arguments": {
          "type": "object"
        }
      }
    }
  },
  {
    "group": "core",
    "readOnly": false,
    "ephemeral": true,
    "name": "reflect",
    "description": "Keep an honest picture of your own state: how you understand the task, your plan, what you have verified (with how), what you only assume, open questions, your confidence (0–1) and the next step. Fields you send replace the stored ones; others stay. Update it when the plan changes, after a surprise or failure, when a self-check asks, and before reporting. It survives compaction word for word.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "understanding": {
          "type": "string"
        },
        "plan": {
          "type": "string"
        },
        "verified": {
          "type": "array",
          "maxItems": 20,
          "items": {
            "type": "string"
          }
        },
        "assumptions": {
          "type": "array",
          "maxItems": 20,
          "items": {
            "type": "string"
          }
        },
        "open_questions": {
          "type": "array",
          "maxItems": 20,
          "items": {
            "type": "string"
          }
        },
        "confidence": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        },
        "next": {
          "type": "string"
        }
      }
    },
    "ephemeralKey": "reflect"
  }
]"###;

use super::{EffectContext, EffectError};
use crate::ApiError;
use serde_json::{json, Value};
use std::{collections::HashSet, sync::OnceLock, time::Duration};
use tepora_core::{harness, json_codec, store_domain};

/// All methods are called synchronously by scoped() on the actor. An implementation
/// holds the one Workspace state authority for the complete scoped operation.
/// Return owned values only; never retain SQLite guards in an effect future.
pub trait ToolsState {
    fn sessions(&mut self) -> Result<Vec<Value>, ApiError>;
    fn session(&mut self, id: &str) -> Result<Value, ApiError>;
    fn update_session(&mut self, id: &str, patch: Value) -> Result<Value, ApiError>;
    fn entry(&mut self, id: &str, seq: u64) -> Result<Option<Value>, ApiError>;
    fn tail(&mut self, id: &str, count: usize) -> Result<Vec<Value>, ApiError>;
    fn search_history(
        &mut self,
        query: &str,
        ids: &[String],
        limit: usize,
    ) -> Result<Vec<Value>, ApiError>;
    fn evidence(&mut self, id: &str) -> Result<Option<Value>, ApiError>;
    fn inbox(&mut self, id: &str) -> Result<Vec<Value>, ApiError>;
    /// Fetch and delete under the same state lock. None means already consumed.
    fn take_inbox_item(&mut self, id: &str, item_id: &str) -> Result<Option<Value>, ApiError>;
    fn list_docs(&mut self, collection: &str) -> Result<Vec<Value>, ApiError>;
    fn get_doc(&mut self, collection: &str, id: &str) -> Result<Option<Value>, ApiError>;
    fn search_memory(&mut self, query: &str, limit: usize) -> Result<Vec<Value>, ApiError>;
    fn write_memory(&mut self, content: &str, title: &str, source: &str)
        -> Result<Value, ApiError>;
    fn publish_artifact(
        &mut self,
        title: &str,
        content: &str,
        options: Value,
    ) -> Result<Value, ApiError>;
    fn now(&self) -> String {
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }
}

pub const IMPLEMENTED: &[&str] = &[
    "read",
    "write",
    "edit",
    "todo",
    "recall",
    "history_search",
    "memory_search",
    "memory_write",
    "artifact",
    "sessions_spawn",
    "sessions_send",
    "sessions_list",
    "sessions_history",
    "sessions_stop",
    "tools_search",
    "tools_call",
    "reflect",
];
const MAIN: &[&str] = &[
    "sessions_spawn",
    "sessions_send",
    "sessions_list",
    "sessions_history",
    "sessions_stop",
    "memory_search",
    "memory_write",
    "recall",
    "history_search",
    "reflect",
    "tools_search",
    "tools_call",
];
const WORKER: &[&str] = &[
    "read",
    "write",
    "edit",
    "todo",
    "reflect",
    "artifact",
    "recall",
    "history_search",
    "memory_search",
    "memory_write",
    "sessions_spawn",
    "sessions_send",
    "sessions_list",
    "tools_search",
    "tools_call",
];
const LEAN: &[&str] = &[
    "read",
    "write",
    "edit",
    "todo",
    "reflect",
    "recall",
    "sessions_send",
];
fn catalog_ref() -> &'static Vec<Value> {
    static CATALOG: OnceLock<Vec<Value>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        json_codec::parse(CATALOG_JSON)
            .expect("frozen built-in catalog JSON")
            .as_array()
            .unwrap()
            .clone()
    })
}
pub fn catalog() -> Vec<Value> {
    catalog_ref().clone()
}
pub fn definition(name: &str) -> Option<Value> {
    catalog_ref().iter().find(|d| s(d, "name") == name).cloned()
}
pub fn toolset(kind: &str) -> Vec<String> {
    match kind {
        "main" => MAIN,
        "lean" => LEAN,
        _ => WORKER,
    }
    .iter()
    .map(|s| (*s).into())
    .collect()
}
pub fn definitions(names: &[String]) -> Value {
    json!(names.iter().filter_map(|name|definition(name)).map(|d|json!({"type":"function","function":{"name":d["name"],"description":d["description"],"parameters":d["parameters"]}})).collect::<Vec<_>>())
}
pub fn classification() -> Value {
    let mut out = serde_json::Map::new();
    for d in catalog_ref() {
        out.insert(s(d, "name").into(), json!({"readOnly":d["readOnly"]}));
    }
    Value::Object(out)
}
pub fn definition_key(name: &str) -> Option<String> {
    definition(name).map(|_| format!("builtin:{name}"))
}
pub fn ephemeral_key(name: &str) -> Option<String> {
    definition(name).and_then(|d| d["ephemeralKey"].as_str().map(str::to_owned))
}

/// Registry search retains registration-order ties and never invents unsupported
/// tools. Native plugins/MCP are not registered until their host is implemented.
pub fn search(query: &str, exclude: &[String], limit: usize) -> Vec<Value> {
    let terms = store_domain::search_tokens(&json!(query), 40, 17);
    let mut hits = vec![];
    for d in catalog_ref() {
        if exclude.iter().any(|name| name == s(d, "name")) {
            continue;
        }
        let tokens = store_domain::search_tokens(
            &json!(format!(
                "{} {} {}",
                s(d, "name").replace('_', " "),
                s(d, "description"),
                s(d, "keywords")
            )),
            30000,
            17,
        );
        let score = terms.iter().filter(|term| tokens.contains(term)).count();
        if score > 0 {
            hits.push(json!({"name":d["name"],"description":d["description"],"parameters":d["parameters"],"score":score,"source":"builtin"}));
        }
    }
    hits.sort_by(|a, b| num(b, "score", 0).cmp(&num(a, "score", 0)));
    hits.truncate(limit);
    hits
}
pub fn summarize(name: &str, args: &Value) -> Result<String, ApiError> {
    Ok(match name {
        "read" => format!("read {}", field(args, "path")),
        "write" => format!(
            "{} {}",
            if truth(&args["append"]) {
                "append"
            } else {
                "write"
            },
            field(args, "path")
        ),
        "edit" => format!("edit {}", field(args, "path")),
        "recall" => format!("recall {}", field(args, "ref")),
        "history_search" | "memory_search" | "tools_search" => {
            format!("{name} {}", stringify(&args["query"])?)
        }
        "memory_write" => format!(
            "memory_write {}",
            stringify(&json!(one_line(&args["content"], 60)?))?
        ),
        "artifact" => format!(
            "artifact {}{}{}",
            field(args, "action"),
            if truth(&args["id"]) {
                format!(" {}", field(args, "id"))
            } else {
                String::new()
            },
            if truth(&args["title"]) {
                format!(" {}", stringify(&args["title"])?)
            } else {
                String::new()
            }
        ),
        "sessions_spawn" => format!(
            "sessions_spawn {}",
            stringify(&if truth(&args["title"]) {
                args["title"].clone()
            } else {
                json!(one_line(&args["task"], 50)?)
            })?
        ),
        "sessions_send" => format!(
            "sessions_send {} {}",
            field(args, "session"),
            stringify(&json!(one_line(&args["message"], 50)?))?
        ),
        "sessions_history" | "sessions_stop" => format!("{name} {}", field(args, "session")),
        "tools_call" => format!("tools_call {}", field(args, "name")),
        "reflect" => format!(
            "reflect{}",
            args.get("confidence")
                .map(|v| format!(" {}", js(v)))
                .unwrap_or_default()
        ),
        _ => name.to_owned(),
    })
}

/// Called from an executeTool future only after its prepared definition/approval
/// has been bound. File effects are routed to FileTools by the native host.
pub async fn execute(
    name: &str,
    args: Value,
    session: Value,
    context: EffectContext,
) -> Result<Value, EffectError> {
    if context.cancellation.is_cancelled() {
        return Err(EffectError::cancelled(true));
    }
    if s(&session, "id") != context.scope.session_id {
        return Err(EffectError::new(
            "Tool session does not match its execution scope",
        ));
    }
    match name {
        "read" | "write" | "edit" => Err(EffectError::new(
            "File tools must execute through the native file host",
        )),
        "tools_call" => Err(EffectError::new("tools_call is executed by the agent loop")),
        "sessions_spawn" => {
            let child = context
                .events
                .call(json!({"op":"runtime.spawn","args":args}))
                .await
                .map_err(EffectError::from)?;
            Ok(
                json!({"text":format!("Started {} \"{}\" ({}). Its report will arrive as a message; you do not need to wait.",s(&child,"kind"),s(&child,"title"),s(&child,"id")),"data":{"sessionId":child["id"],"title":child["title"]}}),
            )
        }
        "sessions_send" | "sessions_stop" => {
            let resolved=context.events.call(json!({"op":"nativeTools.resolve","reference":args["session"],"forStop":name=="sessions_stop","wait":truth(&args["wait"])})).await.map_err(EffectError::from)?;
            let target = &resolved["target"];
            let sender = &resolved["sender"];
            let target_id = s(target, "id").to_owned();
            if name == "sessions_stop" {
                let reason = if truth(&args["reason"]) {
                    field(&args, "reason")
                } else {
                    format!("stopped by {}", context.scope.session_id)
                };
                context
                    .events
                    .call(json!({"op":"runtime.stop","id":target_id,"reason":reason}))
                    .await
                    .map_err(EffectError::from)?;
                return Ok(json!({"text":format!("Stopped {target_id}.")}));
            }
            let seconds = num(&args, "wait", 0).min(600);
            let mode = if truth(&args["mode"]) {
                field(&args, "mode")
            } else {
                "followup".into()
            };
            let title = if truth(&sender["title"]) {
                s(sender, "title")
            } else {
                s(sender, "kind")
            };
            let source = format!(
                "message from \"{}\" ({}){}",
                title,
                context.scope.session_id,
                if seconds > 0 {
                    " — it is waiting for your answer via sessions_send"
                } else {
                    ""
                }
            );
            let started = tokio::time::Instant::now();
            context.events.call(json!({"op":"runtime.send","id":target_id,"body":{"text":args["message"],"mode":mode,"source":source},"wait":seconds})).await.map_err(EffectError::from)?;
            let title = if truth(&target["title"]) {
                s(target, "title")
            } else {
                s(target, "kind")
            };
            if seconds == 0 {
                return Ok(
                    json!({"text":format!("Delivered to \"{title}\" ({target_id}) as {mode}.")}),
                );
            }
            // This execution step stays pending throughout the wait. Thus ordinary
            // Runtime deliver cannot consume its own inbox at a next-step boundary.
            // Poll/take is one actor operation, preserving exactly-once consumption.
            loop {
                if context.cancellation.is_cancelled() {
                    return Err(EffectError::cancelled(false));
                }
                let reply=context.events.call(json!({"op":"nativeTools.reply","fromId":target_id,"excludedIds":resolved["inboxIds"]})).await.map_err(EffectError::from)?;
                if reply["found"] == true {
                    return Ok(
                        json!({"text":format!("Reply from \"{title}\":\n{}",s(&reply,"text"))}),
                    );
                }
                let elapsed = started.elapsed();
                let duration = Duration::from_secs(seconds);
                if elapsed >= duration {
                    return Ok(
                        json!({"text":format!("No reply within {seconds} s; it will arrive as a message later.")}),
                    );
                }
                tokio::select! {biased;_=context.cancellation.cancelled()=>return Err(EffectError::cancelled(false)),_=tokio::time::sleep((duration-elapsed).min(Duration::from_millis(100)))=>{}}
            }
        }
        _ => {
            if definition(name).is_none() {
                return Err(EffectError::new(format!(
                    "Unknown tool \"{name}\". Use tools_search to find available tools."
                )));
            }
            context
                .events
                .call(json!({"op":"nativeTools.execute","name":name,"args":args}))
                .await
                .map_err(EffectError::from)
        }
    }
}

/// Parent calls this within one short scope-checked Workspace mutation boundary.
/// Never call from a future or bypass the coordinator's EffectScope check.
pub fn scoped(
    state: &mut dyn ToolsState,
    session_id: &str,
    request: &Value,
) -> Result<Value, ApiError> {
    let session = state.session(session_id)?;
    require(!session.is_null(), 404, "Session not found")?;
    match s(request, "op") {
        "nativeTools.resolve" => {
            let target =
                resolve_session(&session, &field(request, "reference"), &state.sessions()?)?;
            if request["forStop"] == true {
                require(
                    s(&target, "kind") != "main",
                    403,
                    "The main session cannot be stopped from a tool.",
                )?;
            }
            let inbox = if request["wait"] == true {
                state
                    .inbox(session_id)?
                    .into_iter()
                    .map(|item| item["id"].clone())
                    .collect::<Vec<_>>()
            } else {
                vec![]
            };
            Ok(json!({"target":target,"sender":session,"inboxIds":inbox}))
        }
        "nativeTools.reply" => {
            let from = s(request, "fromId");
            let excluded = array(&request["excludedIds"]);
            for item in state.inbox(session_id)? {
                if excluded.contains(&item["id"]) {
                    continue;
                }
                if s(&item, "from") == from || s(&item, "from") == format!("child:{from}") {
                    if let Some(taken) = state.take_inbox_item(session_id, s(&item, "id"))? {
                        return Ok(json!({"found":true,"text":taken["text"]}));
                    }
                }
            }
            Ok(json!({"found":false}))
        }
        "nativeTools.execute" => {
            execute_state(state, &session, s(request, "name"), &request["args"])
        }
        _ => Err(ApiError::bad_request("Unknown native tool state operation")),
    }
}

pub fn execute_state(
    state: &mut dyn ToolsState,
    session: &Value,
    name: &str,
    args: &Value,
) -> Result<Value, ApiError> {
    let sid = s(session, "id");
    match name {
        "todo" => {
            let items = args["items"]
                .as_array()
                .ok_or_else(|| ApiError::bad_request("arguments.items must be an array"))?
                .iter()
                .map(|item| {
                    Ok(json!({"text":one_line(&item["text"],300)?,"status":item["status"]}))
                })
                .collect::<Result<Vec<Value>, ApiError>>()?;
            state.update_session(sid, json!({"todo":items}))?;
            let done = items.iter().filter(|t| t["status"] == "done").count();
            Ok(
                json!({"text":format!("Todo ({done}/{} done)\n{}",items.len(),render_todo(&items)),"data":{"items":items}}),
            )
        }
        "reflect" => {
            let current = state.session(sid)?;
            let value = pure(
                "metacog.reflect",
                json!({"session":current,"args":args,"at":state.now()}),
            )?;
            state.update_session(sid, json!({"reflection":value["data"]["reflection"]}))?;
            Ok(value)
        }
        "recall" => {
            let reference = field(args, "ref");
            let trimmed = trim(&reference);
            let matched = regex::Regex::new(r"^(?:([a-zA-Z0-9_-]+))?#([0-9]+)$")
                .unwrap()
                .captures(trimmed)
                .ok_or_else(|| {
                    ApiError::bad_request("ref must look like \"#123\" or \"<session id>#123\"")
                })?;
            let target = matched.get(1).map(|m| m.as_str()).unwrap_or(sid);
            let seq = matched[2]
                .parse::<u64>()
                .map_err(|_| ApiError::new(404, format!("No entry {reference}")))?;
            require(
                visible(session, target, &state.sessions()?),
                403,
                "That session is not visible from here.",
            )?;
            let entry = state
                .entry(target, seq)?
                .ok_or_else(|| ApiError::new(404, format!("No entry {reference}")))?;
            let full = if s(&entry, "type") == "tool" && truth(&entry["evidenceId"]) {
                state
                    .evidence(s(&entry, "evidenceId"))?
                    .and_then(|e| e.get("content").cloned())
                    .filter(|v| !v.is_null())
                    .unwrap_or_else(|| entry["content"].clone())
                    .as_str()
                    .unwrap_or("")
                    .to_owned()
            } else {
                entry_text(&entry)?
            };
            let from = num(args, "offset", 0) as usize;
            let size = positive(args, "limit", 20000);
            let part = slice(&full, from, from.saturating_add(size));
            let end = from.saturating_add(length(&part));
            let name = if truth(&entry["name"]) {
                format!(" {}", field(&entry, "name"))
            } else {
                String::new()
            };
            Ok(
                json!({"text":format!("{} ({}{}, {}) characters {}–{} of {}\n{}{}",reference,s(&entry,"type"),name,s(&entry,"at"),from,end,length(&full),part,if end<length(&full){format!("\n[continues: recall(\"{reference}\", offset={end})]")}else{String::new()})}),
            )
        }
        "history_search" => {
            let ids = if args["scope"] == "tree" {
                tree(sid, &state.sessions()?)
            } else {
                vec![sid.into()]
            };
            let hits = state.search_history(s(args, "query"), &ids, positive(args, "limit", 10))?;
            let lines = hits
                .iter()
                .map(|hit| {
                    let text = if truth(&hit["stub"]) {
                        field(hit, "stub")
                    } else {
                        entry_text(hit)?
                    };
                    Ok(format!(
                        "{}#{} {}{} ({}): {}",
                        if s(hit, "sessionId") == sid {
                            ""
                        } else {
                            s(hit, "sessionId")
                        },
                        field(hit, "seq"),
                        s(hit, "type"),
                        if truth(&hit["name"]) {
                            format!(" {}", field(hit, "name"))
                        } else {
                            String::new()
                        },
                        slice(s(hit, "at"), 0, 16),
                        one_line(&json!(text), 200)?
                    ))
                })
                .collect::<Result<Vec<_>, ApiError>>()?;
            Ok(json!({"text":if lines.is_empty(){"No matches.".into()}else{lines.join("\n")}}))
        }
        "memory_search" => {
            let hits = state.search_memory(s(args, "query"), positive(args, "limit", 8))?;
            Ok(
                json!({"text":if hits.is_empty(){"No memories found.".into()}else{hits.iter().map(|m|format!("- ({}{}) {}",slice(s(m,"id"),0,8),if truth(&m["title"]){format!(" {}",field(m,"title"))}else{String::new()},field(m,"content"))).collect::<Vec<_>>().join("\n")}}),
            )
        }
        "memory_write" => {
            let memory = state.write_memory(
                s(args, "content"),
                s(args, "title"),
                &format!("session:{sid}"),
            )?;
            Ok(json!({"text":format!("Saved memory {}.",slice(s(&memory,"id"),0,8))}))
        }
        "artifact" => artifact(state, sid, args),
        "sessions_list" => {
            let all = state.sessions()?;
            let list = all
                .iter()
                .filter(|target| {
                    s(target, "id") != sid
                        && visible(session, s(target, "id"), &all)
                        && (!truth(&args["status"]) || target["status"] == args["status"])
                })
                .take(positive(args, "limit", 30));
            let lines = list
                .map(|target| {
                    Ok(format!(
                        "{} {} [{}] \"{}\"{} · {} steps{}",
                        s(target, "id"),
                        s(target, "kind"),
                        s(target, "status"),
                        s(target, "title"),
                        if truth(&target["label"]) {
                            format!(" @{}", field(target, "label"))
                        } else {
                            String::new()
                        },
                        num(&target["stats"], "steps", 0),
                        if truth(&target["note"]) {
                            format!(" · {}", one_line(&target["note"], 80)?)
                        } else {
                            String::new()
                        }
                    ))
                })
                .collect::<Result<Vec<_>, ApiError>>()?;
            Ok(
                json!({"text":if lines.is_empty(){"No other sessions.".into()}else{lines.join("\n")}}),
            )
        }
        "sessions_history" => {
            let target = resolve_session(session, s(args, "session"), &state.sessions()?)?;
            let limit = positive(args, "limit", 20);
            let mut entries = state
                .tail(s(&target, "id"), limit * 3)?
                .into_iter()
                .filter(|entry| {
                    ["input", "assistant", "notice"].contains(&s(entry, "type"))
                        || args["include_tools"] == true && s(entry, "type") == "tool"
                })
                .collect::<Vec<_>>();
            let skip = entries.len().saturating_sub(limit);
            entries.drain(..skip);
            let lines = entries
                .iter()
                .map(|entry| {
                    let text = if s(entry, "type") == "tool" {
                        entry["stub"].clone()
                    } else {
                        json!(entry_text(entry)?)
                    };
                    Ok(format!(
                        "#{} {}: {}",
                        field(entry, "seq"),
                        if s(entry, "type") == "input" {
                            "in"
                        } else {
                            s(entry, "type")
                        },
                        one_line(&text, 600)?
                    ))
                })
                .collect::<Result<Vec<_>, ApiError>>()?;
            Ok(
                json!({"text":format!("\"{}\" ({}) [{}]\n{}",if truth(&target["title"]){s(&target,"title")}else{s(&target,"kind")},s(&target,"id"),s(&target,"status"),lines.join("\n"))}),
            )
        }
        "tools_search" => {
            let exclude = array(&session["tools"])
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let hits = search(s(args, "query"), &exclude, 8);
            let lines = hits
                .iter()
                .map(|hit| {
                    Ok(format!(
                        "## {} ({})\n{}\nparameters: {}",
                        s(hit, "name"),
                        s(hit, "source"),
                        s(hit, "description"),
                        stringify(&hit["parameters"])?
                    ))
                })
                .collect::<Result<Vec<_>, ApiError>>()?;
            Ok(
                json!({"text":if lines.is_empty(){"No matching tools.".into()}else{lines.join("\n\n")}}),
            )
        }
        "sessions_spawn" | "sessions_send" | "sessions_stop" => Err(ApiError::bad_request(
            "Session control tools must use the coordinator request path",
        )),
        "tools_call" => Err(ApiError::bad_request(
            "tools_call is executed by the agent loop",
        )),
        _ => Err(ApiError::unavailable(format!(
            "Native tool {name} is not available"
        ))),
    }
}

fn artifact(state: &mut dyn ToolsState, sid: &str, args: &Value) -> Result<Value, ApiError> {
    let action = s(args, "action");
    if action == "list" {
        let docs = state
            .list_docs("artifact")?
            .into_iter()
            .filter(|doc| s(doc, "sessionId") == sid || s(doc, "jobId") == sid)
            .collect::<Vec<_>>();
        return Ok(
            json!({"text":if docs.is_empty(){"No artifacts yet.".into()}else{docs.iter().map(|doc|format!("{} v{} {} \"{}\" ({} chars)",s(doc,"id"),field(doc,"version"),s(doc,"kind"),s(doc,"title"),length(s(doc,"content")))).collect::<Vec<_>>().join("\n")}}),
        );
    }
    let existing = if truth(&args["id"]) {
        state.get_doc("artifact", s(args, "id"))?
    } else {
        None
    };
    if action == "publish" {
        require(
            args["title"].is_string() && args["content"].is_string(),
            400,
            "publish needs title and content",
        )?;
        let kind = if truth(&args["kind"]) {
            s(args, "kind")
        } else {
            existing
                .as_ref()
                .and_then(|doc| doc["kind"].as_str())
                .unwrap_or("markdown")
        };
        let mut options = json!({"kind":kind,"jobId":sid,"sessionId":sid});
        if truth(&args["id"]) {
            options["id"] = args["id"].clone();
        }
        if let Some(existing) = existing {
            options["expectedVersion"] = existing["version"].clone();
        }
        let doc = state.publish_artifact(s(args, "title"), s(args, "content"), options)?;
        return Ok(
            json!({"text":format!("Published artifact {} v{} ({}, {} characters).",s(&doc,"id"),field(&doc,"version"),s(&doc,"kind"),length(s(&doc,"content"))),"data":{"id":doc["id"],"version":doc["version"],"title":doc["title"]}}),
        );
    }
    let existing = existing.ok_or_else(|| ApiError::new(404, "Artifact not found"))?;
    if action == "read" {
        return Ok(
            json!({"text":format!("{} v{} {} \"{}\"\n{}",s(&existing,"id"),field(&existing,"version"),s(&existing,"kind"),s(&existing,"title"),s(&existing,"content"))}),
        );
    }
    require(action == "edit", 400, "Invalid artifact action")?;
    if let Some(version) = args.get("expected_version") {
        require(
            version
                .as_f64()
                .is_some_and(|v| existing["version"].as_f64() == Some(v)),
            409,
            format!(
                "The artifact is now version {}; read it again before editing.",
                field(&existing, "version")
            ),
        )?;
    }
    require(
        args["old_string"].is_string()
            && truth(&args["old_string"])
            && args["new_string"].is_string(),
        400,
        "edit needs old_string and new_string",
    )?;
    let old = json_codec::utf16_units(s(args, "old_string"));
    let input = json_codec::utf16_units(s(&existing, "content"));
    let new = json_codec::utf16_units(s(args, "new_string"));
    let mut found = vec![];
    let mut index = 0;
    while index + old.len() <= input.len() {
        if input[index..index + old.len()] == old {
            found.push(index);
            index += old.len();
        } else {
            index += 1;
        }
    }
    require(
        found.len() == 1,
        409,
        if found.is_empty() {
            "old_string was not found; read the artifact again.".into()
        } else {
            format!(
                "old_string occurs {} times; include more context.",
                found.len()
            )
        },
    )?;
    let index = found[0];
    let mut content = input[..index].to_vec();
    content.extend(new);
    content.extend(&input[index + old.len()..]);
    let content = json_codec::from_utf16_units(&content);
    let title = if truth(&args["title"]) {
        s(args, "title")
    } else {
        s(&existing, "title")
    };
    let job = if truth(&existing["jobId"]) {
        s(&existing, "jobId")
    } else {
        sid
    };
    let session = if truth(&existing["sessionId"]) {
        s(&existing, "sessionId")
    } else {
        sid
    };
    let doc=state.publish_artifact(title,&content,json!({"id":existing["id"],"kind":existing["kind"],"jobId":job,"sessionId":session,"expectedVersion":existing["version"]}))?;
    Ok(
        json!({"text":format!("Edited artifact {}: now v{}.",s(&doc,"id"),field(&doc,"version")),"data":{"id":doc["id"],"version":doc["version"],"title":doc["title"]}}),
    )
}

pub fn tree(id: &str, sessions: &[Value]) -> Vec<String> {
    let mut out = vec![id.to_owned()];
    let mut seen = HashSet::from([id.to_owned()]);
    let mut index = 0;
    while index < out.len() {
        let parent = out[index].clone();
        for session in sessions {
            let id = s(session, "id");
            if s(session, "parentId") == parent && seen.insert(id.to_owned()) {
                out.push(id.to_owned());
            }
        }
        index += 1;
    }
    out
}
pub fn visible(from: &Value, id: &str, sessions: &[Value]) -> bool {
    s(from, "kind") == "main"
        || s(from, "id") == id
        || s(from, "parentId") == id
        || tree(s(from, "id"), sessions).iter().any(|v| v == id)
}
pub fn resolve_session(
    from: &Value,
    reference: &str,
    sessions: &[Value],
) -> Result<Value, ApiError> {
    let key = trim(reference);
    if key == "parent" {
        require(
            truth(&from["parentId"]),
            404,
            "This session has no requester.",
        )?;
        return sessions
            .iter()
            .find(|session| session["id"] == from["parentId"])
            .cloned()
            .ok_or_else(|| ApiError::new(404, "Session not found"));
    }
    if key == "main" {
        return sessions
            .iter()
            .find(|session| s(session, "kind") == "main")
            .cloned()
            .ok_or_else(|| ApiError::new(404, "Main session not found"));
    }
    let all = sessions
        .iter()
        .filter(|session| {
            s(session, "id") != s(from, "id") && visible(from, s(session, "id"), sessions)
        })
        .collect::<Vec<_>>();
    all.iter()
        .find(|session| {
            s(session, "id") == key || length(key) >= 6 && s(session, "id").starts_with(key)
        })
        .or_else(|| all.iter().find(|session| s(session, "label") == key))
        .or_else(|| all.iter().find(|session| s(session, "title") == key))
        .map(|v| (*v).clone())
        .ok_or_else(|| {
            ApiError::new(
                404,
                format!("No visible session \"{key}\". Use sessions_list."),
            )
        })
}
pub fn render_todo(items: &[Value]) -> String {
    if items.is_empty() {
        return "(empty)".into();
    }
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            format!(
                "{} {}. {}",
                match s(item, "status") {
                    "in_progress" => "[>]",
                    "done" => "[x]",
                    "blocked" => "[!]",
                    _ => "[ ]",
                },
                index + 1,
                field(item, "text")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
pub fn entry_text(entry: &Value) -> Result<String, ApiError> {
    if entry.is_null() {
        return Ok(String::new());
    }
    Ok(match s(entry, "type") {
        "input" | "notice" => s(entry, "text").into(),
        "tool" => s(entry, "content").into(),
        "checkpoint" => s(entry, "summary").into(),
        "assistant" => {
            let mut lines = vec![];
            if !s(entry, "content").is_empty() {
                lines.push(s(entry, "content").into());
            }
            for call in array(&entry["toolCalls"]) {
                lines.push(format!(
                    "→ {}({})",
                    field(call, "name"),
                    field(call, "arguments")
                ));
            }
            lines.join("\n")
        }
        _ => stringify(entry)?,
    })
}
fn pure(operation: &str, payload: Value) -> Result<Value, ApiError> {
    let input =
        json_codec::stringify_js(&payload).map_err(|e| ApiError::bad_request(e.to_string()))?;
    let output =
        harness::call_json(operation, &input).map_err(|e| ApiError::bad_request(e.to_string()))?;
    json_codec::parse(&output).map_err(|e| ApiError::bad_request(e.to_string()))
}
fn one_line(value: &Value, max: usize) -> Result<String, ApiError> {
    Ok(pure("format.oneLine", json!({"value":value,"max":max}))?
        .as_str()
        .unwrap_or("")
        .into())
}
fn stringify(value: &Value) -> Result<String, ApiError> {
    json_codec::stringify_js(value)
        .map(|text| json_codec::encode_text(&text))
        .map_err(|e| ApiError::bad_request(e.to_string()))
}
fn js(value: &Value) -> String {
    tepora_core::js_value::js_string(Some(value))
}

fn field(value: &Value, key: &str) -> String {
    value.get(key).map(js).unwrap_or_else(|| "undefined".into())
}
fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn truth(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::String(v) => !v.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|v| v != 0.),
        _ => true,
    }
}
fn num(value: &Value, key: &str, default: u64) -> u64 {
    value[key]
        .as_u64()
        .or_else(|| {
            value[key]
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.)
                .map(|n| n as u64)
        })
        .unwrap_or(default)
}
fn positive(value: &Value, key: &str, default: usize) -> usize {
    let n = num(value, key, default as u64) as usize;
    if n == 0 {
        default
    } else {
        n
    }
}
fn length(value: &str) -> usize {
    json_codec::utf16_units(value).len()
}
fn slice(value: &str, start: usize, end: usize) -> String {
    let units = json_codec::utf16_units(value);
    json_codec::from_utf16_units(
        &units[start.min(units.len())..end.min(units.len()).max(start.min(units.len()))],
    )
}
fn trim(value: &str) -> &str {
    value.trim_matches(|c|matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
fn require(ok: bool, status: u16, message: impl Into<String>) -> Result<(), ApiError> {
    if ok {
        Ok(())
    } else {
        Err(ApiError::new(status, message))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    #[derive(Default)]
    struct MemoryState {
        sessions: Vec<Value>,
        entries: HashMap<String, Vec<Value>>,
        evidence: HashMap<String, Value>,
        inbox: HashMap<String, Vec<Value>>,
        docs: HashMap<String, Vec<Value>>,
        last_search: Option<(String, Vec<String>, usize)>,
    }
    impl ToolsState for MemoryState {
        fn sessions(&mut self) -> Result<Vec<Value>, ApiError> {
            Ok(self.sessions.clone())
        }
        fn session(&mut self, id: &str) -> Result<Value, ApiError> {
            Ok(self
                .sessions
                .iter()
                .find(|s| s["id"] == id)
                .cloned()
                .unwrap_or(Value::Null))
        }
        fn update_session(&mut self, id: &str, patch: Value) -> Result<Value, ApiError> {
            let target = self
                .sessions
                .iter_mut()
                .find(|s| s["id"] == id)
                .ok_or_else(|| ApiError::new(404, "missing"))?;
            for (k, v) in patch.as_object().unwrap() {
                target[k] = v.clone();
            }
            Ok(target.clone())
        }
        fn entry(&mut self, id: &str, seq: u64) -> Result<Option<Value>, ApiError> {
            Ok(self
                .entries
                .get(id)
                .and_then(|v| v.iter().find(|e| e["seq"] == seq))
                .cloned())
        }
        fn tail(&mut self, id: &str, count: usize) -> Result<Vec<Value>, ApiError> {
            let rows = self.entries.get(id).cloned().unwrap_or_default();
            Ok(rows
                .into_iter()
                .rev()
                .take(count)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect())
        }
        fn search_history(
            &mut self,
            query: &str,
            ids: &[String],
            limit: usize,
        ) -> Result<Vec<Value>, ApiError> {
            self.last_search = Some((query.into(), ids.to_vec(), limit));
            Ok(vec![])
        }
        fn evidence(&mut self, id: &str) -> Result<Option<Value>, ApiError> {
            Ok(self.evidence.get(id).cloned())
        }
        fn inbox(&mut self, id: &str) -> Result<Vec<Value>, ApiError> {
            Ok(self.inbox.get(id).cloned().unwrap_or_default())
        }
        fn take_inbox_item(&mut self, id: &str, item_id: &str) -> Result<Option<Value>, ApiError> {
            let rows = self.inbox.entry(id.into()).or_default();
            Ok(rows
                .iter()
                .position(|v| v["id"] == item_id)
                .map(|i| rows.remove(i)))
        }
        fn list_docs(&mut self, collection: &str) -> Result<Vec<Value>, ApiError> {
            Ok(self.docs.get(collection).cloned().unwrap_or_default())
        }
        fn get_doc(&mut self, collection: &str, id: &str) -> Result<Option<Value>, ApiError> {
            Ok(self
                .docs
                .get(collection)
                .and_then(|v| v.iter().find(|d| d["id"] == id))
                .cloned())
        }
        fn search_memory(&mut self, _: &str, _: usize) -> Result<Vec<Value>, ApiError> {
            Ok(self.docs.get("memory").cloned().unwrap_or_default())
        }
        fn write_memory(
            &mut self,
            content: &str,
            title: &str,
            source: &str,
        ) -> Result<Value, ApiError> {
            let doc = json!({"id":"abcdefgh-1234","content":content,"title":title,"source":source});
            self.docs
                .entry("memory".into())
                .or_default()
                .push(doc.clone());
            Ok(doc)
        }
        fn publish_artifact(
            &mut self,
            title: &str,
            content: &str,
            options: Value,
        ) -> Result<Value, ApiError> {
            let id = options["id"].as_str().unwrap_or("artifact-new");
            let docs = self.docs.entry("artifact".into()).or_default();
            let previous = docs.iter().position(|d| d["id"] == id);
            let version = previous.map_or(1, |i| num(&docs[i], "version", 0) + 1);
            let doc = json!({"id":id,"title":title,"content":content,"kind":options["kind"],"jobId":options["jobId"],"version":version});
            if let Some(i) = previous {
                docs[i] = doc.clone();
            } else {
                docs.push(doc.clone());
            }
            Ok(doc)
        }
        fn now(&self) -> String {
            "2026-10-07T00:00:00.000Z".into()
        }
    }
    fn sessions() -> Vec<Value> {
        vec![
            json!({"id":"main-000000","kind":"main","title":"Main","status":"running","stats":{"steps":1}}),
            json!({"id":"worker-aaaaaa","kind":"worker","parentId":"main-000000","title":"Worker A","label":"alpha","status":"running","stats":{"steps":7}}),
            json!({"id":"worker-bbbbbb","kind":"worker","parentId":"main-000000","title":"Worker B","status":"done"}),
            json!({"id":"child-cccccc","kind":"worker","parentId":"worker-aaaaaa","title":"Child","status":"idle"}),
        ]
    }
    #[test]
    fn catalog_is_exact_native_subset_with_fixed_order_and_metadata() {
        assert_eq!(
            catalog().iter().map(|d| s(d, "name")).collect::<Vec<_>>(),
            IMPLEMENTED
        );
        assert_eq!(catalog().len(), 17);
        assert_eq!(toolset("main"), MAIN);
        assert_eq!(toolset("worker"), WORKER);
        assert_eq!(toolset("lean"), LEAN);
        assert_eq!(definition("tools_call").unwrap()["readOnly"], false);
        assert_eq!(definition("read").unwrap()["readOnly"], true);
        assert_eq!(ephemeral_key("todo"), Some("todo".into()));
        assert_eq!(definition("todo").unwrap()["ephemeral"], true);
        assert_eq!(ephemeral_key("sessions_list"), Some("sessions_list".into()));
        assert_eq!(definition("sessions_list").unwrap()["ephemeral"], false);
        for name in [
            "exec",
            "process",
            "schedule",
            "web_fetch",
            "skill",
            "computer",
            "media",
        ] {
            assert!(definition(name).is_none());
        }
        let defs = definitions(&vec!["read".into(), "unknown".into(), "todo".into()]);
        assert_eq!(defs.as_array().unwrap().len(), 2);
        assert_eq!(
            defs[0]["function"]["parameters"],
            definition("read").unwrap()["parameters"]
        );
    }
    #[test]
    fn catalog_search_uses_shared_unicode_tokens_and_excludes_fixed_tools() {
        let hits = search("checklist", &[], 8);
        assert_eq!(hits[0]["name"], "todo");
        assert!(hits.iter().all(|h| IMPLEMENTED.contains(&s(h, "name"))));
        assert!(search("checklist", &["todo".into()], 8)
            .iter()
            .all(|h| h["name"] != "todo"));
        assert!(search(&format!("{}checklist", "unknown ".repeat(40)), &[], 8).is_empty());
        assert_eq!(search("ＣＨＥＣＫＬＩＳＴ", &[], 8), hits);
    }
    #[test]
    fn summaries_match_source_templates_and_keep_codec_strings() {
        let special = json_codec::parse(r#"{"query":"\ue000\ue100\ud800"}"#).unwrap();
        let summary = summarize("memory_search", &special).unwrap();
        assert_eq!(
            json_codec::sql_text(&summary),
            format!(
                "memory_search {}",
                json_codec::stringify_js(&special["query"]).unwrap()
            )
        );
        assert_eq!(
            summarize("write", &json!({"path":"a.txt","append":true})).unwrap(),
            "append a.txt"
        );
        assert_eq!(
            summarize("sessions_spawn", &json!({"task":"  do\n the thing "})).unwrap(),
            "sessions_spawn \"do the thing\""
        );
        assert_eq!(
            summarize(
                "sessions_send",
                &json!({"session":"parent","message":"  hello\nthere "})
            )
            .unwrap(),
            "sessions_send parent \"hello there\""
        );
        assert_eq!(
            summarize(
                "artifact",
                &json!({"action":"publish","id":"a","title":"Hi"})
            )
            .unwrap(),
            "artifact publish a \"Hi\""
        );
        assert_eq!(
            summarize("reflect", &json!({"confidence":0.5})).unwrap(),
            "reflect 0.5"
        );
        assert_eq!(summarize("todo", &json!({})).unwrap(), "todo");
    }
    #[test]
    fn visibility_resolves_parent_main_labels_prefixes_and_descendants_without_siblings() {
        let all = sessions();
        let worker = &all[1];
        assert_eq!(
            tree(s(worker, "id"), &all),
            vec!["worker-aaaaaa", "child-cccccc"]
        );
        assert_eq!(
            resolve_session(worker, "parent", &all).unwrap()["id"],
            all[0]["id"]
        );
        assert_eq!(
            resolve_session(&all[3], "main", &all).unwrap()["id"],
            all[0]["id"]
        );
        assert!(resolve_session(worker, "Worker B", &all).is_err());
        assert!(visible(&all[0], "worker-bbbbbb", &all));
        assert!(!visible(worker, "worker-bbbbbb", &all));
        assert_eq!(
            resolve_session(&all[0], "worker-a", &all).unwrap()["id"],
            worker["id"]
        );
        assert_eq!(
            resolve_session(&all[0], "alpha", &all).unwrap()["id"],
            worker["id"]
        );
    }
    #[test]
    fn todo_and_reflect_preserve_current_fields_and_measure_step() {
        let mut state = MemoryState {
            sessions: sessions(),
            ..Default::default()
        };
        let session = state.sessions[1].clone();
        let result=execute_state(&mut state,&session,"todo",&json!({"items":[{"text":"  one\n  task ","status":"in_progress"},{"text":"Done","status":"done"}]})).unwrap();
        assert_eq!(
            result["text"],
            "Todo (1/2 done)\n[>] 1. one task\n[x] 2. Done"
        );
        execute_state(
            &mut state,
            &session,
            "reflect",
            &json!({"understanding":"  First ","assumptions":[" maybe "," "]}),
        )
        .unwrap();
        let result = execute_state(
            &mut state,
            &session,
            "reflect",
            &json!({"next":"Check","confidence":0.7}),
        )
        .unwrap();
        let reflection = &result["data"]["reflection"];
        assert_eq!(reflection["understanding"], "First");
        assert_eq!(reflection["assumptions"], json!(["maybe"]));
        assert_eq!(reflection["step"], 7);
        assert_eq!(reflection["at"], "2026-10-07T00:00:00.000Z");
    }
    #[test]
    fn recall_reads_evidence_with_exact_utf16_pagination_and_visibility() {
        let mut state = MemoryState {
            sessions: sessions(),
            ..Default::default()
        };
        let session = state.sessions[1].clone();
        state.entries.insert("worker-aaaaaa".into(),vec![json!({"seq":42,"type":"tool","name":"read","at":"today","content":"stub","evidenceId":"full"})]);
        state
            .evidence
            .insert("full".into(), json!({"content":"a😀b"}));
        let result = execute_state(
            &mut state,
            &session,
            "recall",
            &json!({"ref":"#42","offset":1,"limit":1}),
        )
        .unwrap();
        let units = json_codec::utf16_units(s(&result, "text"));
        assert!(units.contains(&0xd83d));
        assert!(!units.contains(&0xde00));
        assert!(s(&result, "text").contains("offset=2"));
        assert_eq!(
            execute_state(
                &mut state,
                &session,
                "recall",
                &json!({"ref":"worker-bbbbbb#1"})
            )
            .unwrap_err()
            .status,
            403
        );
        execute_state(
            &mut state,
            &session,
            "history_search",
            &json!({"query":"thing","scope":"tree","limit":3}),
        )
        .unwrap();
        assert_eq!(
            state.last_search.unwrap().1,
            vec!["worker-aaaaaa", "child-cccccc"]
        );
    }
    #[test]
    fn artifacts_enforce_exact_unique_edit_and_version_while_preserving_literal_replacements() {
        let mut state = MemoryState {
            sessions: sessions(),
            ..Default::default()
        };
        let session = state.sessions[1].clone();
        let published = execute_state(
            &mut state,
            &session,
            "artifact",
            &json!({"action":"publish","title":"Doc","content":"first 😀 last"}),
        )
        .unwrap();
        assert_eq!(published["data"]["version"], 1);
        let result=execute_state(&mut state,&session,"artifact",&json!({"action":"edit","id":"artifact-new","old_string":"😀","new_string":"$&","expected_version":1})).unwrap();
        assert_eq!(result["data"]["version"], 2);
        assert_eq!(state.docs["artifact"][0]["content"], "first $& last");
        assert_eq!(execute_state(&mut state,&session,"artifact",&json!({"action":"edit","id":"artifact-new","old_string":"first","new_string":"next","expected_version":1})).unwrap_err().status,409);
        assert_eq!(execute_state(&mut state,&session,"artifact",&json!({"action":"edit","id":"artifact-new","old_string":"missing","new_string":"next"})).unwrap_err().status,409);
    }
    #[test]
    fn reply_wait_only_consumes_new_matching_sender_exactly_once() {
        let mut state = MemoryState {
            sessions: sessions(),
            ..Default::default()
        };
        state.inbox.insert(
            "main-000000".into(),
            vec![
                json!({"id":"old","from":"child:worker-aaaaaa","text":"older"}),
                json!({"id":"other","from":"worker-bbbbbb","text":"other"}),
                json!({"id":"new","from":"child:worker-aaaaaa","text":"answer"}),
            ],
        );
        let query =
            json!({"op":"nativeTools.reply","fromId":"worker-aaaaaa","excludedIds":["old"]});
        assert_eq!(
            scoped(&mut state, "main-000000", &query).unwrap(),
            json!({"found":true,"text":"answer"})
        );
        assert_eq!(
            scoped(&mut state, "main-000000", &query).unwrap(),
            json!({"found":false})
        );
        assert_eq!(state.inbox["main-000000"].len(), 2);
        assert_eq!(
            scoped(
                &mut state,
                "worker-aaaaaa",
                &json!({"op":"nativeTools.resolve","reference":"main","forStop":true})
            )
            .unwrap_err()
            .status,
            403
        );
    }
    #[test]
    fn memory_and_history_outputs_match_source_empty_and_nonempty_forms() {
        let mut state = MemoryState {
            sessions: sessions(),
            ..Default::default()
        };
        let session = state.sessions[1].clone();
        assert_eq!(
            execute_state(&mut state, &session, "memory_search", &json!({"query":"x"})).unwrap()
                ["text"],
            "No memories found."
        );
        assert_eq!(
            execute_state(
                &mut state,
                &session,
                "memory_write",
                &json!({"content":"Fact","title":"Title"})
            )
            .unwrap()["text"],
            "Saved memory abcdefgh."
        );
        assert_eq!(state.docs["memory"][0]["source"], "session:worker-aaaaaa");
        assert_eq!(
            execute_state(
                &mut state,
                &session,
                "memory_search",
                &json!({"query":"Fact"})
            )
            .unwrap()["text"],
            "- (abcdefgh Title) Fact"
        );
        state.entries.insert(
            "child-cccccc".into(),
            vec![
                json!({"seq":1,"type":"input","text":"hello"}),
                json!({"seq":2,"type":"tool","stub":"read file"}),
                json!({"seq":3,"type":"assistant","content":"done"}),
            ],
        );
        let out = execute_state(
            &mut state,
            &session,
            "sessions_history",
            &json!({"session":"Child","include_tools":false}),
        )
        .unwrap();
        assert_eq!(
            out["text"],
            "\"Child\" (child-cccccc) [idle]\n#1 in: hello\n#3 assistant: done"
        );
    }
}
