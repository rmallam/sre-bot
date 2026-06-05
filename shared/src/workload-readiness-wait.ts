/**
 * Poll workload health after cluster patch / restart — scenario-aware, not blind timers.
 */

import type { VerifyResult } from './types.js';
import type { RemediationWaitContext } from './rollout-phase.js';
import {
  buildRolloutProgressMessage,
  inferRemediationWaitContext,
  rolloutPollIntervalMs,
  rolloutTimeoutMs,
} from './rollout-phase.js';
import { decideWaitContinuation } from './remediation-wait-strategy.js';
import type { RemediationAction } from './types.js';

const DEFAULT_INITIAL_DELAY_MS = parseInt(
  process.env['REMEDIATION_ROLLOUT_INITIAL_DELAY_MS'] ?? '15000',
  10
);
const PROGRESS_NOTIFY_MS = parseInt(
  process.env['REMEDIATION_ROLLOUT_PROGRESS_NOTIFY_MS'] ?? '30000',
  10
);

export interface WaitForWorkloadReadyOpts {
  namespace: string;
  resourceName: string;
  incidentId: string;
  /** What remediation just ran — drives what we expect and check for. */
  remediationAction?: RemediationAction;
  afterImagePatch?: boolean;
  fetchVerify: (namespace: string, resourceName: string, incidentId: string) => Promise<VerifyResult>;
  onProgress?: (message: string) => void | Promise<void>;
  initialDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openingMessage(
  resourceName: string,
  context: RemediationWaitContext,
  initialDelayMs: number,
  timeoutMs: number
): string {
  const scenario =
    context.changeKind === 'image'
      ? 'I will watch pod events and image pull progress'
      : context.changeKind === 'restart'
        ? 'I will watch pods restart and pass readiness probes'
        : 'I will watch the Deployment rollout and pod status';

  return (
    `Cluster change applied — **${resourceName}**.\n` +
    `${scenario} (first check in ${Math.round(initialDelayMs / 1000)}s; up to ${Math.round(timeoutMs / 60_000)} min).`
  );
}

/**
 * Wait until workload is ready, a terminal failure is detected, or scenario timeout hits.
 * Uses pod-level phase (image pull, probes, etc.) — not just replica counts.
 */
export async function waitForWorkloadReady(opts: WaitForWorkloadReadyOpts): Promise<VerifyResult> {
  const context = inferRemediationWaitContext(opts.remediationAction ?? 'git_patch', {
    imagePatch: opts.afterImagePatch,
  });
  const initialDelay = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;

  await sleep(initialDelay);

  const startedAt = Date.now();
  let last: VerifyResult = { healthy: false, message: 'Waiting for rollout' };
  let lastProgressAt = Date.now();
  let lastPhase: string | undefined;
  let unchangedPhasePolls = 0;

  let decision = decideWaitContinuation(last, context);
  let timeoutMs = rolloutTimeoutMs(decision.phase, context);
  const deadline = startedAt + timeoutMs;

  await opts.onProgress?.(openingMessage(opts.resourceName, context, initialDelay, timeoutMs));

  while (Date.now() < deadline) {
    last = await opts.fetchVerify(opts.namespace, opts.resourceName, opts.incidentId);

    if (last.healthy) {
      return last;
    }

    decision = decideWaitContinuation(last, context);
    timeoutMs = rolloutTimeoutMs(decision.phase, context);
    const effectiveDeadline = startedAt + timeoutMs;

    if (!decision.keepWaiting) {
      return {
        ...last,
        rolloutPhase: decision.phase,
        waitDetail: decision.waitDetail,
        rolloutInProgress: false,
      };
    }

    const phaseKey = `${decision.phase}:${last.readyReplicas ?? 0}/${last.desiredReplicas ?? 0}`;
    if (phaseKey === lastPhase) {
      unchangedPhasePolls += 1;
    } else {
      unchangedPhasePolls = 0;
      lastPhase = phaseKey;
    }

    if (Date.now() - lastProgressAt >= PROGRESS_NOTIFY_MS) {
      lastProgressAt = Date.now();
      await opts.onProgress?.(
        buildRolloutProgressMessage({
          resourceName: opts.resourceName,
          phase: decision.phase,
          readyReplicas: last.readyReplicas,
          desiredReplicas: last.desiredReplicas,
          updatedReplicas: last.updatedReplicas,
          waitDetail: decision.waitDetail,
          context,
        })
      );
    }

    const pollMs = rolloutPollIntervalMs(decision.phase, context);
    await sleep(pollMs);

    if (Date.now() > effectiveDeadline) {
      break;
    }
  }

  const finalDecision = decideWaitContinuation(last, context);
  const stillTransient = finalDecision.keepWaiting;

  return {
    ...last,
    healthy: false,
    rolloutPhase: finalDecision.phase,
    waitDetail: finalDecision.waitDetail,
    rolloutInProgress: stillTransient,
    message:
      last.message ??
      (stillTransient
        ? `${opts.resourceName} is still ${finalDecision.phase.replace(/_/g, ' ')} after ${Math.round((Date.now() - startedAt) / 60_000)} min — not treating as fixed yet.`
        : `Deployment ${opts.resourceName} did not become ready within the allowed time.`),
  };
}
