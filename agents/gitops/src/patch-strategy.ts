import { resolveGitPatchTarget, type PatchTarget } from '../../../shared/src/patch-target.js';
import type { RemediateCommand } from '../../../shared/src/types.js';

export function gitPatchTarget(cmd: RemediateCommand): PatchTarget {
  return resolveGitPatchTarget({
    planTarget: cmd.plan.patchTarget,
    diagnoseMode: cmd.mode === 'diagnose',
  });
}

export function shouldTryClusterPatch(target: PatchTarget, hasPatchOps: boolean): boolean {
  return hasPatchOps && (target === 'cluster' || target === 'auto');
}

export function shouldTryGitOpsMirror(
  target: PatchTarget,
  clusterApplied: boolean,
  hasGitOpsRepo: boolean
): boolean {
  if (target === 'cluster') {
    return false;
  }
  if (target === 'gitops') {
    return true;
  }
  return !clusterApplied && hasGitOpsRepo;
}
