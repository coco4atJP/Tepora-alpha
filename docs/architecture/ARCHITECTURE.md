# Tepora Project - Comprehensive Architecture Specification

[English](#english) | [日本語](#japanese)

<div id="english"></div>

# Comprehensive Architecture Specification (English)

**Version**: 2.1
**Last Updated**: 2025-12-15
**Project Overview**: Local-first personal AI agent system

---

## 1. Project Overview

### 1.1 Project Vision

Tepora aims to **"Realize a true personal AI agent running on consumer hardware."**

#### Core Concepts

- **Local First**: Privacy first. All processing is completed in the local environment.
- **Production Ready**: Transition from experimental code to product quality.
- **Hardware Agnostic**: Works on a wide range of hardware, from high-end GPUs to CPUs.
- **Modular Design**: Modular design emphasizing maintainability, extensibility, and testability.

### 1.2 Features

1. **Episodic Memory System (EM-LLM)**: Realizes a human-like memory mechanism.
2. **Multi-Agent Coordination**: Coordination between conversational and executive agents.
3. **Three Operation Modes**: Chat, Search, Agent.
4. **Infinite Context**: Realizes long-term dialogue with Attention Sinks.
5. **MCP Support**: Extensible tool system with Model Context Protocol.

---

## 2. System Architecture

### 2.1 High-Level Architecture

```mermaid
graph TB
    User[User] <--> Tauri[Tauri Desktop App (Primary)]
    
    subgraph Frontend[Frontend Layer]
        React[React + TypeScript]
        UI[Glassmorphism UI]
        WS[WebSocket Client]
    end
    
    subgraph Backend[Backend Layer]
        FastAPI[FastAPI Server]
        Core[AgentCore<br/>LangGraph]
        
        subgraph Managers
            LLM[LLMManager]
            Tool[ToolManager]
            Mem[MemorySystem]
        end
        
        subgraph AI[AI Engine]
            Llama[llama.cpp Servers]
            Models[GGUF Models]
        end
        
        subgraph Storage
            Chroma[(ChromaDB<br/>Vector DB)]
            SQLite[(SQLite<br/>Chat History)]
        end
    end
    
    subgraph External
        MCP[MCP Servers]
        Native[Native Tools]
    end
    
    Tauri <--> React
    React <--> WS
    WS <-->|WebSocket| FastAPI
    FastAPI <--> Core
    Core <--> LLM
    Core <--> Tool
    Core <--> Mem
    LLM <--> Llama
    Llama <--> Models
    Mem <--> Chroma
    Mem <--> SQLite
    Tool <--> MCP
    Tool <--> Native
```

### 2.2 Layers

| Layer | Technology | Role |
|---|---|---|
| **Presentation** | Tauri + React | UI rendering, user interaction |
| **Communication** | WebSocket | Real-time bidirectional communication |
| **Application** | FastAPI | HTTP endpoints, WebSocket handling |
| **Business Logic** | LangGraph | State machine, agent control flow |
| **Data Access** | ChromaDB, SQLite | Persistence, vector search |
| **Inference Engine** | llama.cpp | LLM inference processing |

---

## 3. Directory Structure

### 3.1 Project Root

```
Tepora/
├── Tepora-app/                 # Main Application Directory
│   ├── backend/                # Backend Application
│   ├── frontend/               # Frontend Application
│   └── scripts/                # Build Scripts
├── scripts/                    # Legacy & Root Scripts
├── docs/                       # Documentation
│   ├── architecture/           # Architecture & Design
│   │   ├── ARCHITECTURE.md
│   │   └── design_document_v2.md
│   ├── planning/               # Planning & Audit
│   └── guides/                 # Guides
│       └── developer_guide.md
└── README.md                   # Project README
```

### 3.2 Backend Structure (`Tepora-app/backend/`)

```
backend/
├── server.py                   # FastAPI Entry Point
├── config.yml                  # System Configuration
├── pyproject.toml              # Dependencies
├── models/                     # GGUF Models
└── src/
    ├── tepora_server/          # Web Server/API Layer
    │   ├── app_factory.py
    │   └── api/
    └── core/                   # Core Logic (Business Logic)
        ├── app/                # Application Layer
        ├── graph/              # LangGraph Logic
        ├── em_llm/             # Episodic Memory System
        ├── llm_manager.py      # LLM Management
        ├── tool_manager.py     # Tool Management
        └── tools/              # Tool Implementations
```

---

<div id="japanese"></div>

# Tepora Project - 包括的アーキテクチャ仕様書 (日本語)

**バージョン**: 2.1
**最終更新日**: 2025-12-15
**プロジェクト概要**: ローカル環境で動作するパーソナルAIエージェントシステム

---

## 1. プロジェクト概要

### 1.1 プロジェクトのビジョン

Teporaは、**「コンシューマーハードウェアで動作する、真のパーソナルAIエージェントの実用化」**を目指すプロジェクトです。

#### コアコンセプト

- **Local First**: プライバシー最優先。全処理をローカル環境で完結
- **Production Ready**: 実験コードから製品品質への移行
- **Hardware Agnostic**: ハイエンドGPUからCPUまで幅広いハードウェアで動作
- **Modular Design**: 保守性・拡張性・テスト容易性を重視したモジュラー設計

### 1.2 プロジェクトの特徴

Teporaは以下の革新的な特徴を持ちます：

1. **エピソード記憶システム (EM-LLM)**: 人間のような記憶の仕組みを実現
2. **マルチエージェント協調**: 対話型と実行型の2つのエージェントが協調
3. **3つの動作モード**: Chat、Search、Agentの使い分け
4. **無限コンテキスト**: Attention Sinksによる長時間対話の実現
5. **MCP対応**: Model Context Protocolによる拡張可能なツールシステム

---

## 2. システムアーキテクチャ

### 2.1 全体構成図

（EnglishセクションのMermaid図を参照してください。構造は同一です。）

### 2.2 アーキテクチャの階層

| 層 | 技術 | 役割 |
|---|---|---|
| **プレゼンテーション層** | Tauri + React | UIレンダリング、ユーザー操作 |
| **通信層** | WebSocket | リアルタイム双方向通信 |
| **アプリケーション層** | FastAPI | HTTPエンドポイント、WebSocketハンドリング |
| **ビジネスロジック層** | LangGraph | ステートマシン、エージェント制御フロー |
| **データアクセス層** | ChromaDB, SQLite | 永続化、ベクトル検索 |
| **推論エンジン層** | llama.cpp | LLM推論処理 |

---

## 3. ディレクトリ構造

### 3.1 プロジェクトルート

```
Tepora/
├── Tepora-app/                 # メインアプリケーションディレクトリ
│   ├── backend/                # バックエンドアプリケーション
│   ├── frontend/               # フロントエンドアプリケーション
│   └── scripts/                # ビルドスクリプト
├── scripts/                    # レガシー・ルート用スクリプト
├── docs/                       # ドキュメント
│   ├── architecture/           # アーキテクチャ・設計
│   │   ├── ARCHITECTURE.md
│   │   └── design_document_v2.md
│   ├── planning/               # 計画・監査
│   └── guides/                 # ガイド
│       └── developer_guide.md
└── README.md                   # プロジェクトREADME
```

### 3.2 バックエンド構造 (`Tepora-app/backend/`)

```
backend/
├── server.py                   # FastAPIエントリーポイント
├── config.yml                  # システム設定ファイル
├── pyproject.toml              # プロジェクト設定・依存関係
├── models/                     # GGUFモデル格納
└── src/
    ├── tepora_server/          # Webサーバー/API層
    │   ├── app_factory.py      # FastAPI App生成
    │   └── api/                # ルート定義
    └── core/                   # コアロジック (Business Logic)
        ├── app/                # アプリケーション層
        ├── graph/              # LangGraphロジック
        ├── em_llm/             # エピソード記憶システム
        ├── llm_manager.py      # LLM管理
        ├── tool_manager.py     # ツール管理
        └── tools/              # ツールシステム
```

---

*詳細な仕様については、英語セクションの図および各モジュールのドキュメントを参照してください。*
