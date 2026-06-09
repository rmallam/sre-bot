/**
 * Cluster / namespace health facts and deployment name resolution.
 */

import * as k8s from '@kubernetes/client-node';
import { existsSync } from 'node:fs';
import type { DiagnosisContext, KubeEvent, ResourceKind } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { gatherPodFacts } from './k8s-facts.js';
import { resolveDeploymentByHint } from './workload-resolve.js';

export { resolveDeploymentByHint };

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

const kc = buildKubeConfig();
const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
const appsV1Api = kc.makeApiClient(k8s.AppsV1Api);

function mapEvents(items: k8s.CoreV1Event[]): KubeEvent[] {
  return items.slice(0, 30).map((e) => ({
    reason: e.reason ?? '',
    message: e.message ?? '',
    count: e.count ?? 1,
    firstTime: e.firstTimestamp?.toISOString() ?? '',
    lastTime: e.lastTimestamp?.toISOString() ?? '',
    type: (e.type as 'Normal' | 'Warning') ?? 'Warning',
  }));
}

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

export async function gatherClusterHealthFacts(incidentId: string): Promise<Partial<DiagnosisContext>> {
  log('info', AGENT, 'Gathering cluster health overview', { incidentId });

  const [nodesRes, eventsRes, depsRes] = await Promise.all([
    listWithError('listNode', () => coreV1Api.listNode()),
    listWithError('listEventForAllNamespaces', () => coreV1Api.listEventForAllNamespaces()),
    listWithError('listDeploymentForAllNamespaces', () => appsV1Api.listDeploymentForAllNamespaces()),
  ]);

  const apiErrors = [nodesRes.error, eventsRes.error, depsRes.error].filter(Boolean) as string[];
  const nodes = nodesRes.value.body.items ?? [];
  const clusterReachable = apiErrors.length === 0 && nodes.length > 0;

  if (!clusterReachable) {
    const reason =
      apiErrors[0] ??
      'No nodes returned — the cluster appears stopped or the API is not serving data.';
    log('warn', AGENT, 'Cluster health: API unreachable or empty', {
      incidentId,
      apiErrors: apiErrors.length,
      nodeCount: nodes.length,
    });
    return {
      namespace: 'default',
      resourceName: '_cluster',
      resourceKind: 'Deployment',
      recentEvents: [],
      currentLogs: reason,
      previousLogs: '',
      existingDeployments: [],
      namespaceExists: false,
      clusterReachable: false,
    };
  }

  const notReadyNodes = nodes.filter((n) =>
    (n.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status !== 'True')
  );

  const deployments = depsRes.value.body.items ?? [];
  const unhealthy = deployments
    .map((d) => {
      const desired = d.status?.replicas ?? 0;
      const ready = d.status?.readyReplicas ?? 0;
      const ns = d.metadata?.namespace ?? 'default';
      const name = d.metadata?.name ?? '';
      return { ns, name, desired, ready, gap: desired - ready };
    })
    .filter((d) => d.name && d.desired > 0 && d.ready < d.desired)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 10);

  const warnings = (eventsRes.value.body.items ?? [])
    .filter((e) => e.type === 'Warning')
    .sort((a, b) => {
      const at = a.lastTimestamp?.getTime() ?? 0;
      const bt = b.lastTimestamp?.getTime() ?? 0;
      return bt - at;
    })
    .slice(0, 20);

  const summaryLines = [
    `Cluster overview: ${nodes.length} node(s), ${notReadyNodes.length} not Ready`,
    'Nodes:',
    ...nodes.slice(0, 12).map((n) => {
      const name = n.metadata?.name ?? '?';
      const ready = (n.status?.conditions ?? []).find((c) => c.type === 'Ready');
      const status = ready?.status === 'True' ? 'Ready' : 'NotReady';
      return `  - ${name}: ${status}`;
    }),
    `Deployments not fully ready: ${unhealthy.length}`,
    ...unhealthy.map((u) => `  - ${u.ns}/${u.name}: ${u.ready}/${u.desired} ready`),
  ];

  let deepFacts: Partial<DiagnosisContext> = {};
  if (unhealthy.length > 0) {
    const top = unhealthy[0]!;
    deepFacts = await gatherPodFacts(
      top.ns,
      top.name,
      top.name,
      'Deployment',
      incidentId
    );
  }

  return {
    ...deepFacts,
    namespace: unhealthy[0]?.ns ?? 'default',
    resourceName: unhealthy[0]?.name ?? '_cluster',
    resourceKind: 'Deployment',
    recentEvents: mapEvents(warnings),
    currentLogs: summaryLines.join('\n'),
    previousLogs: '',
    existingDeployments: deployments
      .map((d) => `${d.metadata?.namespace}/${d.metadata?.name}`)
      .filter(Boolean)
      .slice(0, 50),
    namespaceExists: true,
    clusterReachable: true,
  };
}

export async function gatherNamespaceHealthFacts(
  namespace: string,
  incidentId: string
): Promise<Partial<DiagnosisContext>> {
  log('info', AGENT, 'Gathering namespace health overview', { incidentId, namespace });

  const [depsRes, eventsRes] = await Promise.all([
    appsV1Api.listNamespacedDeployment(namespace).catch(() => ({ body: { items: [] } })),
    coreV1Api.listNamespacedEvent(namespace).catch(() => ({ body: { items: [] } })),
  ]);

  const deployments = depsRes.body.items ?? [];
  const unhealthy = deployments
    .map((d) => ({
      name: d.metadata?.name ?? '',
      desired: d.status?.replicas ?? 0,
      ready: d.status?.readyReplicas ?? 0,
    }))
    .filter((d) => d.name && d.desired > 0 && d.ready < d.desired);

  const warnings = (eventsRes.body.items ?? []).filter((e) => e.type === 'Warning').slice(0, 15);

  const summary = [
    `Namespace ${namespace}: ${deployments.length} deployment(s), ${unhealthy.length} not fully ready`,
    ...unhealthy.map((u) => `  - ${u.name}: ${u.ready}/${u.desired} ready`),
  ].join('\n');

  let deepFacts: Partial<DiagnosisContext> = {};
  if (unhealthy.length > 0) {
    const top = unhealthy[0]!;
    deepFacts = await gatherPodFacts(namespace, top.name, top.name, 'Deployment', incidentId);
  } else if (deployments[0]?.metadata?.name) {
    const name = deployments[0].metadata.name;
    deepFacts = await gatherPodFacts(namespace, name, name, 'Deployment', incidentId);
  }

  return {
    ...deepFacts,
    namespace,
    resourceName: unhealthy[0]?.name ?? deployments[0]?.metadata?.name ?? '_namespace',
    resourceKind: 'Deployment',
    recentEvents: mapEvents(warnings),
    currentLogs: summary,
    existingDeployments: deployments.map((d) => d.metadata?.name ?? '').filter(Boolean),
  };
}
