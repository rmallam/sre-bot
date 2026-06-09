/**
 * Lightweight cluster health snapshot for the console dashboard (cached).
 */

import * as k8s from '@kubernetes/client-node';
import { existsSync } from 'node:fs';
import {
  classifyPodIssue,
  deriveClusterStatus,
  deriveDisplayStatus,
  buildStatusSummary,
  DEFAULT_EVENT_WINDOW_MINUTES,
  isRecentEvent,
  eventTimestampMs,
  type ClusterHealthDeployment,
  type ClusterHealthEvent,
  type ClusterHealthNode,
  type ClusterHealthPodIssue,
  type ClusterHealthSnapshot,
} from '../../../shared/src/cluster-health.js';
import { log } from '../../../shared/src/http.js';

const AGENT = 'investigator';
const CACHE_TTL_MS = 30_000;
const MAX_ISSUES = 8;
const MAX_DEPLOYMENTS = 6;
const MAX_EVENTS = 6;
const EVENT_WINDOW_MINUTES = parseInt(
  process.env.CLUSTER_HEALTH_EVENT_WINDOW_MINUTES ?? String(DEFAULT_EVENT_WINDOW_MINUTES),
  10
);

function eventLastTime(e: k8s.CoreV1Event): string {
  const ts =
    e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp ?? undefined;
  if (!ts) return '';
  if (ts instanceof Date) return ts.toISOString();
  return String(ts);
}

function buildKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token')) {
    try {
      kc.loadFromCluster();
      return kc;
    } catch {
      /* fall through */
    }
  }
  kc.loadFromDefault();
  return kc;
}

const kc = buildKubeConfig();
const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
const appsV1Api = kc.makeApiClient(k8s.AppsV1Api);

function formatK8sApiError(err: unknown): string {
  const body = (err as { body?: { message?: string } })?.body?.message;
  if (body) return body;
  const msg = String(err);
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connect EHOST/i.test(msg)) {
    return 'Cannot connect to the Kubernetes API — the cluster may be stopped.';
  }
  return msg.slice(0, 240);
}

async function listWithError<T>(
  label: string,
  fn: () => Promise<T>
): Promise<{ value: T; error?: string }> {
  try {
    return { value: await fn() };
  } catch (err) {
    const error = formatK8sApiError(err);
    log('warn', AGENT, `Kubernetes ${label} failed`, { error });
    return { value: { body: { items: [] } } as T, error };
  }
}

let cached: { expiresAt: number; snapshot: ClusterHealthSnapshot } | null = null;

export async function gatherClusterHealthSnapshot(): Promise<ClusterHealthSnapshot> {
  const checkedAt = new Date().toISOString();

  const [nodesRes, podsRes, depsRes, eventsRes] = await Promise.all([
    listWithError('listNode', () => coreV1Api.listNode()),
    listWithError('listPodForAllNamespaces', () => coreV1Api.listPodForAllNamespaces()),
    listWithError('listDeploymentForAllNamespaces', () => appsV1Api.listDeploymentForAllNamespaces()),
    listWithError('listEventForAllNamespaces', () => coreV1Api.listEventForAllNamespaces()),
  ]);

  const apiErrors = [nodesRes.error, podsRes.error, depsRes.error, eventsRes.error].filter(
    Boolean
  ) as string[];
  const nodesRaw = nodesRes.value.body.items ?? [];
  const reachable = apiErrors.length === 0 && nodesRaw.length > 0;

  if (!reachable) {
    const error =
      apiErrors[0] ??
      'No nodes returned — the cluster appears stopped or the API is not serving data.';
    return {
      reachable: false,
      checkedAt,
      error,
      status: 'unreachable',
      displayStatus: 'unreachable',
      statusSummary: buildStatusSummary('unreachable', { error }),
      nodes: { total: 0, ready: 0, notReady: 0, items: [] },
      pods: {
        total: 0,
        running: 0,
        pending: 0,
        failed: 0,
        problematic: 0,
        issues: [],
      },
      deployments: { total: 0, unhealthy: 0, items: [] },
      warningEvents: [],
      eventWindowMinutes: EVENT_WINDOW_MINUTES,
    };
  }

  const nodeItems: ClusterHealthNode[] = nodesRaw.map((n) => {
    const readyCond = (n.status?.conditions ?? []).find((c) => c.type === 'Ready');
    return {
      name: n.metadata?.name ?? '?',
      ready: readyCond?.status === 'True',
    };
  });
  const notReadyNodes = nodeItems.filter((n) => !n.ready).length;

  const podsRaw = podsRes.value.body.items ?? [];
  let running = 0;
  let pending = 0;
  let failed = 0;
  const issues: ClusterHealthPodIssue[] = [];

  for (const p of podsRaw) {
    const phase = p.status?.phase ?? 'Unknown';
    if (phase === 'Running') running += 1;
    else if (phase === 'Pending') pending += 1;
    else if (phase === 'Failed') failed += 1;

    const issue = classifyPodIssue({
      namespace: p.metadata?.namespace ?? '',
      name: p.metadata?.name ?? '',
      phase,
      containerStatuses: p.status?.containerStatuses,
    });
    if (issue && issues.length < MAX_ISSUES) {
      issues.push(issue);
    }
  }

  const deploymentsRaw = depsRes.value.body.items ?? [];
  const unhealthyDeployments: ClusterHealthDeployment[] = deploymentsRaw
    .map((d) => ({
      namespace: d.metadata?.namespace ?? 'default',
      name: d.metadata?.name ?? '',
      desired: d.status?.replicas ?? 0,
      ready: d.status?.readyReplicas ?? 0,
    }))
    .filter((d) => d.name && d.desired > 0 && d.ready < d.desired)
    .sort((a, b) => b.desired - b.ready - (a.desired - a.ready))
    .slice(0, MAX_DEPLOYMENTS);

  const nowMs = Date.parse(checkedAt);
  const warningEvents: ClusterHealthEvent[] = (eventsRes.value.body.items ?? [])
    .filter((e) => e.type === 'Warning')
    .map((e) => ({
      namespace: e.metadata?.namespace ?? '',
      reason: e.reason ?? '',
      object: e.involvedObject
        ? `${e.involvedObject.kind}/${e.involvedObject.name}`
        : '',
      message: (e.message ?? '').slice(0, 120),
      lastTime: eventLastTime(e),
    }))
    .filter((e) => e.lastTime && isRecentEvent(e.lastTime, nowMs, EVENT_WINDOW_MINUTES))
    .sort((a, b) => (eventTimestampMs(b.lastTime) ?? 0) - (eventTimestampMs(a.lastTime) ?? 0))
    .slice(0, MAX_EVENTS);

  const statusInput = {
    reachable: true,
    notReadyNodes,
    unhealthyDeployments: unhealthyDeployments.length,
    problematicPods: issues.length,
    warningEvents: warningEvents.length,
  };
  const status = deriveClusterStatus(statusInput);
  const displayStatus = deriveDisplayStatus(statusInput);
  const statusSummary = buildStatusSummary(displayStatus, {
    notReadyNodes,
    unhealthyDeployments: unhealthyDeployments.length,
    problematicPods: issues.length,
    warningEvents: warningEvents.length,
    eventWindowMinutes: EVENT_WINDOW_MINUTES,
  });

  return {
    reachable: true,
    checkedAt,
    status,
    displayStatus,
    statusSummary,
    nodes: {
      total: nodeItems.length,
      ready: nodeItems.length - notReadyNodes,
      notReady: notReadyNodes,
      items: nodeItems,
    },
    pods: {
      total: podsRaw.length,
      running,
      pending,
      failed,
      problematic: issues.length,
      issues,
    },
    deployments: {
      total: deploymentsRaw.length,
      unhealthy: unhealthyDeployments.length,
      items: unhealthyDeployments,
    },
    warningEvents,
    eventWindowMinutes: EVENT_WINDOW_MINUTES,
  };
}

export async function getClusterHealthSnapshot(force = false): Promise<ClusterHealthSnapshot> {
  if (!force && cached && Date.now() < cached.expiresAt) {
    return cached.snapshot;
  }
  const snapshot = await gatherClusterHealthSnapshot();
  cached = { expiresAt: Date.now() + CACHE_TTL_MS, snapshot };
  return snapshot;
}
