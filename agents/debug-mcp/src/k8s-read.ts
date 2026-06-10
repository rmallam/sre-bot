/**
 * Read-only K8s and observability helpers for debug MCP (PLAT-11).
 */

import * as k8s from '@kubernetes/client-node';
import { buildKubeConfig } from '../../../shared/src/kube-config.js';
import {
  queryLokiLogs,
  queryPrometheusMetrics,
} from '../../../shared/src/observability-query.js';

const kc = buildKubeConfig();
const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
const appsV1 = kc.makeApiClient(k8s.AppsV1Api);

const MAX_LOG_BYTES = parseInt(process.env['DEBUG_MCP_MAX_LOG_BYTES'] ?? '8192', 10);

export async function listPods(namespace?: string): Promise<object> {
  const res = namespace
    ? await coreV1.listNamespacedPod(namespace)
    : await coreV1.listPodForAllNamespaces();
  return (res.body.items ?? []).slice(0, 50).map((p) => ({
    namespace: p.metadata?.namespace,
    name: p.metadata?.name,
    phase: p.status?.phase,
    ready: (p.status?.containerStatuses ?? []).every((c) => c.ready),
    restarts: (p.status?.containerStatuses ?? []).reduce(
      (n, c) => n + (c.restartCount ?? 0),
      0
    ),
  }));
}

export async function listEvents(namespace?: string): Promise<object> {
  const res = namespace
    ? await coreV1.listNamespacedEvent(namespace)
    : await coreV1.listEventForAllNamespaces();
  return (res.body.items ?? [])
    .filter((e) => e.type === 'Warning')
    .slice(0, 40)
    .map((e) => ({
      namespace: e.metadata?.namespace,
      reason: e.reason,
      message: e.message,
      involvedObject: e.involvedObject?.name,
      lastTime: e.lastTimestamp?.toISOString(),
    }));
}

export async function listDeployments(namespace?: string): Promise<object> {
  const res = namespace
    ? await appsV1.listNamespacedDeployment(namespace)
    : await appsV1.listDeploymentForAllNamespaces();
  return (res.body.items ?? []).slice(0, 50).map((d) => ({
    namespace: d.metadata?.namespace,
    name: d.metadata?.name,
    desired: d.status?.replicas ?? 0,
    ready: d.status?.readyReplicas ?? 0,
  }));
}

export async function getPodLogs(args: {
  namespace: string;
  pod: string;
  container?: string;
  tailLines?: number;
}): Promise<object> {
  const res = await coreV1.readNamespacedPodLog(
    args.pod,
    args.namespace,
    args.container,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    args.tailLines ?? 100
  );
  const text = typeof res.body === 'string' ? res.body : String(res.body ?? '');
  return {
    namespace: args.namespace,
    pod: args.pod,
    truncated: text.length > MAX_LOG_BYTES,
    logs: text.slice(-MAX_LOG_BYTES),
  };
}

export async function queryLogs(args: {
  incidentId: string;
  namespace?: string;
  pod?: string;
  deployment?: string;
  sinceMinutes?: number;
}): Promise<object> {
  const result = await queryLokiLogs({
    incidentId: args.incidentId,
    namespace: args.namespace,
    podName: args.pod,
    deployment: args.deployment,
    sinceMinutes: args.sinceMinutes ?? 30,
  });
  return result ?? { lines: [], source: 'none', truncated: false };
}

export async function queryMetrics(args: {
  incidentId: string;
  namespace: string;
  deployment?: string;
  pod?: string;
}): Promise<object> {
  const result = await queryPrometheusMetrics({
    incidentId: args.incidentId,
    namespace: args.namespace,
    deployment: args.deployment,
    podName: args.pod,
  });
  return result ?? { source: 'none', samples: [], findings: [], summary: 'Prometheus not configured' };
}
