"""Real loopback transport with synthetic samples; no ML packages or models."""
import http.client
import io
import json
import tempfile
import threading
import unittest
import wave
from tts_server import make_server, pcm_wav, load_backend


class SpeechTransport(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.entered, self.release = threading.Event(), threading.Event()
        self.hold = False

        def generate(text):
            self.calls.append(text)
            if self.hold:
                self.entered.set()
                self.release.wait(3)
            return pcm_wav([0.0, 0.5, -0.5] * 100, 24000)
        self.server = make_server('synthetic-model', 'synthetic-voice', generate, 0, 'synthetic-token')
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()

    def tearDown(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, fields=None, **headers):
        body = json.dumps(fields if fields is not None else dict(model='synthetic-model', voice='synthetic-voice', input='合成の日本語', response_format='wav'), ensure_ascii=False).encode()
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        conn.request('POST', '/v1/audio/speech', body, {'Authorization': 'Bearer synthetic-token', 'Content-Type': 'application/json', **headers})
        result = conn.getresponse()
        data = result.read()
        status = result.status
        conn.close()
        return status, data

    def test_real_http_unicode_wav_and_no_file_storage(self):
        status, data = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(self.calls, ['合成の日本語'])
        with wave.open(io.BytesIO(data)) as wav:
            self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (1, 2, 24000))

    def test_auth_origin_model_voice_and_format_refuse_before_inference(self):
        self.assertEqual(self.request(Authorization='wrong')[0], 401)
        self.assertEqual(self.request(Origin='https://example.test')[0], 403)
        self.assertEqual(self.request(Host='other.test')[0], 403)
        for field, value in [('model', 'other'), ('voice', '../other'), ('response_format', 'mp3'), ('input', 'a' * 4001), ('prompt_audio', 'unapproved-reference')]:
            fields = dict(model='synthetic-model', voice='synthetic-voice', input='合成', response_format='wav')
            fields[field] = value
            self.assertEqual(self.request(fields)[0], 400)
        self.assertEqual(self.calls, [])

    def test_busy_does_not_queue_second_inference(self):
        self.hold = True
        results = []
        first = threading.Thread(target=lambda: results.append(self.request()[0]))
        first.start()
        self.assertTrue(self.entered.wait(2))
        self.assertEqual(self.request()[0], 429)
        self.release.set()
        first.join()
        self.assertEqual(results, [200])
        self.assertEqual(len(self.calls), 1)

    def test_missing_local_model_fails_before_optional_runtime_import(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'explicitly installed'):
                load_backend('qwen', directory, 'cpu')
        with self.assertRaises(ValueError):
            pcm_wav([float('nan')], 24000)


if __name__ == '__main__':
    unittest.main()
