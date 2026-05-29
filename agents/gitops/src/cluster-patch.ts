/**
 * Apply approved git_patch plans directly to live cluster workloads.
 * GitOps mirror-only patches fail when GITOPS_REPO_URL is unset or manifests are missing.
 */

import * as k8s from '@kubernetes/client-node';
import type { Operation } from 'fast-json-patch';
import { log } from '../../../shared/src/http.js';
import { buildKubeConfig } from './kube-config.js';
import type { JsonPatchOp, RemediateCommand, ResourceKind } from '../../../shared/src/types.js';

const AGENT = 'gitops-agent';

export interface ClusterPatchResult {
  success: boolean;
  error?: string;
  method?: string;
  targetKind?: ResourceKind;
  targetName?: string;
}

function buildKubeClients(): { apps: k8s.AppsV1Api; core: k8s.CoreV1Api } | null {
  try {
    const kc = buildKubeConfig();
    return {
      apps: kc.makeApiClient(k8s.AppsV1Api),
      core: kc.makeApiClient(k8s.CoreV1Api),
    };
  } catch (err) {
    log('warn', AGENT, 'Kubernetes client unavailable for cluster patch', { error: String(err) });
    return null;
  }
}

/** Pod incidents → owning Deployment/StatefulSet (via ReplicaSet). */
export async function resolveControllerTarget(
  apps: k8s.AppsV1Api,
  core: k8s.CoreV1Api,
  namespace: string,
  resourceKind: ResourceKind,
  resourceName: string
): Promise<{ kind: 'Deployment' | 'StatefulSet'; name: string } | null> {
  if (resourceKind === 'Deployment' || resourceKind === 'StatefulSet') {
    return { kind: resourceKind, name: resourceName };
  }

  if (resourceKind !== 'Pod') {
    return null;
  }

  try {
    const podRes = await core.readNamespacedPod(resourceName, namespace);
    const pod = podRes.body;
    const rsOwner = pod.metadata?.ownerReferences?.find((o) => o.kind === 'ReplicaSet' && o.name);
    if (!rsOwner?.name) {
      return null;
    }
    const rsRes = await apps.readNamespacedReplicaSet(rsOwner.name, namespace);
    const depOwner = rsRes.body.metadata?.ownerReferences?.find(
      (o) => o.kind === 'Deployment' && o.name
    );
    if (depOwner?.name) {
      return { kind: 'Deployment', name: depOwner.name };
    }
    const stsOwner = rsRes.body.metadata?.ownerReferences?.find(
      (o) => o.kind === 'StatefulSet' && o.name
    );
    if (stsOwner?.name) {
      return { kind: 'StatefulSet', name: stsOwner.name };
    }
  } catch (err) {
    log('warn', AGENT, 'Failed to resolve controller from pod', {
      namespace,
      podName: resourceName,
      error: String(err),
    });
  }

  // Heuristic: strip ReplicaSet hash suffix (deployment-name-abc12345-xyz)
  const guess = resourceName.replace(/-[a-z0-9]{5,10}-[a-z0-9]{5,10}$/i, '');
  if (guess && guess !== resourceName) {
    try {
      await apps.readNamespacedDeployment(guess, namespace);
      return { kind: 'Deployment', name: guess };
    } catch {
      /* try next */
    }
  }

  return null;
}

function patchTargetsPodTemplate(patch: JsonPatchOp[]): boolean {
  return patch.some((op) => op.path.startsWith('/spec/template/'));
}

/** RFC6902 replace fails when path is missing — use add for optional pod-template fields. */
function normalizePatchOps(
  workload: Record<string, unknown>,
  patch: JsonPatchOp[]
): JsonPatchOp[] {
  const getAt = (path: string): unknown => {
    if (!path.startsWith('/')) return workload;
    const parts = path.slice(1).split('/');
    let cur: unknown = workload;
    for (const part of parts) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  };

  return patch.map((op) => {
    if (op.op !== 'replace') return op;
    if (getAt(op.path) !== undefined) return op;
    return { ...op, op: 'add' };
  });
}

/**
 * Apply RFC 6902 patch ops to a live Deployment or StatefulSet.
 */
export async function applyClusterGitPatch(cmd: RemediateCommand): Promise<ClusterPatchResult> {
  const clients = buildKubeClients();
  if (!clients) {
    return { success: false, error: 'Kubernetes client not available' };
  }

  const { apps, core } = clients;
  const { namespace, resourceKind, resourceName, plan, incidentId } = cmd;

  if (!plan.proposedPatch?.length) {
    return { success: false, error: 'git_patch has empty proposedPatch' };
  }

  if (!patchTargetsPodTemplate(plan.proposedPatch)) {
    return {
      success: false,
      error: 'Cluster patch only supports /spec/template/* paths on Deployments',
    };
  }

  const target = await resolveControllerTarget(apps, core, namespace, resourceKind, resourceName);
  if (!target) {
    return {
      success: false,
      error: `Could not resolve Deployment/StatefulSet for ${resourceKind}/${resourceName}`,
    };
  }

  let workloadBody: Record<string, unknown>;
  try {
    if (target.kind === 'Deployment') {
      const res = await apps.readNamespacedDeployment(target.name, namespace);
      workloadBody = res.body as unknown as Record<string, unknown>;
    } else {
      const res = await apps.readNamespacedStatefulSet(target.name, namespace);
      workloadBody = res.body as unknown as Record<string, unknown>;
    }
  } catch (err) {
    return {
      success: false,
      error: `Could not read ${target.kind}/${target.name}: ${String(err)}`,
      targetKind: target.kind,
      targetName: target.name,
    };
  }

  const patchBody = normalizePatchOps(workloadBody, plan.proposedPatch) as Operation[];

  log('info', AGENT, 'Applying cluster patch', {
    incidentId,
    namespace,
    targetKind: target.kind,
    targetName: target.name,
    opCount: patchBody.length,
  });

  try {
    if (target.kind === 'Deployment') {
      await apps.patchNamespacedDeployment(
        target.name,
        namespace,
        patchBody,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/json-patch+json' } }
      );
    } else {
      await apps.patchNamespacedStatefulSet(
        target.name,
        namespace,
        patchBody,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/json-patch+json' } }
      );
    }

    log('info', AGENT, 'Cluster patch applied', {
      incidentId,
      targetKind: target.kind,
      targetName: target.name,
    });

    return {
      success: true,
      method: 'cluster-json-patch',
      targetKind: target.kind,
      targetName: target.name,
    };
  } catch (err) {
    const error = String(err);
    // If imagePullSecrets already exists, retry with replace instead of add.
    if (/imagePullSecrets/i.test(error) && patchBody.some((op) => op.op === 'add')) {
      const replaceOps = patchBody.map((op) =>
        op.path.includes('imagePullSecrets') && op.op === 'add'
          ? { ...op, op: 'replace' as const }
          : op
      );
      try {
        if (target.kind === 'Deployment') {
          await apps.patchNamespacedDeployment(
            target.name,
            namespace,
            replaceOps,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            { headers: { 'Content-Type': 'application/json-patch+json' } }
          );
        } else {
          await apps.patchNamespacedStatefulSet(
            target.name,
            namespace,
            replaceOps,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            { headers: { 'Content-Type': 'application/json-patch+json' } }
          );
        }
        return {
          success: true,
          method: 'cluster-json-patch-replace',
          targetKind: target.kind,
          targetName: target.name,
        };
      } catch (retryErr) {
        log('error', AGENT, 'Cluster patch retry failed', { incidentId, error: String(retryErr) });
        return {
          success: false,
          error: String(retryErr),
          targetKind: target.kind,
          targetName: target.name,
        };
      }
    }

    log('error', AGENT, 'Cluster patch failed', { incidentId, error });
    return { success: false, error, targetKind: target.kind, targetName: target.name };
  }
}
