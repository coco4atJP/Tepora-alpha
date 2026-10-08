//! Atomic adapter for built-in state tools. The entire read/modify/write plan
//! shares Workspace's one mutex and one savepoint; broadcasts follow commit.
use super::*;
use crate::agent::tools::{self, ToolsState};

impl WorkspaceAccess {
    pub fn tool_state(&self, session_id: &str, request: &Value) -> Result<Value, ApiError> {
        let mut state = self.lock()?;
        state.call("exec", json!({"sql":"SAVEPOINT native_agent_tools"}))?;
        let mut events = Vec::new();
        let result = {
            let mut adapter = Adapter {
                state: &mut state,
                events: &mut events,
            };
            tools::scoped(&mut adapter, session_id, request)
        };
        match result {
            Ok(value) => {
                if let Err(error) = state.call("exec", json!({"sql":"RELEASE native_agent_tools"}))
                {
                    let _ = state.call(
                        "exec",
                        json!({"sql":"ROLLBACK TO native_agent_tools; RELEASE native_agent_tools"}),
                    );
                    return Err(error);
                }
                for event in events {
                    state.publish_value(event)?;
                }
                Ok(value)
            }
            Err(error) => {
                let _ = state.call(
                    "exec",
                    json!({"sql":"ROLLBACK TO native_agent_tools; RELEASE native_agent_tools"}),
                );
                Err(error)
            }
        }
    }
}
struct Adapter<'a> {
    state: &'a mut State,
    events: &'a mut Vec<Value>,
}
impl Adapter<'_> {
    fn call(&mut self, op: &str, args: Value) -> Result<Value, ApiError> {
        self.state.agent_operation(op, &args, self.events)
    }
    fn rows(&mut self, op: &str, args: Value) -> Result<Vec<Value>, ApiError> {
        Ok(self.call(op, args)?.as_array().cloned().unwrap_or_default())
    }
}
impl ToolsState for Adapter<'_> {
    fn sessions(&mut self) -> Result<Vec<Value>, ApiError> {
        self.rows("session.list", json!({}))
    }
    fn session(&mut self, id: &str) -> Result<Value, ApiError> {
        self.call("session.get", json!({"id":id}))
    }
    fn update_session(&mut self, id: &str, patch: Value) -> Result<Value, ApiError> {
        self.call("session.update", json!({"id":id,"patch":patch}))
    }
    fn entry(&mut self, id: &str, seq: u64) -> Result<Option<Value>, ApiError> {
        self.call("session.entry", json!({"id":id,"seq":seq}))
            .map(present)
    }
    fn tail(&mut self, id: &str, count: usize) -> Result<Vec<Value>, ApiError> {
        self.rows("session.tail", json!({"id":id,"limit":count}))
    }
    fn search_history(
        &mut self,
        query: &str,
        ids: &[String],
        limit: usize,
    ) -> Result<Vec<Value>, ApiError> {
        let expression = match_expression(query);
        if expression.is_empty() {
            return Ok(vec![]);
        }
        self.rows(
            "session.search",
            json!({"expression":expression,"sessionIds":ids,"limit":limit}),
        )
    }
    fn evidence(&mut self, id: &str) -> Result<Option<Value>, ApiError> {
        self.call("evidence.get", json!({"id":id})).map(present)
    }
    fn inbox(&mut self, id: &str) -> Result<Vec<Value>, ApiError> {
        self.rows("inbox.pending", json!({"id":id}))
    }
    fn take_inbox_item(&mut self, id: &str, item_id: &str) -> Result<Option<Value>, ApiError> {
        let item = self
            .inbox(id)?
            .into_iter()
            .find(|item| item["id"] == item_id);
        if item.is_some() && self.call("inbox.takeItem", json!({"id":id,"itemId":item_id}))? == true
        {
            Ok(item)
        } else {
            Ok(None)
        }
    }
    fn list_docs(&mut self, collection: &str) -> Result<Vec<Value>, ApiError> {
        self.rows("document.list", json!({"kind":collection}))
    }
    fn get_doc(&mut self, collection: &str, id: &str) -> Result<Option<Value>, ApiError> {
        self.call("document.get", json!({"kind":collection,"id":id}))
            .map(present)
    }
    fn search_memory(&mut self, query: &str, limit: usize) -> Result<Vec<Value>, ApiError> {
        let expression = match_expression(query);
        if expression.is_empty() {
            return Ok(vec![]);
        }
        self.rows(
            "memory.recall",
            json!({"expression":expression,"cloud":false,"share":false,"limit":limit}),
        )
    }
    fn write_memory(
        &mut self,
        content: &str,
        title: &str,
        source: &str,
    ) -> Result<Value, ApiError> {
        self.call(
            "store.memory",
            json!({"content":content,"options":{"title":title,"source":source,"confirmed":true}}),
        )
    }
    fn publish_artifact(
        &mut self,
        title: &str,
        content: &str,
        options: Value,
    ) -> Result<Value, ApiError> {
        self.call(
            "store.artifact",
            json!({"title":title,"content":content,"options":options}),
        )
    }
}
fn present(value: Value) -> Option<Value> {
    if value.is_null() {
        None
    } else {
        Some(value)
    }
}
fn match_expression(query: &str) -> String {
    store_domain::search_tokens(&json!(query), 32, 17)
        .iter()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (Workspace, WorkspaceAccess, PathBuf, String) {
        let dir = env::temp_dir().join(format!("tepora-native-tools-{}", Uuid::new_v4()));
        let workspace = Workspace::open(&dir).unwrap();
        let access = workspace.access();
        let session = access
            .agent_state(
                "session.create",
                json!({"fields":{"id":"tool-main","kind":"main","title":"main"}}),
            )
            .unwrap();
        (
            workspace,
            access,
            dir,
            session["id"].as_str().unwrap().into(),
        )
    }
    fn call(
        access: &WorkspaceAccess,
        id: &str,
        name: &str,
        args: Value,
    ) -> Result<Value, ApiError> {
        access.tool_state(
            id,
            &json!({"op":"nativeTools.execute","name":name,"args":args}),
        )
    }
    #[test]
    fn real_single_connection_tools_persist_search_recall_artifact_and_reply() {
        let (workspace, access, dir, id) = setup();
        let todo = call(
            &access,
            &id,
            "todo",
            json!({"items":[{"text":" do  work ","status":"in_progress"}]}),
        )
        .unwrap();
        assert!(todo["text"].as_str().unwrap().contains("[>] 1. do work"));
        call(
            &access,
            &id,
            "reflect",
            json!({"understanding":" build it ","verified":[" checked "]}),
        )
        .unwrap();
        assert_eq!(
            access.agent_state("session.get", json!({"id":id})).unwrap()["reflection"]
                ["understanding"],
            "build it"
        );
        call(
            &access,
            &id,
            "memory_write",
            json!({"content":"The preferred colour is violet","title":"Preference"}),
        )
        .unwrap();
        assert!(
            call(&access, &id, "memory_search", json!({"query":"violet"})).unwrap()["text"]
                .as_str()
                .unwrap()
                .contains("violet")
        );
        access.agent_state("session.append",json!({"id":id,"type":"tool","body":{"name":"read","content":"short","evidenceId":"long-evidence"}})).unwrap();
        access.agent_state("evidence.put",json!({"id":"long-evidence","sessionId":id,"seq":1,"tool":"read","content":"full evidence 日本😀"})).unwrap();
        assert!(
            call(&access, &id, "recall", json!({"ref":"#1"})).unwrap()["text"]
                .as_str()
                .unwrap()
                .contains("full evidence 日本😀")
        );
        access
            .agent_state(
                "session.append",
                json!({"id":id,"type":"input","body":{"text":"uniquevioletmarker"}}),
            )
            .unwrap();
        assert!(call(
            &access,
            &id,
            "history_search",
            json!({"query":"uniquevioletmarker"})
        )
        .unwrap()["text"]
            .as_str()
            .unwrap()
            .contains("#2"));
        let artifact = call(
            &access,
            &id,
            "artifact",
            json!({"action":"publish","title":"Report","content":"before text"}),
        )
        .unwrap();
        let aid = artifact["data"]["id"].clone();
        call(&access,&id,"artifact",json!({"action":"edit","id":aid,"old_string":"before","new_string":"after","expected_version":1})).unwrap();
        assert!(
            call(&access, &id, "artifact", json!({"action":"read","id":aid})).unwrap()["text"]
                .as_str()
                .unwrap()
                .contains("after text")
        );
        access
            .agent_state(
                "inbox.enqueue",
                json!({"id":id,"item":{"id":"reply-a","from":"child:worker-1","text":"finished"}}),
            )
            .unwrap();
        let request = json!({"op":"nativeTools.reply","fromId":"worker-1","excludedIds":[]});
        assert_eq!(
            access.tool_state(&id, &request).unwrap(),
            json!({"found":true,"text":"finished"})
        );
        assert_eq!(
            access.tool_state(&id, &request).unwrap(),
            json!({"found":false})
        );
        drop(access);
        drop(workspace);
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn failed_artifact_edit_changes_neither_revision_nor_content() {
        let (workspace, access, dir, id) = setup();
        let result = call(
            &access,
            &id,
            "artifact",
            json!({"action":"publish","title":"A","content":"same same"}),
        )
        .unwrap();
        let aid = result["data"]["id"].clone();
        assert_eq!(call(&access,&id,"artifact",json!({"action":"edit","id":aid,"old_string":"same","new_string":"different","expected_version":1})).unwrap_err().status,409);
        let doc = access
            .agent_state("document.get", json!({"kind":"artifact","id":aid}))
            .unwrap();
        assert_eq!(doc["version"], 1);
        assert_eq!(doc["content"], "same same");
        drop(access);
        drop(workspace);
        let _ = fs::remove_dir_all(dir);
    }
}
