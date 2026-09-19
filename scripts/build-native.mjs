import { spawnSync } from 'node:child_process';
import { mkdirSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

if (process.platform !== 'darwin') {
  console.error('The Summon activity helper requires macOS.');
  process.exit(1);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cache = `/private/tmp/summon-swift-cache-${process.getuid()}`;
mkdirSync(cache, { recursive: true, mode: 0o700 });
const binary = join(root, 'native', 'summon-context');
const result = spawnSync('/usr/bin/xcrun', [
  'swiftc', '-O', '-module-cache-path', cache,
  '-framework', 'AppKit', '-framework', 'ApplicationServices',
  join(root, 'native', 'Context.swift'), '-o', binary,
], {
  stdio: 'inherit',
  env: { ...process.env, CLANG_MODULE_CACHE_PATH: cache, SWIFT_MODULECACHE_PATH: cache },
});
if (result.error) {
  console.error(`Could not compile the native helper: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
chmodSync(binary, 0o755);
console.log(`Built ${binary}`);

// Use the already installed whisper.cpp C API. The private worker talks only
// over its inherited pipes; it exposes no transcription server or microphone.
const brewRoot = ['/opt/homebrew/opt', '/usr/local/opt'].find(prefix =>
  existsSync(join(prefix, 'whisper-cpp/include/whisper.h')) && existsSync(join(prefix, 'ggml/include/ggml-backend.h')));
if (!brewRoot) {
  console.error('Building local voice requires the installed whisper-cpp and ggml Homebrew libraries.');
  process.exit(1);
}
const speechBinary = join(root, 'native', 'summon-transcribe');
const whisperVersion = readFileSync(join(brewRoot, 'whisper-cpp/lib/pkgconfig/whisper.pc'), 'utf8').match(/^Version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/m)?.[1];
if (!whisperVersion) {
  console.error('Could not identify the installed Whisper API version.');
  process.exit(1);
}
const speech = spawnSync('/usr/bin/xcrun', [
  'clang++', '-std=c++17', '-O2', '-fobjc-arc', '-framework', 'Foundation',
  `-DSUMMON_WHISPER_VERSION="${whisperVersion}"`,
  `-I${join(brewRoot, 'ggml/include')}`, `-I${join(brewRoot, 'whisper-cpp/include')}`,
  `-L${join(brewRoot, 'ggml/lib')}`, `-L${join(brewRoot, 'whisper-cpp/lib')}`,
  '-lggml', '-lggml-base', '-lwhisper',
  join(root, 'native', 'transcription-worker.mm'), '-o', speechBinary,
], { stdio: 'inherit' });
if (speech.error || speech.status !== 0) {
  console.error(`Could not compile local speech: ${speech.error?.message || 'compiler failure'}`);
  process.exit(speech.status || 1);
}
chmodSync(speechBinary, 0o755);
console.log(`Built ${speechBinary}`);

const fnKeyBinary = join(root, 'native', 'summon-fn-key');
const fnKey = spawnSync('/usr/bin/xcrun', [
  'clang', '-O2', '-Wall', '-Wextra', '-Werror', '-fblocks',
  '-mmacosx-version-min=12.0',
  join(root, 'native', 'fn-key', 'main.c'),
  '-framework', 'CoreGraphics', '-framework', 'CoreFoundation',
  '-o', fnKeyBinary,
], { stdio: 'inherit' });
if (fnKey.error || fnKey.status !== 0) {
  console.error(`Could not compile fn-key helper: ${fnKey.error?.message || 'compiler failure'}`);
  process.exit(fnKey.status || 1);
}
chmodSync(fnKeyBinary, 0o755);
console.log(`Built ${fnKeyBinary}`);
