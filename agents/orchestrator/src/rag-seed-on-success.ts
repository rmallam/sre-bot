/**
 * Seed verified fixes into platform RAG when remediation succeeds.
 */

import type { RemediationPlan, RunStatus } from '../../../shared/src/types.js';
import type { HumanDecision, RemediationOutcome } from '../../../shared/src/remediation-outcome.js';
import { buildRemediationOutcome, runDisplayName } from '../../../shared/src/remediation-outcome.js';
import { buildRagLearnPayload } from '../../../shared/src/rag-learn.js';
import { log } from '../../../shared/src/http.js';
import { platformRagLearn, ragLearningEnabled } from '../../../shared/src/platform-client.js';
import { getRun, mergeRunMetadata } from './run-store.js';

const AGENT = 'orchestrator-rag-learn';

export interface RagSeedContext {
  detectedError?: string;
  targetComponent?: string;
  mode?: string;
  outcome?: RemediationOutcome;
  plan?: RemediationPlan;
}

export async function maybeSeedRagFromSuccessfulRun(
  runId: string,
  ctx: RagSeedContext = {}
): Promise<void> {
  if (!ragLearningEnabled()) return;

  const run = await getRun(runId);
  if (!run) return;
  if (run.metadata?.ragSeeded === true) return;

  const mode =
    ctx.mode ??
    (run.metadata?.mode as string | undefined) ??
    ((run.metadata?.request as Record<string, unknown> | undefined)?.mode as string | undefined);
  if (mode !== 'diagnose' && mode !== 'ci-failure') return;

  const plan = ctx.plan ?? (run.metadata?.remediationPlan as RemediationPlan | undefined);

  const outcome =
    ctx.outcome ??
    buildRemediationOutcome({
      run,
      status: run.status as RunStatus,
      lastError: run.metadata?.lastError as string | undefined,
      actionHistory: [],
      plan,
      humanDecision: run.metadata?.humanDecision as HumanDecision | undefined,
    });

  if (outcome.worked !== true) return;

  const ragMeta = run.metadata?.ragContext as
    | { detectedError?: string; targetComponent?: string }
    | undefined;

  const ciMeta = run.metadata?.ciRun as { diagnosis?: { category?: string } } | undefined;

  const errorSignature =
    (ctx.detectedError ?? ragMeta?.detectedError ?? '').trim() ||
    inferErrorFromPlan(plan) ||
    (mode === 'ci-failure' ? ciMeta?.diagnosis?.category ?? 'ci_failure' : '');
  if (!errorSignature) {
    log('info', AGENT, 'Skip RAG seed — no error signature', { runId, incidentId: run.incidentId });
    return;
  }

  const targetComponent =
    ctx.targetComponent ??
    ragMeta?.targetComponent ??
    (mode === 'ci-failure' ? 'gitops' : 'compute');

  const req = run.metadata?.request as Record<string, unknown> | undefined;
  const payload = buildRagLearnPayload({
    outcome,
    plan,
    errorSignature,
    targetComponent,
    runId,
    incidentId: run.incidentId,
    resourceLabel: runDisplayName(run),
    namespace: req?.namespace as string | undefined,
    resourceName: req?.resourceName as string | undefined,
  });
  if (!payload) return;

  const result = await platformRagLearn({
    errorSignature: payload.errorSignature,
    targetComponent: payload.targetComponent,
    playbookMarkdown: payload.playbookMarkdown,
    runId: payload.runId,
    incidentId: payload.incidentId,
  });

  if (!result?.upserted) {
    log('warn', AGENT, 'RAG learn call did not upsert', { runId, incidentId: run.incidentId });
    return;
  }

  await mergeRunMetadata(runId, {
    ragSeeded: true,
    ragSeededAt: new Date().toISOString(),
    ragLearnRunbookId: result.runbookId,
    ragLearnProvenCount: result.provenCount,
  });

  log('info', AGENT, 'Seeded verified fix to RAG', {
    runId,
    incidentId: run.incidentId,
    errorSignature: result.errorSignature,
    targetComponent: result.targetComponent,
    provenCount: result.provenCount,
  });
}

function inferErrorFromPlan(plan?: RemediationPlan): string {
  const blob = [plan?.rootCause, plan?.reasoning].filter(Boolean).join(' ');
  const signatures = [
    'CrashLoopBackOff',
    'OOMKilled',
    'ImagePullBackOff',
    'ErrImagePull',
    'CreateContainerConfigError',
    'FailedMount',
    'FailedScheduling',
    'Evicted',
    'ContainerCannotRun',
  ];
  for (const sig of signatures) {
    if (blob.includes(sig)) return sig;
  }
  if (/\boom\b/i.test(blob)) return 'OOMKilled';
  return '';
}
