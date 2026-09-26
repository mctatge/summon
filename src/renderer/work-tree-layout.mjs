/** A collapsible, explicitly recorded hierarchy. Dependencies are references, never parentage. */
export const goalNodeId = (repoId, goalId) => `goal:${JSON.stringify([repoId, goalId])}`;
export const rootNodeId = repoId => `root:${JSON.stringify(repoId)}`;
const list = value => Array.isArray(value) ? value : [];
const compare = (a, b) => String(a.label ?? a.title ?? a.name ?? '').localeCompare(String(b.label ?? b.title ?? b.name ?? '')) || String(a.id).localeCompare(String(b.id));
const STATUS_ORDER = { blocked: 0, 'needs-verification': 1, working: 2, planned: 3, deferred: 4, done: 5, dismissed: 6 };
const compareGoals = (a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3) || compare(a, b);
const CARD_WIDTH = 240;
const CARD_HEIGHT = 132;
const DEPTH_STEP = 480;
const SIBLING_GAP = 40;
const sessionKeys = goal => [...new Set([goal.ownerSessionKey, goal.links?.sessionKey].filter(Boolean))];
const blankSummary = () => ({ parentNodeId: null, depth: 0, childCount: 0, descendantCount: 0, expanded: false, activeCount: 0, doneCount: 0, totalCount: 0, dependencyCount: 0 });

/** Dependency cycles remain diagnostic; they do not influence hierarchy or position. */
function dependencyCycles(nodes, edges) {
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) outgoing.get(edge.from)?.push(edge.to);
  let index = 0;
  const indexes = new Map(), low = new Map(), stack = [], stacked = new Set(), components = [];
  function visit(id) {
    indexes.set(id, index); low.set(id, index++); stack.push(id); stacked.add(id);
    for (const next of outgoing.get(id) ?? []) {
      if (!indexes.has(next)) { visit(next); low.set(id, Math.min(low.get(id), low.get(next))); }
      else if (stacked.has(next)) low.set(id, Math.min(low.get(id), indexes.get(next)));
    }
    if (indexes.get(id) === low.get(id)) {
      const members = []; let item;
      do { item = stack.pop(); stacked.delete(item); members.push(item); } while (item !== id);
      components.push(members);
    }
  }
  for (const node of nodes) if (!indexes.has(node.id)) visit(node.id);
  const componentOf = new Map();
  components.forEach((members, id) => members.forEach(member => componentOf.set(member, id)));
  for (const edge of edges) edge.cycle = componentOf.get(edge.from) === componentOf.get(edge.to);
  return components.filter(members => members.length > 1 || edges.some(edge => edge.from === members[0] && edge.to === members[0])).length;
}

export function connector(from, to, side = false) {
  let start, end, c1, c2;
  if (side && to.x === from.x) {
    start = { x: from.x + from.width, y: from.y + from.height / 2 };
    end = { x: to.x + to.width, y: to.y + to.height / 2 };
    const bend = Math.max(start.x, end.x) + 96;
    c1 = { x: bend, y: start.y - (from.id === to.id ? 72 : 0) };
    c2 = { x: bend, y: end.y + (from.id === to.id ? 72 : 0) };
  } else {
    const right = to.x > from.x;
    start = { x: from.x + (right ? from.width : 0), y: from.y + from.height / 2 };
    end = { x: to.x + (right ? 0 : to.width), y: to.y + to.height / 2 };
    const middle = (start.x + end.x) / 2;
    c1 = { x: middle, y: start.y }; c2 = { x: middle, y: end.y };
  }
  return { start, c1, c2, end, path: `M ${start.x} ${start.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y}` };
}

export function pointOnConnector(curve, t) {
  const u = 1 - t;
  return { x: u ** 3 * curve.start.x + 3 * u ** 2 * t * curve.c1.x + 3 * u * t ** 2 * curve.c2.x + t ** 3 * curve.end.x,
    y: u ** 3 * curve.start.y + 3 * u ** 2 * t * curve.c1.y + 3 * u * t ** 2 * curve.c2.y + t ** 3 * curve.end.y };
}

/** Exact cubic split: animation ends at the agent marker, with no completion estimate. */
export function connectorUntil(curve, t) {
  const mix = (a, b) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const a = mix(curve.start, curve.c1), b = mix(curve.c1, curve.c2), c = mix(curve.c2, curve.end);
  const d = mix(a, b), e = mix(b, c), end = mix(d, e);
  return `M ${curve.start.x} ${curve.start.y} C ${a.x} ${a.y} ${d.x} ${d.y} ${end.x} ${end.y}`;
}

function markerRectangle(point, session, children, linkedChildId) {
  // The caption is centered below the icon in a 160px slot, rather than extending
  // toward the task card. Reserve its largest visible scale (1.1) and the icon's
  // maximum overview scale. A linked child's second caption extends farther down.
  const linked = children.find(child => child.id === linkedChildId);
  return { x: point.x - 88, y: point.y - 34, width: 176, height: linked ? 122 : 94 };
}

function markerPosition(edge, preferred, session, children, linkedChildId, nodes, occupied) {
  const intersects = (a, b) => a.x < b.x + b.width + 4 && a.x + a.width + 4 > b.x && a.y < b.y + b.height + 4 && a.y + a.height + 4 > b.y;
  // A fixed sample budget keeps every marker on its recorded connector. Check the
  // requested position first, then progressively nearer alternatives along that line.
  const positions = [...new Set([preferred, ...Array.from({ length: 197 }, (_, index) => (index + 2) / 200)])].sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || b - a);
  let best = null;
  for (const position of positions) {
    const point = pointOnConnector(edge, position), rectangle = markerRectangle(point, session, children, linkedChildId);
    const nodeCollisions = nodes.filter(node => intersects(rectangle, node)).length;
    const markerCollisions = occupied.filter(other => intersects(rectangle, other)).length;
    const score = nodeCollisions * 1000 + markerCollisions;
    if (!best || score < best.score) best = { position, point, rectangle, score };
    if (!score) return best;
  }
  return best;
}

function reachableChildren(session) {
  const candidates = list(session.children).filter(child => child?.key && child.parentSessionKey && child.key !== session.key);
  const descendants = new Set([session.key]), children = [];
  for (let round = 0; round < candidates.length; round++) {
    let added = false;
    for (const child of candidates) if (!descendants.has(child.key) && descendants.has(child.parentSessionKey)) {
      descendants.add(child.key); children.push(child); added = true;
    }
    if (!added) break;
  }
  return children;
}

export function buildWorkTreeLayout(data, { selectedRepoId = null, maxGoals = 180, expandedNodes, selectedNodeId = null } = {}) {
  const repos = list(data?.repos).filter(repo => repo?.id && (!selectedRepoId || repo.id === selectedRepoId));
  const repoIds = new Set(repos.map(repo => repo.id));
  const allGoals = [...new Map(list(data?.goals).filter(goal => goal?.id && repoIds.has(goal.repoId)).map(goal => [goalNodeId(goal.repoId, goal.id), goal])).values()].sort(compareGoals);
  const limit = Number.isFinite(maxGoals) ? Math.max(1, Math.min(300, Math.floor(maxGoals))) : 180;
  const goals = allGoals.slice(0, limit);
  const allKnown = new Map(allGoals.map(goal => [goalNodeId(goal.repoId, goal.id), goal]));
  const externalKnown = new Map(list(data?.externalGoals).map(goal => [goalNodeId(goal.repoId, goal.id), goal]));
  const names = new Map([...repos, ...list(data?.externalRepos)].map(repo => [repo.id, repo.name]));
  const scopedSessions = list(data?.sessions).filter(session => session?.key && (!selectedRepoId || session.repoId === selectedRepoId));
  const sessionsByKey = new Map(scopedSessions.map(session => [session.key, session]));
  const childrenBySession = new Map(scopedSessions.map(session => [session.key, reachableChildren(session)]));
  const isWorking = (goal, key) => {
    // A task linked to a particular child follows that child's observed state.
    // Its lead or siblings may be busy with entirely different work.
    if (goal.links?.sessionKey === key && goal.links?.agentId) {
      const child = childrenBySession.get(key)?.find(child => child.id === goal.links.agentId);
      return Boolean(child && child.activity === 'working' && !child.endedAt);
    }
    return sessionsByKey.get(key)?.activity === 'working' || childrenBySession.get(key)?.some(child => child.activity === 'working' && !child.endedAt);
  };
  const attachedKeys = new Set(allGoals.flatMap(sessionKeys));
  const expanded = expandedNodes ?? new Set(selectedRepoId ? [rootNodeId(selectedRepoId)] : []);
  const hierarchy = new Map(goals.map(goal => [goalNodeId(goal.repoId, goal.id), {
    ...blankSummary(), id: goalNodeId(goal.repoId, goal.id), kind: 'goal', repoId: goal.repoId, goal, label: goal.title,
    width: CARD_WIDTH, height: CARD_HEIGHT, rank: 0, x: 0, y: 0,
  }]));
  const roots = repos.sort((a, b) => Number(!allGoals.some(goal => goal.repoId === a.id)) - Number(!allGoals.some(goal => goal.repoId === b.id)) || compare(a, b)).map(repo => ({
    ...blankSummary(), id: rootNodeId(repo.id), kind: 'root', repoId: repo.id, label: repo.name,
    width: CARD_WIDTH, height: 100, rank: 0, x: 0, y: 0,
  }));
  roots.forEach(root => hierarchy.set(root.id, root));
  let missingParents = 0, parentCycles = 0;
  for (const node of hierarchy.values()) if (node.goal) {
    const parent = node.goal.parentId && goalNodeId(node.repoId, node.goal.parentId);
    node.parentNodeId = parent && hierarchy.get(parent)?.kind === 'goal' ? parent : rootNodeId(node.repoId);
    if (parent && node.parentNodeId !== parent) missingParents++;
  }
  // A corrupt parent cycle is cut at every involved member. Its children still retain
  // their recorded parents; no task is duplicated or lost behind an unexpandable cycle.
  const checked = new Set();
  for (const node of hierarchy.values()) if (node.goal && !checked.has(node.id)) {
    const path = [], index = new Map(); let cursor = node;
    while (cursor?.kind === 'goal' && !checked.has(cursor.id)) {
      if (index.has(cursor.id)) {
        parentCycles++;
        for (const id of path.slice(index.get(cursor.id))) hierarchy.get(id).parentNodeId = rootNodeId(hierarchy.get(id).repoId);
        break;
      }
      index.set(cursor.id, path.length); path.push(cursor.id); cursor = hierarchy.get(cursor.parentNodeId);
    }
    path.forEach(id => checked.add(id));
  }
  const children = new Map([...hierarchy.keys()].map(id => [id, []]));
  for (const node of hierarchy.values()) if (node.parentNodeId) children.get(node.parentNodeId).push(node);
  for (const siblings of children.values()) siblings.sort((a, b) => compareGoals(a.goal, b.goal));

  // References are recorded independently of the parent tree, including hidden endpoints.
  const references = [], referenceIds = new Set(), diagnosticIds = new Set(goals.map(goal => goalNodeId(goal.repoId, goal.id)));
  function addReference(from, to, kind, label) {
    const id = JSON.stringify([from, to, kind]);
    if (referenceIds.has(id)) return;
    referenceIds.add(id); diagnosticIds.add(from); diagnosticIds.add(to);
    references.push({ id, from, to, kind, label, cycle: false });
  }
  for (const goal of goals) {
    const to = goalNodeId(goal.repoId, goal.id);
    const dependencies = new Set();
    for (const id of list(goal.dependsOn)) if (typeof id === 'string' && id) {
      const from = goalNodeId(goal.repoId, id); dependencies.add(from); addReference(from, to, 'dependency', 'Depends on');
    }
    for (const ref of list(goal.crossRepoDependsOn)) if (ref?.repoId && ref?.goalId) {
      const from = goalNodeId(ref.repoId, ref.goalId); dependencies.add(from); addReference(from, to, ref.repoId === goal.repoId ? 'dependency' : 'external', 'Depends on');
    }
    hierarchy.get(to).dependencyCount = dependencies.size;
    for (const id of list(goal.serialWith)) if (typeof id === 'string' && id && id !== goal.id) {
      const [a, b] = [to, goalNodeId(goal.repoId, id)].sort(); addReference(a, b, 'coordination', 'One at a time');
    }
  }
  const cycleCount = dependencyCycles([...diagnosticIds].map(id => ({ id })), references.filter(edge => edge.kind !== 'coordination'));

  function summarize(node, depth) {
    const descendants = children.get(node.id), active = new Set(node.goal ? sessionKeys(node.goal).filter(key => isWorking(node.goal, key)) : []);
    node.depth = depth; node.rank = depth; node.childCount = descendants.length; node.expanded = descendants.length > 0 && expanded.has(node.id);
    node.totalCount = node.goal ? 1 : 0; node.doneCount = node.goal?.status === 'done' ? 1 : 0;
    for (const child of descendants) {
      const childActive = summarize(child, depth + 1); childActive.forEach(key => active.add(key));
      node.totalCount += child.totalCount; node.doneCount += child.doneCount;
    }
    node.descendantCount = node.totalCount - (node.goal ? 1 : 0); node.activeCount = active.size;
    return active;
  }
  roots.forEach(root => summarize(root, 0));
  const spans = new Map();
  function measure(node) {
    const descendants = node.expanded ? children.get(node.id) : [];
    const span = Math.max(node.height, descendants.reduce((sum, child) => sum + measure(child), 0) + Math.max(0, descendants.length - 1) * SIBLING_GAP);
    spans.set(node.id, span); return span;
  }
  roots.forEach(measure);
  const nodes = [], edges = [];
  function position(node, top) {
    node.x = 48 + node.depth * DEPTH_STEP; node.y = top;
    nodes.push(node);
    if (!node.expanded) return;
    let cursor = top;
    for (const [index, child] of children.get(node.id).entries()) {
      position(child, cursor);
      // Expansion grows downward from the first (highest-priority) child. A tall
      // branch must not pull its parent halfway down the map or hide that child.
      if (index === 0) node.y = child.y + child.height / 2 - node.height / 2;
      edges.push({ id: JSON.stringify([node.id, child.id, 'parent']), from: node.id, to: child.id, kind: node.kind === 'root' ? 'root' : 'hierarchy', label: '', cycle: false, ...connector(node, child) });
      cursor += spans.get(child.id) + SIBLING_GAP;
    }
  }
  let bottom = 48;
  for (const root of roots) { position(root, bottom); bottom += spans.get(root.id) + 96; }
  const visible = new Map(nodes.map(node => [node.id, node]));
  if (visible.get(selectedNodeId)?.kind === 'goal') {
    const selectedReferences = references.filter(edge => edge.from === selectedNodeId || edge.to === selectedNodeId);
    const stubs = new Map();
    const referenceNode = id => {
      if (visible.has(id)) return visible.get(id);
      if (stubs.has(id)) return stubs.get(id);
      const [repoId, goalId] = JSON.parse(id.slice(5));
      const known = repoIds.has(repoId) ? allKnown.get(id) : externalKnown.get(id);
      const stub = { ...blankSummary(), id, kind: 'external', repoId, label: known?.title || 'Unavailable task', projectName: names.get(repoId) || 'Another project',
        detail: !repoIds.has(repoId) ? 'External dependency' : hierarchy.has(id) ? 'In a collapsed branch' : known ? 'Outside this map limit' : 'Referenced task unavailable',
        width: CARD_WIDTH, height: CARD_HEIGHT, rank: 0, x: 48 + stubs.size % 3 * 300, y: bottom + Math.floor(stubs.size / 3) * (CARD_HEIGHT + 52) };
      stubs.set(id, stub); nodes.push(stub); return stub;
    };
    for (const edge of selectedReferences) {
      const from = referenceNode(edge.from), to = referenceNode(edge.to);
      edges.push({ ...edge, ...connector(from, to, true) });
    }
  }

  const agents = [], occupiedMarkers = [];
  for (const node of nodes.filter(node => node.kind === 'goal')) {
    const edge = edges.find(edge => edge.to === node.id && (edge.kind === 'root' || edge.kind === 'hierarchy'));
    if (!edge) continue;
    sessionKeys(node.goal).forEach((key, index) => {
      const session = sessionsByKey.get(key); if (!session) return;
      const children = childrenBySession.get(key), linkedChildId = node.goal.links?.sessionKey === key ? node.goal.links?.agentId ?? null : null;
      const marker = markerPosition(edge, Math.max(.24, .72 - index * .28), session, children, linkedChildId, nodes, occupiedMarkers);
      occupiedMarkers.push(marker.rectangle);
      agents.push({ id: JSON.stringify([node.id, key]), nodeId: node.id, edgeId: edge.id, session, children, linkedChildId,
        position: marker.position, active: Boolean(isWorking(node.goal, key)), ...marker.point, path: connectorUntil(edge, marker.position) });
    });
  }
  const visibleGoals = nodes.filter(node => node.kind === 'goal').length;
  return { nodes, edges, agents, unlinkedSessions: scopedSessions.filter(session => !attachedKeys.has(session.key)),
    width: Math.max(440, 48 + Math.max(0, ...nodes.map(node => node.x + node.width))),
    height: Math.max(240, 48 + Math.max(0, ...nodes.map(node => node.y + node.height))),
    totalGoalCount: allGoals.length, collapsedCount: goals.length - visibleGoals, hiddenCount: allGoals.length - goals.length, cycleCount,
    warnings: [...list(data?.warnings),
      ...(parentCycles ? [`${parentCycles} circular parent ${parentCycles === 1 ? 'relationship was' : 'relationships were'} moved to the project level for review.`] : []),
      ...(missingParents ? [`${missingParents} ${missingParents === 1 ? 'task has an unavailable parent' : 'tasks have unavailable parents'} and appear at project level.`] : []),
      ...(cycleCount ? [`${cycleCount} circular task ${cycleCount === 1 ? 'dependency needs' : 'dependencies need'} review.`] : [])] };
}
