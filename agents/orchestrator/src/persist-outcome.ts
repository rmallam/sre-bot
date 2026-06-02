/**
 * Persist structured remediation outcomes for console + future skills.
 */

import type { ActionRecord, RemediationPlan, RunStatus } from '../../../shared/src/types.js';
import type { HumanDecision } from '../../../shared/src/remediation-outcome.js';
import { buildRemediationOutcome } from '../../../shared/src/remediation-outcome.js';
import { getRun, mergeRunMetadata } from './run-store.js';

export async function persistRunOutcome(
  runId: string,
  params: {
    status: RunStatus;
    lastError?: string;
    actionHistory?: ActionRecord[];
    plan?: RemediationPlan;
    humanDecision?: HumanDecision;
  }
): Promise<void> {
  const run = await getRun(runId);
  if (!run) return;

  const plan =
    params.plan ??
    (run.metadata?.remediationPlan as RemediationPlan | undefined);

  const outcome = buildRemediationOutcome({
    run,
    status: params.status,
    lastError: params.lastError,
    actionHistory: params.actionHistory ?? [],
    plan,
    humanDecision: params.humanDecision,
  });

  await mergeRunMetadata(runId, {
    remediationOutcome: outcome,
    remediationPlan: plan,
    lastError: params.lastError,
    humanDecision: params.humanDecision,
  });
}

export async function persistSuggestedPlan(
  runId: string,
  plan: RemediationPlan,
  meta?: { planSource?: 'bot' | 'human' }
): Promise<void> {
  await mergeRunMetadata(runId, {
    remediationPlan: plan,
    planSource: meta?.planSource ?? 'bot',
  });
}
