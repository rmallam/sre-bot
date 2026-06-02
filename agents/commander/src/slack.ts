// ─────────────────────────────────────────────────────────────────────────────
// src/slack.ts — Slack integration via @slack/bolt (Socket Mode)
//
// Listens for:
//   • App mentions (@bot <command>)
//   • Direct messages to the bot
//
// Every message goes through isAuthorized() then parseCommand() then
// handleCommand(). Progress / confirmation messages are posted back using
// the Slack WebClient (injected into confirm.ts).
// ─────────────────────────────────────────────────────────────────────────────

import pkg from '@slack/bolt';
import type { App } from '@slack/bolt';
const { LogLevel } = pkg;
import { log } from '../../../shared/src/http.js';
import { isAuthorized } from './auth.js';
import { handleCommand } from './router.js';
import { registerSlackClient } from './confirm.js';
import { registerSlackClientForNotify } from './notify.js';
import { routeMessage } from './llm-router.js';
import { buildDeployChoicePrompt, tryResolvePendingChoice } from './deploy-choice.js';
import {
  buildNamespaceCreatePrompt,
  needsNamespaceCreatePrompt,
  storeNamespaceCreatePrompt,
  tryResolveNamespaceCreateChoice,
} from './namespace-prompt.js';
import {
  resolveInvestigateFlow,
  storeInvestigateChoice,
  tryResolvePendingInvestigateChoice,
} from './investigate-choice.js';
import { tryResolvePendingDeleteChoice } from './delete-choice.js';
import { getChannelPref } from './channel-prefs.js';

const AGENT = 'commander-agent';
const PLATFORM = 'slack' as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strip the mention prefix from a message that begins with "<@BOTID>".
 * e.g. "<@U12345> deploy https://github.com/org/repo" → "deploy https://github.com/org/repo"
 */
function stripMention(text: string): string {
  return text.replace(/^<@[A-Z0-9]+>\s*/i, '').trim();
}

/** Build the acknowledgement string shown immediately to the user. */
function ackMessage(incidentId: string, type: string, parsed?: import('./parser.js').ParsedCommand): string {
  if (type === 'unknown') {
    return (
      "Sorry, I didn't understand that command. Try:\n" +
      '• `deploy <github-url> [@branch]`\n' +
      '• `get namespaces` / `get pods in staging`\n' +
      '• `investigate [namespace/]<resource>`\n' +
      '• `rollback [namespace/]<resource>`'
    );
  }
  if (type === 'deploy' && parsed?.type === 'deploy') {
    if (parsed.stackServices && parsed.stackServices.length > 1) {
      return (
        `🚀 Stack deploy started — tracking: \`${incidentId}\`\n` +
        `Services: ${parsed.stackServices.map((s) => s.name).join(', ')}\n` +
        `Namespace: ${parsed.namespace}\n` +
        `Mode: ${parsed.deployStrategy === 'direct' ? 'Direct apply (generated Helm per service)' : 'GitOps'}`
      );
    }
    return (
      `🚀 Deploy started — tracking: \`${incidentId}\`\n` +
      `Repo: ${parsed.githubRepo} @ ${parsed.gitRef}\n` +
      `Namespace: ${parsed.namespace}\n` +
      `Mode: ${parsed.deployStrategy === 'direct' ? 'Direct apply (no Git push)' : 'GitOps'}`
    );
  }
  return `🔍 Got it! I'm on it — tracking: \`${incidentId}\`\nI'll post back here when done.`;
}

// ── App factory ───────────────────────────────────────────────────────────────

export function createSlackApp(): App {
  const botToken = process.env['SLACK_BOT_TOKEN'];
  const appToken = process.env['SLACK_APP_TOKEN'];

  if (!botToken || !appToken) {
    throw new Error(
      'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set to enable the Slack integration'
    );
  }

  const app = new pkg.App({
    token: botToken,
    appToken,
    socketMode: true,
    // Disable the built-in logger in favour of our structured JSON logger
    logger: {
      debug: (...msgs) =>
        log('debug', AGENT, msgs.join(' '), { incidentId: 'N/A', source: 'bolt' }),
      info: (...msgs) =>
        log('info', AGENT, msgs.join(' '), { incidentId: 'N/A', source: 'bolt' }),
      warn: (...msgs) =>
        log('warn', AGENT, msgs.join(' '), { incidentId: 'N/A', source: 'bolt' }),
      error: (...msgs) =>
        log('error', AGENT, msgs.join(' '), { incidentId: 'N/A', source: 'bolt' }),
      setLevel: () => {},
      getLevel: () => LogLevel.INFO,
      setName: () => {},
    },
  });

  // ── Register the WebClient so confirm.ts can post messages ────────────────
  registerSlackClient(app.client);
  registerSlackClientForNotify(app.client);

  // ── App mentions: @bot <command> ──────────────────────────────────────────
  app.event('app_mention', async ({ event, say }) => {
    const userId = event.user ?? 'unknown';
    const channelId = event.channel;
    const rawText = stripMention(event.text ?? '');

    if (!isAuthorized(userId, PLATFORM)) {
      await say({
        text: '🚫 You are not authorized to use this bot.',
        thread_ts: event.ts,
      });
      return;
    }

    const nsPending = tryResolveNamespaceCreateChoice(PLATFORM, channelId, userId, rawText);
    if (nsPending.status === 'cancelled') {
      await say({ text: 'Deploy cancelled — namespace will not be created.', thread_ts: event.ts });
      return;
    }
    if (nsPending.status === 'approved' && nsPending.deploy) {
      const result = await handleCommand(nsPending.deploy, userId, PLATFORM, channelId, rawText);
      await say({
        text:
          result.immediateReply ??
          ackMessage(result.incidentId, nsPending.deploy.type, nsPending.deploy),
        thread_ts: event.ts,
      });
      return;
    }

    const pending = tryResolvePendingChoice(PLATFORM, channelId, userId, rawText);
    if (pending.status === 'cancelled') {
      await say({ text: 'Deploy request cancelled.', thread_ts: event.ts });
      return;
    }
    if (pending.status === 'selected' && pending.deploy) {
      const result = await handleCommand(pending.deploy, userId, PLATFORM, channelId, rawText);
      await say({
        text: result.immediateReply ?? ackMessage(result.incidentId, pending.deploy.type, pending.deploy),
        thread_ts: event.ts,
      });
      return;
    }

    const delPending = tryResolvePendingDeleteChoice(PLATFORM, channelId, userId, rawText);
    if (delPending.status === 'cancelled') {
      await say({ text: 'Delete cancelled.', thread_ts: event.ts });
      return;
    }
    if (delPending.status === 'selected' && delPending.command) {
      try {
        const result = await handleCommand(delPending.command, userId, PLATFORM, channelId, rawText);
        await say({
          text:
            result.immediateReply ??
            ackMessage(result.incidentId, delPending.command.type, delPending.command),
          thread_ts: event.ts,
        });
      } catch (err) {
        await say({ text: `⚠️ ${String(err)}`, thread_ts: event.ts });
      }
      return;
    }

    const invPending = tryResolvePendingInvestigateChoice(PLATFORM, channelId, userId, rawText);
    if (invPending.status === 'cancelled') {
      await say({ text: 'Investigation cancelled.', thread_ts: event.ts });
      return;
    }
    if (invPending.status === 'selected' && invPending.command) {
      const result = await handleCommand(invPending.command, userId, PLATFORM, channelId, rawText);
      await say({
        text:
          result.immediateReply ??
          ackMessage(result.incidentId, invPending.command.type, invPending.command),
        thread_ts: event.ts,
      });
      return;
    }

    const routed = await routeMessage(rawText, PLATFORM, userId, channelId);
    let parsed = routed.parsed;
    if (parsed.type === 'unknown' && routed.conversationalReply) {
      await say({ text: routed.conversationalReply, thread_ts: event.ts });
      return;
    }
    log('info', AGENT, 'Slack app_mention received', {
      incidentId: 'N/A',
      userId,
      channelId,
      commandType: parsed.type,
    });

    try {
      if (parsed.type === 'deploy' && !parsed.deployStrategyExplicit) {
        const prompt = await buildDeployChoicePrompt(PLATFORM, channelId, userId, parsed);
        await say({ text: prompt, thread_ts: event.ts });
        return;
      }
      if (parsed.type === 'deploy') {
        if (!parsed.createNamespace && (await needsNamespaceCreatePrompt(parsed))) {
          storeNamespaceCreatePrompt(PLATFORM, channelId, userId, parsed);
          await say({ text: buildNamespaceCreatePrompt(parsed), thread_ts: event.ts });
          return;
        }
      }
      if (parsed.type === 'investigate') {
        const flow = await resolveInvestigateFlow(parsed, rawText, {
          platform: PLATFORM,
          verbose: getChannelPref(PLATFORM, channelId).verbose,
        });
        if (flow.kind === 'reply') {
          await say({ text: flow.text, thread_ts: event.ts });
          return;
        }
        if (flow.kind === 'confirm') {
          storeInvestigateChoice(PLATFORM, channelId, userId, rawText, parsed, flow.candidates);
          await say({ text: flow.prompt, thread_ts: event.ts });
          return;
        }
        if (flow.kind === 'ready') {
          parsed = flow.command;
        }
      }
      const result = await handleCommand(parsed, userId, PLATFORM, channelId, rawText);
      await say({
        text: result.immediateReply ?? ackMessage(result.incidentId, parsed.type, parsed),
        thread_ts: event.ts,
      });
    } catch (err) {
      log('error', AGENT, 'Error handling Slack app_mention', {
        incidentId: 'N/A',
        userId,
        channelId,
        error: String(err),
      });
      await say({ text: '⚠️ An internal error occurred. Please try again.', thread_ts: event.ts });
    }
  });

  // ── Direct messages to the bot ────────────────────────────────────────────
  app.message(async ({ message, say }) => {
    // Only handle messages in DM channels (channel type 'im')
    if (message.subtype !== undefined) return; // ignore edits, bot messages etc.

    const msg = message as {
      user?: string;
      text?: string;
      channel: string;
      ts: string;
      channel_type?: string;
    };

    // Only handle DMs (channel_type 'im')
    if (msg.channel_type !== 'im') return;

    const userId = msg.user ?? 'unknown';
    const channelId = msg.channel;
    const rawText = (msg.text ?? '').trim();

    if (!isAuthorized(userId, PLATFORM)) {
      await say({ text: '🚫 You are not authorized to use this bot.' });
      return;
    }

    const nsPending = tryResolveNamespaceCreateChoice(PLATFORM, channelId, userId, rawText);
    if (nsPending.status === 'cancelled') {
      await say({ text: 'Deploy cancelled — namespace will not be created.' });
      return;
    }
    if (nsPending.status === 'approved' && nsPending.deploy) {
      const result = await handleCommand(nsPending.deploy, userId, PLATFORM, channelId, rawText);
      await say({
        text:
          result.immediateReply ??
          ackMessage(result.incidentId, nsPending.deploy.type, nsPending.deploy),
      });
      return;
    }

    const pending = tryResolvePendingChoice(PLATFORM, channelId, userId, rawText);
    if (pending.status === 'cancelled') {
      await say({ text: 'Deploy request cancelled.' });
      return;
    }
    if (pending.status === 'selected' && pending.deploy) {
      const result = await handleCommand(pending.deploy, userId, PLATFORM, channelId, rawText);
      await say({
        text: result.immediateReply ?? ackMessage(result.incidentId, pending.deploy.type, pending.deploy),
      });
      return;
    }

    const delPendingDm = tryResolvePendingDeleteChoice(PLATFORM, channelId, userId, rawText);
    if (delPendingDm.status === 'cancelled') {
      await say({ text: 'Delete cancelled.' });
      return;
    }
    if (delPendingDm.status === 'selected' && delPendingDm.command) {
      try {
        const result = await handleCommand(delPendingDm.command, userId, PLATFORM, channelId, rawText);
        await say({
          text:
            result.immediateReply ??
            ackMessage(result.incidentId, delPendingDm.command.type, delPendingDm.command),
        });
      } catch (err) {
        await say({ text: `⚠️ ${String(err)}` });
      }
      return;
    }

    const invPending = tryResolvePendingInvestigateChoice(PLATFORM, channelId, userId, rawText);
    if (invPending.status === 'cancelled') {
      await say({ text: 'Investigation cancelled.' });
      return;
    }
    if (invPending.status === 'selected' && invPending.command) {
      const result = await handleCommand(invPending.command, userId, PLATFORM, channelId, rawText);
      await say({
        text:
          result.immediateReply ??
          ackMessage(result.incidentId, invPending.command.type, invPending.command),
      });
      return;
    }

    const routed = await routeMessage(rawText, PLATFORM, userId, channelId);
    let parsed = routed.parsed;
    if (parsed.type === 'unknown' && routed.conversationalReply) {
      await say({ text: routed.conversationalReply });
      return;
    }
    log('info', AGENT, 'Slack DM received', {
      incidentId: 'N/A',
      userId,
      channelId,
      commandType: parsed.type,
    });

    try {
      if (parsed.type === 'deploy' && !parsed.deployStrategyExplicit) {
        const prompt = await buildDeployChoicePrompt(PLATFORM, channelId, userId, parsed);
        await say({ text: prompt });
        return;
      }
      if (parsed.type === 'deploy') {
        if (!parsed.createNamespace && (await needsNamespaceCreatePrompt(parsed))) {
          storeNamespaceCreatePrompt(PLATFORM, channelId, userId, parsed);
          await say({ text: buildNamespaceCreatePrompt(parsed) });
          return;
        }
      }
      if (parsed.type === 'investigate') {
        const flow = await resolveInvestigateFlow(parsed, rawText, {
          platform: PLATFORM,
          verbose: getChannelPref(PLATFORM, channelId).verbose,
        });
        if (flow.kind === 'reply') {
          await say({ text: flow.text });
          return;
        }
        if (flow.kind === 'confirm') {
          storeInvestigateChoice(PLATFORM, channelId, userId, rawText, parsed, flow.candidates);
          await say({ text: flow.prompt });
          return;
        }
        if (flow.kind === 'ready') {
          parsed = flow.command;
        }
      }
      const result = await handleCommand(parsed, userId, PLATFORM, channelId, rawText);
      await say({ text: result.immediateReply ?? ackMessage(result.incidentId, parsed.type, parsed) });
    } catch (err) {
      log('error', AGENT, 'Error handling Slack DM', {
        incidentId: 'N/A',
        userId,
        channelId,
        error: String(err),
      });
      await say({ text: '⚠️ An internal error occurred. Please try again.' });
    }
  });

  return app;
}
