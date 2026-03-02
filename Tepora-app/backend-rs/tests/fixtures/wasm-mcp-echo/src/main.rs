use serde_json::{json, Value};
use std::io::{self, BufRead, BufReader, Write};

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = stdout.lock();

    while let Some(message) = read_message(&mut reader)? {
        if let Some(response) = build_response(&message) {
            write_message(&mut writer, &response)?;
        }
    }

    Ok(())
}

fn read_message(reader: &mut impl BufRead) -> io::Result<Option<Value>> {
    let mut line = String::new();
    let bytes_read = reader.read_line(&mut line)?;
    if bytes_read == 0 {
        return Ok(None);
    }

    let payload = line.trim();
    if payload.is_empty() {
        return Ok(None);
    }

    let parsed = serde_json::from_str::<Value>(payload).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid json-rpc payload: {e}"),
        )
    })?;

    Ok(Some(parsed))
}

fn write_message(writer: &mut impl Write, payload: &Value) -> io::Result<()> {
    let encoded = serde_json::to_string(payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("serialize error: {e}")))?;
    writer.write_all(encoded.as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

fn build_response(message: &Value) -> Option<Value> {
    let id = message.get("id").cloned()?;
    let method = message.get("method").and_then(|m| m.as_str()).unwrap_or("");

    match method {
        "initialize" => {
            let protocol = message
                .pointer("/params/protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or("2025-11-25");
            Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": protocol,
                    "capabilities": {
                        "tools": {
                            "listChanged": false
                        }
                    },
                    "serverInfo": {
                        "name": "wasm-mcp-echo",
                        "version": "0.1.0"
                    }
                }
            }))
        }
        "tools/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "tools": [
                    {
                        "name": "echo",
                        "description": "Echoes input text",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "text": { "type": "string" }
                            },
                            "required": ["text"]
                        }
                    }
                ]
            }
        })),
        "tools/call" => {
            let name = message
                .pointer("/params/name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let text = message
                .pointer("/params/arguments/text")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if name != "echo" {
                return Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32602,
                        "message": "Unknown tool name"
                    }
                }));
            }

            Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": format!("echo:{text}")
                        }
                    ],
                    "isError": false
                }
            }))
        }
        _ => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": -32601,
                "message": "Method not found"
            }
        })),
    }
}
