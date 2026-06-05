/**
 * Fire-and-forget: after a fix PR opens, poll CI on the PR branch and notify the operator.
 */

import type { Platform } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { pollCiUntilSettled } from './ci-verify-poll.js';

const AGENT = 'cicd-ci-verify-watch';
const COMMANDER_URL = process.env['COMMANDER_URL'] ?? 'http://commander-agent:8080';
const ORCHESTRATOR_URL = process.env['ORCHESTRATOR_URL'] ?? 'http://orchestrator-agent:8080';

const activeWatches = new Set<string>();

export interface WatchCiAfterPrOpts {
  githubRepo: string;
  branch: string;
  workflowName?: string;
  incidentId: string;
  runId?: string;
  platform?: Platform;
  channelId?: string;
  prUrl?: string;
}

function watchKey(opts: WatchCiAfterPrOpts): string {
  return `${opts.incidentId}:${opts.branch}`;
}

async function notifyUpdate(opts: WatchCiAfterPrOpts, kind: string, message: string): Promise<void> {
  if (!opts.platform || !opts.channelId) return;
  try {
    await fetch(`${COMMANDER_URL}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: opts.platform,
        channelId: opts.channelId,
        message,
        incidentId: opts.incidentId,
        runId: opts.runId,
        update: {
          kind,
          incidentId: opts.incidentId,
          runId: opts.runId,
          mode: 'ci-failure',
          repo: opts.githubRepo,
          ciPrUrl: opts.prUrl,
          technicalMessage: message,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    log('warn', AGENT, 'Notify failed', { error: String(err), incidentId: opts.incidentId });
  }
}

async function recordCiVerifyOutcome(runId: string, worked: boolean, message: string): Promise<void> {
  try {
    await fetch(`${ORCHESTRATOR_URL}/runs/${encodeURIComponent(runId)}/ci-verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worked, message }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    log('warn', AGENT, 'Could not record CI verify outcome', { runId, error: String(err) });
  }
}

export function watchCiAfterPr(opts: WatchCiAfterPrOpts): void {
  if (!opts.branch?.trim()) return;
  const key = watchKey(opts);
  if (activeWatches.has(key)) return;
  activeWatches.add(key);

  void (async () => {
    try {
      await notifyUpdate(
        opts,
        'ci_pr_verify_started',
        opts.prUrl
          ? `Fix PR opened: ${opts.prUrl}\nWatching CI on branch \`${opts.branch}\` — I'll message you when it passes or fails.`
          : `Watching CI on branch \`${opts.branch}\` after the fix PR — I'll message you when it completes.`
      );

      const result = await pollCiUntilSettled({
        githubRepo: opts.githubRepo,
        branch: opts.branch,
        workflowName: opts.workflowName,
        incidentId: opts.incidentId,
      });

      if (result.success) {
        await notifyUpdate(
          opts,
          'ci_pr_verify_succeeded',
          `✅ **CI passed** after the fix PR on \`${opts.githubRepo}\`.\n${result.message}`
        );
        if (opts.runId) {
          await recordCiVerifyOutcome(opts.runId, true, result.message);
        }
      } else {
        await notifyUpdate(
          opts,
          'ci_pr_verify_failed',
          `❌ **CI still failing** on \`${opts.githubRepo}\` branch \`${opts.branch}\`.\n${result.message.slice(0, 500)}`
        );
        if (opts.runId) {
          await recordCiVerifyOutcome(opts.runId, false, result.message);
        }
      }
    } catch (err) {
      await notifyUpdate(
        opts,
        'ci_pr_verify_failed',
        `Could not verify CI after PR: ${String(err).slice(0, 300)}`
      );
    } finally {
      activeWatches.delete(key);
    }
  })();
}
