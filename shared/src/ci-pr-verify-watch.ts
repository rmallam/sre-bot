/**
 * Trigger post-PR CI verify watch on cicd-agent (CI-3).
 */

import type { Platform } from './types.js';
import { log } from './http.js';

const CICD_URL = process.env['CICD_URL'] ?? 'http://cicd-agent:8080';

export interface WatchCiPrOpts {
  githubRepo: string;
  branch: string;
  workflowName?: string;
  incidentId: string;
  runId?: string;
  platform?: Platform;
  channelId?: string;
  prUrl?: string;
}

export function ciPrVerifyEnabled(): boolean {
  return (process.env['CI_VERIFY_AFTER_PR'] ?? 'true').toLowerCase() !== 'false';
}

/** Fire-and-forget — poll CI on PR branch until green or failure. */
export function scheduleCiPrVerifyWatch(opts: WatchCiPrOpts): void {
  if (!ciPrVerifyEnabled()) return;
  if (!opts.branch?.trim() || !opts.githubRepo?.trim()) return;

  void fetch(`${CICD_URL}/watch-pr-ci`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
    signal: AbortSignal.timeout(15_000),
  }).catch((err) => {
    log('warn', 'ci-pr-verify', 'Failed to schedule CI verify watch', {
      incidentId: opts.incidentId,
      error: String(err),
    });
  });
}

/** Derive PR head branch from incident id (matches cicd-agent branch naming). */
export function ciFixHeadBranch(incidentId: string, kind: 'code' | 'workflow'): string {
  const prefix = kind === 'code' ? 'sre-bot/code-fix-' : 'sre-bot/ci-fix-';
  return `${prefix}${incidentId.slice(0, 8)}`;
}
