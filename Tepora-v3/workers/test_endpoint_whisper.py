"""Endpoint-only adapter tests with stdlib fakes; no ML packages or model calls."""
import array
import base64
import builtins
import gc
import http.client
import json
import os
import sys
import tempfile
import threading
import types
import unittest
import weakref
from unittest.mock import patch

from endpoint_whisper import EndpointWhisper, local_model, main
from speech_server import AudioSessions, make_server


class FakeModel:
    def __init__(self, texts=None):
        self.texts = texts if texts is not None else [" 日本語", " result "]
        self.calls = []
        self.options = []
        self.entered = threading.Event()
        self.release = None
        self.active = 0
        self.closed = 0
        self.wait_timeout = 3

    def transcribe(self, audio, **options):
        self.calls.append(list(audio))
        self.options.append(options)
        def segments():
            if self.active:
                raise AssertionError("Concurrent model decoding")
            self.active += 1
            try:
                self.entered.set()
                if self.release is not None and not self.release.wait(self.wait_timeout):
                    raise AssertionError("Decode was not released")
                for text in self.texts:
                    yield types.SimpleNamespace(text=text)
            finally:
                self.active -= 1
                self.closed += 1
        return segments(), None


class EndpointWhisperTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = self.directory.name
        for name in ("model.bin", "config.json", "tokenizer.json"):
            with open(os.path.join(self.path, name), "wb") as handle:
                handle.write(b"fixture placeholder, never executed")
        self.environment = patch.dict(os.environ)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def backend(self, model=None, **options):
        model = model or FakeModel()
        self.constructor = None
        def factory(path, **kwargs):
            self.constructor = (path, kwargs)
            self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
            return model
        return EndpointWhisper(self.path, _model_factory=factory,
                               _pcm_converter=lambda values: list(values), **options)

    def thread(self, callback):
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

    def test_explicit_complete_local_model_and_cpu_offline_constructor(self):
        self.backend(threads=2, language="ja")
        self.assertEqual(self.constructor, (self.path, {
            "device": "cpu", "compute_type": "int8", "cpu_threads": 2,
            "num_workers": 1, "local_files_only": True}))
        original_import = builtins.__import__
        def checked_import(name, *args, **kwargs):
            if name.split(".")[0] in {"faster_whisper", "numpy", "torch"}:
                raise AssertionError("ML runtime imported before local validation")
            return original_import(name, *args, **kwargs)
        with patch("builtins.__import__", side_effect=checked_import):
            for path in (os.path.join(self.path, "missing"), "model-name", "https://invalid.example/model"):
                with self.subTest(path=path), self.assertRaises(ValueError):
                    EndpointWhisper(path)
            os.unlink(os.path.join(self.path, "tokenizer.json"))
            with self.assertRaisesRegex(ValueError, "tokenizer.json"):
                EndpointWhisper(self.path)

    def test_threads_and_language_are_validated_without_model_loading(self):
        factory = unittest.mock.Mock()
        for threads in (0, 9, -1, True, 1.5, "2"):
            with self.subTest(threads=threads), self.assertRaises(ValueError):
                EndpointWhisper(self.path, threads, _model_factory=factory)
        for language in ("", "japanese", 1, "日本"):
            with self.subTest(language=language), self.assertRaises(ValueError):
                EndpointWhisper(self.path, language=language, _model_factory=factory)
        factory.assert_not_called()

    def test_chunks_never_decode_finish_decodes_once_and_releases_audio(self):
        model = FakeModel()
        backend = self.backend(model, language="ja")
        state = backend.start()
        self.assertIsInstance(state.audio, array.array)
        self.assertEqual(state.audio.typecode, "f")
        for _ in range(5):
            self.assertEqual(backend.chunk([0.125] * 3200, state), "")
        self.assertEqual(model.calls, [])
        self.assertEqual(backend.finish(state), "日本語 result")
        self.assertEqual(len(model.calls), 1)
        self.assertEqual(model.calls[0], [0.125] * 16000)
        self.assertEqual(model.options[0], {
            "language": "ja", "beam_size": 1, "best_of": 1, "temperature": 0,
            "condition_on_previous_text": False, "vad_filter": False,
            "word_timestamps": False, "without_timestamps": True})
        self.assertEqual(len(state.audio), 0)
        self.assertTrue(state.cancelled.is_set())
        with self.assertRaises(ValueError):
            backend.finish(state)
        self.assertEqual(len(model.calls), 1)

    def test_audio_budget_sample_validation_and_empty_finish(self):
        backend = self.backend()
        state = backend.start()
        for values in ([], [float("nan")], [float("inf")], [1.1], [0.0] * 16001):
            with self.assertRaises(ValueError):
                backend.chunk(values, state)
        for _ in range(30):
            backend.chunk([0.0] * 16000, state)
        self.assertEqual(len(state.audio), 480000)
        with self.assertRaisesRegex(ValueError, "budget"):
            backend.chunk([0.0], state)
        self.assertEqual(len(state.audio), 480000)
        backend.cancel(state)
        self.assertEqual(len(state.audio), 0)
        self.assertEqual(backend.finish(backend.start()), "")
        self.assertEqual(backend.model.calls, [])

    def test_reset_cancel_and_expired_transport_do_not_retain_audio(self):
        backend = self.backend()
        old = backend.start()
        backend.chunk([0.2] * 3200, old)
        state = backend.start()
        self.assertTrue(old.cancelled.is_set())
        self.assertEqual(len(old.audio), 0)
        with self.assertRaises(ValueError):
            backend.chunk([0.0], old)
        backend.chunk([0.2] * 3200, state)
        backend.cancel(state)
        self.assertEqual(len(state.audio), 0)
        sessions = AudioSessions(backend)
        sid = sessions.start()["session_id"]
        expiring = sessions.sessions[sid]["state"]
        backend.chunk([0.0] * 3200, expiring)
        reference = weakref.ref(expiring)
        del expiring
        sessions.sessions[sid]["at"] -= 121
        with self.assertRaises(ValueError):
            sessions.get(sid)
        gc.collect()
        self.assertIsNone(reference())

    def test_cancelled_lazy_decode_cannot_return_text_or_overlap_next_decode(self):
        model = FakeModel(["stale text"])
        model.release = threading.Event()
        self.addCleanup(model.release.set)
        backend = self.backend(model)
        old = backend.start()
        backend.chunk([0.0] * 3200, old)
        first, results, errors = self.thread(lambda: backend.finish(old))
        self.assertTrue(model.entered.wait(2))
        with self.assertRaises(BlockingIOError):
            backend.finish(old)
        backend.cancel(old)
        self.assertTrue(old.cancelled.is_set())
        state = backend.start()
        backend.chunk([0.0] * 3200, state)
        second, final, final_errors = self.thread(lambda: backend.finish(state))
        second.join(1)
        self.assertFalse(second.is_alive())
        self.assertEqual(final, [])
        self.assertEqual(len(final_errors), 1)
        self.assertIsInstance(final_errors[0], BlockingIOError)
        self.assertEqual(len(state.audio), 0)
        self.assertTrue(state.cancelled.is_set())
        self.assertEqual(len(model.calls), 1)
        model.release.set()
        first.join(3)
        second.join(3)
        self.assertEqual(results, [])
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], ValueError)
        recovered = backend.start()
        backend.chunk([0.0] * 3200, recovered)
        self.assertEqual(backend.finish(recovered), "stale text")
        self.assertEqual(len(model.calls), 2)
        self.assertEqual(model.active, 0)

    def test_real_sessions_cancel_restart_does_not_queue_finish_threads_or_waveforms(self):
        model = FakeModel(["stale text"])
        model.release = threading.Event()
        model.wait_timeout = 10
        backend = self.backend(model)
        sessions = AudioSessions(backend)
        packet = base64.b64encode(bytes(16000 * 4)).decode()
        waveforms, waiters = [], []
        def capture():
            sid = sessions.start()["session_id"]
            sessions.chunk(sid, 0, packet)
            waveforms.append(weakref.ref(sessions.sessions[sid]["state"].audio))
            return sid
        sid = capture()
        first, first_results, first_errors = self.thread(lambda: sessions.finish(sid))
        try:
            self.assertTrue(model.entered.wait(2))
            sessions.cancel(sid)
            peak_threads = 1
            for _ in range(21):
                replacement = capture()
                thread, results, errors = self.thread(lambda sid=replacement: sessions.finish(sid))
                thread.join(0.05)
                waiters.append((thread, results, errors))
                sessions.cancel(replacement)
                peak_threads = max(peak_threads, int(first.is_alive()) +
                                   sum(thread.is_alive() for thread, _, _ in waiters))
            gc.collect()
            live_waveforms = sum(reference() is not None for reference in waveforms)
            retained_bytes = sum(len(reference()) * 4 for reference in waveforms if reference() is not None)
            calls_while_blocked = len(model.calls)
            remaining_sessions = len(sessions.sessions)
        finally:
            model.release.set()
            first.join(3)
            for thread, _, _ in waiters:
                thread.join(3)
        self.assertEqual(remaining_sessions, 0)
        self.assertEqual(calls_while_blocked, 1)
        self.assertLessEqual(peak_threads, 1,
                             f"Cancelled finishes retained {peak_threads} threads and {retained_bytes} waveform bytes")
        self.assertLessEqual(live_waveforms, 1)
        self.assertLessEqual(retained_bytes, 16000 * 4)
        self.assertFalse(first.is_alive())
        self.assertEqual(first_results, [])
        self.assertEqual(len(first_errors), 1)
        self.assertIsInstance(first_errors[0], ValueError)
        for thread, results, errors in waiters:
            self.assertFalse(thread.is_alive())
            self.assertEqual(results, [])
            self.assertEqual(len(errors), 1)
            self.assertIsInstance(errors[0], BlockingIOError)
        self.assertTrue(all(reference() is None for reference in waveforms))
        recovered = capture()
        self.assertEqual(sessions.finish(recovered), {"text": "stale text", "final": True})
        self.assertEqual(len(model.calls), 2)
        self.assertEqual(model.active, 0)
        self.assertEqual(model.closed, 2)

    def test_pcm_conversion_failure_releases_admission_without_model_dispatch(self):
        backend = self.backend()
        converter = unittest.mock.Mock(side_effect=[RuntimeError("Synthetic conversion failure"), [0.0]])
        backend._pcm_converter = converter
        state = backend.start()
        backend.chunk([0.0], state)
        with self.assertRaisesRegex(RuntimeError, "conversion failure"):
            backend.finish(state)
        self.assertTrue(state.cancelled.is_set())
        self.assertEqual(len(state.audio), 0)
        self.assertEqual(backend.model.calls, [])
        recovered = backend.start()
        backend.chunk([0.0], recovered)
        self.assertEqual(backend.finish(recovered), "日本語 result")
        self.assertEqual(len(backend.model.calls), 1)
        self.assertEqual(converter.call_count, 2)

    def test_http_busy_finish_is_terminal_429_and_recovers_after_cancelled_decode_drains(self):
        model = FakeModel()
        model.release = threading.Event()
        backend = self.backend(model)
        server = make_server(backend, 0, "busy-fixture-token")
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        def cleanup():
            server.shutdown()
            server.server_close()
            server_thread.join(3)
        self.addCleanup(cleanup)
        def request(route, body):
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            try:
                connection.request("POST", route, json.dumps(body), {
                    "Content-Type": "application/json", "Authorization": "Bearer busy-fixture-token"})
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()
        def capture():
            status, session = request("/api/start", {})
            self.assertEqual(status, 200)
            sid = session["session_id"]
            self.assertEqual(request("/api/chunk", {"session_id": sid, "sequence": 0,
                                                    "pcm": base64.b64encode(bytes(3200 * 4)).decode()})[0], 200)
            return sid
        sid = capture()
        thread, results, errors = self.thread(lambda: request("/api/finish", {"session_id": sid}))
        try:
            self.assertTrue(model.entered.wait(2))
            self.assertEqual(request("/api/cancel", {"session_id": sid})[0], 200)
            replacement = capture()
            self.assertEqual(request("/api/finish", {"session_id": replacement}),
                             (429, {"error": "Audio worker is busy"}))
            self.assertEqual(request("/api/finish", {"session_id": replacement})[0], 422)
            self.assertEqual(len(model.calls), 1)
        finally:
            model.release.set()
            thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(results[0][0], 422, "Cancelled decode must not publish a transcript")
        recovered = capture()
        self.assertEqual(request("/api/finish", {"session_id": recovered}),
                         (200, {"text": "日本語 result", "final": True}))
        self.assertEqual(len(model.calls), 2)

    def test_invalid_or_oversized_transcript_closes_generator_and_cannot_retry(self):
        for texts in ([False], ["x" * 32001], ["x" * 16000, "y" * 16001]):
            model = FakeModel(texts)
            backend = self.backend(model)
            state = backend.start()
            backend.chunk([0.0], state)
            with self.assertRaises(ValueError):
                backend.finish(state)
            self.assertEqual(model.closed, 1)
            self.assertEqual(len(state.audio), 0)
            with self.assertRaises(ValueError):
                backend.finish(state)
            self.assertEqual(len(model.calls), 1)

    def test_authenticated_loopback_transport_retries_and_final_only_text(self):
        backend = self.backend()
        server = make_server(backend, 0, "synthetic-token")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def cleanup():
            server.shutdown()
            server.server_close()
            thread.join(3)
        self.addCleanup(cleanup)
        def request(route, body, authenticated=True):
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            try:
                headers = {"Content-Type": "application/json"}
                if authenticated:
                    headers["Authorization"] = "Bearer synthetic-token"
                connection.request("POST", route, json.dumps(body), headers)
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()
        self.assertEqual(server.server_address[0], "127.0.0.1")
        self.assertEqual(request("/api/start", {}, False)[0], 401)
        status, session = request("/api/start", {"sample_rate": 16000})
        self.assertEqual(status, 200)
        sid = session["session_id"]
        packet = {"session_id": sid, "sequence": 0,
                  "pcm": base64.b64encode(bytes(3200 * 4)).decode()}
        self.assertEqual(request("/api/chunk", packet), (200, {"text": "", "final": False}))
        self.assertEqual(request("/api/chunk", packet), (200, {"text": "", "final": False}))
        self.assertEqual(backend.model.calls, [])
        self.assertEqual(request("/api/finish", {"session_id": sid}),
                         (200, {"text": "日本語 result", "final": True}))
        self.assertEqual(len(backend.model.calls), 1)
        self.assertEqual(request("/api/finish", {"session_id": sid})[0], 422)
        sid = request("/api/start", {})[1]["session_id"]
        self.assertEqual(request("/api/cancel", {"session_id": sid}), (200, {"cancelled": True}))
        self.assertEqual(len(backend.model.calls), 1)

    def test_cli_defaults_existing_model_and_token(self):
        with patch.object(sys, "argv", ["endpoint_whisper.py", "--model", self.path]), \
             patch.dict(os.environ, {"TEPORA_SPEECH_TOKEN": "synthetic-token"}), \
             patch("endpoint_whisper.EndpointWhisper") as adapter, \
             patch("endpoint_whisper.make_server") as factory, patch("builtins.print"):
            factory.return_value.server_port = 8768
            factory.return_value.serve_forever.side_effect = KeyboardInterrupt
            main()
            adapter.assert_called_once_with(self.path, 2, None)
            factory.assert_called_once_with(adapter.return_value, 8768, "synthetic-token")
            factory.return_value.server_close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
