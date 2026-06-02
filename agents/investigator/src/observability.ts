/**
 * Phase D — Loki/Prometheus queries with Kubernetes fallback.
 */

import {
  queryLokiLogs,
  queryPrometheusMetrics,
  type LogQueryRequest,
  type MetricsQueryRequest,
} from '../../../shared/src/observability-query.js';
import { gatherPodFacts } from './k8s-facts.js';

export async function queryLogs(req: LogQueryRequest): Promise<{
  lines: string[];
  source: string;
  truncated: boolean;
}> {
  const loki = await queryLokiLogs(req);
  if (loki && loki.lines.length > 0) {
    return loki;
  }

  if (req.namespace && req.podName) {
    const facts = await gatherPodFacts(
      req.namespace,
      req.podName,
      req.podName,
      'Pod',
      req.incidentId
    );
    const lines = (facts.currentLogs ?? '')
      .split('\n')
      .filter(Boolean)
      .slice(-(req.limit ?? 100));
    return { lines, source: 'kubernetes', truncated: lines.length >= (req.limit ?? 100) };
  }

  return { lines: [], source: 'none', truncated: false };
}

export async function queryMetrics(req: MetricsQueryRequest): Promise<{
  summary: string;
  source: string;
  samples: Array<{ metric: string; value: string }>;
  findings: string[];
}> {
  const prom = await queryPrometheusMetrics(req);
  if (prom) return prom;

  return {
    source: 'none',
    samples: [],
    findings: [],
    summary: 'No metrics backend configured (set PROMETHEUS_URL) and no K8s fallback for this query.',
  };
}
