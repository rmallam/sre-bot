/**
 * PLAT-6 — Scheduled proactive health checks (operator-style).
 * Polls investigator cluster-health and starts diagnose runs for unhealthy workloads.
 */

import { v4 as uuidv4 } from 'uuid';
import { log, postWithRetry } from '../../../shared/src/http.js';
import type { ClusterHealthSnapshot } from '../../../shared/src/cluster-health.js';
import type { StartRunRequest } from '../../../shared/src/types.js';

const AGENT = 'watcher-health-check';
const INVESTIGATOR_URL = process.env['INVESTIGATOR_URL'] ?? 'http://investigator-agent:8080';
const ORCHESTRATOR_URL = process.env['ORCHESTRATOR_URL'] ?? 'http://orchestrator-agent:8080';
const USE_ORCHESTRATOR =
  (process.env['USE_ORCHESTRATOR'] ?? 'true').toLowerCase() === 'true';
const ENABLED = (process.env['HEALTH_CHECK_ENABLED'] ?? 'true').toLowerCase() === 'true';
const INTERVAL_MS = parseInt(process.env['HEALTH_CHECK_INTERVAL_MS'] ?? String(15 * 60 * 1000), 10);
const COOLDOWN_MS = parseInt(
  process.env['HEALTH_CHECK_COOLDOWN_MS'] ?? String(30 * 60 * 1000),
  10
);

/** Map<"namespace/resourceName", lastFiredMs> */
const cooldownMap = new Map<string, number>();

function cooldownKey(namespace: string, resourceName: string): string {
  return `${namespace}/${resourceName}`.toLowerCase();
}

function shouldThrottle(namespace: string, resourceName: string): boolean {
  const key = cooldownKey(namespace, resourceName);
  const last = cooldownMap.get(key);
  if (!last) return false;
  return Date.now() - last < COOLDOWN_MS;
}

function markFired(namespace: string, resourceName: string): void {
  cooldownMap.set(cooldownKey(namespace, resourceName), Date.now());
}

async function fetchClusterHealth(): Promise<ClusterHealthSnapshot | null> {
  try {
    const res = await fetch(`${INVESTIGATOR_URL}/cluster-health`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as ClusterHealthSnapshot;
  } catch (err) {
    log('warn', AGENT, 'Cluster health fetch failed', { error: String(err) });
    return null;
  }
}

async function startHealthCheckRun(payload: StartRunRequest): Promise<void> {
  const url = USE_ORCHESTRATOR
    ? `${ORCHESTRATOR_URL}/runs`
    : `${INVESTIGATOR_URL}/investigate`;
  await postWithRetry({
    url,
    payload,
    incidentId: payload.incidentId,
    callerAgent: AGENT,
  });
}

async function runHealthCheckSweep(): Promise<number> {
  const snapshot = await fetchClusterHealth();
  if (!snapshot?.reachable) return 0;

  let fired = 0;

  for (const dep of snapshot.deployments.items ?? []) {
    if (!dep.namespace || !dep.name) continue;
    if (shouldThrottle(dep.namespace, dep.name)) continue;

    const incidentId = uuidv4();
    const payload: StartRunRequest = {
      incidentId,
      triggeredBy: 'watcher',
      triggeredAt: new Date().toISOString(),
      namespace: dep.namespace,
      resourceKind: 'Deployment',
      resourceName: dep.name,
      mode: 'diagnose',
      eventReason: 'ScheduledHealthCheck',
      eventMessage: `Proactive check: deployment ${dep.ready}/${dep.desired} ready`,
      investigateScope: 'workload',
    };

    try {
      await startHealthCheckRun(payload);
      markFired(dep.namespace, dep.name);
      fired += 1;
      log('info', AGENT, 'Started proactive health check run', {
        incidentId,
        namespace: dep.namespace,
        resourceName: dep.name,
      });
    } catch (err) {
      log('warn', AGENT, 'Proactive run failed', {
        namespace: dep.namespace,
        resourceName: dep.name,
        error: String(err),
      });
    }
  }

  for (const issue of snapshot.pods.issues ?? []) {
    if (!issue.namespace || !issue.name) continue;
    if (shouldThrottle(issue.namespace, issue.name)) continue;

    const incidentId = uuidv4();
    const payload: StartRunRequest = {
      incidentId,
      triggeredBy: 'watcher',
      triggeredAt: new Date().toISOString(),
      namespace: issue.namespace,
      resourceKind: 'Pod',
      resourceName: issue.name,
      mode: 'diagnose',
      podName: issue.name,
      eventReason: 'ScheduledHealthCheck',
      eventMessage: `Proactive check: pod ${issue.phase} (${issue.reason})`,
      investigateScope: 'workload',
    };

    try {
      await startHealthCheckRun(payload);
      markFired(issue.namespace, issue.name);
      fired += 1;
    } catch (err) {
      log('warn', AGENT, 'Proactive pod run failed', {
        namespace: issue.namespace,
        resourceName: issue.name,
        error: String(err),
      });
    }
  }

  if (fired > 0) {
    log('info', AGENT, 'Proactive health sweep completed', { fired });
  }
  return fired;
}

export function startHealthCheckScheduler(): void {
  if (!ENABLED) {
    log('info', AGENT, 'Proactive health checks disabled (HEALTH_CHECK_ENABLED=false)');
    return;
  }

  log('info', AGENT, 'Starting proactive health scheduler', {
    intervalMs: INTERVAL_MS,
    cooldownMs: COOLDOWN_MS,
  });

  void runHealthCheckSweep().catch((err) => {
    log('warn', AGENT, 'Initial health sweep failed', { error: String(err) });
  });

  setInterval(() => {
    void runHealthCheckSweep().catch((err) => {
      log('warn', AGENT, 'Health sweep failed', { error: String(err) });
    });
  }, INTERVAL_MS);
}
