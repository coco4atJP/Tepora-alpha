# Primary implementation sources checked 2026-09-27

- Codex App Server: https://learn.chatgpt.com/docs/app-server
  Used official initialize/initialized, thread/start/resume, turn/start/steer/interrupt and approvals.
  Restrict read roots and workspace writes; do not turn API compatibility into a sandbox guarantee.
- Hermes architecture: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/architecture.md
- Hermes routine behavior: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/cron.md
  Retained reusable skills, durable routines, interruption and cross-session recall as implementation goals.
- Laya: https://github.com/NandhaKishorM/laya
- Multilingual checkpoint: https://huggingface.co/convaiinnovations/laya-multilingual
- Qwen streaming: https://github.com/QwenLM/Qwen3-ASR/blob/main/qwen_asr/cli/demo_streaming.py
- Tauri tray API: https://v2.tauri.app/learn/system-tray/

No upstream latency, accuracy or product-ranking number is presented as a Tepora measurement.
Muse/GrokBot are product-level references, not repackaged binaries or reverse-engineered login flows.


## beta.6 first-use integration

Primary API contracts used for the opt-in local setup flow:
- https://docs.ollama.com/api/pull — streamed model acquisition, success/error payloads.
- https://docs.ollama.com/api/tags — local name/digest list used before candidate activation.
- https://docs.ollama.com/windows — native runtime installation remains separate.
- https://ollama.com/library/qwen3:4b-instruct-2507-q4_K_M
- https://ollama.com/library/qwen3.5:4b

Catalog sizes are approximate download metadata, not measured inference performance or a
claim that these choices outperform newer models. Existing local models and advanced provider
configuration remain supported. Real transfer, model quality, and target-machine behavior were
not measured in this change; transport fixtures are explicitly labelled.
