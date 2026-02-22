# Tepora Project 包括的レビュー（2026-02-21）

**レビュー種別**: フルスタック・アーキテクチャ・品質・セキュリティ総合評価  
**レビュー担当**: Cline (AI Code Review)  
**レビュー方針**: 持続可能性・保守性・拡張性・運用安全性を重視した多角的評価

---

## エグゼクティブサマリー

Teporaプロジェクトは、**Local-First AI Agent**として優れた設計思想を持ち、RustバックエンドとReactフロントエンドの両面で高い品質を達成しています。特にグラフベースのエージェント実行エンジン、モジュラーなコンテキストパイプライン、EM-LLM統合などは技術的に先進的です。

**総合評価: B+ (良好)**

| カテゴリ | 評価 | 備考 |
|---------|------|------|
| アーキテクチャ設計 | A | 依存分離・拡張性が優秀 |
| コード品質 | B+ | テストカバレッジ良好・型安全性高い |
| セキュリティ | B | 基盤は堅牢・一部改善余地あり |
| 保守性 | B+ | ドキュメント充実・モジュール化適切 |
| パフォーマンス | B | 非同期設計適切・最適化余地あり |
| 運用性 | B- | ログ・監視に改善余地あり |

---

## 1. アーキテクチャ評価

### 1.1 バックエンドアーキテクチャ（優秀）

**強み:**

- **petgraphベースのグラフエンジン**: LangGraph概念のRustネイティブ実装は技術的に評価できる。`EdgeCondition`による条件分岐、`NodeOutput`によるフロー制御が型安全に設計されている。
  
- **WorkerPipeline（v4.0）**: コンテキスト構築のモジュラー化が優秀。各Worker（System/Memory/Tool/Search/Rag）が単一責任を持ち、`PipelineMode`による有効/無効制御が明確。

- **RagStore trait抽象化**: SQLiteベースの実装ながら、将来的なLanceDB/Qdrant移行パスを確保している点が戦略的に正しい。

- **依存方向の厳格化**: 下位レイヤーが上位レイヤーをインポートしないルールが遵守されている。

**改善推奨:**

```
改善案 A-1: GraphRuntimeのエラーコンテキスト強化
現在: GraphError { node_id, message }
提案: 実行トレース（node履歴、所要時間）を含める

理由: 本番環境でのデバッグ効率向上
優先度: P2
```

```
改善案 A-2: AppStateのライフサイクル明示化
現在: Arc<AppState>が全ハンドラで共有
提案:AppStateRef<T>トレイトでread/writeアクセスを型レベルで区別

理由: 並行アクセス時のデッドロックリスク低減
優先度: P3
```

### 1.2 フロントエンドアーキテクチャ（良好）

**強み:**

- **Zustand + TanStack Query**: クライアント状態とサーバー状態の分離が適切。`websocketStore`と`chatStore`の責務境界が明確。

- **ストリーミングバッファリング**: 50ms間隔でのフラッシュ、Thinking→Answer遷移時のメッセージ統合など、UXを考慮した実装。

- **Feature-Sliced Design**: `features/`ディレクトリによる機能単位のモジュール化。

**改善推奨:**

```
改善案 A-3: ストリーミング状態の正規化
現在: _streamBuffer, _streamMetadata, _flushTimeoutが分散
提案: StreamingStateオブジェクトに集約

理由: 状態の一貫性保証、テスト容易性向上
優先度: P2
```

---

## 2. コード品質評価

### 2.1 Rustバックエンド

**品質メトリクス:**
- テスト: 243 passed / 0 failed ✅
- Clippy: pass ✅
- 型安全性: 高い

**優秀な実装パターン:**

```rust
// models/manager.rs - モデルエントリのupsert実装（C-2対応済み）
if let Some(existing) = registry.models.iter_mut().find(|m| {
    m.repo_id.as_deref() == Some(repo_id)
        && m.filename == filename
        && m.role == role
}) {
    existing.display_name = display_name.to_string();
    // ... 更新処理
    return Ok(updated);
}
```

```rust
// mcp/mod.rs - 適切なformat_tool_result実装
fn format_content_item(item: &rmcp::model::Content) -> String {
    use rmcp::model::{RawContent, ResourceContents};
    match &item.raw {
        RawContent::Text(t) => t.text.clone(),
        RawContent::Image(_) => "[Image content]".to_string(),
        // ... 各バリアントを適切に処理
    }
}
```

**改善推奨:**

```
改善案 C-1: setup_set_active_modelのエラー伝播
場所: src/server/handlers/setup.rs

現在:
pub async fn setup_set_active_model(...) -> Result<impl IntoResponse, ApiError> {
    state.models.update_active_model_config("text", &payload.model_id)?;
    Ok(Json(json!({"success": true})))
}

問題: update_active_model_configのエラーがそのまま返るが、
      フロントエンド側でのエラーハンドリングが一貫していない

提案: エラーレスポンスにmodel_idと具体的な失敗理由を含める
優先度: P1
```

```
改善案 C-2: MCP設定パース失敗時のログ強化
場所: src/mcp/mod.rs

現在:
let parsed = match serde_json::from_str::<McpToolsConfig>(&contents) {
    Ok(config) => config,
    Err(e) => {
        tracing::warn!("Failed to parse MCP config, using current config: {}", e);
        return Ok(self.config.read().await.clone());
    }
};

問題: パース失敗の詳細（行番号、フィールド名）が不明

提案: serde_path_to_string等でエラー位置を特定
優先度: P2
```

### 2.2 Reactフロントエンド

**品質メトリクス:**
- テスト: 196 tests passed ✅
- TypeScript: strict mode ✅
- ESLint: pass ✅

**優秀な実装パターン:**

```typescript
// websocketStore.ts - 再接続ロジック
const calculateBackoff = (attempt: number): number => {
    const delay = Math.min(BASE_RECONNECT_DELAY * 2 ** attempt, MAX_RECONNECT_DELAY);
    const jitter = delay * 0.1 * (Math.random() * 2 - 1);
    return delay + jitter;
};
```

```typescript
// SearchResults.tsx - URL サニタイズ
const getValidUrl = (result: SearchResult) => {
    const raw = ("url" in result && result.url) || ("link" in result && result.link) || "";
    return sanitizeUrl(raw);
};
```

**改善推奨:**

```
改善案 C-3: chatStoreの複雑なストリーミングロジック
場所: src/stores/chatStore.ts

現状: handleStreamChunkが約80行、複数の分岐
提案: useStreamingBufferカスタムフックに分離

理由: テスト容易性、関心の分離
優先度: P2
```

---

## 3. セキュリティ評価

### 3.1 認証・認可

**現状:**
- REST API: `x-api-key`ヘッダー必須（`/health`、`/api/status`を除く）
- WebSocket: `Sec-WebSocket-Protocol`経由でトークン送信
- セッショントークン: `~/.tepora/.session_token`に保存

**改善推奨:**

```
改善案 S-1: WebSocket認証のupgrade前判定
場所: src/server/ws/handler.rs

現在: 条件に関わらずon_upgrade実行、不正時はupgrade後にclose
提案: HTTP段階で401/403を返してupgrade自体を拒否

理由: 接続スパムの負荷低減、ログノイズ削減
優先度: P1
```

```
改善案 S-2: /api/statusの認証要件
場所: src/server/handlers/health.rs

現在: 未認証公開、total_messages等のメトリクス露出
提案: desktop以外では認証必須化、またはメトリクスの詳細度を設定可能に

理由: 情報漏えいリスクの最小化
優先度: P2
```

### 3.2 入力検証

**良好な実装:**

```rust
// モデルファイル名のサニタイズ（実装済み）
fn sanitize_model_filename(filename: &str) -> Option<&str> {
    if filename.is_empty() {
        return None;
    }
    let base = Path::new(filename).file_name().and_then(|n| n.to_str())?;
    if base == filename {
        Some(base)
    } else {
        None
    }
}
```

```typescript
// URLサニタイズ（フロントエンド）
export function sanitizeUrl(url: string): string {
    try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
            return "#";
        }
        return parsed.href;
    } catch {
        return "#";
    }
}
```

**改善推奨:**

```
改善案 S-3: RagContextPanelのURL検証
場所: src/features/chat/RagContextPanel.tsx

現状: url/linkがそのままhrefに使用されている可能性
提案: SearchResultsと同様にsanitizeUrlを適用

優先度: P1
```

### 3.3 依存関係セキュリティ

**現状:**
- cargo audit: RUSTSEC-2023-0071（rsa 0.9.10経由）※sqlxmacros無効化で影響軽減済み
- npm audit: 0 vulnerabilities ✅

```
改善案 S-4: 脆弱性スキャンの自動化
現状: 手動実行
提案: CI/CDパイプラインに組み込み、PR時に自動チェック

優先度: P1
```

---

## 4. 保守性・運用性評価

### 4.1 ドキュメント

**良好:**
- `ARCHITECTURE.md`: 技術仕様が詳細に記述
- `README.md`: セットアップ手順が明確
- Mermaid図によるアーキテクチャ可視化

**改善推奨:**

```
改善案 D-1: APIドキュメント自動生成
現状: ARCHITECTURE.mdに手動記述
提案: utoipa等でOpenAPI仕様を自動生成

理由: 実装とドキュメントの同期維持
優先度: P2
```

```
改善案 D-2: トラブルシューティングガイド
現状: なし
提案: docs/guides/troubleshooting.mdを作成
      - よくあるエラーメッセージと対処法
      - ログの読み方
      - デバッグ手順

優先度: P2
```

### 4.2 ログ・監視

**現状:**
- tracingによる構造化ログ
- ログレベル: RUST_LOG環境変数で制御

**改善推奨:**

```
改善案 D-3: ログの構造化強化
現状: tracing::info/warn/errorベース
提案: 
  - spanによるリクエスト追跡
  - 相関ID（correlation-id）の導入
  - メトリクスエクスポート（Prometheus形式）

優先度: P2
```

```
改善案 D-4: ヘルスチェック詳細化
現状: /healthは"OK"のみ返却
提案: 依存サービス（LLM、DB、MCP）の状態を含む詳細ヘルス

{
  "status": "healthy",
  "components": {
    "llm": { "status": "ok", "model": "gemma-3n" },
    "database": { "status": "ok", "latency_ms": 5 },
    "mcp": { "status": "degraded", "connected": 2, "failed": 1 }
  }
}

優先度: P2
```

---

## 5. パフォーマンス評価

### 5.1 非同期設計

**良好:**
- Tokioベースの非同期ランタイム
- WebSocketストリーミングの適切な実装
- ストリーミングレスポンスによるUX向上

**改善推奨:**

```
改善案 P-1: チャンクフラッシュ間隔の調整
現状: 50ms固定
提案: ネットワーク条件に応じた動的調整、または設定可能化

優先度: P3
```

### 5.2 メモリ管理

**改善推奨:**

```
改善案 P-2: 大規模履歴のページネーション
現状: セッション履歴を一括ロード
提案: 仮想スクロール + チャンク読み込み

理由: 長期間使用時のメモリ使用量削減
優先度: P2
```

---

## 6. テスト戦略評価

### 6.1 ユニットテスト

**良好:**
- バックエンド: 243テスト
- フロントエンド: 196テスト
- モックによる依存分離

### 6.2 改善推奨

```
改善案 T-1: 統合テストの拡充
現状: ユニットテスト中心
提案: 
  - エンドツーエンドのシナリオテスト
  - WebSocket接続の統合テスト
  - MCPツール実行の統合テスト

優先度: P1
```

```
改善案 T-2: テストカバレッジ測定
現状: 未測定
提案: cargo-llvm-cov / Vitest coverageのCI組み込み

優先度: P2
```

---

## 7. 国際化（i18n）評価

**現状:**
- i18next採用
- 4言語対応（en, ja, es, zh）
- `find_i18n_issues.js`による検査スクリプト

**改善推奨:**

```
改善案 I-1: i18n検査スクリプトのパス修正
場所: find_i18n_issues.js

現状: 旧パス（frontend/...）参照でENOENTエラー
提案: Tepora-app/frontend/... に更新

優先度: P1
```

---

## 8. 優先度別改善項目まとめ

### P0（即時対応）

該当なし（重大な問題は解消済み）

### P1（今スプリント）

| ID | カテゴリ | 内容 | 影響度 |
|----|---------|------|--------|
| S-1 | セキュリティ | WS認証のupgrade前判定 | 高 |
| S-3 | セキュリティ | RagContextPanelのURL検証 | 中 |
| S-4 | セキュリティ | 脆弱性スキャン自動化 | 中 |
| C-1 | 品質 | setup_set_active_modelエラー伝播 | 中 |
| I-1 | 保守性 | i18n検査スクリプト修正 | 低 |
| T-1 | 品質 | 統合テスト拡充 | 中 |

### P2（次スプリント）

| ID | カテゴリ | 内容 | 影響度 |
|----|---------|------|--------|
| A-1 | アーキテクチャ | GraphRuntimeエラーコンテキスト強化 | 低 |
| A-3 | アーキテクチャ | ストリーミング状態正規化 | 低 |
| C-2 | 品質 | MCP設定パース失敗ログ強化 | 低 |
| C-3 | 品質 | chatStoreロジック分離 | 低 |
| S-2 | セキュリティ | /api/status認証要件 | 低 |
| D-1 | 保守性 | APIドキュメント自動生成 | 中 |
| D-2 | 保守性 | トラブルシューティングガイド | 中 |
| D-3 | 運用性 | ログ構造化強化 | 中 |
| D-4 | 運用性 | ヘルスチェック詳細化 | 中 |
| P-2 | パフォーマンス | 履歴ページネーション | 中 |
| T-2 | 品質 | テストカバレッジ測定 | 低 |

### P3（改善推奨）

| ID | カテゴリ | 内容 |
|----|---------|------|
| A-2 | アーキテクチャ | AppStateライフサイクル明示化 |
| P-1 | パフォーマンス | チャンクフラッシュ間隔調整 |

対応状況（2026-02-22）:
- ✅ A-2 実施: `AppStateRead` / `AppStateWrite` と `AppStateRef<ReadAccess/WriteAccess>` を導入し、HTTP/WebSocket境界で read/write を型分離
- ✅ P-1 実施: チャンクフラッシュ間隔をネットワークヒント（`navigator.connection`）とチャンク量で動的調整し、`VITE_CHUNK_FLUSH_INTERVAL_MIN/MAX` で範囲を外部設定可能化
- ✅ A-3 / C-3 追補: `chatStore` の `streaming` を実運用状態として `_stream*` と同期し、`useStreamingBuffer` も `streaming` 参照へ統一
- ✅ C-1 追補: `setup_set_active_model` で `ApiError` 種別（`Internal` / `Conflict` 等）を保持しつつ文脈付きメッセージを返却
- ✅ D-4 追補: `/health` の総合判定を修正し、`llm=error` / `mcp!=ok` / `db=error` を `degraded` として一貫判定

---

## 9. ベストプラクティス遵守状況

### 9.1 遵守している項目 ✅

- ✅ **Single Responsibility Principle**: 各モジュール・Workerが単一責任
- ✅ **Dependency Inversion**: traitによる抽象化（RagStore, Node）
- ✅ **Error Handling**: Result型による明示的エラー処理
- ✅ **Type Safety**: TypeScript strict mode、Rust所有権システム
- ✅ **Async/Await**: 適切な非同期パターン
- ✅ **Configuration Externalization**: config.yml / mcp_tools_config.json
- ✅ **Logging**: tracingによる構造化ログ
- ✅ **Input Validation**: サニタイズ関数の適用

### 9.2 改善余地のある項目

- ⚠️ **Observability**: メトリクス・トレーシング不足
- ⚠️ **Documentation**: API仕様の自動生成未導入
- ⚠️ **Testing**: 統合テスト・E2Eテスト不足

---

## 10. 技術的負債評価

| 項目 | 負債レベル | 説明 |
|------|-----------|------|
| 旧Python版資料 | 低 | docs/legacy/で整理済み |
| 未使用コード | 低 | SynthesizerNode等は文書化済み |
| ハードコード | 低 | 設定可能項目が多い |
| テスト不足 | 中 | 統合テスト拡充必要 |

---

## 11. 結論

Teporaプロジェクトは、**高い技術水準**で開発されており、特に以下の点が優れています：

1. **グラフベースのエージェント実行エンジン** - 拡張性と型安全性のバランス
2. **Rustネイティブ実装** - パフォーマンスと安全性の両立
3. **EM-LLM統合** - 先進的なエピソード記憶システム
4. **モジュラー設計** - WorkerPipeline、RagStore抽象化

改善推奨事項の多くは「運用品質の向上」に関連しており、現在の機能実装自体は安定しています。P1項目から順次対応することで、本番運用に向けた信頼性がさらに向上します。

---

**レビュー完了日時**: 2026-02-21 12:15 JST  
**次回レビュー推奨**: P1項目対応後
