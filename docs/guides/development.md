# Tepora V3 beta.11 開発ガイド

現行コードは `Tepora-v3/` です。Node.js 22.16.0以上を使います。コア起動にnpm依存の導入は不要です。

```sh
npm start                 # ブラウザーを開く
npm run serve             # サービスのみ
npm run doctor            # 必須・任意の環境を確認
npm test                  # Nodeとルート起動の回帰試験
npm run quality           # 標準の全検証
npm run preview:build     # モデル不要のHTML
```

標準検証にはPython 3が必要です。Windowsでは `python`、その他では `python3` を使い、`PYTHON` で実行ファイルを指定できます。

ネイティブ開発はRust stableとOSのTauriビルド環境を用意してから実行します。

```sh
npm ci --prefix Tepora-v3 --ignore-scripts
npm run desktop
npm run build
```

`task dev`、`task serve`、`task dev-tauri`、`task quality`、`task build` も同じV3の処理です。旧V2のRustバックエンドやReact開発サーバーは標準タスクから起動しません。

`core/` はNode ESMとSQLite、`web/` はJavaScript/CSS、`workers/` は任意のPython連携、`desktop/` は薄いTauriホストです。API認証、接続先、操作承認、出典と改版の確認を維持してください。人格やモデルの判断を権限として扱いません。

CIはLinux・Windows・macOSで標準回帰を実行し、別ワークフローでWindows/macOSのネイティブパッケージを検証します。実モデル、課金API、Docker実行、音声やPC操作は標準ゲートの証拠に含めません。

詳細は[アーキテクチャ](../../Tepora-v3/docs/ARCHITECTURE.md)、[検証手順](../../Tepora-v3/docs/QA.md)、[改善ループ](../../Tepora-v3/docs/IMPROVEMENT-LOOP.md)を参照してください。
