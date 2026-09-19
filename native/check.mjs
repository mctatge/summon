import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise JSON and untrusted download metadata without recording user activity,
// reading real downloads, or displaying a macOS permission prompt.
const helper = join(dirname(fileURLToPath(import.meta.url)), 'summon-context');
const run = (...args) => {
  const result = spawnSync(helper, args, { encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
};
assert.equal(typeof run('permissions').accessibility, 'boolean');
const directory = mkdtempSync('/private/tmp/summon-native-check-');
try {
  const file = join(directory, 'synthetic-workbook.xlsx');
  writeFileSync(file, 'Synthetic test fixture.');
  assert.deepEqual(run('metadata', join(directory, 'missing.xlsx')), {});
  assert.deepEqual(run('metadata', file), {});
  const setAttribute = (xml) => {
    const result = spawnSync('/usr/bin/xattr', [
      '-wx', 'com.apple.metadata:kMDItemWhereFroms', Buffer.from(xml).toString('hex'), file,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  setAttribute('<plist version="1.0"><array><string>https://download.example/report.xlsx?signature=secret</string><string>https://user:password@example.com/course?token=secret#heading</string></array></plist>');
  assert.deepEqual(run('metadata', file), { sourceUrl: 'https://example.com/course' });
  setAttribute('<plist version="1.0"><array><string>file:///private/example.xlsx</string><string>javascript:alert(1)</string></array></plist>');
  assert.deepEqual(run('metadata', file), {});
  setAttribute('<plist version="1.0"><array><string>https://example.com/path?q=secret</string></array></plist>');
  assert.deepEqual(run('metadata', file), { sourceUrl: 'https://example.com/path' });
  setAttribute('<plist version="1.0"><dict><key>unexpected</key><string>value</string></dict></plist>');
  assert.deepEqual(run('metadata', file), {});
  setAttribute('malformed property list');
  assert.deepEqual(run('metadata', file), {});
  const invalid = spawnSync(helper, ['watch', '--unknown'], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(invalid.status, 64);
  assert.equal(invalid.stdout, '');
  const fixtureBinary = join(directory, 'context-visibility-check');
  const compiled = spawnSync('/usr/bin/xcrun', [
    'swiftc', '-D', 'SUMMON_CONTEXT_TEST', '-module-cache-path',
    `/private/tmp/summon-swift-cache-${process.getuid()}`,
    '-framework', 'AppKit', '-framework', 'ApplicationServices',
    join(dirname(helper), 'Context.swift'), '-o', fixtureBinary,
  ], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message);
  const visibility = spawnSync(fixtureBinary, [], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(visibility.status, 0, visibility.stderr);
  assert.deepEqual(JSON.parse(visibility.stdout), { visibilityChecks: true });
  console.log('Native JSON, permission read, URL sanitization, metadata failure and hidden-context checks passed.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
