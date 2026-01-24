# V2 Cutover Parity Checklist (V1 Removal)

This document is a **functional parity checklist** for cutting over to **V2-only runtime** while **removing V1 execution paths**.

Source of truth: `docs/architecture/ARCHITECTURE.md`.

## Goal

- **V1 is not executed** anywhere in runtime (no env flag, no fallback core).
- **No functional regression** vs current behavior (WebSocket, REST, history, search, tools, EM-LLM).
- V1 code remains only as **archive**: `格納/core_v1_archive/`.

## Runtime Entry Points

- Backend server entry: `Tepora-app/backend/server.py`
- FastAPI app: `Tepora-app/backend/src/tepora_server/app_factory.py`
- Core facade (V2): `Tepora-app/backend/src/core/app_v2.py`
- Server state container: `Tepora-app/backend/src/tepora_server/state.py`

## Parity Items

### WebSocket (streaming chat)

- [ ] `process_user_request()` produces:
  - `on_chat_model_stream` events with streamed token chunks
  - `on_chain_start` / `on_chain_end` events for UI activity log
  - search mode emits `GraphNodes.EXECUTE_SEARCH` output so UI can render `search_results`
- [ ] Dangerous tools require approval callback (via `approval_callback` config injection)
- [ ] Final stats message (`get_memory_stats()`) returns `MemoryStats` shape expected by UI

### REST API

- [ ] `/health` reports `initialized` correctly
- [ ] `/api/status` works in V2-only:
  - `initialized`
  - `em_llm_enabled` / `degraded`
  - `total_messages`
  - `memory_events`
- [ ] `/api/tools` returns the available tool list
- [ ] `/api/sessions/*` works (list/create/get/update/delete/messages)

### Session History (SQLite)

- [ ] Messages are persisted in `ChatHistoryManager` per `session_id`
- [ ] Messages include `additional_kwargs.mode` so history can replay correct mode in UI
- [ ] Session timestamps are updated (`touch_session`) and history is trimmed

### Direct / Search / Agent modes

- [ ] Direct mode:
  - persona/system prompt applied
  - context trimming works (token count if possible, fallback estimation)
  - EM-LLM memory retrieval applied
- [ ] Search mode:
  - generates search queries (unless `skip_web_search`)
  - executes web search tool (`native_google_search`)
  - fetches top URL (`native_web_fetch`) + attachments for RAG context
  - summarization includes citations
- [ ] Agent mode:
  - ReAct loop works
  - tool calls executed through ToolManager with approval gating

### Tools / Providers

- [ ] Default providers are registered in V2-only runtime:
  - `NativeToolProvider` (search, web fetch)
  - `McpToolProvider` (via server-provided `McpHub`)
- [ ] ToolManager exposes:
  - `tools` (filtered)
  - `all_tools` (unfiltered)
  - `aexecute_tool()` for async execution

### EM-LLM

- [ ] `char_memory` / `prof_memory` statistics returned by `get_memory_stats()`
- [ ] Memory retrieval populates `synthesized_memory` for prompt context
- [ ] Memory formation is executed from logprobs when available, with semantic fallback

