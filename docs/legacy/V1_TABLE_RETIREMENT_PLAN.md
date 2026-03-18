# V1 メモリテーブル退役計画

- 作成日: 2026-02-24
- ステータス: Phase E 完了（2026-03-18）
- 対象テーブル: `episodic_events`（v1）
- 移行先: `memory_events` / `memory_edges`（v2）

---

## 1. 背景

EM-LLM × FadeMem 全体再設計（Phase 1〜5）により、v2メモリストア（`memory_events` / `memory_edges`）が本番稼働状態に達した。
Phase 6 の dual-read 比較でv1とv2の検索品質差がないことを確認した後、v1テーブルを段階的に退役させる。

---

## 2. 退役条件（Gate）

以下の全条件を満たした場合にのみ、v1退役を進めてよい。

| # | 条件 | 確認方法 |
|---|------|----------|
| G1 | v2がデフォルト (`em_llm.memory_version = "v2"`) で安定稼働 | ログにv2検索エラーなし（7日間） |
| G2 | dual-read比較で検索品質差が許容範囲内 | `dual-read comparison` ログで v2_avg_score ≥ v1_avg_score × 0.9 |
| G3 | v2の全機能テストが通過 | `cargo test em_llm` / `cargo test memory_v2` |
| G4 | 既存v1データの移行要否が運用判断済み（本プロジェクトは不要） | 運用判断記録（必要な場合のみ移行実施ログ） |

---

## 3. 退役手順

### Phase A: Soft Deprecation（完了）

1. `em_llm.memory_version` のデフォルトを `"v2"` に設定（完了）
2. v1への書き込みを継続（dual-write維持、2026-02-25 まで）
3. v1からの読み取りを `MemoryVersion::V1` または `MemoryVersion::DualCompare` 時のみに限定（2026-02-25 まで）

### Phase B: Write-Stop（完了: 2026-02-25）

1. [x] `ingest_interaction_with_embedding` から v1書き込みを削除
2. [x] `ingest_interaction` の v1 legacy insert を無効化
3. [x] ビルド確認 + テスト通過（`cargo check` / `cargo test em_llm` / `cargo test memory_v2`）

### Phase C: Read-Stop（完了: 2026-02-25）

1. [x] `MemoryVersion::V1` と `MemoryVersion::DualCompare` を削除
2. [x] `EmMemoryStore` の `retrieve_similar` / `reinforce_accesses` への参照を削除
3. [x] `retrieve_v1()` メソッドを削除
4. [x] `store` フィールドを `EmMemoryService` から削除

### Phase D: Table Rename（完了: 2026-03-18）

1. [x] `SqliteMemoryRepository` 初期化時に `episodic_events` を `episodic_events_retired_YYYYMMDD[_N]` に自動リネーム
2. [x] 猶予期間を 30 日に固定
3. [x] ロールバック手順を文書化

### Phase E: Table Drop（完了: 2026-03-18）

1. [x] 猶予期間を過ぎた `episodic_events_retired_*` を起動時に自動DROP
2. [x] `EmMemoryStore` モジュール自体を削除
3. [x] `store.rs` ファイル削除

---

## 4. データ移行ユーティリティ

既存v1データをv2に移行する必要がある場合:

```
POST /api/memory/migrate-v1-to-v2?session_id=<session_id>
```

処理:
1. `episodic_events` から全レコードを取得
2. 各レコードを `MemoryEvent` に変換（episode_id自動生成、event_seq=0）
3. `memory_events` に INSERT
4. 元レコードのID対応を `memory_compaction_members` に記録（トレーサビリティ）

> **注意**: 本プロジェクトでは既存v1データの移行は不要（v1データは参照不要）。
> 移行が必要な場合のみ以下コマンドで実施する。
> このAPIは Phase B 以前に実装・実行が必要。

---

## 5. ロールバック手順

退役中に問題が発生した場合:

1. 2026-02-25 以降（Phase C完了後）は設定切替では戻せないため、Phase C適用前コミットへコードロールバックして再デプロイする
2. アプリケーション再起動
3. Phase D完了後の場合: リネームテーブルを元の名前に戻す
   ```sql
   ALTER TABLE episodic_events_retired_YYYYMMDD RENAME TO episodic_events;
   ```

> 実装上は `episodic_events_retired_YYYYMMDD[_N]` 形式で保存される。
> 同日に複数回退役が発生した場合のみ `_1`, `_2`, ... が付与される。

---

## 6. スケジュール案

| フェーズ | 期間 | 備考 |
|---------|------|------|
| Phase A | 現在〜 | Dual-read比較中 |
| Phase B | Gate G1〜G3 達成後 | Write-stop |
| Phase C | Phase B + 7日間 | Read-stop |
| Phase D | 2026-03-18 | 起動時の自動テーブルリネーム |
| Phase E | 2026-03-18 実装完了 | 30日超の退役テーブル自動削除 + v1コード削除 |

---

## 7. 影響範囲

### 削除対象ファイル（Phase E完了時）

- `backend-rs/src/infrastructure/episodic_store/em_llm/store.rs` — v1ストア実装全体
- `store` 依存のテストケース

### 変更対象ファイル（2026-03-18 実施分）

- `Tepora-app/backend-rs/src/infrastructure/episodic_store/memory_v2/sqlite_repository.rs` — v1テーブル退役・猶予切れDROP
- `Tepora-app/backend-rs/src/infrastructure/episodic_store/em_llm/mod.rs` — `store` モジュール公開削除
- `Tepora-app/backend-rs/src/infrastructure/episodic_store/em_llm/compression.rs` — v2専用化
- `Tepora-app/backend-rs/src/infrastructure/episodic_store/em_llm/tests.rs` — v1 `store_tests` 削除
