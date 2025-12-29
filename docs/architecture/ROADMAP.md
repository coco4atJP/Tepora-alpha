# 今後の展望

## 1. Phase 3: Ecosystem (v3.0以降)

> [!NOTE]
> **このセクション (Phase 3) は将来構想です。現時点でコードは実装されていません。**
> 現在の実装状態については「開発経緯」セクション (Phase 2) を参照してください。

### 1.1 AG-UI (Agent-User Interaction Protocol)

エージェントが動的にUIコンポーネントを生成。

**Generative UI**:
- ボタン、フォーム、グラフ、地図などをチャット内に動的表示
- Human-in-the-loop: ツール実行承認をGUIで効率化

### 1.2 A2A Protocol (Agent-to-Agent)

分散エージェント社会を見据えた標準プロトコル。

**機能**:
- **Discovery**: ネットワーク上の他エージェント発見
- **Negotiation**: タスク依頼、能力確認、権限交渉
- **Collaboration**: 共通ゴールに向けた協調作業

### 1.3 Multimodal Capabilities

**Vision**:
- ユーザーがアップロードした画像の認識・解析
- スクリーンショットの理解

**Image Generation**:
- エージェントが説明図やアイデアスケッチを生成

### 1.4 Advanced Reasoning (Thinking)

**System 2 Reasoning**:
- アプリケーション側で思考プロセスを管理
- 「思考」と「回答」のコンテキスト分離
- 複雑な推論の強制的なステップ挿入

### 1.5 Canvas & Artifacts

**Canvas機能**:
- コード、ドキュメント、プレビュー画面をチャットとは別ペインで表示
- リアルタイム共同編集

**Artifact Management**:
- 生成物のバージョン管理
- 後から参照・修正可能

### 1.6 Scalable Agent Registry

**複数エージェント登録**:
- カスタムプロンプト、ツールセット、モデル構成を持つエージェントを無制限登録
- タスクに応じた最適エージェントの自動/手動切り替え

## 2. 技術的将来計画

- **モデルの多様化**: Llama 3, Qwen, Mistralなど、より多くのモデルのサポート
- **マルチモーダルモデル統合**: LLaVA, Bakllavaなどのビジョンモデル
- **分散実行**: 複数デバイス間でのモデル分散推論
- **プラグインマーケットプレイス**: コミュニティ製のプロンプト・ツール共有
