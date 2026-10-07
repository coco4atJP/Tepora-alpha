# Tepora V3 beta.11 トラブルシューティング

| 状況 | 確認すること |
| --- | --- |
| 起動できない | `npm run doctor` でNode.js 22.16.0以上を確認する |
| 認証エラー | 起動時に表示した一時トークン付きURLから開き直す |
| AIが応答しない | 接続先の稼働・モデル・API形式・通信モード・送信許可を確認する |
| CLI・MCP・Codexが使えない | 初期値のprotectedでは無効。必要性を確認してlegacy-hostを明示設定する |
| executorが使えない | Dockerと事前導入・承認済みのダイジェスト固定Nodeイメージを確認する |
| 再開を拒否される | 結果不明の操作や古い承認を確認する。自動再試行しない |
| 実行モードを変えられない | 仕事・キュー・既知のホスト処理を停止し、不明な実行を確認する |
| Pythonテストが起動しない | Python 3を導入するか、`PYTHON` に実行ファイルを指定する |
| ネイティブCLIがない | `npm ci --prefix Tepora-v3 --ignore-scripts` を実行する |
| プレビューで推論できない | プレビューは画面確認用。実サービスにモデルを接続する |

V2の設定ファイル・データベースをV3のデータとして置き換えないでください。現行データと検証範囲は[README](../../Tepora-v3/README.md)と[STATUS](../../Tepora-v3/docs/STATUS.md)に記載しています。

## macOS Rust build dependencies

この環境で `phf_macros` などのE0463と `mis-aligned LINKEDIT string pool` を再現しました。症状は[Rustの公式報告](https://github.com/rust-lang/rust/issues/157750)と一致します。`Tepora-v3/desktop/Cargo.toml` のdev/release `build-override` は、ビルドスクリプトと手続きマクロのデバッグ情報を残し、stripを無効にします。アプリ本体のrelease最適化は変更しません。

新しい設定で `npm run build` を再実行してください。ツールチェーンの更新で回避策が不要になった場合は、実際のビルドを検証してから外します。
