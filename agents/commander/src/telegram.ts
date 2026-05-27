// ─────────────────────────────────────────────────────────────────────────────
// src/telegram.ts — Telegram integration via telegraf
//
// Handles both structured slash commands and free-form text messages.
//
// Commands:
//   /deploy <github-url> [@branch]
//   /investigate [namespace/]<resource>
//   /rollback [namespace/]<resource>
//
// Free text is run through parseCommand() for best-effort interpretation.
//
// All messages go through isAuthorized() first. The Telegram user ID is
// converted to a string for uniform treatment with Slack/Teams IDs.
// ─────────────────────────────────────────────────────────────────────────────

import { Telegraf, type Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { Markup } from 'telegraf';
import { log } from '../../../shared/src/http.js';
import { isAuthorized } from './auth.js';
import { parseCommand } from './parser.js';
import { handleCommand } from './router.js';
import { routeMessage } from './llm-router.js';
import { registerTelegramBot } from './confirm.js';
import { registerTelegramBotForNotify } from './notify.js';
import {
  buildDeployChoicePrompt,
  resolvePendingChoiceSelection,
  tryResolvePendingChoice,
} from './deploy-choice.js';

const AGENT = 'commander-agent';
const PLATFORM = 'telegram' as const;
const HIL_URL = process.env['HIL_URL'] ?? 'http://localhost:8085';

// ── Helpers ───────────────────────────────────────────────────────────────────

function userId(ctx: Context): string {
  return String(ctx.from?.id ?? 'unknown');
}

function channelId(ctx: Context): string {
  return String(ctx.chat?.id ?? 'unknown');
}

function ackMessage(incidentId: string, type: string, parsed?: import('./parser.js').ParsedCommand): string {
  if (type === 'unknown') {
    return "Sorry, I didn't understand that. Try:\n/deploy github.com/org/repo\nor: deploy my app github.com/org/repo --namespace staging";
  }
  if (type === 'deploy' && parsed?.type === 'deploy') {
    const strategyText =
      parsed.deployStrategy === 'direct'
        ? 'Direct apply from source repo (no Git push)'
        : 'GitOps flow (push app/GitOps repos + Argo CD)';
    return (
      `🚀 Deploy started — tracking \`${incidentId}\`\n` +
      `Repo: ${parsed.githubRepo} @ ${parsed.gitRef}\n` +
      `Namespace: ${parsed.namespace}\n` +
      `Mode: ${strategyText}\n\n` +
      `I'll clone the repo, choose the right deploy path, and message you when done.`
    );
  }
  return `Got it! Autonomous run started — tracking: ${incidentId}\nI'll message you when done.`;
}

/** Send a safe reply — Telegraf context may or may not have a message to reply to. */
async function safeReply(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.reply(text);
  } catch (err) {
    log('warn', AGENT, 'Failed to send Telegram reply', {
      incidentId: 'N/A',
      error: String(err),
    });
  }
}

async function processText(ctx: Context, rawText: string): Promise<void> {
  const uid = userId(ctx);
  const cid = channelId(ctx);

  if (!isAuthorized(uid, PLATFORM)) {
    await safeReply(ctx, '🚫 You are not authorized to use this bot.');
    return;
  }

  const decision = tryResolvePendingChoice(PLATFORM, cid, uid, rawText);
  if (decision.status === 'cancelled') {
    await safeReply(ctx, 'Deploy request cancelled.');
    return;
  }
  if (decision.status === 'selected' && decision.deploy) {
    const incidentId = await handleCommand(decision.deploy, uid, PLATFORM, cid, rawText);
    await safeReply(ctx, ackMessage(incidentId, decision.deploy.type, decision.deploy));
    return;
  }

  const routed = await routeMessage(rawText, PLATFORM, uid);
  const parsed = routed.parsed;

  if (parsed.type === 'unknown' && routed.conversationalReply) {
    await safeReply(ctx, routed.conversationalReply);
    return;
  }
  log('info', AGENT, 'Telegram message received', {
    incidentId: 'N/A',
    userId: uid,
    channelId: cid,
    commandType: parsed.type,
  });

  try {
    if (parsed.type === 'deploy' && !parsed.deployStrategyExplicit) {
      const prompt = await buildDeployChoicePrompt(PLATFORM, cid, uid, parsed);
      await ctx.reply(
        prompt,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('GitOps', 'deploy_choice_gitops'),
            Markup.button.callback('Direct (No Git Push)', 'deploy_choice_direct'),
          ],
          [Markup.button.callback('Cancel', 'deploy_choice_cancel')],
        ])
      );
      return;
    }
    const incidentId = await handleCommand(parsed, uid, PLATFORM, cid, rawText);
    await safeReply(ctx, ackMessage(incidentId, parsed.type, parsed));
  } catch (err) {
    log('error', AGENT, 'Error handling Telegram message', {
      incidentId: 'N/A',
      userId: uid,
      channelId: cid,
      error: String(err),
    });
    await safeReply(ctx, '⚠️ An internal error occurred. Please try again.');
  }
}

// ── Bot factory ───────────────────────────────────────────────────────────────

export function createTelegramBot(): Telegraf {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN must be set to enable the Telegram integration');
  }

  const bot = new Telegraf(token);

  // Register with confirm.ts so it can push result messages
  registerTelegramBot(bot);
  registerTelegramBotForNotify(bot);

  // ── /start — onboarding ────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    const uid = userId(ctx);
    if (!isAuthorized(uid, PLATFORM)) {
      await safeReply(ctx, '🚫 You are not authorized to use this bot.');
      return;
    }
    await safeReply(
      ctx,
      'Welcome to the Kube SRE Bot!\n\n' +
        'Commands:\n' +
        '/deploy <github-url> [@branch] — deploy a service\n' +
        '/deploy <github-url> --no-git-push — deploy directly from source repo\n' +
        '/investigate [namespace/]<resource> — diagnose issues\n' +
        '/rollback [namespace/]<resource> — roll back a deployment\n\n' +
        'You can also send free-form messages and I will try to understand.'
    );
  });

  // ── /deploy ────────────────────────────────────────────────────────────────
  bot.command('deploy', async (ctx) => {
    const rawText = ctx.message.text.replace(/^\/deploy\s*/i, '').trim();
    if (!rawText) {
      await safeReply(
        ctx,
        'Usage: /deploy github.com/org/repo [@branch] [--namespace ns] [--no-git-push]'
      );
      return;
    }
    await processText(ctx, `deploy ${rawText}`);
  });

  // ── /investigate ───────────────────────────────────────────────────────────
  bot.command('investigate', async (ctx) => {
    const rest = ctx.message.text.replace(/^\/investigate\s*/i, '').trim();
    await processText(ctx, `investigate ${rest}`);
  });

  // ── /rollback ──────────────────────────────────────────────────────────────
  bot.command('rollback', async (ctx) => {
    const rest = ctx.message.text.replace(/^\/rollback\s*/i, '').trim();
    await processText(ctx, `rollback ${rest}`);
  });

  // ── Free-form text messages ────────────────────────────────────────────────
  bot.on(message('text'), async (ctx) => {
    // Skip if it starts with "/" (already handled by command handlers above)
    if (ctx.message.text.startsWith('/')) return;
    await processText(ctx, ctx.message.text.trim());
  });

  // ── Callback Query handler ──────────────────────────────────────────────────
  bot.on('callback_query', async (ctx) => {
    const data = (ctx.callbackQuery as { data?: string }).data ?? '';
    if (data.startsWith('deploy_choice_')) {
      const choice = data.replace('deploy_choice_', '') as 'gitops' | 'direct' | 'cancel';
      const uid = String(ctx.callbackQuery.from.id);
      const cid = channelId(ctx);
      const resolved = resolvePendingChoiceSelection(PLATFORM, cid, uid, choice);

      if (resolved.status === 'none') {
        await ctx.answerCbQuery('Choice expired. Please run /deploy again.');
        return;
      }
      if (resolved.status === 'cancelled') {
        await ctx.answerCbQuery('Cancelled');
        await ctx.editMessageText('Deploy request cancelled.').catch(() => {});
        return;
      }
      if (!resolved.deploy) {
        await ctx.answerCbQuery('No deploy payload found');
        return;
      }

      await ctx.answerCbQuery(`Selected: ${choice}`);
      try {
        const incidentId = await handleCommand(
          resolved.deploy,
          uid,
          PLATFORM,
          cid,
          `deploy choice: ${choice}`
        );
        await ctx.editMessageText(
          ackMessage(incidentId, resolved.deploy.type, resolved.deploy)
        ).catch(() => {});
      } catch (err) {
        log('error', AGENT, 'Failed to start deploy after strategy selection', {
          incidentId: 'N/A',
          userId: uid,
          channelId: cid,
          error: String(err),
        });
        await ctx.editMessageText('⚠️ Failed to start deploy. Please try again.').catch(() => {});
      }
      return;
    }

    if (!data.startsWith('hil_')) {
      await ctx.answerCbQuery('Unknown action');
      return;
    }

    const [, action, ...parts] = data.split('_');
    const incidentId = parts.join('_');
    const userId = ctx.callbackQuery.from.username ?? String(ctx.callbackQuery.from.id);

    log('info', AGENT, `Telegram callback query received: ${action}`, { incidentId, userId });

    try {
      const res = await fetch(`${HIL_URL}/api/${action}/${incidentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, platform: PLATFORM }),
      });

      if (res.ok) {
        if (action === 'approve') {
          await ctx.answerCbQuery('✅ Approved! Dispatching remediation…');
          await ctx.editMessageText(
            `✅ *Approved* by @${userId} via Telegram.\nDispatching remediation for \`${incidentId}\`…`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        } else {
          await ctx.answerCbQuery('❌ Rejected');
          await ctx.editMessageText(
            `❌ *Rejected* by @${userId} via Telegram.`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        }
      } else {
        const errJson = await res.json() as any;
        const errMsg = errJson?.error ?? 'Request failed';
        await ctx.answerCbQuery(`⚠️ Action failed: ${errMsg}`);
      }
    } catch (err) {
      log('error', AGENT, 'Failed to forward Telegram callback query to HIL agent', {
        incidentId,
        error: String(err),
      });
      await ctx.answerCbQuery('⚠️ Connection to HIL agent failed.');
    }
  });

  // ── Error handler ──────────────────────────────────────────────────────────
  bot.catch((err: unknown, ctx: Context) => {
    log('error', AGENT, 'Telegraf unhandled error', {
      incidentId: 'N/A',
      userId: userId(ctx),
      error: String(err),
    });
  });

  return bot;
}
