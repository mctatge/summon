import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildContextEvidence, localContextEvidence, createContextReasoning, validateContextResult } from '../src/core/context-reasoning.mjs';

const now = Date.parse('2026-09-21T12:00:00Z');
const value = () => ({
  flight: { repos: [{ id: 'a', name: 'Alpha', path: '/alpha' }, { id: 'b', name: 'Beta', path: '/beta' }] },
  snapshot: { currentProjectId: 'pb', projects: [{ id: 'pa', path: '/alpha' }, { id: 'pb', path: '/beta' }], settings: {} },
  sessions: { groups: [{ sessions: [
    { key: 'old-a', repoId: 'a', updatedAt: new Date(now - 5 * 86400000).toISOString(), recentContext: { messages: [{ role: 'user', text: 'Prepare the professor update' }] } },
    ...Array.from({ length: 12 }, (_, i) => ({ key: `busy-b-${i}`, repoId: 'b', updatedAt: new Date(now).toISOString(), recentContext: { messages: [{ role: 'user', text: 'Fix another unrelated app bug' }] } })),
  ] }] },
  projectNotes: [
    { projectId: 'pa', kind: 'project-note', text: '2026-09-11: Proposed, not sent: send the professor a link-sharing and importer update.', source: { label: 'Alpha hub', line: 161, modifiedAt: '2026-09-20T12:00:00Z' } },
    { projectId: 'pb', kind: 'project-note', text: 'Unrelated Beta plans', source: { label: 'Beta hub' } },
    { projectId: null, kind: 'explicit', text: 'Unscoped private reminder', source: { label: 'Home' } },
  ],
});
const answer = (repoId, id = 'E1') => ({ summary: `${repoId} direction`, goals: [{ repoId, title: 'Send the professor update', summary: 'The project note records an unsent update.', status: 'planned', confidence: 'medium', evidence: [id] }], sessionTitles: [] });
const turn = () => new Promise(resolve => setImmediate(resolve));

test('selected workspace gets its older intent and dated notes despite busy other projects', () => {
  const packet = localContextEvidence(buildContextEvidence({ ...value(), scopeRepoId: 'a' }, now));
  assert.deepEqual(packet.repos.map(repo => repo.id), ['a']);
  assert.deepEqual(packet.sessions.map(session => session.key), ['old-a']);
  assert.ok(packet.evidence.every(item => item.repoId === 'a'));
  assert.ok(packet.evidence.some(item => item.kind === 'project-note' && item.line === 161));
  assert.ok(packet.evidence.some(item => item.role === 'user'));
  assert.doesNotMatch(JSON.stringify(packet), /Unrelated Beta|Unscoped private|busy-b/);
  assert.throws(() => buildContextEvidence({ ...value(), scopeRepoId: 'unknown' }, now), /known repository/);
});

test('note-only commitments can be inferred with provenance, but cannot confirm completion or reopen saved goals', () => {
  const input = value(); input.sessions = {}; input.scopeRepoId = 'a';
  let packet = buildContextEvidence(input, now);
  const goal = validateContextResult(answer('a'), packet).goals[0];
  assert.match(goal.inference.evidence[0], /Alpha hub:161/);
  const certain = answer('a'); certain.goals[0].confidence = 'high';
  assert.equal(validateContextResult(certain, packet).goals[0].inference.confidence, 'medium');
  const done = answer('a'); done.goals[0].status = 'done';
  assert.equal(validateContextResult(done, packet).goals.length, 0);
  packet.evidence.push({ id: 'assistant-complete', kind: 'conversation', repoId: 'a', role: 'assistant', text: 'I think this is done.' });
  done.goals[0].evidence.push('assistant-complete');
  assert.equal(validateContextResult(done, packet).goals.length, 0);
  input.explicitGoals = [{ id: 'saved', repoId: 'a', title: 'Send the professor update', status: 'dismissed', nextStep: 'No further action.' }];
  packet = buildContextEvidence(input, now);
  assert.equal(validateContextResult(answer('a', 'E2'), packet).goals.length, 0);
  assert.equal(validateContextResult(answer('a', 'E1'), packet).goals.length, 0);
});

test('local budget keeps note evidence alongside user intent and a large saved-goal collection', () => {
  const input = value(); input.scopeRepoId = 'a';
  input.explicitGoals = Array.from({ length: 24 }, (_, i) => ({ id: `goal${i}`, repoId: 'a', title: `A detailed saved outcome for improving the application and its usability ${i}`, status: 'planned', nextStep: 'Prepare the detailed next milestone and verify every acceptance condition with fresh evidence. '.repeat(30) }));
  const packet = localContextEvidence(buildContextEvidence(input, now));
  assert.ok(packet.evidence.some(item => item.role === 'user'));
  assert.ok(packet.evidence.some(item => item.kind === 'project-note'));
  assert.ok(packet.evidence.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0) <= 6000);
});

test('switching scope suppresses late results and queues the newest workspace; default follows Working in', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'summon-scope-'));
  const requests = []; let release, selected = 'a';
  const gate = new Promise(resolve => { release = resolve; });
  const service = await createContextReasoning({ dataDir, now: () => now, getSelectedRepoId: () => selected,
    getInput: async options => { requests.push(options.repoId); const data = value(); data.sessions = {}; return data; },
    infer: async (_engine, request) => {
      const packet = JSON.parse(request.prompt.split('EVIDENCE_JSON:\n')[1]);
      if (packet.repos[0].id === 'a') await gate;
      return { raw: answer(packet.repos[0].id) };
    },
  });
  t.after(async () => { release(); await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const first = service.refresh({ repoId: 'a' }); await turn();
  const switched = service.request({ repoId: 'b' });
  assert.equal(switched.repoId, 'b'); assert.equal(switched.goals.length, 0);
  release(); await first; await turn(); await turn();
  assert.equal(service.read().repoId, 'b'); assert.equal(service.read().goals[0].repoId, 'b');
  assert.ok(requests.includes('a') && requests.includes('b'));
  service.poll(); await turn();
  assert.equal(service.read().repoId, 'b', 'background poll preserves the visible filter');
  service.releaseFocus(); assert.equal(service.read().repoId, 'a');
  selected = 'b'; service.poll(); await turn(); await turn();
  assert.equal(service.read().repoId, 'b', 'after release background follows Working in');
  await service.refresh({ repoId: null }); assert.equal(service.read().repoId, null);
  selected = 'a'; await service.refresh(); assert.equal(service.read().repoId, 'a');
});
