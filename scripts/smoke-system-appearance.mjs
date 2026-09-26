import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

// Exercise the packaged window and renderer without changing macOS appearance
// or the user's Summon settings. NativeTheme drives Chromium's real media query.
const require = createRequire(import.meta.url);
const { _electron } = require(process.env.SUMMON_PLAYWRIGHT || 'playwright');
const dir = await mkdtemp('/private/tmp/summon-appearance-ui-');
const home = path.join(dir, 'home'), data = path.join(dir, 'data');
for (const folder of ['Downloads', 'Desktop']) await mkdir(path.join(home, folder), { recursive: true });
await mkdir(data, { recursive: true });
await writeFile(path.join(home, 'Downloads', 'Project notes.txt'), 'Appearance test fixture');
const executablePath = process.env.SUMMON_APP || require('electron');
const electron = await _electron.launch({ executablePath, args: process.env.SUMMON_APP ? [] : ['.'],
  env: { ...process.env, SUMMON_TEST_HOME: home, SUMMON_DATA_DIR: data, SUMMON_SOCKET: path.join(dir, 'test.sock') }, timeout: 60000 });
const errors = [];
try {
  const page = await electron.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: null });
  await page.getByRole('heading', { name: 'All projects', exact: true }).waitFor();
  assert.equal(await electron.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'system');
  for (const theme of ['dark', 'light', 'dark']) {
    await electron.evaluate(({ nativeTheme }, value) => { nativeTheme.themeSource = value; }, theme);
    const dark = theme === 'dark';
    await page.waitForFunction(value => matchMedia('(prefers-color-scheme: dark)').matches === value, dark);
    await page.waitForFunction(value => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === value, dark ? '#edf0eb' : '#141615');
    const colors = await page.evaluate(() => ({
      background: getComputedStyle(document.documentElement).backgroundColor,
      scheme: getComputedStyle(document.documentElement).colorScheme,
    }));
    assert.equal(colors.background, dark ? 'rgb(25, 27, 26)' : 'rgb(234, 234, 232)');
    assert.equal(colors.scheme, theme);
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase()), dark ? '#191b1a' : '#eaeae8');
  }
  await page.screenshot({ path: path.join(dir, 'dark-work.png') });
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await page.screenshot({ path: path.join(dir, 'dark-assistant.png') });
  await page.getByRole('button', { name: 'Preferences', exact: true }).last().click();
  await page.getByRole('dialog').waitFor();
  await page.getByText('Light and dark mode follow your macOS appearance automatically.').waitFor();
  await page.screenshot({ path: path.join(dir, 'dark-preferences.png') });
  await page.getByRole('button', { name: 'Forest accent', exact: true }).click();
  await page.waitForFunction(async () => (await window.summon.snapshot()).settings.accentColor === '#32664c');
  const darkInk = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-ink'));
  await electron.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
  await page.waitForFunction(previous => getComputedStyle(document.documentElement).getPropertyValue('--accent-ink') !== previous, darkInk);
  assert.equal(await page.evaluate(async () => (await window.summon.snapshot()).settings.accentColor), '#32664c', 'System changes preserve the chosen accent');
  await page.screenshot({ path: path.join(dir, 'light-preferences.png') });
  await electron.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
  await page.reload();
  await page.getByRole('heading', { name: 'All projects', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark', 'A fresh renderer starts in the active system appearance');
  assert.equal(await page.evaluate(async () => (await window.summon.snapshot()).settings.accentColor), '#32664c');
  assert.deepEqual(errors, []);
  await electron.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system'; });
  console.log(JSON.stringify({ passed: true, screenshots: dir, checks: 'system default, live dark/light/dark, native backing, preferences, saved accent, renderer reload' }));
} catch (error) {
  const page = await electron.firstWindow();
  console.error(await electron.evaluate(({ nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors })));
  console.error(await page.evaluate(() => ({ dark: matchMedia('(prefers-color-scheme: dark)').matches, scheme: getComputedStyle(document.documentElement).colorScheme, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent') })));
  throw error;
} finally {
  await electron.close();
  await rm(data, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
}
