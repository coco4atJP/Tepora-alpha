"""Local-only committed-turn Granite TurboCTC adapter; no streaming or downloads.

API shape follows IBM's multilingual 2026-10-21 model card (Transformers>=5.16).
Do not load the old English-only checkpoint under the same repository name.
"""
import array
import json
import os
from pathlib import Path
import re
import sys
import wave

MODEL_ID = 'ibm-granite/granite-speech-5.0-470m-turboctc'


def validate_checkpoint(directory):
    root = Path(directory).resolve()
    if not root.is_dir() or not (root / 'config.json').is_file():
        raise ValueError('Supply an explicitly installed local multilingual Granite checkpoint directory')
    config = json.loads((root / 'config.json').read_text(encoding='utf-8'))
    if root.name.startswith('947f59a') or str(config.get('_commit_hash', '')).startswith('947f59a'):
        raise ValueError('The known English-only Granite revision 947f59a is not a Japanese checkpoint')
    if (config.get('model_type') != 'granite_speech5_ctc' or config.get('vocab_size') != 16384
            or config.get('encoder_config', {}).get('vocab_size') != 16384):
        raise ValueError('Use the 2026-10-21 multilingual TurboCTC checkpoint (16384-token CTC heads), not the old English-only model')
    return root


def read_pcm(path):
    with wave.open(str(path), 'rb') as wav:
        rate, frames = wav.getframerate(), wav.getnframes()
        if (wav.getnchannels() != 1 or wav.getsampwidth() != 2 or not 8000 <= rate <= 96000
                or not 0 < frames <= rate * 65):
            raise ValueError('Use bounded mono PCM16 WAV at 8–96kHz, up to 65 seconds')
        data = wav.readframes(frames)
        if len(data) != frames * 2:
            raise ValueError('Truncated PCM audio')
    samples = array.array('h')
    samples.frombytes(data)
    if sys.byteorder != 'little':
        samples.byteswap()
    return samples, rate


def make_transcriber(directory, device='cpu'):
    root = validate_checkpoint(directory)
    if device not in ('cpu', 'cuda'):
        raise ValueError('This adapter supports explicit CPU/CUDA; MLX is a separate runtime')
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    import transformers
    version = re.match(r'^(\d+)\.(\d+)\.(\d+)', transformers.__version__)
    if version is None or tuple(map(int, version.groups())) < (5, 16, 0):
        raise ValueError('Granite multilingual TurboCTC requires Transformers>=5.16.0')
    import torch
    from torchaudio.functional import resample
    torch.set_num_threads(2)
    processor = transformers.AutoProcessor.from_pretrained(str(root), local_files_only=True, trust_remote_code=False)
    model = transformers.AutoModelForCTC.from_pretrained(str(root), local_files_only=True,
                                trust_remote_code=False, dtype=torch.float32).to(device).eval()
    rate = processor.feature_extractor.sampling_rate
    if not isinstance(rate, int) or not 8000 <= rate <= 96000:
        raise ValueError('Invalid local feature extractor sample rate')

    def transcribe(path, language):
        # CTC recognizes its supported languages automatically; there is no prompt decoder.
        if language not in ('', 'ja', 'en', 'fr', 'de', 'es', 'pt', 'it'):
            raise ValueError('This Granite checkpoint does not support the requested language')
        samples, source_rate = read_pcm(path)
        audio = torch.tensor(samples, dtype=torch.float32).unsqueeze(0) / 32768.0
        if source_rate != rate:
            audio = resample(audio, source_rate, rate)
        with torch.inference_mode():
            inputs = processor([audio.squeeze(0).numpy()], sampling_rate=rate, device=model.device, return_tensors='pt')
            inputs = inputs.to(model.device, dtype=model.dtype)
            ids = model.generate(**inputs)
            result = processor.batch_decode(ids, skip_special_tokens=True)
        if not isinstance(result, list) or len(result) != 1 or not isinstance(result[0], str) or len(result[0]) > 32000:
            raise ValueError('Invalid local CTC transcript')
        return result[0].strip()
    return transcribe
