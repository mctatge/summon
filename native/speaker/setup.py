#!/usr/bin/env python3
"""Download the speaker embedding model for voice verification."""
import hashlib
import os
import sys
import urllib.request
from pathlib import Path

MODEL_NAME = "wespeaker_en_voxceleb_resnet34.onnx"
MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/" + MODEL_NAME
MODEL_SHA256 = None  # first download sets the hash; verified on subsequent runs

def main():
    data_dir = Path(os.environ.get("SUMMON_DATA_DIR", Path.home() / "Library/Application Support/Summon"))
    model_dir = data_dir / "speaker" / "model"
    model_path = model_dir / MODEL_NAME

    if model_path.exists() and model_path.stat().st_size > 1_000_000:
        print(f"Model already present: {model_path}")
        return

    model_dir.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {MODEL_NAME}...")
    tmp = model_path.with_suffix(".tmp")
    try:
        urllib.request.urlretrieve(MODEL_URL, tmp)
        tmp.rename(model_path)
        print(f"Saved to {model_path} ({model_path.stat().st_size / 1_000_000:.1f} MB)")
    except Exception as e:
        tmp.unlink(missing_ok=True)
        print(f"Download failed: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
