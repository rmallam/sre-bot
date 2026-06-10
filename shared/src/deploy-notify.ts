/**
 * Human-readable deploy progress lines → commander /notify → Telegram/Slack.
 */

import type { Platform } from './types.js';

import type { RunUpdateKind } from './run-update.js';

export interface DeployNotifyTarget {
  incidentId: string;
  platform?: Platform;
  channelId?: string;
  runId?: string;
}

const COMMANDER_URL = process.env['COMMANDER_URL'] ?? 'http://commander-agent:8080';

export async function sendDeployProgress(
  target: DeployNotifyTarget,
  message: string,
  opts?: {
    kind?: Extract<RunUpdateKind, 'deploy_progress' | 'deploy_ready' | 'deploy_failed'>;
    namespace?: string;
    resourceName?: string;
  }
): Promise<void> {
  if (!target.platform || !target.channelId || !message.trim()) return;

  const kind = opts?.kind ?? 'deploy_progress';

  try {
    await fetch(`${COMMANDER_URL}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: target.platform,
        channelId: target.channelId,
        message: message.trim(),
        incidentId: target.incidentId,
        update: {
          kind,
          incidentId: target.incidentId,
          runId: target.runId,
          progressStep: message.trim(),
          technicalMessage: message.trim(),
          namespace: opts?.namespace,
          resourceName: opts?.resourceName,
          detailAvailable: kind !== 'deploy_progress' && !!target.runId,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    /* best-effort */
  }
}

export function deployHeader(app: string, namespace: string): string {
  return `Deploy: ${app} → namespace ${namespace}`;
}
