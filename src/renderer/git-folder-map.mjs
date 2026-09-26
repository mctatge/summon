const PROJECT_WIDTH = 220;
const PROJECT_HEIGHT = 112;
const FOLDER_X = 300;
const FOLDER_WIDTH = 340;
const FOLDER_HEIGHT = 152;
const FOLDER_STEP = 172;
const GROUP_GAP = 40;
const COLUMN_GAP = 64;
const OVERVIEW_ASPECT = 1.8;
const matches = (values, query) => values.some(value => typeof value === 'string' && value.toLowerCase().includes(query));

/** Keep complete project groups together; put each next group in the shortest column. */
function packGroups(groups, columns, columnWidth) {
  const bottoms = Array(columns).fill(0);
  const positions = [];
  let width = 1, height = 1;
  for (const group of groups) {
    let column = 0;
    for (let index = 1; index < columns; index++) if (bottoms[index] < bottoms[column]) column = index;
    const x = column * (columnWidth + COLUMN_GAP), y = bottoms[column];
    positions.push({ x, y });
    width = Math.max(width, x + group.width);
    height = Math.max(height, y + group.height);
    bottoms[column] = y + group.height + GROUP_GAP;
  }
  return { positions, width, height };
}

/** Lay out every matching working folder under its project without changing source order. */
export function layoutGitFolders(repos, query = '') {
  const search = query.trim().toLowerCase();
  const nodes = [];
  const edges = [];
  const groups = [];
  let folderCount = 0;

  for (const repo of repos) {
    const projectMatches = !search || matches([repo.name, repo.displayPath], search);
    const places = projectMatches ? repo.places : repo.places.filter(place => matches([place.label, place.branch, place.displayPath], search));
    if (!projectMatches && !places.length) continue;
    // Partition instead of sorting so both groups keep the scanner's stable order.
    const ordered = [...places.filter(place => place.kind === 'main'), ...places.filter(place => place.kind !== 'main')];
    groups.push({ repo, ordered, width: ordered.length ? FOLDER_X + FOLDER_WIDTH : PROJECT_WIDTH, height: Math.max(PROJECT_HEIGHT, ordered.length ? FOLDER_HEIGHT + (ordered.length - 1) * FOLDER_STEP : 0) });
  }

  const columnWidth = groups.reduce((maximum, group) => Math.max(maximum, group.width), 1);
  let packed = packGroups(groups, 1, columnWidth);
  // Compare whole-group layouts against a landscape viewport. Actual heights,
  // not just project count, decide whether a second or third column helps Fit.
  let fitCost = Math.max(packed.width / OVERVIEW_ASPECT, packed.height);
  for (let columns = 2; columns <= Math.ceil(Math.sqrt(groups.length)); columns++) {
    const candidate = packGroups(groups, columns, columnWidth);
    const candidateCost = Math.max(candidate.width / OVERVIEW_ASPECT, candidate.height);
    if (candidateCost < fitCost) { packed = candidate; fitCost = candidateCost; }
  }

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const { repo, ordered } = groups[groupIndex];
    const { x, y } = packed.positions[groupIndex];
    const projectId = `project:${JSON.stringify(repo.id)}`;
    nodes.push({ id: projectId, kind: 'project', repoId: repo.id, placeId: null, x, y, width: PROJECT_WIDTH, height: PROJECT_HEIGHT });
    for (let index = 0; index < ordered.length; index++) {
      const place = ordered[index];
      const identity = JSON.stringify([repo.id, place.id]);
      const folderId = `folder:${identity}`;
      nodes.push({ id: folderId, kind: 'folder', repoId: repo.id, placeId: place.id, x: x + FOLDER_X, y: y + index * FOLDER_STEP, width: FOLDER_WIDTH, height: FOLDER_HEIGHT });
      edges.push({ id: `edge:${identity}`, source: projectId, target: folderId });
      folderCount++;
    }
  }
  return { nodes, edges, width: packed.width, height: packed.height, projectCount: groups.length, folderCount };
}
