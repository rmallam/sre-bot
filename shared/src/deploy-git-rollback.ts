/**
 * Automated Git-level rollback when deploy verification fails.
 */

export interface DeployGitRollbackState {
  previousGitCommitSha?: string;
  deployGitCommitSha?: string;
  appRepoCommitSha?: string;
  revertedAt?: string;
  revertCommitSha?: string;
  revertCommitUrl?: string;
}

export function autoGitRollbackEnabled(): boolean {
  const raw = process.env['AUTO_GIT_ROLLBACK_ENABLED'];
  return raw?.toLowerCase() === 'true' || raw === '1';
}

export function autoGitRollbackRequireHil(): boolean {
  const raw = process.env['AUTO_GIT_ROLLBACK_REQUIRE_HIL'];
  if (raw == null || raw.trim() === '') return true;
  return raw.toLowerCase() === 'true' || raw === '1';
}

export function namespaceAllowsAutoRollback(namespace: string): boolean {
  const blocked = (process.env['AUTO_GIT_ROLLBACK_BLOCK_NAMESPACES'] ?? 'kube-system,production,prod')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return !blocked.includes(namespace.trim().toLowerCase());
}

export function canAttemptGitRollback(
  state: DeployGitRollbackState | undefined,
  namespace: string
): { allowed: boolean; reason: string } {
  if (!autoGitRollbackEnabled()) {
    return { allowed: false, reason: 'AUTO_GIT_ROLLBACK_ENABLED is false' };
  }
  if (!namespaceAllowsAutoRollback(namespace)) {
    return { allowed: false, reason: `namespace ${namespace} is blocked for auto rollback` };
  }
  if (!state?.deployGitCommitSha) {
    return { allowed: false, reason: 'no deploy commit recorded' };
  }
  if (state.revertedAt) {
    return { allowed: false, reason: 'rollback already attempted' };
  }
  return { allowed: true, reason: 'ok' };
}

export function parseDeployGitRollback(metadata: Record<string, unknown> | undefined): DeployGitRollbackState | undefined {
  const raw = metadata?.['deployGitRollback'];
  if (!raw || typeof raw !== 'object') return undefined;
  return raw as DeployGitRollbackState;
}
