/**
 * Running-status lookup for conversational "is X running?" queries.
 */

import * as k8s from '@kubernetes/client-node';
import { existsSync } from 'node:fs';
import type { ResourceKind } from '../../../shared/src/types.js';
import type { WorkloadStatusFacts, WorkloadPodStatus } from '../../../shared/src/workload-status.js';
import { verifyDeployment } from './verify.js';
import { resolvePodForWorkload, resolveWorkloadCandidates } from './workload-resolve.js';
import { ALL_NAMESPACES } from '../../../shared/src/namespace-scope.js';
import type { WorkloadStatusMatch } from '../../../shared/src/workload-status.js';
import { log } from '../../../shared/src/http.js';

const AGENT = 'investigator';

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

function podDetail(statuses: k8s.V1ContainerStatus[]): string | undefined {
  for (const s of statuses) {
    const w = s.state?.waiting;
    if (w?.reason) return `${w.reason}${w.message ? `: ${w.message.slice(0, 120)}` : ''}`;
    const t = s.state?.terminated;
    if (t?.reason) return `${t.reason}${t.message ? `: ${t.message.slice(0, 120)}` : ''}`;
  }
  return undefined;
}

function mapPod(pod: k8s.V1Pod): WorkloadPodStatus {
  const statuses = pod.status?.containerStatuses ?? [];
  const ready = statuses.filter((s) => s.ready).length;
  const total = statuses.length;
  return {
    name: pod.metadata?.name ?? 'unknown',
    phase: pod.status?.phase ?? 'Unknown',
    ready: total > 0 ? `${ready}/${total}` : '?',
    detail: podDetail(statuses),
  };
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

async function gatherSingleNamespaceStatus(opts: {
  incidentId: string;
  namespace: string;
  resourceName: string;
  resourceKind?: ResourceKind;
  podName?: string;
}): Promise<WorkloadStatusFacts> {
  const resourceKind = opts.resourceKind ?? 'Deployment';
  const kc = buildKubeConfig();
  const core = kc.makeApiClient(k8s.CoreV1Api);

  if (resourceKind === 'Pod') {
    try {
      const res = await core.readNamespacedPod(opts.resourceName, opts.namespace);
      const pod = mapPod(res.body);
      const healthy = pod.phase === 'Running' && pod.ready !== '0/1' && pod.ready !== '0/0';
      return {
        namespace: opts.namespace,
        resourceKind: 'Pod',
        resourceName: opts.resourceName,
        healthy,
        pods: [pod],
        summary: healthy
          ? `Pod ${opts.resourceName} is running.`
          : `Pod ${opts.resourceName} is ${pod.phase}.`,
      };
    } catch {
      return {
        namespace: opts.namespace,
        resourceKind: 'Pod',
        resourceName: opts.resourceName,
        healthy: false,
        pods: [],
        summary: `Pod ${opts.resourceName} not found in namespace ${opts.namespace}.`,
      };
    }
  }

  const verify = await verifyDeployment(opts.namespace, opts.resourceName, opts.incidentId);
  const podName =
    opts.podName ??
    (await resolvePodForWorkload(opts.namespace, opts.resourceName, resourceKind, opts.incidentId));

  let pods: WorkloadPodStatus[] = [];
  try {
    const prefix = `${opts.resourceName}-`;
    const list = await core.listNamespacedPod(opts.namespace);
    pods = (list.body.items ?? [])
      .filter((p) => p.metadata?.name?.startsWith(prefix) || p.metadata?.name === podName)
      .map(mapPod);
    if (pods.length === 0 && podName) {
      try {
        const one = await core.readNamespacedPod(podName, opts.namespace);
        pods = [mapPod(one.body)];
      } catch {
        /* optional pod */
      }
    }
  } catch (err) {
    log('warn', AGENT, 'Pod list for workload status failed', { error: String(err) });
  }

  return {
    namespace: opts.namespace,
    resourceKind,
    resourceName: opts.resourceName,
    healthy: !!verify.healthy,
    readyReplicas: verify.readyReplicas,
    desiredReplicas: verify.desiredReplicas,
    pods,
    summary: verify.message ?? '',
  };
}

async function gatherAllNamespacesStatus(opts: {
  incidentId: string;
  resourceName: string;
  resourceKind?: ResourceKind;
}): Promise<WorkloadStatusFacts> {
  const hint = opts.resourceName;
  const candidates = await resolveWorkloadCandidates(hint, undefined, opts.incidentId, 20);
  const hintNorm = normalizeName(hint);

  const filtered = candidates.filter((c) => {
    if (c.resourceKind === 'Pod') return false;
    return normalizeName(c.resourceName) === hintNorm || c.score >= 92;
  });

  const byKey = new Map<string, typeof filtered[0]>();
  for (const c of filtered) {
    const key = `${c.namespace}/${c.resourceKind}/${c.resourceName}`;
    const prev = byKey.get(key);
    if (!prev || c.score > prev.score) byKey.set(key, c);
  }
  const unique = [...byKey.values()].slice(0, 10);

  if (unique.length === 0) {
    return {
      namespace: ALL_NAMESPACES,
      scope: 'cluster',
      resourceKind: opts.resourceKind ?? 'Deployment',
      resourceName: hint,
      healthy: false,
      pods: [],
      matches: [],
      summary: `No workload named "${hint}" found in any namespace.`,
    };
  }

  const matches: WorkloadStatusMatch[] = [];
  for (const c of unique) {
    const status = await gatherSingleNamespaceStatus({
      incidentId: opts.incidentId,
      namespace: c.namespace,
      resourceName: c.resourceName,
      resourceKind: c.resourceKind,
      podName: c.podName,
    });
    matches.push({
      namespace: c.namespace,
      resourceKind: status.resourceKind,
      resourceName: status.resourceName,
      healthy: status.healthy,
      readyReplicas: status.readyReplicas,
      desiredReplicas: status.desiredReplicas,
      pods: status.pods,
      summary: status.summary,
    });
  }

  return {
    namespace: ALL_NAMESPACES,
    scope: 'cluster',
    resourceKind: opts.resourceKind ?? 'Deployment',
    resourceName: hint,
    healthy: matches.some((m) => m.healthy),
    pods: [],
    matches,
    summary: `Found ${matches.length} deployment(s) matching "${hint}" across the cluster.`,
  };
}

export async function gatherWorkloadStatus(opts: {
  incidentId: string;
  namespace: string;
  resourceName: string;
  resourceKind?: ResourceKind;
  podName?: string;
}): Promise<WorkloadStatusFacts> {
  log('info', AGENT, 'Gathering workload status', {
    incidentId: opts.incidentId,
    namespace: opts.namespace,
    resourceName: opts.resourceName,
    resourceKind: opts.resourceKind ?? 'Deployment',
  });

  if (opts.namespace === ALL_NAMESPACES || opts.namespace === '_all') {
    return gatherAllNamespacesStatus({
      incidentId: opts.incidentId,
      resourceName: opts.resourceName,
      resourceKind: opts.resourceKind,
    });
  }

  return gatherSingleNamespaceStatus(opts);
}
