"""Loopback-only, multilingual Laya worker. No tool execution or cloud fallback.
Run after installing workers/requirements-laya.txt in a dedicated environment.
Model acquisition is a separate, explicit --allow-download operation.
"""
import argparse
import hmac
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = "convaiinnovations/laya-multilingual"
MAX_BODY = 65536


class LayaBackend:
    def __init__(self, model_dir=None, device="cpu", revision=None, allow_download=False):
        if not allow_download:
            os.environ["HF_HUB_OFFLINE"] = "1"
        import torch
        import laya
        torch.set_num_threads(max(1, min(4, (os.cpu_count() or 2) // 2)))
        self.agent = laya.load(model_dir or MODEL_ID, device=device, revision=revision)
        self.model_id = MODEL_ID
        self.lock = threading.Lock()

    def predict(self, state, questions):
        if not self.lock.acquire(blocking=False):
            raise BlockingIOError("Decision worker is busy")
        try:
            # The multilingual checkpoint is fixed; no language heuristic may select English.
            result = self.agent.system_one(state, questions, max_len=8192, head_max_len=512)
            return {**result, "model": MODEL_ID, "advisory": True,
                    "calibration": "not-validated-for-Tepora"}
        finally:
            self.lock.release()


def validate_request(body):
    if not isinstance(body, dict):
        raise ValueError("Request must be an object")
    if body.get("model", "multilingual") not in ("multilingual", MODEL_ID):
        raise ValueError("This worker serves only laya-multilingual")
    state, questions = body.get("state"), body.get("questions")
    if not isinstance(state, (str, list, dict)) or not isinstance(questions, dict) or not 1 <= len(questions) <= 16:
        raise ValueError("State and 1-16 questions are required")
    for question in questions.values():
        if not isinstance(question, dict) or question.get("type") not in ("choice", "score", "noul"):
            raise ValueError("Invalid question")
        if question["type"] == "choice":
            options = question.get("criteria")
            if not isinstance(options, dict) or not 2 <= len(options) <= 16:
                raise ValueError("Shortlist 2-16 choices before inference")
        if question["type"] == "score":
            levels = question.get("criteria")
            if not isinstance(levels, list) or not 2 <= len(levels) <= 10 or any(x is None for x in levels):
                raise ValueError("Score needs 2-10 described levels")
    return state, questions


def make_server(backend, port=0, token=""):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_):
            pass  # Never put voice context, requests, or credentials in access logs.

        def reply(self, status, value):
            data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)

        def permitted(self):
            if self.headers.get("Origin") or self.headers.get("Host") not in (
                f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"
            ):
                self.reply(403, {"error": "Origin or Host rejected"})
                return False
            if token and not hmac.compare_digest(
                self.headers.get("Authorization", ""), "Bearer " + token
            ):
                self.reply(401, {"error": "Worker authentication required"})
                return False
            return True

        def do_GET(self):
            if not self.permitted():
                return
            if self.path != "/health":
                return self.reply(404, {"error": "Not found"})
            self.reply(200, {"ready": True, "model": MODEL_ID, "advisory": True})

        def do_POST(self):
            if not self.permitted():
                return
            if self.path != "/v1/systemone":
                return self.reply(404, {"error": "Not found"})
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                return self.reply(415, {"error": "Use application/json"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BODY:
                    return self.reply(413, {"error": "Request size exceeds budget"})
                body = json.loads(self.rfile.read(length))
                state, questions = validate_request(body)
                result = backend.predict(state, questions)
                self.reply(200, result)
            except BlockingIOError:
                self.reply(429, {"error": "Decision worker is busy"})
            except (ValueError, TypeError, KeyError):
                self.reply(422, {"error": "Invalid decision request or output"})
            except Exception:
                self.reply(503, {"error": "Local inference failed; no cloud fallback was used"})

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8767)
    parser.add_argument("--device", choices=["cpu", "cuda", "mps", "xpu"], default="cpu")
    parser.add_argument("--model-dir")
    parser.add_argument("--revision", help="Hub commit SHA to pin the explicitly acquired model")
    parser.add_argument("--allow-download", action="store_true")
    args = parser.parse_args()
    backend = LayaBackend(args.model_dir, args.device, args.revision, args.allow_download)
    server = make_server(backend, args.port, os.environ.get("TEPORA_DECISION_TOKEN", ""))
    print(json.dumps({"ready": True, "port": server.server_port, "model": MODEL_ID}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
