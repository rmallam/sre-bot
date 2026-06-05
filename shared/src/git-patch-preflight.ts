/**
 * Preconditions before proposing or executing git_patch remediation.
 * Diagnose mode without Git manifest must use cluster hot-fix (patchTarget=cluster), not Git mirror.
 */

import { resolveGitPatchTarget, type PatchTarget } from './patch-target.js';
import type {
  DiagnosisContext,
  IncidentMode,
  PlanValidationIssue,
  RemediationPlan,
  ResourceKind,
} from './types.js';

export interface GitPatchPreflightInput {
  plan: RemediationPlan;
  mode: IncidentMode;
  resourceKind: ResourceKind;
  resourceName: string;
  facts?: Partial<DiagnosisContext>;
  gitopsRepoUrl?: string;
  envPatchMode?: string;
}

export interface GitPatchPreflightResult {
  allowed: boolean;
  issues: PlanValidationIssue[];
  /** Plan with patchTarget forced to cluster when Git path is unavailable. */
  normalizedPlan?: RemediationPlan;
  summary: string;
}

function hasGitManifest(facts?: Partial<DiagnosisContext>): boolean {
  return Boolean(facts?.gitManifestContent?.trim() || facts?.gitManifestPath?.trim());
}

function hasClusterWorkload(facts?: Partial<DiagnosisContext>, resourceKind?: ResourceKind): boolean {
  if (resourceKind === 'Deployment' || resourceKind === 'StatefulSet') return true;
  if (facts?.phase && facts.phase !== 'Unknown') return true;
  if (facts?.currentLogs?.trim()) return true;
  if (facts?.previousLogs?.trim()) return true;
  return false;
}

function resolvedTarget(input: GitPatchPreflightInput): PatchTarget {
  return resolveGitPatchTarget({
    planTarget: input.plan.patchTarget,
    envMode: input.envPatchMode ?? process.env['GITOPS_PATCH_MODE'],
    diagnoseMode: input.mode === 'diagnose',
  });
}

/** Git mirror / commit path requires manifest or configured GitOps repo. */
export function gitMirrorPathReady(
  input: GitPatchPreflightInput,
  target: PatchTarget
): boolean {
  const repo = (input.gitopsRepoUrl ?? process.env['GITOPS_REPO_URL'] ?? '').trim();
  if (target === 'cluster') return false;
  if (target === 'gitops') return Boolean(repo);
  return Boolean(repo) && hasGitManifest(input.facts);
}

export function assessGitPatchPreflight(input: GitPatchPreflightInput): GitPatchPreflightResult {
  const issues: PlanValidationIssue[] = [];
  const plan = input.plan;

  if (plan.action !== 'git_patch') {
    return { allowed: true, issues: [], summary: 'Not a git_patch plan.' };
  }

  if (!plan.proposedPatch?.length) {
    issues.push({
      code: 'empty_patch',
      severity: 'HIGH',
      message: 'git_patch requires non-empty proposedPatch (container image, resources, or replicas)',
    });
    return {
      allowed: false,
      issues,
      summary: 'git_patch blocked: empty proposedPatch.',
    };
  }

  const target = resolvedTarget(input);
  const mirrorReady = gitMirrorPathReady(input, target);
  const clusterReady = hasClusterWorkload(input.facts, input.resourceKind);

  const onlyPodTemplate = plan.proposedPatch.every((op) =>
    (op.path ?? '').startsWith('/spec/template/')
  );
  if (!onlyPodTemplate && input.mode === 'diagnose') {
    issues.push({
      code: 'non_pod_template_patch',
      severity: 'MEDIUM',
      message: 'Diagnose git_patch should only change pod template fields on live workloads',
    });
  }

  if (target === 'gitops' && !mirrorReady) {
    issues.push({
      code: 'gitops_repo_missing',
      severity: 'HIGH',
      message: 'GITOPS_PATCH_MODE=gitops requires GITOPS_REPO_URL and/or git manifest in facts',
    });
  }

  if ((target === 'cluster' || target === 'auto') && !clusterReady) {
    issues.push({
      code: 'cluster_target_unverified',
      severity: 'HIGH',
      message:
        'No verified Deployment/StatefulSet or pod evidence in facts — gather workload state before patching',
    });
  }

  if (target === 'auto' && !mirrorReady && clusterReady && onlyPodTemplate) {
    const normalizedPlan: RemediationPlan = {
      ...plan,
      patchTarget: 'cluster',
      reasoning:
        `${plan.reasoning} (cluster hot-fix: no Git manifest/repo — skipping Git mirror)`.trim(),
    };
    const blocking = issues.filter((i) => i.severity === 'HIGH' && i.code !== 'gitops_repo_missing');
    if (blocking.length === 0) {
      return {
        allowed: true,
        issues: issues.filter((i) => i.code !== 'gitops_repo_missing'),
        normalizedPlan,
        summary: 'git_patch will apply as direct cluster hot-fix (no Git mirror).',
      };
    }
  }

  if (target === 'gitops' && !mirrorReady) {
    return {
      allowed: false,
      issues,
      summary: 'git_patch blocked: GitOps mirror path not ready.',
    };
  }

  if ((target === 'cluster' || (target === 'auto' && !mirrorReady)) && !clusterReady) {
    return {
      allowed: false,
      issues,
      summary: 'git_patch blocked: cluster target not verified.',
    };
  }

  const normalizedPlan =
    input.mode === 'diagnose' && target !== 'gitops'
      ? { ...plan, patchTarget: 'cluster' as const }
      : undefined;

  return {
    allowed: issues.every((i) => i.severity !== 'HIGH'),
    issues,
    normalizedPlan,
    summary:
      issues.length === 0
        ? 'git_patch preflight passed.'
        : `git_patch preflight: ${issues.map((i) => i.code).join(', ')}`,
  };
}

/** After Git mirror/commit failure — same patch via live cluster API. */
export function clusterHotFixFallbackPlan(plan: RemediationPlan, errorHint?: string): RemediationPlan {
  return {
    ...plan,
    patchTarget: 'cluster',
    reasoning:
      `${plan.reasoning}\nGit repository patch failed${errorHint ? `: ${errorHint.slice(0, 200)}` : ''}. ` +
      `Approve direct cluster hot-fix (kubectl patch on Deployment/StatefulSet).`.trim(),
    commitMessage: plan.commitMessage.replace(/^fix:/, 'fix(cluster):'),
  };
}

export function isGitMirrorFailure(error?: string): boolean {
  if (!error) return false;
  return /gitops|git mirror|applypatchandpush|commit|push rejected|manifest.*not found|GITOPS_REPO|repo mirror|could not clone/i.test(
    error
  );
}
