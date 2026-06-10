/**
 * Orchestrator helper — revert GitOps deploy commit after failed verification.
 */

import { log, postJson } from '../../../shared/src/http.js';
import type { RemediationPlan } from '../../../shared/src/types.js';
import {
  autoGitRollbackRequireHil,
  canAttemptGitRollback,
  parseDeployGitRollback,
} from '../../../shared/src/deploy-git-rollback.js';
import { mergeRunMetadata } from './run-store.js';
import type { OrchestratorRunContext } from './tools.js';

const AGENT = 'orchestrator-git-rollback';
const GITOPS_URL = process.env['GITOPS_URL'] ?? 'http://gitops-agent:8080';

export interface GitRollbackAttempt {
  attempted: boolean;
  success?: boolean;
  message: string;
  revertCommitUrl?: string;
  awaitingApproval?: boolean;
}

export function buildGitRevertPlan(verifyMessage: string): RemediationPlan {
  return {
    action: 'git_revert',
    rootCause: 'Deploy verification failed — restore last-known-good Git revision',
    reasoning: verifyMessage.slice(0, 800),
    rollbackSafe: true,
    commitMessage: 'sre-bot: revert failed deploy (verification)',
  };
}

async function callRevertDeploy(opts: {
  incidentId: string;
  namespace: string;
  resourceName: string;
  deployGitCommitSha?: string;
  previousGitCommitSha?: string;
  reason: string;
}): Promise<{
  success: boolean;
  error?: string;
  gitCommitUrl?: string;
  gitCommitSha?: string;
  previousGitCommitSha?: string;
}> {
  return postJson(`${GITOPS_URL}/revert-deploy`, opts, opts.incidentId);
}

export async function executeGitRevert(ctx: OrchestratorRunContext): Promise<GitRollbackAttempt> {
  const run = await (await import('./run-store.js')).getRun(ctx.runId);
  const rollbackState = parseDeployGitRollback(run?.metadata);
  const gate = canAttemptGitRollback(rollbackState, ctx.namespace);
  if (!gate.allowed) {
    return { attempted: false, message: gate.reason };
  }

  try {
    const result = await callRevertDeploy({
      incidentId: ctx.incidentId,
      namespace: ctx.namespace,
      resourceName: ctx.resourceName,
      deployGitCommitSha: rollbackState!.deployGitCommitSha,
      previousGitCommitSha: rollbackState!.previousGitCommitSha,
      reason: ctx.pendingPlan?.reasoning ?? 'deploy verification failed',
    });

    await mergeRunMetadata(ctx.runId, {
      deployGitRollback: {
        ...rollbackState,
        revertedAt: new Date().toISOString(),
        revertCommitSha: result.gitCommitSha,
        revertCommitUrl: result.gitCommitUrl,
      },
    });

    if (!result.success) {
      return { attempted: true, success: false, message: result.error ?? 'Git revert failed' };
    }

    return {
      attempted: true,
      success: true,
      message: `Reverted deploy commit to last-known-good (${result.previousGitCommitSha?.slice(0, 8) ?? 'prior'})`,
      revertCommitUrl: result.gitCommitUrl,
    };
  } catch (err) {
    return { attempted: true, success: false, message: String(err) };
  }
}

export async function attemptDeployGitRollback(opts: {
  runId: string;
  incidentId: string;
  namespace: string;
  resourceName: string;
  verifyMessage: string;
  requestHil?: (plan: RemediationPlan) => Promise<void>;
}): Promise<GitRollbackAttempt> {
  const { getRun } = await import('./run-store.js');
  const run = await getRun(opts.runId);
  const rollbackState = parseDeployGitRollback(run?.metadata);
  const gate = canAttemptGitRollback(rollbackState, opts.namespace);
  if (!gate.allowed) {
    return { attempted: false, message: gate.reason };
  }

  if (autoGitRollbackRequireHil()) {
    const plan = buildGitRevertPlan(opts.verifyMessage);
    if (opts.requestHil) {
      await opts.requestHil(plan);
      return {
        attempted: false,
        awaitingApproval: true,
        message: 'Git revert queued — waiting for operator approval',
      };
    }
    return {
      attempted: false,
      message: 'Git revert requires HIL approval (no requestHil callback)',
    };
  }

  try {
    const result = await callRevertDeploy({
      incidentId: opts.incidentId,
      namespace: opts.namespace,
      resourceName: opts.resourceName,
      deployGitCommitSha: rollbackState!.deployGitCommitSha,
      previousGitCommitSha: rollbackState!.previousGitCommitSha,
      reason: opts.verifyMessage.slice(0, 500),
    });

    await mergeRunMetadata(opts.runId, {
      deployGitRollback: {
        ...rollbackState,
        revertedAt: new Date().toISOString(),
        revertCommitSha: result.gitCommitSha,
        revertCommitUrl: result.gitCommitUrl,
      },
    });

    if (!result.success) {
      return { attempted: true, success: false, message: result.error ?? 'Git revert failed' };
    }

    log('info', AGENT, 'Deploy git rollback completed', {
      incidentId: opts.incidentId,
      runId: opts.runId,
      revertSha: result.gitCommitSha,
    });

    return {
      attempted: true,
      success: true,
      message: `Reverted deploy commit to last-known-good (${result.previousGitCommitSha?.slice(0, 8) ?? 'prior'})`,
      revertCommitUrl: result.gitCommitUrl,
    };
  } catch (err) {
    return { attempted: true, success: false, message: String(err) };
  }
}
