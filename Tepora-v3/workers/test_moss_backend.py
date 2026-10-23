"""MOSS orchestration with synthetic runtime/tokens; no optional dependencies."""
import io
import json
import tempfile
import sys
from types import SimpleNamespace
from unittest.mock import patch
import unittest
import wave
from pathlib import Path
from moss_backend import builtin_voices, load_moss, make_generator, VOICE_REQUIRED
from tts_server import pcm_wav


class MossAdapter(unittest.TestCase):
    def runtime(self):
        class Runtime:
            codec_meta = {'codec_config': {'sample_rate': 48000, 'channels': 2}}
            calls = []
            def list_builtin_voices(self):
                return [{'voice': 'synthetic-installed', 'prompt_audio_codes': [[1, 2]]}]
            def build_voice_clone_request_rows(self, codes, tokens):
                self.calls.append((codes, tokens))
                return tokens
            def generate_audio_frames(self, rows):
                return [[3, 4]]
            def decode_full_audio(self, frames):
                return [[0.25] * 100, [-0.25] * 100], 100
        return Runtime()

    def test_only_explicit_packaged_voice_and_bounded_stereo(self):
        class Tokenizer:
            def encode(self, text, out_type):
                return list(range(len(text)))
        runtime = self.runtime()
        for voice in ['', VOICE_REQUIRED, '../uninstalled', 'alloy']:
            with self.assertRaisesRegex(ValueError, 'Explicitly select'):
                make_generator(runtime, Tokenizer(), voice, pcm_wav)
        generate = make_generator(runtime, Tokenizer(), 'synthetic-installed', pcm_wav)
        data = generate('あ' * 151)
        self.assertEqual([len(call[1]) for call in runtime.calls], [75, 75, 1])
        self.assertTrue(all(call[0] == [[1, 2]] for call in runtime.calls))
        with wave.open(io.BytesIO(data)) as wav:
            self.assertEqual((wav.getnchannels(), wav.getframerate(), wav.getnframes()), (2, 48000, 300))
        with self.assertRaisesRegex(ValueError, '300 model tokens'):
            generate('a' * 301)
        self.assertEqual(len(runtime.calls), 3)

    def test_voice_list_is_local_metadata_and_missing_setup_fails_before_import(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'complete MOSS'):
                builtin_voices(directory)
            Path(directory, 'browser_poc_manifest.json').write_text(json.dumps({'builtin_voices': [{'voice': 'synthetic-installed'}]}))
            self.assertEqual(builtin_voices(directory), ['synthetic-installed'])
            with self.assertRaisesRegex(ValueError, 'Explicitly select'):
                load_moss(directory, directory, VOICE_REQUIRED, pcm_wav)
            with self.assertRaisesRegex(ValueError, 'runtime-dir'):
                load_moss(directory, directory, 'synthetic-installed', pcm_wav)

    def test_installed_low_level_runtime_loads_cpu_without_download_helpers(self):
        class Tokenizer:
            def __init__(self, model_file):
                self.path = model_file
            def encode(self, text, out_type):
                return [1, 2]
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'browser_poc_manifest.json').write_text(json.dumps({'builtin_voices': [{'voice': 'synthetic-installed'}]}))
            Path(directory, 'ort_cpu_runtime.py').write_text("""
from pathlib import Path
class OrtCpuRuntime:
    def __init__(self, model_dir, thread_count, max_new_frames, execution_provider):
        assert thread_count == 2 and max_new_frames == 375 and execution_provider == 'cpu'
        self.manifest = {'model_files': {}}
        self.codec_meta = {'codec_config': {'sample_rate': 48000, 'channels': 2}}
        self.root = Path(model_dir)
    def resolve_manifest_relative_path(self, path): return self.root / path
    def list_builtin_voices(self): return [{'voice': 'synthetic-installed', 'prompt_audio_codes': [[1,2]]}]
    def build_voice_clone_request_rows(self, codes, tokens): return tokens
    def generate_audio_frames(self, rows): return [[1,2]]
    def decode_full_audio(self, frames): return [[0.0]*100, [0.0]*100], 100
""")
            with patch.dict(sys.modules, {'sentencepiece': SimpleNamespace(SentencePieceProcessor=Tokenizer)}):
                model, voice, generate = load_moss(directory, directory, 'synthetic-installed', pcm_wav)
                self.assertEqual(voice, 'synthetic-installed')
                self.assertIn('100M-ONNX', model)
                with wave.open(io.BytesIO(generate('合成'))) as wav:
                    self.assertEqual(wav.getnchannels(), 2)


if __name__ == '__main__':
    unittest.main()
