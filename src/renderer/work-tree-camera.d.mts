import type { WorkTreeLayout } from './work-tree-layout.mjs';
export type TreeViewport = { x: number; y: number; zoom: number };
export type ViewSize = { width: number; height: number };
export function fitWorkTree(layout: WorkTreeLayout, size: ViewSize): TreeViewport;
export function initialWorkTreeView(layout: WorkTreeLayout, size: ViewSize): TreeViewport;
export function revealWorkTreeBranch(layout: WorkTreeLayout, size: ViewSize, view: TreeViewport, nodeId: string, previousNode?: { x: number; y: number; width: number; height: number }): TreeViewport;
export function resizeWorkTreeView(view: TreeViewport, previousSize: ViewSize, nextSize: ViewSize): TreeViewport;
