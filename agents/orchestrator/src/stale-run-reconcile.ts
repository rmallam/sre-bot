import { log } from '../../../shared/src/http.js';
import type { StoredRun } from '../../../shared/src/run-persistence.js';
import type { ActiveDuplicateRun } from './run-dedupe.js';

const AGENT = 'orchestrator-stale-reconcile';
const STALE_RUNNING_MS = parseInt(process.env['STALE_RUNNING_MS'] ?? String(2 * 60 * 60 * 1000), 10);
const HIL_URL = process.env['HIL_URL'] ?? 'http://hil-agent:8080';

interface HilApprovalRow {
  incidentId?: string;
  runId?: string;
  status?: string;
  expiresAt?: string;
}

/** True when HIL still has a non-expired PENDING approval for this run. */
export async function hasPendingHilApproval(
  runId: string,
  incidentId: string
): Promise<boolean> {
  try {
    const res = await fetch(`${HIL_URL}/api/approvals`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return true;
    const data = (await res.json()) as { approvals?: HilApprovalRow[] };
    const now = Date.now();
    return (data.approvals ?? []).some((row) => {
      if (row.status !== 'PENDING') return false;
      if (row.expiresAt && new Date(row.expiresAt).getTime() <= now) return false;
      return row.runId === runId || row.incidentId === incidentId;
    });
  } catch (err) {
    log('warn', AGENT, 'HIL approvals check failed — treating as pending', {
      runId,
      incidentId,
      error: String(err),
    });
    return true;
  }
}

/**
 * awaiting_human in Postgres with no live HIL approval (e.g. after hil-agent restart)
 * blocks all new runs — cancel the orphan so the operator can retry.
 */
export async function reconcileStaleAwaitingHuman(
  duplicate: ActiveDuplicateRun,
  cancelRun: (runId: string) => Promise<void>
): Promise<'still_active' | 'cancelled_stale'> {
  if (duplicate.status !== 'awaiting_human') return 'still_active';
  const pending = await hasPendingHilApproval(duplicate.runId, duplicate.incidentId);
  if (pending) return 'still_active';
  await cancelRun(duplicate.runId);
  log('info', AGENT, 'Auto-cancelled stale awaiting_human run (no HIL approval)', {
    runId: duplicate.runId,
    incidentId: duplicate.incidentId,
  });
  return 'cancelled_stale';
}

function isStaleRunningRun(entry: StoredRun): boolean {
  if (entry.status !== 'running') return false;
  const transcriptLen = entry.transcript?.length ?? 0;
  const updatedMs = new Date(entry.updatedAt ?? entry.startedAt).getTime();
  const startedMs = new Date(entry.startedAt).getTime();
  const idleMs = Date.now() - updatedMs;
  const ageMs = Date.now() - startedMs;
  if (transcriptLen === 0 && idleMs > STALE_RUNNING_MS) return true;
  if (transcriptLen === 0 && ageMs > 24 * 60 * 60 * 1000) return true;
  return false;
}

/** Cancel zombie `running` rows that block dedupe (orchestrator crash, lost worker, etc.). */
export async function reconcileStaleActiveRun(
  duplicate: ActiveDuplicateRun,
  getRunEntry: (runId: string) => Promise<StoredRun | undefined>,
  cancelRun: (runId: string) => Promise<void>
): Promise<'still_active' | 'cancelled_stale'> {
  if (duplicate.status === 'awaiting_human') {
    return reconcileStaleAwaitingHuman(duplicate, cancelRun);
  }
  if (duplicate.status !== 'running') return 'still_active';

  const entry = await getRunEntry(duplicate.runId);
  if (!entry) {
    await cancelRun(duplicate.runId).catch(() => undefined);
    return 'cancelled_stale';
  }
  if (!isStaleRunningRun(entry)) return 'still_active';

  await cancelRun(duplicate.runId);
  log('info', AGENT, 'Auto-cancelled stale running run (no progress)', {
    runId: duplicate.runId,
    incidentId: duplicate.incidentId,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    transcriptLen: entry.transcript?.length ?? 0,
  });
  return 'cancelled_stale';
}
