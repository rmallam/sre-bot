/**
 * Poll deployment health after apply and notify the operator when Ready or failing.
 */

import type { VerifyResult } from './types.js';
import { sendDeployProgress, type DeployNotifyTarget } from './deploy-notify.js';

const INVESTIGATOR_URL = process.env['INVESTIGATOR_URL'] ?? 'http://investigator-agent:8080';
const POLL_MS = parseInt(process.env['DEPLOY_READY_POLL_MS'] ?? '5000', 10);
const TIMEOUT_MS = parseInt(process.env['DEPLOY_READY_TIMEOUT_MS'] ?? '600000', 10);

const activeWatches = new Set<string>();

function watchKey(target: DeployNotifyTarget, namespace: string, resourceName: string): string {
  return `${target.channelId}:${namespace}:${resourceName}`;
}

export function deployReadyPromiseMessage(appName: string, namespace: string): string {
  return (
    `Deploy applied for \`${appName}\` in namespace \`${namespace}\`.\n` +
    `I'll message you when pods are Ready (or if something fails).`
  );
}

export function deployReadySuccessMessage(
  appName: string,
  namespace: string,
  verify: Pick<VerifyResult, 'readyReplicas' | 'desiredReplicas' | 'message'>
): string {
  const replicas =
    verify.readyReplicas != null && verify.desiredReplicas != null
      ? ` (${verify.readyReplicas}/${verify.desiredReplicas} ready)`
      : '';
  return (
    `✅ Pods are Ready for \`${appName}\` in \`${namespace}\`${replicas}.\n` +
    `Check: \`kubectl get pods -n ${namespace}\``
  );
}

export function deployReadyFailureMessage(
  appName: string,
  namespace: string,
  detail: string
): string {
  return (
    `❌ Deploy is not healthy for \`${appName}\` in \`${namespace}\`.\n` +
    `${detail}\n` +
    `Check: \`kubectl get pods -n ${namespace}\` and \`kubectl describe deployment ${appName} -n ${namespace}\``
  );
}

function isTerminalDeployFailure(message: string): boolean {
  return /ImagePullBackOff|ErrImagePull|CrashLoopBackOff|CreateContainerConfigError|InvalidImageName|ImageInspectError|CreateContainerError/i.test(
    message
  );
}

async function fetchVerify(
  namespace: string,
  resourceName: string,
  incidentId: string
): Promise<VerifyResult> {
  const res = await fetch(
    `${INVESTIGATOR_URL}/verify?namespace=${encodeURIComponent(namespace)}&resourceName=${encodeURIComponent(resourceName)}&incidentId=${encodeURIComponent(incidentId)}`,
    { signal: AbortSignal.timeout(30_000) }
  );
  if (!res.ok) {
    return { healthy: false, message: `Health check HTTP ${res.status}` };
  }
  return res.json() as Promise<VerifyResult>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WatchDeployReadinessOpts {
  target: DeployNotifyTarget;
  namespace: string;
  resourceName: string;
  /** Defaults to resourceName. */
  appName?: string;
  /** If false, sends the promise line before polling (default true). */
  sendPromise?: boolean;
}

/**
 * Fire-and-forget: poll until Ready, terminal failure, or timeout; notify via commander.
 */
export function watchDeployReadinessAndNotify(opts: WatchDeployReadinessOpts): void {
  const { target, namespace, resourceName } = opts;
  const appName = opts.appName ?? resourceName;
  if (!target.platform || !target.channelId) return;

  const key = watchKey(target, namespace, resourceName);
  if (activeWatches.has(key)) return;
  activeWatches.add(key);

  void (async () => {
    try {
      if (opts.sendPromise !== false) {
        await sendDeployProgress(target, deployReadyPromiseMessage(appName, namespace));
      }

      const deadline = Date.now() + TIMEOUT_MS;
      let last: VerifyResult = { healthy: false, message: 'Still starting' };

      while (Date.now() < deadline) {
        last = await fetchVerify(namespace, resourceName, target.incidentId);
        if (last.healthy) {
          await sendDeployProgress(
            target,
            deployReadySuccessMessage(appName, namespace, last)
          );
          return;
        }
        if (isTerminalDeployFailure(last.message)) {
          await sendDeployProgress(
            target,
            deployReadyFailureMessage(appName, namespace, last.message)
          );
          return;
        }
        await sleep(POLL_MS);
      }

      await sendDeployProgress(
        target,
        deployReadyFailureMessage(
          appName,
          namespace,
          last.message ||
            `Timed out after ${Math.round(TIMEOUT_MS / 60_000)} minutes — pods did not become Ready.`
        )
      );
    } catch (err) {
      await sendDeployProgress(
        target,
        deployReadyFailureMessage(appName, namespace, String(err))
      );
    } finally {
      activeWatches.delete(key);
    }
  })();
}
