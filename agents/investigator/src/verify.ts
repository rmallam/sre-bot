/**
 * Workload health verification for orchestrator verify node.
 */

import * as k8s from '@kubernetes/client-node';
import { existsSync } from 'node:fs';
import type { DeployWorkloadRef } from '../../../shared/src/deploy-workloads.js';
import type { ResourceKind, VerifyResult } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { isRolloutInProgress, isTerminalWorkloadFailure } from '../../../shared/src/rollout-status.js';
import { observeDeploymentRollout } from './rollout-observe.js';
import { discoverReleaseWorkloads } from './release-workloads.js';

const AGENT = 'investigator';

function isDeploymentNotFound(err: unknown): boolean {
  const status = (err as { response?: { statusCode?: number } })?.response?.statusCode;
  if (status === 404) return true;
  const msg = String(err);
  return /not found|does not exist/i.test(msg);
}

function buildAppsApi(): k8s.AppsV1Api {
  const kc = buildKubeConfig();
  return kc.makeApiClient(k8s.AppsV1Api);
}

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

async function verifySingleDeployment(
  appsApi: k8s.AppsV1Api,
  namespace: string,
  resourceName: string,
  incidentId: string
): Promise<VerifyResult> {
  const kc = buildKubeConfig();
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
}

async function verifySingleStatefulSet(
  appsApi: k8s.AppsV1Api,
  namespace: string,
  resourceName: string
): Promise<VerifyResult> {
  const stsRes = await appsApi.readNamespacedStatefulSet(resourceName, namespace);
  const status = stsRes.body.status;
  const ready = status?.readyReplicas ?? 0;
  const desired = status?.replicas ?? 0;
  const healthy = desired > 0 && ready === desired;
  return {
    healthy,
    readyReplicas: ready,
    desiredReplicas: desired,
    rolloutInProgress: !healthy && ready > 0,
    message: healthy
      ? `StatefulSet ${resourceName} ready ${ready}/${desired}`
      : `StatefulSet ${resourceName} not ready ${ready}/${desired}`,
  };
}

async function verifyOneWorkload(
  appsApi: k8s.AppsV1Api,
  workload: DeployWorkloadRef,
  incidentId: string
): Promise<VerifyResult> {
  if (workload.resourceKind === 'StatefulSet') {
    return verifySingleStatefulSet(appsApi, workload.namespace, workload.resourceName);
  }
  return verifySingleDeployment(
    appsApi,
    workload.namespace,
    workload.resourceName,
    incidentId
  );
}

/** Aggregate health across all workloads in a release. */
export async function verifyWorkloadList(
  releaseName: string,
  workloads: DeployWorkloadRef[],
  incidentId: string
): Promise<VerifyResult> {
  if (workloads.length === 0) {
    return {
      healthy: false,
      message: `No workloads recorded or discovered for release "${releaseName}".`,
    };
  }

  const appsApi = buildAppsApi();
  let totalReady = 0;
  let totalDesired = 0;
  const parts: string[] = [];
  let anyRolling = false;
  let terminalMsg: string | undefined;

  for (const w of workloads) {
    try {
      const one = await verifyOneWorkload(appsApi, w, incidentId);
      totalReady += one.readyReplicas ?? 0;
      totalDesired += one.desiredReplicas ?? 0;
      parts.push(`${w.resourceName} ${one.readyReplicas ?? 0}/${one.desiredReplicas ?? 0}`);
      if (!one.healthy) {
        if (one.rolloutPhase === 'terminal_failure' || isTerminalWorkloadFailure(one.waitDetail ?? one.message)) {
          terminalMsg = one.waitDetail ?? one.message;
        } else if (one.rolloutInProgress) {
          anyRolling = true;
        }
      }
    } catch (err) {
      log('warn', AGENT, 'Verify workload failed', {
        incidentId,
        workload: w.resourceName,
        error: String(err),
      });
      parts.push(`${w.resourceName} error`);
    }
  }

  const healthy = totalDesired > 0 && totalReady === totalDesired;
  if (healthy) {
    return {
      healthy: true,
      readyReplicas: totalReady,
      desiredReplicas: totalDesired,
      rolloutPhase: 'ready',
      rolloutInProgress: false,
      message: `Release "${releaseName}" ready — ${parts.join(', ')}`,
    };
  }

  if (terminalMsg) {
    return {
      healthy: false,
      readyReplicas: totalReady,
      desiredReplicas: totalDesired,
      rolloutPhase: 'terminal_failure',
      rolloutInProgress: false,
      message: terminalMsg,
    };
  }

  return {
    healthy: false,
    readyReplicas: totalReady,
    desiredReplicas: totalDesired,
    rolloutInProgress: anyRolling || totalReady > 0,
    message: anyRolling || totalReady > 0
      ? `Release "${releaseName}" still starting — ${parts.join(', ')}`
      : `Release "${releaseName}" not ready — ${parts.join(', ')}`,
  };
}

export interface VerifyDeploymentOpts {
  /** Layer 4 — workloads captured at apply time. */
  workloads?: DeployWorkloadRef[];
}

export async function verifyDeployment(
  namespace: string,
  resourceName: string,
  incidentId: string,
  opts?: VerifyDeploymentOpts
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

    if (opts?.workloads?.length) {
      return verifyWorkloadList(resourceName, opts.workloads, incidentId);
    }

    const appsApi = buildAppsApi();
    try {
      return await verifySingleDeployment(appsApi, namespace, resourceName, incidentId);
    } catch (depErr) {
      if (!isDeploymentNotFound(depErr)) throw depErr;
    }

    const discovered = await discoverReleaseWorkloads(namespace, resourceName, incidentId);
    if (discovered.workloads.length === 0) {
      return {
        healthy: false,
        message: `No deployments or statefulsets found for release "${resourceName}" in namespace "${namespace}".`,
      };
    }

    if (discovered.workloads.length === 1 && discovered.workloads[0]!.resourceKind === 'Deployment') {
      try {
        return await verifySingleDeployment(
          appsApi,
          namespace,
          discovered.workloads[0]!.resourceName,
          incidentId
        );
      } catch {
        /* fall through to aggregate */
      }
    }

    return verifyWorkloadList(resourceName, discovered.workloads, incidentId);
  } catch (err) {
    log('warn', AGENT, 'Verify deployment failed', { incidentId, error: String(err) });
    const msg = String(err);
    if (/HttpError/i.test(msg)) {
      return {
        healthy: false,
        message: `Could not reach the Kubernetes API to verify ${resourceName} (${msg.slice(0, 200)}).`,
      };
    }
    return { healthy: false, message: msg };
  }
}

export interface VerifyWithPlaybooksOpts {
  workloads?: DeployWorkloadRef[];
  playbookMarkdown?: string;
}

export async function verifyWithPlaybooks(
  namespace: string,
  resourceName: string,
  incidentId: string,
  opts?: VerifyWithPlaybooksOpts
): Promise<VerifyResult> {
  const base = await verifyDeployment(namespace, resourceName, incidentId, {
    workloads: opts?.workloads,
  });
  const markdown = opts?.playbookMarkdown?.trim();
  if (!markdown || !base.healthy) return base;

  const { runPlaybookVerifySteps, summarizePlaybookVerifyResults } = await import(
    './playbook-verify-runner.js'
  );
  const checks = await runPlaybookVerifySteps(markdown, { namespace, resourceName });
  if (checks.length === 0) return base;

  const allPassed = checks.every((c) => c.passed);
  const summary = summarizePlaybookVerifyResults(checks);
  return {
    ...base,
    healthy: allPassed,
    allPlaybookChecksPassed: allPassed,
    playbookChecks: checks,
    message: allPassed ? `${base.message}; ${summary}` : `${base.message}; ${summary}`,
  };
}
