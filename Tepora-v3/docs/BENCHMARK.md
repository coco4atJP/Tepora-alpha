# beta.11 実モデル基本動作ベンチマーク

目的は、実サービスの基本操作を繰り返し、モデルの自己申告と実際の結果を照合することです。「全機能に不具合がない」という保証ではありません。

## 対象と判定

主モデルは OpenCode Go の `deepseek-v4.1-flash`、`minimax-m3.1-flash-free`、`step-5-preview`、`mimo-v2.6-flash`、`muse-spark-1.3-contributor`。Teporaの公開認証APIで一時キーをpi-aiへ登録し、モデル一覧を明示更新して `engine: pi-ai` / `piProvider: opencode-go` / `authMode: pi-key` のプロフィールを保存します。MuseはResponses API、他の4モデルはChat Completionsを実際のSDK Workerとネットワーク検査で通します。HTTP transportはOpenCodeの認証を補わず、SDKから来たキー・会話ヘッダー・クライアント名を照合します。Museの入出力が学習に利用されるContributor枠でも、送信内容はこの試験の合成データに限定します。

Computer Useでは主モデルが目標と入力を渡し、TypeSafeの `jev-latest` が実Chrome上の操作候補を選びます。Jevを採点用モデルとしては使いません。Jevによる完了判定の補助呼び出しは、Computer Useの操作決定と別に集計します。chat modelへの操作フォールバックをJev成功とは数えません。

| 分類 | 内容 |
|---|---|
| 既存ワークフロー11項目 | 日本語JSON、否定の保持、実artifact、2ファイル、読戻しと計算、未確認表現、改訂、引用の保持、既存ファイル編集、スクリプト実行、長いログの抽出 |
| 製品動作9項目 | 2往復会話、添付読取りと4重再送、担当への委任、承認と拒否、停止と再開、記憶検索と更新、再起動後の保存、共有表示と390px画面 |
| Computer Use 2項目 | 氏名・選択・確認・送信を含むフォーム、送信機能のないフォーム |

ファイルの内容、バージョン、実ツール履歴、フォームサーバーが独立して記録した受信データ、DOMを検査します。成功・失敗・接続などによるブロック・未実行を分けます。中央値とp95は成功ケースの所要時間であり、選択したモデルの同時実行による競合を含むため速度ランキングには使いません。2回の反復は統計的な信頼性保証には不足します。

委任では、担当フォルダーと、主モデルが担当へ指定した親フォルダーの両方を認めます。ただし担当自身の成功したwrite/read履歴、主モデルが代行していないこと、私有試験データ内の実ファイルと内容一致を必須にします。保存先だけの前提で委任成功を誤って不合格にしません。

## 実行

```sh
npm run build:core
npm --prefix Tepora-v3 run bench:list

# 私有ファイルには {"opencode":"…","typesafe":"…"} を設定する。
# chmod 600 /private/path/keys.json
TEPORA_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
npm --prefix Tepora-v3 run bench:product -- \
  --run --allow-cloud --key-file /private/path/keys.json \
  --repeat 2 --timeout 120 --max-usd 3 --out validation/live-benchmark
```

`OPENCODE_API_KEY` / `TYPESAFE_API_KEY` でも指定できます。キーをコマンドライン引数やソースに直接記入しないでください。`--models`、`--cases` はカンマ区切りで限定できます。ブラウザーがなければUI項目はブロックとなります。実行しない `--list` と引数検証、通常の `npm test` / `quality:full` は実APIを呼びません。

予算はモデルごとに等分し、保守的な入力・最大出力の事前予約で送信を制限します。受信した使用量が既知なら差額を解放し、未知なら予約を保持します。最大1,000送信/モデルです。価格・キャッシュ・プロバイダー課金の差があるため、請求額の厳密な上限や請求証明ではありません。Goの追加利用設定は変更しません。接続・予算制約は承認や添付の待機でも早期にブロックと判定し、期限切れの試験で変えた権限は別のクリーンアップ期限で元へ戻します。

登録だけを調査する場合:

```sh
node Tepora-v3/scripts/benchmark-connection.mjs --run --allow-cloud \
  --key-file /private/path/keys.json \
  --models mimo-v2.6-flash,muse-spark-1.3-contributor \
  --out /private/path/connection-audit
```

応答の `x-opencode-log-id` と時刻、URL、モデルID、キー一致を保存します。OpenCode ConsoleのLogs画面に表示されたことは別途照合が必要です。

## データと限界

既存ユーザーDB・設定・OAuth認証には触れず、各モデルの私有一時ディレクトリーで実行します。同じモデル内の反復は通常の永続状態を共有し、学習とheartbeatは停止します。送るのは合成データだけです。execは計算スクリプトの項目のみ許可し、Web取得/検索、ユーザーのネイティブデスクトップ操作は許可しません。Computer Useの送信先は専用のローカルフォームです。終了後に一時資格情報とDBを削除します。レポートはキーを除去しますが、合成会話・作業の証拠を含みます。

実ASR・マイク・TTS・音声出力・画像/動画生成・embedding品質・実MCP/CLI・OAuthアカウント・ネイティブWebView/デスクトップComputer Use・長時間運用はこの22項目には含みません。ネイティブ画面や署名の検証は別のQA証拠を参照してください。失敗またはブロックがあれば全体合格にせず、必要なAPIや環境がない機能を合格に置き換えません。

接続仕様: [OpenCode Go](https://opencode.ai/v2/docs/console/go/)、[Pi設定](https://opencode.ai/v2/docs/console/harnesses/pi/)、[TypeSafe System One](https://docs.typesafe.ai/api/system-one)。
