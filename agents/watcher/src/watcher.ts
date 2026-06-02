/**
 * watcher.ts — Core Kubernetes anomaly detection logic.
 *
 * Dual watch strategy:
 *  1. Stream Kubernetes Warning Events via the Watch API (event-driven)
 *  2. Poll Pod statuses every 30 s for terminal container states (polling)
 *
 * Deduplication / Cooldown (Issue #9 — alert storms):
 *  - In-memory Map<string, number> keyed by "{namespace}/{resourceName}"
 *  - Configurable cooldown window via COOLDOWN_MINUTES (default 5)
 *  - When a Pod recovers to Running, its cooldown entry is cleared
 *
 * Fires AnomalyDetected payloads to INVESTIGATOR_URL /analyze via postWithRetry.
 */

import * as k8s from '@kubernetes/client-node';
import { existsSync } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { postWithRetry, log } from '../../../shared/src/http.js';
import type { AnomalyDetected } from '../../../shared/src/types.js';

// ── Configuration ──────────────────────────────────────────────────────────────

const AGENT_NAME = 'watcher-agent';

const INVESTIGATOR_URL =
  process.env.INVESTIGATOR_URL ?? 'http://investigator-agent:8080';
const ORCHESTRATOR_URL =
  process.env.ORCHESTRATOR_URL ?? 'http://orchestrator-agent:8080';
const HIL_URL = process.env.HIL_URL ?? 'http://hil-agent:8080';
const USE_ORCHESTRATOR =
  (process.env.USE_ORCHESTRATOR ?? 'true').toLowerCase() === 'true';

const COOLDOWN_MINUTES = parseInt(process.env.COOLDOWN_MINUTES ?? '5', 10);
const COOLDOWN_MS = COOLDOWN_MINUTES * 60 * 1_000;

const POD_POLL_INTERVAL_MS = 30_000;

/**
 * Namespaces to watch. Empty array = all namespaces (cluster-wide watch).
 */
const WATCH_NAMESPACES: string[] = (() => {
  const raw = process.env.WATCH_NAMESPACES ?? '';
  return raw
    .split(',')
    .map((ns) => ns.trim())
    .filter(Boolean);
})();

/**
 * Kubernetes Event reasons that represent actionable anomalies.
 */
const WATCHED_REASONS = new Set([
  'BackOff',
  'OOMKilling',
  'FailedMount',
  'FailedCreate',
  'Killing',
  'Unhealthy',
  'Failed',
  'EvictionThresholdMet',
]);

/**
 * Pod container waiting / terminated reason strings that indicate failure.
 */
const TERMINAL_REASONS = new Set([
  'CrashLoopBackOff',
  'OOMKilled',
  'ImagePullBackOff',
  'OOMKilling',
  'Evicted',
]);

// ── Cooldown state ─────────────────────────────────────────────────────────────

/** Map<"{namespace}/{resourceName}", lastFiredTimestampMs> */
const cooldownMap = new Map<string, number>();

function cooldownKey(namespace: string, resourceName: string): string {
  return `${namespace}/${resourceName}`;
}

function normalizeWorkloadNameFromPodName(podName: string): string {
  const statefulSet = podName.match(/^(.*)-(\d+)$/);
  if (statefulSet?.[1]) {
    return statefulSet[1];
  }

  const deploymentPod = podName.match(/^(.*)-[a-f0-9]{8,10}-[a-z0-9]{5}$/i);
  if (deploymentPod?.[1]) {
    return deploymentPod[1];
  }

  const hashedSuffix = podName.match(/^(.*)-[a-f0-9]{8,10}$/i);
  if (hashedSuffix?.[1]) {
    return hashedSuffix[1];
  }

  return podName;
}

function workloadNameFromPod(pod: k8s.V1Pod): string {
  const podName = pod.metadata?.name ?? 'unknown';
  const owner = pod.metadata?.ownerReferences?.[0];
  if (!owner?.name) return normalizeWorkloadNameFromPodName(podName);
  if (owner.kind === 'StatefulSet' || owner.kind === 'DaemonSet' || owner.kind === 'Job') {
    return owner.name;
  }
  if (owner.kind === 'ReplicaSet') {
    return normalizeWorkloadNameFromPodName(owner.name);
  }
  return normalizeWorkloadNameFromPodName(podName);
}

/**
 * Returns true if the resource is within the cooldown window and should be
 * skipped. Updates the last-fired timestamp on success (i.e. not throttled).
 */
function shouldThrottle(namespace: string, resourceName: string): boolean {
  const key = cooldownKey(namespace, resourceName);
  const lastFired = cooldownMap.get(key);
  const now = Date.now();

  if (lastFired !== undefined && now - lastFired < COOLDOWN_MS) {
    return true; // still within cooldown window
  }

  cooldownMap.set(key, now);
  return false;
}

function clearCooldown(namespace: string, workloadName: string): void {
  const key = cooldownKey(namespace, workloadName);
  if (cooldownMap.has(key)) {
    cooldownMap.delete(key);
    log('info', AGENT_NAME, 'Cooldown cleared — Pod recovered', {
      namespace,
      workloadName,
      key,
    });
  }
}

/** Cached ignore list from HIL (refreshed periodically). */
let ignoreKeyCache: { keys: Set<string>; loadedAt: number } | null = null;
const IGNORE_CACHE_MS = 30_000;

async function refreshIgnoreCache(): Promise<Set<string>> {
  if (ignoreKeyCache && Date.now() - ignoreKeyCache.loadedAt < IGNORE_CACHE_MS) {
    return ignoreKeyCache.keys;
  }
  try {
    const res = await fetch(`${HIL_URL}/api/ignored`, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) {
      const data = (await res.json()) as { keys?: string[] };
      const keys = new Set(data.keys ?? []);
      ignoreKeyCache = { keys, loadedAt: Date.now() };
      return keys;
    }
  } catch {
    // HIL unavailable — don't block watcher
  }
  return ignoreKeyCache?.keys ?? new Set();
}

async function isIgnoredResource(namespace: string, resourceName: string): Promise<boolean> {
  const keys = await refreshIgnoreCache();
  return keys.has(`${namespace}/${resourceName}`);
}

// ── Kubernetes client setup ────────────────────────────────────────────────────

function buildKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  const hasToken = existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token');
  if (hasToken) {
    try {
      kc.loadFromCluster();
      log('info', AGENT_NAME, 'Loaded in-cluster kubeconfig');
      return kc;
    } catch (err) {
      log('warn', AGENT_NAME, 'Failed to load in-cluster kubeconfig, falling back to default', { error: String(err) });
    }
  }
  kc.loadFromDefault();
  log('info', AGENT_NAME, 'Loaded default kubeconfig (local dev)');
  return kc;
}

// ── Fire anomaly to investigator ───────────────────────────────────────────────

async function fireAnomaly(payload: AnomalyDetected): Promise<void> {
  log('info', AGENT_NAME, 'Firing AnomalyDetected', {
    incidentId: payload.incidentId,
    namespace: payload.namespace,
    resourceName: payload.resourceName,
    eventReason: payload.eventReason,
    podName: payload.podName,
  });

  const url = USE_ORCHESTRATOR
    ? `${ORCHESTRATOR_URL}/runs`
    : `${INVESTIGATOR_URL}/analyze`;

  const payloadToSend = USE_ORCHESTRATOR
    ? {
        ...payload,
        eventMessage: payload.eventMessage,
      }
    : payload;

  await postWithRetry({
    url,
    payload: payloadToSend,
    incidentId: payload.incidentId,
    callerAgent: AGENT_NAME,
  });
}

// ── Event Watch ────────────────────────────────────────────────────────────────

/**
 * Streams Warning events from all (or specific) namespaces using the K8s Watch
 * API. Restarts automatically on connection drop.
 */
async function watchEvents(kc: k8s.KubeConfig): Promise<void> {
  const watch = new k8s.Watch(kc);

  const namespacePaths =
    WATCH_NAMESPACES.length > 0
      ? WATCH_NAMESPACES.map((ns) => `/api/v1/namespaces/${ns}/events`)
      : ['/api/v1/events'];

  for (const watchPath of namespacePaths) {
    scheduleEventWatch(watch, watchPath);
  }
}

function scheduleEventWatch(watch: k8s.Watch, path: string): void {
  const doWatch = (): void => {
    watch
      .watch(
        path,
        { fieldSelector: 'type=Warning' },
        (phase: string, obj: k8s.CoreV1Event) => {
          if (phase === 'ADDED' || phase === 'MODIFIED') {
            handleKubeEvent(obj);
          }
        },
        (err: unknown) => {
          if (err) {
            log('warn', AGENT_NAME, 'Event watch stream ended with error — restarting in 5 s', {
              path,
              error: String(err),
            });
          } else {
            log('info', AGENT_NAME, 'Event watch stream closed — restarting in 5 s', { path });
          }
          setTimeout(doWatch, 5_000);
        }
      )
      .catch((err: unknown) => {
        log('error', AGENT_NAME, 'Event watch failed to start — restarting in 10 s', {
          path,
          error: String(err),
        });
        setTimeout(doWatch, 10_000);
      });
  };

  doWatch();
}

function handleKubeEvent(event: k8s.CoreV1Event): void {
  const reason = event.reason ?? '';
  if (!WATCHED_REASONS.has(reason)) {
    return; // not an actionable anomaly
  }

  const namespace = event.involvedObject?.namespace ?? 'default';
  const resourceName = event.involvedObject?.name ?? 'unknown';
  const resourceKind = (event.involvedObject?.kind ?? 'Pod') as
    | 'Deployment'
    | 'StatefulSet'
    | 'Pod'
    | 'Job'
    | 'DaemonSet';
  const podName =
    event.involvedObject?.kind === 'Pod'
      ? resourceName
      : (event.involvedObject?.name ?? 'unknown');
  const cooldownResource =
    event.involvedObject?.kind === 'Pod'
      ? normalizeWorkloadNameFromPodName(resourceName)
      : resourceName;

  if (shouldThrottle(namespace, cooldownResource)) {
    log('debug', AGENT_NAME, 'Cooldown active — skipping event', {
      namespace,
      resourceName,
      cooldownResource,
      reason,
    });
    return;
  }

  void (async () => {
    if (await isIgnoredResource(namespace, cooldownResource)) {
      log('debug', AGENT_NAME, 'Resource ignored — skipping event', {
        namespace,
        resourceName,
        cooldownResource,
        reason,
      });
      return;
    }

    const incidentId = uuidv4();
    const payload: AnomalyDetected = {
      incidentId,
      triggeredBy: 'watcher',
      triggeredAt: new Date().toISOString(),
      namespace,
      resourceKind,
      resourceName,
      mode: 'diagnose',
      podName,
      eventReason: reason,
      eventMessage: event.message ?? '',
      containerName: undefined,
    };

    fireAnomaly(payload).catch((err: unknown) => {
      log('error', AGENT_NAME, 'Failed to fire anomaly from K8s event', {
        incidentId,
        error: String(err),
      });
    });
  })();
}

// ── Pod Poll ───────────────────────────────────────────────────────────────────

/**
 * Polls all pods in the watched namespaces every 30 s, looking for containers
 * stuck in terminal states (CrashLoopBackOff, OOMKilled, ImagePullBackOff, etc.)
 */
async function pollPods(coreApi: k8s.CoreV1Api): Promise<void> {
  const poll = async (): Promise<void> => {
    try {
      if (WATCH_NAMESPACES.length > 0) {
        for (const ns of WATCH_NAMESPACES) {
          const res = await coreApi.listNamespacedPod(ns);
          processPodList(res.body.items);
        }
      } else {
        const res = await coreApi.listPodForAllNamespaces();
        processPodList(res.body.items);
      }
    } catch (err: unknown) {
      log('error', AGENT_NAME, 'Pod poll failed', { error: String(err) });
    }
  };

  // Run immediately, then on interval
  await poll();
  setInterval(() => {
    poll().catch((err: unknown) => {
      log('error', AGENT_NAME, 'Pod poll interval error', { error: String(err) });
    });
  }, POD_POLL_INTERVAL_MS);
}

function processPodList(pods: k8s.V1Pod[]): void {
  for (const pod of pods) {
    const namespace = pod.metadata?.namespace ?? 'default';
    const podName = pod.metadata?.name ?? 'unknown';
    const workloadName = workloadNameFromPod(pod);

    // Check if Pod itself is Evicted (phase=Failed, reason=Evicted)
    const podPhase = pod.status?.phase;
    const podReason = pod.status?.reason;

    if (podPhase === 'Failed' && podReason === 'Evicted') {
      if (!shouldThrottle(namespace, workloadName)) {
        const incidentId = uuidv4();
        const payload: AnomalyDetected = {
          incidentId,
          triggeredBy: 'watcher',
          triggeredAt: new Date().toISOString(),
          namespace,
          resourceKind: 'Pod',
          resourceName: podName,
          mode: 'diagnose',
          podName,
          eventReason: 'Evicted',
          eventMessage: pod.status?.message ?? 'Pod evicted',
        };
        fireAnomaly(payload).catch((err: unknown) => {
          log('error', AGENT_NAME, 'Failed to fire Evicted anomaly', {
            incidentId,
            error: String(err),
          });
        });
      }
      continue;
    }

    // Check container statuses for terminal states
    const allStatuses = [
      ...(pod.status?.containerStatuses ?? []),
      ...(pod.status?.initContainerStatuses ?? []),
    ];

    let podIsHealthy = true;

    for (const cs of allStatuses) {
      const waitingReason = cs.state?.waiting?.reason ?? '';
      const terminatedReason = cs.state?.terminated?.reason ?? '';

      const anomalyReason = TERMINAL_REASONS.has(waitingReason)
        ? waitingReason
        : TERMINAL_REASONS.has(terminatedReason)
        ? terminatedReason
        : null;

      if (anomalyReason) {
        podIsHealthy = false;

        if (!shouldThrottle(namespace, workloadName)) {
          void (async () => {
            if (await isIgnoredResource(namespace, workloadName)) {
              return;
            }
            const incidentId = uuidv4();
            const message =
              cs.state?.waiting?.message ??
              cs.state?.terminated?.message ??
              `Container ${cs.name} is in state ${anomalyReason}`;

            const payload: AnomalyDetected = {
              incidentId,
              triggeredBy: 'watcher',
              triggeredAt: new Date().toISOString(),
              namespace,
              resourceKind: 'Pod',
              resourceName: podName,
              mode: 'diagnose',
              podName,
              eventReason: anomalyReason,
              eventMessage: message,
              containerName: cs.name,
            };

            fireAnomaly(payload).catch((err: unknown) => {
              log('error', AGENT_NAME, 'Failed to fire pod-poll anomaly', {
                incidentId,
                error: String(err),
              });
            });
          })();
        }
      }
    }

    // If all containers are Running+Ready, clear any existing cooldown entry
    if (podIsHealthy && podPhase === 'Running') {
      const allReady = allStatuses.length > 0 && allStatuses.every((cs) => cs.ready === true);
      if (allReady) {
        clearCooldown(namespace, workloadName);
      }
    }
  }
}

// ── Public entrypoint ──────────────────────────────────────────────────────────

export async function startWatcher(): Promise<void> {
  log('info', AGENT_NAME, 'Starting watcher', {
    watchNamespaces: WATCH_NAMESPACES.length > 0 ? WATCH_NAMESPACES : ['all'],
    cooldownMinutes: COOLDOWN_MINUTES,
    investigatorUrl: INVESTIGATOR_URL,
  });

  const kc = buildKubeConfig();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);

  // Start both watch strategies concurrently
  await Promise.all([watchEvents(kc), pollPods(coreApi)]);
}
