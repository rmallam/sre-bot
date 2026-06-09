/**
 * APP-GRAPH-1 — Application graph schema and deterministic review pass.
 * Graph construction happens in investigator; this module owns review logic.
 */

import type { DiagnosisContext, KubeEvent } from './types.js';

export type AppNodeKind = 'deployment' | 'service' | 'ingress' | 'pod' | 'external';
export type AppNodeStatus = 'ok' | 'degraded' | 'down' | 'unknown';

export interface AppNode {
  id: string;
  kind: AppNodeKind;
  namespace: string;
  name: string;
  status: AppNodeStatus;
  detail: string;
  ready?: number;
  desired?: number;
}

export type AppEdgeKind = 'selects' | 'routes' | 'depends-on' | 'annotated' | 'env-ref';

export interface AppEdge {
  from: string;
  to: string;
  kind: AppEdgeKind;
}

export interface AppGraph {
  appId: string;
  namespace: string;
  nodes: AppNode[];
  edges: AppEdge[];
}

export type AppOverallStatus = 'ok' | 'degraded' | 'down' | 'unknown';

export interface AppReviewResult {
  appId: string;
  namespace: string;
  checkedAt: string;
  reachable: boolean;
  clusterReachable: boolean;
  overallStatus: AppOverallStatus;
  frontierNodeId?: string;
  frontierNode?: AppNode;
  narrative: string;
  graph: AppGraph;
  error?: string;
}

const STATUS_RANK: Record<AppNodeStatus, number> = {
  down: 3,
  degraded: 2,
  unknown: 1,
  ok: 0,
};

function nodeById(graph: AppGraph): Map<string, AppNode> {
  return new Map(graph.nodes.map((n) => [n.id, n]));
}

function adjacency(edges: AppEdge[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const list = out.get(e.from) ?? [];
    list.push(e.to);
    out.set(e.from, list);
  }
  return out;
}

/** Entry nodes: ingress, or deployments with no incoming routes edge. */
export function findEntryNodeIds(graph: AppGraph): string[] {
  const hasIncomingRoute = new Set(
    graph.edges.filter((e) => e.kind === 'routes').map((e) => e.to)
  );
  const ingressIds = graph.nodes.filter((n) => n.kind === 'ingress').map((n) => n.id);
  if (ingressIds.length > 0) return ingressIds;

  const deployIds = graph.nodes
    .filter((n) => n.kind === 'deployment' && !hasIncomingRoute.has(n.id))
    .map((n) => n.id);
  if (deployIds.length > 0) return deployIds;

  return graph.nodes.slice(0, 1).map((n) => n.id);
}

export interface FrontierResult {
  frontierNodeId?: string;
  frontierNode?: AppNode;
  path: string[];
}

/** BFS from entry; frontier = shallowest unhealthy node. */
export function findFrontierFailure(graph: AppGraph): FrontierResult {
  const nodes = nodeById(graph);
  const adj = adjacency(graph.edges);
  const entries = findEntryNodeIds(graph);
  if (entries.length === 0) {
    return { path: [] };
  }

  const depth = new Map<string, number>();
  const parent = new Map<string, string>();
  const queue: string[] = [];

  for (const id of entries) {
    depth.set(id, 0);
    queue.push(id);
  }

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = depth.get(cur) ?? 0;
    for (const next of adj.get(cur) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, d + 1);
      parent.set(next, cur);
      queue.push(next);
    }
  }

  const unhealthy = graph.nodes.filter(
    (n) => n.status !== 'ok' && isActionableNode(n) && depth.has(n.id)
  );
  if (unhealthy.length === 0) {
    return { path: entries };
  }

  unhealthy.sort((a, b) => {
    const da = depth.get(a.id) ?? 999;
    const db = depth.get(b.id) ?? 999;
    if (da !== db) return da - db;
    return STATUS_RANK[b.status] - STATUS_RANK[a.status];
  });

  const frontier = unhealthy[0]!;
  const path: string[] = [];
  let walk: string | undefined = frontier.id;
  while (walk) {
    path.unshift(walk);
    walk = parent.get(walk);
  }
  if (path.length === 0) path.push(frontier.id);

  return {
    frontierNodeId: frontier.id,
    frontierNode: frontier,
    path,
  };
}

function isActionableNode(n: AppNode): boolean {
  if (n.kind === 'external' && n.status === 'unknown') return false;
  if (n.kind === 'service' && n.status === 'unknown') return false;
  return true;
}

export function deriveOverallStatus(nodes: AppNode[]): AppOverallStatus {
  const relevant = nodes.filter(isActionableNode);
  if (relevant.length === 0) return nodes.length > 0 ? 'ok' : 'unknown';
  if (relevant.some((n) => n.status === 'down')) return 'down';
  if (relevant.some((n) => n.status === 'degraded')) return 'degraded';
  if (relevant.every((n) => n.status === 'ok')) return 'ok';
  return 'unknown';
}

function formatNodeLabel(node: AppNode): string {
  const kind =
    node.kind === 'deployment'
      ? 'Deployment'
      : node.kind === 'service'
        ? 'Service'
        : node.kind === 'ingress'
          ? 'Ingress'
          : node.kind === 'pod'
            ? 'Pod'
            : 'External';
  const loc = node.namespace ? `${node.namespace}/${node.name}` : node.name;
  return `${kind} ${loc}`;
}

export function buildReviewNarrative(
  graph: AppGraph,
  frontier: FrontierResult,
  overall: AppOverallStatus
): string {
  const nodes = nodeById(graph);
  if (graph.nodes.length === 0) {
    return `No resources found for app **${graph.appId}** in namespace **${graph.namespace}**.`;
  }
  if (overall === 'ok') {
    const entries = findEntryNodeIds(graph)
      .map((id) => nodes.get(id))
      .filter(Boolean) as AppNode[];
    const entryLabel = entries.map(formatNodeLabel).join(', ') || graph.appId;
    return `App **${graph.appId}** looks healthy from **${entryLabel}** through ${graph.nodes.length} tracked component(s).`;
  }

  const pathLabels = frontier.path
    .map((id) => nodes.get(id))
    .filter(Boolean)
    .map((n) => {
      const label = formatNodeLabel(n!);
      const statusTag = n!.status === 'ok' ? 'ok' : `**${n!.status}**`;
      return `${label} (${statusTag})`;
    });

  const fn = frontier.frontierNode;
  const detail = fn?.detail ? ` — ${fn.detail}` : '';
  return [
    `App **${graph.appId}** is **${overall}**.`,
    pathLabels.length > 0 ? `Path: ${pathLabels.join(' → ')}.` : '',
    fn ? `Frontier failure at **${formatNodeLabel(fn)}**${detail}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function reviewAppGraph(graph: AppGraph, opts?: { checkedAt?: string; clusterReachable?: boolean }): AppReviewResult {
  const checkedAt = opts?.checkedAt ?? new Date().toISOString();
  const clusterReachable = opts?.clusterReachable ?? true;
  const overallStatus = deriveOverallStatus(graph.nodes);
  const frontier = findFrontierFailure(graph);
  const effectiveFrontier =
    overallStatus === 'ok'
      ? { path: frontier.path }
      : frontier;
  const narrative = buildReviewNarrative(graph, effectiveFrontier, overallStatus);

  return {
    appId: graph.appId,
    namespace: graph.namespace,
    checkedAt,
    reachable: graph.nodes.length > 0,
    clusterReachable,
    overallStatus,
    frontierNodeId: effectiveFrontier.frontierNodeId,
    frontierNode: effectiveFrontier.frontierNode,
    narrative,
    graph,
  };
}

export function appReviewToDiagnosisContext(
  review: AppReviewResult,
  opts: {
    incidentId: string;
    namespace?: string;
    resourceKind?: DiagnosisContext['resourceKind'];
  }
): Partial<DiagnosisContext> {
  const fn = review.frontierNode;
  const ns = fn?.namespace || review.namespace;
  const resourceName = fn?.kind === 'deployment' ? fn.name : review.appId;

  const recentEvents: KubeEvent[] = [];
  if (fn && fn.status !== 'ok') {
    recentEvents.push({
      reason: 'AppReviewFrontier',
      message: fn.detail || `${fn.kind} ${fn.name} is ${fn.status}`,
      count: 1,
      firstTime: review.checkedAt,
      lastTime: review.checkedAt,
      type: 'Warning',
    });
  }

  return {
    namespace: ns,
    resourceName,
    resourceKind: opts.resourceKind ?? 'Deployment',
    recentEvents,
    currentLogs: review.narrative,
    previousLogs: '',
    clusterReachable: review.clusterReachable,
    existingDeployments: review.graph.nodes
      .filter((n) => n.kind === 'deployment')
      .map((n) => `${n.namespace}/${n.name}`),
  };
}
