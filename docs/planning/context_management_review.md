# コンテキスト管理・生成の実装レビュー

## レビュー対象

コンテキストの管理・生成を担うバックエンド `src/context/` ディレクトリおよび周辺実装を網羅的にレビューしました。

| ファイル | 行数 | 概要 |
|---------|------|------|
| [pipeline_context.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/pipeline_context.rs) | 519 | PipelineContext / TokenBudget / 各データ構造体 |
| [controller.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs) | 974 | ContextController / WindowRecipe / ブロック収集〜圧縮〜ドロップ〜レンダリング |
| [worker.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/worker.rs) | 286 | ContextWorker trait / WorkerPipeline 実行エンジン |
| [pipeline.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/pipeline.rs) | 323 | ContextPipeline (レガシー + v4 bridge) |
| [window.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/window.rs) | 257 | ContextWindowManager（レガシー、現在未使用） |
| [prompt.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/prompt.rs) | 15 | システムプロンプト抽出ヘルパー |
| [system_worker.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/workers/system_worker.rs) | 71 | モード別システムプロンプト注入 |
| [persona_worker.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/workers/persona_worker.rs) | 95 | ペルソナ設定注入 |
| [memory_worker.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/workers/memory_worker.rs) | 748 | 履歴取得・記憶検索・LocalContext構築 |
| [tool_worker.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/workers/tool_worker.rs) | 113 | ツール定義注入 |
| [search_worker.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/workers/search_worker.rs) | 88 | Web検索実行 |
| [rag_worker.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/workers/rag_worker.rs) | 98 | RAGベクトル検索 |

---

## 全体評価

> [!TIP]
> アーキテクチャ全体としては **よく設計されている**。Worker パイプラインのモジュラー設計、stage-aware な WindowRecipe、tokenizer 対応の動的バジェット管理は、ローカルLLMという制約の中で非常に実践的です。

---

## 指摘事項

### 🔴 深刻度: 高

#### 1. 死蔵されたレガシーパイプラインが技術的負債に

[pipeline.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/pipeline.rs) に [build_chat_context](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/pipeline.rs#27-115)（レガシー）と [build_v4](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/pipeline.rs#116-151)（新方式）の2系統が定義されていますが、**実際の全グラフノード（[chat.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/graph/nodes/chat.rs), [search.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/graph/nodes/search.rs), [search_agentic.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/graph/nodes/search_agentic.rs), [planner.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/graph/nodes/planner.rs), [agent_executor.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/graph/nodes/agent_executor.rs), [synthesizer.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/graph/nodes/synthesizer.rs)）は [build_v4](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/pipeline.rs#116-151) を使用** しており、[build_chat_context](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/pipeline.rs#27-115) の呼び出し元は存在しません。

```rust
// レガシー (dead code): トークンバジェット管理なし (pipeline.rs:27)
pub async fn build_chat_context(...) -> Result<ContextResult, ApiError>

// 主系統: WorkerPipeline経由 (pipeline.rs:116)
pub async fn build_v4(...) -> Result<PipelineContext, ApiError>
```

**問題点**:
- [build_chat_context](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/pipeline.rs#27-115) は死蔵コードだが削除されていない
- [window.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/window.rs) の [ContextWindowManager](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/window.rs#72-75) も完全にデッドコード（`#![allow(dead_code)]`）
- レガシーコードが残存することで、新規開発者にどちらが正系統か混乱を与えうる

**推奨**: [build_chat_context](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/pipeline.rs#27-115) と [window.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/window.rs) を削除し、レガシー残骸を一掃する。

---

#### 2. [trim_to_tokens](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#921-934) のトークン推定が文字数ベースでUnicode非対応

[controller.rs:921-933](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#L921-L933):

```rust
fn trim_to_tokens(text: &str, max_tokens: usize) -> String {
    let approx_chars = max_tokens.saturating_mul(4);  // 英語前提: 1トークン≈4文字
    // ...
}
```

**問題点**: 日本語テキストは 1トークン ≈ 1〜2文字であるため、日本語コンテンツで大幅にオーバーランします。日本語のAIエージェントで、この推定は **実際のトークン数の2〜4倍を許容** してしまう可能性があります。

同様に [controller.rs:942-945](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#L942-L945) の [estimate_tokens](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/pipeline_context.rs#383-387) も `text.len().div_ceil(4)` でバイト数ベース:

```rust
fn estimate_tokens(text: &str) -> usize {
    let base = text.len().div_ceil(4);        // バイト数 / 4
    (base.saturating_mul(135)).div_ceil(100)   // 135% 補正
}
```

**推奨**: 日本語混在テキストの場合、文字種を見て推定精度を向上させるか、[TokenEstimator](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#63-66) のトークナイザー解決をより積極的に利用する。[trim_to_tokens](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#921-934) は [TokenEstimator](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#63-66) を引数に取るべき。

---

#### 3. [estimation_source_for](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#500-512) の呼び出しが全ブロック再カウントで非効率

[controller.rs:500-511](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#L500-L511):

```rust
fn estimation_source_for(&self, blocks: &[ContextBlock]) -> TokenEstimateSource {
    if blocks.iter().any(|block| {
        matches!(
            self.estimator.count_text(&block.content).source,
            TokenEstimateSource::Tokenizer
        )
    }) {
```

[render()](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#120-132) 内で既に [total_tokens()](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#786-792) でカウント済みのブロックを、[estimation_source_for](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#500-512) でもう一度全件 [count_text()](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#72-85) しています。トークナイザーのエンコードは安くないため、特にブロック数が多い場合にパフォーマンスペナルティになります。

**推奨**: [total_tokens](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#786-792) 呼び出し時に source 情報を同時に収集する。

---

### 🟡 深刻度: 中

#### 4. SystemWorker と PersonaWorker の設定読み込み重複

[system_worker.rs:37](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/workers/system_worker.rs#L37) と [persona_worker.rs:40](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/workers/persona_worker.rs#L40):

```rust
// SystemWorker
let config = state.config.load_config().unwrap_or_default();

// PersonaWorker (直後に実行される)
let config = state.config.load_config().unwrap_or_default();
```

パイプライン内の各ワーカーが個別に `load_config()` を呼んでいます（SystemWorker, PersonaWorker, SearchWorker, RagWorker が各々呼出）。`ConfigService::load_config()` はファイルI/Oを伴う可能性があるため、パフォーマンスに影響する可能性あり。

**推奨**: [PipelineContext](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/pipeline_context.rs#255-277) または `WorkerPipeline::run` の段階で config をプリフェッチし共有する。

---

#### 5. MemoryWorker の embedding model 解決ロジックが脆弱

[memory_worker.rs:55-73](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/workers/memory_worker.rs#L55-L73):

```rust
let embedding_model_id = state.models.get_registry().ok()
    .and_then(|registry| {
        registry.role_assignments.get("embedding").cloned()
            .or_else(|| registry.models.iter()
                .find(|model| model.role == "embedding")
                .map(|model| model.id.clone()))
            .or_else(|| registry.models.first()
                .map(|model| model.id.clone()))  // ← 最初のモデルにフォールバック
    })
    .unwrap_or_else(|| "default".to_string());  // ← "default" にさらにフォールバック
```

**問題点**:
- `.first()` は全く無関係なテキストモデルになる可能性あり
- `"default"` というIDはどこにも登録されていない可能性が高い
- 失敗がサイレント（ログなし）

**推奨**: 不適切なフォールバックをログで警告し、embeddingモデルが未設定の場合は明示的にスキップする。

---

#### 6. [extract_entities](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/workers/memory_worker.rs#275-284) が非常に粗い実装

[memory_worker.rs:275-283](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/workers/memory_worker.rs#L275-L283):

```rust
fn extract_entities(input: &str) -> Vec<String> {
    input
        .split(|ch: char| ch.is_whitespace() || matches!(ch, ',' | '.' | ':' | ';' | '!' | '?'))
        .map(str::trim)
        .filter(|token| token.len() >= 3)  // 3バイト以上
        .take(6)
        .map(ToString::to_string)
        .collect()
}
```

**問題点**:
- 日本語は分かち書きなしのため、1文全体が1トークンとして抽出される
- `token.len() >= 3` はバイト長なので、日本語1文字（3バイト）で通過する
- ストップワード（"the", "and", "this" 等）のフィルタリングなし
- 事実上「エンティティ抽出」ではなく「単語分割」になっている

**推奨**: 現状のルールベースを改善するか、将来的にはLLMベースのエンティティ抽出に切り替える旨のコメントを追加。日本語環境では有効性が低いことを明記。

---

#### 7. WindowRecipe のcap設計意図が明文化されていない

[controller.rs:717-736](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#L717-L736) の Agent fallback recipe:

```rust
(PipelineMode::AgentHigh | ..., _) => recipe(
    stage,
    &[
        (ContextBlockKind::System, 15),       // 15
        (ContextBlockKind::Memory, 25),       // +25 = 40
        (ContextBlockKind::LocalContext, 20), // +20 = 60
        (ContextBlockKind::Evidence, 20),     // +20 = 80
        (ContextBlockKind::ArtifactSummary, 15), // +15 = 95
        (ContextBlockKind::InteractionTail, 5),  // +5  = 100
    ],
    // ... UserInput のキャップなし
```

cap 値は「全体配分」ではなく **「種別ごとの上限ヒント」** として機能しているため、合計が100%を超えること自体は即バグではありません。ただし、この設計意図がコード上に明文化されておらず、将来の保守者が「全体配分」と誤解するリスクがあります。

**推奨**: capの意味が「種別単位の上限%」であり全体合計とは無関係であることを、[WindowRecipe](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#37-48) のドキュメントコメントに明記する。必要に応じて debug assertion を追加。

---

### 🟢 深刻度: 低

#### 8. [mod.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/mod.rs) の `#[allow(dead_code)]` がlint整理不足

[mod.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/mod.rs):

```rust
pub mod controller;
#[allow(dead_code)]
pub mod pipeline;
#[allow(dead_code)]
pub mod pipeline_context;
pub mod prompt;
pub mod window;
#[allow(dead_code)]
pub mod worker;
#[allow(dead_code)]
pub mod workers;
```

v4系（[pipeline](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/worker.rs#276-285), [pipeline_context](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/pipeline_context.rs#406-417), [worker](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/worker.rs#126-131), `workers`）に `#[allow(dead_code)]` が付いていますが、実際には全グラフノードが v4 パイプラインを主系統として使用しています。これはv4未移行の証拠ではなく、**lint抑制の整理が追いついていない**だけです。

**推奨**: v4 系モジュールから `#[allow(dead_code)]` を外し、逆に実際のデッドコード（[build_chat_context](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/pipeline.rs#27-115), [window.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/window.rs)）を削除する。

---

#### 9. `ContextController::render` でのブロック順序の安定性

[controller.rs:455-465](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#L455-L465):

```rust
fn render_blocks(&self, mut blocks: Vec<ContextBlock>) -> Vec<ChatMessage> {
    blocks.sort_by_key(|block| render_priority(block.kind));
    // ...
}
```

`sort_by_key` は安定ソートですが、同じ [kind](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#403-439) 内のブロック順序は [collect_blocks](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#133-324) の挿入順に依存します。Memory ブロックは事前にスコアでソートされているものの、Evidence や InteractionTail は挿入順（＝元データの順序）のまま。これは意図通りと思われるが明示的なドキュメントがない。

---

#### 10. tokenizer キャッシュの `Mutex` がブロッキング

[controller.rs:949-971](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#L949-L971):

```rust
type TokenizerCache = Mutex<HashMap<String, Arc<Tokenizer>>>;
```

`std::sync::Mutex` を使っています。async context での使用でも短時間のロックなので実用上問題ないですが、`tokio::sync::RwLock` にするとリード側の並行性が向上します。ただし、`Tokenizer::from_file` は同期I/Oなので、現行の `std::sync::Mutex` は合理的な選択です。

---

## 設計上の良い点

1. **WorkerPipeline の設計**: リトライ/スキップ/致命的エラーの3種のエラーハンドリングが明確で堅牢
2. **stage-aware なWindowRecipe**: モード×ステージの組み合わせごとにキャップ比率を定義しており、きめ細かなコンテキスト制御が可能
3. **memory-first のブロック優先順位**: System → Memory → LocalContext → Evidence → ... → UserInput の順は、EM-LLM の設計思想と合致
4. **TokenBudget の動的解決**: モデルの [context_length](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/pipeline.rs#183-224) / `n_ctx` に追従する設計は、複数モデル対応で実用的
5. **dedupe + compress + drop の3段階**: コンテキスト圧縮のパイプラインが段階的で、必要なコンテンツを最大限保持する設計
6. **トークナイザーキャッシュ**: `OnceLock` + `Mutex<HashMap>` による効率的なキャッシュ

---

## 改善優先度まとめ

| # | 項目 | 深刻度 | 影響範囲 | 工数 |
|---|------|--------|---------|------|
| # | 項目 | 深刻度 | 影響範囲 | 工数 |
|---|------|--------|---------|------|
| 1 | レガシー残骸の削除 | 🔴 高 | コード品質 | 小 |
| 2 | 日本語対応のトークン推定 | 🔴 高 | 日本語利用時 | 中 |
| 3 | estimation_source_for の非効率 | 🔴 高 | パフォーマンス | 小 |
| 4 | config重複読み込み | 🟡 中 | パフォーマンス | 小 |
| 5 | embedding model フォールバック | 🟡 中 | メモリ検索時 | 小 |
| 6 | extract_entities の日本語対応 | 🟡 中 | LocalContext精度 | 中 |
| 7 | WindowRecipe 設計意図の明文化 | 🟡 中 | 保守性 | 小 |
| 8 | dead_code lint整理 | 🟢 低 | コード品質 | 小 |
| 9 | ブロック順序のドキュメント | 🟢 低 | 保守性 | 小 |
| 10 | Mutex最適化 | 🟢 低 | 並行性能 | 小 |
