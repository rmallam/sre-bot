/**
 * Deploy source registry — pgvector-backed mapping of workload → Git/Helm source.
 */

import { log } from './http.js';
import {
  deploySourceRegistryKey,
  formatDeploySourceRegistryMarkdown,
  provenanceFromRegistryMarkdown,
  type DeployProvenance,
} from './deploy-provenance.js';
import { platformEnabled, ragLearningEnabled } from './platform-client.js';
import type { ResourceKind } from './types.js';

const REGISTRY_COMPONENT = 'gitops';

export async function lookupDeploySourceRegistry(
  namespace: string,
  resourceKind: ResourceKind | string,
  resourceName: string,
  incidentId = 'registry-lookup'
): Promise<Partial<DeployProvenance> | null> {
  if (!platformEnabled()) return null;

  const key = deploySourceRegistryKey(namespace, resourceKind, resourceName);
  const platformUrl = (process.env['SRE_PLATFORM_URL'] ?? process.env['PLATFORM_URL'] ?? '').replace(
    /\/$/,
    ''
  );
  if (!platformUrl) return null;

  try {
    const params = new URLSearchParams({
      namespace,
      resource_kind: resourceKind,
      resource_name: resourceName,
    });
    const res = await fetch(`${platformUrl}/registry/deploy-source?${params}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { found?: boolean; playbook_markdown?: string };
    if (!data.found || !data.playbook_markdown) return null;
    return provenanceFromRegistryMarkdown(data.playbook_markdown, key);
  } catch (err) {
    log('debug', 'deploy-source-registry', 'lookup failed', {
      incidentId,
      key,
      error: String(err),
    });
    return null;
  }
}

export async function saveDeploySourceRegistry(
  namespace: string,
  resourceKind: ResourceKind | string,
  resourceName: string,
  provenance: DeployProvenance,
  runId?: string
): Promise<boolean> {
  if (!platformEnabled() || !ragLearningEnabled()) return false;

  const key = deploySourceRegistryKey(namespace, resourceKind, resourceName);
  const markdown = formatDeploySourceRegistryMarkdown(
    namespace,
    resourceKind,
    resourceName,
    provenance
  );
  const platformUrl = (process.env['SRE_PLATFORM_URL'] ?? process.env['PLATFORM_URL'] ?? '').replace(
    /\/$/,
    ''
  );
  if (!platformUrl) return false;

  try {
    const res = await fetch(`${platformUrl}/registry/deploy-source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace,
        resource_kind: resourceKind,
        resource_name: resourceName,
        playbook_markdown: markdown,
        run_id: runId,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      log('warn', 'deploy-source-registry', 'save failed', { key, status: res.status });
      return false;
    }
    log('info', 'deploy-source-registry', 'saved deploy source', { key, runId });
    return true;
  } catch (err) {
    log('warn', 'deploy-source-registry', 'save error', { key, error: String(err) });
    return false;
  }
}
