/**
 * Read-only cluster listings (kubectl get-style) for commander chat.
 */

import * as k8s from '@kubernetes/client-node';
import { existsSync } from 'node:fs';
import { log } from '../../../shared/src/http.js';

const AGENT = 'investigator';
const MAX_ROWS = 50;
const MAX_CHARS = 3800;

export type ClusterGetResource =
  | 'namespaces'
  | 'pods'
  | 'deployments'
  | 'nodes'
  | 'services'
  | 'events';

export interface ClusterGetResult {
  resource: ClusterGetResource;
  namespace?: string;
  total: number;
  shown: number;
  text: string;
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
const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
const appsV1 = kc.makeApiClient(k8s.AppsV1Api);

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s.padEnd(width);
}

function truncate(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(0, MAX_CHARS - 40)}\n\n…(truncated)`;
}

function formatResult(
  resource: ClusterGetResource,
  title: string,
  header: string,
  rows: string[],
  total: number,
  namespace?: string
): ClusterGetResult {
  const shown = rows.length;
  const lines = [title, '', '```', header, ...rows, '```'];
  if (total > shown) {
    lines.push('', `Showing ${shown} of ${total}. Use "get pods in <namespace>" to narrow down.`);
  }
  return {
    resource,
    namespace,
    total,
    shown,
    text: truncate(lines.join('\n')),
  };
}

export async function clusterGet(
  resource: ClusterGetResource,
  namespace: string | undefined,
  incidentId: string
): Promise<ClusterGetResult> {
  log('info', AGENT, 'cluster get', { incidentId, resource, namespace });

  switch (resource) {
    case 'namespaces':
      return getNamespaces(incidentId);
    case 'pods':
      return getPods(namespace, incidentId);
    case 'deployments':
      return getDeployments(namespace, incidentId);
    case 'nodes':
      return getNodes(incidentId);
    case 'services':
      return getServices(namespace, incidentId);
    case 'events':
      return getEvents(namespace, incidentId);
    default:
      throw new Error(`Unsupported resource: ${resource}`);
  }
}

async function getNamespaces(incidentId: string): Promise<ClusterGetResult> {
  const res = await coreV1.listNamespace();
  const items = (res.body.items ?? []).sort((a, b) =>
    (a.metadata?.name ?? '').localeCompare(b.metadata?.name ?? '')
  );
  const header = `${pad('NAME', 28)} ${pad('STATUS', 10)}`;
  const rows = items.slice(0, MAX_ROWS).map((ns) => {
    const name = ns.metadata?.name ?? '';
    const phase = ns.status?.phase ?? 'Unknown';
    return `${pad(name, 28)} ${pad(phase, 10)}`;
  });
  return formatResult('namespaces', `📋 Namespaces (${items.length})`, header, rows, items.length);
}

async function getPods(ns: string | undefined, incidentId: string): Promise<ClusterGetResult> {
  const res = ns
    ? await coreV1.listNamespacedPod(ns)
    : await coreV1.listPodForAllNamespaces();
  const items = (res.body.items ?? []).sort((a, b) => {
    const an = `${a.metadata?.namespace}/${a.metadata?.name}`;
    const bn = `${b.metadata?.namespace}/${b.metadata?.name}`;
    return an.localeCompare(bn);
  });
  const header = ns
    ? `${pad('NAME', 36)} ${pad('READY', 8)} ${pad('STATUS', 12)}`
    : `${pad('NAMESPACE', 16)} ${pad('NAME', 28)} ${pad('READY', 8)} ${pad('STATUS', 12)}`;
  const rows = items.slice(0, MAX_ROWS).map((p) => {
    const namespace = p.metadata?.namespace ?? '';
    const name = p.metadata?.name ?? '';
    const ready = `${(p.status?.containerStatuses ?? []).filter((c) => c.ready).length}/${p.status?.containerStatuses?.length ?? 0}`;
    const status = p.status?.phase ?? 'Unknown';
    if (ns) {
      return `${pad(name, 36)} ${pad(ready, 8)} ${pad(status, 12)}`;
    }
    return `${pad(namespace, 16)} ${pad(name, 28)} ${pad(ready, 8)} ${pad(status, 12)}`;
  });
  const title = ns ? `📋 Pods in ${ns} (${items.length})` : `📋 Pods (${items.length})`;
  return formatResult('pods', title, header, rows, items.length, ns);
}

async function getDeployments(
  ns: string | undefined,
  incidentId: string
): Promise<ClusterGetResult> {
  const res = ns
    ? await appsV1.listNamespacedDeployment(ns)
    : await appsV1.listDeploymentForAllNamespaces();
  const items = (res.body.items ?? []).sort((a, b) => {
    const an = `${a.metadata?.namespace}/${a.metadata?.name}`;
    const bn = `${b.metadata?.namespace}/${b.metadata?.name}`;
    return an.localeCompare(bn);
  });
  const header = ns
    ? `${pad('NAME', 32)} ${pad('READY', 10)} ${pad('AVAILABLE', 10)}`
    : `${pad('NAMESPACE', 16)} ${pad('NAME', 24)} ${pad('READY', 10)} ${pad('AVAILABLE', 10)}`;
  const rows = items.slice(0, MAX_ROWS).map((d) => {
    const namespace = d.metadata?.namespace ?? '';
    const name = d.metadata?.name ?? '';
    const desired = d.status?.replicas ?? 0;
    const ready = d.status?.readyReplicas ?? 0;
    const readyStr = `${ready}/${desired}`;
    const avail = String(d.status?.availableReplicas ?? 0);
    if (ns) {
      return `${pad(name, 32)} ${pad(readyStr, 10)} ${pad(avail, 10)}`;
    }
    return `${pad(namespace, 16)} ${pad(name, 24)} ${pad(readyStr, 10)} ${pad(avail, 10)}`;
  });
  const title = ns
    ? `📋 Deployments in ${ns} (${items.length})`
    : `📋 Deployments (${items.length})`;
  return formatResult('deployments', title, header, rows, items.length, ns);
}

async function getNodes(incidentId: string): Promise<ClusterGetResult> {
  const res = await coreV1.listNode();
  const items = (res.body.items ?? []).sort((a, b) =>
    (a.metadata?.name ?? '').localeCompare(b.metadata?.name ?? '')
  );
  const header = `${pad('NAME', 28)} ${pad('STATUS', 10)} ${pad('ROLES', 16)}`;
  const rows = items.slice(0, MAX_ROWS).map((n) => {
    const name = n.metadata?.name ?? '';
    const ready = (n.status?.conditions ?? []).find((c) => c.type === 'Ready');
    const status = ready?.status === 'True' ? 'Ready' : 'NotReady';
    const roles =
      Object.keys(n.metadata?.labels ?? {})
        .filter((k) => k.startsWith('node-role.kubernetes.io/'))
        .map((k) => k.replace('node-role.kubernetes.io/', ''))
        .join(',') || '<none>';
    return `${pad(name, 28)} ${pad(status, 10)} ${pad(roles, 16)}`;
  });
  return formatResult('nodes', `📋 Nodes (${items.length})`, header, rows, items.length);
}

async function getServices(ns: string | undefined, incidentId: string): Promise<ClusterGetResult> {
  const res = ns
    ? await coreV1.listNamespacedService(ns)
    : await coreV1.listServiceForAllNamespaces();
  const items = (res.body.items ?? []).sort((a, b) => {
    const an = `${a.metadata?.namespace}/${a.metadata?.name}`;
    const bn = `${b.metadata?.namespace}/${b.metadata?.name}`;
    return an.localeCompare(bn);
  });
  const header = ns
    ? `${pad('NAME', 28)} ${pad('TYPE', 12)} ${pad('CLUSTER-IP', 16)}`
    : `${pad('NAMESPACE', 14)} ${pad('NAME', 22)} ${pad('TYPE', 12)} ${pad('CLUSTER-IP', 16)}`;
  const rows = items.slice(0, MAX_ROWS).map((s) => {
    const namespace = s.metadata?.namespace ?? '';
    const name = s.metadata?.name ?? '';
    const type = s.spec?.type ?? '';
    const ip = s.spec?.clusterIP ?? '';
    if (ns) {
      return `${pad(name, 28)} ${pad(type, 12)} ${pad(ip, 16)}`;
    }
    return `${pad(namespace, 14)} ${pad(name, 22)} ${pad(type, 12)} ${pad(ip, 16)}`;
  });
  const title = ns ? `📋 Services in ${ns} (${items.length})` : `📋 Services (${items.length})`;
  return formatResult('services', title, header, rows, items.length, ns);
}

async function getEvents(ns: string | undefined, incidentId: string): Promise<ClusterGetResult> {
  const res = ns
    ? await coreV1.listNamespacedEvent(ns)
    : await coreV1.listEventForAllNamespaces();
  const items = (res.body.items ?? [])
    .filter((e) => e.type === 'Warning' || !ns)
    .sort((a, b) => {
      const at = a.lastTimestamp?.getTime() ?? 0;
      const bt = b.lastTimestamp?.getTime() ?? 0;
      return bt - at;
    });
  const header = `${pad('NAMESPACE', 14)} ${pad('REASON', 18)} ${pad('OBJECT', 22)}`;
  const rows = items.slice(0, MAX_ROWS).map((e) => {
    const namespace = e.metadata?.namespace ?? '';
    const reason = e.reason ?? '';
    const obj = e.involvedObject
      ? `${e.involvedObject.kind}/${e.involvedObject.name}`
      : '';
    const msg = (e.message ?? '').slice(0, 60);
    return `${pad(namespace, 14)} ${pad(reason, 18)} ${pad(obj, 22)}\n  ${msg}`;
  });
  const title = ns
    ? `⚠️ Recent events in ${ns} (${items.length})`
    : `⚠️ Recent warning events (${items.length})`;
  return formatResult('events', title, header, rows, items.length, ns);
}
