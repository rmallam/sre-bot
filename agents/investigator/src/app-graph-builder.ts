/**
 * Build application graph from Kubernetes API (deterministic, no LLM).
 */

import * as k8s from '@kubernetes/client-node';
import { existsSync } from 'node:fs';
import {
  type AppEdge,
  type AppGraph,
  type AppNode,
  type AppNodeStatus,
  reviewAppGraph,
  type AppReviewResult,
} from '../../../shared/src/app-graph.js';
import { log } from '../../../shared/src/http.js';
import { resolveDeploymentByHint } from './cluster-facts.js';
import { getCatalogEntry } from './app-catalog-store.js';
import { resolveMatchedDeployments } from './app-list.js';

const AGENT = 'investigator';
const DEPENDS_ON_ANNOTATION = 'sre.bot/depends-on';

const ENV_HOST_PATTERNS = [
  /^(.+)_HOST$/i,
  /^(.+)_URL$/i,
  /^(.+)_ADDR$/i,
  /^DATABASE_URL$/i,
  /^REDIS_URL$/i,
  /^AMQP_URL$/i,
];

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
const netV1Api = kc.makeApiClient(k8s.NetworkingV1Api);

function formatK8sApiError(err: unknown): string {
  const body = (err as { body?: { message?: string } })?.body?.message;
  if (body) return body;
  return String(err).slice(0, 240);
}

function nodeId(kind: AppNode['kind'], namespace: string, name: string): string {
  if (kind === 'external') return `external:${name}`;
  return `${kind}:${namespace}/${name}`;
}

function deploymentStatus(dep: k8s.V1Deployment): { status: AppNodeStatus; detail: string; ready: number; desired: number } {
  const desired = dep.spec?.replicas ?? dep.status?.replicas ?? 0;
  const ready = dep.status?.readyReplicas ?? 0;
  const available = dep.status?.availableReplicas ?? 0;

  if (desired === 0) {
    return { status: 'degraded', detail: '0 desired replicas', ready, desired };
  }
  if (ready === 0) {
    return { status: 'down', detail: `0/${desired} replicas ready`, ready, desired };
  }
  if (ready < desired || available < desired) {
    return { status: 'degraded', detail: `${ready}/${desired} replicas ready`, ready, desired };
  }
  return { status: 'ok', detail: `${ready}/${desired} replicas ready`, ready, desired };
}

function podStatus(pod: k8s.V1Pod): { status: AppNodeStatus; detail: string } {
  const phase = pod.status?.phase ?? 'Unknown';
  const cs = pod.status?.containerStatuses ?? [];
  const ready = cs.filter((c) => c.ready).length;
  const total = cs.length || 1;
  const waiting = cs.find((c) => c.state?.waiting);
  const terminated = cs.find((c) => c.state?.terminated);

  if (phase === 'Failed' || waiting?.state?.waiting?.reason === 'CrashLoopBackOff') {
    return {
      status: 'down',
      detail: waiting?.state?.waiting?.reason ?? terminated?.state?.terminated?.reason ?? phase,
    };
  }
  if (phase === 'Pending' || ready < total) {
    return { status: 'degraded', detail: `${phase} (${ready}/${total} ready)` };
  }
  if (phase === 'Running' && ready === total) {
    return { status: 'ok', detail: `Running (${ready}/${total} ready)` };
  }
  return { status: 'unknown', detail: phase };
}

function serviceStatus(svc: k8s.V1Service, endpoints: k8s.V1Endpoints | undefined): { status: AppNodeStatus; detail: string } {
  if (svc.spec?.clusterIP === 'None') {
    return { status: 'ok', detail: 'Headless service' };
  }
  const subsets = endpoints?.subsets ?? [];
  const readyAddresses = subsets.reduce(
    (sum, s) => sum + (s.addresses?.length ?? 0),
    0
  );
  if (readyAddresses === 0) {
    return { status: 'down', detail: 'No ready endpoints' };
  }
  return { status: 'ok', detail: `${readyAddresses} ready endpoint(s)` };
}

function ingressStatus(ing: k8s.V1Ingress): { status: AppNodeStatus; detail: string } {
  const rules = ing.spec?.rules?.length ?? 0;
  const lbs = ing.status?.loadBalancer?.ingress?.length ?? 0;
  const backends = (ing.spec?.rules ?? []).flatMap((r) =>
    (r.http?.paths ?? []).map((p) => p.backend?.service?.name).filter(Boolean)
  );
  if (rules === 0) {
    return { status: 'degraded', detail: 'No ingress rules' };
  }
  if (backends.length === 0) {
    return { status: 'down', detail: 'No backend services configured' };
  }
  if (lbs === 0) {
    return { status: 'degraded', detail: `${rules} rule(s), load balancer pending` };
  }
  return { status: 'ok', detail: `${rules} rule(s), load balancer ready` };
}

function labelsMatch(a: Record<string, string>, b: Record<string, string>): boolean {
  return Object.entries(a).every(([k, v]) => b[k] === v);
}

/** Hostname from env value — handles postgres/redis/amqp URLs and plain hostnames. */
function hostFromEnvValue(val: string): string | null {
  const trimmed = val.trim();
  const pgMatch = trimmed.match(/^postgres(?:ql)?:\/\/[^@]*@([^:/]+)/i);
  if (pgMatch?.[1]) return pgMatch[1]!;
  const redisMatch = trimmed.match(/^rediss?:\/\/[^@]*@([^:/]+)/i);
  if (redisMatch?.[1]) return redisMatch[1]!;
  const amqpMatch = trimmed.match(/^amqp(?:s)?:\/\/[^@]*@([^:/]+)/i);
  if (amqpMatch?.[1]) return amqpMatch[1]!;
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const host = withoutScheme.split('/')[0]!.split(':')[0]!.split('@').pop()!;
  if (!host || host === 'localhost' || host.length < 2) return null;
  return host;
}

function extractEnvDependencies(env: k8s.V1EnvVar[] | undefined): string[] {
  const deps: string[] = [];
  for (const e of env ?? []) {
    const val = e.value ?? '';
    if (!val) continue;
    const name = e.name ?? '';
    if (ENV_HOST_PATTERNS.some((re) => re.test(name))) {
      const host = hostFromEnvValue(val);
      if (host) deps.push(host);
    }
  }
  return [...new Set(deps.filter((d) => d.length > 1 && !d.includes('localhost')))];
}

function parseEnvTarget(host: string, defaultNs: string): { kind: 'service' | 'external'; ns: string; name: string } {
  const svcMatch = host.match(/^([\w][\w-]*)\.([\w-]+)\.svc(?:\.cluster\.local)?$/i);
  if (svcMatch) {
    return { kind: 'service', ns: svcMatch[2]!, name: svcMatch[1]! };
  }
  const shortSvc = allServiceNames(host, defaultNs);
  if (shortSvc) return shortSvc;
  return { kind: 'external', ns: '', name: host };
}

function allServiceNames(host: string, defaultNs: string): { kind: 'service'; ns: string; name: string } | null {
  if (/^[\w][\w-]*$/.test(host)) {
    return { kind: 'service', ns: defaultNs, name: host };
  }
  return null;
}

function parseDependsOn(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface BuildAppGraphOpts {
  appId: string;
  namespace?: string;
  incidentId?: string;
}

export interface BuildAppGraphResult {
  graph: AppGraph;
  clusterReachable: boolean;
  error?: string;
}

async function listWithError<T>(
  label: string,
  fn: () => Promise<{ body: T }>
): Promise<{ value: T; error?: string }> {
  try {
    const res = await fn();
    return { value: res.body };
  } catch (err) {
    const error = formatK8sApiError(err);
    log('warn', AGENT, `App graph: ${label} failed`, { error });
    return { value: { items: [] } as T, error };
  }
}

export async function buildAppGraph(opts: BuildAppGraphOpts): Promise<BuildAppGraphResult> {
  const incidentId = opts.incidentId ?? 'app-graph';
  let appId = opts.appId.trim();
  let namespace = opts.namespace?.trim() || 'default';

  log('info', AGENT, 'Building app graph', { incidentId, appId, namespace });

  const [depsRes, svcsRes, podsRes, ingRes, epsRes] = await Promise.all([
    listWithError('listDeploymentForAllNamespaces', () => appsV1Api.listDeploymentForAllNamespaces()),
    listWithError('listServiceForAllNamespaces', () => coreV1Api.listServiceForAllNamespaces()),
    listWithError('listPodForAllNamespaces', () => coreV1Api.listPodForAllNamespaces()),
    listWithError('listIngressForAllNamespaces', () => netV1Api.listIngressForAllNamespaces()),
    listWithError('listEndpointsForAllNamespaces', () => coreV1Api.listEndpointsForAllNamespaces()),
  ]);

  const apiErrors = [depsRes.error, svcsRes.error, podsRes.error, ingRes.error, epsRes.error].filter(
    Boolean
  ) as string[];
  const allDeps = depsRes.value.items ?? [];
  const clusterReachable = allDeps.length > 0 || apiErrors.length === 0;

  if (allDeps.length === 0 && depsRes.error) {
    return {
      graph: { appId, namespace, nodes: [], edges: [] },
      clusterReachable: false,
      error: depsRes.error,
    };
  }

  const resolved = await resolveDeploymentByHint(appId, namespace !== 'default' ? namespace : undefined, incidentId);
  if (resolved) {
    appId = resolved.resourceName;
    namespace = resolved.namespace;
  }

  const appIdLower = appId.toLowerCase();
  const { matched: matchedDeps, namespace: resolvedNs } = await resolveMatchedDeployments(
    allDeps,
    appId,
    namespace
  );
  namespace = resolvedNs;

  const catalogEntry = await getCatalogEntry(namespace, appId);

  const namespaces = new Set(matchedDeps.map((d) => d.metadata?.namespace ?? namespace));
  if (matchedDeps.length === 0) namespaces.add(namespace);

  const nodes: AppNode[] = [];
  const edges: AppEdge[] = [];
  const nodeIds = new Set<string>();

  function addNode(node: AppNode): void {
    if (nodeIds.has(node.id)) return;
    nodeIds.add(node.id);
    nodes.push(node);
  }

  function addEdge(edge: AppEdge): void {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) return;
    edges.push(edge);
  }

  const allSvcs = svcsRes.value.items ?? [];
  const allPods = podsRes.value.items ?? [];
  const allIng = ingRes.value.items ?? [];
  const allEps = epsRes.value.items ?? [];

  const epsByNsName = new Map<string, k8s.V1Endpoints>();
  for (const ep of allEps) {
    const key = `${ep.metadata?.namespace}/${ep.metadata?.name}`;
    epsByNsName.set(key, ep);
  }

  for (const dep of matchedDeps) {
    const ns = dep.metadata?.namespace ?? namespace;
    const name = dep.metadata?.name ?? appId;
    const id = nodeId('deployment', ns, name);
    const st = deploymentStatus(dep);
    addNode({
      id,
      kind: 'deployment',
      namespace: ns,
      name,
      status: st.status,
      detail: st.detail,
      ready: st.ready,
      desired: st.desired,
    });

    const selector = dep.spec?.selector?.matchLabels ?? {};
    const depPods = allPods.filter(
      (p) =>
        (p.metadata?.namespace ?? '') === ns &&
        labelsMatch(selector, p.metadata?.labels ?? {})
    );

    for (const pod of depPods.slice(0, 8)) {
      const podName = pod.metadata?.name ?? 'pod';
      const pid = nodeId('pod', ns, podName);
      const pst = podStatus(pod);
      addNode({
        id: pid,
        kind: 'pod',
        namespace: ns,
        name: podName,
        status: pst.status,
        detail: pst.detail,
      });
      addEdge({ from: id, to: pid, kind: 'selects' });
    }

    for (const c of dep.spec?.template?.spec?.containers ?? []) {
      for (const host of extractEnvDependencies(c.env)) {
        const target = parseEnvTarget(host, ns);
        if (target.kind === 'service') {
          const targetSvc = allSvcs.find(
            (s) =>
              (s.metadata?.namespace ?? '') === target.ns &&
              (s.metadata?.name ?? '') === target.name
          );
          if (!targetSvc) {
            const extId = nodeId('external', '', `${target.ns}/${target.name}`);
            if (!nodeIds.has(extId)) {
              addNode({
                id: extId,
                kind: 'external',
                namespace: target.ns,
                name: target.name,
                status: 'unknown',
                detail: 'External dependency (service not in cluster)',
              });
            }
            addEdge({ from: id, to: extId, kind: 'env-ref' });
            continue;
          }
          const sid = nodeId('service', target.ns, target.name);
          if (!nodeIds.has(sid)) {
            const ep = epsByNsName.get(`${target.ns}/${target.name}`);
            const sst = serviceStatus(targetSvc, ep);
            addNode({
              id: sid,
              kind: 'service',
              namespace: target.ns,
              name: target.name,
              status: sst.status,
              detail: sst.detail,
            });
          }
          addEdge({ from: id, to: sid, kind: 'env-ref' });
        } else {
          const extId = nodeId('external', '', host);
          addNode({
            id: extId,
            kind: 'external',
            namespace: '',
            name: host,
            status: 'unknown',
            detail: `Referenced via env (${c.name})`,
          });
          addEdge({ from: id, to: extId, kind: 'env-ref' });
        }
      }
    }

    for (const depName of [
      ...parseDependsOn(dep.metadata?.annotations?.[DEPENDS_ON_ANNOTATION]),
      ...(catalogEntry?.dependsOn ?? []),
    ]) {
      const parts = depName.includes('/') ? depName.split('/') : [ns, depName];
      const depNs = parts.length === 2 ? parts[0]! : ns;
      const depTarget = parts.length === 2 ? parts[1]! : parts[0]!;
      const targetSvc = allSvcs.find(
        (s) => (s.metadata?.namespace ?? '') === depNs && (s.metadata?.name ?? '') === depTarget
      );
      const targetDep = allDeps.find(
        (d) => (d.metadata?.namespace ?? '') === depNs && (d.metadata?.name ?? '') === depTarget
      );
      if (targetSvc) {
        const sid = nodeId('service', depNs, targetSvc.metadata!.name!);
        if (!nodeIds.has(sid)) {
          const ep = epsByNsName.get(`${depNs}/${targetSvc.metadata!.name!}`);
          const sst = serviceStatus(targetSvc, ep);
          addNode({
            id: sid,
            kind: 'service',
            namespace: depNs,
            name: targetSvc.metadata!.name!,
            status: sst.status,
            detail: sst.detail,
          });
        }
        addEdge({ from: id, to: sid, kind: 'annotated' });
      } else if (targetDep) {
        const did = nodeId('deployment', depNs, targetDep.metadata!.name!);
        if (!nodeIds.has(did)) {
          const dst = deploymentStatus(targetDep);
          addNode({
            id: did,
            kind: 'deployment',
            namespace: depNs,
            name: targetDep.metadata!.name!,
            status: dst.status,
            detail: dst.detail,
            ready: dst.ready,
            desired: dst.desired,
          });
        }
        addEdge({ from: id, to: did, kind: 'annotated' });
      } else {
        const extId = nodeId('external', '', depName);
        addNode({
          id: extId,
          kind: 'external',
          namespace: '',
          name: depName,
          status: 'unknown',
          detail: 'Annotated dependency',
        });
        addEdge({ from: id, to: extId, kind: 'annotated' });
      }
    }
  }

  for (const ns of namespaces) {
    const nsSvcs = allSvcs.filter((s) => (s.metadata?.namespace ?? '') === ns);
    for (const svc of nsSvcs) {
      const svcName = svc.metadata?.name ?? '';
      const relatedDep = matchedDeps.find(
        (d) =>
          (d.metadata?.namespace ?? '') === ns &&
          (d.metadata?.name === svcName ||
            labelsMatch(d.spec?.selector?.matchLabels ?? {}, svc.spec?.selector ?? {}))
      );
      if (!relatedDep && !svcName.toLowerCase().includes(appIdLower)) continue;

      const sid = nodeId('service', ns, svcName);
      if (!nodeIds.has(sid)) {
        const ep = epsByNsName.get(`${ns}/${svcName}`);
        const sst = serviceStatus(svc, ep);
        addNode({
          id: sid,
          kind: 'service',
          namespace: ns,
          name: svcName,
          status: sst.status,
          detail: sst.detail,
        });
      }

      for (const dep of matchedDeps.filter((d) => (d.metadata?.namespace ?? '') === ns)) {
        const did = nodeId('deployment', ns, dep.metadata!.name!);
        if (nodeIds.has(did)) {
          addEdge({ from: did, to: sid, kind: 'selects' });
          addEdge({ from: sid, to: did, kind: 'selects' });
        }
      }

      const nsIng = allIng.filter((i) => (i.metadata?.namespace ?? '') === ns);
      for (const ing of nsIng) {
        for (const rule of ing.spec?.rules ?? []) {
          for (const path of rule.http?.paths ?? []) {
            if (path.backend?.service?.name === svcName) {
              const inName = ing.metadata?.name ?? 'ingress';
              const iid = nodeId('ingress', ns, inName);
              if (!nodeIds.has(iid)) {
                const ist = ingressStatus(ing);
                addNode({
                  id: iid,
                  kind: 'ingress',
                  namespace: ns,
                  name: inName,
                  status: ist.status,
                  detail: ist.detail,
                });
              }
              addEdge({ from: iid, to: sid, kind: 'routes' });
            }
          }
        }
      }
    }
  }

  const graph: AppGraph = {
    appId,
    namespace: [...namespaces][0] ?? namespace,
    nodes,
    edges,
  };

  return { graph, clusterReachable, error: apiErrors[0] };
}

export async function buildAppReview(opts: BuildAppGraphOpts): Promise<AppReviewResult> {
  const built = await buildAppGraph(opts);
  const review = reviewAppGraph(built.graph, { clusterReachable: built.clusterReachable });
  if (built.error && built.graph.nodes.length === 0) {
    return { ...review, error: built.error, clusterReachable: false, reachable: false };
  }
  return built.error ? { ...review, error: built.error } : review;
}

export { listApps, type AppListEntry } from './app-list.js';
