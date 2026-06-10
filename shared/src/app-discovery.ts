/**
 * Pure app discovery / grouping logic (Helm labels, annotations, catalog).
 */

import type { AppCatalogEntry, AppCatalogMember } from './app-catalog.js';

export const APP_ID_ANNOTATION = 'sre.bot/app-id';
export const HELM_INSTANCE_LABEL = 'app.kubernetes.io/instance';
export const PART_OF_LABEL = 'app.kubernetes.io/part-of';

export type AppListSource =
  | 'annotation'
  | 'helm-instance'
  | 'part-of'
  | 'deployment-name'
  | 'catalog'
  | 'auto'
  | 'user';

export interface DeploymentAppInput {
  name: string;
  namespace: string;
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
}

export interface AppListEntry {
  appId: string;
  namespace: string;
  deploymentCount: number;
  source: AppListSource;
  displayName?: string;
  userEdited?: boolean;
  memberNames?: string[];
}

export function resolveDeploymentAppGroup(dep: DeploymentAppInput): {
  appId: string;
  namespace: string;
  source: AppListSource;
} {
  const ns = dep.namespace || 'default';
  const annId = dep.annotations?.[APP_ID_ANNOTATION]?.trim();
  if (annId) {
    return { appId: annId, namespace: ns, source: 'annotation' };
  }
  const instance = dep.labels?.[HELM_INSTANCE_LABEL]?.trim();
  if (instance) {
    return { appId: instance, namespace: ns, source: 'helm-instance' };
  }
  const partOf = dep.labels?.[PART_OF_LABEL]?.trim();
  if (partOf) {
    return { appId: partOf, namespace: ns, source: 'part-of' };
  }
  return { appId: dep.name || 'unknown', namespace: ns, source: 'deployment-name' };
}

export function groupDeploymentsToApps(
  deps: DeploymentAppInput[],
  namespaceFilter?: string
): AppListEntry[] {
  const byKey = new Map<string, AppListEntry & { members: Set<string> }>();

  for (const dep of deps) {
    const ns = dep.namespace || 'default';
    if (namespaceFilter && ns !== namespaceFilter) continue;
    const { appId, source } = resolveDeploymentAppGroup(dep);
    const key = `${ns}|${appId}`.toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      existing.deploymentCount += 1;
      if (dep.name) existing.members.add(dep.name);
    } else {
      byKey.set(key, {
        appId,
        namespace: ns,
        deploymentCount: 1,
        source,
        members: new Set(dep.name ? [dep.name] : []),
      });
    }
  }

  return [...byKey.values()]
    .map((e) => ({
      appId: e.appId,
      namespace: e.namespace,
      deploymentCount: e.deploymentCount,
      source: e.source,
      memberNames: [...e.members],
    }))
    .sort((a, b) =>
      a.namespace === b.namespace ? a.appId.localeCompare(b.appId) : a.namespace.localeCompare(b.namespace)
    );
}

export function catalogEntryToListEntry(entry: AppCatalogEntry): AppListEntry {
  let source: AppListSource = 'catalog';
  if (entry.userEdited) source = 'user';
  else if (entry.source === 'auto') source = 'auto';
  else if (entry.source === 'helm-instance') source = 'helm-instance';
  else if (entry.source === 'annotation') source = 'annotation';
  return {
    appId: entry.appId,
    namespace: entry.namespace,
    deploymentCount: entry.members.length,
    source,
    displayName: entry.displayName,
    userEdited: entry.userEdited,
    memberNames: entry.members.map((m) => m.resourceName),
  };
}

export function mergeDiscoveredAppsWithCatalog(
  discovered: AppListEntry[],
  catalog: AppCatalogEntry[],
  namespaceFilter?: string
): { apps: AppListEntry[]; namespaces: string[] } {
  const appMap = new Map<string, AppListEntry>();
  for (const a of discovered) {
    appMap.set(`${a.namespace}|${a.appId}`.toLowerCase(), a);
  }
  for (const entry of catalog) {
    if (namespaceFilter && entry.namespace !== namespaceFilter) continue;
    const key = `${entry.namespace}|${entry.appId}`.toLowerCase();
    const listEntry = catalogEntryToListEntry(entry);
    const prev = appMap.get(key);
    if (prev) {
      appMap.set(key, {
        ...prev,
        ...listEntry,
        deploymentCount: Math.max(prev.deploymentCount, listEntry.deploymentCount),
        memberNames: listEntry.memberNames?.length ? listEntry.memberNames : prev.memberNames,
      });
    } else {
      appMap.set(key, listEntry);
    }
  }

  const apps = [...appMap.values()].sort((a, b) =>
    a.namespace === b.namespace ? a.appId.localeCompare(b.appId) : a.namespace.localeCompare(b.namespace)
  );
  const namespaces = [...new Set(apps.map((a) => a.namespace))].sort();
  return { apps, namespaces };
}

/** Helm release groups for auto-catalog (skips sre.bot/app-id deployments). */
export function buildHelmInstanceCatalogGroups(
  deps: DeploymentAppInput[]
): Array<{ appId: string; namespace: string; members: AppCatalogMember[] }> {
  const groups = new Map<string, { appId: string; namespace: string; members: AppCatalogMember[] }>();

  for (const dep of deps) {
    const annId = dep.annotations?.[APP_ID_ANNOTATION]?.trim();
    if (annId) continue;
    const instance = dep.labels?.[HELM_INSTANCE_LABEL]?.trim();
    if (!instance || !dep.name) continue;
    const ns = dep.namespace || 'default';
    const key = `${ns}|${instance}`.toLowerCase();
    const g = groups.get(key) ?? { appId: instance, namespace: ns, members: [] };
    g.members.push({ resourceKind: 'Deployment', resourceName: dep.name });
    groups.set(key, g);
  }

  return [...groups.values()];
}

export function matchDeploymentsForApp(
  deps: DeploymentAppInput[],
  appId: string,
  namespace: string,
  catalogMembers?: AppCatalogMember[]
): { matched: DeploymentAppInput[]; namespace: string } {
  const appIdLower = appId.toLowerCase();
  let ns = namespace;

  if (catalogMembers?.length) {
    const matched = deps.filter((d) => {
      const depNs = d.namespace || 'default';
      if (depNs !== ns) return false;
      return catalogMembers.some(
        (m) => m.resourceKind === 'Deployment' && m.resourceName === d.name
      );
    });
    if (matched.length > 0) {
      return { matched, namespace: ns };
    }
  }

  let matched = deps.filter((d) => {
    const depNs = d.namespace || 'default';
    if (depNs !== ns) return false;
    const annAppId = d.annotations?.[APP_ID_ANNOTATION];
    if (annAppId?.toLowerCase() === appIdLower) return true;
    const instance = d.labels?.[HELM_INSTANCE_LABEL];
    if (instance?.toLowerCase() === appIdLower) return true;
    const partOf = d.labels?.[PART_OF_LABEL];
    if (partOf?.toLowerCase() === appIdLower) return true;
    return d.name.toLowerCase() === appIdLower;
  });

  if (matched.length === 0) {
    matched = deps.filter((d) => (d.annotations?.[APP_ID_ANNOTATION] ?? '').toLowerCase() === appIdLower);
    if (matched.length > 0) {
      ns = matched[0]!.namespace || ns;
    }
  }

  if (matched.length === 0) {
    matched = deps.filter((d) => {
      const depNs = d.namespace || 'default';
      if (ns && depNs !== ns) return false;
      return d.labels?.[HELM_INSTANCE_LABEL]?.toLowerCase() === appIdLower;
    });
  }

  return { matched, namespace: ns };
}

export function catalogUpsertFromDeploy(opts: {
  releaseName: string;
  namespace: string;
  members: AppCatalogMember[];
}): Pick<AppCatalogEntry, 'appId' | 'namespace' | 'source' | 'members'> {
  return {
    appId: opts.releaseName,
    namespace: opts.namespace,
    source: 'auto',
    members: opts.members,
  };
}
