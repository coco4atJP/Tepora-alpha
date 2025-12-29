# Critical Codebase Audit Report (辛口レビュー)

**Review Date**: 2025-12-28
**Reviewer**: Antigravity (AI Agent)
**Scope**: Full Codebase (Backend & Frontend)
**Tone**: **Strict / Critical / Fault-Finding**

---

## 1. Executive Summary

While the "Project Review Report" paints a rosy picture of a mature codebase (8/10), a deeper, more cynical look reveals significant **fragility** and **hidden technical debt**. The codebase relies heavily on "happy path" assumptions, magic numbers, and broad exception swallowing which masks potential runtime instability.

**Real Score**: 6.5/10 (Requires immediate refactoring before true "Production" readiness)

---

## 2. High Severity Issues (Security & Stability)

### 2.1 Hardcoded Security Logic (`native.py`)
- **File**: `backend/src/core/tools/native.py` (L178-186)
- **Issue**: The IP denylist for `WebFetchTool` is **hardcoded** in the source code.
- **Risk**: If a new private range or specific internal host needs to be blocked (or allowed), it requires a code change and redeploy.
- **Evidence**: `default_denylist = ["localhost", "127.0.0.1", ...]`
- **Critique**: Security rules should **never** be hardcoded. They belong in external configuration. The comment `# TODO: In future, can merge with config-based denylist` admits this failure but delays the fix indefinitely.

### 2.2 Fragile Secret Redaction (`config/service.py`)
- **File**: `backend/src/core/config/service.py` (L23, L176)
- **Issue**:
    1. `SENSITIVE_KEYS` is a hardcoded list (`"api_key", "secret", ...`). If a user adds a key like `"private_key"` or `"auth_token"` (not just `"token"`), it might leak.
    2. `restore_redacted_values` uses complex recursive logic that assumes the structure of the incoming config exactly matches the internal state.
- **Risk**: Accidental exposure of secrets in the API `GET /api/config` if naming conventions aren't strictly followed.

### 2.3 Runtime Import Hiding (`state.py`)
- **File**: `backend/src/tepora_server/state.py` (L68-69)
- **Issue**: Imports for `McpHub` and `McpRegistry` are hidden inside `_initialize_mcp`.
- **Critique**: This is "Import Hiding". While it avoids circular imports, it delays `ImportError` checks until runtime initialization. If `src.core.mcp` has a syntax error, the app will start up and then fail silently or log an error (L60-62) while reporting "healthy" status.
- **Impact**: False sense of system health.

---

## 3. Medium Severity Issues (Architecture & Maintainability)

### 3.1 Magic Numbers Everywhere
Calls to `timeout` and message limits are scattered throughout the code with arbitrary values.

- `frontend/src/App.tsx`: `fetchWithTimeout(..., 10000)` (L12, 60). Why 10 seconds?
- `backend/src/tepora_server/api/session_handler.py`: `timeout=300.0` (L135). 5 minutes for approval is hardcoded.
- `backend/src/core/tools/native.py`: `max_chars = 6000` (L240). Why 6000? Is this tied to context window? If the model changes, this value becomes obsolete.

### 3.2 "Zombie" Code & Deprecation (`routes.py`)
- **File**: `backend/src/tepora_server/api/routes.py` (L31-41)
- **Issue**: Endpoint `GET /api/personas` is explicitly marked as "Deprecated" in comments, with indecisive logic ("Actually, we should probably update...", "For now, let's map...").
- **Critique**: Do not leave conversational doubts in the codebase. Deprecate it formally (with `DeprecationWarning` or API removal) or refactor it. This suggests a lack of decisive API versioning strategy.

### 3.3 Broad Exception Swallowing
The codebase is terrified of crashing, to a fault.

- **Pattern**: `except Exception as e: logger.error(...); return "Error"`
- **Locations**:
    - `native.py` (L99): `noqa: BLE001` - explicit suppression of linter warning.
    - `mcp.py` (L31, L76, L128): Swallows errors during tool loading.
    - `routes.py`: Every endpoint catches `Exception` and returns 500.
- **Critique**: While this keeps the server "up", it makes debugging difficult. Using `FastAPI`'s default exception handlers or a global middleware is cleaner than `try-except` blocks in *every single route function*.

---

## 4. Low Severity & Nitpicks (Code Smells)

### 4.1 Frontend Concerns
- **`App.tsx`**:
    - Hardcoded styling: `bg-gray-950` (L113). This should come from a centralized theme config (Tailwind `index.css` variables) to allow for easy theming (e.g., the "Tea" theme mentioned in history).
    - `h-screen w-screen`: Rigid layout assumption.

### 4.2 Backend Nitpicks
- **`session_handler.py`**:
    - `_pending_approvals: Dict[str, asyncio.Future]` (L73). Memory leak potential if cleanup logic (L145) is bypassed by a server crash or unhandled async exception (though `finally` block exists, process termination kills it). Using a dedicated TTL cache or Redis would be more robust for production.
- **`mcp.py`**:
    - Dead code: `return [], None # type: ignore` (L137). If it's unreachable, remove it or raise `RuntimeError`.

---

## 5. Summary Recommendation

To move from "Prototype/Beta" to "Professional Product", the following actions are required:

1.  **Externalize Configuration**: Move all security lists (denylists, sensitive keys) to `config.yml`.
2.  **Centralize Constants**: Create a `constants.py` (shareable with frontend via API or generation) for timeouts, limits (6000 chars), and defaults.
3.  **Clean Up Routes**: Remove zombie code in `routes.py`. Use FastAPI middleware for global error logging instead of repetitive `try/except`.
4.  **Strict Typing**: Replace `Any` in `native.py` and `config/service.py` with proper Pydantic models or Generics where possible.
