# Agent Mode CLI Profile Design

**作成日**: 2026-03-19  
**対象**: Tepora Agent Mode / Executive Agent  
**目的**: Agent Mode にネイティブ CLI ツールを導入するための具体設計

---

## 1. 結論

Tepora の CLI 導入は、`Skill が CLI を直接持つ` 方式ではなく、**中央の `agent_executor` が CLI profile 由来の動的ツールを受け取って実行する**方式にする。

これは現在の Agent Mode 実装が以下の構造だからである。

- Skill は独立実行ノードではない
- `supervisor` が Skill を選択する
- `agent_executor` が唯一のツール実行主体である
- Skill は `skill_body`、`resource_prompt`、`tool_policy`、モデル割当として executor に注入される

このため、CLI は Agent Skills の見た目に寄せつつ、実装は **runtime で列挙される第3のツールソース** として扱うのが最も自然である。

---

## 2. 現状アーキテクチャ整理

### 2.1 実行主体

Agent Mode のグラフでは、ツール実行主体は `agent_executor` のみである。

- `router` から Agent Mode に入る
- `supervisor` が selected skill を決める
- 必要なら `planner` を通る
- `agent_executor` が ReAct loop と tool call を実行する

関連コード:

- `Tepora-app/backend-rs/src/graph/mod.rs`
- `Tepora-app/backend-rs/src/graph/nodes/supervisor.rs`
- `Tepora-app/backend-rs/src/graph/nodes/agent_executor.rs`

### 2.2 Skill の役割

Skill は executor に対する設定パッケージとして使われている。

- `choose_skill()` で Skill を選ぶ
- `map_selected_agent()` で `SelectedAgentRuntime` に変換する
- `agent_executor` は `skill_body` と `resource_prompt` を system prompt に注入する
- `tool_policy` で allowed / denied / require_confirmation を決める

関連コード:

- `Tepora-app/backend-rs/src/agent/skill_registry.rs`
- `Tepora-app/backend-rs/src/agent/execution.rs`
- `Tepora-app/backend-rs/src/agent/instructions.rs`

### 2.3 ツール列挙の現状

現在 executor がモデルに見せるツール一覧は次の2系統である。

- 静的 native tools
- 動的 MCP tools

`build_allowed_tool_list()` はこの2つを集約し、Skill の `tool_policy` で絞り込む。

関連コード:

- `Tepora-app/backend-rs/src/core/native_tools.rs`
- `Tepora-app/backend-rs/src/agent/execution.rs`

---

## 3. 問題設定

CLI 導入で必要なのは以下である。

1. エグゼクティブエージェントだけが使える
2. Skill に近い UX を持つ
3. 汎用 terminal は渡さない
4. MCP と競合せず共存する
5. `gh`、`aws`、`gcloud`、`kubectl` のような既存 CLI 能力を安全に取り込む
6. 設定は簡単だが、実行制御は厳格にする

---

## 4. 採用方針

### 4.1 中核方針

CLI は汎用 shell として公開しない。  
代わりに、**CLI profile という設定単位を runtime tool として公開する**。

モデルに見える道具は以下のような名前にする。

- `cli:github_search`
- `cli:github_repo_read`
- `cli:aws_read`
- `cli:gcloud_projects`

内部では各 profile が以下を持つ。

- 実バイナリ
- 許可 prefix
- cwd policy
- env policy
- 出力整形方針
- デフォルト引数
- リスクレベル

### 4.2 非採用方針

以下は採用しない。

- `run_shell_command` のような任意 command 実行をそのまま公開する方式
- Skill package 内の script を直接 executor が自由実行する方式
- フロントエンドの terminal / shell plugin をエージェントに直接渡す方式

理由:

- 現在の Tepora の承認・監査モデルと噛み合わない
- 実行境界が緩くなりすぎる
- Agent Mode の中央 executor 構造と合わない

---

## 5. 追加コンポーネント

### 5.1 `CliProfileManager`

新規追加。

責務:

- config から `cli_profiles` を読む
- profile を検証する
- runtime tool descriptor を列挙する
- profile 名から実行 spec を解決する

想定配置:

- `Tepora-app/backend-rs/src/cli/mod.rs`
- `Tepora-app/backend-rs/src/cli/profile_manager.rs`
- `Tepora-app/backend-rs/src/cli/types.rs`
- `Tepora-app/backend-rs/src/cli/runner.rs`

### 5.2 `CliRunner`

新規追加。

責務:

- profile を `Command::new()` に変換する
- shell を介さず `argv` 直接実行する
- timeout / stdout / stderr / exit_code を収集する
- JSON 優先出力を試みる
- 実行前に prefix 制約を検証する

### 5.3 `CliToolDescriptor`

MCP tool と同様に runtime で列挙される動的 tool descriptor。

最低限の項目:

- `name`
- `description`
- `input_schema`
- `source = cli`
- `risk_level`
- `profile_name`

---

## 6. データモデル案

### 6.1 アプリ設定

```json
{
  "cli_profiles": {
    "github_search": {
      "enabled": true,
      "bin": "gh",
      "description": "Search GitHub issues, PRs, and repositories via GitHub CLI",
      "allowed_prefixes": [
        ["search", "issues"],
        ["search", "prs"],
        ["search", "repos"]
      ],
      "default_args": ["--limit", "20"],
      "json_mode": {
        "strategy": "append_flags",
        "flags": ["--json", "number,title,url,state,updatedAt"]
      },
      "cwd_policy": {
        "mode": "workspace"
      },
      "env_allowlist": ["GH_TOKEN", "GITHUB_TOKEN"],
      "timeout_ms": 20000,
      "risk_level": "medium"
    }
  }
}
```

### 6.2 ツール名

モデルに見せるツール名は `cli:<profile_name>` とする。

例:

- `cli:github_search`
- `cli:aws_read`

理由:

- native / mcp と衝突しにくい
- Skill metadata に書きやすい
- alias 解決しやすい

### 6.3 ツール入力 schema

CLI ツールの入力は自由文字列ではなく、構造化する。

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "args": {
      "type": "array",
      "items": { "type": "string" }
    },
    "cwd": {
      "type": ["string", "null"]
    },
    "reason": {
      "type": ["string", "null"]
    }
  },
  "required": ["args"]
}
```

`command` 文字列は受け取らない。

---

## 7. Skill 連携案

### 7.1 最小変更案

既存 `tool_policy.allowed_tools` をそのまま使う。

```yaml
tool_policy:
  allowed_tools:
    - cli:github_search
    - native_search
```

この方式なら `CustomToolPolicy` の構造を大きく壊さずに導入できる。

### 7.2 将来拡張案

読みやすさのため、将来的には frontmatter に `allowed_cli_profiles` を追加してもよい。

```yaml
allowed_cli_profiles:
  - github_search
  - aws_read
```

内部ではロード時に `cli:<profile>` に変換する。

### 7.3 Skill resource との関係

Skill package 内の `references/` や `scripts/` は引き続き prompt resource であり、CLI の実体ではない。  
CLI profile は skill package に埋め込まず、グローバル設定または workspace 設定から参照する。

理由:

- Skill の portability を保ちやすい
- バイナリの有無を skill package に閉じ込めない
- 実行権限を Skill 保存物から分離できる

---

## 8. 実行フロー

### 8.1 ツール列挙

1. `native_tools`
2. `mcp.list_tools()`
3. `cli_profile_manager.list_tools()`
4. `tool_policy` でフィルタ
5. `agent_instructions` に注入

`build_allowed_tool_list()` を次のように拡張する。

- 戻り値を `tool_list, mcp_tool_set, cli_tool_set` にする
- もしくは `ToolCatalog` 構造体に置き換える

### 8.2 実行時

1. executor が `tool_call` を受け取る
2. `cli:<profile>` なら `CliProfileManager` で解決
3. prefix 制約を検証
4. cwd 制約を検証
5. 承認対象の scope を解決
6. `CliRunner` が direct exec
7. 結果を `ToolExecution` に詰める
8. scratchpad / history / activity に反映

### 8.3 承認単位

初期実装では `PermissionScopeKind::NativeTool` を流用できるが、最終的には専用 scope を追加した方が良い。

推奨:

- `cli_profile`
- 必要なら将来的に `cli_prefix`

理由:

- `native_tool` だと CLI の粒度が粗すぎる
- `cli:github_search` と `cli:aws_write` は別物として扱いたい

---

## 9. セキュリティ設計

### 9.1 必須制約

- `shell -c` を禁止する
- 実行は必ず `Command::new(bin)` + `args`
- profile の `allowed_prefixes` は token 単位で検証する
- `cwd` は policy に従い workspace 配下だけ許可する
- env は allowlist 方式
- timeout 必須
- stdout/stderr はサイズ制限必須

### 9.2 prefix 検証

`starts_with("gh")` のような文字列判定は使わない。  
以下の形で比較する。

```text
bin = "gh"
allowed_prefix = ["search", "issues"]
user_args = ["search", "issues", "label:bug"]
```

このとき、`user_args` の先頭トークン列が `allowed_prefix` と一致した場合のみ許可する。

禁止例:

- `gh api ...`
- `gh extension ...`
- `gh auth ...`
- `bash -lc "gh search issues ..."`

### 9.3 cwd policy

最低限以下を持つ。

- `workspace`
- `profile_default`
- `fixed`

初期実装は `workspace` と `fixed` で十分。

### 9.4 env policy

env は profile 単位に allowlist を持つ。

例:

- `GH_TOKEN`
- `AWS_PROFILE`
- `GOOGLE_APPLICATION_CREDENTIALS`

モデルから任意 env を注入させない。

---

## 10. 出力設計

### 10.1 `ToolExecution` 拡張

現在 `ToolExecution` はほぼ text result 前提なので、CLI 導入時に拡張する。

追加候補:

- `stdout: String`
- `stderr: String`
- `exit_code: Option<i32>`
- `duration_ms: u64`
- `truncated: bool`
- `structured_output: Option<Value>`
- `execution_kind: "native" | "mcp" | "cli"`

### 10.2 JSON 優先

CLI profile は可能なら JSON 出力を優先する。

例:

- `gh --json ...`
- `aws --output json`
- `gcloud --format=json`

JSON が取れた場合:

- `structured_output` に保存
- `output` は簡潔な要約テキストを返す

JSON がない場合:

- `stdout` をサイズ制限つきで text fallback

---

## 11. API / UI 変更

### 11.1 `/api/tools`

`ToolSource` に `Cli` を追加する。

現在:

- `native`
- `mcp`

変更後:

- `native`
- `mcp`
- `cli`

### 11.2 Settings

CLI profile 管理 UI を追加する。

最低限必要な項目:

- profile 名
- 説明
- binary
- allowed prefixes
- cwd policy
- env allowlist
- timeout
- enabled

### 11.3 承認ダイアログ

CLI 実行時は以下を出す。

- profile 名
- 実バイナリ
- 正規化後 argv
- cwd
- リスクレベル
- 保存対象 scope

---

## 12. 実装ステップ

### Phase 1: MVP

- `CliProfileManager` 追加
- config に `cli_profiles` 追加
- `/api/tools` に `cli` source を追加
- `build_allowed_tool_list()` に CLI profile tool を合流
- `execute_tool()` に `cli:<profile>` 分岐を追加
- `ToolExecution` を拡張
- 承認はひとまず `native_tool` 扱い

### Phase 2: Skill 連携強化

- `allowed_cli_profiles` frontmatter 追加
- alias 解決に `cli:` 対応を追加
- CLI profile ごとの descriptions / schema を改善

### Phase 3: セキュリティ強化

- `PermissionScopeKind::CliProfile` 追加
- trusted workspace 概念追加
- 実行ログと監査イベントを CLI 用に拡張

### Phase 4: 高度化

- background process / PTY session
- 長時間 job の read / write / kill
- CLI profile bundle の import / export

---

## 13. 初期提供 profile の推奨

最初から write 系を増やしすぎない。  
初期は read-heavy な profile に限定する。

推奨:

- `github_search`
- `github_repo_read`
- `aws_read`
- `gcloud_read`

後回し:

- `gh api`
- `gh copilot`
- `aws` の write 系
- `kubectl apply`
- `terraform apply`

---

## 14. 最終判断

Tepora の CLI 導入は、Agent Skills をそのまま実行器として拡張する話ではない。  
**現在の中央 executor アーキテクチャに、Skill 互換の見た目を持つ動的 CLI tools を追加する話**である。

そのための正しい実装単位は以下。

- SkillRegistry の大改造ではない
- 汎用 shell 公開でもない
- `agent_executor` に合流する `CLIProfileManager` と `CliRunner` である

この設計なら、以下を同時に満たせる。

- Executive Agent 限定
- Skill ライクな使い勝手
- MCP との共存
- CLI 生態系の即時活用
- 汎用 terminal を渡さない安全性

