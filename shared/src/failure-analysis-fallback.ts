/**
 * Deterministic failure analysis when brain LLM is unavailable.
 */

import type { DeployFailureAnalysis } from './deploy-failure.js';
import type { FailureAnalysisResult } from './types.js';

export function deterministicFailureAnalysis(
  classified: DeployFailureAnalysis,
  errorMessage: string
): FailureAnalysisResult {
  const snippet = errorMessage.slice(0, 200);

  if (classified.kind === 'namespace_missing') {
    return {
      decision: 'escalate_human',
      reasoning:
        'Namespace is missing. User should confirm creation before retry (do not fail silently).',
      operatorMessage:
        `Namespace not found. Reply **yes** or **create namespace** and I will create it and retry the deploy.`,
      confidence: 0.92,
      missingResource: {
        kind: 'namespace',
        name: inferMissingNamespace(errorMessage) ?? 'unknown',
        reason: 'Deploy target namespace does not exist.',
        canAutoCreate: true,
        createAction: 'create_namespace',
      },
    };
  }

  if (classified.kind === 'cluster_unreachable') {
    return {
      decision: 'escalate_human',
      reasoning:
        'Cluster API is unreachable from the gitops agent (TLS or network). ' +
        'Retrying Helm or kubectl will not help until connectivity is fixed.',
      operatorMessage:
        `Cannot reach the cluster API (${classified.summary}). ` +
        `Restart agents after fixing kubeconfig, or enable kube-proxy profile. Not retrying Helm.`,
      confidence: 0.95,
    };
  }

  if (classified.kind === 'git') {
    const develop =
      /branch.*not found|remote branch/i.test(errorMessage) && !/develop/.test(errorMessage);
    if (develop) {
      return {
        decision: 'retry_with_plan',
        reasoning: 'Git branch missing; try develop or default branch.',
        operatorMessage: 'Branch not found — will retry deploy on develop.',
        confidence: 0.8,
        suggestedGitRef: 'develop',
      };
    }
    return {
      decision: 'escalate_human',
      reasoning: classified.summary,
      operatorMessage: `Git error: ${snippet}`,
      confidence: 0.85,
    };
  }

  if (classified.kind === 'rbac' || classified.kind === 'auth') {
    return {
      decision: 'escalate_human',
      reasoning: classified.summary,
      operatorMessage: `Cluster permission error — needs human: ${snippet}`,
      confidence: 0.9,
    };
  }

  if (classified.kind === 'helm_tooling' && classified.alternateStrategyMayHelp) {
    return {
      decision: 'retry_with_plan',
      reasoning: 'Helm binary issue; retry with direct kubectl apply path.',
      operatorMessage: 'Helm failed in container — retrying with kubectl manifest apply.',
      confidence: 0.75,
      suggestedAction: 'repo_apply',
      deployStrategy: 'direct',
    };
  }

  if (classified.kind === 'manifest' && classified.alternateStrategyMayHelp) {
    return {
      decision: 'retry_with_plan',
      reasoning: 'Manifest validation failed; may need different chart path or git ref.',
      operatorMessage: 'Manifest apply failed — analyzing next step (one retry).',
      confidence: 0.6,
    };
  }

  return {
    decision: 'escalate_human',
    reasoning: classified.summary,
    operatorMessage: `Deploy failed: ${classified.summary}`,
    confidence: 0.7,
  };
}

function inferMissingNamespace(errorMessage: string): string | undefined {
  const quoted = errorMessage.match(/namespaces?\s+["']([^"']+)["']\s+not found/i);
  if (quoted?.[1]) return quoted[1];
  const plain = errorMessage.match(/namespace\s+([a-z0-9-_.]+)\s+not found/i);
  if (plain?.[1]) return plain[1];
  return undefined;
}
