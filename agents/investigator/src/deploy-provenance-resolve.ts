/**
 * Resolve deployment provenance from cluster metadata + Git mirror + registry.
 */

import * as k8s from '@kubernetes/client-node';
import { existsSync } from 'node:fs';
import { log } from '../../../shared/src/http.js';
import {
  defaultFixSurface,
  mergeDeployProvenance,
  parseProvenanceFromMetadata,
  type DeployProvenance,
} from '../../../shared/src/deploy-provenance.js';
import { lookupDeploySourceRegistry } from '../../../shared/src/deploy-source-registry.js';
import type { ResourceKind } from '../../../shared/src/types.js';

const AGENT = 'investigator-provenance';

function buildKubeConfig(): k8s.KubeConfig | null {
  try {
    const kc = new k8s.KubeConfig();
    if (existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token')) {
      kc.loadFromCluster();
    } else {
      kc.loadFromDefault();
    }
    return kc;
  } catch {
    return null;
  }
}

async function readWorkloadMetadata(
  namespace: string,
  resourceKind: ResourceKind,
  resourceName: string,
  incidentId: string
): Promise<{
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: k8s.V1OwnerReference[];
} | null> {
  const kc = buildKubeConfig();
  if (!kc) return null;

  const apps = kc.makeApiClient(k8s.AppsV1Api);
  try {
    if (resourceKind === 'Deployment') {
      const res = await apps.readNamespacedDeployment(resourceName, namespace);
      return {
        labels: res.body.metadata?.labels,
        annotations: res.body.metadata?.annotations,
        ownerReferences: res.body.metadata?.ownerReferences,
      };
    }
    if (resourceKind === 'StatefulSet') {
      const res = await apps.readNamespacedStatefulSet(resourceName, namespace);
      return {
        labels: res.body.metadata?.labels,
        annotations: res.body.metadata?.annotations,
        ownerReferences: res.body.metadata?.ownerReferences,
      };
    }
  } catch (err) {
    log('debug', AGENT, 'workload metadata read failed', {
      incidentId,
      namespace,
      resourceKind,
      resourceName,
      error: String(err),
    });
  }
  return null;
}

function inferFromGitMirror(
  manifestPath?: string,
  gitRepoUrl?: string
): Partial<DeployProvenance> | null {
  if (!manifestPath?.trim()) return null;

  const lower = manifestPath.toLowerCase();
  let method: DeployProvenance['method'] = 'plain-yaml';
  if (lower.includes('chart.yaml') || lower.includes('/helm/')) method = 'helm';
  else if (lower.includes('kustomization')) method = 'kustomize';

  const chartPath = lower.endsWith('chart.yaml')
    ? manifestPath.replace(/\/Chart\.yaml$/i, '')
    : undefined;

  return {
    method,
    confidence: 'high',
    source: 'git-mirror',
    fixSurface: defaultFixSurface(method),
    manifestPath,
    chartPath,
    gitopsRepo: gitRepoUrl,
  };
}

function inferOperatorFromOwners(
  owners: k8s.V1OwnerReference[] | undefined,
  namespace: string
): Partial<DeployProvenance> | null {
  if (!owners?.length) return null;
  const cr = owners.find((o) => o.kind && o.kind !== 'ReplicaSet' && o.name);
  if (!cr?.kind || !cr.name) return null;
  if (cr.kind === 'ReplicaSet') return null;

  return {
    method: 'operator-cr',
    confidence: 'medium',
    source: 'cluster-labels',
    fixSurface: 'operator-cr',
    operatorCr: {
      apiVersion: cr.apiVersion ?? 'unknown',
      kind: cr.kind,
      name: cr.name,
      namespace,
    },
  };
}

export async function resolveDeployProvenance(opts: {
  incidentId: string;
  namespace: string;
  resourceKind: ResourceKind;
  resourceName: string;
  gitManifestPath?: string;
  gitRepoUrl?: string;
  requestProvenance?: Partial<DeployProvenance>;
}): Promise<DeployProvenance> {
  const meta = await readWorkloadMetadata(
    opts.namespace,
    opts.resourceKind,
    opts.resourceName,
    opts.incidentId
  );

  const fromMeta = meta
    ? parseProvenanceFromMetadata(meta.labels, meta.annotations)
    : null;
  const fromOperator = inferOperatorFromOwners(meta?.ownerReferences, opts.namespace);
  const fromMirror = inferFromGitMirror(opts.gitManifestPath, opts.gitRepoUrl);

  let fromRegistry: Partial<DeployProvenance> | null = null;
  try {
    fromRegistry = await lookupDeploySourceRegistry(
      opts.namespace,
      opts.resourceKind,
      opts.resourceName,
      opts.incidentId
    );
  } catch {
    fromRegistry = null;
  }

  const merged = mergeDeployProvenance(
    fromRegistry ?? undefined,
    fromMeta ?? undefined,
    fromOperator ?? undefined,
    fromMirror ?? undefined,
    opts.requestProvenance
  );

  log('info', AGENT, 'resolved deploy provenance', {
    incidentId: opts.incidentId,
    namespace: opts.namespace,
    resourceName: opts.resourceName,
    method: merged.method,
    confidence: merged.confidence,
    missing: merged.missingFields,
  });

  return merged;
}
