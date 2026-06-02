/**
 * GitHub webhook handler — auto-start ci-failure runs on workflow_run failures.
 */

import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { Request, Response } from 'express';
import { log, postWithRetry } from '../../../shared/src/http.js';
import type { Platform, StartRunRequest } from '../../../shared/src/types.js';

const AGENT = 'commander-github-webhook';
const ORCHESTRATOR_URL = process.env['ORCHESTRATOR_URL'] ?? 'http://orchestrator-agent:8080';
const WEBHOOK_SECRET = process.env['GITHUB_WEBHOOK_SECRET'] ?? '';
const NOTIFY_PLATFORM = (process.env['GITHUB_WEBHOOK_NOTIFY_PLATFORM'] ?? 'telegram') as Platform;
const NOTIFY_CHANNEL_ID =
  process.env['GITHUB_WEBHOOK_NOTIFY_CHANNEL_ID'] ?? process.env['TELEGRAM_ALERT_CHAT_ID'] ?? '';

function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!WEBHOOK_SECRET) return true;
  if (!signature) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export async function githubWebhookHandler(req: Request, res: Response): Promise<void> {
  const rawBody = req.body as Buffer;
  const event = String(req.headers['x-github-event'] ?? '');
  const signature = req.headers['x-hub-signature-256'] as string | undefined;

  if (!verifySignature(rawBody, signature)) {
    res.status(401).json({ error: 'Invalid webhook signature' });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown>;
  } catch {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }

  if (event !== 'workflow_run') {
    res.json({ ok: true, ignored: true, event });
    return;
  }

  const workflowRun = payload['workflow_run'] as Record<string, unknown> | undefined;
  const repository = payload['repository'] as Record<string, unknown> | undefined;
  const conclusion = workflowRun?.['conclusion'] as string | undefined;
  const action = payload['action'] as string | undefined;

  if (action !== 'completed' || conclusion !== 'failure') {
    res.json({ ok: true, ignored: true, reason: 'not a completed failure' });
    return;
  }

  const fullName = repository?.['full_name'] as string | undefined;
  const runId = workflowRun?.['id'] as number | undefined;
  const workflowName = workflowRun?.['name'] as string | undefined;
  const branch = workflowRun?.['head_branch'] as string | undefined;

  if (!fullName || !runId) {
    res.status(400).json({ error: 'Missing repository or run id' });
    return;
  }

  const incidentId = uuidv4();
  const appName = fullName.split('/').pop() ?? 'ci';
  const startPayload: StartRunRequest = {
    incidentId,
    triggeredBy: 'commander',
    triggeredAt: new Date().toISOString(),
    namespace: 'ci',
    resourceKind: 'Job',
    resourceName: appName,
    mode: 'ci-failure',
    githubRepo: fullName,
    workflowRunId: runId,
    workflowName,
    ciBranch: branch,
    platform: NOTIFY_CHANNEL_ID ? NOTIFY_PLATFORM : undefined,
    channelId: NOTIFY_CHANNEL_ID || undefined,
    rawMessage: `GitHub webhook: workflow_run failure ${fullName}#${runId}`,
  };

  try {
    await postWithRetry({
      url: `${ORCHESTRATOR_URL}/runs`,
      payload: startPayload,
      incidentId,
      callerAgent: AGENT,
    });
    log('info', AGENT, 'Started ci-failure run from webhook', {
      incidentId,
      githubRepo: fullName,
      runId,
    });
    res.json({ ok: true, incidentId, runId });
  } catch (err) {
    log('error', AGENT, 'Failed to start run from webhook', { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
}
