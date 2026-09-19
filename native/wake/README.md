# Local “Summon” wake detection

Summon uses sherpa-onnx's small English Zipformer keyword spotter, with the custom
keyword `SUMMON` tokenized against its own vocabulary. A persistent local Python
worker performs constrained keyword spotting; it returns a keyword flag, not a
transcript. The worker has no microphone or network code and keeps audio in RAM.
Full Whisper transcription starts only after a wake detection or an explicit
microphone-button command. The microphone stays off until the user enables it.

## Install

From the Summon source directory on this Mac:

```sh
/usr/bin/python3 native/wake/setup.py
```

Setup downloads about 45 MB: the official 17.6 MB model archive and pinned Python
wheels. It checks the archive SHA-256 and extracts only named regular files. The
installed footprint measured 102 MB, including the private Python environment;
the selected int8 encoder/joiner plus decoder, vocabulary and notices are 6.3 MB.
Setup requires 400 MB free for temporary installation work. It needs network
access only during installation. It neither requests mic access nor starts it.

Files live under `~/Library/Application Support/Summon/wake/`:

- `venv/` — Python environment: sherpa-onnx 1.13.8, sherpa-onnx-core 1.13.8,
  NumPy 1.26.4 and sentencepiece 0.2.2. Sentencepiece is used during setup only.
- `model/` — encoder.onnx, decoder.onnx, joiner.onnx, tokens.txt, bpe.model,
  keywords.txt and upstream license/README.
- `manifest.json` — exact model source, archive hash and installed-file hashes.

For a fixture or custom app-data directory, pass `--data-dir /absolute/path`.
`--archive /absolute/path/model.tar.bz2` can reuse the exact official archive;
checksum verification still applies. Runtime data-directory choice belongs to
the host app, which passes its resolved data directory to the detector.

## Host integration

Package this directory as an Electron `extraResources` entry with destination
`wake`. In packaged mode pass the unpacked worker path; Python cannot execute a
file inside Electron's ASAR archive.

```js
const wake = createWakeDetector({
  dataDir,
  workerPath: path.join(process.resourcesPath, 'wake', 'wake-worker.py'),
});
await wake.start();              // readiness probe: does not open a microphone
wake.status();                  // {available, loaded, keyword, model, error?}
await wake.detect(wavBytes);     // {detected, elapsedMs, keyword?, timestamp?, endTimestamp?}
await wake.stop();               // call during app shutdown; cancels active checks
```

Wire trusted-renderer `bridge.detectWake(ArrayBuffer)` to `wake.detect`. The
renderer passes one mono PCM16 WAV per voice-activity segment, bounded to 18
seconds. The worker accepts 0.1–30 seconds at 8–48 kHz, with a 3 MB byte limit.
Only one detection is in flight. Worker readiness is bounded to 12 seconds,
checks to 6 seconds, and shutdown to 1.5 seconds. Stop is permanent for an
instance; create a new detector after a full app restart.

`available` means runtime/model files were found; `loaded` means the worker
actually initialized. An error is surfaced rather than silently falling back to
continuous Whisper. If handsfree detection fails, the renderer turns capture
off. `stop()` does not persist captured audio. Optional token timestamps are
approximate and may be absent in this model/runtime.

The current frontend checks at the end of each speech segment (about 1.1 seconds
of silence), not on each microphone frame. The persistent worker avoids model
reloads, but this is not instantaneous mid-sentence interruption. A standalone
“Summon” confirmed by both detectors arms one following utterance for eight
seconds. A combined “Summon, open calendar” executes directly. If KWS fires but
Whisper does not recognize a leading Summon, the utterance is discarded and no
command window is opened. One next utterance can wait while processing finishes.

## Checks

```sh
node --test native/wake/gating.test.mjs native/wake/lifecycle.test.mjs
node native/wake/check.mjs
```

The first command uses synthetic adapters and Python children, without model
inference or microphone access. It verifies transcription gating, false-match
discard, single-use arming, explicit button behavior, cancellation and bounded
shutdown. The second uses macOS `say` to write synthetic test files, converts
them through `/opt/homebrew/bin/ffmpeg`, then checks the installed real detector.
It does not play or record audio and removes its temporary files. Use
`SUMMON_DATA_DIR` and `SUMMON_TEST_VOICES` to select a fixture and local voices.

On September 16, 2026, all 26 synthetic phrases passed using Samantha and Daniel:
10 positives (Summon alone and within commands) and 16 ordinary/near-match
negatives (including someone, summer, salmon, summarize and common). Median
detector compute time was 53 ms, p95 131 ms, with 732 ms cold worker startup.
These checks establish that the custom wake phrase works, not a measured
real-world false-activation rate. Personal voice, distance, background sound and
accents still need user testing. VAD/Whisper latency is additional.

## Upstream sources and licenses

- [Official keyword-spotter documentation](https://k2-fsa.github.io/sherpa/onnx/kws/index.html).
- [Official pretrained models](https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html).
- [Exact model archive](https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2).
- Model SHA-256: `f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a`.
- The model's supplied README declares **Apache License 2.0**. Its original text
  is retained in [licenses/MODEL-README.md](licenses/MODEL-README.md).
- sherpa-onnx is Apache-2.0; its upstream license is retained in
  [licenses/sherpa-onnx-APACHE-2.0.txt](licenses/sherpa-onnx-APACHE-2.0.txt).
- NumPy's BSD license and included-component notices are installed by its wheel
  in `venv/lib/python3.9/site-packages/numpy-1.26.4.dist-info/LICENSE.txt`.
- [sentencepiece is Apache-2.0](https://github.com/google/sentencepiece/blob/v0.2.2/LICENSE).
- [ONNX Runtime is MIT](https://github.com/microsoft/onnxruntime/blob/main/LICENSE),
  with [third-party notices](https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt).

The Python runtime/models are installed separately in private app data rather
than copied into the app bundle. Keep their upstream licenses/notices when
redistributing the installed runtime.
