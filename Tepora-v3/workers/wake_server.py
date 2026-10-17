"""Optional local openWakeWord adapter; no model discovery, downloads or audio files.

Install the optional openwakeword/onnxruntime dependencies and all three ONNX
models explicitly. Transport reuses speech_server's authenticated loopback API:
16 kHz little-endian Float32 PCM, exactly 200 ms per chunk. Text stays empty;
the chunk's ``detected`` flag latches until the session ends.
"""
import argparse
import array
import json
import math
import os
import threading

from speech_server import make_server


def local_onnx(path):
    """Require an explicit existing local file before importing the ML runtime."""
    path = os.path.abspath(os.fspath(path))
    if not path.lower().endswith(".onnx") or not os.path.isfile(path):
        raise ValueError("Supply an explicitly installed local .onnx model file")
    return path


def numpy_pcm(samples):
    import numpy as np
    return np.frombuffer(samples, dtype=np.int16)


class OpenWakeWord:
    FRAME_SAMPLES = 1280
    CHUNK_SAMPLES = 3200

    def __init__(self, model, melspec_model, embedding_model, threshold=0.5,
                 *, _model_factory=None, _pcm_converter=numpy_pcm):
        paths = [local_onnx(path) for path in (model, melspec_model, embedding_model)]
        if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not 0 < threshold <= 1:
            raise ValueError("Wake threshold must be greater than 0 and at most 1")
        if _model_factory is None:
            from openwakeword.model import Model
            _model_factory = Model
        # Model forwards the feature-model kwargs to AudioFeatures. Supplying all
        # paths avoids implicit bundled models; no download helper is invoked.
        self.model = _model_factory(wakeword_models=[paths[0]],
                                   melspec_model_path=paths[1],
                                   embedding_model_path=paths[2],
                                   inference_framework="onnx")
        self.threshold = threshold
        self._pcm_converter = _pcm_converter
        self._model_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._active = None

    def _check(self, state):
        with self._state_lock:
            if state is not self._active or state["cancelled"].is_set():
                raise ValueError("Wake session expired")

    def start(self):
        state = {"pending": array.array("h"), "detected": False,
                 "cancelled": threading.Event()}
        # Invalidate before waiting for a running prediction. Its result must be
        # discarded before this session can reset and use the shared model.
        with self._state_lock:
            if self._active is not None:
                self._active["cancelled"].set()
            self._active = state
        with self._model_lock:
            try:
                self._check(state)
                self.model.reset()
                self._check(state)
            except Exception:
                self.cancel(state)
                raise
        return state

    def chunk(self, samples, state):
        with self._model_lock:
            self._check(state)
            if len(samples) != self.CHUNK_SAMPLES:
                raise ValueError("Expected a 200 ms wake chunk")
            if any(not math.isfinite(v) or abs(v) > 1.01 for v in samples):
                raise ValueError("Invalid wake sample")
            if state["detected"]:
                return ""
            # Float32 transport -> signed PCM16, with exact endpoint saturation.
            state["pending"].extend(max(-32768, min(32767, round(v * 32768))) for v in samples)
            try:
                while len(state["pending"]) >= self.FRAME_SAMPLES:
                    self._check(state)
                    frame = state["pending"][:self.FRAME_SAMPLES]
                    del state["pending"][:self.FRAME_SAMPLES]
                    scores = self.model.predict(self._pcm_converter(frame))
                    self._check(state)
                    if not isinstance(scores, dict) or not scores:
                        raise ValueError("Invalid wake prediction")
                    values = [float(score) for score in scores.values()]
                    if any(not math.isfinite(score) or not 0 <= score <= 1 for score in values):
                        raise ValueError("Invalid wake score")
                    if max(values) >= self.threshold:
                        state["detected"] = True
                        state["pending"] = array.array("h")
                        break
                self._check(state)
            except Exception:
                # Failed inference may have mutated model buffers; require a new
                # session/reset instead of retrying partially consumed audio.
                state["pending"] = array.array("h")
                self.cancel(state)
                raise
            return ""

    def detection(self, state):
        self._check(state)
        return state["detected"]

    def finish(self, state):
        with self._model_lock:
            self._check(state)
            try:
                self.model.reset()
                self._check(state)
                return ""
            finally:
                state["pending"] = array.array("h")
                self.cancel(state)

    def cancel(self, state):
        # No model lock: cancellation can invalidate an in-flight predict/reset.
        # The bounded in-flight frame drains; the next start resets the model.
        with self._state_lock:
            state["cancelled"].set()
            if self._active is state:
                self._active = None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8769)
    parser.add_argument("--model", required=True, help="Local wake-word .onnx model")
    parser.add_argument("--melspec-model", required=True, help="Local melspectrogram .onnx model")
    parser.add_argument("--embedding-model", required=True, help="Local embedding .onnx model")
    parser.add_argument("--threshold", type=float, default=0.5)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("Port must be between 1 and 65535")
    try:
        backend = OpenWakeWord(args.model, args.melspec_model, args.embedding_model, args.threshold)
    except (ValueError, OSError, ImportError) as error:
        parser.error(str(error))
    server = make_server(backend, args.port, os.environ.get("TEPORA_SPEECH_TOKEN", ""))
    print(json.dumps({"ready": True, "port": server.server_port,
                      "wake_word": True, "local": True}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
