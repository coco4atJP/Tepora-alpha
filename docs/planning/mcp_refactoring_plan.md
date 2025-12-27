# MCP Refactoring Implementation Plan

## Goal Description
Revamp the Model Context Protocol (MCP) integration to provide a seamless user experience. The key objectives are:
1.  **MCP Store**: A built-in registry to easily discover and install MCP servers (tools).
2.  **Robust Execution**: Enhanced stability and error handling for MCP server processes.
3.  **Simplified Settings**: A fully functional GUI for managing MCP servers, replacing manual config file editing.

## User Review Required
> [!IMPORTANT]
> **breaking changes**: The existing `mcp_tools_config.json` structure might be slightly modified to support `enabled` flags and metadata. However, I will attempt to maintain backward compatibility or provide a migration.
> **Dependency**: This plan assumes `uv` is available in the environment for executing Python-based MCP servers, and `npx` for Node.js-based ones.

## Proposed Changes

### Backend (`Tepora-app/backend/src/core`)

#### [NEW] `mcp` module restructuring
Refactor `src/core/tools/mcp.py` into a package `src/core/mcp/`.

1.  **`src/core/mcp/hub.py` (McpHub)**
    -   **Central Hub Pattern**: Centralizes lifecycle management of all MCP clients.
    -   **Config Watcher**: Uses `watchdog` (or similar) to monitor `mcp_tools_config.json` and hot-reload changes without server restart.
    -   **Connection Management**: 
        -   **Stdio**: For local processes (native, npx, uvx, docker).
        -   **SSE (Server-Sent Events)**: For connecting to existing/remote running MCP servers (via `sse-client`).
    -   **Error Handling**: "Lenient Validation" for third-party servers to prevent crashes on minor schema violations.

2.  **`src/core/mcp/registry.py`**
    -   **Registry Integration**: Fetches available servers from `https://registry.modelcontextprotocol.io/v0/servers` (using `httpx`).
    -   **Offline Fallback**: Uses `src/core/mcp/seed.json` (copied from `registry-main/data/seed.json`) if the API is unreachable.
    -   **Caching**: Caches the registry list locally to avoid hitting the API on every request.

3.  **`src/core/mcp/installer.py` (New)**
    -   **Smart Command Generation**: 
        -   Parses `packages` list from the registry response.
        -   Prioritizes `runtimeHint`:
            -   `npx` -> `npx -y <identifier>`
            -   `python`/`uvx` -> `uvx <identifier>`
            -   `docker` -> `docker run -i --rm <identifier>` (Assumes stdio transport)
    -   **Env Configuration**: Extracts `environmentVariables` schema (`isRequired`, `isSecret`, `description`) to pass to the frontend for soliciting user input.

4.  **`server.py` (Modify)**
    -   Add REST API endpoints:
        -   `GET /api/mcp/status`: Get current connection status of all servers.
        -   `GET /api/mcp/config`: Get current configuration.
        -   `POST /api/mcp/config`: Update configuration (add/remove/edit) - this will trigger the Config Watcher.
        -   `GET /api/mcp/store`: Get list of installable servers (from `registry.py`).

### Frontend (`Tepora-app/frontend/src`)

#### [MODIFY] `components/settings/sections/McpSettings.tsx`
-   **Dynamic List**: Replace read-only view with dynamic list from `McpHub`.
-   **Status Indicators**: Show real-time status (Connected/Error/Stopped).
-   **Toggle Switches**: Enable/Disable servers (updates config file).

#### [NEW] `components/settings/sections/McpStoreModal.tsx`
-   **Store Interface**: Lists servers fetched from the Official Registry.
-   **Search & Filter**: Search by name/category.
-   **Smart Install Wizard**: 
    -   **Step 1**: Select server & runtime (npx/python/docker).
    -   **Step 2**: Configuration Form (generated dynamically from `environmentVariables` schema).
        -   Handles `isRequired`, `isSecret` (masked input), `default`, `description`.
    -   **Step 3**: Install (sends config to backend).
-   **Manual Mode Connect**: 
    -   **Transport Selection**: "Local Process" vs "Remote (SSE)".
    -   **SSE**: Input for Server URL.
    -   **Process**: Input for Command and Args.

#### [NEW] `hooks/useMcp.ts`
-   **Debounced Updates**: Custom hook to handle high-frequency status updates from the backend (Coalescing Pattern).

## Verification Plan

### Automated Tests
-   **Backend Unit Tests**:
    -   Create `tests/core/test_mcp_manager.py` to test configuration R/W and Store lookup.
    -   Test `McpManager.install_server` ensures correct command generation.

### Manual Verification
1.  **Frontend UI**:
    -   Open Settings > MCP.
    -   Verify list of currently configured servers is shown.
    -   Toggle a server OFF, save, and verify it is not loaded on backend (check logs).
    -   Toggle ON, save, and verify it reconnects.
2.  **Store & Install**:
    -   Click "Add Server".
    -   Select a server from the "Store" (e.g., "Filesystem" or a simple demo server).
    -   Click Install.
    -   Verify the server appears in the list and connects successfully.
    -   Use the newly added tool in the Chat interface (e.g., ask it to list files).
3.  **Robustness**:
    -   Manually kill a running MCP server process (via Task Manager/kill command).
    -   Verify the backend detects the failure and attempts restart or reports error in UI.
