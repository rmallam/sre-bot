/**
 * Namespace throttled run queue — persist requests when circuit breaker is open.
 */

import { v4 as uuidv4 } from 'uuid';
import type { StartRunRequest } from '../../../shared/src/types.js';
import type { StoredRun } from '../../../shared/src/run-persistence.js';
import {
  namespaceRunLimitExceeded,
  resolveNamespaceRunLimit,
} from '../../../shared/src/namespace-run-limit.js';
import { log } from '../../../shared/src/http.js';
import {
  countActiveRunsByNamespace,
  initRun,
  listRuns,
} from './run-store.js';
import { getRunStore } from './stores/index.js';

const AGENT = 'orchestrator-agent';

export async function enqueueThrottledRun(request: StartRunRequest): Promise<string> {
  const runId = uuidv4();
  await initRun(runId, request.incidentId, { mode: request.mode, request }, {
    status: 'pending_throttled',
  });
  log('info', AGENT, 'Run queued — namespace limit reached', {
    runId,
    incidentId: request.incidentId,
    namespace: request.namespace,
    resourceName: request.resourceName,
  });
  return runId;
}

export async function listPendingThrottledRuns(limit = 50): Promise<StoredRun[]> {
  const store = await getRunStore();
  if (store.listPendingThrottledRuns) {
    return store.listPendingThrottledRuns(limit);
  }
  const runs = await listRuns({ limit: 500 });
  return runs
    .filter((r) => r.status === 'pending_throttled')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .slice(0, limit);
}

export async function claimThrottledRun(runId: string): Promise<boolean> {
  const store = await getRunStore();
  if (!store.claimThrottledRun) {
    log('warn', AGENT, 'Run store lacks atomic claimThrottledRun', { runId });
    return false;
  }
  return store.claimThrottledRun(runId);
}

export async function drainThrottledRuns(): Promise<number> {
  const nsLimit = resolveNamespaceRunLimit();
  if (!nsLimit.enabled) return 0;

  const pending = await listPendingThrottledRuns(100);
  let started = 0;

  for (const run of pending) {
    const request = run.metadata?.request as StartRunRequest | undefined;
    if (!request?.namespace?.trim()) continue;

    const active = await countActiveRunsByNamespace(request.namespace);
    if (namespaceRunLimitExceeded(active, nsLimit)) continue;

    const claimed = await claimThrottledRun(run.runId);
    if (!claimed) continue;

    started++;
    log('info', AGENT, 'Dequeuing throttled run', {
      runId: run.runId,
      incidentId: request.incidentId,
      namespace: request.namespace,
    });

    const { startQueuedRun } = await import('./graph.js');
    void startQueuedRun(run.runId, request)
      .then(({ runId, status }) => {
        log('info', AGENT, 'Queued run finished', { runId, status, incidentId: request.incidentId });
        return drainThrottledRuns();
      })
      .catch(async (err) => {
        const error = err instanceof Error ? err.message : String(err);
        log('error', AGENT, 'Queued run failed', {
          runId: run.runId,
          incidentId: request.incidentId,
          error,
        });
        await drainThrottledRuns();
      });
  }

  return started;
}

export function startThrottledQueueDrainer(): void {
  const intervalMs = parseInt(process.env['NAMESPACE_QUEUE_DRAIN_MS'] ?? '15000', 10);
  if (intervalMs <= 0) return;
  setInterval(() => {
    void drainThrottledRuns().catch((err) => {
      log('warn', AGENT, 'Throttled queue drain failed', { error: String(err) });
    });
  }, intervalMs);
}
