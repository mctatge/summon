import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutGitFolders } from '../src/renderer/git-folder-map.mjs';

const place = (id, patch = {}) => ({ id, kind: 'other', label: `Folder ${id}`, branch: `feature/${id}`, displayPath: `~/Projects/checkout-${id}`, ...patch });
const repo = (id, places = [], patch = {}) => ({ id, name: `Project ${id}`, displayPath: `~/Projects/${id}`, places, ...patch });
const nodeFor = (layout, repoId, placeId = null) => layout.nodes.find(node => node.repoId === repoId && node.placeId === placeId);

function assertGeometry(layout) {
  for (const node of layout.nodes) {
    assert.ok(node.x >= 0 && node.y >= 0);
    assert.ok(node.x + node.width <= layout.width, `${node.id} exceeds map width`);
    assert.ok(node.y + node.height <= layout.height, `${node.id} exceeds map height`);
  }
  for (let i = 0; i < layout.nodes.length; i++) {
    for (let j = i + 1; j < layout.nodes.length; j++) {
      const a = layout.nodes[i], b = layout.nodes[j];
      const overlaps = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      assert.equal(overlaps, false, `${a.id} overlaps ${b.id}`);
    }
  }
}

function assertEdges(layout) {
  const byId = new Map(layout.nodes.map(node => [node.id, node]));
  assert.equal(layout.edges.length, layout.folderCount);
  assert.equal(new Set(layout.edges.map(edge => edge.id)).size, layout.edges.length);
  for (const edge of layout.edges) {
    const source = byId.get(edge.source), target = byId.get(edge.target);
    assert.equal(source?.kind, 'project');
    assert.equal(target?.kind, 'folder');
    assert.equal(source.repoId, target.repoId, 'a folder can only connect to its own project');
  }
}

test('every folder is contained without overlap, with the requested dimensions and project spacing', () => {
  const layout = layoutGitFolders([
    repo('b', [place('first'), place('main', { kind: 'main' }), place('last')]),
    repo('empty'),
    repo('a', [place('only')]),
  ]);
  assert.deepEqual(layout.nodes.filter(node => node.kind === 'project').map(node => node.repoId), ['b', 'empty', 'a']);
  assert.deepEqual(layout.nodes.filter(node => node.repoId === 'b' && node.kind === 'folder').map(node => node.placeId), ['main', 'first', 'last']);
  assert.deepEqual([nodeFor(layout, 'b').x, nodeFor(layout, 'b').y, nodeFor(layout, 'b').width, nodeFor(layout, 'b').height], [0, 0, 220, 112]);
  const first = nodeFor(layout, 'b', 'main');
  assert.deepEqual([first.x, first.y, first.width, first.height], [300, 0, 340, 152]);
  assert.equal(nodeFor(layout, 'b', 'first').y, 172);
  assert.equal(nodeFor(layout, 'b', 'last').y, 344);
  assert.equal(nodeFor(layout, 'empty').x, 704);
  assert.equal(nodeFor(layout, 'empty').y, 0);
  assert.equal(nodeFor(layout, 'a').x, 704);
  assert.equal(nodeFor(layout, 'a').y, 112 + 40);
  assert.equal(layout.width, 1344);
  assert.equal(layout.height, 344 + 152);
  assert.deepEqual([layout.projectCount, layout.folderCount], [3, 4]);
  assertGeometry(layout);
  assertEdges(layout);
});

test('five projects use two balanced columns rather than one tall stack', () => {
  const repos = Array.from({ length: 5 }, (_, index) => repo(`project-${index}`, [place('main', { kind: 'main' }), place('agent')]));
  const layout = layoutGitFolders(repos);
  const projects = layout.nodes.filter(node => node.kind === 'project');
  assert.deepEqual(projects.map(node => node.repoId), repos.map(repo => repo.id));
  assert.equal(new Set(projects.map(node => node.x)).size, 2);
  assert.equal(layout.height, 3 * 324 + 2 * 40);
  const oldHeight = 5 * 324 + 4 * 40;
  const fit = Math.min(1000 / layout.width, 560 / layout.height);
  const oldFit = Math.min(1000 / 640, 560 / oldHeight);
  assert.ok(fit > oldFit * 1.5, 'balanced packing should materially improve the full-overview fit');
  assertGeometry(layout);
  assertEdges(layout);
});

test('taller projects use three columns when that improves the overview fit', () => {
  const repos = Array.from({ length: 5 }, (_, index) => repo(`project-${index}`, Array.from({ length: 4 }, (_, folder) => place(`folder-${folder}`))));
  const layout = layoutGitFolders(repos);
  assert.equal(new Set(layout.nodes.filter(node => node.kind === 'project').map(node => node.x)).size, 3);
  assert.equal(layout.height, 2 * 668 + 40);
  assertGeometry(layout);
  assertEdges(layout);
});

test('unequal group heights are balanced without interleaving project folders or changing their internal geometry', () => {
  const repos = [repo('tall', Array.from({ length: 8 }, (_, index) => place(`folder-${index}`))), ...Array.from({ length: 4 }, (_, index) => repo(`short-${index}`, [place('only')]))];
  const layout = layoutGitFolders(repos);
  const tall = nodeFor(layout, 'tall');
  assert.equal(layout.height, 7 * 172 + 152);
  for (const current of repos) {
    const project = nodeFor(layout, current.id);
    if (current.id !== 'tall') assert.notEqual(project.x, tall.x);
    current.places.forEach((place, index) => {
      const folder = nodeFor(layout, current.id, place.id);
      assert.equal(folder.x, project.x + 300);
      assert.equal(folder.y, project.y + index * 172);
    });
  }
  assert.deepEqual(layoutGitFolders(repos, 'short-2').nodes.map(node => [node.kind, node.x, node.y]), [['project', 0, 0], ['folder', 300, 0]]);
  assertGeometry(layout);
  assertEdges(layout);
});

test('stable ordering keeps other folders in source order and leaves source data unchanged', () => {
  const repos = [repo('z', [place('zeta'), place('alpha'), place('main', { kind: 'main' }), place('beta')]), repo('a', [place('second')])];
  const before = structuredClone(repos);
  const first = layoutGitFolders(repos);
  assert.deepEqual(first.nodes.filter(node => node.repoId === 'z' && node.kind === 'folder').map(node => node.placeId), ['main', 'zeta', 'alpha', 'beta']);
  assert.deepEqual(layoutGitFolders(repos), first);
  assert.deepEqual(repos, before);
});

test('a matching project name or displayed path retains all of that project’s folders', () => {
  const repos = [repo('a', [place('one'), place('two')], { name: 'Harbor', displayPath: '~/Clients/Seaside' }), repo('b', [place('other')])];
  for (const query of ['hArBoR', '  SEASIDE  ']) {
    const layout = layoutGitFolders(repos, query);
    assert.deepEqual([layout.projectCount, layout.folderCount], [1, 2]);
    assert.ok(layout.nodes.every(node => node.repoId === 'a'));
    assertEdges(layout);
    assertGeometry(layout);
  }
});

test('folder label, branch and displayed path matches retain only matching folders and their parent', () => {
  const repos = [repo('a', [place('one', { label: 'Codex checkout', branch: 'feature/Login', displayPath: '~/worktrees/Special-copy' }), place('two')]), repo('b', [place('other')])];
  for (const query of ['CODEX', 'LOGIN', 'special-COPY']) {
    const layout = layoutGitFolders(repos, query);
    assert.deepEqual(layout.nodes.map(node => [node.kind, node.repoId, node.placeId]), [['project', 'a', null], ['folder', 'a', 'one']]);
    assert.deepEqual([layout.projectCount, layout.folderCount], [1, 1]);
    assertGeometry(layout);
    assertEdges(layout);
  }
});

test('matching folders from different projects never connect across projects', () => {
  const layout = layoutGitFolders([
    repo('a', [place('one', { branch: 'feature/shared' }), place('no-match')]),
    repo('b', [place('two', { branch: 'fix/shared' })]),
    repo('c', [place('other')]),
  ], 'shared');
  assert.deepEqual([layout.projectCount, layout.folderCount], [2, 2]);
  assert.deepEqual(layout.nodes.filter(node => node.kind === 'project').map(node => node.repoId), ['a', 'b']);
  assertEdges(layout);
  assertGeometry(layout);
});

test('unavailable or empty projects remain visible without inventing a healthy status', () => {
  const repos = [repo('broken', [], { error: 'Read failed.', status: 'error' }), repo('empty'), repo('gone', [place('missing', { missing: true, error: 'Folder unavailable.' })])];
  const before = structuredClone(repos);
  const layout = layoutGitFolders(repos);
  assert.deepEqual([layout.projectCount, layout.folderCount], [3, 1]);
  assert.ok(nodeFor(layout, 'broken'));
  assert.ok(nodeFor(layout, 'empty'));
  assert.ok(nodeFor(layout, 'gone', 'missing'));
  assert.ok(layout.nodes.every(node => !('status' in node) && !('error' in node)));
  assert.deepEqual(repos, before);
  assertGeometry(layout);
  assertEdges(layout);
  assert.equal(layoutGitFolders(repos, 'BROKEN').projectCount, 1);
});

test('identical place IDs in different repositories produce distinct node and edge identities', () => {
  const layout = layoutGitFolders([repo('a:b', [place('same')]), repo('a', [place('same'), place('b:same')])]);
  assert.equal(new Set(layout.nodes.map(node => node.id)).size, layout.nodes.length);
  assert.notEqual(nodeFor(layout, 'a:b', 'same').id, nodeFor(layout, 'a', 'same').id);
  assertEdges(layout);
  assertGeometry(layout);
});

test('empty searches have positive dimensions and folders are never capped', () => {
  for (const layout of [layoutGitFolders([]), layoutGitFolders([repo('a', [place('one')])], 'no such folder')]) {
    assert.deepEqual(layout.nodes, []);
    assert.deepEqual(layout.edges, []);
    assert.equal(layout.width, 1);
    assert.equal(layout.height, 1);
    assert.deepEqual([layout.projectCount, layout.folderCount], [0, 0]);
  }
  const places = Array.from({ length: 513 }, (_, index) => place(`folder-${index}`));
  const layout = layoutGitFolders([repo('many', places)]);
  assert.equal(layout.folderCount, 513);
  assert.equal(layout.nodes.length, 514);
  assert.equal(nodeFor(layout, 'many', 'folder-512').y, 512 * 172);
  assert.equal(layout.height, 512 * 172 + 152);
  assertEdges(layout);
});
