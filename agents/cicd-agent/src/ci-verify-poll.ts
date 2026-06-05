/**
 * Poll GitHub Actions on a branch until CI completes (post-PR verify — CI-3).
 */

import type { CiRunFacts } from '../../../shared/src/ci-types.js';
import { log } from '../../../shared/src/http.js';
import { fetchLatestRunOnBranch, fetchRunById } from './github.js';

const AGENT = 'cicd-ci-verify';

export interface CiVerifyPollResult {
  success: boolean;
  message: string;
  run?: CiRunFacts;
}

export async function pollCiUntilSettled(opts: {
  githubRepo: string;
  branch: string;
  workflowName?: string;
  initialDelayMs?: number;
  pollMs?: number;
  timeoutMs?: number;
  incidentId?: string;
}): Promise<CiVerifyPollResult> {
  const initialDelay = opts.initialDelayMs ?? parseInt(process.env['CI_VERIFY_INITIAL_DELAY_MS'] ?? '45000', 10);
  const pollMs = opts.pollMs ?? parseInt(process.env['CI_VERIFY_POLL_MS'] ?? '20000', 10);
  const timeoutMs = opts.timeoutMs ?? parseInt(process.env['CI_VERIFY_TIMEOUT_MS'] ?? '1200000', 10);

  await sleep(initialDelay);

  const deadline = Date.now() + timeoutMs;
  let last: CiRunFacts | null = null;

  while (Date.now() < deadline) {
    last = await fetchLatestRunOnBranch(opts.githubRepo, {
      branch: opts.branch,
      workflowName: opts.workflowName,
    });

    if (!last) {
      await sleep(pollMs);
      continue;
    }

    if (last.status === 'in_progress' || last.status === 'queued' || last.status === 'waiting') {
      log('debug', AGENT, 'CI still running on branch', {
        incidentId: opts.incidentId,
        branch: opts.branch,
        runId: last.workflowRunId,
        status: last.status,
      });
      await sleep(pollMs);
      continue;
    }

    if (last.conclusion === 'success') {
      return {
        success: true,
        message: `CI passed on \`${opts.branch}\` — workflow "${last.workflowName}" run #${last.workflowRunId}.`,
        run: last,
      };
    }

    if (last.conclusion === 'failure' || last.conclusion === 'cancelled' || last.conclusion === 'timed_out') {
      const detailed = await fetchRunById(opts.githubRepo, last.workflowRunId);
      const category = detailed.diagnosis?.category ?? 'unknown';
      return {
        success: false,
        message:
          `CI still failing on \`${opts.branch}\` — "${last.workflowName}" run #${last.workflowRunId} ` +
          `(${category}).\n${detailed.htmlUrl ?? ''}`,
        run: detailed,
      };
    }

    await sleep(pollMs);
  }

  return {
    success: false,
    message:
      last
        ? `Timed out waiting for CI on \`${opts.branch}\` (last run #${last.workflowRunId} was ${last.status}).`
        : `Timed out — no workflow run appeared on branch \`${opts.branch}\` yet.`,
    run: last ?? undefined,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
