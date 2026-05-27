// ─────────────────────────────────────────────────────────────────────────────
// src/confirm.ts — POST /confirm handler (called by gitops-agent)
//
// Receives a RemediationResult, looks up the originating platform + channelId
// from the payload, and posts a success/failure message back to the right
// Slack channel or Telegram chat.
// ─────────────────────────────────────────────────────────────────────────────

import type { Request, Response } from 'express';
import type { WebClient } from '@slack/web-api';
import type { Telegraf } from 'telegraf';
import type { RemediationResult } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';

const AGENT = 'commander-agent';

// ── Notifier registry ─────────────────────────────────────────────────────────
// Platform clients are injected at startup so confirm.ts stays testable.

let slackClient: WebClient | null = null;
let telegramBot: Telegraf | null = null;

export function registerSlackClient(client: WebClient): void {
  slackClient = client;
}

export function registerTelegramBot(bot: Telegraf): void {
  telegramBot = bot;
}

// ── Message formatters ────────────────────────────────────────────────────────

function formatSuccess(result: RemediationResult): string {
  const lines: string[] = [
    `✅ *Remediation complete* — Incident \`${result.incidentId}\``,
    `• Resource: \`${result.namespace}/${result.resourceName}\``,
  ];
  if (result.gitCommitUrl) {
    lines.push(`• Commit: <${result.gitCommitUrl}|${result.gitCommitSha ?? 'view'}>`);
  }
  if (result.argoCDAppUrl) {
    lines.push(`• ArgoCD: <${result.argoCDAppUrl}|${result.argoCDSyncStatus ?? 'view'}>`);
  }
  return lines.join('\n');
}

function formatFailure(result: RemediationResult): string {
  const lines: string[] = [
    `❌ *Remediation failed* — Incident \`${result.incidentId}\``,
    `• Resource: \`${result.namespace}/${result.resourceName}\``,
  ];
  if (result.error) {
    lines.push(`• Error: ${result.error}`);
  }
  return lines.join('\n');
}

// ── Express handler ───────────────────────────────────────────────────────────

export async function confirmHandler(req: Request, res: Response): Promise<void> {
  const result = req.body as RemediationResult;

  if (!result.incidentId) {
    log('warn', AGENT, 'Received /confirm with missing incidentId', { incidentId: 'N/A' });
    res.status(400).json({ error: 'incidentId is required' });
    return;
  }

  log('info', AGENT, 'Received /confirm from gitops-agent', {
    incidentId: result.incidentId,
    success: result.success,
    platform: result.platform,
    channelId: result.channelId,
  });

  const message = result.success ? formatSuccess(result) : formatFailure(result);

  // Acknowledge immediately — posting to platform is best-effort
  res.status(200).json({ received: true });

  const platform = result.platform;
  const channelId = result.channelId;

  if (!platform || !channelId) {
    log('warn', AGENT, 'No platform/channelId in RemediationResult — cannot reply', {
      incidentId: result.incidentId,
    });
    return;
  }

  try {
    switch (platform) {
      case 'slack': {
        if (!slackClient) {
          log('warn', AGENT, 'Slack client not registered — cannot send confirm message', {
            incidentId: result.incidentId,
          });
          return;
        }
        await slackClient.chat.postMessage({
          channel: channelId,
          text: message,
          mrkdwn: true,
        });
        log('info', AGENT, 'Confirmation posted to Slack', {
          incidentId: result.incidentId,
          channelId,
        });
        break;
      }

      case 'telegram': {
        if (!telegramBot) {
          log('warn', AGENT, 'Telegram bot not registered — cannot send confirm message', {
            incidentId: result.incidentId,
          });
          return;
        }
        // Telegram channelIds are numeric chat IDs stored as strings
        const chatId = parseInt(channelId, 10);
        if (isNaN(chatId)) {
          log('error', AGENT, 'Invalid Telegram channelId (not a number)', {
            incidentId: result.incidentId,
            channelId,
          });
          return;
        }
        // Telegram uses Markdown V2 — send plain text for safety
        const plainMessage = message.replace(/[*`<>]/g, '');
        await telegramBot.telegram.sendMessage(chatId, plainMessage);
        log('info', AGENT, 'Confirmation posted to Telegram', {
          incidentId: result.incidentId,
          channelId,
        });
        break;
      }

      case 'teams':
        // Microsoft Teams webhook support is handled via an incoming webhook URL
        // stored in channelId for the Teams platform.
        log('warn', AGENT, 'Teams confirm reply not yet wired — channelId stored for future use', {
          incidentId: result.incidentId,
          channelId,
        });
        break;

      case 'web':
        // Web clients poll or use SSE — no push needed from this agent.
        log('info', AGENT, 'Web platform confirm received — no push action required', {
          incidentId: result.incidentId,
        });
        break;

      default: {
        log('warn', AGENT, `Unknown platform in /confirm payload: ${platform}`, {
          incidentId: result.incidentId,
        });
      }
    }
  } catch (err) {
    log('error', AGENT, 'Failed to post confirmation message to platform', {
      incidentId: result.incidentId,
      platform,
      channelId,
      error: String(err),
    });
  }
}
