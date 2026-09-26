const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const knownCount = value => Number.isSafeInteger(value) && value >= 0;
const plural = (value, noun) => `${value} ${noun}${value === 1 ? '' : 's'}`;
const LOCAL_COMPARISON = 'Based on tracking information already on this Mac. Summon does not fetch updates.';

/** Describe the working copy separately from its locally recorded tracking comparison. */
export function getPlaceStatus(repo, place) {
  if (place.missing || place.error || repo.error) {
    return {
      title: place.missing ? 'Folder unavailable' : 'Status could not be checked',
      detail: place.missing ? 'This checkout folder is missing. Its changes could not be checked.' : place.error || repo.error,
      tone: 'attention', syncTitle: 'Comparison unavailable',
      syncDetail: 'The folder must be readable before its current branch can be compared.',
    };
  }

  const counts = place.counts;
  const items = count(counts.items);
  const conflicts = count(counts.conflicted);
  const title = conflicts ? `${plural(conflicts, 'conflicting item')} need${conflicts === 1 ? 's' : ''} attention`
    : items ? `${place.filesTruncated ? 'At least ' : ''}${plural(items, 'uncommitted item')}`
    : place.filesTruncated ? 'Changes were only partly checked' : 'No uncommitted changes';
  let detail = items ? 'These edits are in this folder but are not included in a saved checkpoint (commit). Items include files and new folders.'
    : place.filesTruncated ? 'Summon could not list every changed item.'
    : place.head ? 'Git reported no changed or new items in this folder.' : 'This checkout does not have a first commit yet.';
  if (conflicts) detail = 'Resolve the conflicting edits before committing them.';
  if (place.filesTruncated) detail += ' The file list is incomplete; the changed-item total may be a lower bound.';
  if (place.detached) detail += ` This folder is not on a branch${place.head ? ` (commit ${place.head.slice(0, 7)})` : ''}.`;

  let tone = conflicts || place.filesTruncated ? 'attention' : items ? 'neutral' : 'good';
  let syncTitle;
  let syncDetail;
  const branch = repo.branches.find(item => item.name === place.branch && item.upstream === place.upstream);
  if (place.detached) {
    syncTitle = 'Not on a branch';
    syncDetail = 'This folder is checked out at a commit, so it has no branch tracking comparison.';
    if (tone === 'good') tone = 'neutral';
  } else if (!place.upstream) {
    syncTitle = 'No tracking branch configured';
    syncDetail = 'Git has no branch selected for this comparison. This does not tell us whether these commits exist elsewhere.';
    if (tone === 'good') tone = 'neutral';
  } else if (branch?.upstreamGone) {
    syncTitle = 'Tracking branch unavailable';
    syncDetail = `${place.upstream} is missing from the local snapshot. ${LOCAL_COMPARISON}`;
    tone = 'attention';
  } else if (!knownCount(place.ahead) || !knownCount(place.behind)) {
    syncTitle = 'Comparison unavailable';
    syncDetail = `Git could not provide a complete comparison with ${place.upstream}. ${LOCAL_COMPARISON}`;
    if (tone === 'good') tone = 'neutral';
  } else {
    const { ahead, behind } = place;
    syncTitle = ahead && behind ? `${ahead} ahead · ${behind} behind ${place.upstream}`
      : ahead ? `${plural(ahead, 'commit')} ahead of ${place.upstream}`
      : behind ? `${plural(behind, 'commit')} behind ${place.upstream}` : `Committed history matches ${place.upstream}`;
    const comparison = ahead && behind
      ? `The histories have diverged: this folder has ${plural(ahead, 'commit')} absent from the locally recorded ${place.upstream}, which has ${plural(behind, 'commit')} absent from this folder.`
      : ahead ? `This folder has ${plural(ahead, 'commit')} absent from the locally recorded ${place.upstream}.`
      : behind ? `The locally recorded ${place.upstream} has ${plural(behind, 'commit')} absent from this folder.`
      : `This folder and the locally recorded ${place.upstream} contain the same committed history. Uncommitted changes are separate.`;
    syncDetail = `${comparison} ${LOCAL_COMPARISON}`;
    if (behind) tone = 'attention';
    else if (ahead && tone === 'good') tone = 'neutral';
  }
  return { title, detail, tone, syncTitle, syncDetail };
}

/** Only include ancestry reachable from this folder's exact or uniquely abbreviated HEAD. */
export function getPlaceHistory(git, place) {
  let partial = Boolean(git.truncated || git.error || place.error || place.missing);
  if (!place.head) return { commits: [], missingHead: Boolean(place.error || place.missing), partial };
  const exact = git.commits.find(commit => commit.id === place.head);
  const matches = exact ? [exact] : git.commits.filter(commit => commit.id.startsWith(place.head));
  if (matches.length !== 1) return { commits: [], missingHead: true, partial: true };

  const byId = new Map(git.commits.map(commit => [commit.id, commit]));
  const included = new Set();
  const pending = [matches[0].id];
  while (pending.length) {
    const id = pending.pop();
    if (included.has(id)) continue;
    const commit = byId.get(id);
    if (!commit) { partial = true; continue; }
    included.add(id);
    pending.push(...commit.parents);
  }
  return { commits: git.commits.filter(commit => included.has(commit.id)), missingHead: false, partial };
}
