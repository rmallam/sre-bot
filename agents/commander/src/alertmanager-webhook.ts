/**
 * PLAT-7 — AlertManager webhook → orchestrator diagnose runs.
 */

import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { Request, Response } from 'express';
import { log, postWithRetry } from '../../../shared/src/http.js';
import type { Platform, ResourceKind, StartRunRequest } from '../../../shared/src/types.js';

const AGENT = 'commander-alertmanager-webhook';
const ORCHESTRATOR_URL = process.env['ORCHESTRATOR_URL'] ?? 'http://orchestrator-agent:8080';
const WEBHOOK_SECRET = process.env['ALERTMANAGER_WEBHOOK_SECRET'] ?? '';
const NOTIFY_PLATFORM = (process.env['ALERTMANAGER_NOTIFY_PLATFORM'] ??
  process.env['GITHUB_WEBHOOK_NOTIFY_PLATFORM'] ??
  'telegram') as Platform;
const NOTIFY_CHANNEL_ID =
  process.env['ALERTMANAGER_NOTIFY_CHANNEL_ID'] ??
  process.env['GITHUB_WEBHOOK_NOTIFY_CHANNEL_ID'] ??
  process.env['TELEGRAM_ALERT_CHAT_ID'] ??
  '';

const LABEL_NAMESPACE = process.env['ALERTMANAGER_LABEL_NAMESPACE'] ?? 'namespace';
const LABEL_POD = process.env['ALERTMANAGER_LABEL_POD'] ?? 'pod';
const LABEL_DEPLOYMENT = process.env['ALERTMANAGER_LABEL_DEPLOYMENT'] ?? 'deployment';
const LABEL_STATEFULSET = process.env['ALERTMANAGER_LABEL_STATEFULSET'] ?? 'statefulset';

/** fingerprint → lastFiredMs */
const alertCooldown = new Map<string, number>();
const COOLDOWN_MS = parseInt(process.env['ALERTMANAGER_COOLDOWN_MS'] ?? String(15 * 60 * 1000), 10);

interface AlertmanagerAlert {
  status?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  fingerprint?: string;
}

interface AlertmanagerPayload {
  status?: string;
  alerts?: AlertmanagerAlert[];
  commonLabels?: Record<string, string>;
  commonAnnotations?: Record<string, string>;
}

function verifySecret(req: Request): boolean {
  if (!WEBHOOK_SECRET) {
    if ((process.env['NODE_ENV'] ?? '').toLowerCase() === 'production') return false;
    log('warn', AGENT, 'ALERTMANAGER_WEBHOOK_SECRET unset — webhook auth disabled (dev only)');
    return true;
  }
  const header = String(req.headers['authorization'] ?? '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const token = String(req.headers['x-alert-token'] ?? bearer);
  if (!token) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(WEBHOOK_SECRET));
  } catch {
    return token === WEBHOOK_SECRET;
  }
}

function workloadFromLabels(labels: Record<string, string>): {
  namespace: string;
  resourceName: string;
  resourceKind: ResourceKind;
  podName?: string;
} | null {
  const namespace = labels[LABEL_NAMESPACE] ?? labels['kubernetes_namespace'] ?? '';
  const pod = labels[LABEL_POD] ?? labels['pod_name'] ?? '';
  const deployment = labels[LABEL_DEPLOYMENT] ?? labels['deployment'] ?? '';
  const sts = labels[LABEL_STATEFULSET] ?? labels['statefulset'] ?? '';

  if (namespace && deployment) {
    return { namespace, resourceName: deployment, resourceKind: 'Deployment' };
  }
  if (namespace && sts) {
    return { namespace, resourceName: sts, resourceKind: 'StatefulSet' };
  }
  if (namespace && pod) {
    return { namespace, resourceName: pod, resourceKind: 'Pod', podName: pod };
  }
  if (namespace && labels['alertname']) {
    return { namespace, resourceName: labels['alertname'], resourceKind: 'Deployment' };
  }
  return null;
}

function shouldThrottle(fingerprint: string): boolean {
  const last = alertCooldown.get(fingerprint);
  if (!last) return false;
  return Date.now() - last < COOLDOWN_MS;
}

export async function alertmanagerWebhookHandler(req: Request, res: Response): Promise<void> {
  if (!verifySecret(req)) {
    res.status(401).json({ error: 'Invalid alert webhook token' });
    return;
  }

  const payload = req.body as AlertmanagerPayload;
  const alerts = payload.alerts ?? [];
  const started: string[] = [];

  for (const alert of alerts) {
    if (alert.status !== 'firing') continue;

    const labels = { ...(payload.commonLabels ?? {}), ...(alert.labels ?? {}) };
    const annotations = { ...(payload.commonAnnotations ?? {}), ...(alert.annotations ?? {}) };
    const target = workloadFromLabels(labels);
    if (!target) {
      log('info', AGENT, 'Skipping alert — no namespace/workload labels', {
        alertname: labels['alertname'],
      });
      continue;
    }

    const fingerprint =
      alert.fingerprint ?? `${labels['alertname'] ?? 'alert'}:${target.namespace}/${target.resourceName}`;
    if (shouldThrottle(fingerprint)) continue;

    const incidentId = uuidv4();
    const summary = annotations['summary'] ?? annotations['description'] ?? labels['alertname'] ?? 'Alert firing';
    const startPayload: StartRunRequest = {
      incidentId,
      triggeredBy: 'commander',
      triggeredAt: new Date().toISOString(),
      namespace: target.namespace,
      resourceKind: target.resourceKind,
      resourceName: target.resourceName,
      podName: target.podName,
      mode: 'diagnose',
      eventReason: labels['alertname'] ?? 'AlertManager',
      eventMessage: summary,
      platform: NOTIFY_CHANNEL_ID ? NOTIFY_PLATFORM : undefined,
      channelId: NOTIFY_CHANNEL_ID || undefined,
      rawMessage: `AlertManager: ${summary}`,
      investigateScope: 'workload',
    };

    try {
      await postWithRetry({
        url: `${ORCHESTRATOR_URL}/runs`,
        payload: startPayload,
        incidentId,
        callerAgent: AGENT,
      });
      alertCooldown.set(fingerprint, Date.now());
      started.push(incidentId);
      log('info', AGENT, 'Started diagnose run from alert', {
        incidentId,
        alertname: labels['alertname'],
        namespace: target.namespace,
        resourceName: target.resourceName,
      });
    } catch (err) {
      log('error', AGENT, 'Failed to start run from alert', {
        error: String(err),
        alertname: labels['alertname'],
      });
    }
  }

  res.json({ ok: true, started: started.length, incidentIds: started });
}
