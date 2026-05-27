/**
 * src/index.ts
 *
 * HIL (Human-in-the-Loop) Agent — Express server.
 *
 * Endpoints:
 *   GET  /health              — liveness probe
 *   GET  /                    — web dashboard (live approval list)
 *   POST /request-approval    — receives ApprovalRequest from Brain
 *   POST /approve/:incidentId — web UI approval action
 *   POST /reject/:incidentId  — web UI rejection action
 *
 * Environment variables (all optional with sane defaults):
 *   PORT                      (default: 8080)
 *   GITOPS_URL                (default: http://gitops-agent:8080)
 *   BRAIN_URL                 (default: http://brain-agent:8080)
 *   SLACK_BOT_TOKEN
 *   SLACK_SIGNING_SECRET
 *   SLACK_ALERT_CHANNEL       (default: #sre-alerts)
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_ALERT_CHAT_ID
 *   APPROVAL_TIMEOUT_MINUTES  (default: 60)
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import { approvalStore } from './store.js';
import { renderDashboard } from './dashboard.js';
import { dispatch, onApproved, onRejected } from './dispatcher.js';
import { startSlack } from './slack-notifier.js';
import { startTelegram } from './telegram-notifier.js';
import { log } from '../../../shared/src/http.js';
import type { ApprovalRequest, RemediationResult } from '../../../shared/src/types.js';

const AGENT = 'hil-agent';
const PORT  = parseInt(process.env['PORT'] ?? '8080', 10);

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // for HTML form POSTs

// ── Structured request logging ────────────────────────────────────────────────
app.use((req: Request, _res: Response, next: NextFunction) => {
  log('info', AGENT, `${req.method} ${req.path}`, {
    ip: req.ip,
    contentType: req.headers['content-type'],
  });
  next();
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  const pending = approvalStore.getPending().length;
  res.json({ status: 'ok', agent: AGENT, pendingApprovals: pending });
});

// ── Web Dashboard ─────────────────────────────────────────────────────────────
app.get('/', (_req: Request, res: Response) => {
  const all = approvalStore.getAll();
  const html = renderDashboard(all);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ── Receive Approval Request from Brain ───────────────────────────────────────
app.post('/request-approval', async (req: Request, res: Response) => {
  const request = req.body as ApprovalRequest;

  if (!request?.incidentId || !request?.plan) {
    log('warn', AGENT, 'Invalid /request-approval payload', {
      body: req.body,
    });
    res.status(400).json({ error: 'incidentId and plan are required' });
    return;
  }

  // Respond immediately so Brain doesn't time out
  res.status(202).json({
    status: 'accepted',
    incidentId: request.incidentId,
    message: 'Approval request queued and notifications dispatched',
  });

  // Fan-out asynchronously
  dispatch(request).catch((err) => {
    log('error', AGENT, 'dispatch() failed', {
      incidentId: request.incidentId,
      error: String(err),
    });
  });
});

// ── Receive Remediation Confirmation from GitOps ──────────────────────────────
app.post('/confirm', (req: Request, res: Response) => {
  const result = req.body as RemediationResult;

  if (!result?.incidentId) {
    log('warn', AGENT, 'Invalid /confirm payload — missing incidentId');
    res.status(400).json({ error: 'incidentId is required' });
    return;
  }

  log('info', AGENT, 'Received remediation confirmation from GitOps', {
    incidentId: result.incidentId,
    success: result.success,
    status: result.success ? 'DONE' : 'FAILED',
    error: result.error,
  });

  approvalStore.updateStatus(result.incidentId, result.success ? 'DONE' : 'FAILED');

  res.json({ status: 'ok' });
});

// ── Web UI: Approve ───────────────────────────────────────────────────────────
app.post('/approve/:incidentId', async (req: Request, res: Response) => {
  const { incidentId } = req.params;

  if (!incidentId) {
    res.status(400).send('Missing incidentId');
    return;
  }

  // In a real deployment this would be behind auth; for now use a placeholder
  const userId = 'web-operator';

  log('info', AGENT, 'Web UI approve action', { incidentId });

  const result = approvalStore.tryApprove(incidentId, userId, 'web');

  if (result === 'ok') {
    const entry = approvalStore.get(incidentId)!;
    // Fire-and-forget; redirect immediately for snappy UX
    onApproved(entry, userId, 'web').catch((err) =>
      log('error', AGENT, 'onApproved failed after web approval', {
        incidentId,
        error: String(err),
      })
    );
    // Redirect back to dashboard
    res.redirect(303, '/?approved=' + encodeURIComponent(incidentId));
  } else if (result === 'already_handled') {
    const entry = approvalStore.get(incidentId);
    res.redirect(
      303,
      '/?info=' +
        encodeURIComponent(
          `Incident ${incidentId} already handled (${entry?.status ?? 'unknown'})`
        )
    );
  } else if (result === 'expired') {
    res.redirect(
      303,
      '/?error=' + encodeURIComponent(`Approval window expired for ${incidentId}`)
    );
  } else {
    res.redirect(
      303,
      '/?error=' + encodeURIComponent(`Unknown incident ${incidentId}`)
    );
  }
});

// ── Web UI: Reject ────────────────────────────────────────────────────────────
app.post('/reject/:incidentId', async (req: Request, res: Response) => {
  const { incidentId } = req.params;

  if (!incidentId) {
    res.status(400).send('Missing incidentId');
    return;
  }

  const userId = 'web-operator';
  const reason =
    (req.body as { reason?: string }).reason ?? 'Rejected via web dashboard';

  log('info', AGENT, 'Web UI reject action', { incidentId, reason });

  const result = approvalStore.tryReject(incidentId, userId, 'web', reason);

  if (result === 'ok') {
    const entry = approvalStore.get(incidentId)!;
    onRejected(entry, userId, 'web', reason).catch((err) =>
      log('error', AGENT, 'onRejected failed after web rejection', {
        incidentId,
        error: String(err),
      })
    );
    res.redirect(303, '/?rejected=' + encodeURIComponent(incidentId));
  } else if (result === 'already_handled') {
    const entry = approvalStore.get(incidentId);
    res.redirect(
      303,
      '/?info=' +
        encodeURIComponent(
          `Incident ${incidentId} already handled (${entry?.status ?? 'unknown'})`
        )
    );
  } else {
    res.redirect(
      303,
      '/?error=' + encodeURIComponent(`Unknown incident ${incidentId}`)
    );
  }
});

// ── API: Approve/Reject (called by other agents, e.g. commander Telegram callback) ───
app.post('/api/approve/:incidentId', async (req: Request, res: Response) => {
  const { incidentId } = req.params;
  const { userId, platform } = req.body;

  log('info', AGENT, 'API approve action received', { incidentId, userId, platform });

  const result = approvalStore.tryApprove(incidentId, userId, platform);

  if (result === 'ok') {
    const entry = approvalStore.get(incidentId)!;
    onApproved(entry, userId, platform).catch((err) =>
      log('error', AGENT, 'onApproved failed after API approval', {
        incidentId,
        error: String(err),
      })
    );
    res.json({ status: 'ok' });
  } else {
    res.status(400).json({ error: result });
  }
});

app.post('/api/reject/:incidentId', async (req: Request, res: Response) => {
  const { incidentId } = req.params;
  const { userId, platform, reason } = req.body;

  log('info', AGENT, 'API reject action received', { incidentId, userId, platform, reason });

  const result = approvalStore.tryReject(incidentId, userId, platform, reason ?? 'Rejected via API');

  if (result === 'ok') {
    const entry = approvalStore.get(incidentId)!;
    onRejected(entry, userId, platform, reason ?? 'Rejected via API').catch((err) =>
      log('error', AGENT, 'onRejected failed after API rejection', {
        incidentId,
        error: String(err),
      })
    );
    res.json({ status: 'ok' });
  } else {
    res.status(400).json({ error: result });
  }
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log('error', AGENT, 'Unhandled Express error', { error: String(err) });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // Start Slack and Telegram in parallel (both are optional)
  await Promise.allSettled([
    startSlack(3001).catch((err) =>
      log('error', AGENT, 'Slack startup error', { error: String(err) })
    ),
    startTelegram().catch((err) =>
      log('error', AGENT, 'Telegram startup error', { error: String(err) })
    ),
  ]);

  app.listen(PORT, () => {
    log('info', AGENT, `HIL agent listening`, {
      port: PORT,
      dashboard: `http://0.0.0.0:${PORT}/`,
      health: `http://0.0.0.0:${PORT}/health`,
    });
  });
}

main().catch((err) => {
  log('error', AGENT, 'Fatal startup error', { error: String(err) });
  process.exit(1);
});
