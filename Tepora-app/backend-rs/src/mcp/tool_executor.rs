use std::time::Instant;

use rmcp::model::CallToolRequestParams;
use serde_json::{Map, Value};

use crate::core::errors::ApiError;

use super::state::McpRuntimeState;
use super::types::McpToolInfo;

#[derive(Clone)]
pub(crate) struct McpToolExecutor {
    runtime: McpRuntimeState,
}

impl McpToolExecutor {
    pub(crate) fn new(runtime: McpRuntimeState) -> Self {
        Self { runtime }
    }

    pub(crate) async fn list_tools(&self) -> Vec<McpToolInfo> {
        let clients = self.runtime.clients.read().await;
        let mut result = Vec::new();

        for (server_name, entry) in clients.iter() {
            for tool_value in &entry.tools {
                if let Some(tool) = mcp_tool_info_from_value(server_name, tool_value) {
                    result.push(tool);
                }
            }
        }

        result.sort_by(|a, b| a.name.cmp(&b.name));
        result
    }

    pub(crate) async fn server_name_for_tool(&self, tool_name: &str) -> Result<String, ApiError> {
        let (server_name, _) = self.resolve_tool_name(tool_name).await?;
        Ok(server_name)
    }

    pub(crate) async fn execute_tool(
        &self,
        tool_name: &str,
        args: &Value,
    ) -> Result<String, ApiError> {
        let started = Instant::now();
        let (server_name, short_name) = self.resolve_tool_name(tool_name).await?;
        let entry = {
            let clients = self.runtime.clients.read().await;
            clients.get(&server_name).cloned().ok_or_else(|| {
                ApiError::NotFound(format!("MCP server '{}' not connected", server_name))
            })?
        };

        let arguments = build_tool_arguments(args);
        let argument_count = arguments.len();
        tracing::info!(
            target: "mcp",
            server = %server_name,
            tool = %short_name,
            full_tool = %tool_name,
            argument_count,
            "Executing MCP tool"
        );
        let params = CallToolRequestParams {
            name: short_name.into(),
            arguments: Some(arguments),
            meta: None,
            task: None,
        };

        let result = entry
            .service
            .call_tool_boxed(params)
            .await
            .map_err(ApiError::internal)?;
        let is_error = result.is_error.unwrap_or(false);
        let elapsed_ms = started.elapsed().as_millis() as u64;
        if is_error {
            tracing::warn!(
                target: "mcp",
                server = %server_name,
                full_tool = %tool_name,
                elapsed_ms,
                "MCP tool returned error"
            );
        } else {
            tracing::info!(
                target: "mcp",
                server = %server_name,
                full_tool = %tool_name,
                elapsed_ms,
                "MCP tool completed"
            );
        }

        Ok(format_tool_result(&result))
    }

    async fn resolve_tool_name(&self, tool_name: &str) -> Result<(String, String), ApiError> {
        let clients = self.runtime.clients.read().await;
        let mut match_name: Option<String> = None;
        for server_name in clients.keys() {
            let prefix = format!("{}_", server_name);
            if tool_name.starts_with(&prefix) {
                let is_better = match_name
                    .as_ref()
                    .map(|current| server_name.len() > current.len())
                    .unwrap_or(true);
                if is_better {
                    match_name = Some(server_name.clone());
                }
            }
        }

        let Some(server_name) = match_name else {
            return Err(ApiError::NotFound(format!(
                "Unknown MCP tool: {}",
                tool_name
            )));
        };

        let short_name = tool_name
            .strip_prefix(&format!("{}_", server_name))
            .unwrap_or(tool_name)
            .to_string();
        Ok((server_name, short_name))
    }
}

pub(crate) fn mcp_tool_info_from_value(
    server_name: &str,
    tool_value: &Value,
) -> Option<McpToolInfo> {
    let name = tool_value.get("name").and_then(|v| v.as_str())?.trim();
    if name.is_empty() {
        return None;
    }

    let description = tool_value
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let input_schema = tool_value
        .get("inputSchema")
        .or_else(|| tool_value.get("input_schema"))
        .cloned();

    Some(McpToolInfo {
        name: format!("{}_{}", server_name, name),
        description,
        input_schema,
    })
}

fn build_tool_arguments(args: &Value) -> Map<String, Value> {
    if let Some(obj) = args.as_object() {
        obj.clone()
    } else {
        Map::new()
    }
}

pub(crate) fn format_tool_result(result: &rmcp::model::CallToolResult) -> String {
    if result.is_error.unwrap_or(false) {
        let mut msg = String::from("Tool execution error:");
        if !result.content.is_empty() {
            for item in &result.content {
                let text = format_content_item(item);
                if !text.is_empty() {
                    msg.push_str(&format!("\n- {}", text));
                }
            }
        }
        return msg;
    }

    let mut msg = String::new();
    if !result.content.is_empty() {
        for item in &result.content {
            let text = format_content_item(item);
            if !text.is_empty() {
                if !msg.is_empty() {
                    msg.push('\n');
                }
                msg.push_str(&text);
            }
        }
    }
    if msg.is_empty() {
        "Tool executed successfully (no output)".to_string()
    } else {
        msg
    }
}

fn format_content_item(item: &rmcp::model::Content) -> String {
    use rmcp::model::{RawContent, ResourceContents};
    match &item.raw {
        RawContent::Text(t) => t.text.clone(),
        RawContent::Image(_) => "[Image content]".to_string(),
        RawContent::Audio(_) => "[Audio content]".to_string(),
        RawContent::Resource(r) => match &r.resource {
            ResourceContents::TextResourceContents { text, .. } => text.clone(),
            ResourceContents::BlobResourceContents { uri, .. } => {
                format!("[Blob: {}]", uri)
            }
        },
        RawContent::ResourceLink(link) => format!("[Resource: {}]", link.uri),
    }
}
