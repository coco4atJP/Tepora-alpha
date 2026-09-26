# Tepora V3.0 Beta

V3 lives in [`Tepora-v3/`](Tepora-v3/README.md). The existing V2 application and its data model are unchanged.

Start the local source edition with Node 22.16 or later:

```sh
cd Tepora-v3
node core/server.mjs --open
```

Create a standalone, model-free visual preview:

```sh
node scripts/build-preview.mjs
```

The beta includes a rich companion UI, asynchronous chat/work lanes, streamed artifacts, local/compatible-cloud model adapters, guarded CLI tools, memory, MCP, skills, optional ASR and ambient connectors, and a Tauri native host.

This is not a signed, model-bundled, fully plug-and-play release. Native target builds, actual GPU models, microphone/media integration, advanced memory migration and unattended agent operation remain acceptance gates. See [`STATUS`](Tepora-v3/docs/STATUS.md), [`QA`](Tepora-v3/docs/QA.md) and [`ARCHITECTURE`](Tepora-v3/docs/ARCHITECTURE.md).
