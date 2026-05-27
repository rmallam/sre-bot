/**
 * Rollout restart via kubectl.kubernetes.io/restartedAt annotation.
 */

import * as k8s from '@kubernetes/client-node';
import { existsSync } from 'node:fs';
import type { ExecutionResult, RemediateCommand } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';

const AGENT = 'executor-agent';
const ROLLOUT_TIMEOUT_MS = parseInt(process.env['EXECUTOR_ROLLOUT_TIMEOUT_MS'] ?? '120000', 10);

function buildAppsApi(): k8s.AppsV1Api {
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
  return kc.makeApiClient(k8s.AppsV1Api);
}

const appsApi = buildAppsApi();

export async function executeRestart(cmd: RemediateCommand): Promise<ExecutionResult> {
  const { namespace, resourceName, resourceKind, incidentId, runId } = cmd;
  const restartedAt = new Date().toISOString();

  log('info', AGENT, 'Executing rollout restart', {
    incidentId,
    runId,
    namespace,
    resourceName,
    resourceKind,
  });

  try {
    if (resourceKind === 'Deployment') {
      const patch = {
        spec: {
          template: {
            metadata: {
              annotations: {
                'kubectl.kubernetes.io/restartedAt': restartedAt,
              },
            },
          },
        },
      };
      await appsApi.patchNamespacedDeployment(
        resourceName,
        namespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
      );
    } else if (resourceKind === 'StatefulSet') {
      const patch = {
        spec: {
          template: {
            metadata: {
              annotations: {
                'kubectl.kubernetes.io/restartedAt': restartedAt,
              },
            },
          },
        },
      };
      await appsApi.patchNamespacedStatefulSet(
        resourceName,
        namespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
      );
    } else {
      return {
        ...baseResult(cmd),
        success: false,
        error: `Restart not supported for kind ${resourceKind}`,
      };
    }

    const ready = await waitForRollout(namespace, resourceName, resourceKind, incidentId);

    return {
      ...baseResult(cmd),
      success: ready,
      method: 'restartedAt-annotation',
      error: ready ? undefined : 'Rollout did not become ready within timeout',
    };
  } catch (err) {
    log('error', AGENT, 'Restart failed', { incidentId, error: String(err) });
    return {
      ...baseResult(cmd),
      success: false,
      error: String(err),
    };
  }
}

function baseResult(cmd: RemediateCommand): ExecutionResult {
  return {
    incidentId: cmd.incidentId,
    triggeredBy: cmd.triggeredBy,
    triggeredAt: cmd.triggeredAt,
    namespace: cmd.namespace,
    resourceKind: cmd.resourceKind,
    resourceName: cmd.resourceName,
    mode: cmd.mode,
    runId: cmd.runId,
    success: false,
  };
}

async function waitForRollout(
  namespace: string,
  name: string,
  kind: string,
  incidentId: string
): Promise<boolean> {
  const deadline = Date.now() + ROLLOUT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if (kind === 'Deployment') {
        const res = await appsApi.readNamespacedDeploymentStatus(name, namespace);
        const status = res.body.status;
        const updated = status?.updatedReplicas ?? 0;
        const ready = status?.readyReplicas ?? 0;
        const desired = status?.replicas ?? 0;
        if (desired > 0 && ready === desired && updated === desired) {
          return true;
        }
      } else if (kind === 'StatefulSet') {
        const res = await appsApi.readNamespacedStatefulSetStatus(name, namespace);
        const status = res.body.status;
        const ready = status?.readyReplicas ?? 0;
        const desired = status?.replicas ?? 0;
        if (desired > 0 && ready === desired) {
          return true;
        }
      }
    } catch (err) {
      log('warn', AGENT, 'Rollout poll error', { incidentId, error: String(err) });
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return false;
}
