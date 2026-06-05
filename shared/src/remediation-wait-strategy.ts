/**
 * Decide whether to keep waiting after a verify poll — scenario-aware, not blind timers.
 */

import type { VerifyResult } from './types.js';
import {
  type RemediationWaitContext,
  type RolloutPhase,
  classifyRolloutDetail,
  isTransientRolloutPhase,
  mergeRolloutPhases,
} from './rollout-phase.js';
import { isRolloutInProgress, isTerminalWorkloadFailure } from './rollout-status.js';

export interface WaitDecision {
  keepWaiting: boolean;
  phase: RolloutPhase;
  waitDetail?: string;
  reason: string;
}

export function deriveRolloutPhase(verify: VerifyResult): RolloutPhase {
  if (verify.healthy) return 'ready';
  if (verify.rolloutPhase) return verify.rolloutPhase;

  const fromPods = (verify.podPhases ?? []).map(classifyRolloutDetail);
  const fromMessage = verify.message ? [classifyRolloutDetail(verify.message)] : [];
  return mergeRolloutPhases([...fromPods, ...fromMessage]);
}

export function decideWaitContinuation(
  verify: VerifyResult,
  context: RemediationWaitContext
): WaitDecision {
  const phase = deriveRolloutPhase(verify);
  const waitDetail = verify.waitDetail ?? verify.message;

  if (verify.healthy) {
    return { keepWaiting: false, phase: 'ready', waitDetail, reason: 'workload healthy' };
  }

  if (phase === 'terminal_failure' || isTerminalWorkloadFailure(verify.message ?? '')) {
    return {
      keepWaiting: false,
      phase: 'terminal_failure',
      waitDetail,
      reason: 'terminal pod/deployment failure',
    };
  }

  const rolling =
    verify.rolloutInProgress ??
    isRolloutInProgress({
      readyReplicas: verify.readyReplicas,
      desiredReplicas: verify.desiredReplicas,
      updatedReplicas: verify.updatedReplicas,
      message: verify.message,
    });

  if (isTransientRolloutPhase(phase)) {
    return {
      keepWaiting: true,
      phase,
      waitDetail,
      reason: `transient phase: ${phase}`,
    };
  }

  if (rolling) {
    return {
      keepWaiting: true,
      phase: phase === 'unknown' ? 'rolling_update' : phase,
      waitDetail,
      reason: 'deployment rollout still converging',
    };
  }

  // Replicas stuck but no terminal signal — one more poll cycle handled by caller timeout
  return {
    keepWaiting: false,
    phase,
    waitDetail,
    reason: 'rollout not progressing and no transient phase detected',
  };
}

/** After wait ends unhealthy — should we avoid auto-remediation / reflect retry? */
export function shouldHoldForOperator(verify: VerifyResult): boolean {
  if (verify.healthy) return false;
  const phase = deriveRolloutPhase(verify);
  return (
    verify.rolloutInProgress === true ||
    isTransientRolloutPhase(phase) ||
    phase === 'pulling_image' ||
    phase === 'creating_container'
  );
}
