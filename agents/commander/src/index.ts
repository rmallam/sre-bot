// ─────────────────────────────────────────────────────────────────────────────
// src/index.ts — Commander Agent Entry Point
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';
import { log } from '../../../shared/src/http.js';
import { createSlackApp } from './slack.js';
import { createTelegramBot } from './telegram.js';
import { confirmHandler } from './confirm.js';
import { postNotify } from './notify.js';
import { getChannelPref } from './channel-prefs.js';
import type { Platform } from '../../../shared/src/types.js';
import { initSessionStore } from './session-store.js';
import { initCaseStore } from './case-store.js';
import {
  createWebChatSession,
  listWebChatSessions,
  resetWebChatSession,
} from './sessions.js';
import { getLastCommanderLlmProbe, probeCommanderLlm } from './llm-probe.js';

const AGENT = 'commander-agent';
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

async function start() {
  const sessionBackend = await initSessionStore().catch((err) => {
    log('error', AGENT, 'Session store init failed, using memory', { error: String(err) });
    return { backend: 'memory' as const };
  });
  log('info', AGENT, `Chat session store: ${sessionBackend.backend}`, { incidentId: 'N/A' });

  const caseBackend = await initCaseStore().catch((err) => {
    log('error', AGENT, 'Case store init failed, using memory', { error: String(err) });
    return { backend: 'memory' as const };
  });
  log('info', AGENT, `Case store: ${caseBackend.backend}`, { incidentId: 'N/A' });

  const app = express();

  app.post(
    '/webhooks/github',
    express.raw({ type: 'application/json' }),
    (req, res) => {
      void import('./github-webhook.js').then(({ githubWebhookHandler }) =>
        githubWebhookHandler(req, res)
      );
    }
  );

  app.use(express.json());

  // ── Express Endpoints ──────────────────────────────────────────────────────
  app.get('/health', (req, res) => {
    void import('../../../shared/src/llm-config.js').then(({ llmConfigSummary }) => {
      void import('../../../shared/src/agent-mode.js').then(({ agentModeHealthPayload }) => {
        void import('../../../shared/src/platform-client.js').then(({ platformHealth, platformRoutingEnabled }) => {
          void platformHealth().then((platform) => {
            const probe = getLastCommanderLlmProbe();
            res.json({
              status: probe && !probe.ok ? 'degraded' : 'ok',
              agent: AGENT,
              llm: llmConfigSummary(),
              commanderLlmProbe: probe,
              chatSessionBackend: process.env['CHAT_SESSION_BACKEND'] ?? (process.env['REDIS_URL'] ? 'redis' : 'memory'),
              caseStoreBackend: process.env['CASE_STORE_BACKEND'] ?? (process.env['REDIS_URL'] ? 'redis' : 'memory'),
              platformRouting: platformRoutingEnabled(),
              platform,
              ...agentModeHealthPayload(),
            });
          });
        });
      });
    }).catch(() => {
      res.json({ status: 'ok', agent: AGENT, commanderLlmProbe: getLastCommanderLlmProbe() });
    });
  });

  app.post('/confirm', confirmHandler);

  app.post('/notify', async (req, res) => {
    const { platform, channelId, message, incidentId, update, quickActions } = req.body as {
      platform?: Platform;
      channelId?: string;
      message?: string;
      incidentId?: string;
      update?: import('../../../shared/src/run-update.js').RunUpdatePayload;
      quickActions?: import('../../../shared/src/run-update.js').RunUpdateQuickAction[];
    };
    if (!platform || !channelId) {
      res.status(400).json({ error: 'platform and channelId required' });
      return;
    }
    const narrateEnabled = (process.env['CONVERSATIONAL_NARRATE'] ?? 'true').toLowerCase() === 'true';
    try {
      let text = message ?? '';
      const verbose = getChannelPref(platform, channelId).verbose;
      if (update) {
        const merged = { ...update, verbose: update.verbose ?? verbose };
        const { narrateRunUpdate } = await import('./narrate.js');
        const { formatRunUpdateFallback } = await import('../../../shared/src/run-update.js');
        text = narrateEnabled ? await narrateRunUpdate(merged) : formatRunUpdateFallback(merged);
        const actions =
          quickActions ?? (await import('../../../shared/src/run-update.js')).defaultQuickActionsForUpdate(merged);

        if (platform === 'web') {
          const { deliverWebChatUpdate } = await import('./chat-web-notify.js');
          await deliverWebChatUpdate({
            channelId,
            text,
            incidentId: incidentId ?? merged.incidentId,
            update: merged,
            quickActions: actions,
          });
          res.json({ ok: true });
          return;
        }

        if (merged.kind === 'deploy_source_required' && merged.runId) {
          const { armDeploySourceClarification } = await import('./deploy-source-followup.js');
          await armDeploySourceClarification(platform, channelId, 'default', {
            kind: 'deploy-source',
            awaiting: 'deploySource',
            prompt: text,
            runId: merged.runId,
            namespace: merged.namespace,
            resourceName: merged.resourceName,
          });
        }

        await postNotify(platform, channelId, text, incidentId ?? 'N/A', actions);
        res.json({ ok: true });
        return;
      }
      if (!text) {
        res.status(400).json({ error: 'message or update required' });
        return;
      }
      if (narrateEnabled && text) {
        const { narrateRunUpdate } = await import('./narrate.js');
        text = await narrateRunUpdate({
          kind: 'generic',
          incidentId: incidentId ?? 'N/A',
          technicalMessage: text,
        });
      }

      if (platform === 'web') {
        const { deliverWebChatUpdate } = await import('./chat-web-notify.js');
        await deliverWebChatUpdate({
          channelId,
          text,
          incidentId: incidentId ?? 'N/A',
          quickActions,
        });
        res.json({ ok: true });
        return;
      }

      await postNotify(platform, channelId, text, incidentId ?? 'N/A', quickActions);
      res.json({ ok: true });
    } catch (err) {
      log('error', AGENT, 'Notify failed', { incidentId, error: String(err) });
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/narrate', async (req, res) => {
    const update = req.body as import('../../../shared/src/run-update.js').RunUpdatePayload;
    if (!update?.incidentId || !update?.kind) {
      res.status(400).json({ error: 'incidentId and kind required' });
      return;
    }
    try {
      const { narrateRunUpdate } = await import('./narrate.js');
      const text = await narrateRunUpdate(update);
      res.json({ text });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** UX-16 — Web console chat (same session + routing as Telegram). */
  app.post('/chat', async (req, res) => {
    const { message, userId, channelId } = req.body as {
      message?: string;
      userId?: string;
      channelId?: string;
    };
    if (!message?.trim()) {
      res.status(400).json({ error: 'message required' });
      return;
    }
    if (!channelId?.trim()) {
      res.status(400).json({ error: 'channelId required — create a session via POST /chat/sessions' });
      return;
    }
    try {
      const { processChatMessage, getChatSessionState } = await import('./chat-handler.js');
      const uid = userId ?? 'console';
      const cid = channelId.trim();
      const result = await processChatMessage({
        text: message.trim(),
        platform: 'web',
        userId: uid,
        channelId: cid,
      });
      const state = await getChatSessionState('web', cid, uid);
      res.json({ ...result, transcript: state.transcript, waitingForRun: state.waitingForRun });
    } catch (err) {
      log('error', AGENT, 'Chat failed', { error: String(err) });
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/chat/transcript', async (req, res) => {
    const userId = (req.query.userId as string) ?? 'console';
    const channelId = req.query.channelId as string;
    if (!channelId) {
      res.status(400).json({ error: 'channelId query required' });
      return;
    }
    const { getChatSessionState } = await import('./chat-handler.js');
    const state = await getChatSessionState('web', channelId, userId);
    res.json({ transcript: state.transcript, waitingForRun: state.waitingForRun });
  });

  app.get('/chat/session', async (req, res) => {
    const userId = (req.query.userId as string) ?? 'console';
    const channelId = req.query.channelId as string;
    if (!channelId) {
      res.status(400).json({ error: 'channelId query required' });
      return;
    }
    const { getChatSessionState } = await import('./chat-handler.js');
    res.json(await getChatSessionState('web', channelId, userId));
  });

  app.get('/chat/sessions', async (req, res) => {
    const userId = (req.query.userId as string) ?? 'console';
    const sessions = await listWebChatSessions(userId);
    res.json({ sessions });
  });

  app.post('/chat/sessions', async (req, res) => {
    const userId = (req.body as { userId?: string })?.userId ?? 'console';
    const label = (req.body as { label?: string })?.label;
    const created = await createWebChatSession(userId, label);
    res.status(201).json(created);
  });

  app.post('/chat/sessions/:channelId/reset', async (req, res) => {
    const userId = (req.body as { userId?: string })?.userId ?? 'console';
    const channelId = req.params.channelId ?? '';
    await resetWebChatSession(channelId, userId);
    const { getChatTranscript } = await import('./chat-handler.js');
    const transcript = await getChatTranscript('web', channelId, userId);
    res.json({ ok: true, channelId, transcript });
  });

  void probeCommanderLlm();

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
