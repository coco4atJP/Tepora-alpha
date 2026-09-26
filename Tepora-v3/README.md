# Tepora V3.0 Beta — Companion Workspace

**話す。任せる。かたちになる。**

Tepora-alpha の `main`（基点 `046643d27b1ec4de44815423031979e7ce7aa3b8`）を残したまま追加する、独立した V3 開発ベータです。紅茶・喫茶店の色、余白、local-first という方向は引き継ぎ、コンパニオン／仕事／成果物を同じ画面に置きます。

**この成果物は、実行できるUIと非同期サービスのソースです。モデルまで同梱した、署名済みの完成インストーラーではありません。** Tauri 2ホストを含み、GitHub ActionsでWindows NSIS／macOS DMGのビルドと成果物アップロードを確認しました。利用者PCでのインストール・起動、実GPU、実音声モデルは未検証です。詳細は [受け入れ状況](docs/STATUS.md) と [検証記録](docs/QA.md) を参照してください。

## まず触る

### 画面だけを、登録なしで

配布された `tepora-v3-preview.html` をブラウザで開きます。完全に単独で動くHTMLです。ホーム、記憶、接続設定、集中タイマー、静かな表示、3段階で更新されるサンプル成果物を試せます。

画面プレビューは明示的に区別しています。**モデル推論、PC操作、外部メディア・天気・ニュース取得は実行しません。** プレビューの記憶・設定は、許可されるブラウザではlocalStorageに保存します。APIキーは保存しません。

再生成:

```sh
node scripts/build-preview.mjs
```

### 実際のローカルサービスを起動する

Node.js **22.16以上** が必要です。通常のサービス起動に `npm install` は不要です。

Windows: `start.cmd` をダブルクリック。macOS: `start.command` を開くか、下記を実行します。

```sh
cd Tepora-v3
node core/server.mjs --open
```

起動時の認証付きURLからブラウザが開きます。初回セットアップで、起動済みのモデルを自動検出するか、自分のAPIエンドポイントを入力します。自動検出はlocalhostの既定4ポートだけを対象にします。

| ランタイム | 標準の接続先 | 注意点 |
|---|---|---|
| llama.cpp | `http://127.0.0.1:8080/v1` | `llama-server` とGGUFは別途必要 |
| vLLM | `http://127.0.0.1:8000/v1` | WindowsはWSL／別ホスト。ネイティブ対応とは扱いません |
| Ollama | `http://127.0.0.1:11434/v1` | OpenAI互換API経由 |
| LM Studio | `http://127.0.0.1:1234/v1` | ローカルサーバーを有効化 |
| 任意の互換API | ユーザーが指定 | リモートはHTTPS＋明示的なクラウド許可が必要 |

作業モードには **tool calling対応モデル** が必要です。サーバー側にも対応する起動オプションが必要です。[ランタイム起動の注意点](docs/RUNTIME-LAUNCH.md) を確認してください。会話モードにはツールを渡しません。非対応のAPIを密かにテキストコマンドへ置き換える実装にはしていません。使えるモデルの品質・速度は、このアプリそのものとは別に評価してください。

APIキーは起動中のメモリにだけ保持するか、環境変数名を指定します。キーそのものをSQLiteやブラウザのlocalStorageへ保存しません。特定プロバイダーのアカウント契約、ゲートウェイ、サブスクリプションは必須ではありません。

## 今回動くこと

- 相棒のホーム、作業スペース、記憶、接続画面。全画面表示、非ロック型のアンビエント表示、軽量CSSコンパニオン2種、レスポンシブ表示。
- **作業レーンと会話レーンの分離**。既定で作業2件＋会話1件。待ち行列、停止、途中の追加指示、明示的な操作承認、SSE更新。
- OpenAI互換のモデル通信、分割ストリーム、tool calling。llama.cpp／vLLMプロセスの起動要求。意図しないクラウドへのフォールバックはしません。
- ワークスペース内ファイルの読み書き、承認後の実CLI実行、出力表示、プロセス停止。**ホスト実行であり、OSサンドボックスではありません。**
- HTML・テキスト・Markdownソースの成果物と改版履歴。HTMLは独立した制限付きiframeで表示します。Markdownは現在テキスト表示です。
- SQLiteに保存する確認済み記憶、AIの記憶提案、個別のクラウド共有可否、編集・削除、JSON書き出し。インポートは記憶のみを「未確認・非共有」で受け入れます。
- ローカルstdio／Streamable HTTPのMCP接続。Context Hubはコピーせず、そのまま接続可能。実接続と各ツール実行に承認を求めます。
- スキルのMarkdown保存・選択読込・書き出し。実行バイナリの自動インストールは行いません。
- 押して録音→ローカルASRサーバーへWAV→文字を確認して送信、という音声入力。ブラウザのクラウド依存SpeechRecognitionは使いません。
- 明示的な天気／RSS接続、YouTubeの埋め込み用分離ページ、YouTube Musicを含む外部Brave起動。広告除去を保証する機能ではありません。

## 音声認識

モデル候補の根拠とトレードオフは [調査メモ](docs/RESEARCH.md) にあります。Qwen3-ASR-1.7Bを品質重視の候補、faster-whisperのturboを別の実行選択肢として接続します。自前の日本語WER測定は未実施です。

Python環境を分けて、使用するバックエンドだけをインストールします。

```sh
python -m venv .venv-asr
# Windows: .venv-asr\Scripts\activate
# macOS: source .venv-asr/bin/activate
python -m pip install -r speech/requirements-base.txt
python -m pip install qwen-asr
python speech/server.py --backend qwen --device cuda
```

CPUの代替:

```sh
python -m pip install faster-whisper
python speech/server.py --backend faster-whisper --model turbo --device cpu
```

設定のASR URLは `http://127.0.0.1:8012/v1/audio/transcriptions`。モデルIDは実際にロードしたモデルと一致させます（後者なら `turbo`）。このコマンドはライブラリが不足する重みを取得する可能性があります。認証を追加する場合は、TeporaとASRの両プロセスに同じ `TEPORA_ASR_KEY` 環境変数を渡してください。

ASRは別プロセスです。モデルのインストール・起動をネイティブ画面だけで完結させる機能、常時待受け、ウェイクワード、話者分離、読み上げ、発話途中の割り込みは未実装です。

## ローカルJev-like判断

vLLM PR #57250のDiffusionGemma構造化判断サーバーを接続対象にしています。**Jevのサービスそのものをローカルで動かす実装ではありません。** `/v1/systemone` はvLLMの標準APIではなく、付属の実験的ラッパーです。

上流の例に対応する起動形:

```sh
vllm serve google/diffusiongemma-26B-A4B-it \
  --diffusion-config '{"canvas_length":64}' --max-logprobs 32 \
  --enable-prefix-caching
python examples/features/structured_diffusion/structured_server.py \
  --upstream http://127.0.0.1:8000 \
  --tokenizer google/diffusiongemma-26B-A4B-it --canvas 64 --port 8011
```

Teporaの判断URLは `http://127.0.0.1:8011/v1/systemone`。このベータは要求の分類ヒントとして使い、失敗しても本体の会話・作業は継続します。判断モデルにCLI・ネットワーク等の権限を付与させません。重みとGPUメモリの要件、現在のvLLMリビジョンとの互換性は実機で確認してください。**8GB GPUでの動作保証はありません。**

## ネイティブ版のビルド（Windows／macOS）

Node 22.16以上、Rust、各OSのTauri開発要件が必要です。WindowsはC++ Build ToolsとWebView2、macOSはXcode Command Line Toolsが対象です。Linuxのネイティブ製品化は対象にしません。

```sh
npm install
npm run desktop:build
```

Nodeの実行ファイルを変更せずsidecarとして同梱し、core/webをリソースとして収録します。配布版はユーザーにNodeの別途インストールを要求しない構成です。TauriのJavaScript層にはshell／filesystemの権限を渡しません。**GitHub ActionsでWindows/macOSのビルド成功を確認しました。ただし、実機起動・署名・公証・クリーンインストールは未検証です。** 署名・公証用の認証情報は含めません。

`ci/v3-beta.yml` にWindows/macOS向けワークフロー例を置いています。実際のGitHub Actionsへの登録状態はPRを確認してください。ビルド依存は初回取得が必要で、lockfileの固定とネイティブ起動テストが配布前のゲートです。

## データと終了

ブラウザ起動版の保存先はWindowsでは `%LOCALAPPDATA%/Tepora/v3`、macOSでは `~/Library/Application Support/Tepora/v3`。Tauri版はアプリ識別子に対応する標準アプリデータディレクトリです。`TEPORA_DATA_DIR` で変更できます。元のV2のDBは書き換えません。

`workspace` にファイル、SQLiteにタスク・記憶・成果物・設定を保存します。再起動時に実行途中だったタスクは「中断」に変わります。**副作用の二重実行を避けるため、自動リプレイしません。** 中断前の成果物を確認して再依頼してください。

ローカルの同一ユーザーによる攻撃、承認済みCLIの悪意ある挙動、外部MCPツールの副作用を、アプリのHTTP認証だけで防げるとは扱いません。詳細: [アーキテクチャと脅威モデル](docs/ARCHITECTURE.md)。

## 検証

```sh
node scripts/check.mjs
node --test
python -m pytest -q speech/test_adapter.py
```

21件のNodeテストと2件のASRアダプターテストを実行済み。実モデルを使わない契約／制御系テストです。ブラウザのURLナビゲーションが管理ポリシーで制限された環境のため、画面は同一ソースの単独HTMLをChromiumのメモリ内に描画して操作し、実HTTP通信はNode側で別に検証しました。Windows WebView2／macOS WKWebViewでの結合検証の代替とはしていません。

Apache-2.0。基になるTeporaのライセンスを維持します。依存するランタイム・モデル・外部サービスの条件はそれぞれ別です。
