/**
 * Persist structured remediation outcomes for console + RAG learning loop.
 */

import type { ActionRecord, RemediationPlan, RunStatus } from '../../../shared/src/types.js';
import type { HumanDecision } from '../../../shared/src/remediation-outcome.js';
import { buildRemediationOutcome } from '../../../shared/src/remediation-outcome.js';
import { getRun, mergeRunMetadata } from './run-store.js';
import { maybeSeedRagFromSuccessfulRun, type RagSeedContext } from './rag-seed-on-success.js';

export async function persistRunOutcome(
  runId: string,
  params: {
    status: RunStatus;
    lastError?: string;
    actionHistory?: ActionRecord[];
    plan?: RemediationPlan;
    humanDecision?: HumanDecision;
    ragSeed?: RagSeedContext;
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

  if (outcome.worked === true) {
    await maybeSeedRagFromSuccessfulRun(runId, {
      ...params.ragSeed,
      outcome,
      plan,
    }).catch(() => undefined);
  }
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

/** CI-3: post-PR verify completed — update outcome and RAG learn. */
export async function persistCiVerifyOutcome(
  runId: string,
  worked: boolean,
  message?: string
): Promise<void> {
  const run = await getRun(runId);
  if (!run) return;

  await mergeRunMetadata(runId, {
    ciVerifyAt: new Date().toISOString(),
    ciVerifyWorked: worked,
    ciVerifyMessage: message,
  });

  await persistRunOutcome(runId, {
    status: worked ? 'succeeded' : 'failed',
    lastError: worked ? undefined : message,
    humanDecision: 'approved',
    ragSeed: { mode: 'ci-failure' },
  });
}
