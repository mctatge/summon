#!/usr/bin/env python3
"""In-memory WAV keyword spotting. No microphone, transcripts, files or network."""
import argparse
import base64
import io
import json
from pathlib import Path
import signal
import sys
import time
import wave

MAX_LINE = 4_000_000


def emit(message):
    print(json.dumps(message, separators=(",", ":")), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    args = parser.parse_args()
    import numpy as np
    import sherpa_onnx
    model = args.model_dir
    kws = sherpa_onnx.KeywordSpotter(
        tokens=str(model / "tokens.txt"), encoder=str(model / "encoder.onnx"),
        decoder=str(model / "decoder.onnx"), joiner=str(model / "joiner.onnx"),
        keywords_file=str(model / "keywords.txt"), num_threads=1, provider="cpu",
        keywords_score=1.5, keywords_threshold=0.35, num_trailing_blanks=2,
    )
    emit({"type": "ready", "keyword": "Summon", "runtime": sherpa_onnx.__version__})
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE + 1)
        if not line:
            break
        if len(line) > MAX_LINE:
            raise ValueError("Wake request exceeds the audio limit.")
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            if not isinstance(request_id, str) or len(request_id) > 100:
                raise ValueError("Invalid wake request identifier.")
            raw = base64.b64decode(request.get("audio", ""), validate=True)
            if len(raw) > 3_000_000:
                raise ValueError("Wake audio exceeds the size limit.")
            with wave.open(io.BytesIO(raw), "rb") as source:
                rate, count = source.getframerate(), source.getnframes()
                if source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getcomptype() != "NONE":
                    raise ValueError("Wake audio must be mono PCM16 WAV.")
                if rate < 8000 or rate > 48000 or count < rate * 0.1 or count > rate * 30:
                    raise ValueError("Wake audio must be 0.1–30 seconds at 8–48 kHz.")
                pcm = source.readframes(count)
                if len(pcm) != count * 2:
                    raise ValueError("Wake audio is truncated.")
            started = time.perf_counter()
            samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
            stream = kws.create_stream()
            stream.accept_waveform(rate, samples)
            stream.accept_waveform(rate, np.zeros(int(rate * 0.7), dtype=np.float32))
            stream.input_finished()
            result = {"detected": False}
            while kws.is_ready(stream):
                kws.decode_stream(stream)
                keyword_result = kws.keyword_spotter.get_result(stream)
                if keyword_result.keyword.strip():
                    stamps = keyword_result.timestamps
                    result = {"detected": True, "keyword": "Summon"}
                    if stamps:
                        result["timestamp"] = round(float(stamps[0]), 3)
                        result["endTimestamp"] = round(float(stamps[-1]) + 0.12, 3)
                    kws.reset_stream(stream)
                    break
            result["elapsedMs"] = round((time.perf_counter() - started) * 1000, 2)
            emit({"id": request_id, "result": result})
        except Exception as error:
            # Errors describe format/runtime state, never the captured audio.
            emit({"id": request_id, "error": str(error)[:300]})


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_args: sys.exit(0))
    try:
        main()
    except Exception as error:
        print("Wake worker failed: " + str(error), file=sys.stderr)
        sys.exit(1)
