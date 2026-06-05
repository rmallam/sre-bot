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
import { resolveGitPatchTarget } from '../../../shared/src/patch-target.js';
import type { ApprovalRequest } from '../../../shared/src/types.js';

const AGENT = 'hil-agent';

const TELEGRAM_BOT_TOKEN     = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
const TELEGRAM_ALERT_CHAT_ID = process.env['TELEGRAM_ALERT_CHAT_ID'] ?? '';
const TELEGRAM_SEND_GAP_MS   = parseInt(process.env['TELEGRAM_SEND_GAP_MS'] ?? '350', 10);
const TELEGRAM_SEND_RETRIES  = parseInt(process.env['TELEGRAM_SEND_RETRIES'] ?? '3', 10);

/** Alert channel, or the Telegram chat that started the run (DM). */
function resolveTelegramChatId(request: ApprovalRequest): string | null {
  if (TELEGRAM_ALERT_CHAT_ID.trim()) return TELEGRAM_ALERT_CHAT_ID.trim();
  if (request.platform === 'telegram' && request.channelId?.trim()) {
    return request.channelId.trim();
  }
  return null;
}

/** Serialize outbound Telegram sends to avoid rate-limit / socket hang up bursts. */
let sendChain: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientTelegramError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('429') ||
    msg.includes('too many requests')
  );
}

async function sendTelegramWithRetry(
  send: () => Promise<unknown>,
  incidentId: string
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= TELEGRAM_SEND_RETRIES; attempt++) {
    try {
      await send();
      return;
    } catch (err) {
      lastErr = err;
      if (!isTransientTelegramError(err) || attempt >= TELEGRAM_SEND_RETRIES) break;
      const delay = 400 * attempt;
      log('warn', AGENT, 'Telegram send failed — retrying', {
        incidentId,
        attempt,
        delayMs: delay,
        error: String(err),
      });
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** Lazily-initialised Telegram bot. */
let bot: Telegraf | null = null;

function getBot(): Telegraf | null {
  if (!TELEGRAM_BOT_TOKEN) return null;
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
    log('warn', AGENT, 'Telegram not configured — TELEGRAM_BOT_TOKEN missing');
    return;
  }

  // We do not call b.launch() here because commander-agent handles the long-polling loop
  // for the same Telegram bot token to avoid 409 Conflict error. HIL agent operates
  // in push-only mode to send alert messages.
  log('info', AGENT, 'Telegram notifications active (push-only mode)', {
    alertChatConfigured: !!TELEGRAM_ALERT_CHAT_ID.trim(),
  });
}

/**
 * Post an approval request message with inline keyboard to Telegram.
 */
export async function notifyTelegram(
  request: ApprovalRequest,
  opts?: { prefix?: string }
): Promise<void> {
  const b = getBot();
  const chatId = resolveTelegramChatId(request);
  if (!b || !chatId) {
    log('warn', AGENT, 'Telegram not configured — skipping notification', {
      incidentId: request.incidentId,
      hasBotToken: !!TELEGRAM_BOT_TOKEN,
      alertChatId: TELEGRAM_ALERT_CHAT_ID || null,
      originPlatform: request.platform,
      originChannelId: request.channelId,
    });
    return;
  }

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

  const applyTarget =
    plan.action === 'git_patch'
      ? resolveGitPatchTarget({
          planTarget: plan.patchTarget,
          diagnoseMode: request.mode === 'diagnose',
        })
      : null;
  const applyLine =
    applyTarget === 'cluster'
      ? '*Apply:* live cluster patch \\(no GitOps repo\\)\n'
      : applyTarget === 'gitops'
        ? '*Apply:* GitOps mirror / Argo\n'
        : applyTarget === 'auto'
          ? '*Apply:* cluster first, GitOps if configured\n'
          : '';

  const titlePrefix = opts?.prefix ?? '';
  const text =
    `${escalationLine}` +
    `${titlePrefix}🛡️ *Approval Required*\n` +
    `*Resource:* \`${resourceKind}/${resourceName}\`\n` +
    `*Namespace:* \`${namespace}\`\n` +
    `*Severity:* ${plan.severity}\n` +
    `*Attempt:* \\#${attemptNumber} / ${circuitBreakerLimit}\n\n` +
    applyLine +
    `*Root Cause:*\n${plan.rootCause.replace(/[_*[\]()~`>#+=|{}.!-]/g, (c: string) => '\\' + c)}\n\n` +
    `*Reasoning:*\n${plan.reasoning.replace(/[_*[\]()~`>#+=|{}.!-]/g, (c: string) => '\\' + c)}\n\n` +
    `*Proposed Patch* \\(${plan.targetManifestPath.replace(/[_*[\]()~`>#+=|{}.!-]/g, (c: string) => '\\' + c)}\\):\n` +
    `\`\`\`\n${patchText}\n\`\`\`\n\n` +
    `*Commit:* \`${plan.commitMessage.replace(/`/g, "'")}\`\n` +
    `*Rollback Safe:* ${plan.rollbackSafe ? '✅ Yes' : '❌ No'}\n\n` +
    `🔑 \`${incidentId}\``;

  try {
    await new Promise<void>((resolve, reject) => {
      sendChain = sendChain
        .then(async () => {
          await sendTelegramWithRetry(
            () =>
              b!.telegram.sendMessage(chatId, text, {
                parse_mode: 'MarkdownV2',
                ...Markup.inlineKeyboard([
                  [
                    Markup.button.callback('✅ Approve', `hil_approve_${incidentId}`),
                    Markup.button.callback('❌ Reject', `hil_reject_${incidentId}`),
                  ],
                  [
                    Markup.button.callback('🔕 Ignore', `hil_ignore_${incidentId}`),
                    Markup.button.callback('✏️ Suggest fix', `hil_suggest_${incidentId}`),
                  ],
                ]),
              }),
            incidentId
          );
          await sleep(TELEGRAM_SEND_GAP_MS);
        })
        .then(resolve)
        .catch(reject);
    });

    log('info', AGENT, 'Telegram notification sent', {
      incidentId,
      chatId,
    });
  } catch (err) {
    log('error', AGENT, 'Failed to send Telegram notification', {
      incidentId,
      error: String(err),
    });
    // Fallback: plain text without MarkdownV2 (special chars in rootCause often break parsing).
    try {
      const plain =
        `${opts?.prefix ?? ''}Approval required: ${resourceKind}/${resourceName} in ${namespace}\n` +
        `Action: ${plan.action}\n` +
        `${plan.rootCause.slice(0, 300)}\n\n` +
        `Incident: ${incidentId}`;
      await sendTelegramWithRetry(
        () =>
          b!.telegram.sendMessage(chatId, plain, {
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('✅ Approve', `hil_approve_${incidentId}`),
                Markup.button.callback('❌ Reject', `hil_reject_${incidentId}`),
              ],
              [
                Markup.button.callback('🔕 Ignore', `hil_ignore_${incidentId}`),
                Markup.button.callback('✏️ Suggest fix', `hil_suggest_${incidentId}`),
              ],
            ]),
          }),
        incidentId
      );
      log('info', AGENT, 'Telegram plain-text fallback sent', { incidentId, chatId });
    } catch (fallbackErr) {
      log('error', AGENT, 'Telegram plain-text fallback failed', {
        incidentId,
        error: String(fallbackErr),
      });
    }
  }
}
