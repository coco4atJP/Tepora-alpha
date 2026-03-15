use rmcp::model::{Annotated, CallToolResult, Content, RawContent, RawTextContent};
use serde_json::json;

use super::tool_executor::{format_tool_result, mcp_tool_info_from_value};

fn make_text_content(text: &str) -> Content {
    Annotated {
        raw: RawContent::Text(RawTextContent {
            text: text.to_string(),
            meta: None,
        }),
        annotations: None,
    }
}

#[test]
fn test_mcp_tool_info_from_value_extracts_schema() {
    let tool = mcp_tool_info_from_value(
        "demo",
        &json!({
            "name": "echo",
            "description": "Echo input",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "message": { "type": "string" }
                },
                "required": ["message"]
            }
        }),
    )
    .unwrap();

    assert_eq!(tool.name, "demo_echo");
    assert_eq!(tool.description, "Echo input");
    assert_eq!(
        tool.input_schema,
        Some(json!({
            "type": "object",
            "properties": {
                "message": { "type": "string" }
            },
            "required": ["message"]
        }))
    );
}

#[test]
fn test_mcp_tool_info_from_value_accepts_snake_case_schema_key() {
    let tool = mcp_tool_info_from_value(
        "demo",
        &json!({
            "name": "echo",
            "description": "Echo input",
            "input_schema": { "type": "object" }
        }),
    )
    .unwrap();

    assert_eq!(tool.input_schema, Some(json!({ "type": "object" })));
}

#[test]
fn test_mcp_tool_info_from_value_rejects_missing_name() {
    assert!(mcp_tool_info_from_value("demo", &json!({ "description": "missing" })).is_none());
    assert!(mcp_tool_info_from_value("demo", &json!({ "name": "   " })).is_none());
}

#[test]
fn test_format_tool_result_text_content() {
    let result = CallToolResult {
        content: vec![make_text_content("Hello from MCP tool")],
        is_error: None,
        meta: None,
        structured_content: None,
    };
    let output = format_tool_result(&result);
    assert_eq!(output, "Hello from MCP tool");
}

#[test]
fn test_format_tool_result_error() {
    let result = CallToolResult {
        content: vec![make_text_content("Something went wrong")],
        is_error: Some(true),
        meta: None,
        structured_content: None,
    };
    let output = format_tool_result(&result);
    assert!(output.starts_with("Tool execution error:"));
    assert!(output.contains("Something went wrong"));
}

#[test]
fn test_format_tool_result_empty() {
    let result = CallToolResult {
        content: vec![],
        is_error: None,
        meta: None,
        structured_content: None,
    };
    let output = format_tool_result(&result);
    assert_eq!(output, "Tool executed successfully (no output)");
}

#[test]
fn test_format_tool_result_multiple_contents() {
    let result = CallToolResult {
        content: vec![make_text_content("Line 1"), make_text_content("Line 2")],
        is_error: None,
        meta: None,
        structured_content: None,
    };
    let output = format_tool_result(&result);
    assert_eq!(output, "Line 1\nLine 2");
}
