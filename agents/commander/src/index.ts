// ─────────────────────────────────────────────────────────────────────────────
// src/index.ts — Commander Agent Entry Point
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';
import { log } from '../../../shared/src/http.js';
import { createSlackApp } from './slack.js';
import { createTelegramBot } from './telegram.js';
import { confirmHandler } from './confirm.js';
import { postNotify } from './notify.js';
import type { Platform } from '../../../shared/src/types.js';

const AGENT = 'commander-agent';
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

async function start() {
  const app = express();
  app.use(express.json());

  // ── Express Endpoints ──────────────────────────────────────────────────────
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', agent: AGENT });
  });

  app.post('/confirm', confirmHandler);

  app.post('/notify', async (req, res) => {
    const { platform, channelId, message, incidentId } = req.body as {
      platform?: Platform;
      channelId?: string;
      message?: string;
      incidentId?: string;
    };
    if (!platform || !channelId || !message) {
      res.status(400).json({ error: 'platform, channelId, message required' });
      return;
    }
    try {
      await postNotify(platform, channelId, message, incidentId ?? 'N/A');
      res.json({ ok: true });
    } catch (err) {
      log('error', AGENT, 'Notify failed', { incidentId, error: String(err) });
      res.status(500).json({ error: String(err) });
    }
  });

  // Start HTTP server first so healthcheck does not depend on bot long-polling.
  app.listen(PORT, () => {
    log('info', AGENT, `HTTP Server listening on port ${PORT}`, {
      incidentId: 'N/A',
      telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      slackConfigured: Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN),
    });
  });

  // ── Slack Bot Integration ──────────────────────────────────────────────────
  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    void (async () => {
      try {
        const slackApp = createSlackApp();
        await slackApp.start();
        log('info', AGENT, 'Slack Bolt app started in Socket Mode', { incidentId: 'N/A' });
      } catch (err) {
        log('error', AGENT, 'Failed to start Slack integration', { incidentId: 'N/A', error: String(err) });
      }
    })();
  } else {
    log('warn', AGENT, 'SLACK_BOT_TOKEN/SLACK_APP_TOKEN not provided — Slack integration disabled', { incidentId: 'N/A' });
  }

  // ── Telegram Bot Integration ────────────────────────────────────────────────
  if (process.env.TELEGRAM_BOT_TOKEN) {
    void (async () => {
      try {
        const tgBot = createTelegramBot();
        await tgBot.launch({ dropPendingUpdates: true }, () => {
          log('info', AGENT, 'Telegram Bot launched (long-polling)', { incidentId: 'N/A' });
        });
        process.once('SIGINT', () => tgBot.stop('SIGINT'));
        process.once('SIGTERM', () => tgBot.stop('SIGTERM'));
      } catch (err) {
        log('error', AGENT, 'Failed to start Telegram integration', { incidentId: 'N/A', error: String(err) });
      }
    })();
  } else {
    log('warn', AGENT, 'TELEGRAM_BOT_TOKEN not provided — Telegram integration disabled', { incidentId: 'N/A' });
  }
}

start().catch((err) => {
  log('error', AGENT, 'Fatal error starting Commander agent', { incidentId: 'N/A', error: String(err) });
  process.exit(1);
});
