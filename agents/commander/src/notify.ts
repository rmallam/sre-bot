import type { WebClient } from '@slack/web-api';
import type { Telegraf } from 'telegraf';
import type { Platform } from '../../../shared/src/types.js';
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

export async function postNotify(
  platform: Platform,
  channelId: string,
  message: string,
  incidentId: string
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
      await telegramBot.telegram.sendMessage(chatId, plain);
      break;
    }
    default:
      log('info', AGENT, 'Notify skipped for platform', { platform, incidentId });
  }
}
