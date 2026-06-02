/**
 * Progress updates → commander narration (web chat + Telegram).
 */

import type { RunUpdatePayload } from '../../../shared/src/run-update.js';
import type { Platform } from '../../../shared/src/types.js';

const COMMANDER_URL = process.env['COMMANDER_URL'] ?? 'http://commander-agent:8080';

export async function notifyCodingProgress(opts: {
  platform?: Platform;
  channelId?: string;
  incidentId: string;
  runId?: string;
  kind: RunUpdatePayload['kind'];
  attempt?: number;
  maxAttempts?: number;
  progressStep?: string;
  prUrl?: string;
  technicalMessage?: string;
}): Promise<void> {
  if (!opts.platform || !opts.channelId) return;

  const update: RunUpdatePayload = {
    kind: opts.kind,
    incidentId: opts.incidentId,
    runId: opts.runId,
    codingAgentAttempt: opts.attempt,
    codingAgentMaxAttempts: opts.maxAttempts,
    progressStep: opts.progressStep,
    codingAgentPrUrl: opts.prUrl,
    technicalMessage: opts.technicalMessage,
  };

  try {
    await fetch(`${COMMANDER_URL}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: opts.platform,
        channelId: opts.channelId,
        incidentId: opts.incidentId,
        update,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    /* best effort */
  }
}
