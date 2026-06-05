/**
 * When an approved cluster hot-fix was applied but verification still fails,
 * notify the operator — do not immediately queue another executable plan.
 */

import type { RemediationAction } from './types.js';

export interface DiagnoseVerifyRecoveryDecision {
  status: 'none' | 'ask_confirmation';
  reason: string;
  userMessage: string;
}

export function decideDiagnoseVerifyRecovery(
  verifyMessage: string,
  resourceName: string,
  lastAction?: RemediationAction
): DiagnoseVerifyRecoveryDecision {
  if (lastAction === 'git_patch' || lastAction === 'restart') {
    const reason = verifyMessage.slice(0, 500) || 'Workload still unhealthy after approved fix';
    return {
      status: 'ask_confirmation',
      reason,
      userMessage:
        `The cluster change was applied, but **${resourceName}** is still not healthy after waiting for rollout:\n` +
        `${verifyMessage.slice(0, 450)}\n\n` +
        `Reply with a **different image tag**, **imagePullSecret**, or tap **Suggest fix** — ` +
        `I will gather your input before proposing another change.`,
    };
  }

  return { status: 'none', reason: 'No diagnose verify recovery mapped.', userMessage: '' };
}
