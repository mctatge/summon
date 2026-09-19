#!/usr/bin/env python3
"""Speaker verification worker. Extracts embeddings, enrolls, and verifies.
No microphone, no network. Communicates over JSON-on-stdio."""
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
THRESHOLD = 0.6

def emit(message):
    print(json.dumps(message, separators=(",", ":")), flush=True)

def decode_wav(raw):
    with wave.open(io.BytesIO(raw), "rb") as source:
        rate = source.getframerate()
        count = source.getnframes()
        if source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getcomptype() != "NONE":
            raise ValueError("Audio must be mono PCM16 WAV.")
        if rate < 8000 or rate > 48000 or count < rate * 0.1 or count > rate * 30:
            raise ValueError("Audio must be 0.1–30 seconds at 8–48 kHz.")
        pcm = source.readframes(count)
        if len(pcm) != count * 2:
            raise ValueError("Audio is truncated.")
    return rate, pcm, count

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--profile-dir", type=Path, required=True)
    args = parser.parse_args()

    import numpy as np
    import sherpa_onnx

    profile_path = args.profile_dir / "profile.json"
    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(args.model), num_threads=1, provider="cpu")
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
    dim = extractor.dim
    manager = sherpa_onnx.SpeakerEmbeddingManager(dim)

    # Load saved profile if it exists.
    enrolled = False
    if profile_path.exists():
        try:
            data = json.loads(profile_path.read_text())
            if data.get("dim") == dim and data.get("embeddings"):
                for emb in data["embeddings"]:
                    manager.add("owner", emb)
                enrolled = True
        except Exception:
            pass

    # Enrollment accumulator.
    enroll_embeddings = []

    def extract_embedding(raw):
        rate, pcm, count = decode_wav(raw)
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        stream = extractor.create_stream()
        stream.accept_waveform(rate, samples)
        stream.input_finished()
        if not extractor.is_ready(stream):
            return None
        return extractor.compute(stream)

    emit({"type": "ready", "dim": dim, "enrolled": enrolled, "runtime": sherpa_onnx.__version__})

    while True:
        line = sys.stdin.buffer.readline(MAX_LINE + 1)
        if not line:
            break
        if len(line) > MAX_LINE:
            raise ValueError("Request exceeds the size limit.")
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            action = request.get("type", "verify")

            if action == "verify":
                raw = base64.b64decode(request.get("audio", ""), validate=True)
                started = time.perf_counter()
                if not enrolled:
                    emit({"id": request_id, "result": {"verified": True, "score": 1.0, "reason": "not-enrolled", "elapsedMs": 0}})
                    continue
                embedding = extract_embedding(raw)
                elapsed = round((time.perf_counter() - started) * 1000, 2)
                if embedding is None:
                    emit({"id": request_id, "result": {"verified": True, "score": 1.0, "reason": "no-voice", "elapsedMs": elapsed}})
                    continue
                verified = manager.verify("owner", embedding, THRESHOLD)
                # Compute score for diagnostics.
                score = manager.score("owner", embedding) if hasattr(manager, "score") else (1.0 if verified else 0.0)
                emit({"id": request_id, "result": {"verified": bool(verified), "score": round(float(score), 3), "elapsedMs": elapsed}})

            elif action == "enroll":
                raw = base64.b64decode(request.get("audio", ""), validate=True)
                started = time.perf_counter()
                embedding = extract_embedding(raw)
                elapsed = round((time.perf_counter() - started) * 1000, 2)
                if embedding is None:
                    emit({"id": request_id, "result": {"count": len(enroll_embeddings), "error": "No voice detected in this segment.", "elapsedMs": elapsed}})
                    continue
                enroll_embeddings.append(list(embedding))
                emit({"id": request_id, "result": {"count": len(enroll_embeddings), "elapsedMs": elapsed}})

            elif action == "save":
                if not enroll_embeddings:
                    emit({"id": request_id, "error": "No enrollment samples collected."})
                    continue
                # Rebuild manager with new embeddings.
                manager = sherpa_onnx.SpeakerEmbeddingManager(dim)
                for emb in enroll_embeddings:
                    manager.add("owner", emb)
                profile_path.parent.mkdir(parents=True, exist_ok=True)
                profile_path.write_text(json.dumps({
                    "version": 1, "dim": dim, "embeddings": enroll_embeddings,
                    "model": args.model.name, "samples": len(enroll_embeddings),
                }))
                enrolled = True
                enroll_embeddings = []
                emit({"id": request_id, "result": {"saved": True, "samples": len(json.loads(profile_path.read_text())["embeddings"])}})

            elif action == "cancel":
                enroll_embeddings = []
                emit({"id": request_id, "result": {"cancelled": True}})

            else:
                emit({"id": request_id, "error": f"Unknown action: {action}"})

        except Exception as error:
            emit({"id": request_id, "error": str(error)[:300]})

if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_args: sys.exit(0))
    try:
        main()
    except Exception as error:
        print("Speaker worker failed: " + str(error), file=sys.stderr)
        sys.exit(1)
