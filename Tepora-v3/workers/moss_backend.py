"""Bounded adapter for an explicitly installed MOSS Nano ONNX runtime.

Uses OrtCpuRuntime from OpenMOSS/MOSS-TTS-Nano (reviewed 8b7bcc9).
No download helpers, reference audio, voice upload, PyTorch or automatic voice choice.
"""
import importlib.util
import json
import sys
from pathlib import Path

MODEL = 'OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX'
VOICE_REQUIRED = 'SELECT_INSTALLED_BUILTIN'


def local_manifest(directory):
    root = Path(directory).resolve()
    for relative in ['browser_poc_manifest.json', 'MOSS-TTS-Nano-100M-ONNX/browser_poc_manifest.json', 'MOSS-TTS-Nano-ONNX-CPU/browser_poc_manifest.json']:
        candidate = root / relative
        if candidate.is_file():
            return candidate, json.loads(candidate.read_text(encoding='utf-8'))
    raise ValueError('Install the complete MOSS Nano ONNX model + codec and local manifest first')


def builtin_voices(directory):
    _, manifest = local_manifest(directory)
    return [row['voice'] for row in manifest.get('builtin_voices', []) if isinstance(row.get('voice'), str)]


def make_generator(runtime, tokenizer, voice, pcm_wav):
    row = next((r for r in runtime.list_builtin_voices() if r.get('voice') == voice), None)
    if not voice or voice == VOICE_REQUIRED or row is None:
        raise ValueError('Explicitly select an installed built-in voice; use --list-voices')
    codes = row.get('prompt_audio_codes')
    if not isinstance(codes, list) or not codes:
        raise ValueError('The selected built-in voice has no packaged prompt codes')
    rate = int(runtime.codec_meta['codec_config']['sample_rate'])
    channels = int(runtime.codec_meta['codec_config']['channels'])
    if channels not in (1, 2):
        raise ValueError('Unsupported MOSS output channels')

    def generate(text):
        tokens = list(tokenizer.encode(text, out_type=int))
        if not 0 < len(tokens) <= 300:
            raise ValueError('Use a short reply of at most 300 model tokens')

        def samples():
            # Four short segments maximum; the loaded runtime caps each to 375 frames.
            # No reference speech is accepted; only the explicitly selected packaged codes.
            for start in range(0, len(tokens), 75):
                request = runtime.build_voice_clone_request_rows(codes, tokens[start:start + 75])
                frames = runtime.generate_audio_frames(request)
                audio, _ = runtime.decode_full_audio(frames)
                if len(audio) != channels:
                    raise ValueError('Invalid MOSS output channels')
                for frame in zip(*audio):
                    yield from frame
        return pcm_wav(samples(), rate, channels)
    return generate


def load_moss(directory, runtime_directory, voice, pcm_wav):
    # Validate setup and voice before importing optional packages or third-party code.
    if not voice or voice == VOICE_REQUIRED or voice not in builtin_voices(directory):
        raise ValueError('Explicitly select an installed built-in voice; use --list-voices')
    script = Path(runtime_directory or '') / 'ort_cpu_runtime.py'
    if not script.is_file():
        raise ValueError('Supply --runtime-dir for an explicitly installed official MOSS repository')
    spec = importlib.util.spec_from_file_location('tepora_moss_ort_runtime', script.resolve())
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    # This low-level runtime loads local files; it has no Hugging Face download path.
    runtime = module.OrtCpuRuntime(model_dir=str(Path(directory).resolve()), thread_count=2,
                                  max_new_frames=375, execution_provider='cpu')
    import sentencepiece
    token_path = runtime.resolve_manifest_relative_path(runtime.manifest['model_files'].get('tokenizer_model', 'tokenizer.model'))
    tokenizer = sentencepiece.SentencePieceProcessor(model_file=str(token_path))
    return MODEL, voice, make_generator(runtime, tokenizer, voice, pcm_wav)
