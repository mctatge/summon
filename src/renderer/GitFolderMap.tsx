import React, { useMemo, useState } from 'react';
import { ArrowRight, Folder, GitBranch } from 'lucide-react';
import type { WifPlace, WifRepo } from './types';
import { GitMapViewport } from './GitMapViewport';
import { layoutGitFolders } from './git-folder-map.mjs';
import { getPlaceStatus } from './git-workspace.mjs';
import './git-folder-map.css';

/* Intent: let the person coordinating agents move from the whole workstation to
   one checkout, using the Work tree's spatial controls. Project -> folder is the
   hierarchy; edges mean membership, never invented commit ancestry. Existing
   paper/ink/petrol tokens, restrained borders, 4px spacing and 12/14/16px type
   keep status readable at normal scale. Zoom and focus change the scope of
   attention; a chosen project remains a hard data boundary. */
type Props = {
  repos: WifRepo[];
  viewKey: string;
  onFolder: (repo: WifRepo, place: WifPlace) => void;
  onProject?: (repo: WifRepo) => void;
};
export function GitFolderMap({ repos, viewKey, onFolder, onProject }: Props) {
  const [query, setQuery] = useState('');
  const layout = useMemo(() => layoutGitFolders(repos, query), [repos, query]);
  const byId = new Map(layout.nodes.map(node => [node.id, node]));
  const byRepo = new Map(repos.map(repo => [repo.id, repo]));
  return <section className="git-folder-map" aria-label="Working folders overview">
    <div className="git-map-heading"><div><h4>{repos.length === 1 ? 'All working folders' : 'Projects & working folders'}</h4><p>{layout.projectCount} {layout.projectCount === 1 ? 'project' : 'projects'} · {layout.folderCount} working {layout.folderCount === 1 ? 'folder' : 'folders'}{query && ' matching your search'}</p></div><input aria-label="Find a Git project or folder" placeholder="Find a project, branch, or folder…" value={query} onChange={event => setQuery(event.target.value)} /></div>
    {!repos.length ? <p className="git-empty">No Git projects were found in your workspaces.</p> : !layout.nodes.length ? <p className="git-empty">No projects or working folders match “{query}”.</p> : <GitMapViewport width={layout.width} height={layout.height} viewKey={`${viewKey}:${query}`}>
      <svg className="git-map-edges" width={layout.width} height={layout.height} aria-hidden="true">{layout.edges.map(edge => {
        const a = byId.get(edge.source)!, b = byId.get(edge.target)!;
        const x = a.x + a.width, y = a.y + a.height / 2, endY = b.y + b.height / 2;
        return <path key={edge.id} d={`M${x} ${y} C${x + 40} ${y},${b.x - 40} ${endY},${b.x} ${endY}`} />;
      })}</svg>
      {layout.nodes.map(node => {
        const repo = byRepo.get(node.repoId)!;
        const style = { left: node.x, top: node.y, width: node.width, height: node.height };
        if (node.kind === 'project') {
          const content = <><span className="git-map-kicker"><Folder size={14} />Project</span><strong>{repo.name}</strong><small>{repo.error ? 'Status unavailable' : `${repo.places.length} working ${repo.places.length === 1 ? 'folder' : 'folders'}`}</small></>;
          return onProject ? <button key={node.id} type="button" className="git-map-project" style={style} aria-label={`Focus Git project ${repo.name}`} onClick={() => onProject(repo)}>{content}</button> : <div key={node.id} className="git-map-project" style={style}>{content}</div>;
        }
        const place = repo.places.find(item => item.id === node.placeId)!;
        const status = getPlaceStatus(repo, place);
        return <button key={node.id} type="button" className={`git-map-folder git-map-folder-${status.tone}`} style={style} aria-label={`Open ${repo.name}: ${place.label}, ${status.title}`} title={`${place.displayPath}\n${status.detail}\n${status.syncDetail}`} onClick={() => onFolder(repo, place)}>
          <span className="git-map-kicker"><Folder size={14} />{place.kind === 'main' ? 'Main folder' : 'Worktree'}<ArrowRight size={14} /></span>
          <strong><GitBranch size={14} /><span>{place.detached ? 'Not on a branch' : place.branch || place.label}</span></strong>
          <span className="git-map-folder-status">{status.title}</span>
          <small className="git-map-sync">{status.syncTitle}</small>
          <small className="git-map-folder-label">{place.label}</small>
        </button>;
      })}
    </GitMapViewport>}
    <p className="git-note">Lines connect projects to their working folders. Click a folder for changes and commit history. Remote comparisons use the information already on this Mac.</p>
  </section>;
}
