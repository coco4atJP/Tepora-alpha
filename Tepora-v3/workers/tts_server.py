"""Optional loopback WAV speech adapter. No packages/models are installed here.

MOSS: installed official OrtCpuRuntime + complete local ONNX model/codec, explicit built-in voice.
Qwen: installed qwen-tts + complete local CustomVoice checkpoint.
Kokoro: installed kokoro/misaki[ja], local config.json, kokoro-v1_0.pth,
and voices/jf_alpha.pt. CPU is the default; CUDA is explicit. No MPS/MLX claim.
"""
import argparse
import array
import hmac
import io
import json
import math
import os
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

QWEN_MODEL = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"


def pcm_wav(samples, rate, channels=1):
    if channels not in (1, 2) or not isinstance(rate, int) or not 8000 <= rate <= 48000:
        raise ValueError("Invalid sample rate")
    values = array.array("h")
    for sample in samples:
        value = float(sample)
        if not math.isfinite(value) or len(values) >= rate * 120 * channels:
            raise ValueError("Invalid or oversized generated audio")
        values.append(round(max(-1, min(1, value)) * 32767))
    if not values or len(values) % channels:
        raise ValueError("No audio generated")
    if sys.byteorder != "little":
        values.byteswap()
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(values.tobytes())
    return output.getvalue()


def load_backend(kind, directory, device, runtime_directory=None, voice=None):
    if kind == "moss":
        if device != "cpu":
            raise ValueError("This MOSS adapter uses CPU ONNX only")
        from moss_backend import load_moss
        return load_moss(directory, runtime_directory, voice, pcm_wav)
    root = Path(directory).resolve()
    if not root.is_dir() or not (root / "config.json").is_file():
        raise ValueError("Supply a complete, explicitly installed local model directory")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    if kind == "qwen":
        import torch
        from qwen_tts import Qwen3TTSModel
        model = Qwen3TTSModel.from_pretrained(str(root), device_map=device,
                    dtype=torch.float32 if device == "cpu" else torch.bfloat16,
                    local_files_only=True)

        def generate(text):
            with torch.inference_mode():
                audio, rate = model.generate_custom_voice(text=text, language="Japanese", speaker="Ono_Anna")
            return pcm_wav(audio[0], rate)
        return QWEN_MODEL, "Ono_Anna", generate
    weights, voice = root / "kokoro-v1_0.pth", root / "voices" / "jf_alpha.pt"
    if not weights.is_file() or not voice.is_file():
        raise ValueError("Install Kokoro weights and voices/jf_alpha.pt explicitly")
    from kokoro import KModel, KPipeline
    model = KModel(repo_id="hexgrad/Kokoro-82M", config=str(root / "config.json"), model=str(weights)).to(device).eval()
    pipeline = KPipeline(lang_code="j", repo_id="hexgrad/Kokoro-82M", model=model)

    def generate(text):
        def samples():
            for _, _, audio in pipeline(text, voice=str(voice)):
                yield from audio.detach().cpu().numpy()
        return pcm_wav(samples(), 24000)
    return "kokoro", "jf_alpha", generate


def make_server(model, voice, generate, port=8880, token=""):
    admission = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def address_string(self):
            return self.client_address[0]

        def log_message(self, *_args):
            pass

        def send(self, status, data, content_type="application/json"):
            if not isinstance(data, bytes):
                data = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_POST(self):
            expected = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
            if self.headers.get("Host") not in expected or self.headers.get("Origin"):
                return self.send(403, {"error": "Backend loopback requests only"})
            if token and not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                return self.send(401, {"error": "Unauthorized"})
            if self.path != "/v1/audio/speech":
                return self.send(404, {"error": "Unknown route"})
            try:
                size = int(self.headers.get("Content-Length", "-1"))
                if not 0 < size <= 24000:
                    return self.send(413, {"error": "Bounded JSON required"})
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict) or body.get("model") != model or body.get("voice") != voice or set(body) - {"model", "voice", "input", "response_format"}:
                    return self.send(400, {"error": "Use the loaded model and Japanese voice"})
                if body.get("response_format", "wav") != "wav":
                    return self.send(400, {"error": "Choose WAV in the Tepora speech profile"})
                text = body.get("input")
                if not isinstance(text, str) or not text.strip() or len(text) > 4000:
                    return self.send(400, {"error": "Use 1–4000 characters"})
            except (ValueError, TypeError, UnicodeError):
                return self.send(400, {"error": "Invalid request"})
            if not admission.acquire(blocking=False):
                return self.send(429, {"error": "Speech model is busy; no request was queued"})
            try:
                self.send(200, generate(text), "audio/wav")
            except Exception:
                self.send(500, {"error": "Local synthesis failed; no cloud fallback"})
            finally:
                admission.release()

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=["moss", "qwen", "kokoro"], required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--runtime-dir", help="MOSS repository containing ort_cpu_runtime.py")
    parser.add_argument("--voice", help="Explicit installed MOSS built-in voice ID")
    parser.add_argument("--list-voices", action="store_true", help="Read MOSS local manifest only; do not load models")
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--port", type=int, default=8880)
    args = parser.parse_args()
    if args.list_voices:
        from moss_backend import builtin_voices
        print(json.dumps(builtin_voices(args.model_dir), ensure_ascii=False))
        return
    model, voice, generate = load_backend(args.backend, args.model_dir, args.device, args.runtime_dir, args.voice)
    server = make_server(model, voice, generate, args.port, os.environ.get("TEPORA_TTS_KEY", ""))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
