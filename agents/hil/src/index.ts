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
import { dispatch, onApproved, onRejected, onIgnored } from './dispatcher.js';
import { ignoreStore } from './ignore-store.js';
import { applyOperatorSuggestion } from './suggest-fix.js';
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

// ── Web Dashboard (legacy HTML) ───────────────────────────────────────────────
app.get('/legacy', (_req: Request, res: Response) => {
  const all = approvalStore.getAll();
  const ignored = ignoreStore.list();
  const html = renderDashboard(all, ignored);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

/** JSON API for Operations Console. */
app.get('/api/approvals', (_req: Request, res: Response) => {
  const approvals = approvalStore.getAll().map((entry) => ({
    incidentId: entry.request.incidentId,
    runId: entry.request.runId,
    status: entry.status,
    expiresAt: entry.expiresAt,
    lockedBy: entry.lockedBy,
    lockedVia: entry.lockedVia,
    lockedAt: entry.lockedAt,
    rejectionReason: entry.rejectionReason,
    namespace: entry.request.namespace,
    resourceName: entry.request.resourceName,
    resourceKind: entry.request.resourceKind,
    mode: entry.request.mode,
    escalated: entry.request.escalated,
    attemptNumber: entry.request.attemptNumber,
    circuitBreakerLimit: entry.request.circuitBreakerLimit,
    plan: entry.request.plan,
    humanSuggestion: entry.request.humanSuggestion,
    planSource: entry.request.planSource,
    triggeredAt: entry.request.triggeredAt,
    triggeredBy: entry.request.triggeredBy,
  }));
  res.json({
    pending: approvals.filter((a) => a.status === 'PENDING').length,
    approvals,
  });
});

// Legacy root — redirect hint; keep HTML at /legacy
app.get('/', (_req: Request, res: Response) => {
  res.redirect(302, '/legacy');
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

  if (ignoreStore.isRequestIgnored(request)) {
    log('info', AGENT, 'Approval request dropped — resource ignored', {
      incidentId: request.incidentId,
      namespace: request.namespace,
      resourceName: request.resourceName,
    });
    res.status(202).json({
      status: 'ignored',
      incidentId: request.incidentId,
      message: 'Resource is on the ignore list — notification skipped',
    });
    return;
  }

  // Respond immediately so Brain doesn't time out
  res.status(202).json({
    status: 'accepted',
    incidentId: request.incidentId,
    runId: request.runId,
    message: 'Approval request queued and notifications dispatched',
  });

  // Fan-out asynchronously (dedupes duplicate asks for the same run/incident)
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
  if (!incidentId) {
    res.status(400).json({ error: 'Missing incidentId' });
    return;
  }
  const { userId, platform } = req.body;
  const via = platform === 'slack' || platform === 'telegram' || platform === 'web' ? platform : 'web';
  const actor = typeof userId === 'string' && userId.trim() ? userId : 'api-operator';

  log('info', AGENT, 'API approve action received', { incidentId, userId: actor, platform: via });

  const result = approvalStore.tryApprove(incidentId, actor, via);

  if (result === 'ok') {
    const entry = approvalStore.get(incidentId)!;
    approvalStore.updateStatus(incidentId, 'EXECUTING');
    // Respond immediately so Telegram/Slack callbacks are not blocked by orchestrator resume.
    res.status(202).json({ status: 'accepted', incidentId });
    onApproved(entry, actor, via).catch((err) => {
      approvalStore.updateStatus(incidentId, 'FAILED');
      log('error', AGENT, 'onApproved failed after API approval', {
        incidentId,
        error: String(err),
      });
    });
  } else if (result === 'already_handled') {
    const entry = approvalStore.get(incidentId);
    res.status(200).json({ status: 'already_handled', currentStatus: entry?.status });
  } else {
    res.status(400).json({ error: result });
  }
});

async function handleSuggestFix(req: Request, res: Response, applyNow: boolean): Promise<void> {
  const incidentId = req.params.incidentId;
  if (!incidentId) {
    res.status(400).json({ error: 'Missing incidentId' });
    return;
  }
  const suggestion =
    (req.body as { suggestion?: string }).suggestion ??
    (req.body as { fix?: string }).fix ??
    '';
  const { userId, platform } = req.body as { userId?: string; platform?: string };
  const via =
    platform === 'slack' || platform === 'telegram' || platform === 'web' ? platform : 'web';
  const actor = typeof userId === 'string' && userId.trim() ? userId : 'web-operator';

  const result = await applyOperatorSuggestion({
    incidentId,
    suggestion,
    userId: actor,
    platform: via,
    applyNow,
  });

  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
}

/** Web dashboard: preview operator suggestion (updates stored plan). */
app.post('/suggest-fix/:incidentId', async (req: Request, res: Response) => {
  const applyField = (req.body as { apply?: string }).apply;
  await handleSuggestFix(req, res, applyField === '1');
});

/** API: commander Telegram / automation. */
app.post('/api/suggest-fix/:incidentId', async (req: Request, res: Response) => {
  const applyNow = (req.body as { applyNow?: boolean }).applyNow === true;
  await handleSuggestFix(req, res, applyNow);
});

app.post('/api/reject/:incidentId', async (req: Request, res: Response) => {
  const { incidentId } = req.params;
  if (!incidentId) {
    res.status(400).json({ error: 'Missing incidentId' });
    return;
  }
  const { userId, platform, reason } = req.body;
  const via = platform === 'slack' || platform === 'telegram' || platform === 'web' ? platform : 'web';
  const actor = typeof userId === 'string' && userId.trim() ? userId : 'api-operator';

  log('info', AGENT, 'API reject action received', { incidentId, userId: actor, platform: via, reason });

  const result = approvalStore.tryReject(incidentId, actor, via, reason ?? 'Rejected via API');

  if (result === 'ok') {
    const entry = approvalStore.get(incidentId)!;
    res.status(202).json({ status: 'accepted', incidentId });
    onRejected(entry, actor, via, reason ?? 'Rejected via API').catch((err) =>
      log('error', AGENT, 'onRejected failed after API rejection', {
        incidentId,
        error: String(err),
      })
    );
  } else if (result === 'already_handled') {
    const entry = approvalStore.get(incidentId);
    res.status(200).json({ status: 'already_handled', currentStatus: entry?.status });
  } else {
    res.status(400).json({ error: result });
  }
});

// ── Web UI: Ignore ────────────────────────────────────────────────────────────
app.post('/ignore/:incidentId', async (req: Request, res: Response) => {
  const { incidentId } = req.params;
  if (!incidentId) {
    res.status(400).send('Missing incidentId');
    return;
  }

  const userId = 'web-operator';
  const reason =
    (req.body as { reason?: string }).reason ?? 'Ignored via web dashboard';

  log('info', AGENT, 'Web UI ignore action', { incidentId, reason });

  const result = approvalStore.tryIgnore(incidentId, userId, 'web', reason);

  if (result === 'ok') {
    const entry = approvalStore.get(incidentId)!;
    onIgnored(entry, userId, 'web', reason).catch((err) =>
      log('error', AGENT, 'onIgnored failed after web ignore', {
        incidentId,
        error: String(err),
      })
    );
    res.redirect(303, '/?ignored=' + encodeURIComponent(incidentId));
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

// ── API: Ignored resources ────────────────────────────────────────────────────
app.get('/api/ignored', (_req: Request, res: Response) => {
  const resources = ignoreStore.list();
  res.json({ resources, keys: ignoreStore.keys() });
});

app.get('/api/ignored/check', (req: Request, res: Response) => {
  const namespace = String(req.query.namespace ?? '');
  const resourceName = String(req.query.resourceName ?? '');
  const githubRepo = req.query.githubRepo ? String(req.query.githubRepo) : undefined;

  if (!namespace || !resourceName) {
    res.status(400).json({ error: 'namespace and resourceName required' });
    return;
  }

  const keys = ignoreKeysForRun({ namespace, resourceName, githubRepo });
  const ignored = keys.some((k) => ignoreStore.isKeyIgnored(k));

  res.json({ ignored, namespace, resourceName, keys });
});

app.delete('/api/ignored/:key', (req: Request, res: Response) => {
  const key = decodeURIComponent(req.params.key ?? '');
  if (!key) {
    res.status(400).json({ error: 'key required' });
    return;
  }
  const removed = ignoreStore.remove(key);
  if (!removed) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  log('info', AGENT, 'Removed ignore entry', { key });
  res.json({ ok: true, key });
});

app.post('/unignore/:key', (req: Request, res: Response) => {
  const key = decodeURIComponent(req.params.key ?? '');
  if (!key) {
    res.status(400).send('key required');
    return;
  }
  ignoreStore.remove(key);
  res.redirect(303, '/');
});

app.post('/api/ignore/:incidentId', async (req: Request, res: Response) => {
  const { incidentId } = req.params;
  if (!incidentId) {
    res.status(400).json({ error: 'Missing incidentId' });
    return;
  }
  const { userId, platform, reason } = req.body as {
    userId?: string;
    platform?: string;
    reason?: string;
  };
  const via =
    platform === 'slack' || platform === 'telegram' || platform === 'web' ? platform : 'web';
  const actor = typeof userId === 'string' && userId.trim() ? userId : 'api-operator';
  const ignoreReason = reason ?? 'Ignored via API';

  log('info', AGENT, 'API ignore action received', { incidentId, userId: actor, platform: via });

  const result = approvalStore.tryIgnore(incidentId, actor, via, ignoreReason);

  if (result === 'ok') {
    const entry = approvalStore.get(incidentId)!;
    res.status(202).json({ status: 'accepted', incidentId });
    onIgnored(entry, actor, via, ignoreReason).catch((err) =>
      log('error', AGENT, 'onIgnored failed after API ignore', {
        incidentId,
        error: String(err),
      })
    );
  } else if (result === 'already_handled') {
    const entry = approvalStore.get(incidentId);
    res.status(200).json({ status: 'already_handled', currentStatus: entry?.status });
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
