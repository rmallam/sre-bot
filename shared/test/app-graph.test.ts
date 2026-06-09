import { describe, expect, it } from 'vitest';
import {
  buildReviewNarrative,
  deriveOverallStatus,
  findFrontierFailure,
  reviewAppGraph,
  type AppGraph,
} from '../src/app-graph.js';

function sampleGraph(overrides?: Partial<AppGraph>): AppGraph {
  return {
    appId: 'checkout',
    namespace: 'default',
    nodes: [
      { id: 'ingress:default/checkout', kind: 'ingress', namespace: 'default', name: 'checkout', status: 'ok', detail: 'LB ready' },
      { id: 'service:default/checkout-api', kind: 'service', namespace: 'default', name: 'checkout-api', status: 'ok', detail: '2 endpoints' },
      { id: 'deploy:default/checkout-api', kind: 'deployment', namespace: 'default', name: 'checkout-api', status: 'down', detail: '0/3 ready', ready: 0, desired: 3 },
      { id: 'pod:default/checkout-api-abc', kind: 'pod', namespace: 'default', name: 'checkout-api-abc', status: 'down', detail: 'CrashLoopBackOff' },
    ],
    edges: [
      { from: 'ingress:default/checkout', to: 'service:default/checkout-api', kind: 'routes' },
      { from: 'service:default/checkout-api', to: 'deploy:default/checkout-api', kind: 'selects' },
      { from: 'deploy:default/checkout-api', to: 'pod:default/checkout-api-abc', kind: 'selects' },
    ],
    ...overrides,
  };
}

describe('findFrontierFailure', () => {
  it('picks shallowest unhealthy node on path from ingress', () => {
    const graph = sampleGraph();
    const frontier = findFrontierFailure(graph);
    expect(frontier.frontierNodeId).toBe('deploy:default/checkout-api');
    expect(frontier.path[0]).toBe('ingress:default/checkout');
  });

  it('returns empty frontier when all ok', () => {
    const graph = sampleGraph({
      nodes: sampleGraph().nodes.map((n) =>
        n.kind === 'deployment' || n.kind === 'pod'
          ? { ...n, status: 'ok' as const, detail: 'healthy' }
          : n
      ),
    });
    const frontier = findFrontierFailure(graph);
    expect(frontier.frontierNodeId).toBeUndefined();
  });
});

describe('deriveOverallStatus', () => {
  it('down beats degraded', () => {
    expect(
      deriveOverallStatus([
        { id: '1', kind: 'service', namespace: 'a', name: 's', status: 'ok', detail: '' },
        { id: '2', kind: 'deployment', namespace: 'a', name: 'd', status: 'down', detail: '' },
      ])
    ).toBe('down');
  });
});

describe('reviewAppGraph', () => {
  it('builds narrative with frontier', () => {
    const review = reviewAppGraph(sampleGraph());
    expect(review.overallStatus).toBe('down');
    expect(review.frontierNode?.name).toBe('checkout-api');
    expect(review.narrative).toContain('checkout');
    expect(review.narrative).toContain('Frontier failure');
  });

  it('reports healthy app', () => {
    const graph = sampleGraph({
      nodes: sampleGraph().nodes.map((n) => ({ ...n, status: 'ok' as const, detail: 'ok' })),
    });
    const review = reviewAppGraph(graph);
    expect(review.overallStatus).toBe('ok');
    expect(buildReviewNarrative(graph, findFrontierFailure(graph), 'ok')).toContain('healthy');
  });
});
