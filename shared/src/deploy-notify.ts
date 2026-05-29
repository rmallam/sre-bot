/**
 * Human-readable deploy progress lines → commander /notify → Telegram/Slack.
 */

import type { Platform } from './types.js';

export interface DeployNotifyTarget {
  incidentId: string;
  platform?: Platform;
  channelId?: string;
}

const COMMANDER_URL = process.env['COMMANDER_URL'] ?? 'http://commander-agent:8080';

export async function sendDeployProgress(
  target: DeployNotifyTarget,
  message: string
): Promise<void> {
  if (!target.platform || !target.channelId || !message.trim()) return;

  try {
    await fetch(`${COMMANDER_URL}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: target.platform,
        channelId: target.channelId,
        message: message.trim(),
        incidentId: target.incidentId,
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
