/**
 * Fingerprints approval requests so HIL can skip duplicate notifications
 * for the same orchestrator run / incident while still updating the stored plan.
 */

import type { ApprovalRequest } from './types.js';

/** Stable key for "same approval ask" (action + target + tool step). */
export function approvalNotifyFingerprint(req: ApprovalRequest): string {
  const tool = req.pendingToolApproval;
  const plan = req.plan;
  const scope = req.runId ?? req.incidentId;
  return [
    scope,
    req.approvalKind ?? 'plan',
    tool?.toolIndex ?? '',
    tool?.tool ?? '',
    plan.action,
    req.namespace,
    req.resourceName,
    req.resourceKind,
  ].join('|');
}
