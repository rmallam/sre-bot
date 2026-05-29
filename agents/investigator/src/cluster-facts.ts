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

export async function gatherClusterHealthFacts(incidentId: string): Promise<Partial<DiagnosisContext>> {
  log('info', AGENT, 'Gathering cluster health overview', { incidentId });

  const [nodesRes, eventsRes, depsRes] = await Promise.all([
    coreV1Api.listNode().catch(() => ({ body: { items: [] } })),
    coreV1Api.listEventForAllNamespaces().catch(() => ({ body: { items: [] } })),
    appsV1Api.listDeploymentForAllNamespaces().catch(() => ({ body: { items: [] } })),
  ]);

  const nodes = nodesRes.body.items ?? [];
  const notReadyNodes = nodes.filter((n) =>
    (n.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status !== 'True')
  );

  const deployments = depsRes.body.items ?? [];
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

  const warnings = (eventsRes.body.items ?? [])
    .filter((e) => e.type === 'Warning')
    .sort((a, b) => {
      const at = a.lastTimestamp?.getTime() ?? 0;
      const bt = b.lastTimestamp?.getTime() ?? 0;
      return bt - at;
    })
    .slice(0, 20);

  const summaryLines = [
    `Cluster overview: ${nodes.length} node(s), ${notReadyNodes.length} not Ready`,
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
