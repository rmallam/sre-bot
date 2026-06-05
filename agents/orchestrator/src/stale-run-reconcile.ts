import { log } from '../../../shared/src/http.js';
import type { ActiveDuplicateRun } from './run-dedupe.js';

const AGENT = 'orchestrator-stale-reconcile';
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
