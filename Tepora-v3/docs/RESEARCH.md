# Implementation research notes

Checked 2026-09-26. Primary sources below guided contracts and boundaries. Upstream benchmarks are not reproduced results from this application.

## vLLM and Windows

vLLM's official installation documentation describes Linux as the GPU platform; Windows is not a native first-class target. Therefore the default Windows-local option remains llama.cpp, while vLLM is a WSL/compatible-host option, not a mandatory installer step.

- https://docs.vllm.ai/en/latest/getting_started/installation/gpu/
- https://github.com/ggml-org/llama.cpp/tree/master/tools/server

## DiffusionGemma and Jev-like structured decisions

The referenced vLLM PR #57250 was checked as merged. It adds examples and a structured-generation approach for DiffusionGemma. Its example wrapper accepts `/v1/systemone` with `{model,state,questions}`; each choice question has `type`, `instructions`, and `criteria`. This is not evidence that ordinary vLLM servers accept this endpoint directly, nor that TypeSafe Jev's hosted product is open-source or can be installed locally.

- https://github.com/vllm-project/vllm/pull/57250
- https://github.com/vllm-project/vllm/blob/main/examples/features/structured_diffusion/structured_server.py

The example inspected uses `google/diffusiongemma-26B-A4B-it`. The total model footprint is not the same as the active-parameter count. No 8GB-GPU fit, speed, calibration, or correctness claim is made here. The integration is optional and advisory; security authorization remains explicit user policy.

## Speech recognition

Qwen3-ASR-1.7B supports Japanese and other languages and has an open model card with quality measurements. The original `qwen_asr` loader supports the explicit model choice used by the adapter. This makes it a defensible quality-focused starting point, not a universal “best” model for the user's microphone, proper nouns or room acoustics.

The lighter Qwen3-ASR-0.6B can use the same adapter with a changed model ID. faster-whisper offers a different, widely used CTranslate2 inference route, including CPU int8, and is used as a fallback installation choice rather than silently replacing the selected model.

- https://huggingface.co/Qwen/Qwen3-ASR-1.7B
- https://github.com/QwenLM/Qwen3-ASR
- https://huggingface.co/docs/transformers/main/model_doc/qwen3_asr
- https://github.com/SYSTRAN/faster-whisper
- https://github.com/ggml-org/whisper.cpp

The Transformers-native `*-hf` checkpoints are a distinct loading route from the original checkpoint used with `qwen_asr`. They must not be interchanged blindly. The current adapter is not ONNX-based. No fabricated Japanese WER/latency comparison is included; a target-device evaluation set is a release gate.

## MCP / skills / asynchronous harness

The client supports core tools over stdio and Streamable HTTP. It negotiates the 2025-11-25 protocol shape, but does not claim to implement every feature in that protocol or newer Tasks extensions. Asynchronous task ownership belongs to Tepora's harness in this beta. Sampling and server-initiated privileged requests are not enabled.

- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- https://agentskills.io/specification
- https://github.com/coco4atJP/mcp-context-hub

The user's Context Hub already provides lazy discovery, a fixed five-tool surface, and device-specific safety around synchronization. Register it as an MCP server rather than copying or weakening that policy. Skill Markdown can be exported; the current store is not a complete implementation of every optional skill package convention.

## Media and ambient information

Brave Shields is part of the Brave browser, not a plugin that automatically applies to Tauri's WebView2/WKWebView. A separate Brave app-mode window can use Shields under its own profile. YouTube behavior changes; ad blocking, login and background playback are not guaranteed. The app itself does not provide a YouTube ad-blocking engine.

- https://support.brave.com/hc/en-us/articles/360022806212-How-do-I-use-Shields-while-browsing
- https://developers.google.com/youtube/player_parameters
- https://open-meteo.com/en/terms
- https://open-meteo.com/en/docs

Open-Meteo's free service has non-commercial terms and attribution requirements. It is not correct to promise cost-free commercial operation for every deployment. RSS has no mandatory aggregator, but each publisher's terms and availability remain relevant.

## Native boundary

Tauri's sidecar mechanism permits bundling a runtime without granting frontend shell permissions. The supplied native host follows that pattern; target builds and WebView-specific integration must still be validated.

- https://v2.tauri.app/develop/sidecar/
- https://v2.tauri.app/security/capabilities/
- https://v2.tauri.app/distribute/

## Repository baseline observations

The current Tepora-alpha README identifies a v0.4.5 beta and documents the Rust/Axum + React/Tauri architecture. Existing provider abstraction already goes beyond llama.cpp. The V3 request's “local/llama-only” assumption was not used as a reason to remove that portability. The new isolated adapter includes local compatible servers and explicit cloud consent.
