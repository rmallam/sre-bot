/**
 * Deploy release → workload mapping (Layer 4 metadata + verify input).
 */

import type { ResourceKind } from './types.js';

export type DeployWorkloadDiscoveryMethod =
  | 'recorded'
  | 'helm-instance-label'
  | 'name-prefix'
  | 'exact';

export interface DeployWorkloadRef {
  namespace: string;
  resourceKind: ResourceKind;
  resourceName: string;
}

export interface DeployReleaseTargets {
  releaseName: string;
  namespace: string;
  workloads: DeployWorkloadRef[];
  discoveredAt: string;
  discoveryMethod: DeployWorkloadDiscoveryMethod;
}

export function flattenDeployWorkloads(
  targets: DeployReleaseTargets | DeployReleaseTargets[] | undefined
): DeployWorkloadRef[] {
  if (!targets) return [];
  const list = Array.isArray(targets) ? targets : [targets];
  const out: DeployWorkloadRef[] = [];
  const seen = new Set<string>();
  for (const t of list) {
    for (const w of t.workloads ?? []) {
      const key = `${w.namespace}/${w.resourceKind}/${w.resourceName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(w);
    }
  }
  return out;
}

export function parseDeployReleaseTargets(
  metadata: Record<string, unknown> | undefined
): DeployReleaseTargets | DeployReleaseTargets[] | undefined {
  if (!metadata?.deployReleaseTargets) return undefined;
  return metadata.deployReleaseTargets as DeployReleaseTargets | DeployReleaseTargets[];
}

export function mergeDeployReleaseTargets(
  existing: DeployReleaseTargets | DeployReleaseTargets[] | undefined,
  next: DeployReleaseTargets
): DeployReleaseTargets[] {
  const prev = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  const without = prev.filter(
    (t) => !(t.namespace === next.namespace && t.releaseName === next.releaseName)
  );
  return [...without, next];
}
