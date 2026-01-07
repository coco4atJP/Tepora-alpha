# ARCHITECTURE.md コードレビュー (Created by GPT-5.2-high 2026/1/7)

1. **総合スコア (0-100点)**: 58点

2. **致命的な欠陥**:
- `docs/architecture/ARCHITECTURE.md:457`, `docs/architecture/ARCHITECTURE.md:463` モデル/バイナリのダウンロードAPIに整合性検証・許可リスト・署名検証の記載がなく、改ざんや悪性バイナリでRCEに直結する。必須: ピン留めリビジョンとSHA256検証を仕様に含める。
```python
ALLOWED_MODELS = {
    "gemma-3n-e4b": {
        "url": "https://huggingface.co/unsloth/gemma-3n-E4B-it-GGUF",
        "revision": "7b5c9f2",
        "sha256": "..."
    }
}

def verify_sha256(path: str, expected: str) -> None:
    if sha256_file(path) != expected:
        raise HTTPException(400, "sha256 mismatch")

@router.post("/api/setup/model/download")
def download_model(req: DownloadRequest):
    allowed = ALLOWED_MODELS.get(req.model_id)
    if not allowed:
        raise HTTPException(400, "model not allowed")
    path = download_with_revision(allowed["url"], allowed["revision"])
    verify_sha256(path, allowed["sha256"])
```
- `docs/architecture/ARCHITECTURE.md:142`, `docs/architecture/ARCHITECTURE.md:778` `react-markdown`の利用が明記されているが、サニタイズ方針がないためXSS経路が残る。Tauriはローカル権限を持つため影響が大きい。必須: HTML無効化 + サニタイズ。
```tsx
import ReactMarkdown from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

const schema = {
  ...defaultSchema,
  attributes: { ...defaultSchema.attributes, code: ["className"] },
};

<ReactMarkdown rehypePlugins={[[rehypeSanitize, schema]]} skipHtml>
  {message}
</ReactMarkdown>;
```
- `docs/architecture/ARCHITECTURE.md:408` `POST /api/shutdown` が認可/認証の記載なし。ローカルでも他プロセスや同一ネットワークから容易にDoSが可能。必須: 管理トークンとローカルバインドを仕様に含める。
```python
from fastapi import Depends, Header, HTTPException

def require_admin(x_admin_token: str = Header(...)):
    if x_admin_token != settings.admin_token:
        raise HTTPException(status_code=403, detail="forbidden")

@router.post("/api/shutdown")
def shutdown(_: None = Depends(require_admin)):
    ...
```
- `docs/architecture/ARCHITECTURE.md:943` Web検索(DuckDuckGo)が標準フローにあり、Local Firstと矛盾する。PII漏洩の可能性があるためデフォルト無効と明示的同意が必須。
```yaml
# config.yml
privacy:
  allow_web_search: false
  redact_pii: true
```
```python
if not settings.privacy.allow_web_search:
    raise HTTPException(403, "web_search disabled")
```

3. **コードの悪臭 (Code Smells)**:
- `docs/architecture/ARCHITECTURE.md:176`, `docs/architecture/ARCHITECTURE.md:198`, `docs/architecture/ARCHITECTURE.md:313` ルート構成で `Tepora-app/` が示されている一方、後続で `backend/` と `frontend/` をルート直下として記述しており構造が不明確。仕様の読み違いを誘発する。
```md
Tepora_Project/
└── Tepora-app/
    ├── backend/
    └── frontend/

### 4.2 バックエンド構造 (Tepora-app/backend/)
### 4.3 フロントエンド構造 (Tepora-app/frontend/)
```
- `docs/architecture/ARCHITECTURE.md:474`, `docs/architecture/ARCHITECTURE.md:919` WebSocketの `mode` が `direct` なのにモード説明は `CHAT` 表記で不一致。クライアント/サーバー実装の齟齬を招く。
```json
{
  "message": "user text",
  "mode": "chat" | "search" | "agent"
}
```
- `docs/architecture/ARCHITECTURE.md:9`, `docs/architecture/ARCHITECTURE.md:1147`, `docs/architecture/ARCHITECTURE.md:1172`, `docs/architecture/ARCHITECTURE.md:1176`, `docs/architecture/ARCHITECTURE.md:1181` 「??」「?」のプレースホルダが残っており、仕様の確定度が不明になる。確定値に置換するか削除すること。
```md
## 目次

### 10.1 Phase 1: Foundation (2025年11月)
| 平均ファイルサイズ | 400行 | 150行 | -62.5% |
```
- `docs/architecture/ARCHITECTURE.md:134`, `docs/architecture/ARCHITECTURE.md:149` 技術スタックのバージョンが手書きで、実体(`package.json`/`pyproject.toml`)との乖離が起きる。生成スクリプト化が必要。
```python
import json, tomllib

pkg = json.load(open("frontend/package.json", "r", encoding="utf-8"))
py = tomllib.load(open("backend/pyproject.toml", "rb"))
print(pkg["dependencies"]["react"], py["project"]["dependencies"])
```
- `docs/architecture/ARCHITECTURE.md:890` `identifier` が `com.tauri.dev` のまま。配布時の署名・更新経路が衝突するため、実運用の識別子に固定すべき。
```json
{
  "identifier": "jp.tepora.app"
}
```
