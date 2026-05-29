/**
 * Apply LLM failure analysis to a remediation plan and run request.
 */

import type {
  FailureAnalysisResult,
  RemediationPlan,
  StartRunRequest,
} from './types.js';

export function mergeFailureAnalysisIntoPlan(
  base: RemediationPlan | undefined,
  analysis: FailureAnalysisResult
): RemediationPlan | undefined {
  if (!base && analysis.decision !== 'retry_with_plan') return undefined;
  if (!base) {
    return {
      action: analysis.suggestedAction ?? 'escalate_human',
      rootCause: analysis.rootCause ?? analysis.reasoning,
      reasoning: analysis.reasoning,
      severity: 'MEDIUM',
      proposedPatch: [],
      targetManifestPath: '',
      commitMessage: `fix: retry after failure analysis`,
      rollbackSafe: true,
      githubRepo: undefined,
      gitRef: analysis.suggestedGitRef,
      targetRepo: 'both',
    };
  }

  return {
    ...base,
    action: analysis.suggestedAction ?? base.action,
    gitRef: analysis.suggestedGitRef ?? base.gitRef,
    rootCause: analysis.rootCause ?? base.rootCause,
    reasoning: `${base.reasoning}\n\nFailure analysis: ${analysis.reasoning}`,
    targetRepo:
      analysis.deployStrategy === 'direct'
        ? 'app'
        : analysis.deployStrategy === 'gitops'
          ? 'gitops'
          : base.targetRepo,
  };
}

export function patchRequestFromFailureAnalysis(
  request: StartRunRequest,
  analysis: FailureAnalysisResult
): StartRunRequest {
  const next: StartRunRequest = { ...request };
  if (analysis.suggestedGitRef) next.gitRef = analysis.suggestedGitRef;
  if (analysis.deployStrategy) next.deployStrategy = analysis.deployStrategy;
  return next;
}
