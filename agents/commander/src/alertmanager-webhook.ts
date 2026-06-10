/**
 * PLAT-7 — AlertManager webhook → correlated orchestrator diagnose runs.
 */

import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { Request, Response } from 'express';
import { log, postWithRetry } from '../../../shared/src/http.js';
import type { Platform, ResourceKind, StartRunRequest } from '../../../shared/src/types.js';
import {
  buildAlertRunGroups,
  mergeWithRecentCorrelation,
  recordCorrelationWindow,
  type ParsedAlertTarget,
} from '../../../shared/src/alert-correlation.js';

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

const CORRELATION_ENABLED =
  (process.env['ALERT_CORRELATION_ENABLED'] ?? 'true').toLowerCase() !== 'false';
const CORRELATION_USE_APP_GRAPH =
  (process.env['ALERT_CORRELATION_USE_APP_GRAPH'] ?? 'true').toLowerCase() !== 'false';
const INVESTIGATOR_URL = process.env['INVESTIGATOR_URL'] ?? 'http://investigator-agent:8080';
const CORRELATION_WINDOW_MS = parseInt(
  process.env['ALERT_CORRELATION_WINDOW_MS'] ?? String(5 * 60 * 1000),
  10
);
const MIN_GROUP_SIZE = parseInt(process.env['ALERT_CORRELATION_MIN_GROUP'] ?? '1', 10);

/** fingerprint → lastFiredMs */
const alertCooldown = new Map<string, number>();
const COOLDOWN_MS = parseInt(process.env['ALERTMANAGER_COOLDOWN_MS'] ?? String(15 * 60 * 1000), 10);

/** correlationKey → recent incident */
const recentCorrelations = new Map<
  string,
  { correlationKey: string; incidentId: string; startedAtMs: number }
>();

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

function parseFiringAlerts(payload: AlertmanagerPayload): ParsedAlertTarget[] {
  const out: ParsedAlertTarget[] = [];
  for (const alert of payload.alerts ?? []) {
    if (alert.status !== 'firing') continue;
    const labels = { ...(payload.commonLabels ?? {}), ...(alert.labels ?? {}) };
    const annotations = { ...(payload.commonAnnotations ?? {}), ...(alert.annotations ?? {}) };
    const target = workloadFromLabels(labels);
    if (!target) continue;

    const fingerprint =
      alert.fingerprint ?? `${labels['alertname'] ?? 'alert'}:${target.namespace}/${target.resourceName}`;
    if (shouldThrottle(fingerprint)) continue;

    const summary =
      annotations['summary'] ?? annotations['description'] ?? labels['alertname'] ?? 'Alert firing';
    out.push({
      ...target,
      labels,
      annotations,
      fingerprint,
      alertname: labels['alertname'] ?? 'AlertManager',
      summary,
    });
    alertCooldown.set(fingerprint, Date.now());
  }
  return out;
}

async function enrichWithGraphBindings(alerts: ParsedAlertTarget[]): Promise<ParsedAlertTarget[]> {
  if (!CORRELATION_USE_APP_GRAPH || alerts.length < 2) return alerts;
  try {
    const res = await fetch(`${INVESTIGATOR_URL}/alert-correlation/bindings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workloads: alerts.map((a) => ({
          namespace: a.namespace,
          resourceKind: a.resourceKind,
          resourceName: a.resourceName,
        })),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return alerts;
    const data = (await res.json()) as { bindings?: Record<string, string> };
    const map = new Map(Object.entries(data.bindings ?? {}));
    return alerts.map((alert) => {
      const key = map.get(
        `${alert.namespace}/${alert.resourceKind}/${alert.resourceName}`.toLowerCase()
      );
      if (!key) return alert;
      return { ...alert, labels: { ...alert.labels, 'sre-graph-binding': key } };
    });
  } catch (err) {
    log('warn', AGENT, 'Graph binding enrichment failed — using label keys only', {
      error: String(err),
    });
    return alerts;
  }
}

function buildStartPayload(group: ReturnType<typeof buildAlertRunGroups>[number], incidentId: string): StartRunRequest {
  const primary = group.primary;
  const multi = group.affectedWorkloads.length > 1;
  return {
    incidentId,
    triggeredBy: 'commander',
    triggeredAt: new Date().toISOString(),
    namespace: primary.namespace,
    resourceKind: primary.resourceKind,
    resourceName: primary.resourceName,
    podName: primary.podName,
    mode: 'diagnose',
    eventReason: group.eventReason,
    eventMessage: group.eventMessage,
    platform: NOTIFY_CHANNEL_ID ? NOTIFY_PLATFORM : undefined,
    channelId: NOTIFY_CHANNEL_ID || undefined,
    rawMessage: multi
      ? `AlertManager correlated incident (${group.affectedWorkloads.length} workloads): ${group.eventMessage}`
      : `AlertManager: ${group.eventMessage}`,
    investigateScope: multi ? 'incident' : 'workload',
    correlationKey: group.correlationKey,
    affectedWorkloads: group.affectedWorkloads,
  };
}

export async function alertmanagerWebhookHandler(req: Request, res: Response): Promise<void> {
  if (!verifySecret(req)) {
    res.status(401).json({ error: 'Invalid alert webhook token' });
    return;
  }

  const payload = req.body as AlertmanagerPayload;
  const parsed = await enrichWithGraphBindings(parseFiringAlerts(payload));
  const started: string[] = [];
  const skipped: string[] = [];

  const groups = CORRELATION_ENABLED
    ? buildAlertRunGroups(parsed, { minGroupSize: MIN_GROUP_SIZE })
    : parsed.map((alert) => ({
        correlationKey: `workload:${alert.namespace}/${alert.resourceName}`,
        primary: {
          namespace: alert.namespace,
          resourceKind: alert.resourceKind,
          resourceName: alert.resourceName,
          podName: alert.podName,
          alertname: alert.alertname,
          summary: alert.summary,
        },
        affectedWorkloads: [
          {
            namespace: alert.namespace,
            resourceKind: alert.resourceKind,
            resourceName: alert.resourceName,
            podName: alert.podName,
            alertname: alert.alertname,
            summary: alert.summary,
          },
        ],
        eventReason: alert.alertname,
        eventMessage: alert.summary,
      }));

  const { groups: toStart, reuseIncidentIds } = CORRELATION_ENABLED
    ? mergeWithRecentCorrelation(groups, recentCorrelations, CORRELATION_WINDOW_MS)
    : { groups, reuseIncidentIds: new Map<string, string>() };

  for (const [, incidentId] of reuseIncidentIds) {
    skipped.push(incidentId);
  }

  for (const group of toStart) {
    const incidentId = uuidv4();
    const startPayload = buildStartPayload(group, incidentId);

    try {
      await postWithRetry({
        url: `${ORCHESTRATOR_URL}/runs`,
        payload: startPayload,
        incidentId,
        callerAgent: AGENT,
      });
      if (CORRELATION_ENABLED) {
        recordCorrelationWindow(recentCorrelations, group.correlationKey, incidentId, CORRELATION_WINDOW_MS);
      }
      started.push(incidentId);
      log('info', AGENT, 'Started diagnose run from alert', {
        incidentId,
        correlationKey: group.correlationKey,
        workloadCount: group.affectedWorkloads.length,
        namespace: group.primary.namespace,
        resourceName: group.primary.resourceName,
      });
    } catch (err) {
      log('error', AGENT, 'Failed to start run from alert', {
        error: String(err),
        correlationKey: group.correlationKey,
      });
    }
  }

  res.json({
    ok: true,
    started: started.length,
    skippedCorrelated: skipped.length,
    incidentIds: started,
  });
}
