import type { WebClient } from '@slack/web-api';
import type { Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import type { Platform } from '../../../shared/src/types.js';
import type { RunUpdateQuickAction } from '../../../shared/src/run-update.js';
import { log } from '../../../shared/src/http.js';

const AGENT = 'commander-agent';

let slackClient: WebClient | null = null;
let telegramBot: Telegraf | null = null;

export function registerSlackClientForNotify(client: WebClient): void {
  slackClient = client;
}

export function registerTelegramBotForNotify(bot: Telegraf): void {
  telegramBot = bot;
}

function telegramKeyboard(actions?: RunUpdateQuickAction[]) {
  if (!actions?.length) return undefined;
  const row = actions.map((a) => Markup.button.callback(a.label, a.id));
  return Markup.inlineKeyboard([row]);
}

export async function postNotify(
  platform: Platform,
  channelId: string,
  message: string,
  incidentId: string,
  quickActions?: RunUpdateQuickAction[]
): Promise<void> {
  const plain = message.replace(/[*`<>]/g, '');

  switch (platform) {
    case 'slack': {
      if (!slackClient) {
        log('warn', AGENT, 'Slack client not registered for notify', { incidentId });
        return;
      }
      await slackClient.chat.postMessage({ channel: channelId, text: message, mrkdwn: true });
      break;
    }
    case 'telegram': {
      if (!telegramBot) {
        log('warn', AGENT, 'Telegram bot not registered for notify', { incidentId });
        return;
      }
      const chatId = parseInt(channelId, 10);
      if (isNaN(chatId)) {
        log('error', AGENT, 'Invalid Telegram channelId', { incidentId, channelId });
        return;
      }
      const keyboard = telegramKeyboard(quickActions);
      if (keyboard) {
        await telegramBot.telegram.sendMessage(chatId, plain, keyboard);
      } else {
        await telegramBot.telegram.sendMessage(chatId, plain);
      }
      break;
    }
    default:
      log('info', AGENT, 'Notify skipped for platform', { platform, incidentId });
  }
}
