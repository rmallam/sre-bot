/**
 * Telegram outbound formatting — HTML parse_mode with plain fallback.
 */

import type { Context } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/types';
import { log } from '../../../shared/src/http.js';
import {
  markdownToTelegramHtml,
  plainTelegramFallback,
  splitTelegramMessage,
} from '../../../shared/src/telegram-format.js';

const AGENT = 'commander-telegram';

export async function sendTelegramFormatted(
  send: (text: string, extra?: { parse_mode?: 'HTML'; reply_markup?: InlineKeyboardMarkup }) => Promise<unknown>,
  text: string,
  replyMarkup?: InlineKeyboardMarkup
): Promise<void> {
  const html = markdownToTelegramHtml(text);
  const parts = splitTelegramMessage(html);

  for (let i = 0; i < parts.length; i++) {
    const extra =
      i === 0 && replyMarkup
        ? { parse_mode: 'HTML' as const, reply_markup: replyMarkup }
        : { parse_mode: 'HTML' as const };
    try {
      await send(parts[i]!, extra);
    } catch (err) {
      log('warn', AGENT, 'HTML send failed, falling back to plain', { error: String(err) });
      const plainParts = splitTelegramMessage(plainTelegramFallback(text));
      for (let j = 0; j < plainParts.length; j++) {
        await send(plainParts[j]!, j === 0 && replyMarkup ? { reply_markup: replyMarkup } : undefined);
      }
      return;
    }
  }
}

export async function replyFormatted(
  ctx: Context,
  text: string,
  replyMarkup?: InlineKeyboardMarkup
): Promise<void> {
  await sendTelegramFormatted((t, extra) => ctx.reply(t, extra), text, replyMarkup);
}

export async function editMessageFormatted(
  ctx: Context,
  text: string,
  replyMarkup?: InlineKeyboardMarkup
): Promise<void> {
  const html = markdownToTelegramHtml(text);
  try {
    await ctx.editMessageText(html, {
      parse_mode: 'HTML',
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
    });
  } catch (err) {
    log('warn', AGENT, 'HTML edit failed, falling back to plain', { error: String(err) });
    await ctx.editMessageText(plainTelegramFallback(text), {
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
    });
  }
}
