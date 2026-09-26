import type { WifRepo } from './types';

export type GitFolderMapNode = {
  id: string;
  kind: 'project' | 'folder';
  repoId: string;
  placeId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type GitFolderMapEdge = { id: string; source: string; target: string };
export type GitFolderMapLayout = {
  nodes: GitFolderMapNode[];
  edges: GitFolderMapEdge[];
  width: number;
  height: number;
  projectCount: number;
  folderCount: number;
};
export function layoutGitFolders(repos: WifRepo[], query?: string): GitFolderMapLayout;
