import type { AppGraph, AppGraphNode } from '../types';

export const NODE_W = 168;
export const NODE_H = 72;
const GAP_X = 20;
const GAP_Y = 96;
const PAD_X = 40;
const PAD_Y = 44;

const KIND_RANK: Record<AppGraphNode['kind'], number> = {
  ingress: 0,
  service: 1,
  deployment: 2,
  pod: 3,
  external: 4,
};

export interface GraphLayout {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

export function computeGraphLayout(graph: AppGraph): GraphLayout {
  const nodes = graph.nodes;
  if (nodes.length === 0) {
    return { positions: new Map(), width: 640, height: 200 };
  }

  const out = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const n of nodes) indegree.set(n.id, 0);
  for (const e of graph.edges) {
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }

  let entries = nodes.filter((n) => n.kind === 'ingress').map((n) => n.id);
  if (entries.length === 0) {
    entries = nodes
      .filter((n) => n.kind === 'deployment' && (indegree.get(n.id) ?? 0) === 0)
      .map((n) => n.id);
  }
  if (entries.length === 0) {
    entries = nodes.filter((n) => n.kind === 'deployment').map((n) => n.id);
  }
  if (entries.length === 0) entries = [nodes[0]!.id];

  const depth = new Map<string, number>();
  const queue = [...entries];
  for (const id of entries) depth.set(id, 0);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of out.get(cur) ?? []) {
      const nextDepth = (depth.get(cur) ?? 0) + 1;
      const prev = depth.get(next);
      if (prev === undefined || nextDepth < prev) {
        depth.set(next, nextDepth);
        queue.push(next);
      }
    }
  }

  let maxDepth = Math.max(0, ...depth.values());
  for (const n of nodes) {
    if (!depth.has(n.id)) {
      maxDepth += 1;
      depth.set(n.id, maxDepth);
    }
  }

  const byDepth = new Map<number, AppGraphNode[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    byDepth.set(d, [...(byDepth.get(d) ?? []), n]);
  }

  let width = 640;
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  for (const d of depths) {
    const row = byDepth.get(d)!;
    const rowWidth = row.length * NODE_W + Math.max(0, row.length - 1) * GAP_X;
    width = Math.max(width, rowWidth + PAD_X * 2);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const d of depths) {
    const row = [...(byDepth.get(d) ?? [])].sort(
      (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.name.localeCompare(b.name)
    );
    const rowWidth = row.length * NODE_W + Math.max(0, row.length - 1) * GAP_X;
    const startX = (width - rowWidth) / 2 + NODE_W / 2;
    row.forEach((n, i) => {
      positions.set(n.id, {
        x: startX + i * (NODE_W + GAP_X),
        y: PAD_Y + d * GAP_Y,
      });
    });
  }

  const height = PAD_Y * 2 + (depths.length - 1) * GAP_Y + NODE_H;
  return { positions, width, height };
}

export function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number }
): string {
  const y1 = from.y + NODE_H / 2;
  const y2 = to.y - NODE_H / 2;
  const mid = (y1 + y2) / 2;
  return `M ${from.x} ${y1} C ${from.x} ${mid}, ${to.x} ${mid}, ${to.x} ${y2}`;
}
