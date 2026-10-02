> Historical Earlier V3 beta document. The current release is **3.0.0-beta.11**; use the [current guide](../../../README.md). This record does not describe the default application.

# Primary references checked for beta.8 — 2026-09-29

These are integration specifications, not proof of Tepora's runtime quality. No community
benchmark numbers from the supplied Grok writeup are recast as Tepora measurements.

- OpenCode providers / optional AI SDK and models.dev background:
  https://opencode.ai/docs/providers/
- models.dev metadata and source:
  https://models.dev/
  https://github.com/anomalyco/models.dev
  Treat metadata as data, not packages to execute or independently probed model capabilities.
- Codex official App Server managed authentication:
  https://developers.openai.com/codex/app-server
  account/read, account/login/start (chatgpt/chatgptDeviceCode), account/login/completed,
  account/login/cancel. Account type matters; an existing API key is not a ChatGPT subscription.
- OpenCode Go usage/identification/session requirements:
  https://opencode.ai/docs/go/
  Other coding agents allowed under the documented traffic rules. Requires own user-agent and
  stable x-opencode-session. Provider-side use-balance fallback can add charges. Not implemented
  as a general unlimited plan in this release.
- Claude Agent SDK authentication restrictions:
  https://platform.claude.com/docs/en/agent-sdk/overview
  Third-party subscription OAuth offerings require prior approval. No credential extraction here.
- Z.AI coding-plan scope and endpoints:
  https://zcode.z.ai/en/docs/configuration
  https://zcode.z.ai/en/docs/qa
  Coding plan and general token-balance API are distinct; no scope/billing equivalence assumed.
- Speech, embeddings, image API contracts:
  https://platform.openai.com/docs/api-reference/audio/createSpeech
  https://platform.openai.com/docs/api-reference/embeddings/create
  https://platform.openai.com/docs/api-reference/images
- xAI asynchronous video generation (text/image inputs and request polling):
  https://docs.x.ai/developers/model-capabilities/video/generation
  https://x.ai/api/imagine
  The retired OpenAI Videos API is not used by the new video adapter.
- LocalJev typed protocol, Laya and closed-set browser examples:
  https://github.com/githubnext/localjev
  https://huggingface.co/convaiinnovations/laya-multilingual
  https://github.com/NandhaKishorM/laya
  https://github.com/browser-use/jev-ultrafast
  https://github.com/ipenywis/laya-ultrafast
  Candidate budgets, calibration and runtime support differ. Compatible HTTP schemas are not
  interchangeable learned-model performance. No citation is used to call every legal candidate safe.
