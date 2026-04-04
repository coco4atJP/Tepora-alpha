# Teporaプロジェクト コードダイエット分析レポート
2026/3/29
Cline(xiaomi-mimo-v2-pro)

## 概要
Teporaプロジェクトのコードベースを分析し、冗長なコードや最適化可能な箇所を特定しました。

## 1. バックアップファイルの大量生成 🔴 高優先度

### 問題
- `backend-rs/`配下に`*.db.bak.*`ファイルが**30以上**存在
- リポジトリサイズの肥大化を招く
- `.gitignore`にバックアップファイルの除外ルールが不足

### 影響
- Git clone時のダウンロードサイズ増大
- リポジトリのメンテナンス性低下

### 推奨対応
```gitignore
# backend-rs/.gitignore に追加
*.db.bak.*
*.db-shm
*.db-wal
```

---

## 2. LLMクライアントの重複コード 🟡 中優先度

### 問題
以下の3ファイルに類似したストリーミング処理が存在：

1. `llm/ollama_native_client.rs`
2. `llm/lmstudio_native_client.rs`  
3. `llm/openai_compatible_client.rs`

### 共通パターン
- `stream_chat()`関数の構造が類似
- バッファリング処理（`mpsc::channel`）
- タイムアウト処理（`stream_idle_timeout`）
- エラーハンドリング

### 推奨対応
共通のストリーミング基盤を抽出し、`llm/common_streaming.rs`として共通化：

```rust
// 共通のストリーミング処理
pub(crate) async fn handle_stream<S, P>(
    byte_stream: S,
    parser: P,
    timeout: Duration,
    buffer_capacity: usize,
) -> Result<mpsc::Receiver<Result<NormalizedStreamChunk, ApiError>>, ApiError>
where
    S: Stream<Item = Result<Bytes, reqwest::Error>> + Unpin,
    P: Fn(&str) -> Option<NormalizedStreamChunk>,
```

### 期待される効果
- コード行数: 約200行削減
- テスト容易性の向上
- 新しいLLMプロバイダー追加時の開発効率向上

---

## 3. legacy/ディレクトリの旧コード 🟡 中優先度

### 問題
`frontend/src/legacy/`に旧バージョンのコードが残存：

- `legacy/App.tsx` - 旧エントリーポイント
- `legacy/features/` - 旧機能モジュール
- `legacy/stores/` - 旧状態管理
- `legacy/machines/` - 旧ステートマシン

### 現状
- 現在のコードは`app/entry.tsx`を使用
- `legacy/`からのインポートは1件のみ（コメント内の参照）

### 推奨対応
1. **使用状況の確認**: `legacy/`配下のコードが実際に使用されているか確認
2. **段階的削除**: 不要であれば削除
3. **ドキュメント化**: 必要な機能は現在のコードに移植

### 期待される効果
- フロントエンドコード量: 約30%削減
- 開発者の confusion 軽減

---

## 4. Pythonキャッシュファイル 🟢 低優先度

### 問題
`scripts/__pycache__/`ディレクトリが存在

### 推奨対応
```gitignore
# .gitignore に追加
__pycache__/
*.pyc
```

---

## 5. 重複するユーティリティ関数 🟢 低優先度

### 調査結果
- フロントエンドでの重複ユーティリティは検出されず
- バックエンドでは`extract_field_text()`等の共通関数が適切に抽出済み

---

## 優先度別の推奨アクション

### 即座に対応すべき項目
1. ✅ `.gitignore`にバックアップファイルの除外ルールを追加
2. ✅ `__pycache__/`を`.gitignore`に追加

### 短期対応（1-2週間）
1. 📁 legacy/ディレクトリの使用状況調査
2. 📊 バックアップファイルの削除方針決定

### 中期対応（1ヶ月）
1. 🔧 LLMクライアントの共通化リファクタリング
2. 📝 legacy/コードの整理または削除

---

## 定量的な影響予測

| 項目 | 現状 | 改善後 | 削減率 |
|------|------|--------|--------|
| バックアップファイル数 | 30+ | 0 | 100% |
| LLMクライアント コード行数 | ~600行 | ~400行 | 33% |
| legacy/ コード量 | 全体の30% | 0% | 30% |

---

## 結論

Teporaプロジェクトは比較的良好なコード構造を持っていますが、以下の点でダイエットが可能です：

1. **ファイル管理**: バックアップファイルの適切な除外
2. **コード共通化**: LLMクライアントのストリーミング処理
3. **旧コード整理**: legacy/ディレクトリの整理

これらの改善により、リポジトリサイズの削減と保守性の向上が期待できます。