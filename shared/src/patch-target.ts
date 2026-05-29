/**
 * Where git_patch remediation is applied: live cluster vs GitOps mirror.
 */

export type PatchTarget = 'cluster' | 'gitops' | 'auto';

/** Parse GITOPS_PATCH_MODE / plan.patchTarget strings. */
export function parsePatchTarget(raw: string | undefined): PatchTarget {
  const v = (raw ?? 'auto').trim().toLowerCase();
  if (v === 'cluster' || v === 'direct' || v === 'cluster_only' || v === 'cluster-first-only') {
    return 'cluster';
  }
  if (v === 'gitops' || v === 'mirror' || v === 'gitops_only') {
    return 'gitops';
  }
  return 'auto';
}

export interface ResolvePatchTargetInput {
  /** Plan-level override (e.g. operator suggestion). */
  planTarget?: PatchTarget | string;
  /** GITOPS_PATCH_MODE env */
  envMode?: string;
  /** diagnose incidents prefer cluster when mode is auto */
  diagnoseMode?: boolean;
  /** Legacy: GITOPS_CLUSTER_PATCH_FIRST=false forces gitops-only in auto */
  clusterPatchFirstEnv?: string;
}

/**
 * Resolve apply path for git_patch.
 * - cluster: kubectl JSON patch on Deployment/StatefulSet only (no mirror)
 * - gitops: RepoMirror commit only
 * - auto: cluster first; mirror fallback only when GITOPS_REPO_URL is set
 */
export function resolveGitPatchTarget(input: ResolvePatchTargetInput): PatchTarget {
  const fromPlan = input.planTarget
    ? parsePatchTarget(typeof input.planTarget === 'string' ? input.planTarget : input.planTarget)
    : 'auto';
  if (fromPlan !== 'auto') {
    return fromPlan;
  }

  const fromEnv = parsePatchTarget(input.envMode ?? process.env['GITOPS_PATCH_MODE']);
  if (fromEnv !== 'auto') {
    return fromEnv;
  }

  const clusterFirst =
    (input.clusterPatchFirstEnv ?? process.env['GITOPS_CLUSTER_PATCH_FIRST'] ?? 'true').toLowerCase() !==
    'false';
  if (!clusterFirst) {
    return 'gitops';
  }
  if (input.diagnoseMode) {
    return 'cluster';
  }
  return 'auto';
}
