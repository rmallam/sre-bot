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

    const res = await appsApi.readNamespacedDeploymentStatus(resourceName, namespace);
    const status = res.body.status;
    const ready = status?.readyReplicas ?? 0;
    const desired = status?.replicas ?? 0;
    const healthy = desired > 0 && ready === desired;
    if (!healthy) {
      const details = await summarizePodReadiness(kc, namespace, resourceName, incidentId);
      return {
        healthy,
        readyReplicas: ready,
        desiredReplicas: desired,
        message: details ?? `Deployment ${resourceName} not ready ${ready}/${desired}`,
      };
    }
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

async function summarizePodReadiness(
  kc: k8s.KubeConfig,
  namespace: string,
  resourceName: string,
  incidentId: string
): Promise<string | undefined> {
  try {
    const core = kc.makeApiClient(k8s.CoreV1Api);
    const pods = await core.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `app.kubernetes.io/name=${resourceName}`
    );
    const items = pods.body.items ?? [];
    for (const pod of items) {
      const statuses = pod.status?.containerStatuses ?? [];
      for (const s of statuses) {
        const waiting = s.state?.waiting;
        if (waiting?.reason === 'ImagePullBackOff' || waiting?.reason === 'ErrImagePull') {
          return (
            `Deployment ${resourceName} is not ready because image pull failed ` +
            `(${waiting.reason}${waiting.message ? `: ${waiting.message}` : ''}).`
          );
        }
        const terminated = s.state?.terminated;
        if (terminated?.reason === 'Error' || terminated?.reason === 'CrashLoopBackOff') {
          return (
            `Deployment ${resourceName} is not ready — container ${s.name} exited ` +
            `(${terminated.reason}${terminated.message ? `: ${terminated.message}` : ''}).`
          );
        }
        const waitingCrash = waiting?.reason === 'CrashLoopBackOff';
        if (waitingCrash) {
          return (
            `Deployment ${resourceName} is not ready — ${s.name} is in CrashLoopBackOff` +
            `${waiting?.message ? `: ${waiting.message}` : ''}.`
          );
        }
      }
    }
    return undefined;
  } catch (err) {
    log('debug', AGENT, 'Unable to enrich verify with pod status details', {
      incidentId,
      error: String(err),
    });
    return undefined;
  }
}
