# Model connections (beta.11)

> This document describes the retained legacy/manual connection layer. New cloud connections use the actual [pi-ai SDK integration](PI-AI.md), with its own multi-provider OAuth flow and credential store. The 22 templates below are not the pi-ai provider limit.

## Ordinary service / desktop

Open **Settings → AI connection → 知能と通信の使い分け**. The existing protocol adapters and Tepora's harness remain in use; no third-party agent runtime replaces the conversation, memory, or tools.

- The connection editor includes 22 templates: local Ollama, llama.cpp, vLLM and LM Studio; OpenAI, Anthropic, Gemini, OpenRouter, Vercel AI Gateway, Groq, Cerebras, Together, Fireworks, NVIDIA, DeepSeek, Mistral, xAI, Moonshot, Z.ai and OpenCode Go; user-managed CLIProxyAPI and LiteLLM. Templates only fill protocol/domain/base URL. Select a model yourself and check actual account/model support. Azure/Bedrock/Vertex-specific authentication is not implemented by these templates.
- API keys remain scoped to the saved endpoint/protocol. The **モデル一覧** button performs a user-approved catalog request, not inference or proof of entitlement. Manual model IDs remain available. Server catalogs have a 500-model display cap; pagination and every provider's specialized catalog API are not implemented.
- CLIProxyAPI/LiteLLM are optional user-managed endpoints. Tepora does not install, launch, update, or authenticate these proxies, read their credentials, or bypass their upstream terms. A loopback proxy may forward to the internet; Tepora's network mode cannot firewall another process.

## ChatGPT sign-in

ChatGPT sign-in is pi-ai's OpenAI OAuth (`openai` / `openai-codex`) on both the ordinary host and the standalone Rust host: **アカウントでログイン → サービスを選ぶ**. See [PI-AI](PI-AI.md). Account and API-key profiles still cannot share an automatic fallback chain, and no paid API key is an automatic escape from a subscription limit.

Tepora's former own sign-in (`authMode: "chatgpt"`, `core/provider-auth.mjs`, `/api/provider-auth*`) is retired. A saved profile of that kind stays visible as **再ログインが必要**, is never dispatched or reinterpreted as an API-key profile on either host, and can be deleted in the editor; register the account again through pi-ai. A leftover `<Tepora data directory>/credentials/chatgpt.json` is no longer read and may be deleted by the user. `tests/fixtures/retired-sign-in-profile.json` is shared by the Node and Rust regression tests.
