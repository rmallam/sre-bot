/**
 * Detect orphaned / zombie runs and format console labels for in-progress work.
 */

import type { RunStatus } from './types.js';

/** Idle time before a running run with no transcript is treated as orphaned. */
export const STALE_RUNNING_MS = parseInt(
  process.env['STALE_RUNNING_MS'] ?? String(2 * 60 * 60 * 1000),
  10
);

/** Idle time before a running run with partial progress is treated as hung. */
export const STALE_RUNNING_PROGRESS_MS = parseInt(
  process.env['STALE_RUNNING_PROGRESS_MS'] ?? String(4 * 60 * 60 * 1000),
  10
);

/** Absolute max age for any still-running row. */
export const STALE_RUNNING_MAX_AGE_MS = parseInt(
  process.env['STALE_RUNNING_MAX_AGE_MS'] ?? String(48 * 60 * 60 * 1000),
  10
);

export interface StaleRunProbe {
  status: RunStatus | string;
  transcript?: unknown[];
  updatedAt?: string;
  startedAt?: string;
}

export function isStaleRunningRun(entry: StaleRunProbe): boolean {
  if (entry.status !== 'running') return false;

  const transcriptLen = entry.transcript?.length ?? 0;
  const updatedMs = new Date(entry.updatedAt ?? entry.startedAt ?? 0).getTime();
  const startedMs = new Date(entry.startedAt ?? 0).getTime();
  if (Number.isNaN(updatedMs) || Number.isNaN(startedMs)) return false;

  const idleMs = Date.now() - updatedMs;
  const ageMs = Date.now() - startedMs;

  if (transcriptLen === 0 && idleMs > STALE_RUNNING_MS) return true;
  if (transcriptLen === 0 && ageMs > 24 * 60 * 60 * 1000) return true;
  if (transcriptLen > 0 && idleMs > STALE_RUNNING_PROGRESS_MS) return true;
  if (ageMs > STALE_RUNNING_MAX_AGE_MS) return true;

  return false;
}

export function formatSuggestedActionLabel(
  suggestedAction: string | undefined,
  ctx: { status?: string; toolCount?: number; isStale?: boolean }
): string {
  if (ctx.isStale && ctx.status === 'running') {
    return 'Orphaned — no plan recorded';
  }
  if (suggestedAction === 'noop' && ctx.status === 'succeeded') {
    return 'No action';
  }
  if (suggestedAction && suggestedAction !== 'unknown') {
    return suggestedAction.replace(/_/g, ' ');
  }
  if (ctx.status === 'running' && (ctx.toolCount ?? 0) === 0) {
    return 'No plan yet';
  }
  if (suggestedAction === 'unknown') return 'Not determined';
  return '—';
}
