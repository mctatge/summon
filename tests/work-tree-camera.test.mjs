import test from 'node:test';
import assert from 'node:assert/strict';
import { fitWorkTree, initialWorkTreeView, revealWorkTreeBranch, resizeWorkTreeView } from '../src/renderer/work-tree-camera.mjs';
import { buildWorkTreeLayout, rootNodeId } from '../src/renderer/work-tree-layout.mjs';

const root = (id, y = 48) => ({ id, kind: 'root', repoId: id, x: 48, y, width: 240, height: 100, parentNodeId: null, depth: 0 });
const goal = (id, parent, y, status = 'planned') => ({ id, kind: 'goal', repoId: parent.repoId, x: parent.x + 480, y, width: 240, height: 132, parentNodeId: parent.id, depth: parent.depth + 1, goal: { status } });
const layout = (nodes, agents = []) => ({ width: Math.max(1, ...nodes.map(node => node.x + node.width + 48)), height: Math.max(1, ...nodes.map(node => node.y + node.height + 48)), nodes, agents });
const size = { width: 980, height: 420 };
const visible = (node, view, box = size) => node.x * view.zoom + view.x >= 0 && (node.x + node.width) * view.zoom + view.x <= box.width && node.y * view.zoom + view.y >= 0 && (node.y + node.height) * view.zoom + view.y <= box.height;

test('long collapsed project lists start at the top and left at 100 percent', () => {
  const roots = Array.from({ length: 40 }, (_, index) => root(`project-${index}`, 48 + index * 196));
  const graph = layout(roots);
  const view = initialWorkTreeView(graph, size);
  assert.equal(view.zoom, 1);
  assert.equal(roots[0].x + view.x, 24);
  assert.equal(roots[0].y + view.y, 24);
  assert.ok(visible(roots[0], view));
  assert.equal(graph.nodes.length, 40, 'the initial camera never removes projects');
});

test('selected projects open on the root and immediate goal column while retaining active context', () => {
  const project = root('project', 400);
  const active = goal('active', project, 420, 'working');
  const other = goal('other', project, 9000);
  const graph = layout([project, active, other], [{ nodeId: active.id, active: true }]);
  const view = initialWorkTreeView(graph, size);
  assert.equal(view.zoom, 1);
  assert.ok(visible(project, view));
  assert.ok(visible(active, view));
  assert.equal(project.x + view.x, 24);
});

test('deep active work starts with its root and first ancestor column, not a disconnected far-right card', () => {
  const project = root('project', 160);
  const first = goal('first', project, 160);
  const second = goal('second', first, 160);
  const active = goal('active', second, 160, 'working');
  const graph = layout([project, first, second, active], [{ nodeId: active.id, active: true }]);
  const view = initialWorkTreeView(graph, size);
  assert.equal(view.zoom, 1);
  assert.ok(visible(project, view));
  assert.ok(visible(first, view));
  assert.ok((active.x * view.zoom + view.x) > size.width);
});

test('initial width adapts only to the first two columns and never shrinks below readable scale for tall content', () => {
  const project = root('project', 6000), active = goal('active', project, 6000, 'blocked');
  const graph = { ...layout([project, active]), width: 9000, height: 20000 };
  const narrow = { width: 680, height: 420 };
  const view = initialWorkTreeView(graph, narrow);
  assert.ok(view.zoom >= .8 && view.zoom <= 1);
  assert.ok(visible(project, view, narrow));
  assert.ok(visible(active, view, narrow));
});

test('initial view preserves the hierarchy start instead of jumping down to an active fifth sibling', () => {
  const snapshot = { repos: [{ id: 'project', name: 'Project', places: [] }], goals: Array.from({ length: 14 }, (_, index) => ({
    id: `goal-${index}`, repoId: 'project', title: `Goal ${String(index).padStart(2, '0')}`, status: index < 4 ? 'needs-verification' : index === 4 ? 'working' : 'planned',
    parentId: null, dependsOn: [], links: index === 4 ? { sessionKey: 'active-session' } : {},
  })), sessions: [{ key: 'active-session', repoId: 'project', activity: 'working', children: [] }], externalGoals: [], externalRepos: [], warnings: [] };
  const graph = buildWorkTreeLayout(snapshot, { selectedRepoId: 'project' });
  const project = graph.nodes.find(node => node.kind === 'root');
  const siblings = graph.nodes.filter(node => node.parentNodeId === project.id).sort((a, b) => a.y - b.y);
  assert.equal(siblings[4].goal.id, 'goal-4');
  assert.ok(graph.agents.some(agent => agent.active && agent.nodeId === siblings[4].id));
  const view = initialWorkTreeView(graph, size);
  assert.equal(view.zoom, 1);
  assert.ok(visible(project, view));
  assert.ok(visible(siblings[0], view));
  assert.equal(siblings[0].y + view.y, 24);
  assert.equal(visible(siblings[4], view), false, 'lower active work remains reachable by deliberate pan');
});

test('Fit remains an explicit overview encompassing the complete graph', () => {
  const project = root('project'), far = goal('far', project, 9000);
  const graph = layout([project, far]);
  const view = fitWorkTree(graph, size);
  assert.ok(view.zoom < .8);
  assert.ok(view.x >= 0 && view.y >= 0);
  assert.ok(view.x + graph.width * view.zoom <= size.width);
  assert.ok(view.y + graph.height * view.zoom <= size.height);
});

test('expanding horizontally pans only enough to include the parent and immediate children', () => {
  const project = root('project', 80), first = goal('first', project, 48), second = goal('second', project, 204);
  const graph = layout([project, first, second]);
  const view = { x: 640, y: 0, zoom: 1 };
  const next = revealWorkTreeBranch(graph, size, view, project.id);
  assert.equal(next.zoom, 1);
  for (const node of graph.nodes) assert.ok(visible(node, next));
  assert.equal(next.y, view.y, 'already visible vertical context stays fixed');
  assert.equal(second.x + second.width + next.x, size.width - 24);
  assert.deepEqual(view, { x: 640, y: 0, zoom: 1 });
});

test('tall expansion reveals the aligned parent and taller first child at top padding', () => {
  const previous = root('project', 80), project = root('project', 64);
  const first = goal('first', project, 48), last = goal('last', project, 8000);
  const view = { x: -24, y: 30, zoom: 1 };
  const next = revealWorkTreeBranch(layout([project, first, last]), size, view, project.id, previous);
  assert.equal(first.y + next.y, 24);
  assert.equal(next.zoom, view.zoom);
  assert.ok(visible(project, next));
  assert.ok(visible(first, next));
  assert.equal(visible(last, next), false);
});

test('tall branches reveal their first action at user zoom even when the clicked parent had been near the top', () => {
  const previous = root('project', 8000), project = root('project', 64);
  const first = goal('first', project, 48), last = goal('last', project, 8000);
  for (const zoom of [.8, 1, 1.4]) {
    const view = { x: -24, y: 24 - previous.y * zoom, zoom };
    const next = revealWorkTreeBranch(layout([project, first, last]), size, view, project.id, previous);
    assert.equal(next.zoom, zoom);
    assert.ok(Math.abs(first.y * zoom + next.y - 24) < .001);
    assert.ok(project.y * zoom + next.y >= 24);
    assert.ok((first.y + first.height) * zoom + next.y <= size.height);
  }
});

test('actual sideways layout expansion keeps its highest-priority first action fully visible', () => {
  const snapshot = { repos: [{ id: 'project', name: 'Project', places: [] }], goals: Array.from({ length: 18 }, (_, index) => ({
    id: `goal-${index}`, repoId: 'project', title: `Goal ${index}`, status: index === 0 ? 'working' : 'planned', parentId: null, dependsOn: [], links: {},
  })), sessions: [], externalGoals: [], externalRepos: [], warnings: [] };
  const collapsed = buildWorkTreeLayout(snapshot);
  const parentId = rootNodeId('project');
  const expanded = buildWorkTreeLayout(snapshot, { expandedNodes: new Set([parentId]) });
  const parent = expanded.nodes.find(node => node.id === parentId);
  const first = expanded.nodes.filter(node => node.parentNodeId === parentId).sort((a, b) => a.y - b.y)[0];
  const view = revealWorkTreeBranch(expanded, size, initialWorkTreeView(collapsed, size), parentId, collapsed.nodes[0]);
  assert.equal(first.goal.id, 'goal-0');
  assert.equal(view.zoom, 1);
  assert.ok(visible(parent, view));
  assert.ok(visible(first, view));
  assert.equal(first.y + view.y, 24);
});

test('explicit branch reveals retain both close user zoom and overview zoom', () => {
  const project = root('project'), child = goal('child', project, 48);
  const graph = layout([project, child]);
  for (const zoom of [.25, .8, 1.4, 2]) {
    const view = { x: -300, y: -40, zoom };
    const next = revealWorkTreeBranch(graph, size, view, project.id);
    assert.equal(next.zoom, zoom);
    assert.ok(visible(project, next));
    if (zoom <= 1) assert.ok(visible(child, next));
  }
});

test('collapse anchors the remaining parent and missing nodes leave the current camera unchanged', () => {
  const previous = root('project', 4000), project = root('project', 48);
  const view = { x: -24, y: -3920, zoom: 1 };
  const next = revealWorkTreeBranch(layout([project]), size, view, project.id, previous);
  assert.equal(project.y + next.y, previous.y + view.y);
  assert.deepEqual(revealWorkTreeBranch(layout([project]), size, view, 'missing'), view);
});

test('empty layouts start at readable scale and resizing retains user zoom and world center', () => {
  assert.deepEqual(initialWorkTreeView(layout([]), size), { zoom: 1, x: 24, y: 24 });
  const view = { x: -390, y: -540, zoom: 1.4 }, nextSize = { width: 720, height: 600 };
  const next = resizeWorkTreeView(view, size, nextSize);
  assert.equal(next.zoom, view.zoom);
  assert.equal((size.width / 2 - view.x) / view.zoom, (nextSize.width / 2 - next.x) / next.zoom);
  assert.equal((size.height / 2 - view.y) / view.zoom, (nextSize.height / 2 - next.y) / next.zoom);
});
