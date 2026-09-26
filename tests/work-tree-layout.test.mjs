import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkTreeLayout, connectorUntil, goalNodeId, pointOnConnector, rootNodeId } from '../src/renderer/work-tree-layout.mjs';

const repo = (id, name = id) => ({ id, name, places: [] });
const goal = (id, repoId = 'a', patch = {}) => ({ id, repoId, title: id, status: 'planned', dependsOn: [], parentId: null, links: {}, ...patch });
const session = (key, repoId = 'a', patch = {}) => ({ key, repoId, activity: 'working', title: key, appLabel: 'Codex', children: [], ...patch });
const data = (patch = {}) => ({ repos: [repo('a')], goals: [], sessions: [], externalGoals: [], externalRepos: [], warnings: [], ...patch });
const node = (layout, id, repoId = 'a') => layout.nodes.find(item => item.id === goalNodeId(repoId, id));
const expandAll = snapshot => new Set([...snapshot.repos.map(repo => rootNodeId(repo.id)), ...snapshot.goals.filter(Boolean).map(goal => goalNodeId(goal.repoId, goal.id))]);
const expandedLayout = (snapshot, options = {}) => buildWorkTreeLayout(snapshot, { expandedNodes: expandAll(snapshot), ...options });
const assertNoOverlap = layout => {
  for (let i = 0; i < layout.nodes.length; i++) for (let j = i + 1; j < layout.nodes.length; j++) {
    const a = layout.nodes[i], b = layout.nodes[j];
    assert.equal(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y, false, `${a.label} overlaps ${b.label}`);
  }
};

test('global view starts with collapsed project roots and selected project opens its first level', () => {
  const snapshot = data({ repos: [repo('a'), repo('b')], goals: [goal('top'), goal('child', 'a', { parentId: 'top' }), goal('other', 'b')] });
  const all = buildWorkTreeLayout(snapshot);
  assert.deepEqual(all.nodes.map(node => node.kind), ['root', 'root']);
  assert.equal(all.collapsedCount, 3);
  const selected = buildWorkTreeLayout(snapshot, { selectedRepoId: 'a' });
  assert.deepEqual(selected.nodes.map(node => node.kind), ['root', 'goal']);
  assert.equal(node(selected, 'top').childCount, 1);
  assert.equal(node(selected, 'top').expanded, false);
  assert.equal(selected.collapsedCount, 1);
  assert.equal(selected.totalGoalCount, 2);
});

test('explicit expanded set controls each level independently', () => {
  const snapshot = data({ goals: [goal('parent'), goal('child', 'a', { parentId: 'parent' }), goal('grandchild', 'a', { parentId: 'child' })] });
  const closed = buildWorkTreeLayout(snapshot, { selectedRepoId: 'a', expandedNodes: new Set() });
  assert.equal(closed.nodes.length, 1);
  const partial = buildWorkTreeLayout(snapshot, { expandedNodes: new Set([rootNodeId('a'), goalNodeId('a', 'parent')]) });
  assert.ok(node(partial, 'child'));
  assert.equal(node(partial, 'grandchild'), undefined);
  assert.equal(partial.collapsedCount, 1);
  const complete = expandedLayout(snapshot);
  assert.equal(complete.collapsedCount, 0);
  assert.equal(new Set(complete.nodes.map(node => node.id)).size, 4);
});

test('only parentId defines hierarchy; dependencies never create parentage or default edges', () => {
  const snapshot = data({ goals: [goal('first'), goal('next', 'a', { dependsOn: ['first'] })] });
  const layout = expandedLayout(snapshot);
  assert.equal(node(layout, 'first').parentNodeId, rootNodeId('a'));
  assert.equal(node(layout, 'next').parentNodeId, rootNodeId('a'));
  assert.equal(node(layout, 'first').depth, 1);
  assert.equal(node(layout, 'first').x, node(layout, 'next').x);
  assert.equal(node(layout, 'next').dependencyCount, 1);
  assert.equal(layout.edges.filter(edge => edge.kind !== 'root').length, 0);
});

test('expanded hierarchy runs left-to-right with room for agents and no card overlap', () => {
  const snapshot = data({ goals: [goal('parent'), goal('child', 'a', { parentId: 'parent' }), goal('grandchild', 'a', { parentId: 'child' }), goal('sibling')] });
  const layout = expandedLayout(snapshot);
  const root = layout.nodes.find(node => node.kind === 'root');
  assert.equal(root.height, 100);
  assert.equal(node(layout, 'parent').height, 132);
  assert.ok(node(layout, 'parent').x - (root.x + root.width) >= 220);
  assert.ok(node(layout, 'child').x > node(layout, 'parent').x);
  assert.equal(node(layout, 'grandchild').depth, 3);
  for (const edge of layout.edges) {
    const from = layout.nodes.find(node => node.id === edge.from), to = layout.nodes.find(node => node.id === edge.to);
    assert.equal(edge.start.x, from.x + from.width);
    assert.equal(edge.end.x, to.x);
  }
  assertNoOverlap(layout);
});

test('parents align with their first visible child when large branches expand downward', () => {
  const goals = [goal('active-parent', 'a', { status: 'working' }), ...Array.from({ length: 14 }, (_, index) => goal(`child-${String(index).padStart(2, '0')}`, 'a', { parentId: 'active-parent' })), ...Array.from({ length: 13 }, (_, index) => goal(`top-${index}`))];
  const snapshot = data({ goals });
  const collapsed = buildWorkTreeLayout(snapshot, { selectedRepoId: 'a' });
  const expanded = expandedLayout(snapshot);
  const root = expanded.nodes.find(node => node.kind === 'root'), parent = node(expanded, 'active-parent'), first = node(expanded, 'child-00');
  assert.equal(root.y + root.height / 2, parent.y + parent.height / 2);
  assert.equal(parent.y + parent.height / 2, first.y + first.height / 2);
  assert.equal(parent.y, node(collapsed, 'active-parent').y, 'expansion should grow below the parent instead of moving it into the subtree midpoint');
  assert.equal(root.y, collapsed.nodes.find(node => node.kind === 'root').y);
  assert.ok(node(expanded, 'child-13').y > first.y);
  assert.ok(node(expanded, 'top-0').y > node(expanded, 'child-13').y + first.height);
  assertNoOverlap(expanded);
});

test('project roots stack vertically with projects containing work before empty projects', () => {
  const layout = buildWorkTreeLayout(data({ repos: [repo('empty', 'A empty'), repo('b', 'B work'), repo('c', 'C work')], goals: [goal('task', 'b'), goal('task', 'c')] }));
  assert.deepEqual(layout.nodes.map(node => node.repoId), ['b', 'c', 'empty']);
  assert.equal(new Set(layout.nodes.map(node => node.x)).size, 1);
  assert.ok(layout.nodes[1].y > layout.nodes[0].y);
  assertNoOverlap(layout);
});

test('attention and working siblings precede ordinary work with stable title ordering', () => {
  const layout = expandedLayout(data({ goals: [goal('z-planned'), goal('b-working', 'a', { status: 'working' }), goal('a-working', 'a', { status: 'working' }), goal('needs-help', 'a', { status: 'blocked' }), goal('done', 'a', { status: 'done' })] }));
  assert.deepEqual(layout.nodes.filter(node => node.kind === 'goal').map(node => node.label), ['needs-help', 'a-working', 'b-working', 'z-planned', 'done']);
});

test('subtree summaries survive collapse and count unique working sessions', () => {
  const snapshot = data({ goals: [goal('parent', 'a', { ownerSessionKey: 'shared' }), goal('child', 'a', { parentId: 'parent', ownerSessionKey: 'shared', status: 'done' }), goal('second', 'a', { parentId: 'parent', links: { sessionKey: 'another' } })], sessions: [session('shared'), session('another'), session('free')] });
  const layout = buildWorkTreeLayout(snapshot, { selectedRepoId: 'a' });
  const parent = node(layout, 'parent'), root = layout.nodes.find(node => node.kind === 'root');
  assert.equal(parent.childCount, 2);
  assert.equal(parent.descendantCount, 2);
  assert.equal(parent.totalCount, 3);
  assert.equal(parent.doneCount, 1);
  assert.equal(parent.activeCount, 2);
  assert.equal(root.activeCount, 2);
  assert.deepEqual(layout.unlinkedSessions.map(session => session.key), ['free']);
  assert.deepEqual(layout.agents.map(agent => agent.session.key), ['shared']);
});

test('parent cycles fall back to project level while every task remains expandable exactly once', () => {
  const snapshot = data({ goals: [goal('a', 'a', { parentId: 'b' }), goal('b', 'a', { parentId: 'a' }), goal('self', 'a', { parentId: 'self' }), goal('child', 'a', { parentId: 'a' })] });
  const layout = expandedLayout(snapshot);
  assert.equal(node(layout, 'a').parentNodeId, rootNodeId('a'));
  assert.equal(node(layout, 'b').parentNodeId, rootNodeId('a'));
  assert.equal(node(layout, 'self').parentNodeId, rootNodeId('a'));
  assert.equal(node(layout, 'child').parentNodeId, goalNodeId('a', 'a'));
  assert.equal(layout.nodes.filter(node => node.kind === 'goal').length, 4);
  assert.equal(new Set(layout.nodes.map(node => node.id)).size, 5);
  assert.ok(layout.warnings.some(warning => warning.includes('2 circular parent')));
  assertNoOverlap(layout);
});

test('unavailable parents become project children with an explicit warning', () => {
  const layout = expandedLayout(data({ goals: [goal('orphan', 'a', { parentId: 'missing' })] }));
  assert.equal(node(layout, 'orphan').parentNodeId, rootNodeId('a'));
  assert.ok(layout.warnings.some(warning => warning.includes('unavailable parent')));
});

test('dependency cycles are diagnosed but neither alter hierarchy nor show unrelated edges', () => {
  const snapshot = data({ goals: [goal('a', 'a', { dependsOn: ['b'] }), goal('b', 'a', { dependsOn: ['a'] }), goal('self', 'a', { dependsOn: ['self'] })] });
  const layout = expandedLayout(snapshot);
  assert.equal(layout.cycleCount, 2);
  assert.ok(layout.warnings.some(warning => warning.includes('circular task')));
  assert.equal(layout.edges.filter(edge => edge.kind !== 'root').length, 0);
  const focused = expandedLayout(snapshot, { selectedNodeId: goalNodeId('a', 'a') });
  assert.equal(focused.edges.filter(edge => edge.kind === 'dependency').length, 2);
  assert.ok(focused.edges.filter(edge => edge.kind === 'dependency').every(edge => edge.cycle));
});

test('selecting a task reveals only its incident dependency and coordination references', () => {
  const snapshot = data({ goals: [goal('a'), goal('b', 'a', { dependsOn: ['a'], serialWith: ['c'] }), goal('c'), goal('d', 'a', { dependsOn: ['c'] }), goal('consumer', 'a', { dependsOn: ['b'] })] });
  const layout = expandedLayout(snapshot, { selectedNodeId: goalNodeId('a', 'b') });
  const references = layout.edges.filter(edge => !['root', 'hierarchy'].includes(edge.kind));
  assert.equal(references.length, 3);
  assert.ok(references.every(edge => edge.from === goalNodeId('a', 'b') || edge.to === goalNodeId('a', 'b')));
  assert.equal(references.filter(edge => edge.kind === 'coordination').length, 1);
});

test('a referenced collapsed task gets a minimal separate-lane stub without expanding its branch', () => {
  const snapshot = data({ goals: [goal('branch'), goal('hidden', 'a', { parentId: 'branch', status: 'working' }), goal('selected', 'a', { dependsOn: ['hidden'] })] });
  const layout = buildWorkTreeLayout(snapshot, { selectedRepoId: 'a', selectedNodeId: goalNodeId('a', 'selected') });
  const stub = node(layout, 'hidden');
  assert.equal(stub.kind, 'external');
  assert.equal(stub.goal, undefined);
  assert.equal(stub.status, undefined);
  assert.equal(stub.label, 'hidden');
  assert.equal(node(layout, 'branch').expanded, false);
  assert.ok(stub.y > Math.max(...layout.nodes.filter(node => node.kind !== 'external').map(node => node.y + node.height)));
  assert.equal(layout.collapsedCount, 1);
  assertNoOverlap(layout);
});

test('selected project leaks no outside goals, agents, or status; explicit external stub only', () => {
  const snapshot = data({ repos: [repo('a'), repo('b', 'Secret project')], goals: [goal('own', 'a', { crossRepoDependsOn: [{ repoId: 'b', goalId: 'shared' }] }), goal('shared', 'b', { title: 'PRIVATE FULL TITLE', status: 'working' }), goal('secret', 'b')], sessions: [session('mine'), session('other', 'b')], externalGoals: [{ repoId: 'b', id: 'shared', title: 'Shared API', status: 'working' }], externalRepos: [{ id: 'b', name: 'Platform' }] });
  const layout = buildWorkTreeLayout(snapshot, { selectedRepoId: 'a', selectedNodeId: goalNodeId('a', 'own') });
  assert.deepEqual(layout.nodes.filter(node => node.kind === 'goal').map(node => node.repoId), ['a']);
  assert.deepEqual(layout.unlinkedSessions.map(session => session.key), ['mine']);
  const stub = node(layout, 'shared', 'b');
  assert.equal(stub.label, 'Shared API'); assert.equal(stub.projectName, 'Platform'); assert.equal(stub.goal, undefined); assert.equal(stub.status, undefined);
  assert.equal(JSON.stringify(layout).includes('PRIVATE FULL TITLE'), false);
  assert.equal(node(layout, 'secret', 'b'), undefined);
  const unselected = buildWorkTreeLayout(snapshot, { selectedRepoId: 'a' });
  assert.equal(unselected.nodes.some(node => node.kind === 'external'), false);
});

test('all-project references reuse visible targets and handle duplicate ids across projects', () => {
  const snapshot = data({ repos: [repo('a'), repo('b')], goals: [goal('same'), goal('same', 'b'), goal('selected', 'a', { crossRepoDependsOn: [{ repoId: 'b', goalId: 'same' }] })] });
  const layout = expandedLayout(snapshot, { selectedNodeId: goalNodeId('a', 'selected') });
  assert.equal(layout.nodes.filter(node => node.kind === 'goal').length, 3);
  assert.equal(layout.nodes.some(node => node.kind === 'external'), false);
  assert.equal(layout.edges.find(edge => edge.kind === 'external').from, goalNodeId('b', 'same'));
});

test('agents use only visible tasks parent connectors and keep activity on the chosen route', () => {
  const snapshot = data({ goals: [goal('parent'), goal('child', 'a', { parentId: 'parent', dependsOn: ['parent'], ownerSessionKey: 'lead', sessionKeys: ['history'] })], sessions: [session('lead'), session('history'), session('child')] });
  const layout = expandedLayout(snapshot, { selectedNodeId: goalNodeId('a', 'child') });
  assert.deepEqual(layout.agents.map(agent => agent.session.key), ['lead']);
  const agent = layout.agents[0], edge = layout.edges.find(edge => edge.id === agent.edgeId);
  assert.equal(edge.kind, 'hierarchy');
  assert.deepEqual({ x: agent.x, y: agent.y }, pointOnConnector(edge, agent.position));
  assert.equal(agent.path, connectorUntil(edge, agent.position));
  assert.deepEqual(layout.unlinkedSessions.map(session => session.key), ['history', 'child']);
});

test('persistent lead retains reachable descendant topology without unrelated subagents', () => {
  const children = [{ key: 'grandchild', id: 'g', parentSessionKey: 'child', activity: 'working', endedAt: null }, { key: 'unrelated', id: 'u', parentSessionKey: 'some-other-session', activity: 'working' }, { key: 'child', id: 'c', parentSessionKey: 'lead', activity: 'quiet' }];
  const snapshot = data({ goals: [goal('task', 'a', { links: { sessionKey: 'lead', agentId: 'g' } })], sessions: [session('lead', 'a', { activity: 'quiet', children })] });
  const agent = expandedLayout(snapshot).agents[0];
  assert.equal(agent.session.key, 'lead'); assert.equal(agent.active, true); assert.equal(agent.linkedChildId, 'g');
  assert.deepEqual(agent.children.map(child => child.key).sort(), ['child', 'grandchild']);
});

test('a stopped linked child does not animate because its lead or sibling is working', () => {
  const children = [{ key: 'stopped', id: 'a', parentSessionKey: 'lead', activity: 'working', endedAt: '2026-09-21T12:00:00Z' }, { key: 'sibling', id: 'b', parentSessionKey: 'lead', activity: 'working', endedAt: null }];
  const snapshot = data({ goals: [goal('task', 'a', { ownerSessionKey: 'lead', links: { sessionKey: 'lead', agentId: 'a' } })], sessions: [session('lead', 'a', { children })] });
  const layout = expandedLayout(snapshot);
  assert.equal(layout.agents[0].active, false);
  assert.equal(node(layout, 'task').activeCount, 0);
  assert.equal(layout.nodes.find(node => node.kind === 'root').activeCount, 0);
});

test('the observed active linked child animates and counts once despite a quiet lead', () => {
  const children = [{ key: 'child', id: 'a', parentSessionKey: 'lead', activity: 'working', endedAt: null }];
  const snapshot = data({ goals: [goal('parent', 'a', { links: { sessionKey: 'lead', agentId: 'a' } }), goal('nested', 'a', { parentId: 'parent', links: { sessionKey: 'lead', agentId: 'a' } })], sessions: [session('lead', 'a', { activity: 'quiet', children })] });
  const layout = expandedLayout(snapshot);
  assert.ok(layout.agents.every(agent => agent.active));
  assert.equal(node(layout, 'parent').activeCount, 1);
  assert.equal(layout.nodes.find(node => node.kind === 'root').activeCount, 1);
});

test('an unavailable linked child stays unknown without borrowing sibling activity', () => {
  const children = [{ key: 'sibling', id: 'b', parentSessionKey: 'lead', activity: 'working', endedAt: null }];
  const layout = expandedLayout(data({ goals: [goal('task', 'a', { links: { sessionKey: 'lead', agentId: 'missing' } })], sessions: [session('lead', 'a', { children })] }));
  assert.equal(layout.agents[0].active, false);
  assert.equal(layout.agents[0].linkedChildId, 'missing');
  assert.equal(node(layout, 'task').activeCount, 0);
});

test('a different explicit owner retains its own activity beside an inactive linked child', () => {
  const children = [{ key: 'child', id: 'a', parentSessionKey: 'lead', activity: 'quiet', endedAt: null }];
  const layout = expandedLayout(data({ goals: [goal('task', 'a', { ownerSessionKey: 'other', links: { sessionKey: 'lead', agentId: 'a' } })], sessions: [session('lead', 'a', { children }), session('other')] }));
  assert.equal(layout.agents.find(agent => agent.session.key === 'lead').active, false);
  assert.equal(layout.agents.find(agent => agent.session.key === 'other').active, true);
  assert.equal(node(layout, 'task').activeCount, 1);
});

test('thirteen owned siblings keep agent footprints clear of hierarchy cards and one another', () => {
  const goals = Array.from({ length: 13 }, (_, index) => goal(`task-${index}`, 'a', { ownerSessionKey: `owner-${index}` }));
  const layout = expandedLayout(data({ goals, sessions: goals.map(goal => session(goal.ownerSessionKey)) }));
  assert.equal(layout.agents.length, 13);
  const rectangles = [];
  for (const agent of layout.agents) {
    const rectangle = { x: agent.x - 88, y: agent.y - 34, width: 176, height: 94 };
    for (const other of [...layout.nodes, ...rectangles]) assert.equal(rectangle.x < other.x + other.width && rectangle.x + rectangle.width > other.x && rectangle.y < other.y + other.height && rectangle.y + rectangle.height > other.y, false, `${agent.session.key} overlaps a card or agent`);
    rectangles.push(rectangle);
  }
});

test('centered provider and linked-child captions clear their task on a horizontal connector', () => {
  const children = [{ key: 'child', id: 'c', parentSessionKey: 'lead', label: 'Long-running specialist', activity: 'working', endedAt: null }];
  const snapshot = data({ goals: [goal('task', 'a', { links: { sessionKey: 'lead', agentId: 'c' } })], sessions: [session('lead', 'a', { appLabel: 'Claude app', helpers: 2, children })] });
  const layout = expandedLayout(snapshot), agent = layout.agents[0];
  const rectangle = { x: agent.x - 88, y: agent.y - 34, width: 176, height: 122 };
  for (const other of layout.nodes) assert.equal(rectangle.x < other.x + other.width && rectangle.x + rectangle.width > other.x && rectangle.y < other.y + other.height && rectangle.y + rectangle.height > other.y, false, 'centered caption overlaps a task or project');
  const edge = layout.edges.find(edge => edge.id === agent.edgeId);
  assert.deepEqual({ x: agent.x, y: agent.y }, pointOnConnector(edge, agent.position));
  assert.equal(agent.path, connectorUntil(edge, agent.position));
});

test('bound-limit counts and collapsed counts remain distinct; omitted references are stubs', () => {
  const snapshot = data({ goals: [goal('a', 'a', { dependsOn: ['z'] }), goal('b'), goal('z')] });
  const closed = buildWorkTreeLayout(snapshot, { maxGoals: 2 });
  assert.equal(closed.totalGoalCount, 3); assert.equal(closed.hiddenCount, 1); assert.equal(closed.collapsedCount, 2);
  const open = expandedLayout(snapshot, { maxGoals: 2, selectedNodeId: goalNodeId('a', 'a') });
  assert.equal(open.hiddenCount, 1); assert.equal(open.collapsedCount, 0);
  assert.equal(node(open, 'z').kind, 'external'); assert.equal(node(open, 'z').detail, 'Outside this map limit');
});

test('partial snapshots remain usable and duplicate records render once', () => {
  assert.doesNotThrow(() => buildWorkTreeLayout(null));
  assert.doesNotThrow(() => expandedLayout(data({ goals: [null, goal('a', 'a', { dependsOn: null, crossRepoDependsOn: null })] })));
  const layout = expandedLayout(data({ goals: [goal('a'), goal('a')] }));
  assert.equal(layout.nodes.filter(node => node.kind === 'goal').length, 1);
  const unknown = buildWorkTreeLayout(data(), { selectedRepoId: 'unknown' });
  assert.equal(unknown.nodes.length, 0); assert.equal(unknown.unlinkedSessions.length, 0);
});
