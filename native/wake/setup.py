#!/usr/bin/env python3
"""Install Summon's small, pinned offline wake detector in private app data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import venv

MODEL = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/" + MODEL + ".tar.bz2"
SHA256 = "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a"
FILES = {
    "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx": "encoder.onnx",
    "decoder-epoch-12-avg-2-chunk-16-left-64.onnx": "decoder.onnx",
    "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx": "joiner.onnx",
    "tokens.txt": "tokens.txt", "bpe.model": "bpe.model", "README.md": "MODEL-README.md",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path.home() / "Library/Application Support/Summon")
    parser.add_argument("--archive", type=Path, help="Reuse the exact official archive; its SHA-256 is verified.")
    args = parser.parse_args()
    os.umask(0o077)
    root = args.data_dir.expanduser().resolve() / "wake"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if shutil.disk_usage(root).free < 400 * 1024 * 1024:
        raise RuntimeError("Wake setup needs at least 400 MB of temporary free disk space.")
    runtime = root / "venv"
    if not (runtime / "bin/python3").exists():
        venv.EnvBuilder(with_pip=True).create(runtime)
    python = runtime / "bin/python3"
    env = {key: os.environ[key] for key in ("HOME", "PATH", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
    env["PYTHONNOUSERSITE"] = "1"
    subprocess.run([str(python), "-m", "pip", "install", "--index-url", "https://pypi.org/simple", "--disable-pip-version-check", "--no-cache-dir", "--only-binary=:all:", "sherpa-onnx==1.13.8", "sherpa-onnx-core==1.13.8", "numpy==1.26.4", "sentencepiece==0.2.2"], env=env, check=True)
    with tempfile.TemporaryDirectory(prefix="setup-", dir=root) as temporary:
        archive = args.archive
        if archive is None:
            archive = Path(temporary) / "model.tar.bz2"
            with urllib.request.urlopen(URL, timeout=30) as response, archive.open("wb") as out:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
                    if out.tell() > 30_000_000:
                        raise RuntimeError("The model download exceeded its size budget.")
        if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
            raise RuntimeError("Model archive checksum mismatch; nothing was installed.")
        model = root / "model"
        model.mkdir(exist_ok=True, mode=0o700)
        with tarfile.open(archive, "r:bz2") as contents:
            for original, destination in FILES.items():
                member = contents.getmember(MODEL + "/" + original)
                if not member.isfile() or member.size > 15_000_000:
                    raise RuntimeError("Unexpected model archive entry.")
                # Explicit filenames avoid archive path traversal and symlinks.
                with contents.extractfile(member) as source, (model / destination).open("wb") as target:
                    shutil.copyfileobj(source, target)
        tokenize = "import sentencepiece as s,sys; p=s.SentencePieceProcessor(model_file=sys.argv[1]); print(' '.join(p.encode('SUMMON',out_type=str))+' @SUMMON')"
        keywords = subprocess.check_output([str(python), "-c", tokenize, str(model / "bpe.model")], env=env, text=True).strip()
        if "<unk>" in keywords or not keywords.endswith("@SUMMON"):
            raise RuntimeError("The model could not tokenize Summon.")
        (model / "keywords.txt").write_text(keywords + "\n", encoding="utf8")
        license_text = urllib.request.urlopen("https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v1.13.8/LICENSE", timeout=20).read()
        (model / "LICENSE-APACHE-2.0.txt").write_bytes(license_text)
        manifest = {
            "version": 1, "keyword": "Summon", "model": MODEL,
            "source": URL, "archiveSha256": SHA256, "runtime": "sherpa-onnx 1.13.8",
            "license": "Apache-2.0 (declared in upstream model README)",
            "files": {name: hashlib.sha256((model / name).read_bytes()).hexdigest() for name in [*FILES.values(), "keywords.txt"]},
        }
        (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"installed": True, "directory": str(root), "modelBytes": sum(p.stat().st_size for p in model.iterdir() if p.is_file()), "keyword": "Summon"}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Wake setup failed: " + str(error), file=sys.stderr)
        sys.exit(1)
