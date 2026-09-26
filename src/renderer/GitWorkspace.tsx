import React, { useState } from 'react';
import { Check, CircleAlert, GitBranch, GitCommitHorizontal } from 'lucide-react';
import type { VisualRepository, WifPlace, WifRepo } from './types';
import { getPlaceHistory, getPlaceStatus } from './git-workspace.mjs';
import { GitFolderMap } from './GitFolderMap';
import './git-workspace.css';

/* Intent: help the person coordinating agents understand what is still local.
   Hierarchy: the selected folder's uncommitted work leads; history follows.
   Domain: working folders, branches, changed files, commits, remote copies.
   Palette/depth: existing paper, ink, pencil gray, petrol and warning amber;
   quiet receipt rules separate present work from saved history. No new theme.
   Surfaces/type: existing raised paper and inset fields, 12/14/20px, weight
   before decoration. Spacing: 4px grid, 16px rows, 24px between sections.
   Signature: one folder's changes and committed history in reading order,
   instead of branch chips, an unexplained all-ref graph, and an idle inspector. */
type Props = {
  repo: WifRepo;
  repository: VisualRepository | null;
  historyLoading?: boolean;
  historyError?: string;
  placeId: string | null;
  commitId: string | null;
  onPlace: (place: WifPlace | null) => void;
  onAllProjects: () => void;
  onCommit: (id: string, place: WifPlace) => void;
  graph: React.ReactNode;
};
const stamp = (value: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Time unavailable';
const statuses = { modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', typechange: 'Type changed', untracked: 'New', conflicted: 'Conflict' };

export function GitWorkspace(props: Props) {
  const { repo, onPlace } = props;
  const place = repo.places.find(item => item.id === props.placeId);
  return <div className="git-workspace">
    {place && <nav className="git-breadcrumbs" aria-label="Git navigation"><button type="button" onClick={props.onAllProjects}>All projects</button><span>/</span>{place ? <button type="button" onClick={() => onPlace(null)}>{repo.name} · All working folders</button> : <span>{repo.name}</span>}{place && <><span>/</span><span>{place.label}</span></>}</nav>}
    {place && <div className="git-folder-picker">
      <label>Working folder<select aria-label="Git working folder" value={place?.id ?? ''} onChange={event => onPlace(repo.places.find(item => item.id === event.target.value) ?? null)}>
        <option value="">All working folders</option>
        {repo.places.map(item => <option key={item.id} value={item.id}>{item.label} · {item.detached ? 'not on a branch' : item.branch || 'branch unavailable'}</option>)}
      </select></label>
      <p>{place ? 'Choose All working folders to return to the map.' : 'Pan and zoom to explore. Select a folder for its changes and history.'}</p>
    </div>}
    {!place ? <GitFolderMap repos={[repo]} viewKey={repo.id} onFolder={(_repo, selected) => onPlace(selected)} /> : <FolderGit key={`${repo.id}:${place.id}`} {...props} place={place} />}
  </div>;
}

function FolderGit({ repo, repository, historyLoading, historyError, place, commitId, onCommit, graph }: Props & { place: WifPlace }) {
  const [allFiles, setAllFiles] = useState(false);
  const [allCommits, setAllCommits] = useState(false);
  const [filter, setFilter] = useState('');
  const status = getPlaceStatus(repo, place);
  const history = repository ? getPlaceHistory(repository.git, place) : null;
  const unavailable = Boolean(repo.error || place.error || place.missing);
  const files = (place.files ?? []).filter(file => file.path.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const shownFiles = allFiles || filter ? files : files.slice(0, 6);
  const shownCommits = history ? allCommits ? history.commits : history.commits.slice(0, 8) : [];
  const selectedCommit = repository?.git.commits.find(commit => commit.id === commitId);
  const selectedRefs = repository?.git.refs.filter(ref => ref.commitId === commitId) ?? [];
  const branchName = place.detached ? 'Not on a branch' : place.branch || 'Branch unavailable';

  return <>
    <section className={`git-status git-status-${status.tone}`} aria-label="Current Git status">
      <div className="git-status-heading">{status.tone === 'attention' ? <CircleAlert size={24} /> : status.tone === 'good' ? <Check size={24} /> : <GitCommitHorizontal size={24} />}<div><h4>{status.title}</h4><p>{status.detail}</p></div></div>
      <div className="git-location"><span><GitBranch size={14} /><strong>{branchName}</strong>{place.detached && place.head && <code>{place.head.slice(0, 7)}</code>}</span><span title={place.displayPath}>{place.displayPath}</span></div>
      <div className="git-sync"><strong>{status.syncTitle}</strong><p>{status.syncDetail}</p></div>
    </section>

    {!unavailable && <section className="git-section" aria-labelledby="git-changes-title">
      <div className="git-section-heading"><div><h4 id="git-changes-title">Uncommitted changes</h4><p>These changes are in your folder, but aren’t part of a commit yet.</p></div>{Boolean(place.files?.length) && <input aria-label="Filter changed files" placeholder="Find a changed file…" value={filter} onChange={event => setFilter(event.target.value)} />}</div>
      {place.counts.items === 0 && !place.filesTruncated ? <p className="git-empty">No uncommitted changes in this folder.</p> : !place.files?.length ? <p className="git-empty">The file list is unavailable in this snapshot. Refresh to check again.</p> : <>
        <ul className="git-files" aria-label="Changed files">{shownFiles.map(file => <li key={file.path}><span className={`git-file-state${file.status === 'conflicted' ? ' conflict' : ''}`}>{statuses[file.status]}</span><span className="git-file-path">{file.path}{file.isDir && <small>Folder{file.fileCount !== null ? ` · ${file.fileCount} files` : ''}</small>}</span><span className="git-file-stage">{file.staged ? 'Staged' : ''}</span></li>)}</ul>
        {filter && files.length === 0 && <p className="git-empty">No changed files match “{filter}”.</p>}
        {!filter && files.length > 6 && <button type="button" className="vw-button git-more" onClick={() => setAllFiles(value => !value)}>{allFiles ? 'Show fewer files' : `Show ${files.length} available changed items`}</button>}
        {place.counts.staged > 0 && <p className="git-note">Staged means selected for the next commit. A staged file can also have newer edits.</p>}
      </>}
      {place.filesTruncated && <p className="git-note">This is a partial file list. There may be more changes than the count shown.</p>}
    </section>}

    <section className="git-section" aria-labelledby="git-history-title">
      <div className="git-section-heading"><div><h4 id="git-history-title">Committed history</h4><p>{place.detached ? 'Commits leading to this folder’s current checkout.' : <>Commits leading to <strong>{place.branch || 'this folder'}</strong>, newest first.</>} A commit is a saved checkpoint.</p></div></div>
      {historyError && <p className="git-warning" role="status">History could not be refreshed: {historyError}{repository && ' Showing the last available history.'}</p>}
      {repository?.git.error && <p className="git-warning" role="status">History could not be fully read: {repository.git.error}</p>}
      {unavailable ? <p className="git-empty">History for this folder is unavailable until its status can be checked.</p> : !history ? <p className="git-empty" role="status">{historyError ? 'History is unavailable. Refresh to try again.' : historyLoading ? 'Loading this folder’s history…' : 'Preparing this folder’s history…'}</p> : history.missingHead ? <p className="git-empty">This folder’s current commit isn’t in the available history snapshot. The full graph below may show other branches.</p> : !history.commits.length ? <p className="git-empty">No commits recorded for this folder yet.</p> : <ol className="git-history" aria-label="Selected folder commit history">{shownCommits.map((commit, index) => <li key={commit.id}><button type="button" aria-pressed={commit.id === commitId} onClick={() => onCommit(commit.id, place)}><GitCommitHorizontal size={18} aria-hidden="true" /><span><strong>{commit.subject || 'Untitled commit'}</strong><small>{stamp(commit.at)}{commit.parents.length > 1 && ' · Merge commit'}{index === 0 && ' · Current checkpoint'}</small></span><code>{commit.id.slice(0, 7)}</code></button></li>)}</ol>}
      {!unavailable && history && !history.missingHead && history.commits.length > 8 && <button type="button" className="vw-button git-more" onClick={() => setAllCommits(value => !value)}>{allCommits ? 'Show fewer commits' : `Show all ${history.commits.length} available commits`}</button>}
      {history?.partial && <p className="git-note">Partial local history. Some commits or references are outside this snapshot.</p>}
      {selectedCommit && <div className="git-commit-detail" aria-label="Selected commit details"><span className="vw-eyebrow">Selected commit</span><h4>{selectedCommit.subject || 'Untitled commit'}</h4><p>{stamp(selectedCommit.at)} · <code>{selectedCommit.id.slice(0, 12)}</code></p><p>{selectedCommit.parents.length > 1 ? `Merge of ${selectedCommit.parents.length} parent commits.` : selectedCommit.parents.length ? 'Continues from one earlier commit.' : 'The start of this recorded history.'}</p>{selectedRefs.length > 0 && <p>References here: {selectedRefs.map(ref => ref.kind === 'head' ? 'HEAD (main folder checkout)' : `${ref.name} (${ref.kind === 'remote' ? 'cached remote' : ref.kind})`).join(', ')}</p>}</div>}
    </section>

    <details className="git-full-graph"><summary><GitBranch size={17} /><span>Full branch graph<small>All branches together · advanced view</small></span></summary><div><p className="git-note">Each dot is a commit. Lines connect it to earlier commits; splits and joins show how histories connect. Labels mark branch tips. This view includes local branches, tags, and cached remote references. Commits from detached working folders may be absent.</p>{repository ? graph : <p className="git-empty" role="status">{historyError ? 'The branch graph is unavailable. Refresh to try again.' : historyLoading ? 'Loading the branch graph…' : 'Preparing the branch graph…'}</p>}</div></details>
    <p className="git-note git-read-only">Remote comparisons use information already on this Mac. Summon does not fetch updates.{repo.lastFetchedAt ? ` Last recorded fetch: ${stamp(repo.lastFetchedAt)}.` : ' No fetch time is recorded.'}</p>
  </>;
}
