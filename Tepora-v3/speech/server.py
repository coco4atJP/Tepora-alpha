"""Optional, loopback-only ASR adapter. Model inference has NOT been hardware-validated here.

Install only the backend you select; see README. The browser sends PCM WAV to Tepora,
which forwards it here. Audio is removed after inference; model downloads are explicit.
"""
from __future__ import annotations
import argparse
import asyncio
import io
import os
import secrets
import tempfile
import wave
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
import uvicorn

MAX_BYTES = 12 * 1024 * 1024

def make_transcriber(backend: str, model_id: str, device: str):
    if backend == "faster-whisper":
        from faster_whisper import WhisperModel
        model = WhisperModel(model_id, device=device, compute_type="int8" if device == "cpu" else "float16")
        def transcribe(path: str, language: str) -> str:
            segments, _ = model.transcribe(path, language=language or None, vad_filter=True, beam_size=5)
            return "".join(segment.text for segment in segments).strip()
        return transcribe
    import torch
    from qwen_asr import Qwen3ASRModel
    model = Qwen3ASRModel.from_pretrained(
        model_id, dtype=torch.float32 if device == "cpu" else torch.bfloat16,
        device_map=device, max_inference_batch_size=1, max_new_tokens=1024,
    )
    def transcribe(path: str, language: str) -> str:
        language_name = {"ja": "Japanese", "en": "English", "zh": "Chinese"}.get(language, language or None)
        result = model.transcribe(audio=path, language=language_name)
        return result[0].text if result else ""
    return transcribe

def create_app(transcriber: Any, model_id: str, port: int, api_key: str = "") -> FastAPI:
    app = FastAPI(title="Tepora local ASR", docs_url=None, redoc_url=None)
    lock = asyncio.Lock()

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if request.headers.get("host") not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
            return JSONResponse({"detail": "Invalid Host"}, status_code=403)
        # No browser origin is allowed; only the local Tepora backend should call this adapter.
        if request.headers.get("origin"):
            return JSONResponse({"detail": "Browser requests are not accepted directly"}, status_code=403)
        if api_key and not secrets.compare_digest(request.headers.get("authorization", ""), f"Bearer {api_key}"):
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
        if request.method == "POST":
            try:
                length = int(request.headers.get("content-length", "-1"))
            except ValueError:
                length = -1
            if not 0 < length <= MAX_BYTES + 8192:
                return JSONResponse({"detail": "A bounded Content-Length is required"}, status_code=413)
        return await call_next(request)

    @app.get("/health")
    async def health():
        return {"ok": True, "model": model_id, "ready": True}

    @app.post("/v1/audio/transcriptions")
    async def transcribe(file: UploadFile = File(...), model: str = Form(""), language: str = Form("ja"), response_format: str = Form("json")):
        if model and model not in {model_id, "default"}:
            raise HTTPException(400, f"This server loaded {model_id}; update the ASR model setting.")
        if response_format != "json":
            raise HTTPException(400, "Only response_format=json is supported")
        audio = await file.read(MAX_BYTES + 1)
        await file.close()
        if len(audio) > MAX_BYTES:
            raise HTTPException(413, "Audio too large")
        try:
            with wave.open(io.BytesIO(audio)) as wav:
                if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() < 8000:
                    raise ValueError("Use mono 16-bit PCM WAV")
                if wav.getnframes() / wav.getframerate() > 65:
                    raise ValueError("Audio duration exceeds 65 seconds")
        except (wave.Error, EOFError, ValueError) as exc:
            raise HTTPException(400, str(exc)) from exc
        if lock.locked():
            raise HTTPException(429, "ASR is busy. Please try again after the current recording finishes.")
        async with lock:
            filename = ""
            try:
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp:
                    temp.write(audio)
                    filename = temp.name
                result = await asyncio.to_thread(transcriber, filename, language)
                return {"text": result, "model": model_id}
            except Exception as exc:
                raise HTTPException(500, "ASR inference failed; inspect the local adapter console.") from exc
            finally:
                if filename:
                    Path(filename).unlink(missing_ok=True)
    return app

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=["qwen", "faster-whisper"], default="qwen")
    parser.add_argument("--model", default="")
    parser.add_argument("--device", default="cpu", help="cpu or cuda; other devices are not validated")
    parser.add_argument("--port", type=int, default=8012)
    args = parser.parse_args()
    model = args.model or ("Qwen/Qwen3-ASR-1.7B" if args.backend == "qwen" else "turbo")
    print(f"Loading {model} on {args.device}. Missing weights may be downloaded by the selected library.", flush=True)
    transcriber = make_transcriber(args.backend, model, args.device)
    uvicorn.run(create_app(transcriber, model, args.port, os.environ.get("TEPORA_ASR_KEY", "")), host="127.0.0.1", port=args.port, access_log=False)

if __name__ == "__main__":
    main()
