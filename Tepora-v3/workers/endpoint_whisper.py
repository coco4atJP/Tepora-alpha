"""Optional CPU/int8 faster-whisper endpoint adapter; no downloads or audio files.

Install faster-whisper and a converted local Whisper model explicitly, then run:
  python workers/endpoint_whisper.py --model /path/to/local-model --threads 2
The existing authenticated loopback API accepts 16 kHz Float32 PCM. Chunks return
empty text; /api/finish decodes once. At most 30 seconds (1.92 MB) of raw samples
are buffered. Model memory depends on the installed model and remains resident.
Cancellation suppresses stale text; an already running native decode must drain.
"""
import argparse
import array
import json
import math
import os
import threading
import weakref

from speech_server import make_server


def local_model(path):
    """Reject model identifiers and incomplete models before importing a runtime."""
    path = os.path.abspath(os.fspath(path))
    if not os.path.isdir(path):
        raise ValueError("Supply an explicitly installed local model directory")
    # faster-whisper otherwise falls back to a remote tokenizer identifier.
    for name in ("model.bin", "config.json", "tokenizer.json"):
        if not os.path.isfile(os.path.join(path, name)):
            raise ValueError("Local model directory is missing " + name)
    return path


def numpy_pcm(samples):
    import numpy as np
    return np.frombuffer(samples, dtype=np.float32)


class AudioState:
    def __init__(self):
        self.audio = array.array("f")
        self.cancelled = threading.Event()
        self.finishing = False


class EndpointWhisper:
    MAX_SAMPLES = 16000 * 30
    MAX_TEXT = 32000

    def __init__(self, model, threads=2, language=None, *, _model_factory=None,
                 _pcm_converter=numpy_pcm):
        model = local_model(model)
        if isinstance(threads, bool) or not isinstance(threads, int) or not 1 <= threads <= 8:
            raise ValueError("CPU threads must be between 1 and 8")
        if language is not None and (not isinstance(language, str) or not language.isascii()
                                     or not language.isalpha() or not 2 <= len(language) <= 3):
            raise ValueError("Language must be a two or three letter code")
        os.environ["HF_HUB_OFFLINE"] = "1"
        if _model_factory is None:
            from faster_whisper import WhisperModel
            _model_factory = WhisperModel
        self.model = _model_factory(model, device="cpu", compute_type="int8",
                                    cpu_threads=threads, num_workers=1,
                                    local_files_only=True)
        self.language = language
        self._pcm_converter = _pcm_converter
        self._model_lock = threading.Lock()
        self._state_lock = threading.Lock()
        # AudioSessions owns the state. An expired transport session must not
        # leave its audio reachable solely through this model owner.
        self._active = None

    def _current(self):
        return self._active() if self._active is not None else None

    def _check_locked(self, state):
        if self._current() is not state or state.cancelled.is_set():
            raise ValueError("Audio session expired")

    def _check(self, state):
        with self._state_lock:
            self._check_locked(state)

    def start(self):
        state = AudioState()
        with self._state_lock:
            previous = self._current()
            if previous is not None:
                previous.cancelled.set()
                previous.audio = array.array("f")
            self._active = weakref.ref(state)
        return state

    def chunk(self, samples, state):
        with self._state_lock:
            self._check_locked(state)
            if state.finishing:
                raise BlockingIOError("Audio is still processing")
            if not 0 < len(samples) <= 16000:
                raise ValueError("Use at most one second of Float32 PCM")
            if any(not math.isfinite(value) or abs(value) > 1.01 for value in samples):
                raise ValueError("Invalid audio sample")
            if len(state.audio) + len(samples) > self.MAX_SAMPLES:
                raise ValueError("Thirty-second audio budget exhausted")
            state.audio.extend(samples)
        return ""

    def finish(self, state):
        with self._state_lock:
            self._check_locked(state)
            if state.finishing:
                raise BlockingIOError("Audio is still processing")
            state.finishing = True
            audio = state.audio
            state.audio = array.array("f")
        segments = None
        try:
            with self._model_lock:
                try:
                    self._check(state)
                    if not audio:
                        return ""
                    # The generator performs inference during iteration, so its
                    # whole lifetime belongs under the single model lock.
                    segments, _ = self.model.transcribe(
                        self._pcm_converter(audio), language=self.language,
                        beam_size=1, best_of=1, temperature=0,
                        condition_on_previous_text=False, vad_filter=False,
                        word_timestamps=False, without_timestamps=True)
                    self._check(state)
                    pieces, length = [], 0
                    for segment in segments:
                        self._check(state)
                        text = segment.text
                        if not isinstance(text, str):
                            raise ValueError("Invalid transcript")
                        length += len(text)
                        if length > self.MAX_TEXT:
                            raise ValueError("Transcript exceeds budget")
                        pieces.append(text)
                    self._check(state)
                    return "".join(pieces).strip()
                finally:
                    # Closing also drops a lazy iterator's waveform reference.
                    if segments is not None and hasattr(segments, "close"):
                        segments.close()
        finally:
            segments, audio = None, None
            self.cancel(state)

    def cancel(self, state):
        # Avoid the model lock: cancellation invalidates a running native decode
        # immediately, while the next decode waits for that bounded call to drain.
        with self._state_lock:
            state.cancelled.set()
            state.audio = array.array("f")
            if self._current() is state:
                self._active = None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="Existing local CTranslate2 Whisper directory")
    parser.add_argument("--port", type=int, default=8768)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--language", default=None, help="Optional language code, for example ja")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("Port must be between 1 and 65535")
    try:
        backend = EndpointWhisper(args.model, args.threads, args.language)
    except (ValueError, OSError, ImportError) as error:
        parser.error(str(error))
    server = make_server(backend, args.port, os.environ.get("TEPORA_SPEECH_TOKEN", ""))
    print(json.dumps({"ready": True, "port": server.server_port,
                      "endpoint_only": True, "local": True,
                      "max_audio_seconds": 30}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
