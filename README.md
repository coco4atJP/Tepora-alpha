![Tepora Header](image/Tepora_log.png)

# Tepora V3 · 3.0.0-beta.11

Teporaは、ひとつのキャラクターとの会話を続けながら、別のワーカーへ非同期に仕事を任せるローカル中心のAIワークスペースです。このブランチの起動・開発・検証・ネイティブビルドはすべて **V3 beta.11** を対象にしています。

## 起動

Node.js **22.16.0以上**が必要です。コアサービスには依存パッケージのインストールは不要です。

```sh
git clone https://github.com/coco4atJP/Tepora-alpha.git
cd Tepora-alpha
npm start
```

Windowsはルートの `start.cmd`、macOSは `start.command` からも起動できます。ブラウザーを自動で開かない場合は `npm run serve` を使い、表示された起動URLを開きます。URLには一時的な認証トークンが含まれます。

上部の「AIを接続」（または「設定 → AIとの接続」）で稼働中のローカルモデルを設定するか、送信先を確認して外部プロバイダーを接続します。モデルや推論環境は同梱されておらず、自動導入も完成していません。

AIを接続せずに画面を確認する場合:

```sh
npm run preview:build
```

生成された `Tepora-v3/tepora-v3-preview.html` を開きます。プレビューはAI推論・ログイン・PC操作を行いません。

## beta.11の構成

- **コンパニオンモニター**: ホームはキャラクター・時計・1枚ずつめくるカード（仕事・天気・ニュース・このPCの音楽・つくった画像）だけの静かな画面です。入力欄はキャラクターの下にあり、会話の全体は必要なときに開きます。しばらく操作がないと待機画面になります。キャラクターは自分のVRMモデルにも替えられます。
- **あなたの番**: 承認・作業担当の質問・確認待ちの結果・止まった仕事・提案を1か所に集めます。不在中は承認が必要な操作だけを保留して、ほかの作業を進めます。許可した内容だけを、そのまま実行します。
- **継続する会話**: キャラクターと作業担当の人格を別々に設定し、会話と仕事の状態をSQLiteに保存します。
- **非同期ワーカー**: 会話を止めずに仕事を任せ、出典付きの進捗・質問・結果を受け取ります。送信先が異なる結果は、確認した範囲だけ共有します。
- **成果物**: 作成、改版、書き出し、受け入れを扱います。隔離実行の出力は候補として保存し、正確な内容と版を確認して取り込みます。
- **能力の接続**: 会話・作業・画像理解・音声・生成・埋め込み・構造化判断の接続先を役割ごとに設定できます。
- **実行境界**: 初期設定は `protected`。任意コードには事前導入・承認済みのダイジェスト固定Dockerイメージが必要です。ホストCLI・Codex・MCP・PC操作には明示的な `legacy-host` 切り替えが必要です。
- **通信制御**: オンライン、指定LAN接続先、完全オフラインのモードを提供します。実行境界と通信許可は別々に管理します。

## 開発・検証・ビルド

```sh
npm run doctor             # 環境診断
npm test                   # V3 Nodeテストとルート起動テスト
npm run quality            # 構文・Node・Python・仕様参照・プレビュー・能力連携
npm run preview:build      # モデル不要の画面プレビュー
npm ci --prefix Tepora-v3 --ignore-scripts  # ネイティブ用CLI
npm run desktop            # Tauri開発起動
npm run build              # Windows/macOSネイティブパッケージ
```

標準検証にはPython 3が必要です。ネイティブビルドにはRust stableとOSごとのTauriビルド環境が必要です。Taskを利用する場合も、`task dev`、`task quality`、`task build` は同じV3のコマンドを実行します。

CIは `main` と `v3.0-beta/**` のV3関連変更およびPRを対象にします。通常検証とWindows/macOSのネイティブビルド・起動確認を用意しています。ワークフローの設定は実行成功の証拠ではありません。

## 現在の範囲

beta.11は開発ベータです。回帰試験は主にローカルHTTPと決定的なモデル代替を使います。100シナリオの対応表は **仕組み検証済み1・部分対応93・未実装6** で、100件の実利用合格を意味しません。

実モデルの品質、実音声、GPU負荷、Docker隔離、ネイティブ配布物の実機確認は別に必要です。PDF・Office入力、macOS全体のPC操作、V2の人格・プロフィールの完全移行は未実装です。詳しくは[検証状況](Tepora-v3/docs/STATUS.md)を参照してください。

## リポジトリと資料

```text
Tepora-v3/        現行アプリ: Nodeコア、Web UI、Pythonワーカー、Tauriホスト
scripts/         V3の環境診断とリリース補助
Taskfile.yml     V3の共通コマンド
package.json     V3のルート起動・検証・ビルド
docs/            beta.11のユーザー・開発・設定ガイド
```

- [使い始め](Tepora-v3/docs/START-HERE.md)
- [ユーザーガイド](docs/user_guide.md)
- [開発ガイド](docs/guides/development.md)
- [設定ガイド](docs/operations/CONFIGURATION_GUIDE.md)
- [beta.11アーキテクチャ](Tepora-v3/docs/ARCHITECTURE.md)
- [実行境界と制限](Tepora-v3/docs/BETA11.md)
- [変更履歴](docs/CHANGELOG.md)

このブランチにはV3のソースと現行資料だけを置いています。旧版のソース・専用ツール・資料・ワークフローは撤去しました。過去の内容はGit履歴から参照できます。既存ユーザーデータの自動移行・削除は行いません。

## ライセンス

[LICENSE](LICENSE)を参照してください。
