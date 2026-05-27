/**
 * Workload health verification for orchestrator verify node.
 */

import * as k8s from '@kubernetes/client-node';
import { existsSync } from 'node:fs';
import type { VerifyResult } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';

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

export async function verifyDeployment(
  namespace: string,
  resourceName: string,
  incidentId: string
): Promise<VerifyResult> {
  try {
    const res = await appsApi.readNamespacedDeploymentStatus(resourceName, namespace);
    const status = res.body.status;
    const ready = status?.readyReplicas ?? 0;
    const desired = status?.replicas ?? 0;
    const healthy = desired > 0 && ready === desired;
    return {
      healthy,
      readyReplicas: ready,
      desiredReplicas: desired,
      message: healthy
        ? `Deployment ${resourceName} ready ${ready}/${desired}`
        : `Deployment ${resourceName} not ready ${ready}/${desired}`,
    };
  } catch (err) {
    log('warn', AGENT, 'Verify deployment failed', { incidentId, error: String(err) });
    return { healthy: false, message: String(err) };
  }
}
