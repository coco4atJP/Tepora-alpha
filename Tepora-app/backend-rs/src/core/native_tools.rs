//! ネイティブツールの定数定義
//!
//! ネイティブツール名の正準名、説明、エイリアス解決を一元管理する。
//! `server/handlers/tools.rs`・`agent/execution.rs`・
//! `agent/exclusive_manager.rs` はここを参照する。

// --- 正準名定数 ---

pub const NATIVE_WEB_FETCH: &str = "native_web_fetch";
pub const NATIVE_SEARCH: &str = "native_search";
pub const NATIVE_RAG_SEARCH: &str = "native_rag_search";
pub const NATIVE_RAG_INGEST: &str = "native_rag_ingest";
pub const NATIVE_RAG_TEXT_SEARCH: &str = "native_rag_text_search";
pub const NATIVE_RAG_GET_CHUNK: &str = "native_rag_get_chunk";
pub const NATIVE_RAG_GET_CHUNK_WINDOW: &str = "native_rag_get_chunk_window";
pub const NATIVE_RAG_CLEAR_SESSION: &str = "native_rag_clear_session";
pub const NATIVE_RAG_REINDEX: &str = "native_rag_reindex";

// --- ツール定義 ---

/// LLM/API 提示用のネイティブツール情報
#[derive(Debug, Clone, Copy)]
pub struct NativeTool {
    pub name: &'static str,
    pub description: &'static str,
}

/// 全ネイティブツールの一覧（定義順）
pub const NATIVE_TOOLS: &[NativeTool] = &[
    NativeTool {
        name: NATIVE_WEB_FETCH,
        description: "Fetch content from a URL",
    },
    NativeTool {
        name: NATIVE_SEARCH,
        description: "Search the web",
    },
    NativeTool {
        name: NATIVE_RAG_SEARCH,
        description: "Search RAG by embedding similarity",
    },
    NativeTool {
        name: NATIVE_RAG_INGEST,
        description: "Ingest text into RAG",
    },
    NativeTool {
        name: NATIVE_RAG_TEXT_SEARCH,
        description: "Search RAG by text pattern",
    },
    NativeTool {
        name: NATIVE_RAG_GET_CHUNK,
        description: "Get one RAG chunk by ID",
    },
    NativeTool {
        name: NATIVE_RAG_GET_CHUNK_WINDOW,
        description: "Get neighboring RAG chunks around one chunk",
    },
    NativeTool {
        name: NATIVE_RAG_CLEAR_SESSION,
        description: "Clear all RAG chunks for a session",
    },
    NativeTool {
        name: NATIVE_RAG_REINDEX,
        description: "Reindex RAG with a specific embedding model",
    },
];

// --- エイリアス解決 ---

/// `agents.yaml` 等で使用される短縮名・エイリアスを正準名に解決する。
///
/// # 変換例
/// - `"web_search"` / `"search"` → `"native_search"`
/// - `"fetch_url"` / `"fetch"` / `"web_fetch"` → `"native_web_fetch"`
/// - `"mcp:server_tool"` → `"server_tool"` (MCP プレフィックスを除去)
/// - すでに正準名であれば変換なし
pub fn resolve_tool_alias(raw: &str) -> String {
    let trimmed = raw.trim();

    // MCP prefix shorthand
    if let Some(mcp_name) = trimmed.strip_prefix("mcp:") {
        return mcp_name.to_string();
    }

    // Native tool aliases
    match trimmed {
        "web_search" | "search" => NATIVE_SEARCH.to_string(),
        "fetch_url" | "fetch" | "web_fetch" => NATIVE_WEB_FETCH.to_string(),
        "rag_search" => NATIVE_RAG_SEARCH.to_string(),
        "rag_ingest" => NATIVE_RAG_INGEST.to_string(),
        "rag_text_search" => NATIVE_RAG_TEXT_SEARCH.to_string(),
        "rag_get_chunk" => NATIVE_RAG_GET_CHUNK.to_string(),
        "rag_get_chunk_window" => NATIVE_RAG_GET_CHUNK_WINDOW.to_string(),
        "rag_clear_session" => NATIVE_RAG_CLEAR_SESSION.to_string(),
        "rag_reindex" => NATIVE_RAG_REINDEX.to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_native_tool_names_are_unique() {
        let names: Vec<_> = NATIVE_TOOLS.iter().map(|t| t.name).collect();
        let mut unique = names.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(names.len(), unique.len(), "Duplicate native tool names found");
    }

    #[test]
    fn resolve_tool_alias_works() {
        assert_eq!(resolve_tool_alias("web_search"), NATIVE_SEARCH);
        assert_eq!(resolve_tool_alias("search"), NATIVE_SEARCH);
        assert_eq!(resolve_tool_alias("fetch_url"), NATIVE_WEB_FETCH);
        assert_eq!(resolve_tool_alias("fetch"), NATIVE_WEB_FETCH);
        assert_eq!(resolve_tool_alias("web_fetch"), NATIVE_WEB_FETCH);
        assert_eq!(resolve_tool_alias("rag_search"), NATIVE_RAG_SEARCH);
        assert_eq!(resolve_tool_alias("rag_ingest"), NATIVE_RAG_INGEST);
        assert_eq!(resolve_tool_alias("rag_text_search"), NATIVE_RAG_TEXT_SEARCH);
        assert_eq!(resolve_tool_alias("rag_get_chunk"), NATIVE_RAG_GET_CHUNK);
        assert_eq!(
            resolve_tool_alias("rag_get_chunk_window"),
            NATIVE_RAG_GET_CHUNK_WINDOW
        );
        assert_eq!(resolve_tool_alias("rag_clear_session"), NATIVE_RAG_CLEAR_SESSION);
        assert_eq!(resolve_tool_alias("rag_reindex"), NATIVE_RAG_REINDEX);
        assert_eq!(resolve_tool_alias("mcp:server_tool"), "server_tool");
        assert_eq!(resolve_tool_alias("native_search"), NATIVE_SEARCH);
        assert_eq!(resolve_tool_alias("custom_tool"), "custom_tool");
    }
}
