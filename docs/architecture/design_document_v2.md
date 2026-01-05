# Tepora Project Design Document Ver. 2.0 （Legacy）
〜 実験的プロトタイプから、実用的なパーソナルAIエージェントへ 〜

## 1. はじめに (Introduction)

### 1.1 プロジェクトの背景
Teporaプロジェクトは、CLIベースでの機能検証と実験的な実装を経て、新たなフェーズに突入しました。これまでに構築された高度なバックエンドロジック（マルチエージェント、エピソード記憶、ツール実行）は、実用性を証明しました。V2では、これらの技術的資産を基盤とし、一般ユーザーが日常的に使用できる「製品」としての品質と体験を提供することを目指します。

### 1.2 V2のミッション
**「コンシューマーハードウェアで動作する、真のパーソナルAIエージェントの実用化」**

- **Local First**: プライバシーを最優先し、全ての処理をローカル（またはユーザー管理下の）環境で完結させる。
- **Production Ready**: 実験コードの域を脱し、堅牢性、安定性、使いやすさを備えたアプリケーションとしてリリースする。
- **Hardware Agnostic**: ハイエンドGPUだけでなく、iGPUやミドルレンジGPU（RTX 3060等）更には、CPUでも実用的な速度で動作させる。

---

## 2. 現状の技術的基盤 (Current Technical Foundation)

現在（V1.5段階）、以下のバックエンド機能が実装済みであり、CLI環境での動作検証が完了しています。これらはV2の核となります。

### 2.1 コア・アーキテクチャ
- **モジュラー設計**: 2025年11月の大規模リファクタリングにより、`graph` (ステートマシン), `em_llm` (記憶), `tools` (ツール), `llm` (モデル管理) が完全に分離・独立化されています。
- **LangGraph**: アプリケーションの制御フローはLangGraphによるステートマシンとして実装されており、複雑な分岐やループ（ReAct）を堅牢に管理しています。

### 2.2 実装済み機能
1.  **3つの動作モード**:
    -   **Chat**: キャラクターエージェント（Gemma-3N等）による自然な対話。
    -   **Search**: Google検索とRAGを用いた情報収集・要約。
    -   **Agent**: ReActループによる自律的な計画立案とツール実行。
2.  **高度なバックエンド機能**:
    -   **LLMManager**: 複数のGGUFモデル（対話用、ツール実行用、埋め込み用）をメモリ状況に応じて動的にロード/アンロード。
    -   **ToolManager**: MCP (Model Context Protocol) サーバーとの接続およびネイティブツールの統合管理。
    -   **EM-LLM (Episodic Memory)**:
        -   **Surprise-based Segmentation**: LLMの「驚き（Logprobs）」に基づくイベント分割。
        -   **Two-stage Retrieval**: 類似性（Similarity）と時間的連続性（Contiguity）を組み合わせた検索。
        -   **Attention Sinks**: 無限のストリーミング生成を可能にするKVキャッシュ管理機構。
    -   **A2A (Agent-to-Agent)**: エージェント間通信のためのプロトコル定義。

### 2.3 フロントエンド実装の進捗
現在、以下のフロントエンド機能がReact + TypeScript + Tauriで実装済みです。

1.  **Tauri統合**:
    -   デスクトップアプリケーションとしてのビルド設定完了。
    -   バックエンド（Python）をsidecar（`tepora-backend`）として同梱可能な構成。
2.  **コアUI/UX**:
    -   **ダイアルコントロール**: 3つのモード（CHAT, SEARCH, AGENT）を視覚的に切り替えるアニメーション付きダイアル。
    -   **Glassmorphismデザイン**: すりガラス効果、カスタムカラーパレット（coffee, gold）、アニメーションをTailwind CSSで実装。
    -   **WebSocket通信**: `useWebSocket`フックによるリアルタイム双方向通信とストリーミングメッセージ受信。
3.  **主要コンポーネント**:
    -   **ChatInterface**: メインチャット画面、メッセージリスト、入力エリア。
    -   **PersonaSwitcher**: キャラクターとエージェント間の切り替え。
    -   **SearchResults**: 検索結果の表示パネル（Searchモード用）。
    -   **AgentStatus**: エージェント実行状態の可視化（Agentモード用）。
4.  **管理機能**:
    -   **Settings**: 設定画面（ルーティング完了）。
    -   **Logs**: ログ閲覧機能。
    -   **Memory**: メモリ統計の可視化。
5.  **テスト基盤**:
    -   Vitest, Testing Libraryによるユニットテスト・コンポーネントテストの環境構築済み。


---

## 3. V2 システムアーキテクチャ (V2 System Architecture)

V2では、既存のバックエンドをTauriベースのGUIアプリケーションに統合し、さらなる機能拡張と最適化を行います。

### 3.1 全体構成
```mermaid
graph TD
    User[User] <--> GUI[Tauri Frontend (React/TS)]
    GUI <--> |WebSocket / AG-UI| Backend[Python Backend (FastAPI)]
    
    subgraph Backend Services
        Orchestrator[AgentCore (LangGraph)]
        LLM[LLMManager (llama.cpp)]
        Mem[Memory System (ChromaDB + SQLite)]
        Tools[ToolManager]
    end
    
    Backend <--> Orchestrator
    Orchestrator <--> LLM
    Orchestrator <--> Mem
    Orchestrator <--> Tools
    
    Tools <--> MCP[External MCP Servers]
    Tools <--> Native[Native Tools]
```

### 3.2 技術スタック
- **Frontend**: React, TypeScript, Tailwind CSS (Glassmorphism Design)
- **App Shell**: Tauri (Rust) - 軽量かつセキュアなデスクトップアプリ化
- **Backend**: Python 3.10+, FastAPI, Uvicorn
- **AI Engine**: llama.cpp (python-binding) - GGUFモデルの高速推論
- **Database**: 
    - **Vector**: ChromaDB (エピソード記憶、ドキュメント)
    - **Relational**: SQLite (設定、チャット履歴メタデータ)

### 3.3 重要な技術的改修 (Refinement)
1.  **MCP & A2Aの標準化**:
    -   既存の実装を、最新の公式仕様（Reference Implementation）に準拠させる。
    -   接続の安定性とエラーハンドリングを強化する。
2.  **EM-LLMのGUI最適化**:
    -   バックエンドで動作しているAttention Sinksの効果を、フロントエンドのストリーミング表示に遅延なく反映させる。
    -   記憶の想起（Retrieval）プロセスをユーザーに可視化する。

---

## 4. コアコンセプトと機能 (Core Concepts & Features)

### 4.1 マルチエージェント協調
ユーザー体験とタスク遂行能力を両立させるため、役割の異なるエージェントが協調します。

-   **キャラクターエージェント (Persona)**:
    -   **役割**: ユーザーインターフェース、対話、メンタルケア、タスクの受付と報告。
    -   **モデル**: 会話性能と性格付けに優れたモデル (例: Gemma-3-4B-Instruct, Llama-3-8B-Instruct)。
-   **エグゼキューターエージェント (Professional)**:
    -   **役割**: 複雑な論理推論、コーディング、データ分析、ツール実行。
    -   **モデル**: 指示追従能力と論理的思考に優れたモデル (例: Qwen-2.5-Coder, Mistral-Nemo)。

### 4.2 無限コンテキストと記憶 (Infinite Context & Memory)
**EM-LLM (Episodic Memory with LLMs)** を中核技術として採用します。

-   **無限のコンテキスト**: 
    -   **Attention Sinks**: 初期のトークン（Sink）と直近のウィンドウを保持することで、KVキャッシュの破綻を防ぎ、理論上無限長の対話を可能にします。
    -   **エピソード記憶**: 過去の膨大な対話ログから、現在の文脈に関連する「エピソード」を動的に検索・注入することで、長期記憶を実現します。
-   **人間らしい記憶の挙動**:
    -   単なるキーワード検索ではなく、「あの時の会話の続き」のような時間的連続性を考慮した想起を行います。

### 4.3 動作モード (GUI Modes)

#### Chat Mode
-   **目的**: 日常的な会話、相談、ブレインストーミング。
-   **UI**: 没入感のあるシングルカラムのチャットインターフェース。
-   **機能**: キャラクターエージェントが主体。感情表現や共感的な応答。

#### Search Mode
-   **目的**: 情報収集、調査。
-   **UI**: 左側にチャット、右側に検索結果・ブラウザビュー・要約を表示するスプリットビュー。
-   **機能**: RAG (Retrieval-Augmented Generation) とWeb検索を統合。ソースの明示とファクトチェック。

#### Agent Mode
-   **目的**: 複雑なタスクの解決（コーディング、レポート作成、データ整理）。
-   **UI**: 左側にチャット、右側に「思考プロセス（Plan/Thought）」、「実行ログ」、「生成物（Artifact）」を表示するダッシュボードビュー。
-   **機能**: 
    -   ユーザーがゴールを設定し、エージェントが計画（Plan）を立案。
    -   ユーザー承認後、自律的にツールを実行。
    -   **AG-UI** による介入：実行途中でユーザーが判断を下したり、追加情報を提供したりするための動的なUIを生成。

---

## 5. 高度な機能と将来構想 (Advanced Capabilities & Future)

### 5.1 AG-UI (Agent-User Interaction Protocol)
エージェントがユーザーに対して「リッチなインターフェース」を動的に提示するためのプロトコルを導入します。
-   **Generative UI**: エージェントが必要に応じて、ボタン、フォーム、グラフ、地図などのUIコンポーネントを生成し、チャットストリーム内に表示します。
-   **Human-in-the-loop**: ツールの実行承認や、曖昧な点の確認を、自然言語だけでなくGUI部品を通じて効率的に行います。

### 5.2 A2A Protocol (Agent-to-Agent)
将来的な分散エージェント社会を見据えた標準プロトコルです。
-   **Discovery**: ネットワーク上の他のエージェント（自身の別デバイスや、友人のエージェントなど）を発見。
-   **Negotiation**: タスクの依頼、能力の確認、権限の交渉。
-   **Collaboration**: 共通のゴールに向けた協調作業。

### 5.3 Multimodal Capabilities
視覚情報を統合し、エージェントの認識・表現能力を拡張します。
-   **画像の入力 (Vision)**: ユーザーがアップロードした画像やスクリーンショットをエージェントが認識・解析し、対話のコンテキストとして利用します。
-   **画像の生成 (Image Generation)**: エージェントが対話の中で、説明図、アイデアスケッチ、またはユーザーのリクエストに応じた画像を生成します。

### 5.4 Advanced Reasoning (Thinking)
モデル単体の能力に依存せず、アプリケーション側で思考プロセスを管理・強化します。
-   **Application-side Context Management**: 「思考（Thinking）」と「回答（Response）」のコンテキストを分離管理します。
-   **System 2 Reasoning**: 直感的な回答（System 1）の前に、論理的な検証や計画立案（System 2）を行うフェーズを強制的に挿入し、複雑な推論を可能にします。

### 5.5 Canvas & Artifacts
チャットストリームとは別に、成果物を永続的に表示・編集するための領域を提供します。
-   **Canvas機能**: コード、ドキュメント、プレビュー画面などを、チャットの横（別ペイン）でリアルタイムに表示・共同編集できる機能。
-   **Artifact Management**: 生成された成果物をバージョン管理し、後から参照・修正可能にします。

### 5.6 Scalable Agent Registry
-   **複数エージェント登録**: ユーザーは独自のプロンプト、ツールセット、モデル構成を持つカスタムエージェントを無制限に作成・登録できます。
-   **動的切り替え**: タスクの内容に応じて、最適なエージェントを自動または手動で切り替えてシームレスに連携させます。

---

## 6. UI/UX デザインガイドライン

### 6.1 Design Philosophy: "Premium & Ethereal"
-   **Tepora**: 名前の、イタリア語「Tepore(約:温かみ)」と「ora(約:現在)」を意識したデザイン。
-   **Concept**: Logコンセプトの紅茶,喫茶店をテーマにしたデザイン。
-   **Premium**: 高級感のあるデザイン、優れた品質感。
-   **Glassmorphism**: すりガラスのような背景、光の反射、奥行き感を多用し、先進的かつ清潔感のあるデザイン。
-   **Motion**: 状態遷移、ローディング、メッセージの出現などに、物理演算に基づいた自然で滑らかなアニメーション（Spring animation）を適用。
-   **Typography**: 視認性が高く、かつ美しいサンセリフ体（Inter, Roboto等）を使用。

### 6.2 User Centric Control
-   **透明性**: エージェントが「今何をしているか」「なぜそう判断したか」を常に可視化する（特にAgentモード）。
-   **制御権**: 自律動作中であっても、ユーザーはいつでも「一時停止」「修正」「中止」ができる緊急停止ボタンや介入手段を持つ。

---

## 7. 開発ロードマップ (Roadmap)

### Phase 1: Foundation (完了)
-   [x] バックエンドコア（FastAPI, LangGraph）の実装
-   [x] 3つの基本モード（Chat, Search, Agent）のロジック実装
-   [x] EM-LLMの基本実装（分割、検索）
-   [x] モジュラーアーキテクチャへのリファクタリング

### Phase 2: Transition & Refinement (現在 〜 v2.0 Release)
-   [ ] **GUI Migration**: フロントエンドをTauriに完全移行し、インストーラーを作成可能にする。
-   [ ] **Optimization**:
    -   Attention Sinksの完全な統合と長時間テスト。
    -   MCPクライアントの堅牢化。
-   [ ] **UX Polish**:
    -   モード別UIの実装。
    -   設定画面（オーバーレイ）の実装。
    -   ストリーミング描画の滑らかさ向上。

### Phase 3: Ecosystem (v3.0 〜 Future)
-   [ ] **AG-UI Integration**: Generative UIの本格導入。
-   [ ] **A2A Network**: ローカルネットワーク内でのエージェント連携。
-   [ ] **Plugin Marketplace**: ユーザー作成のプロンプトやツール設定の共有機能。

---
*Document Version: 2.0*
*Last Updated: 2025-12-01*