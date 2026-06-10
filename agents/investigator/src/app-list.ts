/**
 * Discover logical applications from cluster labels + catalog.
 */

import * as k8s from '@kubernetes/client-node';
import { existsSync } from 'node:fs';
import type { AppCatalogMember } from '../../../shared/src/app-catalog.js';
import {
  buildHelmInstanceCatalogGroups,
  groupDeploymentsToApps,
  matchDeploymentsForApp,
  mergeDiscoveredAppsWithCatalog,
  type AppListEntry,
  type DeploymentAppInput,
} from '../../../shared/src/app-discovery.js';
import { listCatalogEntries, upsertAutoCatalogEntry } from './app-catalog-store.js';

export type { AppListEntry, AppListSource } from '../../../shared/src/app-discovery.js';

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

const appsV1Api = buildKubeConfig().makeApiClient(k8s.AppsV1Api);

function formatK8sApiError(err: unknown): string {
  const body = (err as { body?: { message?: string } })?.body?.message;
  if (body) return body;
  return String(err).slice(0, 240);
}

function toDeploymentInput(dep: k8s.V1Deployment): DeploymentAppInput {
  return {
    name: dep.metadata?.name ?? '',
    namespace: dep.metadata?.namespace ?? 'default',
    annotations: dep.metadata?.annotations,
    labels: dep.metadata?.labels,
  };
}

async function syncHelmInstanceCatalog(allDeps: k8s.V1Deployment[]): Promise<void> {
  const inputs = allDeps.map(toDeploymentInput);
  for (const g of buildHelmInstanceCatalogGroups(inputs)) {
    await upsertAutoCatalogEntry({
      appId: g.appId,
      namespace: g.namespace,
      members: g.members,
    });
  }
}

/** List applications (auto-discovered + catalog), optionally filtered by namespace. */
export async function listApps(namespace?: string): Promise<{
  apps: AppListEntry[];
  namespaces: string[];
  clusterReachable: boolean;
  error?: string;
}> {
  try {
    const depsRes = await appsV1Api.listDeploymentForAllNamespaces();
    const allDeps = depsRes.body.items ?? [];
    await syncHelmInstanceCatalog(allDeps);

    const inputs = allDeps.map(toDeploymentInput);
    const discovered = groupDeploymentsToApps(inputs, namespace);
    const stored = await listCatalogEntries();
    const { apps, namespaces } = mergeDiscoveredAppsWithCatalog(discovered, stored, namespace);

    return { apps, namespaces, clusterReachable: true };
  } catch (err) {
    return {
      apps: [],
      namespaces: [],
      clusterReachable: false,
      error: formatK8sApiError(err),
    };
  }
}

export async function resolveMatchedDeployments(
  allDeps: k8s.V1Deployment[],
  appId: string,
  namespace: string
): Promise<{ matched: k8s.V1Deployment[]; namespace: string }> {
  const { getCatalogEntry } = await import('./app-catalog-store.js');
  const catalog = await getCatalogEntry(namespace, appId);
  const inputs = allDeps.map(toDeploymentInput);
  const { matched, namespace: resolvedNs } = matchDeploymentsForApp(
    inputs,
    appId,
    namespace,
    catalog?.members
  );
  const byName = new Map(inputs.map((d) => [`${d.namespace}/${d.name}`, d]));
  const matchedDeps = matched
    .map((d) => allDeps.find((dep) => dep.metadata?.name === d.name && (dep.metadata?.namespace ?? 'default') === d.namespace))
    .filter(Boolean) as k8s.V1Deployment[];
  return { matched: matchedDeps, namespace: resolvedNs };
}

export { buildHelmInstanceCatalogGroups, groupDeploymentsToApps, matchDeploymentsForApp };
