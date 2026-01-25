# AGENTS.md

This file contains instructions and context for AI agents working on the Tepora project.

## 1. Project Overview & Architecture
- **Name**: Tepora (Multi-AI Agent System)
- **Concept**: "Cyber Tea Salon" - Glassmorphism, dial controls, tea-inspired palette.
- **Architecture**:
  - **Frontend**: React + TypeScript + Tauri + Tailwind CSS v4. Located in `Tepora-app/frontend/`.
  - **Backend**: Python (FastAPI) + LangGraph + ChromaDB. Located in `Tepora-app/backend/`.
  - **Communication**: Frontend communicates with the Python backend (Sidecar) via HTTP/REST.

## 2. Environment & Dependencies
- **Backend**:
  - Managed by **uv**.
  - Install: `cd Tepora-app/backend && uv sync`
  - Run: `uv run server.py`
  - Tests: `uv run pytest tests/`
- **Frontend**:
  - Managed by **npm**.
  - **Important**: Use `npm ci --legacy-peer-deps` due to peer dependency conflicts.
  - Run Dev: `npm run tauri dev` (starts both frontend and backend sidecar).

## 3. Coding Guidelines (Strict)
- **NO "Dirty Code"**:
  - Do NOT add redundant comments explaining obvious logic (e.g., numbered lists for simple steps).
  - Remove unused legacy code immediately if found.
- **Source of Truth**:
  - Edit source files, never build artifacts (`dist/`, `build/`, `binaries/`).
  - `Tepora-app/backend/src/core/config/schema.py` is the source of truth for configuration.
- **Internationalization**:
  - Documentation must be maintained in **Japanese and English** where possible.
  - UI components must use defensive CSS (fluid widths, `break-words`) to support Japanese text expansion.

## 4. Frontend Specifics
- **Tailwind CSS v4**:
  - Define custom classes in the global scope (e.g., `index.css`) rather than `@layer components` to avoid build errors.
  - Use `settings.css` for global overrides on form components.
- **UI Components**:
  - `FormGroup` supports `orientation="vertical"|"horizontal"`. Use `display: inline` for headers to wrap labels naturally.

## 5. Backend Specifics
- **Sidecar Build**:
  - The backend is packaged as a binary using PyInstaller.
  - `Tepora-app/backend/tepora-backend.spec` handles the build spec.
  - **Warning**: If the build process generates absolute paths in `.spec` files, **revert them** or discard those changes to maintain portability.
- **Configuration**:
  - Model ports in `config.yml` should be set to `0` (dynamic assignment).
  - The backend falls back to defaults in `schema.py` if `config.yml` is missing.

## 6. Verification
- **Frontend Verification**:
  - Use Python Playwright scripts with API mocking.
  - Do not rely on manual testing instructions for the user; automate verification where possible.

## 7. Known Constraints
- `PersonaSwitcher` functionality is currently read-only.
- All CLI traces and legacy scripts (`start_app.bat` etc.) have been removed. Do not reintroduce them.
