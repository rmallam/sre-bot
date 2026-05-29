/**
 * Reusable post-deploy verification recovery logic.
 *
 * Converts unhealthy verify outcomes into a deterministic next step:
 * - auto retry (safe restart) for transient runtime failures
 * - ask confirmation (forced HIL) when retry might help but is uncertain
 * - none when no safe automated recovery is known
 */

import type { RemediationPlan } from './types.js';

export interface PostDeployRecoveryDecision {
  status: 'none' | 'auto_retry' | 'ask_confirmation';
  reason: string;
  userMessage: string;
  plan?: RemediationPlan;
}

function buildRestartPlan(resourceName: string, reason: string): RemediationPlan {
  return {
    action: 'restart',
    rootCause: reason,
    reasoning: reason,
    severity: 'MEDIUM',
    proposedPatch: [],
    targetManifestPath: '',
    commitMessage: `fix(runtime): restart ${resourceName} after failed readiness`,
    rollbackSafe: true,
    targetRepo: 'both',
  };
}

/**
 * Decide what to do when deploy applied but verification reports unhealthy pods.
 */
export function decidePostDeployRecovery(
  verifyMessage: string,
  resourceName: string
): PostDeployRecoveryDecision {
  const msg = verifyMessage.toLowerCase();

  if (/imagepullbackoff|errimagepull|pull access denied|manifest unknown|failed to pull image/i.test(msg)) {
    const reason =
      'Pods are failing to pull the image. A restart may help only for transient registry/network issues.';
    return {
      status: 'ask_confirmation',
      reason,
      userMessage:
        'Detected image pull failure. I can try one restart if you approve, ' +
        'but if image/tag or pull-secret is wrong this will still fail.',
      plan: buildRestartPlan(resourceName, reason),
    };
  }

  if (/crashloopbackoff|oomkilled|back-off restarting failed container|liveness probe failed|readiness probe failed/i.test(msg)) {
    const reason = 'Pods are running but unstable after deploy; a restart is a safe first recovery step.';
    return {
      status: 'auto_retry',
      reason,
      userMessage: 'Pods are unstable after deploy — retrying one safe restart automatically.',
      plan: buildRestartPlan(resourceName, reason),
    };
  }

  return {
    status: 'none',
    reason: 'No safe post-deploy auto-recovery mapped for this verification error.',
    userMessage: 'Deploy is unhealthy and needs manual review.',
  };
}
