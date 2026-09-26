const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export function fitWorkTree(layout, size) {
  const zoom = clamp(Math.min(Math.max(1, size.width - 48) / Math.max(1, layout.width), Math.max(1, size.height - 40) / Math.max(1, layout.height)), .005, 1.15);
  return { zoom, x: (size.width - layout.width * zoom) / 2, y: (size.height - layout.height * zoom) / 2 };
}
const boundsOf = nodes => ({
  left: Math.min(...nodes.map(node => node.x)), right: Math.max(...nodes.map(node => node.x + node.width)),
  top: Math.min(...nodes.map(node => node.y)), bottom: Math.max(...nodes.map(node => node.y + node.height)),
});
const centerY = node => node.y + node.height / 2;
const padding = 24;

/** Start with the hierarchy's left edge; a long project list must never shrink the cards. */
export function initialWorkTreeView(layout, size) {
  if (!layout.nodes.length) return { zoom: 1, x: padding, y: padding };
  const roots = layout.nodes.filter(node => node.kind === 'root');
  const goals = layout.nodes.filter(node => node.kind === 'goal');
  const startingRoot = [...roots].sort((a, b) => a.y - b.y || a.x - b.x)[0];
  if (!goals.length) {
    const start = startingRoot ?? layout.nodes[0];
    return { zoom: 1, x: padding - start.x, y: padding - start.y };
  }
  // Priority belongs to sibling ordering. Jumping to an active lower sibling hides the project's starting hierarchy.
  const root = startingRoot;
  const children = root ? layout.nodes.filter(node => node.parentNodeId === root.id).sort((a, b) => a.y - b.y || a.x - b.x) : [];
  const first = children[0] ?? root ?? [...goals].sort((a, b) => a.y - b.y || a.x - b.x)[0];
  const starting = root ? [root, ...children] : [first];
  const bounds = boundsOf(starting);
  const zoom = clamp((size.width - padding * 2) / Math.max(1, bounds.right - bounds.left), .8, 1);
  const y = padding - Math.min(root?.y ?? first.y, first.y) * zoom;
  return { zoom, x: padding - bounds.left * zoom, y };
}

/** Explicit expansion reveals one branch, preserving user zoom and the clicked parent's position where possible. */
export function revealWorkTreeBranch(layout, size, view, nodeId, previousNode) {
  const parent = layout.nodes.find(node => node.id === nodeId);
  if (!parent) return { ...view };
  const zoom = view.zoom;
  let x = view.x + (previousNode ? previousNode.x - parent.x : 0) * zoom;
  let y = view.y + (previousNode ? centerY(previousNode) - centerY(parent) : 0) * zoom;
  const children = layout.nodes.filter(node => node.parentNodeId === parent.id);
  const bounds = boundsOf([parent, ...children]);
  if ((bounds.right - bounds.left) * zoom <= size.width - padding * 2) {
    x = clamp(x, padding - bounds.left * zoom, size.width - padding - bounds.right * zoom);
  } else {
    // A wide branch cannot fit at this chosen zoom. Keep its parent and the start of the child column visible.
    x = padding - parent.x * zoom;
  }
  if ((bounds.bottom - bounds.top) * zoom <= size.height - padding * 2) {
    y = clamp(y, padding - bounds.top * zoom, size.height - padding - bounds.bottom * zoom);
  } else if (children.length) {
    // Open a long list at its first action. Anchoring only the shorter parent can clip the first child above it.
    const firstChild = [...children].sort((a, b) => a.y - b.y || a.x - b.x)[0];
    y = padding - Math.min(parent.y, firstChild.y) * zoom;
  } else if (parent.height * zoom <= size.height - padding * 2) {
    y = clamp(y, padding - parent.y * zoom, size.height - padding - (parent.y + parent.height) * zoom);
  }
  return { zoom, x, y };
}
/** Resizing preserves the world point the user was looking at, without refitting. */
export function resizeWorkTreeView(view, previousSize, nextSize) {
  return { ...view, x: view.x + (nextSize.width - previousSize.width) / 2, y: view.y + (nextSize.height - previousSize.height) / 2 };
}
