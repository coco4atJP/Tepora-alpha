# Tepora 競合調査とフィードバック

**作成日**: 2026-03-18  
**対象バージョン**: Tepora v0.4.5 Beta  
**調査範囲**: ローカル実装・既存ドキュメント・競合公式サイト/公式ドキュメント

---

## 1. エグゼクティブサマリー

2026-03-18 時点での結論は明確です。**Tepora は「ローカルで動くチャットUI」市場で戦うと埋もれますが、「local-first の個人向け AI パートナー。長期記憶と安全なエージェント実行を持つ」製品としては十分に勝ち筋があります。**

ただし、その勝ち筋はまだ前面に出し切れていません。現状の競争環境では、以下の3方向から圧力を受けています。

1. **ローカルモデル実行系**: LM Studio / Jan / GPT4All  
   モデル導入の簡単さ、軽さ、分かりやすさで競争が激しい。
2. **ローカル業務ワークスペース系**: AnythingLLM / Open WebUI / Msty  
   RAG、MCP、エージェント、ワークフロー、チーム利用まで一気通貫で見せてくる。
3. **期待値を作るクラウドデスクトップ系**: Claude Desktop / ChatGPT Desktop  
   コネクタ、プロジェクト、記憶、全体品質で「AI デスクトップに当然求められる体験」を押し上げている。

この状況で Tepora が取るべき方針は、**「モデル管理の便利ツール」でも「何でも入りのAIワークベンチ」でもなく、長期的に付き合える private AI companion へ軸を寄せること**です。

---

## 2. Tepora の現在地

### 2.1 強み

- **思想が一貫している**  
  `local-first / privacy-centric / auditability` が README、ビジョン、設計哲学で揃っている。これは単なる機能列挙より強い。
- **差別化になりうる記憶の核がある**  
  EM-LLM ベースのエピソード記憶、減衰、圧縮、統計表示まで実装されており、単なる「チャット履歴保持」ではない。
- **MCP とエージェント実行を内製オーケストレーションで扱っている**  
  Agent Skills、MCP、ツール承認、Lockdown、監査可能性まで含めて設計されている。
- **工学的な品質意識が高い**  
  `task doctor`、アーキ適合テスト、WS replay、Model Behavior 評価、flaky 検知など、個人プロダクトとしてはかなり堅い。
- **デスクトップ前提の体験設計を持っている**  
  Tauri + React + Rust sidecar で、ローカル体験と制御性の両立を狙っている。

### 2.2 課題

- **市場での見え方が広すぎる**  
  Chat / Search / Agent、Memory、Model Hub、MCP、Web Search、Skills と守備範囲が広く、初見では「結局何が一番強いのか」が伝わりにくい。
- **記憶の価値が“内部構造”としては強いが、“ユーザー価値”としてはまだ見えにくい**  
  現在の Memory 画面は統計と compaction job 中心で、ユーザーが「何を覚えていて、なぜ今その返答なのか」を体感しづらい。
- **オンボーディング負荷が高くなりやすい**  
  `llama.cpp` / Ollama / LM Studio / OpenAI-compatible と選択肢が多く、価値到達前に設定判断が発生しやすい。
- **UI の一貫性がまだ途中**  
  `src/v2/shared/theme/variables.css` にテーマ基盤がある一方、既存画面には `bg-[#0A0A0C]`, `bg-gray-800`, `text-white` などのハードコードが残っている。
- **内部的にはメモリ基盤の統合がまだ終わっていない**  
  `memory_v2` 移行ロードマップは Phase 4-6 が未着手で、差別化の核ほど内部整理が残っている。
- **ドキュメント上の表記ゆれがある**  
  `v0.4.5 Beta` と `4.5 (BETA) (v0.4.5)` のような版表記差は、外向きの信頼感を少し削る。

---

## 3. 競合マップ

### 3.1 直接競合

| 競合 | 現在の見え方 | 強い点 | Tepora が勝てる余地 | 脅威度 |
| --- | --- | --- | --- | --- |
| **LM Studio** | ローカルモデル実行の定番。モデル管理、ローカル API、MCP client、headless 展開まで提供 | 導入の簡単さ、モデル実行体験、開発者向け利用の広さ | 長期記憶、継続会話、安全なエージェント制御 | 高 |
| **Jan** | オープンソース寄りの offline/local AI assistant。MCP、クラウド接続、OpenAI-compatible API を持つ | 「自由・ローカル・オープン」の分かりやすさ、対応 OS/ハード要件の明快さ | 記憶の深さ、監査性、デスクトップ上の安心設計 | 中 |
| **GPT4All** | CPU 含む consumer hardware 向けローカル AI。LocalDocs とローカル API が主軸 | 軽量、分かりやすい、オフライン訴求が強い | エージェント、MCP、継続的なパーソナル記憶 | 中 |
| **AnythingLLM** | local-by-default の AI ワークスペース。AI Agents、Flows、Custom Skills、MCP、Community Hub を同居 | 「仕事に使える箱」としての完成度、RAG/Agents/Flows のパッケージ感 | 個人向け companion 性、記憶の質、安全性と監査性 | 高 |
| **Open WebUI** | self-hosted で拡張性の高い AI インターフェース。Memory / RAG / Web Search / MCP / OpenAPI を統合 | 拡張性、コミュニティ、セルフホスト基盤の強さ | デスクトップ最適化、初期 UX、個人利用での落ち着いた体験 | 高 |
| **Msty Studio** | polished な all-in-one AI studio。local/online models、Knowledge Stacks、MCP tools、Personas、Workflows を明快に訴求 | パッケージング、商用感、分かりやすい価値提示、チーム展開の匂い | ローカル主権の強さ、透明な制御、深い記憶の物語 | 高 |

### 3.2 間接競合 / 期待値形成プレイヤー

| 競合 | ユーザーが期待する体験 | Tepora への影響 |
| --- | --- | --- |
| **Claude Desktop** | デスクトップ AI がツールやコネクタと自然につながること | MCP/Connector 体験の基準を押し上げる |
| **ChatGPT Desktop** | プロジェクト単位の記憶、デスクトップ統合、全体品質の高さ | 「AI アプリならここまで出来て当然」という基準を作る |

---

## 4. 競合比較から見える示唆

### 4.1 Tepora は「モデル実行」単体では勝ちにくい

LM Studio、Jan、GPT4All は、モデルを手元で動かすこと自体の価値提案が非常に明快です。  
Tepora もモデル管理を持っていますが、それを主戦場にすると「導入の軽さ」「モデルカタログ」「開発者 API の認知」で不利になります。

**示唆**: モデル管理は必須機能だが主役ではない。主役は「覚える」「継続する」「安全に動く」であるべき。

### 4.2 一番危険なのは AnythingLLM / Open WebUI / Msty の領域

この3者は、RAG・エージェント・MCP・ドキュメント活用・複数モデル接続を「作業成果に直結するワークスペース」として見せています。  
Tepora が「高機能だが何に効くか伝わりにくい」ままだと、ここに吸われやすいです。

**示唆**: Tepora は“機能の量”ではなく、“人に寄り添う継続性”と“制御された自律性”で戦う必要がある。

### 4.3 クラウド製品がユーザー期待値を定義している

Claude Desktop や ChatGPT Desktop は local-first ではない一方、**記憶・プロジェクト・コネクタ・全体品質**の期待値を作ります。  
ユーザーは無意識にその完成度を基準に比較します。

**示唆**: Tepora は frontier model 品質で正面衝突するのではなく、`privacy + continuity + control` の束で評価軸をずらす必要がある。

---

## 5. Tepora へのフィードバック

### 5.1 最優先: カテゴリを再定義する

現状の Tepora は、説明上は「ローカルAIデスクトップ」「モデル管理」「MCPクライアント」「エージェント」など複数カテゴリにまたがっています。これは機能的には豊かですが、**市場的には輪郭がぼやけます**。

提案:

- 外向きメッセージを **「Local-first AI companion with episodic memory and auditable actions」** に寄せる
- 「何ができるか」の前に **「何を継続的に助ける存在なのか」** を語る
- 「単一GPUでも育つパートナー」「覚えて、でも勝手に暴走しない」を短い言葉で固定する

### 5.2 最優先: 記憶を“見える価値”に変える

EM-LLM 実装は Tepora 最大の技術資産です。しかし現状の UI では、その価値が統計・保守・内部用語寄りに表現されています。

提案:

- 会話ごとに **「今回参照した記憶」** を出す
- **Memory Timeline** を実装し、何をいつ覚えたかを見せる
- 圧縮前後の差分レビューを出す
- 記憶矛盾検知や「これは推測です」の表示を入れる
- 再開時に **前回からの変化3行サマリー** を出す

狙いは「すごいメモリ実装がある」ではなく、**「この子は前回の自分をちゃんと引き継いでいる」** を感じさせることです。

### 5.3 最優先: セットアップを“目的ベース”に変える

現在の導入導線はローダー選択が中心です。これはパワーユーザーには自然でも、一般ユーザーには早い段階で難しい。

提案:

- 初回導線を「どのローダーにするか」ではなく以下の 3〜4 パターンにする  
  - Private Chat
  - Research with Web
  - Personal Memory Companion
  - Coding / Tools
- マシンスペックから推奨構成を自動提示する
- 「最短で価値に到達するデフォルト構成」を 1 つ用意する

競合が強いのは、技術的に高度だからではなく、**最初の 5 分で迷わせない**からです。

### 5.4 最優先: MCP を“設定”から“成果物”に変える

MCP はもはや差別化ではなく前提になりつつあります。Claude、AnythingLLM、Open WebUI、Msty は、接続先やツールを「使い道」と結びつけています。

提案:

- MCP サーバーを **ユースケース単位のスターターパック** として配布する
- 「研究」「執筆」「ローカルファイル整理」「開発補助」などのプリセットを用意する
- 各ツールに **危険度、権限範囲、有効期限** を可視化する
- 承認ログと Lockdown を UI 上でより前面に出す

Tepora は安全側の設計思想を持っているので、ここは単なる追従ではなく **「一番安心して MCP を使える desktop agent」** を目指せます。

### 5.5 高優先: “機能”ではなく“ミッション”で体験を売る

AnythingLLM や Msty が強く見える理由の一つは、ユーザーが成果物を想像しやすいからです。Tepora も Agent Skills を持っていますが、まだ組み立て部品に見えやすいです。

提案:

- 目的別ミッションを同梱する  
  - 調査アシスタント
  - 執筆アシスタント
  - 学習リキャップ
  - 開発ログ要約
- 会話から TODO 抽出、日次リキャップ、Branch Chat など、継続利用のリズムを作る
- 「今日も Tepora を開く理由」を会話以外にも作る

### 5.6 高優先: ブランドと UI を統一する

設計哲学とデザインガイドラインには「温かみ」「紅茶・喫茶店」「Calm UX」が強くあります。しかし現行画面にはハードコード色や旧新テーマ混在が残り、ブランドの一体感がまだ弱いです。

提案:

- v2 テーマ基盤への移行を加速し、ハードコード色を段階削減する
- 「calm / warm / trustworthy」を明示する UI パターンに寄せる
- ModelHub や Memory のような差別化画面ほど、ブランドを感じる仕上がりにする

Msty や Claude と真正面で比べられる時、最後に効くのは**安心感のある統一体験**です。

### 5.7 高優先: 外向きの証拠を作る

Tepora は内部品質が高い一方、その強みが市場に見えにくいです。

提案:

- 代表シナリオのデモを 3 本作る  
  - 2週間継続で育つ personal memory
  - ローカルモデル + 必要時のみ Web/MCP
  - 承認付きエージェント実行
- Tepora らしい KPI を作る  
  - `time-to-first-useful-answer`
  - `time-to-resume-context`
  - `tool safety visibility`
- README 冒頭を「できること一覧」から「なぜ Tepora なのか」に寄せる

---

## 6. 推奨アクションプラン

### P0: 直近 1〜2 か月

1. **ポジショニングを固定する**  
   README / サイト / アプリ初回導線のメッセージを統一する。
2. **記憶の可視化を最小実装する**  
   参照記憶表示、再開サマリー、Memory Timeline のどれか 1 つを先に出す。
3. **目的ベース onboarding を作る**  
   ローダー選択より前に「使い方」から入る。
4. **MCP プリセットを用意する**  
   研究/執筆/開発の 3 つで十分。

### P1: 次の四半期

1. **ミッション駆動の Agent Skills 配布**
2. **UI トークン統一と主要画面のリデザイン**
3. **記憶の信頼性 UI**  
   参照元、矛盾検知、事実/推測タグ
4. **代表デモと比較記事の公開**

### P2: その後

1. **Artifacts / Canvas**
2. **共同作業やチーム機能**
3. **マルチモーダル**
4. **A2A / エージェント社会系の拡張**

現時点では、P2 を急ぐより **P0 で「この製品は何者か」を固める方が ROI が高い**です。

---

## 7. 総評

Tepora の一番良いところは、単なる「ローカルAIアプリを作りたい」ではなく、**主権・継続性・透明性に根差した思想がコードとドキュメントに落ちていること**です。これは競合の多くがまだ十分に持てていない資産です。

一方で、今の競争環境では思想だけでは勝てません。  
必要なのは、**その思想を 5 分で体験できる形に圧縮すること**です。

要するに Tepora は、

- モデルを動かす便利ツールとして戦うべきではない
- 何でも入りワークベンチとして曖昧に広げるべきでもない
- **「覚えてくれる」「でも勝手に暴走しない」「ローカル主権を守る」AI パートナー**として磨くべき

です。

その方向に寄せれば、競合が増えるほど逆に輪郭が立ちます。

---

## 8. 参照資料

### Tepora 内部資料

- [README](../../README.md)
- [Tepora Project Vision](../architecture/Tepora_Project_Vision.md)
- [Tepora Design Philosophy](../architecture/Tepora_Design_Philosophy.md)
- [Architecture](../architecture/ARCHITECTURE.md)
- [Memory Architecture](../architecture/MEMORY_ARCHITECTURE.md)
- [User Guide](../user_guide.md)
- [Project Improvement Catalog](./PROJECT_IMPROVEMENT_CATALOG_2026-03-05.md)
- [ModelHub page](../../Tepora-app/frontend/src/pages/ModelHub.tsx)
- [Memory page](../../Tepora-app/frontend/src/pages/Memory.tsx)
- [V2 theme variables](../../Tepora-app/frontend/src/v2/shared/theme/variables.css)

### 競合の公式情報

- [LM Studio Home](https://lmstudio.ai/home)
- [LM Studio local server docs](https://lmstudio.ai/docs/cli/serve/server-start)
- [AnythingLLM Desktop](https://anythingllm.com/desktop)
- [AnythingLLM Docs](https://docs.anythingllm.com/)
- [Jan Docs / FAQ](https://jan.ai/docs)
- [Open WebUI overview](https://openwebui.com/chats/upload)
- [Open WebUI Tools / Memory / MCP](https://docs.openwebui.com/features/extensibility/plugin/tools/)
- [Open WebUI MCP Support](https://docs.openwebui.com/features/plugin/tools/openapi-servers/mcp/)
- [GPT4All Models](https://docs.gpt4all.io/gpt4all_desktop/models.html)
- [GPT4All API Server](https://docs.gpt4all.io/gpt4all_api_server/home.html)
- [Msty Home](https://msty.ai/)
- [Msty Studio Desktop Free announcement](https://msty.ai/blog/msty-studio-free/)
- [Msty Shadow Persona](https://msty.ai/blog/shadow-persona)
- [Claude official desktop page](https://www.anthropic.com/claude)
- [ChatGPT Release Notes](https://help.openai.com/en/articles/6825453-chatgpt-trelease-notes)
- [ChatGPT Projects / project memory](https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt)
