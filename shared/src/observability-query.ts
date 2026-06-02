/**
 * Phase D — observability query helpers (Loki/Prometheus; optional backends).
 * Code gathers facts — LLM never calls these directly (Holmes-style data plane).
 */

import { pickSignalLogLines } from './log-excerpt.js';

export interface LogQueryRequest {
  namespace?: string;
  podName?: string;
  deployment?: string;
  labelSelector?: string;
  sinceMinutes?: number;
  limit?: number;
  incidentId: string;
}

export interface LogQueryResult {
  lines: string[];
  source: 'kubernetes' | 'loki' | 'none';
  truncated: boolean;
}

export interface MetricsQueryRequest {
  namespace?: string;
  deployment?: string;
  podName?: string;
  incidentId: string;
}

export interface MetricsQueryResult {
  summary: string;
  source: 'prometheus' | 'kubernetes' | 'none';
  samples: Array<{ metric: string; value: string }>;
  findings: string[];
}

const LOKI_URL = process.env['LOKI_URL'] ?? '';
const PROMETHEUS_URL = process.env['PROMETHEUS_URL'] ?? '';
const LOKI_MAX_LINES = parseInt(process.env['LOKI_MAX_LINES'] ?? '120', 10);

function lokiBase(): string {
  return LOKI_URL.replace(/\/$/, '');
}

function promBase(): string {
  return PROMETHEUS_URL.replace(/\/$/, '');
}

function buildLokiQuery(req: LogQueryRequest): string | null {
  if (req.labelSelector) return `{${req.labelSelector}}`;
  if (req.namespace && req.podName) {
    return `{namespace="${req.namespace}", pod="${req.podName}"}`;
  }
  if (req.namespace && req.deployment) {
    return `{namespace="${req.namespace}", app="${req.deployment}"}`;
  }
  if (req.namespace) return `{namespace="${req.namespace}"}`;
  return null;
}

export async function queryLokiLogs(req: LogQueryRequest): Promise<LogQueryResult | null> {
  if (!LOKI_URL) return null;
  const query = buildLokiQuery(req);
  if (!query) return null;

  const since = (req.sinceMinutes ?? 30) * 60;
  const limit = req.limit ?? LOKI_MAX_LINES;
  const url = `${lokiBase()}/loki/api/v1/query_range?query=${encodeURIComponent(query)}&limit=${limit}&since=${since}s`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: { result?: Array<{ values?: Array<[string, string]> }> };
    };
    const raw: string[] = [];
    for (const stream of data.data?.result ?? []) {
      for (const [, line] of stream.values ?? []) {
        raw.push(line);
      }
    }
    const lines = pickSignalLogLines(raw, limit);
    return { lines, source: 'loki', truncated: raw.length > lines.length };
  } catch {
    return null;
  }
}

async function promInstant(query: string): Promise<Array<{ labels: Record<string, string>; value: string }>> {
  if (!PROMETHEUS_URL) return [];
  const url = `${promBase()}/api/v1/query?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    data?: { result?: Array<{ metric?: Record<string, string>; value?: [number, string] }> };
  };
  return (data.data?.result ?? []).map((r) => ({
    labels: r.metric ?? {},
    value: r.value?.[1] ?? '?',
  }));
}

export async function queryPrometheusMetrics(req: MetricsQueryRequest): Promise<MetricsQueryResult | null> {
  if (!PROMETHEUS_URL || !req.namespace) return null;

  const ns = req.namespace;
  const dep = req.deployment ?? req.podName;
  const findings: string[] = [];
  const samples: Array<{ metric: string; value: string }> = [];

  const queries: Array<{ name: string; promql: string }> = [
    {
      name: 'replicas_available',
      promql: `kube_deployment_status_replicas_available{namespace="${ns}"${dep ? `,deployment="${dep}"` : ''}}`,
    },
    {
      name: 'replicas_unavailable',
      promql: `kube_deployment_status_replicas_unavailable{namespace="${ns}"${dep ? `,deployment="${dep}"` : ''}}`,
    },
    {
      name: 'container_restarts',
      promql: `sum by (pod) (kube_pod_container_status_restarts_total{namespace="${ns}"${dep ? `,pod=~"${dep}.*"` : ''}})`,
    },
  ];

  for (const q of queries) {
    const rows = await promInstant(q.promql);
    for (const row of rows.slice(0, 5)) {
      const label = row.labels.deployment ?? row.labels.pod ?? q.name;
      samples.push({ metric: `${q.name}/${label}`, value: row.value });
      const num = parseFloat(row.value);
      if (q.name === 'replicas_unavailable' && num > 0) {
        findings.push(`${label}: ${num} unavailable replica(s)`);
      }
      if (q.name === 'container_restarts' && num > 0) {
        findings.push(`${label}: ${num} container restart(s) (Prometheus)`);
      }
    }
  }

  if (samples.length === 0) {
    return {
      source: 'prometheus',
      samples: [],
      findings: [],
      summary: 'Prometheus reachable but no matching kube-state-metrics series for this workload.',
    };
  }

  const summary =
    findings.length > 0
      ? findings.join('; ')
      : samples.map((s) => `${s.metric}=${s.value}`).slice(0, 6).join(', ');

  return { source: 'prometheus', samples, findings, summary };
}

export function observabilityBackendsConfigured(): { loki: boolean; prometheus: boolean } {
  return { loki: Boolean(LOKI_URL), prometheus: Boolean(PROMETHEUS_URL) };
}
