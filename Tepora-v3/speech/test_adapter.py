"""Adapter contract tests use a stub transcriber, NOT an actual ASR model."""
import io
import wave
from fastapi.testclient import TestClient
from server import create_app

def wav_bytes():
    out = io.BytesIO()
    with wave.open(out, 'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(16000)
        f.writeframes(b'\0\0' * 16000)
    return out.getvalue()

def test_transcription_contract_and_model_validation():
    client = TestClient(create_app(lambda path, language: 'テストの文字起こし', 'test-model', 8012), base_url='http://127.0.0.1:8012')
    response = client.post('/v1/audio/transcriptions', files={'file': ('a.wav', wav_bytes(), 'audio/wav')}, data={'model': 'test-model', 'language': 'ja'})
    assert response.status_code == 200
    assert response.json()['text'] == 'テストの文字起こし'
    wrong = client.post('/v1/audio/transcriptions', files={'file': ('a.wav', wav_bytes(), 'audio/wav')}, data={'model': 'wrong'})
    assert wrong.status_code == 400

def test_rejects_bad_audio_browser_origin_and_untrusted_host():
    client = TestClient(create_app(lambda path, language: '', 'test', 8012), base_url='http://127.0.0.1:8012')
    assert client.post('/v1/audio/transcriptions', files={'file': ('a.wav', b'invalid')}).status_code == 400
    assert client.get('/health', headers={'origin': 'https://evil.example'}).status_code == 403
    assert client.get('/health', headers={'host': 'evil.example'}).status_code == 403
