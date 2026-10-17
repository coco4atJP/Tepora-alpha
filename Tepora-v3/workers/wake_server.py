"""Optional local openWakeWord adapter; no model discovery, downloads or audio files.

Install the optional openwakeword/onnxruntime dependencies and all three ONNX
models explicitly. Transport reuses speech_server's authenticated loopback API:
16 kHz little-endian Float32 PCM, exactly 200 ms per chunk. Text stays empty;
the chunk's ``detected`` flag latches until the session ends.

``--barge-in`` additionally permits channels=2: 6400 interleaved mic/reference
Float32 values per chunk. It loads a second detector and emits wake candidates
only after reference-first processing, a reference-wake veto and bounded delay
correlation rejection. Default delay history needs four chunks (800 ms) to warm
up. The client must pause playback, drain its acoustic tail and require a fresh
mono wake before interrupting. This is not acoustic echo cancellation; nonlinear
speaker distortion, room tails and clock drift need real hardware validation.
"""
import argparse
import array
import json
import math
import os
import threading
from collections import deque

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


def echo_correlated(microphone, reference, threshold=0.65):
    """Reject gain/delay/polarity-correlated playback, without cancelling echo.

    The reference includes the current chunk and bounded preceding samples.
    Every full microphone-length reference window is compared with zero-mean
    normalized correlation. This is a conservative veto, not validated AEC or
    a near-end speech detector. A second wake after pausing playback is required.
    Reference-before-microphone alignment follows the constraint described in
    https://speex.org/docs/manual/speex-manual/node7.html#SECTION00740000000000000000
    """
    import numpy as np
    mic = np.asarray(microphone, dtype=np.float64)
    ref = np.asarray(reference, dtype=np.float64)
    if len(ref) < len(mic):
        ref = np.pad(ref, (len(mic) - len(ref), 0))
    centered = mic - mic.mean()
    mic_power = float(np.dot(centered, centered))
    # A flat microphone cannot establish an independent wake in active playback.
    if mic_power <= 1e-12:
        return bool(np.any(np.abs(ref) > 1e-6))
    size = 1 << (len(ref) + len(mic) - 2).bit_length()
    dot = np.fft.irfft(np.fft.rfft(ref, size) * np.fft.rfft(centered[::-1], size), size)
    dot = dot[len(mic) - 1:len(ref)]
    sums = np.concatenate(([0.0], np.cumsum(ref)))
    squares = np.concatenate(([0.0], np.cumsum(ref * ref)))
    width = len(mic)
    powers = np.maximum(0, squares[width:] - squares[:-width] -
                        (sums[width:] - sums[:-width]) ** 2 / width)
    valid = powers > 1e-12
    return bool(np.any(np.abs(dot[valid]) >= threshold * np.sqrt(powers[valid] * mic_power)))


class OpenWakeWord:
    FRAME_SAMPLES = 1280
    CHUNK_SAMPLES = 3200

    def __init__(self, model, melspec_model, embedding_model, threshold=0.5,
                 *, barge_in=False, reference_veto_seconds=2.0, echo_window_ms=500,
                 _model_factory=None, _pcm_converter=numpy_pcm, _echo_matcher=echo_correlated):
        paths = [local_onnx(path) for path in (model, melspec_model, embedding_model)]
        if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not 0 < threshold <= 1:
            raise ValueError("Wake threshold must be greater than 0 and at most 1")
        if not isinstance(barge_in, bool):
            raise ValueError("Barge-in must be explicitly enabled")
        if isinstance(reference_veto_seconds, bool) or not isinstance(reference_veto_seconds, (int, float)) or not 0.5 <= reference_veto_seconds <= 5:
            raise ValueError("Reference wake veto must be between 0.5 and 5 seconds")
        if isinstance(echo_window_ms, bool) or not isinstance(echo_window_ms, int) or not 40 <= echo_window_ms <= 2000:
            raise ValueError("Echo window must be between 40 and 2000 ms")
        if _model_factory is None:
            from openwakeword.model import Model
            _model_factory = Model
        # Model forwards the feature-model kwargs to AudioFeatures. Supplying all
        # paths avoids implicit bundled models; no download helper is invoked.
        model_options = dict(wakeword_models=[paths[0]], melspec_model_path=paths[1],
                             embedding_model_path=paths[2], inference_framework="onnx")
        self.model = _model_factory(**model_options)
        self.reference_model = _model_factory(**model_options) if barge_in else None
        self.barge_in = barge_in
        self.reference_veto_samples = round(reference_veto_seconds * 16000)
        self.reference_history_samples = self.CHUNK_SAMPLES + echo_window_ms * 16
        self._echo_matcher = _echo_matcher
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
        return self._start(False)

    def start_duplex(self):
        if not self.barge_in:
            raise ValueError("Enable --barge-in explicitly to accept playback references")
        return self._start(True)

    def _start(self, duplex):
        state = {"pending": array.array("h"), "detected": False,
                 "cancelled": threading.Event(), "duplex": duplex,
                 "reference_pending": array.array("h"),
                 "reference_history": deque(maxlen=self.reference_history_samples),
                 "clock": 0, "veto_until": 0}
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
                if self.reference_model is not None:
                    self.reference_model.reset()
                self._check(state)
            except Exception:
                self.cancel(state)
                raise
        return state

    def chunk(self, samples, state):
        with self._model_lock:
            self._check(state)
            if len(samples) != self.CHUNK_SAMPLES * (2 if state["duplex"] else 1):
                raise ValueError("Expected a 200 ms wake chunk")
            if any(not math.isfinite(v) or abs(v) > 1.01 for v in samples):
                raise ValueError("Invalid wake sample")
            if state["detected"]:
                return ""
            if state["duplex"]:
                return self._chunk_duplex(samples, state)
            # Float32 transport -> signed PCM16, with exact endpoint saturation.
            state["pending"].extend(max(-32768, min(32767, round(v * 32768))) for v in samples)
            try:
                while len(state["pending"]) >= self.FRAME_SAMPLES:
                    self._check(state)
                    frame = state["pending"][:self.FRAME_SAMPLES]
                    del state["pending"][:self.FRAME_SAMPLES]
                    if self._predict(self.model, frame, state):
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

    def _predict(self, model, frame, state):
        self._check(state)
        scores = model.predict(self._pcm_converter(frame))
        self._check(state)
        if not isinstance(scores, dict) or not scores:
            raise ValueError("Invalid wake prediction")
        values = [float(score) for score in scores.values()]
        if any(not math.isfinite(score) or not 0 <= score <= 1 for score in values):
            raise ValueError("Invalid wake score")
        return max(values) >= self.threshold

    def _stream(self, samples, pending, model, state):
        pending.extend(max(-32768, min(32767, round(v * 32768))) for v in samples)
        detected = False
        while len(pending) >= self.FRAME_SAMPLES:
            frame = pending[:self.FRAME_SAMPLES]
            del pending[:self.FRAME_SAMPLES]
            detected = self._predict(model, frame, state) or detected
        return detected

    def _chunk_duplex(self, samples, state):
        microphone, reference = samples[::2], samples[1::2]
        try:
            state["clock"] += self.CHUNK_SAMPLES
            # Always feed *all* current reference frames before any microphone
            # frame, including reference that arrived alongside an echo candidate.
            state["reference_history"].extend(reference)
            if self._stream(reference, state["reference_pending"], self.reference_model, state):
                state["veto_until"] = state["clock"] + self.reference_veto_samples
            candidate = self._stream(microphone, state["pending"], self.model, state)
            # Before the history is full, a delayed microphone echo could refer
            # to playback from before this session. Treat that as ambiguous.
            if (candidate and state["clock"] >= self.reference_history_samples and
                    state["clock"] > state["veto_until"]):
                echo = self._echo_matcher(microphone, list(state["reference_history"]))
                self._check(state)
                state["detected"] = not echo
            self._check(state)
            return ""
        except Exception:
            state["pending"] = array.array("h")
            state["reference_pending"] = array.array("h")
            state["reference_history"].clear()
            self.cancel(state)
            raise

    def detection(self, state):
        self._check(state)
        return state["detected"]

    def finish(self, state):
        with self._model_lock:
            self._check(state)
            try:
                self.model.reset()
                if self.reference_model is not None:
                    self.reference_model.reset()
                self._check(state)
                return ""
            finally:
                state["pending"] = array.array("h")
                state["reference_pending"] = array.array("h")
                state["reference_history"].clear()
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
    parser.add_argument("--barge-in", action="store_true", help="Opt in to reference-vetoed duplex wake candidates; requires a fresh wake after pausing playback")
    parser.add_argument("--reference-veto-seconds", type=float, default=2.0)
    parser.add_argument("--echo-window-ms", type=int, default=500)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("Port must be between 1 and 65535")
    try:
        backend = OpenWakeWord(args.model, args.melspec_model, args.embedding_model, args.threshold,
                               barge_in=args.barge_in, reference_veto_seconds=args.reference_veto_seconds,
                               echo_window_ms=args.echo_window_ms)
    except (ValueError, OSError, ImportError) as error:
        parser.error(str(error))
    server = make_server(backend, args.port, os.environ.get("TEPORA_SPEECH_TOKEN", ""))
    print(json.dumps({"ready": True, "port": server.server_port,
                      "wake_word": True, "local": True, "barge_in": args.barge_in}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
