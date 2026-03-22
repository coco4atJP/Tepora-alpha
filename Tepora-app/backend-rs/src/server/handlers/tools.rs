use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::Value;

use crate::core::errors::ApiError;
use crate::core::native_tools::{NativeTool, NATIVE_TOOLS};
use crate::mcp::McpToolInfo;
use crate::state::AppStateRead;

#[derive(Debug, Clone, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolSource {
    Native,
    Mcp,
}

#[derive(Debug, Clone, Serialize, JsonSchema, PartialEq)]
pub struct ToolDescriptor {
    pub name: String,
    pub description: String,
    pub source: ToolSource,
    #[serde(rename = "inputSchema", skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
}

#[derive(Debug, Clone, Serialize, JsonSchema, PartialEq)]
pub struct ToolsListResponse {
    pub tools: Vec<ToolDescriptor>,
}

fn native_tool_descriptor(tool: &NativeTool) -> ToolDescriptor {
    ToolDescriptor {
        name: tool.name.to_string(),
        description: tool.description.to_string(),
        source: ToolSource::Native,
        input_schema: None,
    }
}

fn mcp_tool_descriptor(tool: McpToolInfo) -> ToolDescriptor {
    ToolDescriptor {
        name: tool.name,
        description: tool.description,
        source: ToolSource::Mcp,
        input_schema: tool.input_schema,
    }
}

pub fn build_tools_response(
    native_tools: &[NativeTool],
    mcp_tools: Vec<McpToolInfo>,
) -> ToolsListResponse {
    let mut tools = native_tools
        .iter()
        .map(native_tool_descriptor)
        .collect::<Vec<_>>();
    tools.extend(mcp_tools.into_iter().map(mcp_tool_descriptor));
    ToolsListResponse { tools }
}

pub async fn list_tools(State(state): State<AppStateRead>) -> Result<impl IntoResponse, ApiError> {
    let mcp_tools = state.integration().mcp.list_tools().await;
    Ok(Json(build_tools_response(NATIVE_TOOLS, mcp_tools)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use schemars::schema_for;
    use serde_json::json;

    #[test]
    fn native_tools_response_contract_is_stable() {
        let response = build_tools_response(
            &[NativeTool {
                name: "native_search",
                description: "Search the web",
            }],
            Vec::new(),
        );

        assert_eq!(
            serde_json::to_value(response).unwrap(),
            json!({
                "tools": [
                    {
                        "name": "native_search",
                        "description": "Search the web",
                        "source": "native"
                    }
                ]
            })
        );
    }

    #[test]
    fn mcp_tools_response_includes_input_schema_contract() {
        let response = build_tools_response(
            &[],
            vec![McpToolInfo {
                name: "demo_echo".to_string(),
                description: "Echo input".to_string(),
                input_schema: Some(json!({
                    "type": "object",
                    "properties": {
                        "message": { "type": "string" }
                    },
                    "required": ["message"]
                })),
            }],
        );

        assert_eq!(
            serde_json::to_value(response).unwrap(),
            json!({
                "tools": [
                    {
                        "name": "demo_echo",
                        "description": "Echo input",
                        "source": "mcp",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "message": { "type": "string" }
                            },
                            "required": ["message"]
                        }
                    }
                ]
            })
        );
    }

    #[test]
    fn tools_response_schema_marks_input_schema_optional() {
        let schema = serde_json::to_value(schema_for!(ToolsListResponse)).unwrap();
        let items_schema = &schema["properties"]["tools"]["items"];
        let tool_schema = if let Some(reference) = items_schema["$ref"].as_str() {
            let definition = reference.rsplit('/').next().unwrap();
            &schema["$defs"][definition]
        } else {
            items_schema
        };
        let required = tool_schema["required"].as_array().unwrap();

        assert!(required.contains(&json!("name")));
        assert!(required.contains(&json!("description")));
        assert!(required.contains(&json!("source")));
        assert!(!required.contains(&json!("inputSchema")));
        assert!(tool_schema["properties"].get("inputSchema").is_some());
    }
}
