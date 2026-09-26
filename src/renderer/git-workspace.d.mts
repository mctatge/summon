import type { VisualCommit, VisualRepository, WifPlace, WifRepo } from './types';

export type GitPlaceStatus = {
  title: string;
  detail: string;
  tone: 'neutral' | 'attention' | 'good';
  syncTitle: string;
  syncDetail: string;
};
export type GitPlaceHistory = {
  commits: VisualCommit[];
  /** HEAD could not be resolved, or the folder failed before HEAD could be read. */
  missingHead: boolean;
  /** The graph, folder read, or reachable ancestry is incomplete. */
  partial: boolean;
};
export function getPlaceStatus(repo: WifRepo, place: WifPlace): GitPlaceStatus;
export function getPlaceHistory(git: VisualRepository['git'], place: WifPlace): GitPlaceHistory;
