/**
 * src/telegram-notifier.ts
 *
 * Sends HIL approval requests to Telegram using telegraf.
 * Posts messages with inline keyboard Approve/Reject buttons.
 * Handles callback_query actions atomically via ApprovalStore.
 *
 * Required environment variables:
 *   TELEGRAM_BOT_TOKEN     — from @BotFather
 *   TELEGRAM_ALERT_CHAT_ID — numeric chat / group ID
 */

import { Telegraf, Markup } from 'telegraf';
import { approvalStore } from './store.js';
import { onApproved, onRejected } from './dispatcher.js';
import { log } from '../../../shared/src/http.js';
import type { ApprovalRequest } from '../../../shared/src/types.js';

const AGENT = 'hil-agent';

const TELEGRAM_BOT_TOKEN     = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
const TELEGRAM_ALERT_CHAT_ID = process.env['TELEGRAM_ALERT_CHAT_ID'] ?? '';

/** Lazily-initialised Telegram bot. */
let bot: Telegraf | null = null;

function getBot(): Telegraf | null {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ALERT_CHAT_ID) return null;
  if (bot) return bot;

  bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  // ── Callback query handler ────────────────────────────────────────────────
  bot.on('callback_query', async (ctx) => {
    const data = (ctx.callbackQuery as { data?: string }).data ?? '';
    if (!data.startsWith('hil_')) {
      await ctx.answerCbQuery('Unknown action');
      return;
    }

    const [, action, ...parts] = data.split('_');
    // action_id format: hil_approve_<incidentId> or hil_reject_<incidentId>
    // After splitting on '_', we rejoin parts as incidentId may contain '-'
    const incidentId = parts.join('_');

    const userId =
      ctx.callbackQuery.from.username ?? String(ctx.callbackQuery.from.id);

    log('info', AGENT, `Telegram callback: ${action}`, { incidentId, userId });

    if (action === 'approve') {
      const result = approvalStore.tryApprove(incidentId, userId, 'telegram');

      if (result === 'ok') {
        const entry = approvalStore.get(incidentId)!;
        await onApproved(entry, userId, 'telegram');
        await ctx.answerCbQuery('✅ Approved! Dispatching remediation…');
        await ctx.editMessageText(
          `✅ *Approved* by @${userId} via Telegram.\nDispatching remediation for \`${incidentId}\`…`,
          { parse_mode: 'Markdown' }
        ).catch(() => {/* message may already be edited */});
      } else if (result === 'already_handled') {
        const entry = approvalStore.get(incidentId);
        await ctx.answerCbQuery(
          `ℹ️ Already handled: ${entry?.status ?? 'unknown'}`
        );
      } else if (result === 'expired') {
        await ctx.answerCbQuery('⏰ Approval window expired');
        await ctx.editMessageText(
          `⏰ Approval window expired for \`${incidentId}\`. No action taken.`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      } else {
        await ctx.answerCbQuery(`❓ Unknown incident ${incidentId}`);
      }
    } else if (action === 'reject') {
      const result = approvalStore.tryReject(
        incidentId,
        userId,
        'telegram',
        'Rejected via Telegram'
      );

      if (result === 'ok') {
        const entry = approvalStore.get(incidentId)!;
        await onRejected(entry, userId, 'telegram', 'Rejected via Telegram');
        await ctx.answerCbQuery('❌ Rejected');
        await ctx.editMessageText(
          `❌ *Rejected* by @${userId} via Telegram.`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      } else if (result === 'already_handled') {
        const entry = approvalStore.get(incidentId);
        await ctx.answerCbQuery(
          `ℹ️ Already handled: ${entry?.status ?? 'unknown'}`
        );
      } else {
        await ctx.answerCbQuery(`❓ Unknown incident ${incidentId}`);
      }
    } else {
      await ctx.answerCbQuery('Unknown action');
    }
  });

  return bot;
}

/**
 * Start the Telegram bot long-polling loop.
 * Returns null if Telegram is not configured.
 */
export async function startTelegram(): Promise<void> {
  const b = getBot();
  if (!b) {
    log('warn', AGENT, 'Telegram not configured — TELEGRAM_BOT_TOKEN or TELEGRAM_ALERT_CHAT_ID missing');
    return;
  }

  // We do not call b.launch() here because commander-agent handles the long-polling loop
  // for the same Telegram bot token to avoid 409 Conflict error. HIL agent operates
  // in push-only mode to send alert messages.
  log('info', AGENT, 'Telegram notifications active (push-only mode)');
}

/**
 * Post an approval request message with inline keyboard to Telegram.
 */
export async function notifyTelegram(request: ApprovalRequest): Promise<void> {
  const b = getBot();
  if (!b) {
    log('warn', AGENT, 'Telegram not configured — skipping notification', {
      incidentId: request.incidentId,
    });
    return;
  }

  const chatId = TELEGRAM_ALERT_CHAT_ID;
  const {
    plan,
    incidentId,
    resourceKind,
    resourceName,
    namespace,
    escalated,
    attemptNumber,
    circuitBreakerLimit,
  } = request;

  const patchText = plan.proposedPatch
    .map((op) => {
      const val = op.value !== undefined ? ` → ${JSON.stringify(op.value)}` : '';
      return `${op.op.padEnd(7)} ${op.path}${val}`;
    })
    .join('\n');

  const escalationLine = escalated
    ? '⚠️ *ESCALATED* — Circuit breaker fired\\. Human action required\\.\n\n'
    : '';

  const text =
    `${escalationLine}` +
    `🛡️ *Approval Required*\n` +
    `*Resource:* \`${resourceKind}/${resourceName}\`\n` +
    `*Namespace:* \`${namespace}\`\n` +
    `*Severity:* ${plan.severity}\n` +
    `*Attempt:* \\#${attemptNumber} / ${circuitBreakerLimit}\n\n` +
    `*Root Cause:*\n${plan.rootCause.replace(/[_*[\]()~`>#+=|{}.!-]/g, (c: string) => '\\' + c)}\n\n` +
    `*Reasoning:*\n${plan.reasoning.replace(/[_*[\]()~`>#+=|{}.!-]/g, (c: string) => '\\' + c)}\n\n` +
    `*Proposed Patch* \\(${plan.targetManifestPath.replace(/[_*[\]()~`>#+=|{}.!-]/g, (c: string) => '\\' + c)}\\):\n` +
    `\`\`\`\n${patchText}\n\`\`\`\n\n` +
    `*Commit:* \`${plan.commitMessage.replace(/`/g, "'")}\`\n` +
    `*Rollback Safe:* ${plan.rollbackSafe ? '✅ Yes' : '❌ No'}\n\n` +
    `🔑 \`${incidentId}\``;

  try {
    await b.telegram.sendMessage(
      chatId,
      text,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Approve', `hil_approve_${incidentId}`),
            Markup.button.callback('❌ Reject', `hil_reject_${incidentId}`),
          ],
        ]),
      }
    );

    log('info', AGENT, 'Telegram notification sent', {
      incidentId,
      chatId,
    });
  } catch (err) {
    log('error', AGENT, 'Failed to send Telegram notification', {
      incidentId,
      error: String(err),
    });
  }
}
