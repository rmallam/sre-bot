/**
 * Stamp sre-bot.io/* provenance annotations on workloads after agent deploy/fix.
 */

import * as k8s from '@kubernetes/client-node';
import { log } from '../../../shared/src/http.js';
import {
  buildProvenanceAnnotations,
  type DeployProvenance,
} from '../../../shared/src/deploy-provenance.js';
import { buildKubeConfig } from './kube-config.js';
import type { ResourceKind } from '../../../shared/src/types.js';

const AGENT = 'gitops-provenance';

export async function stampWorkloadProvenance(opts: {
  incidentId: string;
  runId: string;
  namespace: string;
  resourceKind: ResourceKind;
  resourceName: string;
  provenance: Partial<DeployProvenance>;
  planAction?: string;
}): Promise<void> {
  const method =
    opts.provenance.method ??
    (opts.planAction === 'helm_deploy'
      ? 'helm'
      : opts.planAction === 'repo_apply'
        ? 'direct-apply'
        : 'plain-yaml');

  const provenance: DeployProvenance = {
    method,
    confidence: 'high',
    source: 'agent-annotation',
    fixSurface: opts.provenance.fixSurface ?? 'gitops-repo',
    missingFields: [],
    sourceRepo: opts.provenance.sourceRepo,
    chartPath: opts.provenance.chartPath,
    manifestPath: opts.provenance.manifestPath,
    gitRef: opts.provenance.gitRef,
    gitopsRepo: opts.provenance.gitopsRepo,
    argoApp: opts.provenance.argoApp,
    deployRunId: opts.runId,
  };

  const annotations = buildProvenanceAnnotations(provenance, opts.runId);
  const patch = {
    metadata: {
      annotations,
      labels: {
        'app.kubernetes.io/managed-by': 'sre-bot',
      },
    },
  };

  try {
    const kc = buildKubeConfig();
    const apps = kc.makeApiClient(k8s.AppsV1Api);
    if (opts.resourceKind === 'StatefulSet') {
      await apps.patchNamespacedStatefulSet(
        opts.resourceName,
        opts.namespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
      );
    } else {
      await apps.patchNamespacedDeployment(
        opts.resourceName,
        opts.namespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
      );
    }
    log('info', AGENT, 'stamped deploy provenance annotations', {
      incidentId: opts.incidentId,
      namespace: opts.namespace,
      resourceName: opts.resourceName,
      method,
    });
  } catch (err) {
    log('warn', AGENT, 'failed to stamp provenance annotations', {
      incidentId: opts.incidentId,
      error: String(err),
    });
  }
}
