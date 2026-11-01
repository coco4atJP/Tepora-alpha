"""Granite orchestration using synthetic tensors/config. No ML imports or weights."""
import contextlib
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
import wave

spec = importlib.util.spec_from_file_location('tepora_granite', Path(__file__).resolve().parents[1] / 'speech' / 'granite_asr.py')
granite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(granite)


class GraniteAdapter(unittest.TestCase):
    def setup_files(self, root, size=16384):
        Path(root, 'config.json').write_text(json.dumps({'model_type': 'granite_speech5_ctc', 'vocab_size': size, 'encoder_config': {'vocab_size': size}}))
        path = Path(root, 'synthetic.wav')
        with wave.open(str(path), 'wb') as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(48000)
            wav.writeframes(b'\x00\x00\xff\x7f' * 4800)
        return path

    def test_local_multilingual_shape_and_bounded_audio_before_optional_imports(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(ValueError, 'explicitly installed'):
                granite.make_transcriber(root)
            path = self.setup_files(root, 8192)
            with self.assertRaisesRegex(ValueError, 'multilingual'):
                granite.make_transcriber(root)
            self.setup_files(root)
            config=json.loads(Path(root, 'config.json').read_text());config['_commit_hash']='947f59a-old-english'
            Path(root, 'config.json').write_text(json.dumps(config))
            with self.assertRaisesRegex(ValueError, 'English-only Granite revision'):
                granite.make_transcriber(root)
            self.setup_files(root)
            with self.assertRaisesRegex(ValueError, 'CPU/CUDA'):
                granite.make_transcriber(root, 'mps')
            samples, rate = granite.read_pcm(path)
            self.assertEqual(rate, 48000); self.assertEqual(samples[1], 32767)
            Path(root, 'broken.wav').write_bytes(path.read_bytes()[:-4])
            with self.assertRaisesRegex(ValueError, 'Truncated'):
                granite.read_pcm(Path(root, 'broken.wav'))

    def test_offline_processor_resampling_and_non_autoregressive_decoding(self):
        calls = []
        class Tensor:
            def unsqueeze(self, axis): return self
            def squeeze(self, axis): return self
            def __truediv__(self, value): calls.append(('scale', value)); return self
            def numpy(self): return [0.0, 1.0]
        class Inputs(dict):
            def to(self, device, dtype): calls.append(('inputs-to', device, dtype)); return self
        class Processor:
            feature_extractor = types.SimpleNamespace(sampling_rate=16000)
            answer = ['日本語の合成認識。']
            def __call__(self, audio, **kwargs): calls.append(('features', kwargs)); return Inputs(input_features='synthetic')
            def batch_decode(self, ids, **kwargs): calls.append(('decode', ids, kwargs)); return self.answer
        class Model:
            device, dtype = 'cpu', 'float32'
            def to(self, device): self.device=device; return self
            def eval(self): return self
            def generate(self, **kwargs): calls.append(('generate', kwargs)); return 'synthetic-ctc-ids'
        processor = Processor()
        def load_processor(path, **kwargs): calls.append(('processor-load', kwargs)); return processor
        def load_model(path, **kwargs): calls.append(('model-load', kwargs)); return Model()
        transformers = types.SimpleNamespace(__version__='5.16.0', AutoProcessor=types.SimpleNamespace(from_pretrained=load_processor), AutoModelForCTC=types.SimpleNamespace(from_pretrained=load_model))
        torch = types.SimpleNamespace(float32='float32',set_num_threads=lambda n:calls.append(('threads',n)),tensor=lambda values, dtype:Tensor(),inference_mode=contextlib.nullcontext)
        functional = types.ModuleType('torchaudio.functional')
        functional.resample=lambda audio, source, target:(calls.append(('resample',source,target)) or audio)
        with tempfile.TemporaryDirectory() as root, patch.dict('sys.modules',{'transformers':transformers,'torch':torch,'torchaudio.functional':functional}):
            path=self.setup_files(root)
            transcribe=granite.make_transcriber(root)
            self.assertEqual(transcribe(path,'ja'),'日本語の合成認識。')
            for name, kwargs in [call for call in calls if call[0] in ('processor-load','model-load')]:
                self.assertTrue(kwargs['local_files_only']); self.assertFalse(kwargs['trust_remote_code'])
            self.assertIn(('threads',2),calls);self.assertIn(('resample',48000,16000),calls)
            self.assertIn(('generate',{'input_features':'synthetic'}),calls)
            processor.answer=[42]
            with self.assertRaisesRegex(ValueError, 'Invalid local CTC'):
                transcribe(path,'ja')
            with self.assertRaisesRegex(ValueError,'does not support'):
                transcribe(path,'zh')
            transformers.__version__='5.15.9'
            with self.assertRaisesRegex(ValueError,'5.16.0'):
                granite.make_transcriber(root)


if __name__ == '__main__': unittest.main()
