"""Deterministic wake adapter/HTTP lifecycle tests; no ML runtime or model calls."""
import array
import base64
import collections
import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from speech_server import AudioSessions, make_server
from wake_server import OpenWakeWord, local_onnx, main


def pcm(samples=None):
    values = array.array("f", samples if samples is not None else [0.0] * 3200)
    if sys.byteorder != "little":
        values.byteswap()
    return base64.b64encode(values.tobytes()).decode()


class FakeModel:
    def __init__(self, scores=None):
        self.scores = collections.deque(scores or [{"wake": 0.1}])
        self.frames = []
        self.resets = 0
        self.entered = threading.Event()
        self.release = None
        self.busy = False

    def reset(self):
        if self.busy:
            raise AssertionError("Reset overlapped a prediction")
        self.resets += 1

    def predict(self, frame):
        if self.busy:
            raise AssertionError("Concurrent prediction")
        self.busy = True
        try:
            self.frames.append(list(frame))
            self.entered.set()
            if self.release is not None and not self.release.wait(3):
                raise AssertionError("Test prediction was not released")
            return self.scores.popleft() if len(self.scores) > 1 else self.scores[0]
        finally:
            self.busy = False


class WakeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.paths = [os.path.join(self.directory.name, name + ".onnx")
                      for name in ("wake", "mel", "embedding")]
        for path in self.paths:
            with open(path, "wb") as handle:
                handle.write(b"test path placeholder, never executed")

    def backend(self, model=None, threshold=0.5):
        model = model or FakeModel()
        self.kwargs = None
        def factory(**kwargs):
            self.kwargs = kwargs
            return model
        return OpenWakeWord(*self.paths, threshold, _model_factory=factory,
                            _pcm_converter=lambda values: values)

    def start_thread(self, callback):
        results, errors = [], []
        def run():
            try:
                results.append(callback())
            except Exception as error:
                errors.append(error)
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 4)
        return thread, results, errors

    def test_only_explicit_local_models_and_onnx_runtime(self):
        self.backend()
        self.assertEqual(self.kwargs, {"wakeword_models": [self.paths[0]],
                                      "melspec_model_path": self.paths[1],
                                      "embedding_model_path": self.paths[2],
                                      "inference_framework": "onnx"})
        for path in ("https://invalid.example/wake.onnx", self.directory.name,
                     os.path.join(self.directory.name, "absent.onnx")):
            with self.subTest(path=path), self.assertRaises(ValueError):
                local_onnx(path)
        wrong_suffix = os.path.join(self.directory.name, "wake.tflite")
        with open(wrong_suffix, "wb") as handle:
            handle.write(b"fixture")
        with self.assertRaises(ValueError):
            local_onnx(wrong_suffix)

    def test_missing_each_feature_model_fails_before_runtime_factory(self):
        for index in range(3):
            paths = self.paths.copy()
            paths[index] = os.path.join(self.directory.name, "missing.onnx")
            with self.subTest(index=index), patch("wake_server.numpy_pcm") as converter:
                with self.assertRaises(ValueError):
                    OpenWakeWord(*paths, _model_factory=converter)
                converter.assert_not_called()

    def test_threshold_validation(self):
        for value in (0, -1, 1.1, float("nan"), float("inf"), True, "0.5"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.backend(threshold=value)

    def test_float_conversion_frame_boundary_and_bounded_remainder(self):
        model = FakeModel()
        backend = self.backend(model)
        state = backend.start()
        samples = [-1.0, -0.5, 0.0, 0.5, 1.0, 1.01] + [0.0] * 3194
        self.assertEqual(backend.chunk(samples, state), "")
        self.assertEqual(model.frames[0][:6], [-32768, -16384, 0, 16384, 32767, 32767])
        self.assertEqual([len(frame) for frame in model.frames], [1280, 1280])
        self.assertEqual(len(state["pending"]), 640)
        backend.chunk([0.0] * 3200, state)
        self.assertEqual(len(model.frames), 5)
        self.assertEqual(len(state["pending"]), 0)
        for _ in range(20):
            backend.chunk([0.0] * 3200, state)
            self.assertLess(len(state["pending"]), 1280)

    def test_detection_latches_without_transcript_or_extra_predictions(self):
        model = FakeModel([{"wake": 0.1}, {"wake": 0.5}])
        backend = self.backend(model)
        state = backend.start()
        self.assertEqual(backend.chunk([0.0] * 3200, state), "")
        self.assertTrue(backend.detection(state))
        self.assertEqual(len(state["pending"]), 0)
        backend.chunk([0.0] * 3200, state)
        self.assertEqual(len(model.frames), 2)
        self.assertEqual(backend.finish(state), "")
        self.assertEqual(model.resets, 2)
        with self.assertRaises(ValueError):
            backend.detection(state)

    def test_invalid_chunk_does_not_mutate_model_or_buffer(self):
        model = FakeModel()
        backend = self.backend(model)
        state = backend.start()
        for samples in ([], [0.0] * 3199, [0.0] * 3201, [float("nan")] * 3200,
                        [float("inf")] * 3200, [1.1] * 3200):
            with self.subTest(length=len(samples)), self.assertRaises(ValueError):
                backend.chunk(samples, state)
        self.assertEqual(model.frames, [])
        self.assertEqual(len(state["pending"]), 0)
        self.assertFalse(backend.detection(state))

    def test_bad_predictions_invalidate_session_without_detection(self):
        for scores in ({}, {"wake": float("nan")}, {"wake": float("inf")},
                       {"wake": -0.1}, {"wake": 1.1}, {"wake": "invalid"}, []):
            with self.subTest(scores=scores):
                model = FakeModel()
                model.scores = collections.deque([scores])
                backend = self.backend(model)
                state = backend.start()
                with self.assertRaises(ValueError):
                    backend.chunk([0.0] * 3200, state)
                with self.assertRaises(ValueError):
                    backend.detection(state)
                self.assertEqual(len(state["pending"]), 0)

    def test_replacement_rejects_old_chunk_finish_and_detection(self):
        model = FakeModel()
        backend = self.backend(model)
        old = backend.start()
        backend.chunk([0.0] * 3200, old)
        new = backend.start()
        for callback in (lambda: backend.chunk([0.0] * 3200, old),
                         lambda: backend.finish(old), lambda: backend.detection(old)):
            with self.assertRaises(ValueError):
                callback()
        backend.cancel(old)
        self.assertFalse(backend.detection(new))
        self.assertEqual(model.resets, 2)
        self.assertEqual(len(new["pending"]), 0)

    def test_cancel_discards_running_prediction_before_result(self):
        model = FakeModel([{"wake": 1.0}])
        model.release = threading.Event()
        self.addCleanup(model.release.set)
        backend = self.backend(model)
        state = backend.start()
        thread, results, errors = self.start_thread(lambda: backend.chunk([0.0] * 3200, state))
        self.assertTrue(model.entered.wait(2))
        backend.cancel(state)
        model.release.set()
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results, [])
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], ValueError)
        self.assertFalse(state["detected"])

    def test_new_start_waits_for_prediction_then_resets_without_overlap(self):
        model = FakeModel([{"wake": 1.0}])
        model.release = threading.Event()
        self.addCleanup(model.release.set)
        backend = self.backend(model)
        old = backend.start()
        chunk_thread, results, errors = self.start_thread(lambda: backend.chunk([0.0] * 3200, old))
        self.assertTrue(model.entered.wait(2))
        start_thread, states, start_errors = self.start_thread(backend.start)
        self.assertTrue(old["cancelled"].wait(2))
        self.assertEqual(model.resets, 1)
        model.release.set()
        chunk_thread.join(3)
        start_thread.join(3)
        self.assertEqual(results, [])
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], ValueError)
        self.assertEqual(start_errors, [])
        self.assertEqual(len(states), 1)
        self.assertEqual(model.resets, 2)
        self.assertFalse(backend.detection(states[0]))

    def test_transport_retry_cancel_and_expiration(self):
        model = FakeModel()
        backend = self.backend(model)
        sessions = AudioSessions(backend)
        sid = sessions.start()["session_id"]
        state = sessions.sessions[sid]["state"]
        first = sessions.chunk(sid, 0, pcm())
        self.assertEqual(first, {"text": "", "final": False, "detected": False})
        self.assertEqual(sessions.chunk(sid, 0, pcm()), first)
        self.assertEqual(len(model.frames), 2)
        sessions.cancel(sid)
        with self.assertRaises(ValueError):
            backend.detection(state)
        next_sid = sessions.start()["session_id"]
        expiring = sessions.sessions[next_sid]["state"]
        sessions.sessions[next_sid]["at"] -= 121
        newest_sid = sessions.start()["session_id"]
        with self.assertRaises(ValueError):
            backend.chunk([0.0] * 3200, expiring)
        self.assertEqual(sessions.chunk(newest_sid, 0, pcm())["detected"], False)
        self.assertEqual(sessions.finish(newest_sid), {"text": "", "final": True})

    def request(self, server, method, route, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        self.addCleanup(connection.close)
        connection.request(method, route, json.dumps(body) if body is not None else None,
                           {"Content-Type": "application/json", **(headers or {})})
        response = connection.getresponse()
        return response.status, json.loads(response.read())

    def test_authenticated_loopback_detection_contract(self):
        backend = self.backend(FakeModel([{"wake": 0.9}]))
        server = make_server(backend, 0, "wake-test-token")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def cleanup():
            server.shutdown()
            server.server_close()
            thread.join(3)
        self.addCleanup(cleanup)
        self.assertEqual(server.server_address[0], "127.0.0.1")
        auth = {"Authorization": "Bearer wake-test-token"}
        self.assertEqual(self.request(server, "GET", "/health")[0], 401)
        self.assertEqual(self.request(server, "GET", "/health", headers={**auth, "Origin": "https://invalid.example"})[0], 403)
        self.assertEqual(self.request(server, "GET", "/health", headers={**auth, "Host": "invalid.example"})[0], 403)
        status, result = self.request(server, "POST", "/api/start", {"sample_rate": 16000}, auth)
        self.assertEqual(status, 200)
        sid = result["session_id"]
        status, result = self.request(server, "POST", "/api/chunk", {"session_id": sid, "sequence": 0, "pcm": pcm()}, auth)
        self.assertEqual(status, 200)
        self.assertEqual(result, {"text": "", "final": False, "detected": True})
        self.assertEqual(self.request(server, "POST", "/api/cancel", {"session_id": sid}, auth),
                         (200, {"cancelled": True}))
        self.assertEqual(self.request(server, "POST", "/api/chunk", {"session_id": sid, "sequence": 1, "pcm": pcm()}, auth)[0], 422)

    def test_cli_uses_explicit_paths_default_port_and_token(self):
        arguments = ["wake_server.py", "--model", self.paths[0], "--melspec-model", self.paths[1],
                     "--embedding-model", self.paths[2]]
        with patch.object(sys, "argv", arguments), patch.dict(os.environ, {"TEPORA_SPEECH_TOKEN": "local-token"}), \
             patch("wake_server.OpenWakeWord") as adapter, patch("wake_server.make_server") as factory, \
             patch("builtins.print"):
            factory.return_value.server_port = 8769
            factory.return_value.serve_forever.side_effect = KeyboardInterrupt
            main()
            adapter.assert_called_once_with(*self.paths, 0.5)
            factory.assert_called_once_with(adapter.return_value, 8769, "local-token")
            factory.return_value.server_close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
