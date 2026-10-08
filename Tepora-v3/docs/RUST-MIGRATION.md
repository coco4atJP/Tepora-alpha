# Rust移行 — beta.11

## 実装する範囲

移植元は `835c585da7d4fbe2b463492edefce70ad20d19b8`。V3はTypeScriptではなくNode.js ESMのJavaScriptと素のJavaScript/CSSのGUIです。既存のRustはTauriの薄いホストだけでした。

以下は第1段階からの移行記録です。現在の到達点は末尾の**メディア生成ジョブ**であり、通常起動・Tauriの全面切替は行っていません。

第1段階では、`native-core` をRustライブラリとして追加し、実際のSQLite処理を移しました。

- 設定・文書の保存と検索インデックス、メモリー削除時のイベント／ベクトル消去
- イベントの採番・保存・再生・保存件数制限
- セッションの追記型ログ、証拠、検索、順序付き受信箱と消費
- 成果物の期待版チェック、改版履歴と本体の原子的な更新
- トランザクションとSQLite接続の単一所有

第2〜3段階で文脈・トークン予算・通信形式、モデル/ツールの順序、外側の実行枠・再試行・停止/再開・完了判定をRustへ移しました。第4〜5段階で独立HTTP/状態ホストを追加し、第6段階では実際のプロバイダー送受信、対応する17ツール、承認、コンパクション、自己点検まで明示的なRust起動モードへ接続しています。第7段階でプロセスと能力設定、第8段階で人格・設定・表示状態、第9段階でWeb検索・取得を接続しました。ビルド済みnative-agentバイナリーはNodeなしで動きますが、予定・ブラウザー描画/MCP/音声/メディア/PC操作・JSプラグイン等の効果処理は未移植です。通常起動はNode互換サービスのままであり、全バックエンドの移行完了を意味しません。GUIはJavaScript/CSS、任意のワーカーは引き続きPythonです。

## 接続と互換性

`core/native-state.mjs` がN-APIでRustのドメイン操作を呼びます。`Store` と `SessionStore` の公開APIは維持します。イベントの購読コールバック、設定の既定値、インポート／エクスポートの検証と検索の字句生成は共有Rustドメインへ移しました。JavaScript側は既存のコールバック、参照同一性やundefined属性の互換面を担当します。

RustライブラリはNodeを使わない構成でもコンパイル・テストできます。N-APIは移行中の接続層であり、SQLiteクエリだけを転送するラッパーではありません。SQL互換面は既存の複合トランザクションと診断／テストに限定し、通常の保存・セッション操作にはドメインAPIを使います。

データファイル名・テーブル・JSONフィールド・FTS5スキーマを維持します。既存DBを削除したり、別DBに変換したりしません。新しいテーブルを別形式に変更せず、WALとbusy timeoutを引き継ぎます。外側のトランザクション中にもRust操作を使えるよう、原子的なドメイン操作はセーブポイントで保護します。

セッションの次の番号はプロセス内キャッシュに頼らず、追記と同じトランザクション中に算出します。複数の `SessionStore` ファサードで番号が衝突しません。成果物の期待版チェックも更新と同じトランザクション内です。

Rustコアをロードできない場合は明確なエラーで停止します。JavaScriptのDBへの暗黙のフォールバックや別接続は行いません。通常のNodeホストは既存のサービス所有権確認を維持し、独立Rustホストは同じ所有権リースとOSのPID生存確認を使います。両者で同じデータ領域を同時に開きません。

## ビルド・検証

```sh
npm run build:core
npm run test:rust
npm test
npm run quality
```

ソース版の初回ビルドは[公式Rust stable](https://rustup.rs)とOSのC/C++ビルドツールが必要です。依存クレートはCargo.lockで固定します。`npm start`、`npm run serve`、ソース版の起動ファイル、通常のテスト／品質ゲートは必要に応じてビルドします。直接 `node core/server.mjs` や `node --test` を呼ぶ前には `npm run build:core` を実行します。

ビルド成果物は `core/native/tepora_core.node`。ソース・対象プラットフォーム・プロファイルとバイナリハッシュを照合して再ビルドを省略します。バイナリとローカルDBはGitに含めません。デスクトップのsidecar準備でrelease版をビルドし、Nodeと同じパッケージに同梱します。インストール済みアプリの利用者にはRustツールチェーンは不要です。

Rust単体テストは `--no-default-features` でNodeから独立したコアを確認します。Node回帰試験は、旧形式DBの読み取り・再起動・原子的な受信箱・成果物改版・メモリー削除・Unicode・外側トランザクションを確認します。Linuxでの検証とWindows/macOSのネイティブパッケージ検証は区別します。実モデル・有料APIへの通信はこの移行検証に含みません。

## 続く移行

1. 未移植のブラウザー描画/MCP/PC操作、能力サービスの効果、予定・heartbeat・dream最適化、周辺APIを段階的に移す
2. 任意のJSプラグインを残す場合は、既存の生きたコールバックとコンテキストを維持する明示的な互換ホストを実装する
3. 全ルート・停止/再起動・権限・実モデルの受け入れ試験を揃え、Windows/macOSで配布物の組み立て・インストール・常駐・終了を確認する
4. その証拠が揃ってから通常起動とTauri sidecarの切替を判断する

段階を飛ばしてGUIや既存機能を削ることで「Rust化完了」とはしません。現行の `core/sandbox.mjs` は `mode:'off'` が既定です。古いprotected/legacy-host文書を根拠に削除済みの実行境界を復活させず、現在の利用者設定とファイル/承認/通信のガードを引き継ぎます。

## 第1段階の検証記録（2026-10-07、Linux）

- Rust単体試験: 19件合格、`cargo fmt --check` 合格
- Node回帰: 406件中401件合格。新規18件は全件合格
- 移植前の独立ベースライン: 388件中383件合格。移植後の失敗5件は同じブラウザー起動3件、DNS解決1件、bubblewrap権限制約1件
- ルート起動／終了・履歴ベースのリリースノートを含むルート試験: 5件合格
- Pythonワーカー契約: 13件合格。能力連携のローカルfixture: 5件合格
- 構文180モジュール、100シナリオの参照確認、プレビュー生成: 合格
- `npm run quality` はRust・構文を通過し、上記の既存Node失敗で停止。品質ゲート全体が合格したという意味ではない
- Windows/macOSの実パッケージ・実モデルは未検証。CIと実機の結果を別途確認する


## 第2段階 — モデルの文脈と通信形式

- `native-core/src/context.rs`: チェックポイント、まとめて消去した結果、最新の一時結果、画像の表示可否、古い長い引数の縮小、ツール呼び出しと結果の整合、キャッシュ境界をRustで構築
- `native-core/src/tokens.rs`: 文字種・UTF-16長・画像寸法からのトークン見積もりと補正計算。Node22（Unicode16）/24（Unicode17）の差も明示的に扱う
- `native-core/src/protocols.rs`: Chat Completions、Responses、Anthropic、Gemini、Ollamaの要求エンコードと応答状態機械。思考区間、通知順、使用量、不完全なツール引数、接続先固有の不透明データを保持
- JavaScriptはHTTP許可・送受信・中断シグナル・UTF-8/SSE/NDJSONの枠切りと公開APIの薄い接続層を担当する。認証情報や許可をRustの応答が新たに作ることはない

旧実装は試験専用の比較用コードとして固定し、本番にJavaScriptの文脈／プロトコル実装を残すフォールバックは設けない。要求JSONのキー順を含む出力、ストリーム通知順、エラー、画像、壊れた引数、浮動小数、途中で切れたUTF-16を比較する。ランダムに生成するツールIDだけは同一文字列を要求せず、一意性と接続先が提供したIDの保持を確認する。

この段階で明示的に修正した点:

- 画像トークンの旧キャッシュはURLの長さと末尾だけで衝突し得た。Rust版は限定された画像ヘッダーから実際の寸法を計算する
- 不正なAnthropicブロックの型でネイティブ処理をpanicさせず、応答の失敗として扱う
- ツール呼び出し等、本来配列である上流データが不正な型なら、内容を黙って落として完了扱いにせず失敗として扱う

第1段階の公開チェックポイント: `44a5ec0bd0bb6973da275d2956540bd3a91ecadf`（ローカル試験済み `f9ba118` と同じGit tree）。[draft PR #243](https://github.com/coco4atJP/Tepora-alpha/pull/243)で継続する。第1段階CIではUbuntu品質ゲートが合格し、Windows/macOSでもRustビルド・Rust単体・新規移植試験が合格した。既存のWindows/macOS Node試験が失敗したため、実配布物の組み立て・起動はまだ未検証。

### 第2段階の検証記録（2026-10-07、Linux）

- Rust単体56件合格。Nodeに依存しないコアを検証
- 旧実装との比較20件はNode22.16/24の両方で全件合格（値、要求JSONバイト、エラー、通知順、Unicode16/17）
- 全Node回帰は両バージョンで421/426。失敗5件は移植前のブラウザー3・DNS1・bubblewrap1と同じ
- ルート起動等5件、ローカル能力連携5件合格
- `npm run quality` はRust/構文を通過し、同じ既存Node失敗で停止。検証中のソース変更はない

- Linuxのrelease版Rustコアのビルド/ロードとNode22の状態・文脈・プロトコル試験36件も合格


## 第3段階前半 — モデル/ツール実行の状態機械

`native-core/src/execution.rs` が1ステップの順序と判断を所有する。モデル要求前の文脈処理、失敗分類後の待機/コンパクション、拒否/空応答/途中切断、ツールの連続した読み取りグループ、承認から実行までをRustのコマンド/完了イベントで進める。各操作はセッション・世代・操作IDに結び付け、古い完了イベントから次の操作を始めない。

`core/agent/loop.mjs` は既存のモデル通信、プラグイン、ツール、保存/通知への接続を行う。JSの関数やカスタム結果オブジェクトは呼び出し中だけホストに保持し、Rustには参照IDを渡す。従来のプラグインコールバックを消さない。外側の起動/同時実行数/予定/完了判定、プロバイダー再試行、コンパクションの進行管理、自己点検の制御はまだJSにあり、この段階で全バックエンド移行済みとはしない。

明示的な安全修正:
- beforeToolで変更されたMCP引数が、承認された引数と実際の実行引数で食い違わない
- 承認待ち中にプラグインが保持する引数を変えた場合は実行しない
- 停止時にも現在の並列グループを回収し、モデルの順序で結果を記録。後続グループは未実行と区別する
- 停止後の遅いモデル応答/ストリームを破棄し、承認前の古い表示文を復活させない
- 循環参照や投げるプロパティを持つプラグイン例外も、安全なエラー情報として完了処理し、制御機械を稼働中のまま残さない

### 再構築後の検証（2026-10-07、Linux/Node24）

クラウド作業領域のロールバック後、公開済みdc5da6cから第3段階を再構築した。失われた作業コピーの結果を現在のソースの合格証拠には使っていない。

- 現在のRust単体72/72、専用統合10/10合格
- 現在の全Node431/436。失敗はLinuxで従来観測したブラウザー3件・DNS1件・bubblewrap1件
- ルート起動等5/5、ローカル能力連携5/5、構文187モジュール合格
- `npm run quality` はRust/構文を通過後、上記Node失敗で停止。ソースは検証中に変更されていない

### Windows/macOSの区別

第2段階のWindows/macOSではRustビルド・Rust単体・追加移植試験が合格したが、Node試験で止まり配布物は未検証。これはLinuxの5件とは別である。

移植前835c585のnative run37561608054と移植後dc5da6cのrun37584390433を直接照合すると、macOSは同じDocker/Podman不足テストで失敗。Windowsの移植後の全失敗テスト名は移植前にもあり、移植前だけにcompletion-check timeoutが1件追加されていた。引用・二重ドライブ文字・EBUSY・timeoutの症状も両方にある。ただしEBUSY対象が.sqlite/.sqlite-shmで変わる等の揺れがあり、すべての根因が同一と断定するものではない。配布物を受け入れるには、残る失敗の診断と実ビルド/起動確認が必要。


## 第3段階後半 — 外側の実行ライフサイクル

`native-core/src/runtime.rs` が、メイン会話とは独立した作業枠の予約、待機列、費用上限、再試行タイマーの識別、実行世代、停止後の回収、再開、完了前のチェック順序を所有する。未完了todo → 存在しない成果物の主張 → 未作業 → turnEndフック → 完了判定の順と回数制限を保持する。

`core/agent/runtime-host.mjs` はRustの指示に対応するPromise・AbortController・タイマーハンドルを持つ。JavaScriptのMapは実行枠の判断主体ではなく、世代に対応するハンドル台帳である。実行中に届いた追加入力と古い終了通知を混同しない。アイドル時コンパクションも同じRust実行枠を先に予約してから処理する。

明示的なライフサイクル修正:
- 停止中の処理が回収される前に「再開」した場合、回収後に1回だけ続行する
- メイン会話のStop後に受信可能へ戻す操作はrearmと区別し、取り消したターンを勝手に再実行しない
- サービス終了では承認を取り消してから実行結果を回収し、保存先を閉じる前に中断結果を残す。再起動対象を一律stoppedへ変えない
- 同期通知リスナー内の停止、遅い完了判定、遅い子エージェント生成、古いタイマー/終了通知も世代に照合する

検証（2026-10-07）:
- Rust単体88/88、rustfmtチェック合格
- 専用ライフサイクル統合33/33と実行統合10/10
- Node22.16/24の全体回帰はともに464/469。失敗5件は同じLinux環境のブラウザー3・DNS1・bubblewrap1
- Pythonワーカー13/13、ルート5/5、ローカル能力連携5/5、構文189モジュール
- Node22.16の最終整形済みソースでqualityの指紋は前後一致（7f5db8309e7e）。ゲートはNodeの上記5件で止まるため、全ゲート合格とはしない
- 第3段階前半9f96f81のCIはUbuntu全ゲート合格。Windows/macOSはRustビルド・72単体合格後にNodeで停止し、配布物はまだ未検証

HTTPホストの移行ではRustが唯一の待受け・Cookie/CSRF/Host/Origin検証・SSE・状態所有者になる。残るJS組み込み機能は明示的な互換境界を経由して段階的に移す。HTTP待受けだけRustにしてもNodeが不要になったとはしない。通常動作でNodeが不要になるのは、必要な組み込み通信・ツール・周辺機能を移し終えた後である。

## 第4段階 — 独立したRust HTTPホスト（開発用ローカル作業領域）

新しい native-service はRust単独のHTTPプロセスであり、Nodeサーバーへの転送ではない。待受け、Cookie/CSRF/Host/Origin検証、本文上限、静的ファイルの許可リスト/CSP、SQLiteの単一所有、SSEの再接続と書き込み制限を持つ。明示的な --dev-native が必要で、通常のアプリ起動先はまだ変更しない。

この起動方法では履歴・記憶・成果物・改版・コンテキスト輸出入・画面用投影・SSEをNodeなしで扱える。会話実行、接続先通信、ツール、予定、音声、メディア、MCP/コンピューター操作等はまだ利用できず、既知の未移植APIは503を返す。機能を黙って削った通常版への切替ではない。

共有コアへ追加したもの:

- projection.rs: 会話/作業/承認の画面用投影、継続応答の結合、派生イベントの順序
- store_domain.rs: 記憶と成果物の検証、全文検索の字句生成、輸出入、IDの対応付け、権限を復活させない取り込み、原子的な書き込みとイベント
- 公開 compute_json: Nodeに依存しない文脈/トークン/投影の損失なしJSON API

開発ホストのサービス所有権は既存Node版と相互排他。開始時の生きた承認待ちは復元せずwithdrawnにし、既存記録を保持する。取り込んだ記憶は未確認/非共有、スキルやルーチンは無効、仕事は中断、会話バックアップは読み取り専用であり、実行・共有の許可を再生しない。

### 検証（2026-10-07）

- Rustコア100/100、HTTPサービス14/14、両クレートのrustfmt合格
- NodeなしのPATHで直接Rustバイナリーを起動するプロセス試験22/22。認証・重複ヘッダー・本文境界・UTF-16・静的パス・輸出入・改版競合・SSE・終了・データ所有権を実際に確認
- 投影比較10/10、作業領域比較12/12。字句インデックスは全Unicode符号位置の比較を含む
- Node22.16/24の全回帰はいずれも508/513。失敗は従来と同じLinux環境のブラウザー3件・DNS1件・bubblewrap1件
- Python13/13、ルート5/5、能力連携5/5、構文196モジュール
- 両品質ゲートの検証時指紋 a1fa6cdd1d1c は前後一致。Node失敗で止まるので全ゲート合格とはしない
- 前の公開da6a483はUbuntu CI全ゲート合格。Windows/macOSはRustビルド/88単体合格後、既存に観測されたNode失敗で停止。配布物組立/実機起動は未検証

この時点では会話と実作業のプロバイダー通信/効果処理が次の段階だった。以下の第6段階でその限定したネイティブ経路を接続したが、通常版の全機能がNode不要になるまで全面移行完了とはしない。[起動方法と対応範囲](../native-service/README.md)。


## 第6段階 — ネイティブ会話・作業ホスト（明示的なopt-in）

`--dev-native --agent` を追加し、Rust HTTP → 既存Rustランタイム/実行状態機械 → 実際のプロバイダー通信 → 対応ツール → 永続履歴/親への報告までを接続した。Nodeサーバーへの転送や固定応答で代用したものではない。`--dev-native` 単独は従来のローカル作業領域モードを維持し、通常の `npm start` とTauriはNode互換サービスを使い続ける。

### 実装した境界

- `native-service/src/agent/coordinator.rs`: 1本のFIFO actorで両状態機械のコマンドを実行。service/session/run epoch/step generation/operation IDを照合し、古い完了やタイマーから新しい実行を変更しない
- `agent/host.rs` と `host_runtime.rs`: 受付、メイン/ワーカー、入力配送、進捗/完了報告、停止/再開、プロンプト、使用量、ストリームと効果処理の実接続。判断を別の手書きループへ複製しない
- `provider.rs` と `network.rs`: 保存済み接続先、許可/DNS/TLS、SSE/NDJSON/UTF-8、同時使用枠、制限検出、再試行、キャンセル。Chat Completions・Responses・Anthropic・Geminiと、検出されたOllamaネイティブAPIに対応
- `native-core/src/harness/`: 結果整形、軽量スキーマ確認/引数JSON修復、システム/NOTICE/人格、ledger/章/識別子、コンパクション計画、reflect/自己点検を純粋関数として移植。UTF-16、キー順、丸めとUnicode16/17を維持
- `agent/context.rs`: 実モデルへの文脈内要約、rolling要約、既存の決定的フォールバック。中断時はチェックポイントを提案/保存せず、成功時だけactorが保存とプロンプト更新を行う
- `agent/metacognition.rs`: 実際のエスカレーション/解除、繰り返し/失敗の通知、重複を抑えた親への停滞報告の後に、最新セッションを測定して自己点検を保存
- `agent/approvals.rs`・`policy.rs`: 承認済み引数の不変スナップショット、先勝ちポリシー、ECMAScript互換UTF-16正規表現、actorによる決定/撤回。遅い決定・改変された記録・停止済み操作は実行できない
- `agent/files.rs`・`tools.rs`・`receipts.rs`: 本物のファイル/状態ツールと順序付き結果。未実行と実行済み中断を区別し、完全な証拠、切り詰め参照、読み取り参照、統計を保存
- `WorkspaceAccess` と `workspace/agent_state.rs`: SQLite接続を増やさず、型付きのホスト境界と限定されたドメイン操作を使う。保存バッチの後に派生/元イベントを発行し、I/Oや承認待ち中にDBロックを持たない

ネイティブの17ツールは `sessions_spawn`、`sessions_send`、`sessions_list`、`sessions_history`、`sessions_stop`、`read`、`write`、`edit`、`todo`、`reflect`、`artifact`、`recall`、`history_search`、`memory_search`、`memory_write`、`tools_search`、`tools_call`。既存main/worker/leanの順序を維持し、実装済みのものだけを提示する。検索は既存の字句フォールバックを使い、`tools_call` がMCPを暗黙に有効化することはない。

Stopは実行中のツールの結果を回収し、モデル順のreceiptを残す。再開は旧実行枠の解放後に行い、サービス終了はreceipt保存と接続先終了の後にSQLite所有権を解放する。再起動時の未完了ツールは結果不明として記録し、書き込みを自動再実行しない。

### 残る制約と権限

プロセス/任意コード、Web、find/grep、MCP、画像入力/視覚ブリッジ、音声/メディア、PC操作、能力サービス、スキル実行、予定/heartbeat/dream最適化、JSプラグインと一部のセットアップ/アバター/写真等は未移植。既存の保存データを削除して見かけ上対応済みにはしない。`capabilities` のdecisionルート、グローバル `.mjs` プラグイン、enabled heartbeatまたは保存済みschedule文書がある作業領域はnative-agentの開始前に診断する。停止済み/再開セッションも、キャッシュに未対応ツールがあればモデル利用前に明示的に拒否する。

sandboxは現行アプリと同じ既定のoffを保つ。非off時は既存の書き込み範囲と鮮度確認を適用するが、ファイルロックは字句的な解決パス単位であり、シンボリックリンク/ハードリンクの別名による競合を防ぎきらない。最終シンボリックリンクと範囲外の正規化親は拒否するが、同時の祖先ディレクトリー改名まで完全に防ぐ隔離とは主張しない。

### 第6段階の検証記録（2026-10-07、Linux）

- 純粋Rustコア107/107、固定JSとのharness/metacognition比較17/17合格
- サービス153/153、CLI2/2合格のチェックポイント。サービス内の実ホスト試験9件は、ストリーム/費用/再起動、NO_REPLY、親→子→ファイル/成果物→報告、Stop/rearm、承認/撤回、終了時receipt回収/SQLite所有権、native起動前の権限/対応範囲診断を確認
- 実ホスト試験は既存のreducers、HTTPプロバイダー経路、SQLiteとファイルを使い、制御されたローカル応答のみで実行。実モデル・有料API・外部サービスへの通信は行っていない
- 上記ゲートはnative hostとreceiptのUnicode17統一を含む。新しい `--agent` 実TCPプロセス試験8/8と既存workspaceプロセス試験22/22も別々に合格。Rust子プロセスのPATHを空にし、隔離データで認証/接続設定、SSE/入力重複排除、ワーカーの実ファイル/成果物/親報告、承認/撤回/遅い決定409、Stop/rearm/再起動を確認。4本の専用スレッドで制限したprobeの実行中/待機中キャンセル、HTTP/sidecar Stop、終了時の所有権解放、キャンセル済みprobeの遅延実行/再起動後再送の抑止、新規probe/推論の継続、tray Stopで常駐mainの通信と完了済みワーカーを維持することも確認
- Windows/macOSの配布/実機、通常Tauri切替、実モデル品質、未移植効果、品質ゲート全体の合格をこの結果からは主張しない

ルートからの主な検証コマンド:

```sh
npm run build:core
npm run build:native
npm run test:rust
npm run test:native
node --test --test-concurrency=1 Tepora-v3/tests/rust-harness.test.mjs Tepora-v3/tests/rust-harness-metacog.test.mjs Tepora-v3/tests/rust-http.test.mjs
node --test --test-concurrency=1 Tepora-v3/tests/rust-native-agent.test.mjs
```

NodeはGUI bundleとテストのビルド時に使う。ビルド済みRustバイナリーの実行時Node依存がないことと、アプリ全体の移行が完了したことは別である。

## 第7段階: プロセス・能力設定・SSEの実接続

`exec`/`process`を実際のRustプロセスマネージャーに接続し、対応ツールは19個になった。既存のsandbox選択、正確な承認、出力制限、poll/log/input/kill、親への報告、Stopと結果回収を維持する。Resumeは以前のプロセス停止が完了してからモデル要求を始める。逃げた子孫がパイプを保持した場合は不確実な終了として明示し、成功したと扱わない。

能力設定のGET/PUT/keyは単一所有者とrevision確認を使い、明示キーはメモリー内だけに保持する。SSE再接続と保持範囲外のsnapshotは実行中の接続状態・資源待ち・キー有無を失わず、イベント順を保つ。decisionルートの新規設定と起動は、その実行ホストを接続するまで拒否する。

添付ファイルの保存/削除、セッション受け入れ、ファイル一覧/ダウンロードも実装。ダウンロードはsymlink解決後の範囲を確認する。添付のモデルへの配送は未接続であり、保存だけで対応済みとはしない。Web・判断・埋め込みの型付き部品は試験済みだが、このチェックポイントのエージェントからはまだ使わない。Node互換起動とGUIは継続し、全面移行の完了ではない。

See [complete route inventory and release gates](RUST-ROUTE-PARITY.md).

## 第8段階: 人格・設定・表示状態

人格と口調のGET/PUT、アプリ設定のPATCH、display/avatar設定の取得・変更・undo/reset・import/exportを独立Rustホストへ接続した。既存フィールドの検証、期待revision、履歴、保存先の単一所有、イベントを維持する。人格変更は実行中actorへプロンプト更新を通知し、既存のキャッシュ済みprefixを置換しない。人格テキストから権限やネットワーク許可は作らない。

表示の日付互換実装は固定したV8 DateParser由来であり、出典とBSDライセンスをソース・配布物に保持する。noticeが欠落・空の場合はビルドを失敗させる。カスタムアバター素材のアップロード／ファイル配信、写真立て、音声・メディアは別の未移植ルートとして残る。GUI、通常のNode/Tauri起動、保存済みdecisionルートの拒否は変更していない。

検証は固定JavaScriptとの人格236例・表示235例・日付214例のバイト一致、実Workspace/HTTPのrevision競合・undo・権限境界、実actorの人格更新と再起動保存を含む。現時点のLinuxローカル試験は下記の最終ゲートに記録する。実モデル・有料API・Windows/macOS配布成功は別の検証であり、この移植だけでは主張しない。

3b4d243の修正はリモートbranch/treeへ反映済みだが、そのSHAのCI実行は確認できなかった。PR head参照が前の7ffb996のままだったため、既存2ワークフローへ移行ブランチ限定のpush検証を追加した。同じブランチのPRイベントはmatrixを重複実行せず、その他のPR・main・V3ブランチ・手動実行を維持する。権限はcontents:readのまま。CI合格は新しい実行のhead SHAを照合してから判定する。

### 第8段階のLinux最終ゲート（2026-10-07）

- Rustサービス320件＋CLI2件合格。並列実行で確認。プロセスfixtureはsetsid/TERM設定後に子自身がreadyを報告し、終了観測をPID同一性付きで待つ。該当3fixtureの並行反復120/120合格。元のfixtureを36回再実行した対照では再現せず、ランタイム変更は加えていない
- build-nativeのlicense検証7件＋offline HTTP24件＋native-agentプロセス9件、Node22/24でそれぞれ計40件合格
- 全Node回帰543/548。残る5件はブラウザー起動3、DNS1、Linux sandbox1。同じ試験を未変更の公開3b4d243で実行して同じ5件の失敗を再確認。品質ゲート全体は不合格のまま明示する
- 共有Rustコア、構文228モジュール、ルート7件、Python13件、ローカル能力fixture5件、100シナリオ参照、previewビルドは合格。シナリオ参照は実モデルの成功を意味しない
- Windows/macOS実行、native配布物、実モデル品質、ユーザー環境の移行は未確認。通常起動やmainへのmergeは行っていない

## 第9段階: Web検索・取得

`web_search`/`web_fetch`を実行ホストへ接続し、対応ツールを21個にした。既存の検索設定と選択したBraveキーを単一Workspaceのスナップショットとして読み、正確な承認・tools_callの別名・receipt・Stop・キャッシュを維持する。キー／設定変更は古い通信と結果を失効させる。DNS待ちやTCP/TLS待ちの後、実際の要求送信前にも信頼された設定状態を確認する。ブラウザー描画と未接続のdecisionルートは引き続き利用不可であり、暗黙のNode fallbackをしない。

Linux検証:共有コア107、native337＋CLI2、Node22/24の実native-agent HTTP10件、Python13、能力fixture5、ルート7、シナリオ参照100、preview合格。HTML40・entity3・DuckDuckGo8・decode38・pagination6・focus8とcharset27テーブルは固定JSから再生成して一致。全Node回帰544/549で、残る5件は既知のブラウザー/DNS/sandbox環境失敗。品質ゲート全体の合格、実検索プロバイダー品質、配布物成功は主張しない。

### macOS PTY EOF修正

3964160の実CIではLinux回帰は合格、WindowsのRustゲートは合格した一方、macOSはTTY出力後の終了待ちで315/316となった。Python3.9のptyループがBSD/macOSのゼロbyte EOFでmasterを外した後、対話用に開いたstdinを待ち続けることが原因。master_readでEOFを既存のEIO終了経路へ正規化し、stdinの早期closeや出力からの終了推測は行わない。プロセス所有権・waitid・子孫回収は変更しない。

独立した旧Python/BSD挙動の再現fixtureによりLinuxでも修正前の同じ停止待ち失敗と修正後の終了を確認した。非0終了コード、対話入力、末尾32KiB出力の完全回収も検証。最終Linux再実行はnative322＋CLI2、build-notice/offline HTTP/native-agent計40件合格。新しいmacOS CIが成功するまでは実macOSで修正済みとはしない。Windows/macOSの既存Node失敗と、未到達の配布物／インストール検証は引き続き別のゲートである。

## 第10段階: 初回接続・モデルカタログ

第9段階のWeb実装に、setup移植97fcc4e相当と検証済みPTY EOF修正を統合したチェックポイント。直前のhead22941beは実macOSのnative318＋CLI2、Windows native Rust、Linux全回帰を通過した。後続の既存Node失敗と未到達の配布ゲートは別に記録する。本チェックポイントの新head CI、配布物到達、通常起動切替はまだ主張しない。

`--dev-native --agent`でsetup 7ルート、model-catalog 3ルート、runtime/discover 1ルートを接続した。GETや起動は通信・ダウンロードを開始しない。scanは固定loopbackの候補を期限付きで取得し、selectは`consentTest: true`、稼働中の仕事なし、既存の名前付き接続なしを要求する。安全なtool roundtripとOllama digest確認後、actor上で設定識別子・registry revision・キャンセルを再検証し、単一SQLite所有者で設定・接続・probe receipt・イベントを原子的に保存する。失敗時には全体をrollbackする。モデル品質や画像・判断能力の受け入れ証明ではない。

installはbody読込前にもonlineを検証し、`consentDownload: true`、新鮮なローカルengineと固定catalog選択だけを許可する。Ollama pullの進捗・容量・idle/全体timeout・Stop・通信制限・shutdownを管理する。中断後は自動再開せず、明示的な再試行でOllamaの部分データを利用する。ランタイムpackageの自動導入や取得モデルの自動選択はしない。install-helpは明示要求で公式Ollamaページを開くだけ。catalog import/searchは未検証メタデータ、refreshは固定models.dev URLへの24 MiB制限付きのchecked web通信であり、権限は生まれない。既存のsandbox・auth/CSRF/Host/Originとdecisionルート拒否を維持する。

setup側のPTY修正込みゲートはnative library364＋CLI2、Node HTTP24、catalog fixture18、race fixture20/20合格。ローカルのscripted serverを使用し、実モデルやpackageは導入していない。前段の全Node544/549と同じブラウザー3・DNS1・bubblewrap1の環境失敗は未解消であり、統合候補の全品質ゲート合格へ読み替えない。ルート実数は126のうち実装60・部分13・未実装53、別枠static22。完成率ではない。

このsetup段階ではsemantic、添付モデル配送、セッション削除、find/grep、scheduler/heartbeat、MCP、media/speech、PC操作、JS plugins、独自avatar素材・写真は未移植。通常のNodeサービス、JavaScript/CSS GUI、Tauri起動は維持する。詳細なガードは[native host](../native-service/README.md)、全ルートは[route parity](RUST-ROUTE-PARITY.md)を参照。

統合した最終Linuxゲートはnative364＋CLI2、build-notice/offline HTTP/native-agent計41件がNode22/24それぞれ合格。全Node22は544/549、ソース指紋は前後一致。残る5件は同じ既知のブラウザー3・DNS1・bubblewrap1であり、品質ゲート全体は不合格。実macOSでのPTY修正は22941beの318＋CLI2で確認済みだが、新しいWeb/setupのOS間受け入れ証明へ読み替えない。


## 意味検索・索引のローカル検証記録（公開前のチェックポイント）

`POST /api/semantic/index` と `POST /api/semantic/search` を `--dev-native --agent` に接続した。単一Workspace/SQLite所有者のvector cacheを使い、確認済み記憶の字句・意味順位を組み合わせる。索引は最大24文書、各12,000 UTF-16単位。HTTPは既存auth/CSRF/Host/Originとnetwork policyを維持し、非同期待機・要求破棄時の取消・index 90秒/search 30秒の期限を持つ。

外部索引はHTTPの厳密な `consent: true` とshared/confirmed文書だけに限定する。送信直前とcache保存時に文書の本文・共有範囲・確認状態と能力identityを再検証する。記憶変更は応答前に対象処理を失効させるが、送信済みのバイトは回収できない。検索結果も最新文書で再確認し、埋め込みが使えない場合は字句検索へ戻る。

`memory_search` のモデル引数は外部送信への同意にならない。`memory_write` の成功後にboundedなbest-effort索引をまとめて予約し、write receiptは索引の成功・完了と独立する。通常のrun解放では索引を取消さない。Stopは当該sessionの所有権だけを外し、ほかのsession/unscoped所有者が残る共有jobと他sessionのforeground検索は継続する。最後の所有者が停止したjobは取消し、Closeは全semantic処理を取消・drainしてからSQLiteを閉じる。

ローカル検証はnative388＋CLI2、focused HTTP/native-agent/root計41件合格。固定JS由来search84・cosine10・hash7ケースはbyte-identical。全Nodeは544/549で、同じブラウザー3・DNS1・bubblewrap1の環境失敗を維持し、ローカル品質ゲート全体は不合格。公開済みWeb/setup `eba5bd4` は実macOS/Windows nativeとLinux全回帰が合格、後続platform Nodeはこの記録時点で実行中。このsemantic候補は未公開・exact-head CI未実施であり、前段CIを流用した合格主張はしない。実モデル・配布・導入の受け入れは未確認。

HTTP実装差分とinventoryを照合したルート実数は126のうち実装62・部分13・未実装51（handlerあり75）、別枠static22。完成率ではない。decisionルート拒否、添付モデル配送・session削除・find/grep・scheduler/heartbeat・MCP・media/speech・PC操作・JS plugins・独自avatar素材/写真の未移植範囲は維持し、通常Node/JavaScript/CSS/Tauri起動は変更しない。

意味検索チェックポイントの最終追加確認: build-notice/HTTP/native-agent/ルートを合わせた48件がNode22/24それぞれ合格。前段eba5bd4は実macOS360＋CLI2・Windows328＋CLI2とLinux全回帰が合格し、その後は既知のプラットフォームNode失敗で配布工程が未実行となった。この結果を新しい意味検索headのCIへ読み替えない。

## 既存プラットフォーム検証の修復

Rust移行前からCIを止めていた検証障害を、移行回帰と分けて修正した。vendorはGitの改行変換を止めて固定14ハッシュを維持し、Windowsのfile URLはfileURLToPathで解決する。再起動を含む全テストサービスを終了してから共有データを削除し、SQLiteロックと残留HTTPサーバーを防ぐ。Seatbelt本来の検証は維持し、独立したcontainer計画はDocker未導入時の既存409を検証する。一般的なcmd.exe引用符処理は変更していない。日本語ストリーミングfixtureはstdinで確実にコードを渡し、出力と終了状態を確認する。

名前付き作業ルートの検証はNodeとRustの双方を現在のOSのパス文法へ揃えた。実在するディレクトリーだけを使い、URL/版数/報告だけの裸ファイル名、失敗したtool証拠、最大8件の規則を保持する。Windows/UNCの文法テストはLinux上の純粋文字列試験であり、共有先を探査しない。実Windowsでの動作はこのチェックポイントのCIで確認する。

ローカル検証: Node22/24で影響範囲85件と厳格container計画1件がそれぞれ合格、skipなし。新しいautocrlf=true checkoutでもvendor14ハッシュは元の値と一致。native391＋CLI2、Node claims/runtime/native-agent50件合格。Nativeコアは変更せず、completion待ち8秒と判定assertionを維持し、失敗時診断を追加した。包括agent-toolsのDNS/bubblewrap環境失敗、一般的cmd引用符、間欠的completion遅延、配布物の実行はこれだけで解消・確認済みとはしない。

## 第11〜12段階: 意味検索とライフサイクル候補（beta.11）

以下は現在の対応範囲であり、前段の未対応一覧とdecisionルート拒否の記録は各チェックポイント時点のもの。通常のNode/Tauri起動、GUI、sandbox設定は変更していない。

Native semantic index/search and `memory_search` now share `Capabilities`, `NativeNetwork` and the one SQLite owner. Confirmed-memory consent, scope, content and capability identity are rechecked before egress and cache publication; external embedding requires explicit permission and shared scope. Vectors are disposable caches, and lexical fallback remains available. This does not connect media/speech or other capability consumers.

Typed decision requests now use `CapabilityDecisionBackend` with the existing shared capability registry, memory-only keys, network owner and resource gate. Actor-owned delegation and completion consume advisory answers only after scope and binding checks. Buffered answers recheck registry revision, endpoint identity, an opaque owner-wide key generation and close state before consumption. Any capability-key set/clear conservatively invalidates buffered advice; original active-transport behavior is preserved. No keys or credential hashes enter advisory bindings or public events. Advice never grants tool authority.

Attachment input resolves up to six staged IDs on the server, verifies hashes and byte limits, then materializes collision-safe files under the configured work root outside the FIFO actor. Pending requests with the same request ID share preparation; only successful actor acceptance caches the receipt. Stop/shutdown cancel admission but still join dispatched filesystem work. A partial write may remain on disk without an accepted-input receipt. Files are saved locally and the input retains their text/path receipts; up to the first four images enter supported vision context. Non-vision chat omits image bytes while retaining the local receipt and never starts a vision bridge. Oversized images use the bounded macOS resize path; if resizing is unavailable or fails, the local file remains but the image is omitted. Image loading through `read` and unsupported vision bridges remain unavailable.

Session deletion rejects the resident main session (403), missing sessions (404), and active or still-draining work (409). For an idle worker, a correlated admission cancels its timer, blocks new send/resume/wake activity and waits for owned process cleanup before the actor rechecks and commits removal. Cancellation or uncertain cleanup cannot become successful deletion; failed deletion retains the session and prior receipts. Successful removal concerns session state and in-memory host caches, not unrelated user files or recursive removal of the working folder.

The unpublished lifecycle candidate with the native claimed-root correction passed 427 native library + 2 CLI tests and 36 HTTP tests on Node22 against pinned binary SHA-256 `4fec77166ea8322c1b166f093cfb9e30a850be4e2032b12d4d33d00b74f1574a`; Node24 passed 38/38 against the same binary (the 36 HTTP/native-agent tests plus 2 root entry-point tests). These reruns supersede the earlier 424+2 Rust / 12 native-agent HTTP review gate and the pre-guard 36 HTTP result. Published platform-repair head `0b9d548` has CI running; no terminal result is claimed for it. Previous published semantic head `d2d18f2` passed Rust on all supported CI operating systems and the full Linux gate; downstream baseline Node failures and skipped packaging remain separate. No lifecycle publication, lifecycle CI, desktop packaging/installation or real-model acceptance is claimed.

現在のルート一覧は126 application variantsのうち実装64・部分12・未実装50、別枠static22。完成率ではない。scheduler/heartbeat/dream、JS plugins、MCP、media/speech、PC操作、find/grep、skills実行、ブラウザー描画、未対応の視覚ブリッジと独自avatar素材/写真は残る。[HTTP一覧](RUST-ROUTE-PARITY.md)と[native host](../native-service/README.md)を参照。


### ライフサイクル統合候補の追加ローカル検証

Node22の全回帰は552/557、skipなし。残る5件は既知のクラウド環境由来のブラウザー3件、DNS `EAI_AGAIN` 1件、bubblewrap制限1件であり、全体の品質ゲートは不合格のまま。native427＋CLI2、固定binaryでのNode22 HTTP/native-agent36件とNode24 HTTP/native-agent＋root38件の合格は上記の範囲に限る。構文確認は231 JavaScript modulesを検査し、root entry-point/build-noticeゲートは14/14、skipなし。公開済み `0b9d548` のCIはこの記録時点で実行中であり、このローカル結果をOS間・配布・実モデルの受け入れへ読み替えない。

## 予定・チェックインとSQLite最適化（2026-10-08、Linux）

- 保存した予定の追加・一覧・取消、一度だけの通知、定期実行、ワーカー起動をRust actorへ接続。再起動直後の実行と二重配送防止を実HTTPで確認
- チェックインは意味のある変化のみを処理。実行中・入力待ち・変化なしではモデルを起こさず、型付き判断の待機は非同期で保持
- タイマー通知を種類ごとに最大1件へ集約。設定変更は古い判断待ちを取消し、旧世代/別サービス/終了後の通知を破棄
- 日付の解釈を既存のV8由来パーサーへ統合。Dateの両端、年の表示と並び順、DSTの欠落/重複と30分移動を追加検証
- SQLiteの固定文書SELECTをprepare_cachedへ変更。独立ビルドの実コアA/Bで256 Bの読み込み中央値5.57→3.09µs、4 KiBで21.74→19.48µs。アプリ全体の高速化率は未測定

Current Linux checks: 63 selected ordinary native-service tests, 2 focused SQLite cache tests, 11 real HTTP/socket tests, and the original Node scheduler regression pass. The HTTP and source-scheduler gates pass on both Node 22.16.0 and 24.19.0; 9 targeted root workflow/conventional-commit checks pass on both, including dedicated LF/CRLF fixtures. The 11 HTTP tests include a real schedule tool receipt, restart delivery and second-restart deduplication. These are focused gates, not a full Rust/Node/quality pass; approval-policy and broader security suites were not rerun in this slice. Cross-platform CI and packaging for this new source are still pending. Earlier package results at 7743e8d do not certify this candidate. No real model, paid provider or desktop default cutover is claimed.

## 写真フレームの独立Rust化（2026-10-08、ローカル検証）

写真フレームの通常ルートR108〜R112をWorkspaceへ接続した。署名・寸法判定、24MiB/枚・300枚・合計2GiB・120M画素の上限、SHA-256重複抑制、元バイトのGET/HEAD、削除、順序、再起動、frame.updatedを維持する。HTTP認証・CSRF・Host/Originと単一SQLite所有はそのまま。写真専用mutexで操作を直列化し、ファイルI/O中はSQLiteロックを保持しない。終了受付後も受付済みのファイル/メタデータ更新を完了させ、最終DB終了はその処理を待つ。

生成したローカル画像バイトだけでRust 8件、Node 22.16.0/24.19.0それぞれHTTP 2件が通過した。56件の署名/エラーfixtureとPOSIX/Windowsファイル名fixtureは両Node版で一致。元画像の描画・デコード、個人写真、外部通信、実モデル、デスクトップ梱包は検証していない。approval-policyや広範なsecurity suiteはこの差分で実行しておらず、全体quality通過の主張ではない。

この差分のルート一覧は実装69・部分12・未実装45、別枠static22。通常のNode/Tauri起動、GUI、独自avatar素材や他の未移植機能は変更しない。[写真フレームの境界と検証](RUST-PHOTO-FRAME.md)を参照。

## Avatar素材ライブラリの独立Rust化（2026-10-08）

通常ルートR103〜R107を両方のRust開発モードへ接続。画像、VRM 0.x/1.0、画像セット、メッシュpackの検査と元バイト、上限、重複判定、メタデータ、GET/HEAD、削除、使用中素材のリセットと履歴、イベント、再起動を維持する。専用mutexでファイル操作を直列化し、SQLiteロックをI/Oへ持ち越さず、受付済みの更新を終了時に待つ。通常起動とGUIは変更しない。

一覧は実装74・部分12・未実装40、別枠static22。生成fixtureのみを対象とし、実際のユーザー素材・描画・外部モデル・配布の受け入れや全体quality通過は主張しない。[境界と検証](RUST-AVATAR-ASSETS.md)を参照。

この差分のLinux検証はavatar Rust19件＋写真回帰8件、Node22.16.0/24.19.0それぞれ実HTTP avatar5件＋写真2件が通過（skipなし）。コア/nativeビルド、235 JSモジュールの構文と一覧集計も確認。元バイトを借用しpack全体の追加コピーを避けるが、アプリ全体の速度測定ではない。非常に深いJSONは共有serdeパーサーの深さ制限によりNodeより先に形式エラーになる境界を残す。approval-policy/security suite、実素材の描画とOS間配布はこの局所検証に含めない。

## メディア生成ジョブ

R036–R042の7ルートを `--dev-native --agent` に接続した。TTS・画像・画像編集・非同期動画は既存の能力設定・接続先固定・通信制約を使う。生成ジョブ、進捗イベント、結果ファイルは同じWorkspace所有者で保持する。送信結果が不明な生成は自動再送しない。受付ID/ダウンロードURLの再開と、送信前と判明している待機ジョブの明示再開を維持する。停止・終了は所有する通信とタイマーを止めて回収してからSQLiteを閉じる。

合成バイトとローカル提供先によるRust単体テスト・Node互換ホストとの実HTTP比較を追加した。実アカウント、有料生成、モデル品質、映像/音声デコーダー、GUI、クロスプラットフォームのパッケージ受入は検証していない。エージェントからのメディアツール、音声入力、ブラウザー描画、MCP等は別範囲。通常起動とTauriは変更しない。ルート集計は実装81・部分12・未実装33（計126）で、完成率ではない。詳細は [RUST-MEDIA-JOBS](RUST-MEDIA-JOBS.md)。

メディアのStop All／トレイ停止は、移植元の状態名だけの判定を意図的に改善し、実行中のダウンロード所有者もキャンセルする。再開待ちで実行者のないハンドルは保持し、遅着した結果によるreadyへの復帰と生成再送は行わない。16件の新規作成判定は移植元と同じ状態集合であり、awaiting-downloadと明示再開を含む全ハンドル数の上限ではない。

## Ordinary streaming speech native owner

The explicit native agent host owns streaming speech R074–R077 through an ephemeral lifecycle owner and the existing checked network transport. Stop/close invalidate and drain pending worker operations; no audio/transcript enters durable state. The effect-free native mode, normal Node/Tauri defaults, non-streaming ASR and dictation boundaries are unchanged. [Contract and verification](RUST-SPEECH-STREAM.md).
