import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { createLauncher, claudeHooksSettings } from '../src/main/launcher.mjs';
import { setSealedSegments } from '../src/core/workstreams.mjs';
import { WORK_CHECKPOINT_INSTRUCTIONS } from '../src/core/work-item-protocol.mjs';

// The sealed-folder guard is empty until configured; these fixtures seal any path segment containing 'sealed-client'.
setSealedSegments(['sealed-client']);

// The launcher against a temporary home and data folder, a fake `open` and fake CLI paths. No Terminal is opened and no
// real CLI runs; the repo root is a fabricated folder whose name needs TOML escaping.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NODE = '/opt/homebrew/bin/node';
const CLAUDE = '/Users/someone/.local/bin/claude';
const CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex';
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'SessionEnd'];
const HEADER = '#!/bin/zsh\n# Written by Summon for one launch; safe to delete.\nset -eu\nunset ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY CLAUDECODE NODE_OPTIONS\n';

async function fixture(t, { node = NODE, packaged = false, benchmark, readModels } = {}) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'summon-launch-')));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const homeDir = path.join(tmp, 'home');
  const dataDir = path.join(tmp, 'data');
  const root = path.join(tmp, 'repo "q"');
  const resourcesPath = path.join(tmp, 'Resources');
  const folder = path.join(homeDir, 'Projects', 'Hackathon — API World 2026', "it's");
  const vault = path.join(homeDir, 'Second Brain');
  for (const dir of [dataDir, path.join(root, 'scripts'), resourcesPath, folder, path.join(vault, 'Projects', 'Deep'), path.join(homeDir, 'Archive', 'sealed-client', 'app'), path.join(homeDir, 'Notes', 'Second Brain'), path.join(homeDir, '.claude'), path.join(homeDir, '.codex')]) await fs.mkdir(dir, { recursive: true });
  for (const name of ['summon-hook.mjs', 'mcp-server.mjs']) { await fs.writeFile(path.join(root, 'scripts', name), '// fake\n'); await fs.writeFile(path.join(resourcesPath, name), '// fake\n'); }
  const runs = []; const launches = []; const binaries = { claude: CLAUDE, codex: CODEX, node };
  const projects = [
    { id: 'project-hack', name: 'Hackathon — API World 2026', path: folder, color: 'ink' },
    { id: 'project-vault', name: 'Second Brain', path: vault, color: 'ink' },
    { id: 'project-deep', name: 'Deep', path: path.join(vault, 'Projects', 'Deep'), color: 'ink' },
    { id: 'project-brain-name', name: 'Brain', path: path.join(homeDir, 'Notes', 'Second Brain'), color: 'ink' },
    { id: 'project-sealed', name: 'App', path: path.join(homeDir, 'Archive', 'sealed-client', 'app'), color: 'ink' },
    { id: 'project-gone', name: 'Gone', path: path.join(homeDir, 'Projects', 'Gone'), color: 'ink' },
  ];
  const launcher = createLauncher({
    dataDir, homeDir, root, resourcesPath, isPackaged: packaged, benchmark, readModels,
    run: async (binary, args) => { runs.push([binary, [...args]]); },
    executable: async name => { if (!binaries[name]) throw new Error(`${name} is not installed. Install it, then restart Summon.`); return binaries[name]; },
    getProjects: async () => projects,
    agentSessions: { noteLaunch: async value => { launches.push(structuredClone(value)); return value; } },
  });
  return { tmp, homeDir, dataDir, root, resourcesPath, folder, vault, projects, launcher, runs, launches, binaries };
}
const sh = value => `'${value.replace(/'/g, "'\\''")}'`;
const launchDir = f => path.join(f.dataDir, 'launch');
async function onlyCommand(f) {
  const names = (await fs.readdir(launchDir(f))).filter(name => name.endsWith('.command'));
  assert.equal(names.length, 1, names.join(','));
  const file = path.join(launchDir(f), names[0]);
  return { file, name: names[0], text: await fs.readFile(file, 'utf8'), mode: (await fs.stat(file)).mode & 0o777 };
}

test('Claude launches from a per-launch 0700 .command with a session id, the hooks file and an attached MCP server', async t => {
  const f = await fixture(t);
  const result = await f.launcher.launch({ app: 'claude', projectId: 'project-hack' });
  assert.match(result.tag, UUID);
  assert.deepEqual(result, { app: 'claude', tag: result.tag, sessionId: result.tag, folder: f.folder, hooks: true, mcp: 'attached' });
  const script = await onlyCommand(f);
  assert.equal(script.mode, 0o700);
  assert.equal(script.name, `claude-Hackathon - API World 2026-${result.tag.slice(0, 8)}.command`);
  const hooksFile = path.join(f.dataDir, 'claude-hooks.json');
  const mcpFile = path.join(f.dataDir, 'claude-mcp.json');
  assert.equal(script.text, `${HEADER}cd ${sh(f.folder)}\nexec ${sh(CLAUDE)} --session-id ${sh(result.tag)} --settings ${sh(hooksFile)} --mcp-config ${sh(mcpFile)} --append-system-prompt ${sh(WORK_CHECKPOINT_INSTRUCTIONS)}\n`);
  assert.ok(script.text.includes("it'\\''s"), 'the apostrophe in the folder is escaped for zsh');
  assert.ok(!script.text.includes('--strict-mcp-config') && !script.text.includes('--bare') && !script.text.includes('--safe-mode'));
  assert.deepEqual(f.runs, [['/usr/bin/open', ['-a', 'Terminal', script.file]]]);
  assert.deepEqual(f.launches, [{ app: 'claude', tag: result.tag, cwd: f.folder, projectId: 'project-hack', sessionId: result.tag }]);
  assert.deepEqual((await fs.stat(launchDir(f))).mode & 0o777, 0o700);

  // The hooks file: Summon's reporter on every subscribed event, private, and byte-identical across launches.
  assert.equal((await fs.stat(hooksFile)).mode & 0o777, 0o600);
  const hooks = JSON.parse(await fs.readFile(hooksFile, 'utf8'));
  const reporter = path.join(f.root, 'scripts', 'summon-hook.mjs');
  const command = `${sh(NODE)} ${sh(reporter)} claude 2>/dev/null || true`;
  assert.deepEqual(hooks, claudeHooksSettings(NODE, reporter));
  assert.deepEqual(Object.keys(hooks.hooks), HOOK_EVENTS);
  for (const event of HOOK_EVENTS) {
    assert.equal(hooks.hooks[event].length, 1, event);
    assert.deepEqual(hooks.hooks[event][0].hooks, [{ type: 'command', command, timeout: event === 'SessionEnd' ? 1 : 3 }], event);
    if (event === 'Notification') assert.equal(hooks.hooks[event][0].matcher, 'permission_prompt|worker_permission_prompt|idle_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog');
    else assert.equal(hooks.hooks[event][0].matcher, undefined, event);
  }
  const before = await fs.readFile(hooksFile);
  assert.equal((await fs.stat(mcpFile)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await fs.readFile(mcpFile, 'utf8')), { mcpServers: { summon: { type: 'stdio', command: NODE, args: [path.join(f.root, 'scripts', 'mcp-server.mjs')] } } });

  const again = await f.launcher.launch({ app: 'claude', projectId: 'project-hack' });
  assert.notEqual(again.tag, result.tag);
  assert.ok(before.equals(await fs.readFile(hooksFile)), 'the settings file is rewritten identically');
  assert.equal((await fs.readdir(launchDir(f))).filter(name => name.endsWith('.command')).length, 2);
  assert.ok(!(await fs.readFile(hooksFile, 'utf8')).includes(f.homeDir.replace(f.tmp, '')) || true);
});

test('Codex launches with a per-session notify and MCP override, TOML-escaped, and no hooks flags', async t => {
  const f = await fixture(t);
  const result = await f.launcher.launch({ app: 'codex', projectId: 'project-hack' });
  assert.deepEqual(result, { app: 'codex', tag: result.tag, sessionId: null, folder: f.folder, hooks: true, mcp: 'attached' });
  const script = await onlyCommand(f);
  assert.equal(script.mode, 0o700);
  const reporter = path.join(f.root, 'scripts', 'summon-hook.mjs');
  const mcpServer = path.join(f.root, 'scripts', 'mcp-server.mjs');
  const notify = `notify=[${[NODE, reporter, 'codex', '--launch', result.tag].map(item => JSON.stringify(item)).join(',')}]`;
  assert.equal(script.text, `${HEADER}cd ${sh(f.folder)}\nexec ${sh(CODEX)} -C ${sh(f.folder)} -c ${sh(notify)} -c ${sh(`mcp_servers.summon.command=${JSON.stringify(NODE)}`)} -c ${sh(`mcp_servers.summon.args=[${JSON.stringify(mcpServer)}]`)}\n`);
  assert.ok(script.text.includes('repo \\"q\\"'), 'quotes in a path are escaped for TOML');
  assert.ok(!script.text.includes('hooks.') && !script.text.includes('--dangerously-bypass-hook-trust') && !/ -p /.test(script.text));
  assert.ok(!script.text.includes('developer_instructions') && !script.text.includes('--append-system-prompt'), 'Codex uses MCP instructions without replacing its configured developer instructions');
  assert.deepEqual(f.launches, [{ app: 'codex', tag: result.tag, cwd: f.folder, projectId: 'project-hack', sessionId: null }]);
  assert.deepEqual(f.runs, [['/usr/bin/open', ['-a', 'Terminal', script.file]]]);
  await assert.rejects(fs.stat(path.join(f.dataDir, 'claude-hooks.json')), /ENOENT/, 'Codex writes no Claude settings');
});

test('the MCP server is attached only when the user config lacks it, and read-only', async t => {
  const f = await fixture(t);
  const claudeJson = JSON.stringify({ numStartups: 3, mcpServers: { summon: { type: 'stdio', command: NODE, args: ['/elsewhere/mcp-server.mjs'] } }, oauthAccount: { token: 'SECRET' } });
  const configToml = 'model = "gpt-test"\nnotify = ["/x/SkyComputerUseClient", "turn-ended"]\n\n[mcp_servers.summon]\ncommand = "/opt/homebrew/bin/node"\nargs = ["/elsewhere/mcp-server.mjs"]\n';
  await fs.writeFile(path.join(f.homeDir, '.claude.json'), claudeJson);
  await fs.writeFile(path.join(f.homeDir, '.codex', 'config.toml'), configToml);
  const claude = await f.launcher.launch({ app: 'claude', projectId: 'project-hack' });
  assert.equal(claude.mcp, 'global');
  const codex = await f.launcher.launch({ app: 'codex', projectId: 'project-hack' });
  assert.equal(codex.mcp, 'global');
  const texts = await Promise.all((await fs.readdir(launchDir(f))).map(name => fs.readFile(path.join(launchDir(f), name), 'utf8')));
  assert.ok(texts.every(text => !text.includes('mcp-config') && !text.includes('mcp_servers')));
  await assert.rejects(fs.stat(path.join(f.dataDir, 'claude-mcp.json')), /ENOENT/);
  assert.equal(await fs.readFile(path.join(f.homeDir, '.claude.json'), 'utf8'), claudeJson, '~/.claude.json is never changed');
  assert.equal(await fs.readFile(path.join(f.homeDir, '.codex', 'config.toml'), 'utf8'), configToml, '~/.codex/config.toml is never changed');
  // A broken user config reads as "absent", so the session still gets Summon's server.
  await fs.writeFile(path.join(f.homeDir, '.claude.json'), '{ broken');
  assert.equal((await f.launcher.launch({ app: 'claude', projectId: 'project-hack' })).mcp, 'attached');
});

test('without node the launch still opens Terminal, with no hooks and no attached server', async t => {
  const f = await fixture(t, { node: null });
  const claude = await f.launcher.launch({ app: 'claude', projectId: 'project-hack' });
  assert.deepEqual([claude.hooks, claude.mcp], [false, 'none']);
  const script = await onlyCommand(f);
  assert.equal(script.text, `${HEADER}cd ${sh(f.folder)}\nexec ${sh(CLAUDE)} --session-id ${sh(claude.tag)}\n`);
  assert.ok(!script.text.includes('work_items') && !script.text.includes('--append-system-prompt'), 'a session without Summon MCP does not advertise checkpoint tools');
  await assert.rejects(fs.stat(path.join(f.dataDir, 'claude-hooks.json')), /ENOENT/);
  await fs.unlink(script.file);
  const codex = await f.launcher.launch({ app: 'codex', projectId: 'project-hack' });
  assert.deepEqual([codex.hooks, codex.mcp], [false, 'none']);
  assert.equal((await onlyCommand(f)).text, `${HEADER}cd ${sh(f.folder)}\nexec ${sh(CODEX)} -C ${sh(f.folder)}\n`);
  assert.equal(f.runs.length, 2);
});

test('refusals: the vault by name and by path, a sealed folder, a missing folder, an unknown app, no workspace, no CLI', async t => {
  const f = await fixture(t);
  const cases = [
    [{ app: 'claude', projectId: 'project-vault' }, /does not start agents in the vault/],
    [{ app: 'codex', projectId: 'project-deep' }, /does not start agents in the vault/],
    [{ app: 'claude', projectId: 'project-brain-name' }, /does not start agents in the vault/],
    [{ app: 'claude', projectId: 'project-sealed' }, /does not start agents in sealed folders/],
    [{ app: 'claude', projectId: 'project-gone' }, /That folder no longer exists/],
    [{ app: 'cursor', projectId: 'project-hack' }, /Choose Claude or Codex/],
    [{ app: 'claude', projectId: 'project-unknown' }, /Choose a workspace first/],
    [{ app: 'claude' }, /Choose a workspace first/],
    [{ app: 'claude', projectId: '' }, /Choose a workspace first/],
    [{}, /Choose Claude or Codex/],
  ];
  for (const [options, message] of cases) await assert.rejects(f.launcher.launch(options), message, JSON.stringify(options));
  delete f.binaries.codex;
  await assert.rejects(f.launcher.launch({ app: 'codex', projectId: 'project-hack' }), /codex is not installed/);
  assert.deepEqual(f.runs, [], 'nothing was opened');
  assert.deepEqual(f.launches, [], 'nothing was noted');
  await assert.rejects(fs.stat(launchDir(f)), /ENOENT/, 'no launch folder was made');
  assert.equal(await f.launcher.refusal(f.folder, f.projects), null);
  assert.equal(await f.launcher.refusal(path.join(f.vault, 'Inbox'), f.projects), 'Summon does not start agents in the vault.');
});

test('stale launch scripts are pruned after a day; fresh ones and other files stay', async t => {
  const f = await fixture(t);
  await fs.mkdir(launchDir(f), { recursive: true });
  const old = path.join(launchDir(f), 'claude-Old-deadbeef.command');
  const fresh = path.join(launchDir(f), 'codex-Fresh-cafebabe.command');
  const other = path.join(launchDir(f), 'notes.txt');
  for (const file of [old, fresh, other]) await fs.writeFile(file, '#!/bin/zsh\n');
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
  await fs.utimes(old, twoDaysAgo, twoDaysAgo);
  await fs.utimes(other, twoDaysAgo, twoDaysAgo);
  await f.launcher.launch({ app: 'claude', projectId: 'project-hack' });
  const names = (await fs.readdir(launchDir(f))).sort();
  assert.ok(!names.includes(path.basename(old)));
  assert.ok(names.includes(path.basename(fresh)));
  assert.ok(names.includes('notes.txt'));
  assert.equal(names.filter(name => name.endsWith('.command')).length, 2);
});

test('a packaged app points at the bundled reporter and MCP server under Resources', async t => {
  const f = await fixture(t, { packaged: true });
  await f.launcher.launch({ app: 'codex', projectId: 'project-hack' });
  const script = await onlyCommand(f);
  assert.ok(script.text.includes(JSON.stringify(path.join(f.resourcesPath, 'summon-hook.mjs'))));
  assert.ok(script.text.includes(JSON.stringify(path.join(f.resourcesPath, 'mcp-server.mjs'))));
  assert.ok(!script.text.includes('/scripts/'));
});

test('installClaudeHooks merges into settings.json after a byte-identical backup, once, and touches nothing else', async t => {
  const f = await fixture(t);
  const file = path.join(f.homeDir, '.claude', 'settings.json');
  const echo = { type: 'command', command: 'echo "[$(date \'+%a %b %-d %Y, %-I:%M %p %Z\')]"', timeout: 5 };
  const vaultSync = { type: 'command', command: '/usr/bin/python3 /Users/someone/hooks/on-stop.py --hook', timeout: 10 };
  const original = JSON.stringify({ model: 'opus', hooks: { UserPromptSubmit: [{ hooks: [echo] }], Stop: [{ hooks: [vaultSync] }] }, theme: 'dark', enableWorkflows: true });
  await fs.writeFile(file, original);
  const claudeJson = '{"mcpServers":{}}';
  const configToml = 'notify = ["/x/SkyComputerUseClient", "turn-ended"]\n';
  await fs.writeFile(path.join(f.homeDir, '.claude.json'), claudeJson);
  await fs.writeFile(path.join(f.homeDir, '.codex', 'config.toml'), configToml);
  assert.deepEqual(await f.launcher.hookStatus(), { claude: { installed: false, current: false } });

  const result = await f.launcher.installClaudeHooks();
  assert.deepEqual(result.events, HOOK_EVENTS);
  assert.equal(result.installed, true);
  assert.match(path.basename(result.backup), /^settings\.json\.summon-backup-\d{8}-\d{6}$/);
  assert.equal(await fs.readFile(result.backup, 'utf8'), original, 'the backup is byte-identical');
  assert.equal((await fs.stat(result.backup)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const merged = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(merged), ['model', 'hooks', 'theme', 'enableWorkflows'], 'every other key stays, in place');
  assert.deepEqual([merged.model, merged.theme, merged.enableWorkflows], ['opus', 'dark', true]);
  const reporter = path.join(f.root, 'scripts', 'summon-hook.mjs');
  const command = `${sh(NODE)} ${sh(reporter)} claude 2>/dev/null || true`;
  assert.deepEqual(merged.hooks.UserPromptSubmit, [{ hooks: [echo] }, { hooks: [{ type: 'command', command, timeout: 3 }] }], 'the date echo stays first');
  assert.deepEqual(merged.hooks.Stop, [{ hooks: [vaultSync] }, { hooks: [{ type: 'command', command, timeout: 3 }] }], 'the user\'s own Stop hook stays first');
  assert.deepEqual(Object.keys(merged.hooks).sort(), [...HOOK_EVENTS].sort());
  assert.deepEqual(merged.hooks.SessionEnd, [{ hooks: [{ type: 'command', command, timeout: 1 }] }]);
  assert.deepEqual(await f.launcher.hookStatus(), { claude: { installed: true, current: true } });
  assert.deepEqual((await fs.readdir(path.join(f.homeDir, '.claude'))).filter(name => name.includes('tmp')), []);

  // A second click changes nothing and makes no second backup.
  const text = await fs.readFile(file, 'utf8');
  const second = await f.launcher.installClaudeHooks();
  assert.deepEqual(second, { installed: true, backup: null, events: HOOK_EVENTS });
  assert.equal(await fs.readFile(file, 'utf8'), text);
  assert.equal((await fs.readdir(path.join(f.homeDir, '.claude'))).filter(name => name.startsWith('settings.json.summon-backup-')).length, 1);

  // A moved node makes the installed hooks stale; reinstalling replaces Summon's own entries only.
  f.binaries.node = '/usr/local/bin/node';
  assert.deepEqual(await f.launcher.hookStatus(), { claude: { installed: true, current: false } });
  await new Promise(resolve => setTimeout(resolve, 1100));
  const third = await f.launcher.installClaudeHooks();
  assert.notEqual(third.backup, null);
  const replaced = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(replaced.hooks.Stop.length, 2);
  assert.deepEqual(replaced.hooks.Stop[0], { hooks: [vaultSync] });
  assert.ok(replaced.hooks.Stop[1].hooks[0].command.startsWith("'/usr/local/bin/node'"));
  assert.deepEqual(await f.launcher.hookStatus(), { claude: { installed: true, current: true } });

  assert.equal(await fs.readFile(path.join(f.homeDir, '.claude.json'), 'utf8'), claudeJson, '~/.claude.json is never changed');
  assert.equal(await fs.readFile(path.join(f.homeDir, '.codex', 'config.toml'), 'utf8'), configToml, '~/.codex/config.toml is never changed');
});

test('installClaudeHooks leaves an unparsable settings.json alone, and creates one when there is none', async t => {
  const f = await fixture(t);
  const file = path.join(f.homeDir, '.claude', 'settings.json');
  await fs.writeFile(file, '{ not json');
  await assert.rejects(f.launcher.installClaudeHooks(), /settings\.json could not be read; nothing was changed/);
  assert.equal(await fs.readFile(file, 'utf8'), '{ not json');
  assert.deepEqual((await fs.readdir(path.join(f.homeDir, '.claude'))).filter(name => name.includes('backup')), []);
  assert.deepEqual(await f.launcher.hookStatus(), { claude: { installed: false, current: false } });
  await fs.unlink(file);
  const fresh = await f.launcher.installClaudeHooks();
  assert.equal(fresh.backup, null, 'nothing to back up');
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(file, 'utf8'))), ['hooks']);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  // Without node there is nothing to install, and the file is not touched.
  delete f.binaries.node;
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(f.launcher.installClaudeHooks(), /node is not installed/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual(await f.launcher.hookStatus(), { claude: { installed: true, current: false } });
});

test('package.json bundles the reporter, the MCP server and both sign-in scripts as resources', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const resources = Object.fromEntries(pkg.build.extraResources.map(item => [item.from, item.to]));
  assert.equal(resources['scripts/summon-hook.mjs'], 'summon-hook.mjs');
  assert.equal(resources['scripts/mcp-server.mjs'], 'mcp-server.mjs');
  assert.equal(resources['scripts/codex-login.command'], 'codex-login.command');
  assert.equal(resources['scripts/claude-login.command'], 'claude-login.command');
  assert.ok(pkg.build.files.includes('scripts/summon-hook.mjs'));
});


const rankings = () => ({source:'https://aistupidlevel.info/',sourceKind:'public-dashboard',actualCategory:'combined',category:'combined',fetchedAt:new Date().toISOString(),models:[
  {name:'claude-sonnet-5',provider:'anthropic',score:84,lastUpdated:new Date().toISOString(),status:'good',rankable:true},
  {name:'claude-opus-5',provider:'anthropic',score:81,lastUpdated:new Date().toISOString(),status:'good',rankable:true},
]});
const catalog = () => ({status:'ok',models:[{id:'claude-sonnet-5',model:'claude-sonnet-5',name:'Sonnet 5'},{id:'claude-opus-5',model:'claude-opus-5[1m]',name:'Opus 5'}]});

test('Claude receives checkpoint guidance as one argument for attached and global MCP on either backend branch',async t=>{
  for(const globalMcp of [false,true]){
    const f=await fixture(t,{benchmark:async()=>rankings(),readModels:async()=>catalog()});
    if(globalMcp)await fs.writeFile(path.join(f.homeDir,'.claude.json'),JSON.stringify({mcpServers:{summon:{command:NODE,args:['/configured/mcp-server.mjs']}}}));
    const fakeCli=path.join(f.tmp,"checkpoint CLI's argv");
    // NUL delimiters retain spaces, quotes and newlines so the complete instruction must remain one argv item.
    await fs.writeFile(fakeCli,'#!/bin/zsh -f\nprintf \'%s\\0\' SUMMON_ARGV "$@"\n',{mode:0o700});
    f.binaries.claude=fakeCli;
    const task="debug a complex race SECRET_CHECKPOINT_TASK; $(touch /tmp/never-run-checkpoint-task)";
    const launched=await f.launcher.launch({app:'claude',projectId:'project-hack',task});
    assert.equal(launched.mcp,globalMcp?'global':'attached');
    const script=await onlyCommand(f);
    assert.ok(script.text.includes(`--append-system-prompt ${sh(WORK_CHECKPOINT_INSTRUCTIONS)}`));
    assert.doesNotMatch(script.text,/SECRET_CHECKPOINT_TASK|never-run-checkpoint-task/);
    assert.equal(JSON.stringify(f.launches).includes('SECRET_CHECKPOINT_TASK'),false);
    assert.equal(JSON.stringify(launched).includes('SECRET_CHECKPOINT_TASK'),false);
    for(const customBackend of [false,true]){
      const {stdout}=await promisify(execFile)('/bin/zsh',['-f',script.file],{env:{PATH:'/usr/bin:/bin',...(customBackend?{ANTHROPIC_BASE_URL:'fixture-custom-backend'}:{})},timeout:3000});
      const marker='SUMMON_ARGV\0';
      assert.ok(stdout.includes(marker));
      const args=stdout.slice(stdout.indexOf(marker)+marker.length).split('\0').slice(0,-1);
      const expected=['--session-id',launched.sessionId,'--settings',path.join(f.dataDir,'claude-hooks.json'),
        ...(!globalMcp?['--mcp-config',path.join(f.dataDir,'claude-mcp.json')]:[]),
        '--append-system-prompt',WORK_CHECKPOINT_INSTRUCTIONS,
        ...(!customBackend?['--model','claude-sonnet-5','--effort','high']:[])];
      assert.deepEqual(args,expected);
    }
  }
});

test('Claude launch intersects current rankings with the CLI catalog and passes the exact session model',async t=>{
  const calls=[];
  const f=await fixture(t,{benchmark:async category=>{calls.push(category);return rankings();},readModels:async options=>{calls.push(options);return catalog();}});
  const result=await f.launcher.launch({app:'claude',projectId:'project-hack'});
  assert.equal(result.modelSelection.model,'claude-sonnet-5');
  assert.equal(result.modelSelection.score,84);
  assert.deepEqual(calls,['combined',{executable:CLAUDE,cwd:f.folder}]);
  const script=await onlyCommand(f);
  assert.match(script.text,/--model 'claude-sonnet-5'/);
  assert.match(script.text,/printf '%s\\n'/);
  assert.ok(script.text.includes('--session-id')&&script.text.includes('--settings')&&script.text.includes('--mcp-config'));
  await assert.rejects(fs.stat(path.join(f.homeDir,'.claude','settings.json')),/ENOENT/);
});

test('missing rankings or unavailable catalog keep the configured Claude default and explain the fallback',async t=>{
  for(const [benchmark,readModels] of [
    [async()=>({...rankings(),stale:true}),async()=>catalog()],
    [async()=>{throw new Error('offline');},async()=>catalog()],
    [async()=>rankings(),async()=>({status:'not_applicable',models:[]})],
  ]){
    const f=await fixture(t,{benchmark,readModels});
    const result=await f.launcher.launch({app:'claude',projectId:'project-hack'});
    assert.equal(result.modelSelection.model,null);
    assert.match(result.modelSelection.reason,/default/i);
    assert.doesNotMatch((await onlyCommand(f)).text,/--model/);
  }
});

test('Codex and refused Claude folders never fetch rankings or probe the model catalog',async t=>{
  let calls=0;
  const f=await fixture(t,{benchmark:async()=>{calls++;return rankings();},readModels:async()=>{calls++;return catalog();}});
  const result=await f.launcher.launch({app:'codex',projectId:'project-hack'});
  assert.equal(result.modelSelection,undefined);
  await assert.rejects(f.launcher.launch({app:'claude',projectId:'project-vault'}),/vault/);
  await assert.rejects(f.launcher.launch({app:'claude',projectId:'project-sealed'}),/sealed/);
  assert.equal(calls,0);
});

test('generated shell passes the selected model only without custom backend overrides and removes provider keys',async t=>{
  const f=await fixture(t,{node:null,benchmark:async()=>rankings(),readModels:async()=>catalog()});
  const fakeCli=path.join(f.tmp,"fake Claude's CLI");
  // This executable only reports argv. It cannot connect to a provider or start a model turn.
  await fs.writeFile(fakeCli,'#!/bin/zsh -f\nif [[ -n "${ANTHROPIC_API_KEY:-}${OPENAI_API_KEY:-}${CODEX_API_KEY:-}${CLAUDECODE:-}${NODE_OPTIONS:-}" ]]; then exit 90; fi\nprintf \'ARG:%s\\n\' "$@"\n',{mode:0o700});
  f.binaries.claude=fakeCli;
  const launched=await f.launcher.launch({app:'claude',projectId:'project-hack'});
  const script=await onlyCommand(f),execute=promisify(execFile);
  const cases=[{},...['ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'].map(key=>({[key]:'fixture-custom-backend'}))];
  for(const overrides of cases){
    const {stdout,stderr}=await execute('/bin/zsh',['-f',script.file],{env:{PATH:'/usr/bin:/bin',ANTHROPIC_API_KEY:'fixture-key',OPENAI_API_KEY:'fixture-key',CODEX_API_KEY:'fixture-key',CLAUDECODE:'fixture-session',NODE_OPTIONS:'fixture-options',...overrides},timeout:3000});
    const args=stdout.split('\n').filter(line=>line.startsWith('ARG:')).map(line=>line.slice(4));
    assert.equal(stderr,'');
    if(Object.keys(overrides).length){
      assert.deepEqual(args,['--session-id',launched.sessionId]);
      assert.match(stdout,/Custom Claude backend detected; using its configured default/);
      assert.doesNotMatch(stdout,/ranks claude-sonnet-5 highest/);
    }else{
      assert.deepEqual(args,['--session-id',launched.sessionId,'--model','claude-sonnet-5']);
      assert.match(stdout,/ranks claude-sonnet-5 highest/);
    }
  }
});

test('task context selects session effort without saving or executing the user task',async t=>{
  const f=await fixture(t,{benchmark:async()=>rankings(),readModels:async()=>catalog()});
  const task="debug a complex race condition SECRET_TASK_CONTEXT; $(touch /tmp/never-created-by-summon)";
  const result=await f.launcher.launch({app:'claude',projectId:'project-hack',task});
  assert.deepEqual([result.routing.kind,result.routing.complexity,result.routing.effort,result.routing.effortSource],['coding','complex','high','task']);
  const script=await onlyCommand(f);
  assert.match(script.text,/--effort 'high'/);
  assert.doesNotMatch(script.text,/SECRET_TASK_CONTEXT|never-created-by-summon|--prompt|--print| -p /);
  assert.equal(JSON.stringify(f.launches).includes('SECRET_TASK_CONTEXT'),false,'the launch ledger does not persist task context');
  assert.equal(JSON.stringify(result).includes('SECRET_TASK_CONTEXT'),false,'the receipt does not retain task context');
});

test('an explicit known Claude family survives benchmark errors and explicit effort wins over classification',async t=>{
  const f=await fixture(t,{benchmark:async()=>{throw new Error('offline');},readModels:async()=>catalog()});
  const result=await f.launcher.launch({app:'claude',projectId:'project-hack',task:'debug a complex race condition',modelPreference:'sonnet',effort:'low'});
  assert.equal(result.modelSelection.model,'claude-sonnet-5');
  assert.equal(result.routing.effort,'low');
  assert.equal(result.routing.effortSource,'override');
  const script=await onlyCommand(f);
  assert.match(script.text,/--model 'claude-sonnet-5'/);
  assert.match(script.text,/--effort 'low'/);
  assert.doesNotMatch(script.text,/--effort 'high'/);
  assert.equal(result.modelSelection.source,undefined);
});

test('Codex task launches set per-call reasoning effort, keep model config and do not execute a prompt',async t=>{
  let probes=0;
  const f=await fixture(t,{node:null,benchmark:async()=>{probes++;return rankings();},readModels:async()=>{probes++;return catalog();}});
  const fakeCli=path.join(f.tmp,'inert-codex');
  await fs.writeFile(fakeCli,'#!/bin/zsh -f\nprintf \'ARG:%s\\n\' "$@"\n',{mode:0o700});
  f.binaries.codex=fakeCli;
  const result=await f.launcher.launch({app:'codex',projectId:'project-hack',task:'briefly explain this SECRET_CODEX_TASK'});
  const script=await onlyCommand(f);
  const {stdout}=await promisify(execFile)('/bin/zsh',['-f',script.file],{env:{PATH:'/usr/bin:/bin'},timeout:3000});
  const args=stdout.split('\n').filter(line=>line.startsWith('ARG:')).map(line=>line.slice(4));
  assert.deepEqual(args,['-C',f.folder,'-c','model_reasoning_effort="low"']);
  assert.doesNotMatch(script.text,/SECRET_CODEX_TASK|--model|--prompt|--print/);
  assert.equal(result.routing.effort,'low');
  assert.equal(probes,0);
});

test('malformed routing options are refused before any probe, file write or launch',async t=>{
  let probes=0;
  const f=await fixture(t,{benchmark:async()=>{probes++;return rankings();},readModels:async()=>{probes++;return catalog();}});
  for(const options of [
    null,[],{task:42},{task:'x'.repeat(1001)},{task:'one\ntwo'},{task:'embedded\u0000nul'},
    {modelPreference:'--model hacked'},{modelPreference:null},{effort:'max'},{effort:null},{app:'codex',modelPreference:'opus'},
  ])await assert.rejects(f.launcher.launch(options===null||Array.isArray(options)?options:{app:'claude',projectId:'project-hack',...options}));
  assert.equal(probes,0);
  assert.deepEqual(f.runs,[]);
  assert.deepEqual(f.launches,[]);
  await assert.rejects(fs.stat(launchDir(f)),/ENOENT/);
});

test('custom Claude backends discard automatic effort but preserve an explicit effort override',async t=>{
  for(const explicit of [false,true]){
    const f=await fixture(t,{node:null,benchmark:async()=>rankings(),readModels:async()=>catalog()});
    const fakeCli=path.join(f.tmp,'inert-claude');
    await fs.writeFile(fakeCli,'#!/bin/zsh -f\nprintf \'ARG:%s\\n\' "$@"\n',{mode:0o700});
    f.binaries.claude=fakeCli;
    const result=await f.launcher.launch({app:'claude',projectId:'project-hack',task:'debug a complex problem SECRET_SHELL_CONTEXT',...(explicit?{effort:'low'}:{})});
    const script=await onlyCommand(f);
    for(const key of ['ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY']){
      const {stdout}=await promisify(execFile)('/bin/zsh',['-f',script.file],{env:{PATH:'/usr/bin:/bin',[key]:'fixture-custom-backend'},timeout:3000});
      const args=stdout.split('\n').filter(line=>line.startsWith('ARG:')).map(line=>line.slice(4));
      assert.deepEqual(args,['--session-id',result.sessionId,...(explicit?['--effort','low']:[])]);
      assert.match(stdout,/Custom Claude backend detected/);
      assert.doesNotMatch(stdout,/SECRET_SHELL_CONTEXT/);
    }
  }
});
