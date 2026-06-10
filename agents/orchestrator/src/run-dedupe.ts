import type { StoredRun } from '../../../shared/src/run-persistence.js';
import type { RunStatus, StartRunRequest } from '../../../shared/src/types.js';

const ACTIVE_STATUSES = new Set<RunStatus>(['running', 'awaiting_human', 'pending_throttled']);

export interface ActiveDuplicateRun {
  runId: string;
  incidentId: string;
  status: RunStatus;
}

function norm(text: string | undefined): string | undefined {
  return text?.trim().toLowerCase();
}

function requestsMatch(a: StartRunRequest, b: StartRunRequest): boolean {
  const modeA = norm(a.mode);
  const modeB = norm(b.mode);
  if (modeA !== modeB) return false;

  const repoA = norm(a.githubRepo);
  const repoB = norm(b.githubRepo);
  if (repoA || repoB) {
    return !!repoA && !!repoB && repoA === repoB;
  }

  return norm(a.namespace) === norm(b.namespace) && norm(a.resourceName) === norm(b.resourceName);
}

function parseStoredRequest(run: StoredRun): StartRunRequest | undefined {
  const req = run.metadata?.request;
  if (!req || typeof req !== 'object') return undefined;
  return req as StartRunRequest;
}

export function findActiveDuplicateRun(
  incoming: StartRunRequest,
  runs: StoredRun[]
): ActiveDuplicateRun | undefined {
  for (const run of runs) {
    if (!ACTIVE_STATUSES.has(run.status)) continue;
    const existing = parseStoredRequest(run);
    if (!existing) continue;
    if (!requestsMatch(existing, incoming)) continue;
    return {
      runId: run.runId,
      incidentId: run.incidentId,
      status: run.status,
    };
  }
  return undefined;
}
