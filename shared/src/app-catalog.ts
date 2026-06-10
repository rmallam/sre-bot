/**
 * Application catalog — auto-discovered + user-curated app definitions.
 */

import type { ResourceKind } from './types.js';

export type AppCatalogSource = 'auto' | 'user' | 'annotation' | 'helm-instance' | 'part-of' | 'catalog';

export interface AppCatalogMember {
  resourceKind: ResourceKind;
  resourceName: string;
}

export interface AppCatalogEntry {
  appId: string;
  namespace: string;
  displayName?: string;
  source: AppCatalogSource;
  members: AppCatalogMember[];
  /** Comma-separated service/host dependencies (sre.bot/depends-on style). */
  dependsOn?: string[];
  updatedAt: string;
  userEdited?: boolean;
}

export function catalogKey(namespace: string, appId: string): string {
  return `${namespace}|${appId}`.toLowerCase();
}

export function mergeCatalogEntries(
  auto: AppCatalogEntry[],
  user: AppCatalogEntry[]
): AppCatalogEntry[] {
  const byKey = new Map<string, AppCatalogEntry>();
  for (const e of auto) {
    byKey.set(catalogKey(e.namespace, e.appId), e);
  }
  for (const e of user) {
    const key = catalogKey(e.namespace, e.appId);
    const prev = byKey.get(key);
    if (prev?.userEdited && !e.userEdited) continue;
    byKey.set(key, { ...prev, ...e, members: e.members.length ? e.members : prev?.members ?? [] });
  }
  return [...byKey.values()].sort((a, b) =>
    a.namespace === b.namespace ? a.appId.localeCompare(b.appId) : a.namespace.localeCompare(b.namespace)
  );
}
