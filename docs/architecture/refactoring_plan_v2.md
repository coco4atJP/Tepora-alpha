# Tepora Architecture Refactoring Plan (v2)

**Status**: Implemented (Phase 4 Completed)
**Date**: 2026-01-21 (Updated: 2026-01-23)
**Objective**: Redesign backend architecture to improve modularity, scalability, and maintainability.

---

## 1. Overview

This document details the migration strategy from the current standard `src/core` to the new modular architecture.

> [!IMPORTANT]
> **Implementation Note (P1-1 解決)**: 実装は`src/core/`内にV2コンポーネントを配置。
> `app_v2.py`, `system/`, `graph/`, `rag/`, `context/` 等が該当。

**Correction based on Code Review**:
*   `AgentCore` and `LLMManager` are already partially modular. The **Primary Refactoring Target** is **`ConversationNodes`** (where RAG, Context, and Summarization are tightly coupled).
*   **Concurrency**: `LLMManager` must move away from stateful `_current_model_key` to support multi-session parallel execution.

### Key Changes
1.  **V2 Components in `src/core/`**: V2コンポーネントは`src/core/`に統合配置。
2.  **Explicit Graph Modules**: Separating `Chat`, `Search`, and `Agent` modes into distinct state machines.
3.  **SubGraph Agents**: Specialized agents (Coding, Research) run as isolated SubGraphs.
4.  **Session-Scoped RAG**: Implemented via **Metadata Filtering** (Single Vector Store).
5.  **Framework-Agnostic State**: `core` must NOT depend on FastAPI. `AppState` remains in `tepora_server`.



### Module Dependency Rules (Strict)
To prevent circular dependencies and "Big ball of mud", we enforce the following **One-Way Dependency Flow**:

```mermaid
graph TD
    App[App Wrapper / Facade] --> Graph[Graph Module (Orchestrator)]
    Graph --> Agent[Agent Module]
    Graph --> RAG[RAG Module]
    Graph --> Context[Context Module]
    
    Agent --> LLM[LLM Module]
    Agent --> Tools[Tools Module]
    
    RAG --> LLM
    RAG --> Tools
    
    Context --> System[System / State / Config]
    LLM --> System
    Tools --> System 
```

**Rules**:
1.  **Lower layers NEVER import upper layers.** (e.g., `llm` cannot import `graph`).
2.  **Siblings should minimize dependencies.** (Use dependency injection or event buses if needed).
3.  **`system` and `config` are foundational.** Accessible by all.


---

## 2. Directory Structure Mapping

| V1 (Current) | V2 (New Location) | Description |
| :--- | :--- | :--- |
| `src/core/config/` | `src/core/config/` (Shared) | **Reusable**. Config is shared to avoid duplication. |
| `src/tepora_server/state.py` | `src/tepora_server/state.py` | **Kept in Server**. V2 keeps logic agnostic of HTTP. |
| `src/core/state.py` | `src/core/graph/state.py` | Graph state definitions (e.g. `AgentState`). |
| `src/core/llm_manager.py` | `src/core/llm/service.py` | **Stateless Execution**. Removes `_current_model_key`. |
| `src/core/graph/` | `src/core/graph/` | **Orchestrator**. Passes `session_id` in State. |
| (Mixed in Graph) | `src/core/agent/` | **Specialized Agents**. SubGraphs. |
| `src/core/chat_history_manager.py` | `src/core/context/history.py` | Chat History logic. |
| (Mixed in ConversationNodes) | `src/core/context/window.py` | Token window management. |
| (Mixed in ConversationNodes) | `src/core/rag/` | **RAG Engine**. Source mgmt & Retrieval. |
| `src/core/em_llm/` | `src/core/em_llm/` | EM-LLM logic (Ported/Refined). |
| `src/core/tool_manager.py` | `src/core/tools/manager.py` | Tool execution & PII filter. |
| `src/core/mcp/` | `src/core/mcp/` | MCP Hub & Registry (Ported). |
| `src/core/download/` | `src/core/download/` | Download Manager (Independent). |
| (None) | `src/core/system/` | Logging, Setup, Session Manager. |
| (None) | `src/core/app_v2.py` | **V2 Application Facade**. |

---

## 3. Detailed Component Design

### 3.1 LLM Module (`src/core/llm/`)
Responsible for **Executing Models**. Does NOT handle logic/prompting.

-   **`service.py`**: `LLMService`. Facade for getting clients.
    -   `get_client(role: str) -> BaseChatModel`
    -   `get_embedding_client() -> Embeddings`
-   **`providers/backend_llamacpp.py`**: Wraps `llama-server` process management.
-   **`monitor.py`**: Hardware monitoring (CPU/GPU usage).
-   **Concurrency Strategy (P1-3 実装済)**:
    -   `LLMService` is essentially a factory.
    -   Model selection happens *per request*. The `get_client` method accepts configuration/model_id overrides.
    -   **`asyncio.Lock`によるモデルキー単位の排他制御**を実装。
    -   キャッシュサイズを3に増加し、複数モデルの同時保持を可能に。

### 3.2 System Module (`src/core/system/`)
Infrastructure foundations.

-   **`logging.py`**: `setup_logging()`. Handles rotation and PII redaction.
-   **`session.py`**: **Business Logic** for Sessions.
    -   High-level aggregation: `get_session_resources(session_id) -> (History, VectorStore)`.
    -   Delegates persistence to `src/core/context/history.py`.

### 3.3 Context Module (`src/core/context/`)
Manages "What the LLM sees".

-   **`history.py`**:
    -   Wrapper around existing SQLite logic (initially).
    -   Interface: `SessionHistory`.
    -   **Goal**: Decouple `ChatHistoryManager` from Core V1 dependencies.
-   **`window.py`**: `ContextWindowManager`. De-couples Token Counting from `LLMManager`.

### 3.4 RAG Module (`src/core/rag/`)
Retrieval pipelines.

-   **Store Strategy**: **Metadata Filter**.
    -   `add_document(doc, session_id)`
    -   `search(query, session_id)` -> `filter={"session_id": session_id}`
-   **`manager.py`**: `SourceManager`.

### 3.5 Agent Module (`src/core/agent/`)
Defines the **Behavior**.

-   **`base.py`**: Interface for compiled graphs.
-   **`coding/graph.py`**: The Coding Agent's logic.
-   **`research/graph.py`**: The Research Agent's logic.

### 3.6 Graph Module (`src/core/graph/`)
The Main Router.

-   **`runtime.py`**: `TeporaGraph`.
-   **State Definition**:
    ```python
    class AgentState(TypedDict):
        session_id: str  # Added for V2
        messages: list[BaseMessage]
        # ... other fields
    ```
-   **Nodes**: `router`, `chat_node`, `search_node`, `agent_delegate_node`.

---

## 4. Migration Phases (Step-by-Step)

We will execute this in 4 phases. Each phase must pass its **Acceptance Criteria (Golden Flow)** before moving to the next.

### Phase 1: Foundation (System & Tools) ✅
**Goal**: Build the independent bottom layers and the **Public API Facade**.

1.  [x] **Config**: **IMPORT** `src/core/config` (Do not copy). Ensure V2 uses shared config.
2.  [x] **System**: Create `logging.py`.
3.  [x] **Tools**: Create `tools/manager.py` and move PII handling.
4.  [x] **MCP**: Port MCP (kept in `src/core/mcp`).
5.  [x] **Facade**: Define `src/core/app_v2.py`.
6.  [x] **Verify**: Unit tests for Logging, Tools.

**Acceptance Criteria (Golden Flow)**:
*   `test_foundation_flow`: V2 App can load settings from `src/core/config` and execute a Tool via `ToolManager`.

### Phase 2: Execution Engines (LLM & Memory) ✅
**Goal**: Enable Model running capability **(Concurrency Safe)**.

1.  [x] **Download**: Keep in `src/core/download`.
2.  [x] **LLM**: Implement `LLMService` (Stateless). Ensure no `_current_model_key`.
3.  [x] **EM-LLM**: Keep in `src/core/em_llm`.
4.  [x] **Context**: Create `history.py` (Wrapping existing SQLite logic).
5.  [x] **Verify**: Ensure models can load and answer simple prompts.

**Acceptance Criteria (Golden Flow)**:
*   `test_llm_execution_flow`: Initialize `LLMService` using a **Mock LLM**. Send a "Hello" prompt, and receive a pre-defined string response. Verify Token Window logic trims a long history correctly.

### Phase 3: RAG & Agents ✅
**Goal**: Implement the intelligence.

**Refactoring Map (ConversationNodes)**:
| Current Method in `conversation.py` | V2 Location | Responsibility |
|----------------|-------------|---------------|
| `_build_local_context` | `src/core/context/window.py` | Context Window Management |
| `_collect_rag_chunks` | `src/core/rag/engine.py` | RAG Retrieval Logic |
| `_build_rag_context` | `src/core/rag/prompts.py` | RAG Context Formatting |
| `direct_answer_node` | `src/core/graph/nodes/chat.py` | Direct Chat Node |
| `summarize_search_result_node` | `src/core/graph/nodes/search.py` | Search Summary Node |

1.  [x] **RAG**: Implement `SourceManager` and Simple RAG engine.
2.  [x] **Agents**: Create dummy/skeletal Specialized Agents.
3.  [x] **Graph**: Implement `TeporaGraph` (Router). Connect to RAG and Agents.
4.  [x] **Verify**: Test Chat Mode and Search Mode flows.

**Acceptance Criteria (Golden Flow)**:
*   `test_rag_search_flow`: Create a Session, Add a dummy PDF source (mock text), Switch to `Search Mode`, Ask a question about the PDF, and verify the answer cites the source.

### Phase 4: Integration ✅
**Goal**: Switch the Server to use V2.

1.  [x] **App Wrapper**: Finalize `src/core/app_v2.py` (Connect all real modules).
2.  [x] **Server**: Modify `state.py` to inject V2 app via `TEPORA_USE_V2` flag.
3.  [x] **E2E Test**: Run full regression tests (Chat, History, Settings).
4.  [ ] **Cleanup**: Archive V1 to `格納/core_v1_archive`.

**Acceptance Criteria (Golden Flow)**:
*   `test_full_system_e2e`: Send "Hello" via WebSocket (mock auth), Receive Stream, Switch to Agent Mode, Verify Agent routing.

---

## 5. Next Steps

START Phase 1.
1. Create `src/core_v2` directory.
2. Set up `logging` and `config`.
