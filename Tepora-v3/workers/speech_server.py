"""Qwen3-ASR native streaming adapter. Local endpoint, explicit capture, no cloud fallback.
The Qwen backend needs a supported vLLM environment (Windows: WSL/another supported host).
This module can be contract-tested without downloading any model or importing PyTorch.
"""
import argparse
import array
import base64
import hmac
import json
import math
import os
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class AudioSessions:
    def __init__(self, backend):
        self.backend = backend
        self.sessions = {}
        self.lock = threading.Lock()

    def start(self, sample_rate=16000):
        if sample_rate != 16000:
            raise ValueError("Expected 16000 Hz")
        with self.lock:
            now = time.monotonic()
            self.sessions = {k: v for k, v in self.sessions.items() if now - v["at"] < 120}
            if self.sessions:
                raise BlockingIOError("An audio session is active")
            sid = uuid.uuid4().hex
            self.sessions[sid] = {"state": self.backend.start(), "next": 0, "last": None,
                                  "samples": 0, "at": now, "lock": threading.Lock()}
            return {"session_id": sid}

    def get(self, sid):
        value = self.sessions.get(sid)
        if value is None or time.monotonic() - value["at"] > 120:
            self.sessions.pop(sid, None)
            raise ValueError("Audio session expired")
        return value

    def chunk(self, session_id, sequence, pcm):
        session = self.get(session_id)
        if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 0:
            raise ValueError("Invalid audio sequence")
        if not isinstance(pcm, str) or len(pcm) > 90000:
            raise ValueError("Invalid PCM")
        if session["last"] and session["last"][0] == sequence:
            if session["last"][1] != pcm:
                raise ValueError("Duplicate sequence with different data")
            return session["last"][2]
        if not session["lock"].acquire(blocking=False):
            raise BlockingIOError("Audio is still processing")
        try:
            if sequence != session["next"]:
                raise ValueError("Out-of-order audio")
            data = base64.b64decode(pcm, validate=True)
            if not data or len(data) % 4 or len(data) > 64000:
                raise ValueError("Invalid audio size")
            values = array.array("f")
            values.frombytes(data)
            if sys.byteorder != "little":
                values.byteswap()
            if any(not math.isfinite(v) or abs(v) > 1.01 for v in values):
                raise ValueError("Invalid audio sample")
            if session["samples"] + len(values) > 16000 * 120:
                raise ValueError("Audio budget exhausted")
            text = self.backend.chunk(values, session["state"])
            if not isinstance(text, str) or len(text) > 32000:
                raise ValueError("Invalid transcript")
            result = {"text": text, "final": False}
            session["next"] += 1
            session["samples"] += len(values)
            session["at"] = time.monotonic()
            session["last"] = (sequence, pcm, result)
            return result
        finally:
            session["lock"].release()

    def finish(self, session_id):
        session = self.get(session_id)
        if not session["lock"].acquire(blocking=False):
            raise BlockingIOError("Audio is still processing")
        try:
            text = self.backend.finish(session["state"])
            if not isinstance(text, str) or len(text) > 32000:
                raise ValueError("Invalid transcript")
            return {"text": text, "final": True}
        finally:
            self.sessions.pop(session_id, None)
            session["lock"].release()

    def cancel(self, session_id):
        self.sessions.pop(session_id, None)
        return {"cancelled": True}


class QwenStreaming:
    def __init__(self, model, gpu_memory_utilization=0.25):
        from qwen_asr import Qwen3ASRModel
        self.asr = Qwen3ASRModel.LLM(model=model,
                   gpu_memory_utilization=gpu_memory_utilization, max_new_tokens=64)

    def start(self):
        return self.asr.init_streaming_state(
            unfixed_chunk_num=4, unfixed_token_num=5, chunk_size_sec=0.5
        )

    def chunk(self, samples, state):
        import numpy as np
        self.asr.streaming_transcribe(np.asarray(samples, dtype=np.float32), state)
        return getattr(state, "text", "") or ""

    def finish(self, state):
        self.asr.finish_streaming_transcribe(state)
        return getattr(state, "text", "") or ""


def make_server(backend, port=0, token=""):
    sessions = AudioSessions(backend)

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def log_message(self, *_):
            pass

        def reply(self, status, value):
            data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)

        def permitted(self):
            expected = {f"localhost:{self.server.server_port}",
                        f"127.0.0.1:{self.server.server_port}"}
            if self.headers.get("Origin") or self.headers.get("Host") not in expected:
                self.reply(403, {"error": "Origin or Host rejected"})
                return False
            if token and not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                self.reply(401, {"error": "Authentication required"})
                return False
            return True

        def do_GET(self):
            if not self.permitted():
                return
            if self.path != "/health":
                return self.reply(404, {"error": "Not found"})
            self.reply(200, {"ready": True, "streaming": True, "local": True})

        def do_POST(self):
            if not self.permitted():
                return
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                return self.reply(415, {"error": "Use application/json"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 100000:
                    return self.reply(413, {"error": "Audio request exceeds budget"})
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError("Expected JSON object")
                if self.path == "/api/start":
                    result = sessions.start(body.get("sample_rate", 16000))
                elif self.path == "/api/chunk":
                    result = sessions.chunk(body.get("session_id"), body.get("sequence"), body.get("pcm"))
                elif self.path == "/api/finish":
                    result = sessions.finish(body.get("session_id"))
                elif self.path == "/api/cancel":
                    result = sessions.cancel(body.get("session_id"))
                else:
                    return self.reply(404, {"error": "Not found"})
                self.reply(200, result)
            except BlockingIOError:
                self.reply(429, {"error": "Audio worker is busy"})
            except (ValueError, TypeError, KeyError):
                self.reply(422, {"error": "Invalid audio request"})
            except Exception:
                self.reply(503, {"error": "Local speech failed; no cloud fallback was used"})

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8768)
    p.add_argument("--model", required=True, help="Path to an explicitly installed Qwen3-ASR checkpoint")
    p.add_argument("--gpu-memory-utilization", type=float, default=0.25)
    args = p.parse_args()
    if not os.path.isdir(args.model):
        p.error("Install the checkpoint explicitly and supply a local model directory")
    if not 0.05 <= args.gpu_memory_utilization <= 0.8:
        p.error("GPU allocation must be between 0.05 and 0.8")
    os.environ["HF_HUB_OFFLINE"] = "1"
    backend = QwenStreaming(args.model, args.gpu_memory_utilization)
    server = make_server(backend, args.port, os.environ.get("TEPORA_SPEECH_TOKEN", ""))
    print(json.dumps({"ready": True, "port": server.server_port, "streaming": True}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
