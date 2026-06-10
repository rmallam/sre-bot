/**
 * Cross-workload alert correlation — group firing alerts by shared dependency bindings.
 */

import type { ResourceKind } from './types.js';

export interface CorrelatedWorkloadRef {
  namespace: string;
  resourceKind: ResourceKind;
  resourceName: string;
  podName?: string;
  alertname?: string;
  summary?: string;
}

export interface ParsedAlertTarget {
  namespace: string;
  resourceName: string;
  resourceKind: ResourceKind;
  podName?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  fingerprint: string;
  alertname: string;
  summary: string;
}

export interface AlertCorrelationGroup {
  correlationKey: string;
  primary: CorrelatedWorkloadRef;
  affectedWorkloads: CorrelatedWorkloadRef[];
  eventMessage: string;
  eventReason: string;
}

const DEPENDENCY_LABEL_KEYS = [
  'dependency',
  'cnpg_cluster',
  'database',
  'broker',
  'cluster',
  'instance',
  'service',
  'target',
  'job',
  'topic',
  'redis',
  'postgres',
] as const;

export function correlationKeyFromLabels(labels: Record<string, string>): string | null {
  const graph = labels['sre-graph-binding']?.trim();
  if (graph) return graph;

  for (const key of DEPENDENCY_LABEL_KEYS) {
    const val = labels[key]?.trim();
    if (val) return `${key}:${val.toLowerCase()}`;
  }
  const alertname = labels['alertname']?.trim();
  const ns = (labels['namespace'] ?? labels['kubernetes_namespace'])?.trim();
  if (alertname && ns) return `symptom:${ns.toLowerCase()}:${alertname.toLowerCase()}`;
  return null;
}

export function workloadKey(w: Pick<CorrelatedWorkloadRef, 'namespace' | 'resourceKind' | 'resourceName'>): string {
  return `${w.namespace}/${w.resourceKind}/${w.resourceName}`.toLowerCase();
}

function pickPrimary(workloads: CorrelatedWorkloadRef[]): CorrelatedWorkloadRef {
  const sorted = [...workloads].sort((a, b) =>
    workloadKey(a).localeCompare(workloadKey(b))
  );
  const dependencyAlert = sorted.find((w) =>
    /postgres|redis|kafka|rabbit|mysql|mongo|broker|database|cnpg|dependency/i.test(
      w.alertname ?? w.summary ?? ''
    )
  );
  return dependencyAlert ?? sorted[0]!;
}

export function groupParsedAlerts(
  alerts: ParsedAlertTarget[],
  opts?: { minGroupSize?: number }
): AlertCorrelationGroup[] {
  const minGroup = opts?.minGroupSize ?? 1;
  const buckets = new Map<string, CorrelatedWorkloadRef[]>();

  for (const alert of alerts) {
    const key = correlationKeyFromLabels(alert.labels);
    if (!key) continue;
    const ref: CorrelatedWorkloadRef = {
      namespace: alert.namespace,
      resourceKind: alert.resourceKind,
      resourceName: alert.resourceName,
      podName: alert.podName,
      alertname: alert.alertname,
      summary: alert.summary,
    };
    const list = buckets.get(key) ?? [];
    if (!list.some((w) => workloadKey(w) === workloadKey(ref))) list.push(ref);
    buckets.set(key, list);
  }

  const groups: AlertCorrelationGroup[] = [];
  for (const [correlationKey, workloads] of buckets) {
    if (workloads.length < minGroup) continue;
    const primary = pickPrimary(workloads);
    const summaries = workloads.map((w) => w.summary).filter(Boolean);
    groups.push({
      correlationKey,
      primary,
      affectedWorkloads: workloads,
      eventReason: primary.alertname ?? 'AlertManager',
      eventMessage:
        workloads.length > 1
          ? `Correlated incident (${workloads.length} workloads): ${summaries.slice(0, 3).join('; ')}`
          : (summaries[0] ?? primary.alertname ?? 'Alert firing'),
    });
  }
  return groups;
}

/** Merge alerts without correlation keys as single-workload groups. */
export function buildAlertRunGroups(
  alerts: ParsedAlertTarget[],
  opts?: { minGroupSize?: number }
): AlertCorrelationGroup[] {
  const grouped = groupParsedAlerts(alerts, opts);
  const groupedKeys = new Set(
    alerts
      .map((a) => correlationKeyFromLabels(a.labels))
      .filter((k): k is string => !!k)
  );

  const covered = new Set<string>();
  for (const g of grouped) {
    for (const w of g.affectedWorkloads) covered.add(workloadKey(w));
  }

  const singles: AlertCorrelationGroup[] = [];
  for (const alert of alerts) {
    const ref: CorrelatedWorkloadRef = {
      namespace: alert.namespace,
      resourceKind: alert.resourceKind,
      resourceName: alert.resourceName,
      podName: alert.podName,
      alertname: alert.alertname,
      summary: alert.summary,
    };
    const wk = workloadKey(ref);
    if (covered.has(wk)) continue;
    const key = correlationKeyFromLabels(alert.labels) ?? `workload:${wk}`;
    if (groupedKeys.has(key) && grouped.some((g) => g.correlationKey === key)) continue;
    singles.push({
      correlationKey: key,
      primary: ref,
      affectedWorkloads: [ref],
      eventReason: alert.alertname,
      eventMessage: alert.summary,
    });
    covered.add(wk);
  }

  return [...grouped, ...singles];
}

export interface CorrelationWindowEntry {
  correlationKey: string;
  incidentId: string;
  startedAtMs: number;
}

export function mergeWithRecentCorrelation(
  groups: AlertCorrelationGroup[],
  recent: Map<string, CorrelationWindowEntry>,
  windowMs: number,
  nowMs = Date.now()
): { groups: AlertCorrelationGroup[]; reuseIncidentIds: Map<string, string> } {
  const reuseIncidentIds = new Map<string, string>();
  const out: AlertCorrelationGroup[] = [];

  for (const group of groups) {
    const hit = recent.get(group.correlationKey);
    if (hit && nowMs - hit.startedAtMs <= windowMs) {
      reuseIncidentIds.set(group.correlationKey, hit.incidentId);
      continue;
    }
    out.push(group);
  }

  return { groups: out, reuseIncidentIds };
}

export function recordCorrelationWindow(
  recent: Map<string, CorrelationWindowEntry>,
  correlationKey: string,
  incidentId: string,
  windowMs: number,
  nowMs = Date.now()
): void {
  recent.set(correlationKey, { correlationKey, incidentId, startedAtMs: nowMs });
  for (const [key, entry] of recent) {
    if (nowMs - entry.startedAtMs > windowMs) recent.delete(key);
  }
}
