/**
 * Resolve vague workload hints → Deployment/StatefulSet + real pod name.
 */

import * as k8s from '@kubernetes/client-node';
import { existsSync } from 'node:fs';
import type { ResourceKind } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';

const AGENT = 'investigator';

export const AUTO_CONFIRM_SCORE = 85;
export const MIN_CANDIDATE_SCORE = 45;

export interface WorkloadCandidate {
  namespace: string;
  resourceKind: ResourceKind;
  resourceName: string;
  podName?: string;
  label: string;
  score: number;
  ready?: string;
  phase?: string;
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

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + cost);
      prev = row[j]!;
      row[j] = next;
    }
  }
  return row[n]!;
}

/** Exported for unit tests (typo-tolerant matching). */
export function scoreWorkloadHint(hint: string, candidate: string): number {
  const h = normalizeName(hint);
  const c = normalizeName(candidate);
  if (!h || !c) return 0;
  if (c === h) return 100;
  if (c.includes(h) || h.includes(c)) return 80;
  if (c.startsWith(h) || h.startsWith(c)) return 65;
  const dist = levenshtein(h, c);
  const maxLen = Math.max(h.length, c.length);
  if (maxLen <= 12 && dist === 1) return 82;
  if (maxLen >= 4 && dist === 2 && Math.abs(h.length - c.length) <= 1) return 72;
  return 0;
}

function labelSelectorFromLabels(labels: Record<string, string> | undefined): string | undefined {
  if (!labels || Object.keys(labels).length === 0) return undefined;
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

function podReadySummary(pod: k8s.V1Pod): { ready: string; phase: string } {
  const statuses = pod.status?.containerStatuses ?? [];
  const ready = statuses.filter((s) => s.ready).length;
  const total = statuses.length;
  return {
    ready: total > 0 ? `${ready}/${total}` : '?',
    phase: pod.status?.phase ?? 'Unknown',
  };
}

/**
 * Find a pod for a Deployment using its selector, then name-prefix fallback.
 */
export async function resolvePodForWorkload(
  namespace: string,
  resourceName: string,
  resourceKind: ResourceKind,
  incidentId: string
): Promise<string | null> {
  if (resourceKind === 'Pod') {
    try {
      await coreV1.readNamespacedPod(resourceName, namespace);
      return resourceName;
    } catch {
      return null;
    }
  }

  if (resourceKind === 'Deployment') {
    try {
      const depRes = await appsV1.readNamespacedDeployment(resourceName, namespace);
      const dep = depRes.body;
      const selector = labelSelectorFromLabels(dep.spec?.selector?.matchLabels);
      if (selector) {
        const podsRes = await coreV1.listNamespacedPod(
          namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          selector
        );
        const items = podsRes.body.items ?? [];
        const unhealthy = items.find((p) =>
          (p.status?.containerStatuses ?? []).some((c) => !c.ready || c.state?.waiting)
        );
        const pick = unhealthy ?? items.find((p) => p.status?.phase === 'Running') ?? items[0];
        if (pick?.metadata?.name) {
          log('info', AGENT, 'Resolved pod via deployment selector', {
            incidentId,
            namespace,
            resourceName,
            podName: pick.metadata.name,
            selector,
          });
          return pick.metadata.name;
        }
      }
    } catch (err) {
      log('warn', AGENT, 'Deployment selector pod lookup failed', {
        incidentId,
        namespace,
        resourceName,
        error: String(err),
      });
    }

    try {
      const podsRes = await coreV1.listNamespacedPod(namespace);
      const prefix = `${resourceName}-`;
      const matches = (podsRes.body.items ?? []).filter((p) =>
        p.metadata?.name?.startsWith(prefix)
      );
      const unhealthy = matches.find((p) =>
        (p.status?.containerStatuses ?? []).some((c) => !c.ready || c.state?.waiting)
      );
      const pick = unhealthy ?? matches.find((p) => p.status?.phase === 'Running') ?? matches[0];
      if (pick?.metadata?.name) {
        log('info', AGENT, 'Resolved pod via deployment name prefix', {
          incidentId,
          namespace,
          resourceName,
          podName: pick.metadata.name,
        });
        return pick.metadata.name;
      }
    } catch (err) {
      log('warn', AGENT, 'Pod prefix lookup failed', { incidentId, error: String(err) });
    }
  }

  if (resourceKind === 'StatefulSet') {
    try {
      const stsRes = await appsV1.readNamespacedStatefulSet(resourceName, namespace);
      const sts = stsRes.body;
      const selector = labelSelectorFromLabels(sts.spec?.selector?.matchLabels);
      if (selector) {
        const podsRes = await coreV1.listNamespacedPod(
          namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          selector
        );
        const items = podsRes.body.items ?? [];
        const unhealthy = items.find((p) =>
          (p.status?.containerStatuses ?? []).some((c) => !c.ready || c.state?.waiting)
        );
        const pick = unhealthy ?? items[0];
        if (pick?.metadata?.name) {
          log('info', AGENT, 'Resolved pod via statefulset selector', {
            incidentId,
            namespace,
            resourceName,
            podName: pick.metadata.name,
          });
          return pick.metadata.name;
        }
      }
    } catch (err) {
      log('warn', AGENT, 'StatefulSet pod lookup failed', {
        incidentId,
        namespace,
        resourceName,
        error: String(err),
      });
    }

    // StatefulSet pods: name-0, name-1, …
    const ordinalPod = `${resourceName}-0`;
    try {
      await coreV1.readNamespacedPod(ordinalPod, namespace);
      return ordinalPod;
    } catch {
      /* fall through */
    }
  }

  return null;
}

export async function resolveDeploymentByHint(
  hint: string,
  preferredNamespace: string | undefined,
  incidentId: string
): Promise<{ namespace: string; resourceName: string; resourceKind: ResourceKind } | null> {
  const candidates = await resolveWorkloadCandidates(hint, preferredNamespace, incidentId, 1);
  const top = candidates[0];
  if (!top || top.score < MIN_CANDIDATE_SCORE) return null;
  return {
    namespace: top.namespace,
    resourceName: top.resourceName,
    resourceKind: top.resourceKind,
  };
}

/**
 * Rank workloads matching a human hint (deployment/statefulset names, optional pod name).
 */
export async function resolveWorkloadCandidates(
  hint: string,
  preferredNamespace: string | undefined,
  incidentId: string,
  limit = 5
): Promise<WorkloadCandidate[]> {
  const trimmed = hint.trim();
  const browseMode = trimmed.length === 0;

  const results: WorkloadCandidate[] = [];

  try {
    const [deploymentsRes, stsRes, podsRes] = await Promise.all([
      preferredNamespace && preferredNamespace !== '_all'
        ? appsV1.listNamespacedDeployment(preferredNamespace)
        : appsV1.listDeploymentForAllNamespaces(),
      preferredNamespace && preferredNamespace !== '_all'
        ? appsV1.listNamespacedStatefulSet(preferredNamespace)
        : appsV1ApiListStatefulSets(),
      preferredNamespace && preferredNamespace !== '_all'
        ? coreV1.listNamespacedPod(preferredNamespace)
        : coreV1.listPodForAllNamespaces(),
    ]);

    const deployments = deploymentsRes.body.items ?? [];
    const statefulSets = stsRes.body.items ?? [];
    const pods = podsRes.body.items ?? [];

    for (const dep of deployments) {
      const ns = dep.metadata?.namespace ?? 'default';
      const name = dep.metadata?.name ?? '';
      if (!name) continue;
      let score = browseMode ? 50 : scoreWorkloadHint(trimmed, name);
      if (preferredNamespace && preferredNamespace !== '_all' && ns === preferredNamespace) {
        score += 10;
      }
      const desired = dep.status?.replicas ?? 0;
      const ready = dep.status?.readyReplicas ?? 0;
      if (browseMode || score >= MIN_CANDIDATE_SCORE) {
        results.push({
          namespace: ns,
          resourceKind: 'Deployment',
          resourceName: name,
          label: `${ns}/${name} (${ready}/${desired} ready)`,
          score,
          ready: `${ready}/${desired}`,
        });
      }
    }

    for (const sts of statefulSets) {
      const ns = sts.metadata?.namespace ?? 'default';
      const name = sts.metadata?.name ?? '';
      if (!name) continue;
      let score = (browseMode ? 45 : scoreWorkloadHint(trimmed, name)) - 5;
      if (preferredNamespace && preferredNamespace !== '_all' && ns === preferredNamespace) {
        score += 10;
      }
      if (browseMode || score >= MIN_CANDIDATE_SCORE) {
        results.push({
          namespace: ns,
          resourceKind: 'StatefulSet',
          resourceName: name,
          label: `${ns}/${name} (StatefulSet)`,
          score,
        });
      }
    }

    for (const pod of pods) {
      const ns = pod.metadata?.namespace ?? 'default';
      const name = pod.metadata?.name ?? '';
      if (!name) continue;
      let score = browseMode ? 40 : scoreWorkloadHint(trimmed, name);
      if (browseMode || score >= 70) {
        const { ready, phase } = podReadySummary(pod);
        results.push({
          namespace: ns,
          resourceKind: 'Pod',
          resourceName: name,
          podName: name,
          label: `${ns}/pod ${name} (${phase}, ${ready})`,
          score: browseMode ? score : Math.min(100, score + 5),
          ready,
          phase,
        });
      }
    }

    dropPodsOwnedByMatchingControllers(results, trimmed);

    results.sort((a, b) => b.score - a.score);

    // Prefer Deployment/StatefulSet over Pod when the hint matches a controller name.
    if (!browseMode && trimmed) {
      const h = normalizeName(trimmed);
      const topController = results.find(
        (r) =>
          (r.resourceKind === 'Deployment' || r.resourceKind === 'StatefulSet') &&
          normalizeName(r.resourceName) === h
      );
      if (topController) {
        const filtered = results.filter(
          (r) =>
            r.resourceKind !== 'Pod' ||
            !r.resourceName.startsWith(`${topController.resourceName}-`)
        );
        results.length = 0;
        results.push(...filtered);
        results.sort((a, b) => b.score - a.score);
      }
    }

    const top = results.slice(0, limit);

    for (const c of top) {
      if (!c.podName && c.resourceKind !== 'Pod') {
        c.podName =
          (await resolvePodForWorkload(c.namespace, c.resourceName, c.resourceKind, incidentId)) ??
          undefined;
      }
    }

    log('info', AGENT, 'Workload candidates resolved', {
      incidentId,
      hint: trimmed,
      count: top.length,
      top: top.map((c) => ({ label: c.label, score: c.score })),
    });

    return top;
  } catch (err) {
    log('warn', AGENT, 'resolveWorkloadCandidates failed', { incidentId, error: String(err) });
    return [];
  }
}

async function appsV1ApiListStatefulSets(): Promise<{ body: k8s.V1StatefulSetList }> {
  return appsV1.listStatefulSetForAllNamespaces();
}

/** Pods that belong to a matching Deployment/STS should not prompt as separate targets. */
function dropPodsOwnedByMatchingControllers(results: WorkloadCandidate[], hint: string): void {
  if (!hint.trim()) return;
  const controllers = results.filter(
    (r) => r.resourceKind === 'Deployment' || r.resourceKind === 'StatefulSet'
  );
  const matching = controllers.filter((c) => scoreWorkloadHint(hint, c.resourceName) >= 65);
  if (matching.length === 0) return;
  const names = matching.map((c) => c.resourceName);
  const kept = results.filter((r) => {
    if (r.resourceKind !== 'Pod') return true;
    return !names.some((cn) => r.resourceName.startsWith(`${cn}-`));
  });
  results.length = 0;
  results.push(...kept);
}

export function needsUserConfirmation(candidates: WorkloadCandidate[]): boolean {
  if (candidates.length === 0) return false;
  if (candidates.length === 1) return candidates[0]!.score < AUTO_CONFIRM_SCORE;
  const top = candidates[0]!;
  const second = candidates[1];
  if (top.score >= AUTO_CONFIRM_SCORE && (!second || top.score - second.score >= 15)) {
    return false;
  }
  return true;
}
