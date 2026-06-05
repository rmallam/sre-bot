/**
 * Workload health verification for orchestrator verify node.
 */

import * as k8s from '@kubernetes/client-node';
import { existsSync } from 'node:fs';
import type { VerifyResult } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { isRolloutInProgress, isTerminalWorkloadFailure } from '../../../shared/src/rollout-status.js';
import { observeDeploymentRollout } from './rollout-observe.js';

const AGENT = 'investigator';

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

export async function verifyDeployment(
  namespace: string,
  resourceName: string,
  incidentId: string
): Promise<VerifyResult> {
  try {
    const kc = buildKubeConfig();
    const core = kc.makeApiClient(k8s.CoreV1Api);
    try {
      await core.readNamespace(namespace);
    } catch (nsErr) {
      const nsMsg = String(nsErr);
      if (/not found/i.test(nsMsg)) {
        return {
          healthy: false,
          message: `Namespace "${namespace}" not found — create the namespace and redeploy, or reply yes when the bot asks to create it.`,
        };
      }
    }

    const depRes = await appsApi.readNamespacedDeployment(resourceName, namespace);
    const dep = depRes.body;
    const status = dep.status;
    const ready = status?.readyReplicas ?? 0;
    const desired = status?.replicas ?? 0;
    const updated = status?.updatedReplicas ?? ready;
    const healthy = desired > 0 && ready === desired && updated === desired;

    const observation = await observeDeploymentRollout(kc, namespace, resourceName, dep);

    if (!healthy) {
      const terminal = observation.terminal || isTerminalWorkloadFailure(observation.waitDetail);
      const rolling =
        !terminal &&
        (observation.transient ||
          isRolloutInProgress({
            readyReplicas: ready,
            desiredReplicas: desired,
            updatedReplicas: updated,
            message: observation.waitDetail,
          }));

      return {
        healthy,
        readyReplicas: ready,
        desiredReplicas: desired,
        updatedReplicas: updated,
        rolloutPhase: observation.rolloutPhase,
        waitDetail: observation.waitDetail,
        rolloutInProgress: rolling,
        podPhases: observation.podPhaseSummaries,
        message: terminal
          ? observation.waitDetail
          : observation.waitDetail ||
            (rolling
              ? `Deployment ${resourceName} rollout in progress ${ready}/${desired} ready`
              : `Deployment ${resourceName} not ready ${ready}/${desired}`),
      };
    }

    return {
      healthy,
      readyReplicas: ready,
      desiredReplicas: desired,
      updatedReplicas: updated,
      rolloutPhase: 'ready',
      rolloutInProgress: false,
      message: `Deployment ${resourceName} ready ${ready}/${desired}`,
    };
  } catch (err) {
    log('warn', AGENT, 'Verify deployment failed', { incidentId, error: String(err) });
    return { healthy: false, message: String(err) };
  }
}
