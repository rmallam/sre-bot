/**
 * Discover workloads created by a Helm release / deploy (Layer 2 + 3).
 */

import * as k8s from '@kubernetes/client-node';
import { existsSync } from 'node:fs';
import type { DeployReleaseTargets, DeployWorkloadRef } from '../../../shared/src/deploy-workloads.js';
import type { ResourceKind } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { scoreWorkloadHint } from './workload-resolve.js';

const AGENT = 'investigator';
const NAME_PREFIX_MATCH_SCORE = 45;

function buildKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token')) {
    try {
      kc.loadFromCluster();
    } catch {
      kc.loadFromDefault();
    }
  } else {
    kc.loadFromDefault();
  }
  return kc;
}

const kc = buildKubeConfig();
const appsApi = kc.makeApiClient(k8s.AppsV1Api);

function labelSelectorFromLabels(labels: Record<string, string> | undefined): string | undefined {
  if (!labels || Object.keys(labels).length === 0) return undefined;
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

function pushWorkload(
  out: DeployWorkloadRef[],
  seen: Set<string>,
  namespace: string,
  resourceKind: ResourceKind,
  resourceName: string
): void {
  const key = `${namespace}/${resourceKind}/${resourceName}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ namespace, resourceKind, resourceName });
}

async function listByHelmInstanceLabel(
  namespace: string,
  releaseName: string
): Promise<DeployWorkloadRef[]> {
  const selector = labelSelectorFromLabels({
    'app.kubernetes.io/instance': releaseName,
  });
  if (!selector) return [];

  const out: DeployWorkloadRef[] = [];
  const seen = new Set<string>();

  const [deployRes, stsRes] = await Promise.all([
    appsApi.listNamespacedDeployment(namespace, undefined, undefined, undefined, undefined, selector),
    appsApi.listNamespacedStatefulSet(namespace, undefined, undefined, undefined, undefined, selector),
  ]);

  for (const dep of deployRes.body.items ?? []) {
    const name = dep.metadata?.name;
    if (name) pushWorkload(out, seen, namespace, 'Deployment', name);
  }
  for (const sts of stsRes.body.items ?? []) {
    const name = sts.metadata?.name;
    if (name) pushWorkload(out, seen, namespace, 'StatefulSet', name);
  }

  return out;
}

async function listByNamePrefixHint(
  namespace: string,
  releaseName: string
): Promise<DeployWorkloadRef[]> {
  const out: DeployWorkloadRef[] = [];
  const seen = new Set<string>();

  const [deployRes, stsRes] = await Promise.all([
    appsApi.listNamespacedDeployment(namespace),
    appsApi.listNamespacedStatefulSet(namespace),
  ]);

  for (const dep of deployRes.body.items ?? []) {
    const name = dep.metadata?.name ?? '';
    if (!name) continue;
    if (scoreWorkloadHint(releaseName, name) >= NAME_PREFIX_MATCH_SCORE) {
      pushWorkload(out, seen, namespace, 'Deployment', name);
    }
  }
  for (const sts of stsRes.body.items ?? []) {
    const name = sts.metadata?.name ?? '';
    if (!name) continue;
    if (scoreWorkloadHint(releaseName, name) >= NAME_PREFIX_MATCH_SCORE) {
      pushWorkload(out, seen, namespace, 'StatefulSet', name);
    }
  }

  return out.sort((a, b) => a.resourceName.localeCompare(b.resourceName));
}

/** Layer 2 (Helm instance label) then Layer 3 (name-prefix scoring). */
export async function discoverReleaseWorkloads(
  namespace: string,
  releaseName: string,
  incidentId: string
): Promise<DeployReleaseTargets> {
  const at = new Date().toISOString();

  try {
    await appsApi.readNamespacedDeployment(releaseName, namespace);
    return {
      releaseName,
      namespace,
      workloads: [{ namespace, resourceKind: 'Deployment', resourceName: releaseName }],
      discoveredAt: at,
      discoveryMethod: 'exact',
    };
  } catch {
    /* not an exact deployment name — continue discovery */
  }

  const byLabel = await listByHelmInstanceLabel(namespace, releaseName);
  if (byLabel.length > 0) {
    log('info', AGENT, 'Discovered workloads by Helm instance label', {
      incidentId,
      namespace,
      releaseName,
      count: byLabel.length,
      names: byLabel.map((w) => w.resourceName),
    });
    return {
      releaseName,
      namespace,
      workloads: byLabel,
      discoveredAt: at,
      discoveryMethod: 'helm-instance-label',
    };
  }

  const byPrefix = await listByNamePrefixHint(namespace, releaseName);
  log('info', AGENT, 'Discovered workloads by release name prefix', {
    incidentId,
    namespace,
    releaseName,
    count: byPrefix.length,
    names: byPrefix.map((w) => w.resourceName),
  });
  return {
    releaseName,
    namespace,
    workloads: byPrefix,
    discoveredAt: at,
    discoveryMethod: 'name-prefix',
  };
}
