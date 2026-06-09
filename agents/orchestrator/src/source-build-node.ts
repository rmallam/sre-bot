/**
 * Orchestrator build node — execute source builds before deploy plan (DEPLOY-2d/e).
 */

import type { DiagnosisContext, RemediationPlan, RunStatus } from '../../../shared/src/types.js';
import { defaultBuiltImageRef } from '../../../shared/src/deploy/source-build.js';
import {
  shouldRunSourceBuild,
  sourceBuildRequiresHil,
  type SourceBuildPending,
} from '../../../shared/src/deploy/source-build-gate.js';
import type { DetectedRuntime, SourceBuildStrategy } from '../../../shared/src/deploy/runtime-detect.js';
import { executeSourceBuildViaInvestigator } from '../../../shared/src/deploy/source-build.js';
import { sendDeployProgress } from '../../../shared/src/deploy-notify.js';
import { log } from '../../../shared/src/http.js';
import { getRun, mergeRunMetadata, setRunStatus } from './run-store.js';
import { persistSuggestedPlan } from './persist-outcome.js';
import { notifyUserUpdate, requestHilApproval, type OrchestratorRunContext } from './tools.js';

const AGENT = 'orchestrator-agent';

function toRunCtx(state: SourceBuildGraphState): OrchestratorRunContext {
  return {
    runId: state.runId,
    incidentId: state.incidentId,
    request: state.request,
    namespace: state.namespace,
    resourceName: state.resourceName,
    resourceKind: state.resourceKind,
    mode: state.mode,
  };
}

export interface SourceBuildGraphState {
  runId: string;
  incidentId: string;
  mode: import('../../../shared/src/types.js').IncidentMode;
  namespace: string;
  resourceName: string;
  resourceKind: import('../../../shared/src/types.js').ResourceKind;
  request: import('../../../shared/src/types.js').StartRunRequest;
  factsSanitized?: DiagnosisContext;
  status: RunStatus;
  iteration: number;
  maxIterations: number;
}

function buildHilPlan(pending: SourceBuildPending): RemediationPlan {
  return {
    action: 'repo_apply',
    rootCause: `Build container image from ${pending.githubRepo}`,
    reasoning:
      `Approve building a container image from Git source before deploy.\n` +
      `Repo: ${pending.githubRepo}@${pending.gitRef}\n` +
      `Strategy: ${pending.strategy}\n` +
      `Target image: ${pending.targetImage}`,
    severity: 'MEDIUM',
    proposedPatch: [],
    rollbackSafe: true,
    targetRepo: 'app',
    githubRepo: pending.githubRepo,
    gitRef: pending.gitRef,
    commitMessage: `feat(deploy): build image for ${pending.appName}`,
  };
}

function pendingFromState(state: SourceBuildGraphState): SourceBuildPending | undefined {
  const signals = state.factsSanitized?.repoSignals;
  const githubRepo = state.request.githubRepo ?? state.factsSanitized?.githubRepo;
  if (!signals?.needsImageBuild || !githubRepo) return undefined;

  const gitRef = state.request.gitRef ?? state.factsSanitized?.resolvedGitRef ?? 'main';
  return {
    githubRepo,
    gitRef,
    appName: state.resourceName,
    namespace: state.namespace,
    runtime: signals.detectedRuntime ?? 'unknown',
    strategy: (signals.buildStrategy ?? 'buildpacks') as SourceBuildStrategy,
    targetImage: defaultBuiltImageRef({ appName: state.resourceName, githubRepo }),
  };
}

export async function sourceBuildGraphNode(
  state: SourceBuildGraphState
): Promise<{
  status?: RunStatus;
  awaitingHuman?: boolean;
  lastError?: string;
  factsSanitized?: DiagnosisContext;
  pendingPlan?: RemediationPlan;
  authorizeForceHil?: boolean;
}> {
  const signals = state.factsSanitized?.repoSignals;
  if (
    !shouldRunSourceBuild({
      mode: state.mode,
      needsImageBuild: signals?.needsImageBuild,
      buildStrategy: signals?.buildStrategy,
      suggestedImage: signals?.suggestedImage,
    })
  ) {
    return {};
  }

  const pending = pendingFromState(state);
  if (!pending) return {};

  const stored = await getRun(state.runId);
  const meta = stored?.metadata ?? {};
  const alreadyBuilt =
    typeof meta['sourceBuildResult'] === 'object' &&
    (meta['sourceBuildResult'] as { success?: boolean }).success === true;

  if (alreadyBuilt && signals?.suggestedImage) {
    return {};
  }

  const needsHil = sourceBuildRequiresHil(pending.githubRepo);
  const approved = meta['sourceBuildApproved'] === true;

  if (needsHil && !approved) {
    await mergeRunMetadata(state.runId, {
      sourceBuildPending: pending,
      factsSnapshot: state.factsSanitized,
    });

    const hilPlan = buildHilPlan(pending);
    await persistSuggestedPlan(state.runId, hilPlan);

    if (state.request.platform && state.request.channelId) {
      await sendDeployProgress(
        {
          incidentId: state.incidentId,
          platform: state.request.platform,
          channelId: state.request.channelId,
        },
        `Source repo needs a container image build (${pending.strategy}) → \`${pending.targetImage}\`. ` +
          `Human approval required before building from Git.`
      );
      await notifyUserUpdate(toRunCtx(state), {
        kind: 'hil_required',
        incidentId: state.incidentId,
        runId: state.runId,
        mode: state.mode,
        pendingAction: 'repo_apply',
        namespace: state.namespace,
        resourceName: state.resourceName,
        detailAvailable: true,
        technicalMessage: hilPlan.reasoning,
      });
    }

    await requestHilApproval(
      toRunCtx(state),
      hilPlan,
      state.iteration,
      state.maxIterations
    );
    await setRunStatus(state.runId, 'awaiting_human');

    log('info', AGENT, 'Source build awaiting HIL approval', {
      incidentId: state.incidentId,
      runId: state.runId,
      githubRepo: pending.githubRepo,
    });

    return {
      status: 'awaiting_human',
      awaitingHuman: true,
      pendingPlan: hilPlan,
      authorizeForceHil: true,
      lastError: 'source_build_awaiting_approval',
    };
  }

  if (state.request.platform && state.request.channelId) {
    await sendDeployProgress(
      {
        incidentId: state.incidentId,
        platform: state.request.platform,
        channelId: state.request.channelId,
      },
      `Building container image from source (${pending.strategy})…`
    );
  }

  const build = await executeSourceBuildViaInvestigator({
    incidentId: state.incidentId,
    appName: pending.appName,
    namespace: pending.namespace,
    githubRepo: pending.githubRepo,
    gitRef: pending.gitRef,
    repoDir: '',
    runtime: pending.runtime as DetectedRuntime,
    strategy: pending.strategy,
  });

  await mergeRunMetadata(state.runId, {
    sourceBuildResult: build,
    sourceBuildApproved: true,
  });

  if (!build.success) {
    return {
      status: 'failed',
      lastError: build.summary,
    };
  }

  const updatedFacts: DiagnosisContext = {
    ...(state.factsSanitized ?? ({} as DiagnosisContext)),
    repoSignals: {
      ...signals,
      suggestedImage: build.image,
    },
  };

  if (state.request.platform && state.request.channelId) {
    await sendDeployProgress(
      {
        incidentId: state.incidentId,
        platform: state.request.platform,
        channelId: state.request.channelId,
      },
      `Image built: \`${build.image}\`. Generating deploy plan…`
    );
  }

  log('info', AGENT, 'Source build completed', {
    incidentId: state.incidentId,
    image: build.image,
    strategy: pending.strategy,
  });

  return { factsSanitized: updatedFacts };
}

/** Continue pre-deploy after source-build HIL approval. */
export async function continueAfterSourceBuildApproval(state: SourceBuildGraphState): Promise<{
  factsSanitized?: DiagnosisContext;
  status?: RunStatus;
  lastError?: string;
}> {
  const stored = await getRun(state.runId);
  const facts =
    (stored?.metadata?.factsSnapshot as DiagnosisContext | undefined) ??
    state.factsSanitized;

  await mergeRunMetadata(state.runId, { sourceBuildApproved: true });

  const withFacts = { ...state, factsSanitized: facts };
  const result = await sourceBuildGraphNode(withFacts);
  return {
    factsSanitized: result.factsSanitized ?? facts,
    status: result.status,
    lastError: result.lastError,
  };
}
