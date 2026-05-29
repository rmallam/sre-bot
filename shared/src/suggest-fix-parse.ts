/**
 * Rule-based parsing of operator fix suggestions into RemediationPlan shapes.
 * Used before/alongside LLM suggest-plan in brain-agent.
 */

import type { JsonPatchOp, RemediationPlan, ResourceKind } from './types.js';

export interface SuggestFixContext {
  namespace: string;
  resourceKind: ResourceKind;
  resourceName: string;
  /** Existing bot plan — paths and manifest hints are reused when possible. */
  basePlan: RemediationPlan;
}

function deploymentManifestPath(resourceName: string, basePath: string): string {
  if (basePath && !basePath.includes('pod')) {
    return basePath;
  }
  const dep = resourceName.replace(/-[a-z0-9]{5,10}-[a-z0-9]{5,10}$/i, '');
  return `deployments/${dep}.yaml`;
}

/**
 * Returns a plan if the suggestion matches known patterns; otherwise null (use LLM).
 */
export function tryParseOperatorSuggestion(
  suggestion: string,
  ctx: SuggestFixContext
): RemediationPlan | null {
  const text = suggestion.trim();
  const lower = text.toLowerCase();
  const manifest = deploymentManifestPath(ctx.resourceName, ctx.basePlan.targetManifestPath);

  if (
    /\brestart\b/.test(lower) ||
    /\brollout\s+restart\b/.test(lower) ||
    /\broll\s+out\s+again\b/.test(lower)
  ) {
    return {
      action: 'restart',
      rootCause: ctx.basePlan.rootCause,
      reasoning: `Operator suggested: ${text}`,
      severity: ctx.basePlan.severity,
      proposedPatch: [],
      targetManifestPath: manifest,
      commitMessage: `fix: restart ${ctx.resourceName} (operator suggestion)`,
      rollbackSafe: true,
    };
  }

  const pullSecret =
    lower.match(/image\s*pull\s*secret[s]?\s+[`'"]?([a-z0-9][-a-z0-9.]*)[`'"]?/i) ??
    lower.match(/pull\s*secret[s]?\s+[`'"]?([a-z0-9][-a-z0-9.]*)[`'"]?/i) ??
    lower.match(/secret[s]?\s+[`'"]?([a-z0-9][-a-z0-9.]*)[`'"]?\s+for\s+pull/i);
  if (pullSecret?.[1]) {
    const name = pullSecret[1];
    const patch: JsonPatchOp[] = [
      {
        op: 'add',
        path: '/spec/template/spec/imagePullSecrets',
        value: [{ name }],
      },
    ];
    return {
      action: 'git_patch',
      rootCause: ctx.basePlan.rootCause,
      reasoning: `Operator suggested adding imagePullSecret "${name}": ${text}`,
      severity: ctx.basePlan.severity,
      proposedPatch: patch,
      targetManifestPath: manifest,
      commitMessage: `fix: add imagePullSecrets ${name} (operator suggestion)`,
      rollbackSafe: true,
      patchTarget: ctx.basePlan.patchTarget ?? 'cluster',
    };
  }

  const image =
    text.match(/\b(?:set|use|change|update)\s+image\s+(?:to\s+)?[`'"]?([^\s`"']+)[`'"]?/i) ??
    text.match(/\bimage\s*[:=]\s*[`'"]?([^\s`"']+)[`'"]?/i);
  if (image?.[1]) {
    const imageRef = image[1];
    const patch: JsonPatchOp[] = [
      {
        op: 'replace',
        path: '/spec/template/spec/containers/0/image',
        value: imageRef,
      },
    ];
    return {
      action: 'git_patch',
      rootCause: ctx.basePlan.rootCause,
      reasoning: `Operator suggested image change to ${imageRef}`,
      severity: ctx.basePlan.severity,
      proposedPatch: patch,
      targetManifestPath: manifest,
      commitMessage: `fix: set image to ${imageRef} (operator suggestion)`,
      rollbackSafe: ctx.basePlan.rollbackSafe,
      patchTarget: ctx.basePlan.patchTarget ?? 'cluster',
    };
  }

  const replicas = lower.match(/\bscale\s+(?:to\s+)?(\d+)\b/);
  if (replicas?.[1]) {
    const n = parseInt(replicas[1], 10);
    return {
      action: 'git_patch',
      rootCause: ctx.basePlan.rootCause,
      reasoning: `Operator suggested scaling to ${n} replicas`,
      severity: ctx.basePlan.severity,
      proposedPatch: [{ op: 'replace', path: '/spec/replicas', value: n }],
      targetManifestPath: manifest,
      commitMessage: `fix: scale to ${n} replicas (operator suggestion)`,
      rollbackSafe: true,
      patchTarget: ctx.basePlan.patchTarget ?? 'cluster',
    };
  }

  return null;
}
