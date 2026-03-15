use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::service::{RoleClient, RunningService};
use serde_json::Value;
use tokio::sync::RwLock;

use super::types::{McpServerStatus, McpToolsConfig};

pub(crate) trait SafeMcpService: Send + Sync {
    fn call_tool_boxed(
        &self,
        params: CallToolRequestParams,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<CallToolResult, rmcp::ServiceError>>
                + Send
                + '_,
        >,
    >;
}

impl SafeMcpService for RunningService<RoleClient, ()> {
    fn call_tool_boxed(
        &self,
        params: CallToolRequestParams,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<CallToolResult, rmcp::ServiceError>>
                + Send
                + '_,
        >,
    > {
        Box::pin(self.call_tool(params))
    }
}

#[derive(Clone)]
pub(crate) struct McpClientEntry {
    pub(crate) service: Arc<dyn SafeMcpService>,
    pub(crate) tools: Vec<Value>,
}

#[derive(Clone)]
pub(crate) struct McpRuntimeState {
    pub(crate) config: Arc<RwLock<McpToolsConfig>>,
    pub(crate) status: Arc<RwLock<HashMap<String, McpServerStatus>>>,
    pub(crate) clients: Arc<RwLock<HashMap<String, McpClientEntry>>>,
    initialized: Arc<AtomicBool>,
    pub(crate) init_error: Arc<RwLock<Option<String>>>,
}

impl McpRuntimeState {
    pub(crate) fn new() -> Self {
        Self {
            config: Arc::new(RwLock::new(McpToolsConfig::default())),
            status: Arc::new(RwLock::new(HashMap::new())),
            clients: Arc::new(RwLock::new(HashMap::new())),
            initialized: Arc::new(AtomicBool::new(false)),
            init_error: Arc::new(RwLock::new(None)),
        }
    }

    pub(crate) fn initialized(&self) -> bool {
        self.initialized.load(Ordering::SeqCst)
    }

    pub(crate) fn set_initialized(&self, value: bool) {
        self.initialized.store(value, Ordering::SeqCst);
    }
}
