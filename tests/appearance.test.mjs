import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCompanion } from '../src/core/companion.mjs';
import { DEFAULT_ACCENT, parseAccentColor } from '../src/core/appearance.mjs';
import { ACCENT_PRESETS, accentVariables } from '../src/renderer/appearance.ts';

async function fixture(t) {
  const homeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-appearance-')));
  const dataDir = path.join(homeDir, 'Data');
  await fs.mkdir(path.join(homeDir, 'Downloads'));
  await fs.mkdir(path.join(homeDir, 'Desktop'));
  const services = [];
  const create = async () => {
    const service = await createCompanion({ homeDir, dataDir });
    services.push(service);
    return service;
  };
  t.after(async () => {
    for (const service of services) await service.stop();
    await fs.rm(homeDir, { recursive: true, force: true });
  });
  return { homeDir, dataDir, create };
}

test('accent persists locally across a service restart, normalized without changing other preferences', async t => {
  const f = await fixture(t), service = await f.create();
  assert.equal(service.snapshot().settings.accentColor, DEFAULT_ACCENT);
  await service.updateSettings({ accentColor: ' #ABC ', retentionDays: 14 });
  assert.equal(service.snapshot().settings.accentColor, '#aabbcc');
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.equal(saved.settings.accentColor, '#aabbcc');
  await service.stop();
  const reopened = await f.create();
  assert.equal(reopened.snapshot().settings.accentColor, '#aabbcc');
  assert.equal(reopened.snapshot().settings.retentionDays, 14);
});

test('invalid custom colors reject the whole settings patch and leave saved state unchanged', async t => {
  const f = await fixture(t), service = await f.create();
  await service.updateSettings({ accentColor: '#32664c', retentionDays: 14 });
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  for (const accentColor of [null, 42, {}, '', 'white', '#12345', '#11223344', 'red; background:url(https://example.com)']) {
    await assert.rejects(service.updateSettings({ retentionDays: 30, accentColor }), /Accent color/);
    assert.equal(service.snapshot().settings.accentColor, '#32664c');
    assert.equal(service.snapshot().settings.retentionDays, 14);
    assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before);
  }
});

test('old state and a damaged cosmetic preference recover to black without discarding workspace history', async t => {
  const f = await fixture(t), service = await f.create();
  await service.addProject({ name: 'Local workspace', path: f.homeDir });
  await service.updateSettings({ retentionDays: 14 });
  await service.stop();
  const statePath = path.join(f.dataDir, 'state.json');
  const original = JSON.parse(await fs.readFile(statePath, 'utf8'));
  for (const color of [undefined, 'not-a-color', { url: 'untrusted' }]) {
    const state = structuredClone(original);
    if (color === undefined) delete state.settings.accentColor;
    else state.settings.accentColor = color;
    await fs.writeFile(statePath, JSON.stringify(state));
    const restored = await f.create();
    assert.equal(restored.snapshot().settings.accentColor, DEFAULT_ACCENT);
    assert.equal(restored.snapshot().settings.retentionDays, 14);
    assert.equal(restored.snapshot().projects[0].name, 'Local workspace');
    assert.equal(restored.snapshot().health.errors.length, 0);
    await restored.stop();
  }
  assert.equal((await fs.readdir(f.dataDir)).some(file => file.includes('.corrupt-')), false);
});

// Independent WCAG contrast calculation checks the generated roles, including
// arbitrary pale custom colors that would make white button labels disappear.
function ratio(a, b) {
  const luminance = color => {
    const channels = color.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
      .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const first = luminance(a), second = luminance(b);
  return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
}

test('accent roles retain user colors while making button labels, text and usage bars readable', () => {
  const samples = [...ACCENT_PRESETS.map(preset => preset.color), '#ffffff', '#ffff00', '#00ff00', '#77aaff', '#ff00ff', '#757575'];
  // Exercise different luminances and hues across the custom-color space.
  for (let red = 0; red <= 255; red += 51) for (let green = 0; green <= 255; green += 51) for (let blue = 0; blue <= 255; blue += 51) {
    samples.push(`#${[red, green, blue].map(channel => channel.toString(16).padStart(2, '0')).join('')}`);
  }
  for (const color of samples) {
    const vars = accentVariables(color);
    assert.equal(vars['--accent'], color);
    assert.ok(ratio(color, vars['--on-accent']) >= 4.5, `${color} button label`);
    assert.ok(ratio(vars['--accent-hover'], vars['--on-accent']) >= 4.5, `${color} hovered button label`);
    for (const surface of ['#ffffff', '#eaeae8', '#f5f5f3', vars['--accent-soft']]) {
      assert.ok(ratio(vars['--accent-ink'], surface) >= 4.5, `${color} text on ${surface}`);
      assert.ok(ratio(vars['--accent-meter'], surface) >= 3, `${color} meter on ${surface}`);
    }
    if (ratio(color, '#ffffff') < 3) assert.ok(ratio(vars['--accent-edge'], '#ffffff') >= 3);
  }
});

test('renderer defaults and color parsing never emit unchecked CSS', () => {
  assert.deepEqual(accentVariables(), accentVariables(DEFAULT_ACCENT));
  assert.deepEqual(accentVariables('url(https://example.com)'), accentVariables(DEFAULT_ACCENT));
  assert.equal(parseAccentColor(' #ABCDEF '), '#abcdef');
  assert.equal(parseAccentColor('#f09'), '#ff0099');
  assert.equal(parseAccentColor('#ffff'), null);
});
