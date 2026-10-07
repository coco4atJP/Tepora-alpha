# Tepora V3 beta.11 Web UI開発

V3のUIは `Tepora-v3/web/` のJavaScriptモジュールとCSSです。React・Vite・TypeScriptのV2開発サーバーは使用しません。

`npm run serve` でUIとAPIを同じloopbackサービスから提供します。表示された一時トークン付きURLから開いてください。`core/frontend.mjs` が固定順のモジュールをブラウザー向けスクリプトへまとめます。モジュールを追加する場合はそのバンドル契約も更新します。

`npm run preview:build` はモデル不要のHTMLを生成します。プレビューの操作成功をAI・MCP・PC操作の成功と扱いません。`npm test` のUI状態・下書き・音声・成果物・HTTP試験と、必要に応じた実ブラウザー確認を使います。

会話は継続セッションに固定し、仕事へのナビゲーションで入力先を変えません。遅い応答で新しい下書きや添付を消さず、共有表示と外部送信許可を分けて扱います。

protectedモードのHTML成果物はソースとして表示します。インタラクティブな成果物表示はlegacy-hostの機能です。プレビューHTMLの生成だけでは実機表示の検証にはなりません。

任意のブラウザー検証は `npm run quality:full` を使います。導入済みのPython PlaywrightとChromiumが必要で、`PYTHON`・`CHROMIUM_PATH` を指定できます。詳細は[QA](../../Tepora-v3/docs/QA.md)を参照してください。
