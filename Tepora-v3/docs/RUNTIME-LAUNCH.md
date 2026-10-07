# Tool-capable runtime launch — beta.11

beta.11の初期設定はprotectedです。アプリからホストの推論プロセスを起動する場合は、仕事と既知のホスト処理を停止し、明示的にlegacy-hostへ切り替える必要があります。既に稼働している推論APIへの接続はprotectedでも利用できます。

Teporaの作業モードは `tool_choice: auto` を使います。APIサーバーが起動しただけで、道具を呼べるようになったとは限りません。

## llama.cpp

アプリからインストール済み `llama-server` を起動する場合は `--jinja` を付けます。手動で起動したサーバーにも同じ設定と、モデルに適したチャットテンプレートが必要です。モデル自体の道具選択能力は別途確認してください。

## vLLM

vLLMをTeporaから起動するときは、モデルに合ったparserを明示してください。parserはモデルごとに異なるため、アプリは推測で決めません。`TEPORA_VLLM_TOOL_PARSER` 環境変数を指定してTeporaを起動すると、`--enable-auto-tool-choice --tool-call-parser <parser>` を付けます。未指定なら、その理由を画面に表示して起動を拒否します。

PowerShellでの例（Qwen3のHermes形式に対応するモデルを選んだ場合）:

```powershell
$env:TEPORA_VLLM_TOOL_PARSER = "hermes"
node core/server.mjs --open
```

GUIでparserを選ぶ画面はまだありません。より多くのオプションが必要な場合はWSL内等でvLLMを手動起動し、アプリの設定画面からURLを接続してください。例:

```sh
vllm serve Qwen/Qwen3-0.6B --host 127.0.0.1 --port 8000 \
  --enable-auto-tool-choice --tool-call-parser hermes
```

これは起動方法の例であり、この小型モデルが複雑なエージェント仕事に十分という推奨ではありません。モデルやvLLMの版により追加のチャットテンプレートや別parserが必要です。macOSのvLLMローカルGPU実行を保証するものでもありません。

## macOS microphone

TauriのInfo.plistにマイク利用の説明を追加しています。常時録音や自動許可は行いません。実機の許可画面、WKWebViewからの録音、ASRモデルへの送信はまだ結合検証していません。

## Primary sources (2026-09-26)

- https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md
- https://docs.vllm.ai/en/latest/features/tool_calling/
- https://vllm-project.github.io/guidellm/0.7.4/guides/tool_calling/
- https://v2.tauri.app/reference/config/#macconfig
- https://developer.apple.com/documentation/bundleresources/information-property-list/nsmicrophoneusagedescription
