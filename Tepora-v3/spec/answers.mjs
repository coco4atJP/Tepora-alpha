/** Implementation traceability, not 100 real-user or real-model passes. */
export const groups={
  "firstUse": {
    "files": [
      "core/setup.mjs",
      "core/platform-links.mjs",
      "core/probe.mjs",
      "web/onboarding.mjs",
      "web/app.mjs"
    ],
    "tests": [
      "tests/setup-journey.test.mjs",
      "tests/browser-first-use.py"
    ],
    "answer": "使い始め画面からローカル接続を探索し、稼働中Ollama経由の確認付きモデル取得・取消・再取得と、ツール往復検査後の切替えを実装。取得だけでは接続完了・初回成功としない。OS実行基盤の自動導入は未実装。 検証済みの初回ローカル接続を名前付き継続先へ登録し、二重の設定作業を減らす。"
  },
  "sourceHandoff": {
    "files": [
      "core/input-files.mjs",
      "core/requests.mjs",
      "core/harness.mjs",
      "core/workspace.mjs",
      "web/app.mjs"
    ],
    "tests": [
      "tests/setup-journey.test.mjs",
      "tests/browser-first-use.py"
    ],
    "answer": "利用者が選んだUTF-8ファイルだけをローカルに保存。仕事別のハッシュ付き参照と接続先別の送信同意で渡し、添付から成果物・確認へ進める。入力資料のコピーを成果物と数えない。PNG/JPEGは独立した画像経路で扱う。PDF・Office入力は未対応。"
  },
  "requestReceipt": {
    "files": [
      "core/requests.mjs",
      "core/server.mjs",
      "web/app.mjs",
      "web/bridge.mjs"
    ],
    "tests": [
      "tests/setup-journey.test.mjs",
      "tests/browser-first-use.py"
    ],
    "answer": "送信内容を要求IDに結び付け、応答を失った際の再送で仕事を重複させない。失敗時は下書きと添付を保持し、後から入力した内容を遅い応答で消さない。"
  },
  "loopGate": {
    "files": [
      "scripts/improve-loop.mjs",
      "docs/IMPROVEMENT-LOOP.md",
      "../.github/workflows/ci.yml"
    ],
    "tests": [
      "tests/setup-journey.test.mjs",
      "tests/browser-first-use.py"
    ],
    "answer": "変更→構文・実HTTP/ファイル/状態試験・ワーカー契約・100場面対応検査・プレビュー生成のループを共通化。source hashと各段階のログを残し、変更がなければ再試験を改善回数に数えない。コードの自動改変機能ではない。"
  },
  "agents": {
    "files": [
      "core/agents/rpc.mjs",
      "core/agents/codex.mjs",
      "core/harness.mjs",
      "web/app.mjs"
    ],
    "tests": [
      "tests/agentos.test.mjs",
      "tests/http.test.mjs"
    ],
    "answer": "Codex App Serverの公式stdio接続を実装。スレッド保持、逐次出力、承認、expectedTurnId付き途中指示、中断、切断時の結果不明を扱う。実Codex／実機では未評価。 制限ネットワークモードでは、通信を封じ込められない外部Codex自体を起動しない。"
  },
  "scheduling": {
    "files": [
      "core/routines.mjs",
      "core/plans.mjs",
      "web/app.mjs"
    ],
    "tests": [
      "tests/agentos.test.mjs",
      "tests/http.test.mjs",
      "tests/browser-agentos.py"
    ],
    "answer": "タイムゾーン付き定期／一回実行とDAGプランを実装。提案と有効化、依存条件、決定的実行ID、繰越の集約、権限変更時停止を分離。"
  },
  "checking": {
    "files": [
      "core/verification.mjs",
      "core/workspace.mjs",
      "core/harness.mjs"
    ],
    "tests": [
      "tests/agentos.test.mjs",
      "tests/http.test.mjs"
    ],
    "answer": "ファイル／JSON／artifact／承認済みコマンド結果の宣言的検査と最大2回の自動修正を実装。テスト後のファイル変更を検出する。"
  },
  "continuity": {
    "files": [
      "core/context.mjs",
      "core/search.mjs",
      "core/learning.mjs",
      "core/harness.mjs"
    ],
    "tests": [
      "tests/agentos.test.mjs"
    ],
    "answer": "原依頼・訂正・作業メモを保つ作業コンテキスト、証拠の範囲取得、日本語bigram付きFTS5、出所付きの手順提案を実装。"
  },
  "speechEditor": {
    "files": [
      "core/dictation.mjs",
      "web/draft.mjs",
      "web/app.mjs"
    ],
    "tests": [
      "tests/agentos.test.mjs",
      "tests/http.test.mjs"
    ],
    "answer": "ローカルモデルによる自然言語の下書き編集を実装。UTF-16範囲、原文照合、版、Undoを検査し、外部送信やPC操作のツールを渡さない。意味精度は未評価。"
  },
  "readiness": {
    "files": [
      "core/probe.mjs",
      "core/server.mjs",
      "web/app.mjs"
    ],
    "tests": [
      "tests/agentos.test.mjs"
    ],
    "answer": "安全なnonceのツール呼び出しと結果の読み取りを実モデルに要求する接続検査を実装。モデル一覧だけを準備完了と呼ばない。"
  },
  "monitor": {
    "files": [
      "web/app.mjs",
      "web/styles.css"
    ],
    "tests": [
      "tests/browser-preview.py"
    ],
    "answer": "時計と相棒と1枚のカードを既定にし、仕事・記憶・設定は必要時に開く。文字入力は常にキャラクターの下にあり、動いている処理があるあいだは全停止を必ず表示する（表示設定では消えない）。"
  },
  "display": {
    "files": [
      "core/display.mjs",
      "web/display-model.mjs",
      "web/app.mjs",
      "core/harness.mjs"
    ],
    "tests": [
      "tests/contracts.test.mjs",
      "tests/http.test.mjs",
      "tests/browser-preview.py"
    ],
    "answer": "表示専用の検証済みスキーマ、順序・選択・文字サイズ・テーマ、変更履歴とUndo、今日だけ非表示、モデルからの表示ツールを実装。"
  },
  "native": {
    "files": [
      "desktop/src/main.rs",
      "desktop/Cargo.toml"
    ],
    "tests": [],
    "answer": "閉じる操作はトレイへ隠す。表示・全停止・終了を分離し、隠れた画面のマイクを停止する。実機確認はネイティブCIと別途必要。"
  },
  "voice": {
    "files": [
      "core/speech-stream.mjs",
      "web/realtime-voice.mjs",
      "web/pcm-worklet.js",
      "workers/speech_server.py"
    ],
    "tests": [
      "tests/speech-stream.test.mjs",
      "workers/test_workers.py"
    ],
    "answer": "ローカルPCMの逐次送信、部分・最終認識、順序・重複防止、二分上限、明示的開始・取消を実装。Qwen認識器そのものの精度は未計測。"
  },
  "draft": {
    "files": [
      "web/draft.mjs",
      "web/app.mjs"
    ],
    "tests": [
      "tests/contracts.test.mjs"
    ],
    "answer": "版を指定した範囲編集とUndoを実装。手入力後の遅い音声結果を上書きせず、認識文字を自動送信・実行しない。"
  },
  "tasks": {
    "files": [
      "core/harness.mjs",
      "core/server.mjs"
    ],
    "tests": [
      "tests/contracts.test.mjs",
      "tests/core.test.mjs"
    ],
    "answer": "会話と仕事の独立レーン、会話からの委任、永続チェックポイント、一時停止・再開・途中指示、実行予算とループ停止を実装。"
  },
  "approval": {
    "files": [
      "core/harness.mjs",
      "core/server.mjs",
      "web/app.mjs"
    ],
    "tests": [
      "tests/contracts.test.mjs",
      "tests/http.test.mjs"
    ],
    "answer": "操作の引数・版に結び付く承認、有効期限、途中指示・権限撤回時の無効化、結果不明の操作記録と手動照合を実装。"
  },
  "artifact": {
    "files": [
      "core/store.mjs",
      "core/harness.mjs",
      "core/server.mjs",
      "web/app.mjs"
    ],
    "tests": [
      "tests/contracts.test.mjs",
      "tests/http.test.mjs",
      "tests/browser-preview.py"
    ],
    "answer": "版履歴、CAS編集、表示版の固定、他仕事からの上書き防止を実装。モデルの完了宣言は仕事の完了にせずreviewへ移す。"
  },
  "memory": {
    "files": [
      "core/store.mjs",
      "core/server.mjs",
      "web/app.mjs"
    ],
    "tests": [
      "tests/contracts.test.mjs",
      "tests/http.test.mjs"
    ],
    "answer": "記憶の確認・訂正・共有範囲・削除と、1000件を超える検索・書出しを実装。記憶イベントへ本文を複製しない。"
  },
  "portability": {
    "files": [
      "core/store.mjs",
      "core/server.mjs",
      "web/app.mjs"
    ],
    "tests": [
      "tests/contracts.test.mjs"
    ],
    "answer": "v2の専用データ移行形式で記憶・成果物・版・スキル・仕事・文脈・操作履歴を持ち出す。取込は非共有・無効・実行停止で行う。"
  },
  "runtime": {
    "files": [
      "core/runtime.mjs",
      "core/policy.mjs",
      "core/server.mjs"
    ],
    "tests": [
      "tests/core.test.mjs",
      "tests/http.test.mjs",
      "tests/launch.test.mjs"
    ],
    "answer": "複数の互換実行先、ローカル検出、起動設定、明示的外部接続、起動中のみのキーを維持。モデル一覧確認を実仕事の成功と区別する。"
  },
  "shared": {
    "files": [
      "core/shared-assets.mjs",
      "core/harness.mjs",
      "core/server.mjs"
    ],
    "tests": [
      "tests/contracts.test.mjs"
    ],
    "answer": "~/.agents/skillsの明示的・読み取り専用探索、名前空間ID、未承認シンボリックリンク拒否、内容ハッシュ照合、仕事内でのスキル版固定を実装。"
  },
  "mcp": {
    "files": [
      "core/mcp.mjs",
      "core/harness.mjs",
      "core/server.mjs"
    ],
    "tests": [
      "tests/core.test.mjs",
      "tests/http.test.mjs"
    ],
    "answer": "stdio/HTTPのMCP接続と明示的実行承認を維持。登録だけでは起動せず、新規道具は無効で保存する。"
  },
  "decision": {
    "files": [
      "core/decision.mjs",
      "core/runtime.mjs",
      "core/harness.mjs",
      "workers/laya_server.py"
    ],
    "tests": [
      "tests/contracts.test.mjs",
      "workers/test_workers.py"
    ],
    "answer": "Laya多言語版のローカルワーカーとJev互換の型付き判断を実装。期限・短い候補集合・応答検証を設け、権限・完了の証拠から分離する。"
  },
  "privacy": {
    "files": [
      "core/policy.mjs",
      "core/harness.mjs",
      "web/app.mjs"
    ],
    "tests": [
      "tests/http.test.mjs",
      "tests/browser-preview.py"
    ],
    "answer": "共有表示は下書き・成果物・個人通知を隠す。権限撤回で実行を止め、古い許可の文脈を無断再送しない。共有表示はOS認証の代替ではない。"
  },
  "media": {
    "files": [
      "core/connectors.mjs",
      "core/server.mjs",
      "web/app.mjs"
    ],
    "tests": [
      "tests/core.test.mjs",
      "tests/http.test.mjs"
    ],
    "answer": "選択式の天気・RSSと、分離したYouTube埋め込み・Brave経路を提供。広告除去・自動ログイン・再生品質は保証しない。"
  },
  "workspace": {
    "files": [
      "core/harness.mjs",
      "core/policy.mjs"
    ],
    "tests": [
      "tests/contracts.test.mjs",
      "tests/core.test.mjs"
    ],
    "answer": "仕事ごとに作業ディレクトリを分離し、同名ファイルの仕事間衝突を避ける。ホストCLIをOSサンドボックスとは扱わない。"
  },
  "distribution": {
    "files": [
      "package.json",
      "scripts/build-preview.mjs",
      "scripts/build-sidecar.mjs",
      "../.github/workflows/ci.yml"
    ],
    "tests": [
      "tests/frontend.test.mjs"
    ],
    "answer": "版を固定したソース、単独プレビュー、ネイティブビルドと検証ログを対応付ける。署名・公証・モデル自動導入は未完了。"
  },
  "providers": {
    "files": [
      "core/provider-registry.mjs",
      "core/provider-protocols.mjs",
      "web/provider-settings.mjs",
      "core/harness.mjs"
    ],
    "tests": [
      "tests/routing-policy.test.mjs",
      "tests/routing-integration.test.mjs",
      "tests/browser-routing.py"
    ],
    "answer": "名前付き接続先と4種類のAPI形式、主系・役割別・明示的代替経路、接続先専用キー、ツール往復検査、既存仕事の同意付き切替えを実装。全ベンダー固有認証の互換ではない。"
  },
  "connectivity": {
    "files": [
      "core/network-policy.mjs",
      "core/server.mjs",
      "core/requests.mjs",
      "core/connectors.mjs"
    ],
    "tests": [
      "tests/routing-policy.test.mjs",
      "tests/routing-integration.test.mjs"
    ],
    "answer": "オンライン／同一PCのみ／指定LAN推論機の通信境界を共通化。IP・ポート・APIパス固定、DNS・redirect検査、実行中の送信取消、ネットワーク待ちからのローカル継続を実装。OS全体の遮断ではない。"
  },
  "localVision": {
    "files": [
      "core/vision.mjs",
      "core/provider-protocols.mjs",
      "core/input-files.mjs",
      "core/requests.mjs"
    ],
    "tests": [
      "tests/routing-integration.test.mjs",
      "tests/browser-routing.py"
    ],
    "answer": "PNG/JPEGの明示的取込と実画像のVLM送信を実装。クラウド文字モデルへは明示的共有範囲内の出所付き説明だけを返せる。説明は非可逆・機密性を維持。実VLM精度は未評価。"
  },
  "computerUse": {
    "files": [
      "core/computer.mjs",
      "workers/computer.py",
      "core/harness.mjs",
      "web/provider-settings.mjs"
    ],
    "tests": [
      "tests/computer-contracts.test.mjs",
      "scripts/check-computer.mjs",
      "tests/browser-routing.py"
    ],
    "answer": "専用ブラウザ／選択したWindows UIAウィンドウ、観測した要素ID・版・操作範囲の照合、権限解放、Laya候補選択とVLM画像観測を実装。ローカルHTMLを実Chromiumで操作し観測確認。Windows UIA・公開サイト・ログインは未検証。"
  },
  "offlineCompute": {
    "files": [
      "core/computer.mjs",
      "workers/computer.py",
      "core/harness.mjs"
    ],
    "tests": [
      "tests/computer-contracts.test.mjs",
      "scripts/check-computer.mjs"
    ],
    "answer": "ホストAPI・ファイルハンドル・通信を渡さない使い捨てブラウザWorkerでJavaScript計算を実装。実計算、外部fetch拒否、無限ループ停止を検証。任意CLIのOSサンドボックスではない。"
  },
  "recovery": {
    "files": [
      "core/provider-registry.mjs",
      "core/harness.mjs",
      "core/network-policy.mjs"
    ],
    "tests": [
      "tests/routing-policy.test.mjs",
      "tests/routing-integration.test.mjs"
    ],
    "answer": "資源別の入場制御、優先・待ち行列上限、共有クールダウン、最大5回の限定復帰、途中切替時の古い出力破棄を実装。未知の操作結果を自動再実行しない。GPU予約・24/7保証ではない。"
  },
  "internetWork": {
    "files": [
      "core/web-tools.mjs",
      "core/network-policy.mjs",
      "core/computer.mjs",
      "workers/computer.py"
    ],
    "tests": [
      "tests/routing-integration.test.mjs",
      "tests/routing-policy.test.mjs"
    ],
    "answer": "出所・取得時刻付きのHTTPS文書取得と、許可オリジンの専用ブラウザ通信ブローカーを実装。私有IP・redirect・裏での送信を拒否。検索エンジンや既存ログインの引継ぎではない。"
  },
  "abilities": {
    "files": [
      "core/capabilities.mjs",
      "web/capability-ui.mjs"
    ],
    "tests": [
      "tests/multimodal.test.mjs",
      "tests/browser-capabilities.py"
    ],
    "answer": "主モデルと別にSystem One、TTS、埋め込み、画像生成・編集、動画の役割を管理。接続先別認証、同一PC・許可LAN・クラウドの通信制御と変更時の無効化を実装。独自SDKやホストサービスは必須にしない。"
  },
  "generatedMedia": {
    "files": [
      "core/media-jobs.mjs",
      "core/harness.mjs",
      "core/server.mjs",
      "web/capability-ui.mjs"
    ],
    "tests": [
      "tests/multimodal.test.mjs",
      "scripts/check-capabilities.mjs",
      "tests/browser-capabilities.py"
    ],
    "answer": "明示した内容・送信先で画像／画像編集／動画／読み上げを非同期に受付。受付ID・バイト列・出所を保存し、会話を止めずギャラリー／プレイヤーへ届ける。結果不明の新規生成は自動再送しない。実生成品質は未測定。"
  },
  "semanticRecall": {
    "files": [
      "core/semantic.mjs",
      "core/store.mjs",
      "core/harness.mjs",
      "web/capability-ui.mjs"
    ],
    "tests": [
      "tests/multimodal.test.mjs",
      "scripts/check-capabilities.mjs"
    ],
    "answer": "埋め込みと語彙のハイブリッド記憶検索、汎用候補ランキング、ローカル埋め込みによるツール候補整列を実装。モデル空間・内容ハッシュ・共有状態を再確認し、古い索引で訂正や削除を無視しない。類似度は事実判定・権限ではない。"
  },
  "toolCatalog": {
    "files": [
      "core/tool-hub.mjs",
      "core/mcp.mjs",
      "core/harness.mjs",
      "web/capability-ui.mjs"
    ],
    "tests": [
      "tests/multimodal.test.mjs",
      "tests/browser-capabilities.py"
    ],
    "answer": "最大100件のmcpServersをプレビューして無効で一括登録。選択した最大12接続の起動を確認し最大3並列で一覧取得。大量のツールは必要時に検索し、全スキーマを毎回主モデルへ送らない。停止後の未起動接続は起動しない。"
  },
  "managedLogin": {
    "files": [
      "core/agents/codex-login.mjs",
      "core/server.mjs",
      "web/capability-ui.mjs"
    ],
    "tests": [
      "tests/multimodal.test.mjs",
      "tests/browser-capabilities.py"
    ],
    "answer": "公式Codex App Serverのブラウザ／デバイスコード認証を接続。TeporaはOAuthトークンを抜き出さない。既存APIキー認証をサブスク認証と偽らず、共有CLI認証の変更には追加確認。実アカウント試験は未実施。"
  },
  "dualComputer": {
    "files": [
      "core/computer-controllers.mjs",
      "core/computer.mjs",
      "core/harness.mjs",
      "web/provider-settings.mjs"
    ],
    "tests": [
      "tests/multimodal.test.mjs",
      "scripts/check-computer.mjs"
    ],
    "answer": "LLM直指定と型付き意思決定の制御を分離。後者は実在する候補と操作・対象の一括質問から選び、同じ承認・版照合・ドライバを利用。DONEは独立観測で確認するまで提案。主モデル／Layaの判断精度は未評価。"
  },
  "modelCatalog": {
    "files": [
      "core/model-catalog.mjs",
      "web/capability-ui.mjs"
    ],
    "tests": [
      "tests/multimodal.test.mjs",
      "tests/browser-capabilities.py"
    ],
    "answer": "models.devの明示取得、JSON取込、オフライン検索を実装。外部メタデータを対応能力の実証とせず、npm名やコードは実行・インストールしない。モデルIDをコピーして既存接続設定で選べる。"
  }
};
export const cases=[
  [
    "A01",
    "monitor native privacy firstUse",
    "PC初心者によるクリーンインストール・初回成功・OS再表示を実機で検証する。"
  ],
  [
    "A02",
    "voice draft runtime firstUse abilities",
    "音声モデル・依存の自動取得と、実機ASRを含めた初心者向け導入を完成する。"
  ],
  [
    "A03",
    "",
    "プリンター検出、文書選択、部数確認、実印刷の専用ワークフローは未実装。"
  ],
  [
    "A04",
    "workspace approval localVision",
    "写真群の非破壊整理・重複判断・復元は未実装。単一画像の読取り経路と仕事別ファイル操作から進める。"
  ],
  [
    "A05",
    "",
    "予約先コネクター、入力プレビュー、予約確定と外部状態照合は未実装。"
  ],
  [
    "A06",
    "voice draft privacy",
    "ウェイクワード・本人宛発話・テレビ音声判別を実環境で評価する。"
  ],
  [
    "A07",
    "privacy",
    "OS利用者に連動した分離プロフィール、ゲスト、共有PCの記憶分離は未実装。"
  ],
  [
    "A08",
    "native tasks",
    "Windows/macOSで閉じる→隠す→再表示中の実モデル仕事の継続を検証する。"
  ],
  [
    "A09",
    "media",
    "曲名・気分からの検索とアカウント連携は未実装。"
  ],
  [
    "A10",
    "monitor display draft generatedMedia",
    "スクリーンリーダー、拡大率、代替入力とキーボードの全工程を実機で検証する。"
  ],
  [
    "A11",
    "monitor voice decision recovery abilities",
    "資源名で同時呼出しを制限するが、待機電力・発熱・ASRとのGPU競合を実機で測定する必要がある。"
  ],
  [
    "A12",
    "portability native",
    "アンインストール時の専用資産削除・バックアップ案内・所有権台帳は未実装。"
  ],
  [
    "A13",
    "monitor display distribution firstUse",
    "実行基盤まで同梱したプリインストール製品の初回利用と実モデル性能は未検証。"
  ],
  [
    "A14",
    "voice draft speechEditor",
    "実音声と実モデルで、名前・数値・否定・曖昧な訂正の意味精度と遅延を評価する。"
  ],
  [
    "A15",
    "display",
    "実音声・実モデルで「今日だけ」を理解する精度と異なるタイムゾーンを検証する。"
  ],
  [
    "A16",
    "privacy",
    "来客検出を自動化しない。共有状態の誤操作を利用者試験で確認する。"
  ],
  [
    "A17",
    "voice",
    "遠距離・反響・混雑の音声精度と発話終端を実測する。"
  ],
  [
    "A18",
    "",
    "画面取り外し・移動・タッチ対応を含むモニター別配置は未実装。"
  ],
  [
    "A19",
    "runtime voice decision monitor firstUse connectivity providers offlineCompute",
    "事前導入済みのローカル推論・資料・計算で継続する機構を試験。音声や実LLMを含む完全オフライン導入は未完成。"
  ],
  [
    "A20",
    "portability",
    "共通資産を残して専用キャッシュ・認証・常駐登録を削除する処理は未実装。"
  ],
  [
    "B01",
    "monitor tasks artifact firstUse sourceHandoff generatedMedia",
    "準備→本人の選んだ資料→成果物→確認のHTTP結合試験を実施。モデルは模擬で、実利用者の最初の成功は未検証。"
  ],
  [
    "B02",
    "runtime approval firstUse",
    "モデル取得前の通信・容量説明を実装。実行全体の金額予算と料金見積もりは未実装。"
  ],
  [
    "B03",
    "runtime managedLogin",
    "Codexの公式サブスク認証経路は実装。実アカウント・ネイティブOS試験は未実施。他社サブスクの権利・用途制約ごとの専用認証は未実装。"
  ],
  [
    "B04",
    "voice draft speechEditor",
    "自由な文体変更の忠実性と高負荷時の遅延を実モデルで測る。"
  ],
  [
    "B05",
    "tasks approval requestReceipt",
    "依頼受付の重複防止を実装。既に送信済みの外部サービスを自動照合する処理は別途必要。"
  ],
  [
    "B06",
    "scheduling",
    "絶対時刻とタイムゾーンの予約を実装。曖昧な自然言語日時の確認精度は未評価。"
  ],
  [
    "B07",
    "memory semanticRecall",
    "意味的統合、期限付き記憶、既存会話・バックアップを含めた忘却は未実装。"
  ],
  [
    "B08",
    "artifact mcp sourceHandoff internetWork",
    "HTTPS原文の取得経路を追加。網羅検索・主張単位の出典検証・調査品質は未評価。"
  ],
  [
    "B09",
    "approval privacy toolCatalog",
    "ホストCLIを隔離するOSサンドボックスと外部情報由来命令への攻撃評価は未完了。"
  ],
  [
    "B10",
    "voice media generatedMedia",
    "再生音・通話のエコーと、応答への割込みを実音声で検証する。"
  ],
  [
    "B11",
    "privacy requestReceipt generatedMedia",
    "共有表示で添付名・送信エラーも隠す。共有状態の自動検出や本人認証ではない。"
  ],
  [
    "B12",
    "tasks memory continuity",
    "一週間以上の利用で検索・文脈復帰の品質を評価する。"
  ],
  [
    "B13",
    "draft voice speechEditor",
    "実モデルによる自由な編集・対象同定の精度を実音声で検証する。"
  ],
  [
    "B14",
    "draft speechEditor",
    "否定・推測を保持する意味精度はベンチマーク未実施。"
  ],
  [
    "B15",
    "draft approval",
    "引用を自動で実行しない経路を実装。意図分類自体の精度は未評価。"
  ],
  [
    "B16",
    "display draft",
    "音声経由の自由なUndo指示を実モデルで検証する。"
  ],
  [
    "B17",
    "media",
    "音声曲名検索、認証付き再生、完全なメディア制御は未実装。"
  ],
  [
    "B18",
    "media display",
    "ニュース・天気以外の任意サービス表示拡張とOAuthは未実装。"
  ],
  [
    "B19",
    "",
    "利用者固有名詞の音声辞書学習は未実装。"
  ],
  [
    "B20",
    "portability",
    "認証情報の移行確認と旧PC上の完全削除は未実装。"
  ],
  [
    "C01",
    "distribution firstUse loopGate",
    "使い始めの導線と回帰ゲートを整備。署名／公証済み配布・自動更新・統一取得ページは未完了。"
  ],
  [
    "C02",
    "runtime firstUse providers",
    "CPUで動くモデル・ワーカーを登録できるが、GPU検出・自動導入・用途別の実測推薦は未完成。"
  ],
  [
    "C03",
    "firstUse",
    "稼働中Ollama経由のモデル取得・取消・再要求・進捗を実装。各OSでの容量不足回復、実取得と再開の実機検証が残る。"
  ],
  [
    "C04",
    "runtime readiness firstUse providers modelCatalog",
    "役割・能力別の選択と明示的代替を実装。どのモデルが実際に高品質かの自動比較は未実装。"
  ],
  [
    "C05",
    "mcp toolCatalog",
    "一般利用者向けのサービス名ベース接続とOAuth更新は未実装。"
  ],
  [
    "C06",
    "workspace approval sourceHandoff",
    "ファイルを明示選択する入口と仕事別読み取りを実装。フォルダー権限・除外・継続同期は未実装。"
  ],
  [
    "C07",
    "artifact sourceHandoff",
    "選択したテキスト資料から成果物を作る経路を結合試験。Word/Excel/PowerPoint出力は未実装。"
  ],
  [
    "C08",
    "portability memory semanticRecall",
    "他社AIのエクスポート形式変換と意味的な重複・矛盾整理は未実装。"
  ],
  [
    "C09",
    "shared mcp continuity toolCatalog",
    "配布元署名、依存関係の導入、更新ロールバックは未実装。"
  ],
  [
    "C10",
    "tasks artifact",
    "曖昧な途中指示を正しい仕事に自動帰属させる精度を実モデルで確認する。"
  ],
  [
    "C11",
    "voice",
    "固有名詞の継続学習、コードスイッチと実ASR精度評価が残る。"
  ],
  [
    "C12",
    "distribution portability loopGate",
    "変更ごとの回帰試験と証拠保存を実装。アプリ／モデル／スキルの独立ロールバックは未実装。"
  ],
  [
    "C13",
    "shared",
    "通常の~/.agents/skills以外の各種共通形式の統合と実ユーザー環境試験が残る。"
  ],
  [
    "C14",
    "shared",
    "同名スキルの説明・出所を比較する専用UIと優先設定を追加する。"
  ],
  [
    "C15",
    "display",
    "Live2D/VRMなど任意アバターの隔離付きプラグインローダーは未実装。"
  ],
  [
    "C16",
    "",
    "第三者ウィジェットの隔離、資源予算、権限付き拡張実行は未実装。"
  ],
  [
    "C17",
    "display",
    "",
    "mechanism_tested"
  ],
  [
    "C18",
    "voice draft",
    "日本語・英語混在とコード音声の実モデル評価が残る。"
  ],
  [
    "C19",
    "display",
    "自由な二次元配置・要素ごとのサイズ調整・ドラッグ操作は未実装。"
  ],
  [
    "C20",
    "voice",
    "デバイス切替えとBluetooth遅延を実機で検証する。"
  ],
  [
    "D01",
    "shared runtime agents managedLogin",
    "実Codexの各プラットフォームで既存の認証・作業環境との併用を検証する。"
  ],
  [
    "D02",
    "tasks display",
    "実LLMによる適切な委任と会話継続を評価する。"
  ],
  [
    "D03",
    "tasks approval scheduling",
    "プラン全体への意味的な指示変更と依存成果の無効化は限定的。実長時間試験が残る。"
  ],
  [
    "D04",
    "tasks continuity",
    "長時間実モデルでコンテキスト保持、費用・時間予算、要約品質を評価する。"
  ],
  [
    "D05",
    "workspace artifact",
    "Git worktreeによるコード統合と競合レビューは未実装。"
  ],
  [
    "D06",
    "artifact draft",
    "生成HTMLの要素単位編集・リッチテキスト統合と意味的マージは未実装。"
  ],
  [
    "D07",
    "artifact tasks checking sourceHandoff generatedMedia",
    "入力コピーを成果物へ昇格させない。任意の業務要件に対する独立した品質判断と実ブラウザ検査は未実装。"
  ],
  [
    "D08",
    "approval tasks requestReceipt generatedMedia",
    "Teporaへの依頼受付の重複防止を実装。外部操作の自動照合・冪等キーはコネクターごとに必要。"
  ],
  [
    "D09",
    "approval",
    "用途／範囲／期間を限定した委任権限と承認の集約は未実装。"
  ],
  [
    "D10",
    "runtime decision readiness providers localVision recovery abilities",
    "主系・仕事・会話・画像・音声編集を分け、明示的fallbackを実装。実モデルごとの品質・費用・遅延最適化は未評価。"
  ],
  [
    "D11",
    "tasks memory continuity",
    "長期利用の状態差分・意味的統合と再開の実モデル評価が残る。"
  ],
  [
    "D12",
    "tasks approval artifact providers recovery toolCatalog",
    "選択先・失敗・切替えを仕事と結び付けて記録。包括的な秘密マスキングと本番トレースの長期保持は未完成。"
  ],
  [
    "D13",
    "agents tasks managedLogin",
    "実Codexログイン・Windows/macOS・実プロバイダーとの結合試験が残る。他製品の全履歴を自動取込はしない。"
  ],
  [
    "D14",
    "agents tasks",
    "実Codexに対する音声経由の指示と反映遅延を検証する。Hermes ACP等は未実装。"
  ],
  [
    "D15",
    "agents approval managedLogin",
    "実Codexが返す各権限要求形式と追加権限の実環境試験が残る。"
  ],
  [
    "D16",
    "computerUse dualComputer",
    "選択した操作先への限定アクセスと明示的解放を実装。Windowsでの人間のマウス介入・フォーカス競合の実機検証は残る。"
  ],
  [
    "D17",
    "computerUse internetWork dualComputer",
    "専用ブラウザでの要素操作は実装。既存ログイン・OAuth・CAPTCHAの人間への引継ぎ、実公開サイトの完遂は未検証。"
  ],
  [
    "D18",
    "shared",
    "実ファイル更新と複数プロセス同時利用下でのスキル版固定試験が残る。"
  ],
  [
    "D19",
    "draft artifact speechEditor",
    "自由音声の編集精度、リッチエディターの意味的マージは未評価。"
  ],
  [
    "D20",
    "native tasks agents",
    "実ネイティブ環境で表示を隠してもCodex仕事が継続することを確認する。"
  ],
  [
    "E01",
    "runtime providers connectivity",
    "具体的IP・ポート・API範囲とprivateContextを設定。実LAN機・TLS証明書・名前解決の現場試験は残る。"
  ],
  [
    "E02",
    "tasks voice decision providers recovery",
    "同資源名での入場制御・会話優先を実装。ASRを含むGPUメモリ予約・強制割込み・遅延保証は未実装。"
  ],
  [
    "E03",
    "runtime decision providers abilities",
    "4API形式と各接続の能力を管理。未知の全プロバイダー・全モデルの通信完全互換は主張しない。"
  ],
  [
    "E04",
    "decision approval computerUse dualComputer",
    "Layaを観測済み候補の選択に接続。型付き通信は試験済み、実Layaの精度・校正・速度は未実測。"
  ],
  [
    "E05",
    "memory portability continuity semanticRecall",
    "FTS5化を実装。意味検索、百万件級評価、保持方針の細分化は未実装。"
  ],
  [
    "E06",
    "tasks scheduling providers recovery",
    "32仕事枠、資源別制御、待機上限、優先を実装。大量実モデル負荷と長期運用は未検証。"
  ],
  [
    "E07",
    "tasks scheduling checking recovery",
    "定期仕事の限定復帰と失敗の抑制を実装。実モデルでの夜間連続運用・長期ストレージ管理・進捗の意味検証は未完了。"
  ],
  [
    "E08",
    "tasks shared",
    "全構成・モデル・プロンプト・依存のスナップショットと再現実験は未実装。"
  ],
  [
    "E09",
    "approval mcp sourceHandoff connectivity computerUse offlineCompute toolCatalog",
    "制限モードでは未封じ込めのCLI/MCP/Codexを拒否。計算workerにはホスト権限を渡さないが、汎用OSサンドボックスと攻撃総合評価は未実装。"
  ],
  [
    "E10",
    "runtime tasks privacy requestReceipt providers connectivity recovery",
    "実行中の切断から事前許可済み代替へ移る経路、クールダウン後の限定再開を試験。実分散ノードの長期障害試験は残る。"
  ],
  [
    "E11",
    "native tasks",
    "認証付き遠隔・マルチモニタークライアントの製品導入は未実装。"
  ],
  [
    "E12",
    "portability",
    "設定・認証・ワークスペース実ファイルの完全移行と外部実行再開は未実装。"
  ],
  [
    "E13",
    "shared",
    "WSL境界と外部symlink先を利用者が許可する設定UIは未実装。"
  ],
  [
    "E14",
    "decision runtime providers computerUse abilities",
    "Laya/Jev互換を補助判断に利用。各実重みの同条件比較と性能評価は未実施。"
  ],
  [
    "E15",
    "voice decision tasks providers recovery abilities",
    "LLMの資源入場制御と音声の独立処理を持つが、実GPU負荷でのASR遅延・品質の計測が残る。"
  ],
  [
    "E16",
    "",
    "第三者ウィジェットのCPU/メモリ制限と故障隔離は未実装。"
  ],
  [
    "E17",
    "tasks",
    "複数クライアントの権限・本人分離とヘッドレス機器の運用導入が残る。"
  ],
  [
    "E18",
    "display portability",
    "未知の表示スキーマは拒否する。将来の自動マイグレーションは未実装。"
  ],
  [
    "E19",
    "shared portability",
    "完全アンインストールと所有権台帳の実装が残る。"
  ],
  [
    "E20",
    "display runtime providers connectivity modelCatalog",
    "役割・信頼範囲・モデル能力を変更でき、表示設定と権限を分離。すべての設定由来表示・外部プラグイン隔離は未完成。"
  ]
];
