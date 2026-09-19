# macOS context helper

Build on macOS with Xcode or Command Line Tools installed:

```sh
node scripts/build-native.mjs
node native/check.mjs
```

The helper is compiled for the current machine's architecture. Swift module
caches live in `/private/tmp`, outside the repository. Compile again on another
architecture; distribute the helper in the app's resources, outside an ASAR.
The check script uses synthetic temporary files. It does not start activity
monitoring or request permissions.

Commands print JSON to stdout; diagnostics go to stderr:

```sh
native/summon-context permissions
native/summon-context request-accessibility
native/summon-context metadata '/absolute/path/to/workbook.xlsx'
native/summon-context watch
native/summon-context watch --accessibility --exclude com.example.private,com.example.other
```

- `permissions` returns `{"accessibility":false}` or `true`, without prompting.
- `request-accessibility` requests the macOS permission and returns its current
  state. The prompt is asynchronous: permission may still be false when it
  returns. Call this only from an explicit user action. Development helpers and
  packaged applications can have separate macOS permission identities.
- `metadata` returns `{}` when source metadata is unavailable. Otherwise it
  returns `{"sourceUrl":"https://example.com/course"}` from the file's
  `kMDItemWhereFroms` extended attribute. It prefers a referring page when the
  browser supplied one, removes credentials, query strings and fragments, and
  rejects non-HTTP(S) URLs. Some sites include secrets in URL paths; source URLs
  remain local and must not be forwarded automatically to an AI service.
- `watch` emits an initial permissions record and the active application,
  followed by app activation changes. With `--accessibility`, it samples the
  focused window title and its local `AXDocument` path at most every three
  seconds between activations, only when permission is granted. Unavailable
  titles and document paths are omitted. Permission changes are checked every
  five seconds. Identical consecutive activity snapshots are suppressed.

Watch records:

```json
{"type":"permissions","accessibility":false}
{"type":"activity","app":"Microsoft Excel","bundleId":"com.microsoft.Excel","at":"2026-09-15T20:00:00.000Z"}
{"type":"activity-hidden"}
```

Optional activity fields are `title` (at most 300 characters) and `documentPath`
(an existing local file). An excluded app or unavailable foreground app emits
`activity-hidden`, without any app identity, title, path or timestamp. The host
clears its transient app context without adding a history entry. Consecutive
hidden records are suppressed. `com.summon.companion` is silently ignored so the
host can retain its last observed foreground context while Summon is open.
SIGTERM, SIGINT, SIGHUP, a closed stdout pipe, or termination of the
supervising parent stop the helper. The app should stop it when paused or when
activity tracking is disabled, and restart it when exclusions or permission
preferences change.

There is no Input Monitoring, keylogging, screenshot capture, document reading,
Accessibility traversal, network access, or persistence in this helper.

API references: [NSWorkspace activation notifications](https://developer.apple.com/documentation/appkit/nsworkspace/didactivateapplicationnotification),
[AXIsProcessTrustedWithOptions](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions),
[AXUIElementCopyAttributeValue](https://developer.apple.com/documentation/applicationservices/1462085-axuielementcopyattributevalue).

## Private speech worker

The same build script compiles `transcription-worker.mm` to `summon-transcribe`
using the installed Homebrew `whisper-cpp` and `ggml` headers/libraries. It reads
the Whisper version from its installed pkg-config record and compiles an ABI
guard: if the runtime changes, rebuild the helper before using voice again.
The current local build uses whisper.cpp 1.9.1. The packaged worker remains
dependent on those installed libraries; they are not bundled or downloaded.

The parent supplies one selected model path at launch. The worker loads it once,
prepares its inference graph on synthetic silence, and reports readiness. It
then accepts bounded JSON lines with an ID and base64 float32 mono 16 kHz PCM,
returning text and numeric decode time on stdout. Diagnostics use stderr.
There is no microphone, HTTP server, socket, or audio/transcript persistence.
The model opens only after voice is enabled or an explicit transcription request.

`src/main/transcription.mjs` validates PCM16 WAV, resamples in memory, serializes
model changes, and holds a session lease while listening is enabled. After that
lease is released it retires an idle worker after 60 seconds. Startup and decode
have deadlines; quit cancels outstanding operations and forcibly releases a
stuck child after a bounded wait. The worker clears prior transcription context
between requests and preserves Whisper CLI beam size 5, best-of 5 and
temperature fallback within a 15-second decode deadline. Synthetic benchmarks and their limits live in
`docs/routing-research.md`.

The Homebrew Metal plugin embeds shader source and can spend around 19 seconds
compiling it on a cold cache before model loading. For local installation,
prepare the final signed helper once with a bounded setup timeout and verify a
second startup before handing the app back. The cache can be invalidated by
future updates or eviction. Merely providing `GGML_METAL_PATH_RESOURCES` does not
bypass compilation in this embedded-source build. Production voice startup
keeps its 20-second deadline; no permanent timeout increase is part of this fix.
