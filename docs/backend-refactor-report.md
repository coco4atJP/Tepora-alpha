# Backend Refactor Report

This report summarizes the backend audit/refactor work completed so far, with
an emphasis on readability, robustness, and error visibility.

## Overview
- Scope: backend codebase (core, server API, graph, tools, LLM, download)
- Focus: error handling, stability, type clarity, and runtime safety
- Status: ongoing audit; additional passes planned

## Changes Applied
### Conversation/graph pipeline
- Tool error responses are parsed safely, including JSON payloads.
- Attachment handling is normalized to strings for summary/RAG paths.
- ReAct JSON code block extraction is more robust.
- Search nodes are handled asynchronously to avoid sync/async mismatches.

Files:
- Tepora-app/backend/src/core/graph/nodes/conversation.py
- Tepora-app/backend/src/core/graph/nodes/react.py
- Tepora-app/backend/src/core/graph/core.py
- Tepora-app/backend/src/core/state.py

### Tools and web search
- Google search API key handling consistently unwraps SecretStr values.
- Tool enablement checks use the actual key value instead of the SecretStr object.

Files:
- Tepora-app/backend/src/core/tools/native.py

### LLM and process management
- Server launch failures now log exception details for easier diagnostics.
- Log file keys are sanitized to avoid path traversal/special chars.
- Dead process detection triggers restart in the process manager.
- LLM health checks handle invalid JSON responses gracefully.

Files:
- Tepora-app/backend/src/core/llm_manager.py
- Tepora-app/backend/src/core/llm/process_manager.py
- Tepora-app/backend/src/core/llm/health.py

### EM-LLM stability
- Surprise stats and logprobs handling now tolerate missing fields.

Files:
- Tepora-app/backend/src/core/graph/nodes/em_llm.py

### Download/progress pipeline
- Use running loop time for async progress accounting.
- PAUSED status is reflected in progress messages.

Files:
- Tepora-app/backend/src/core/download/binary.py
- Tepora-app/backend/src/core/download/progress.py

### Registry/state load hardening
- Model registry loader validates shape and skips malformed entries.
- Binary registry loader ignores unknown variants or invalid timestamps.
- Download job state loader skips incomplete job entries instead of aborting.

Files:
- Tepora-app/backend/src/core/models/manager.py
- Tepora-app/backend/src/core/download/binary.py
- Tepora-app/backend/src/core/download/progress.py

### API/config/typing cleanup
- WebSocket allowed origins now use settings.
- Tool approval failures stop waiting to avoid indefinite hangs.
- Setup config reload failures are logged for visibility.
- Type hints for attachments and input sanitization clarified.
- Memory cleanup closes memory systems on app shutdown.

Files:
- Tepora-app/backend/src/tepora_server/api/ws.py
- Tepora-app/backend/src/tepora_server/api/session_handler.py
- Tepora-app/backend/src/tepora_server/api/setup.py
- Tepora-app/backend/src/core/app/utils.py
- Tepora-app/backend/src/core/app/core.py
- Tepora-app/backend/src/core/tool_manager.py
- Tepora-app/backend/src/core/config/prompts.py
- Tepora-app/backend/src/core/app/startup_validator.py
- Tepora-app/backend/src/core/mcp/hub.py

## Risk Notes
- WebSocket allowed origins now rely on configuration; incorrect settings can
  reject valid connections.
- Tool confirmation failures return earlier, which may change client behavior.
- Search API key validation is stricter; misconfigured keys disable search.
- Progress events include PAUSED status, which may need frontend handling.
- Malformed registry/state entries are skipped; corrupted entries may be dropped
  instead of recovered.

## Tests
- Full pytest suite executed with all tests passing.

## Status
- Audit complete for core modules; ongoing monitoring recommended.

---

## Extension Pass: Code Readability Improvements (2026-01-16)

### Logging standardization
- Unified log format from f-strings to `%s` placeholder style across all modules.
- Ensures lazy evaluation and consistent style throughout codebase.

Files:
- Tepora-app/backend/src/core/chat_history_manager.py
- Tepora-app/backend/src/tepora_server/api/routes.py
- Tepora-app/backend/src/tepora_server/api/sessions.py
- Tepora-app/backend/src/core/config/loader.py
- Tepora-app/backend/src/tepora_server/app_factory.py
- Tepora-app/backend/src/core/memory/memory_system.py

### Type hint improvements
- Added return type annotations to key methods (save_episode, retrieve, count, close).
- Enhanced docstrings with Args/Returns sections following Sphinx/Google style.
- sqlite3.Error explicitly caught instead of bare Exception in ChatHistoryManager.

Files:
- Tepora-app/backend/src/core/chat_history_manager.py
- Tepora-app/backend/src/core/memory/memory_system.py
- Tepora-app/backend/src/core/memory/chroma_store.py

### Documentation updates
- Docstrings in sessions.py translated from Japanese to English.
- ChromaVectorStore class docstring expanded with Warning and Example sections.
- Deprecated function annotations updated to Sphinx format in loader.py.

Files:
- Tepora-app/backend/src/tepora_server/api/sessions.py
- Tepora-app/backend/src/core/memory/chroma_store.py
- Tepora-app/backend/src/core/config/loader.py

### Verification
- ruff format: All files formatted
- ruff check (E,W,F): 46 E501 errors (pre-existing in other files)
- bandit: No security issues in modified files
- pytest: All tests passing

---

## Extension Pass: G004 Logging Standardization Complete (2026-01-16)

All f-string logging statements (G004) converted to lazy `%s` format.

### Files Modified (~170 total log statements)

**core/em_llm** (16 logs)
- integrator.py, segmenter.py, retrieval.py, boundary.py

**core/graph** (~60 logs)
- nodes/react.py, nodes/conversation.py, nodes/memory.py, nodes/em_llm.py
- routing.py, utils.py

**core/llm** (17 logs)
- process_manager.py, client_factory.py, model_registry.py

**core/download** (11 logs)
- binary.py, manager.py

**core/ misc** (10 logs)
- app/core.py, app/startup_validator.py, llm_manager.py, tool_manager.py

**tepora_server/api** (55 logs)
- setup.py, session_handler.py, ws.py, security.py, mcp_routes.py

### Verification
- ruff check --select=G004: **All checks passed!**
- ruff format: All files formatted
- pytest: 135 passed, 14 warnings
- bandit -lll: No high-severity issues
