# Tepora Application Architecture

## Overview

Tepora is a local-first AI agent application built using a hybrid architecture. It combines a modern React frontend wrapped in Tauri with a powerful Python backend sidecar that handles AI logic, memory, and tool execution.

## High-Level Architecture

The application consists of two main processes:

1.  **Tepora Desktop (Frontend)**: A Tauri application running a React interface. It acts as the user entry point and orchestrator.
2.  **Tepora Backend (Sidecar)**: A Python FastAPI server running locally as a child process of the Tauri app. It provides the intelligence, memory, and Model Context Protocol (MCP) capabilities.

```mermaid
graph TD
    subgraph "Tepora Desktop (Frontend)"
        UI[React UI (Vite)]
        Tauri[Tauri Core (Rust)]
        UI -->|IPC| Tauri
    end

    subgraph "Tepora Backend (Python Sidecar)"
        API[FastAPI Server]
        Agent[LangGraph Agents]
        MCP[MCP Manager]
        Mem[Memory Manager]
        
        API --> Agent
        Agent --> MCP
        Agent --> Mem
        
        subgraph "Data & Models"
            SQLite[(SQLite DB)]
            Chroma[(ChromaDB)]
            LocalLLM[Local Models]
        end
        
        Mem --> SQLite
        Mem --> Chroma
        Agent --> LocalLLM
    end

    Tauri -->|Spawns & Manages| API
    UI -->|HTTP Requests| API
```

## Component Details

### Frontend Layer
- **Tech Stack**: React 19, TypeScript, Vite 7, Tailwind CSS 4.
- **Role**: Provides the chat interface, settings configuration, and visual feedback.
- **Communication**: Communicates with the backend via HTTP requests to `localhost`. The port is dynamically allocated by the backend and passed to the frontend via environment variables/stdout during startup.

### Backend Layer (Sidecar)
- **Tech Stack**: Python 3.11+, FastAPI, Uvicorn.
- **Entry Point**: `backend/server.py`
- **Core Logic**:
    - **`src.core.graph`**: Manages agent workflows using LangGraph.
    - **`src.core.mcp`**: Implements the Model Context Protocol to connect with external tools and resources.
    - **`src.core.memory`**: Handles episodic memory storage and retrieval.
- **Data Storage**:
    - **SQLite**: Stores chat history and application state (`tepora_chat.db`).
    - **ChromaDB**: Vector database for semantic search and memory embeddings (`chroma_db`).

## Directory Structure

| Directory | Description |
|-----------|-------------|
| `frontend/` | React application source code and Tauri configuration. |
| `backend/` | Python server code, dependency definitions, and entry points. |
| `backend/src/core` | Core logic including agents, memory, and tools. |
| `backend/src/tepora_server` | API route definitions and server factory. |

