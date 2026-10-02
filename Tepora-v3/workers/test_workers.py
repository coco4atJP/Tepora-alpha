"""Transport/state tests use deterministic fakes, NOT ASR/model accuracy benchmarks."""
import array
import base64
import http.client
import json
import sys
import threading
import unittest
from laya_server import make_server as laya_server, validate_request
from speech_server import AudioSessions, make_server as speech_server

class FakeLaya:
    def predict(self, state, questions):
        return {"model": "test-fixture", "answers": {"q": {"type": "noul", "noul": 0.5}}}

class FakeSpeech:
    def __init__(self):
        self.calls = 0

    def start(self):
        return {"text": ""}

    def chunk(self, samples, state):
        self.calls += 1
        state["text"] += "日本語"
        return state["text"]

    def finish(self, state):
        return state["text"] + "。"

def pcm(value=0.1, count=3200):
    values = array.array("f", [value] * count)
    if sys.byteorder != "little":
        values.byteswap()
    return base64.b64encode(values.tobytes()).decode()

class WorkerTests(unittest.TestCase):
    def request(self, server, method, route, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        data = json.dumps(body) if body is not None else None
        conn.request(method, route, data, {"Content-Type": "application/json", **(headers or {})})
        response = conn.getresponse()
        status, value = response.status, json.loads(response.read())
        conn.close()
        return status, value

    def running(self, factory, backend, token=""):
        server = factory(backend, 0, token)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def cleanup():
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
        self.addCleanup(cleanup)
        return server

    def test_laya_multilingual_only(self):
        state, questions = validate_request({"state": "こんにちは", "model": "multilingual",
                                             "questions": {"q": {"type": "noul"}}})
        self.assertEqual(state, "こんにちは")
        with self.assertRaises(ValueError):
            validate_request({"state": "x", "model": "english", "questions": questions})

    def test_laya_invalid_question_sets(self):
        for value in (None, [], {}, {"q": {"type": "exec"}}, {"q": {"type": "choice", "criteria": {"one": "x"}}}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_request({"state": "x", "questions": value})

    def test_laya_worker_auth(self):
        server = self.running(laya_server, FakeLaya(), "test-token")
        self.assertEqual(self.request(server, "GET", "/health")[0], 401)
        self.assertEqual(self.request(server, "GET", "/health", headers={"Authorization": "Bearer test-token"})[0], 200)

    def test_laya_rejects_browser_origins(self):
        server = self.running(laya_server, FakeLaya())
        self.assertEqual(self.request(server, "GET", "/health", headers={"Origin": "https://example.org"})[0], 403)

    def test_laya_http_contract(self):
        server = self.running(laya_server, FakeLaya())
        status, result = self.request(server, "POST", "/v1/systemone",
                                      {"state": "日本語", "model": "multilingual", "questions": {"q": {"type": "noul"}}})
        self.assertEqual(status, 200)
        self.assertEqual(result["answers"]["q"]["noul"], 0.5)

    def test_speech_partial_final(self):
        sessions = AudioSessions(FakeSpeech())
        sid = sessions.start()["session_id"]
        self.assertEqual(sessions.chunk(sid, 0, pcm())["text"], "日本語")
        self.assertEqual(sessions.chunk(sid, 1, pcm())["text"], "日本語日本語")
        self.assertTrue(sessions.finish(sid)["final"])
        self.assertEqual(len(sessions.sessions), 0)

    def test_duplicate_chunk_is_not_processed_twice(self):
        backend = FakeSpeech()
        sessions = AudioSessions(backend)
        sid = sessions.start()["session_id"]
        first = sessions.chunk(sid, 0, pcm())
        self.assertEqual(first, sessions.chunk(sid, 0, pcm()))
        self.assertEqual(backend.calls, 1)
        with self.assertRaises(ValueError):
            sessions.chunk(sid, 0, pcm(0.2))

    def test_out_of_order_audio_rejected(self):
        sessions = AudioSessions(FakeSpeech())
        sid = sessions.start()["session_id"]
        with self.assertRaises(ValueError):
            sessions.chunk(sid, 1, pcm())
        self.assertEqual(sessions.sessions[sid]["next"], 0)

    def test_bad_audio_preserves_session(self):
        sessions = AudioSessions(FakeSpeech())
        sid = sessions.start()["session_id"]
        for value in ("bad!", pcm(float("nan")), pcm(3), ""):
            with self.subTest(value=value[:20]), self.assertRaises(ValueError):
                sessions.chunk(sid, 0, value)
        self.assertEqual(sessions.sessions[sid]["next"], 0)

    def test_capture_is_single_session_and_cancel_releases(self):
        sessions = AudioSessions(FakeSpeech())
        sid = sessions.start()["session_id"]
        with self.assertRaises(BlockingIOError):
            sessions.start()
        sessions.cancel(sid)
        self.assertNotEqual(sessions.start()["session_id"], sid)

    def test_non_16khz_rejected(self):
        with self.assertRaises(ValueError):
            AudioSessions(FakeSpeech()).start(48000)

    def test_speech_http_flow(self):
        server = self.running(speech_server, FakeSpeech())
        status, result = self.request(server, "POST", "/api/start", {"sample_rate": 16000})
        self.assertEqual(status, 200)
        sid = result["session_id"]
        status, result = self.request(server, "POST", "/api/chunk",
                                      {"session_id": sid, "sequence": 0, "pcm": pcm()})
        self.assertEqual(status, 200)
        self.assertEqual(result["text"], "日本語")
        status, result = self.request(server, "POST", "/api/finish", {"session_id": sid})
        self.assertEqual(status, 200)
        self.assertEqual(result["text"], "日本語。")

    def test_speech_origin_and_auth(self):
        server = self.running(speech_server, FakeSpeech(), "token")
        self.assertEqual(self.request(server, "GET", "/health")[0], 401)
        self.assertEqual(self.request(server, "GET", "/health",
                         headers={"Authorization": "Bearer token", "Origin": "https://example.org"})[0], 403)

if __name__ == "__main__":
    unittest.main()
