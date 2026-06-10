/**
 * k8s-facts.ts
 *
 * Core Kubernetes fact-gathering module.
 * All data is returned as structured JSON — never as kubectl text output.
 *
 * Uses @kubernetes/client-node which auto-discovers cluster credentials from:
 *  - In-cluster ServiceAccount (when running in a Pod)
 *  - ~/.kube/config (when running locally for development)
 */

import * as k8s from '@kubernetes/client-node';
import type { DiagnosisContext, KubeEvent } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { buildKubeConfig } from '../../../shared/src/kube-config.js';

const AGENT = 'investigator';
const SAFE_MODE = (process.env['INVESTIGATOR_SAFE_MODE'] ?? 'true').toLowerCase() === 'true';
const SAFE_MAX_LOG_BYTES = parseInt(process.env['INVESTIGATOR_SAFE_MAX_LOG_BYTES'] ?? '4096', 10);

// ── Kubernetes client setup ──────────────────────────────────────────────────

const kc = buildKubeConfig();
const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
const appsV1Api = kc.makeApiClient(k8s.AppsV1Api);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Safely calls a K8s API method and returns the response body or a fallback.
 * Logs errors but never throws, so a single failed fact doesn't block others.
 */
async function safeCall<T>(
  incidentId: string,
  label: string,
  fn: () => Promise<{ body: T }>
): Promise<T | null> {
  try {
    const res = await fn();
    return res.body;
  } catch (err: unknown) {
    const status = (err as { response?: { statusCode?: number } })?.response?.statusCode;
    log('warn', AGENT, `K8s API call failed: ${label}`, {
      incidentId,
      error: String(err),
      status,
    });
    return null;
  }
}

/** Truncates log strings; in safe mode uses smaller limit. */
function truncateLog(raw: string | null | undefined, maxBytes?: number): string {
  const limit = maxBytes ?? (SAFE_MODE ? SAFE_MAX_LOG_BYTES : 32_768);
  if (!raw) return SAFE_MODE ? '' : '';
  if (SAFE_MODE && !raw.includes('Error') && !raw.includes('error') && !raw.includes('Exception')) {
    // Error-only logs in safe mode: take last 2KB if no error keywords
    const lines = raw.split('\n');
    const errorLines = lines.filter((l) => /error|exception|fatal|panic/i.test(l));
    if (errorLines.length === 0) return '[safe-mode: logs omitted]';
    raw = errorLines.slice(-20).join('\n');
  }
  if (raw.length <= limit) return raw;
  const half = Math.floor(limit / 2);
  return (
    raw.slice(0, half) +
    `\n... [truncated ${raw.length - limit} bytes] ...\n` +
    raw.slice(raw.length - half)
  );
}

// ── Core fact-gathering ──────────────────────────────────────────────────────

/**
 * Gathers all available Kubernetes facts for a given pod and its managing resource.
 *
 * @param namespace     - Kubernetes namespace
 * @param podName       - Name of the affected Pod
 * @param resourceName  - Name of the managing Deployment/StatefulSet/etc.
 * @param resourceKind  - Kind of the managing resource
 * @param incidentId    - Trace ID for structured logging
 */
export async function gatherPodFacts(
  namespace: string,
  podName: string,
  resourceName: string,
  resourceKind: string,
  incidentId: string
): Promise<Partial<DiagnosisContext>> {
  log('info', AGENT, 'Starting Kubernetes fact-gathering', {
    incidentId,
    namespace,
    podName,
    resourceName,
    resourceKind,
  });

  // Run all API calls concurrently — independent of each other
  const [podResult, controllerResult, eventsResult, logsResult, prevLogsResult] =
    await Promise.all([
      // 1. Pod spec
      safeCall(incidentId, `readNamespacedPod/${podName}`, () =>
        coreV1Api.readNamespacedPod(podName, namespace)
      ),

      // 2. Managing controller (Deployment, StatefulSet, DaemonSet, Job)
      fetchController(namespace, resourceName, resourceKind, incidentId),

      // 3. Pod events (filtered by involvedObject)
      safeCall(
        incidentId,
        `listNamespacedEvent(involvedObject=${podName})`,
        () =>
          coreV1Api.listNamespacedEvent(
            namespace,
            undefined,
            undefined,
            undefined,
            `involvedObject.name=${podName}`
          )
      ),

      // 4. Current container logs (first container)
      safeCall(incidentId, `readNamespacedPodLog/${podName}`, () =>
        coreV1Api.readNamespacedPodLog(
          podName,
          namespace,
          undefined,  // container — undefined picks the first
          false,      // follow
          undefined,  // insecureSkipTLSVerifyBackend
          undefined,  // limitBytes
          undefined,  // pretty
          undefined,  // previous
          undefined,  // sinceSeconds — get recent 5 mins worth
          300,        // tailLines
          undefined   // timestamps
        )
      ),

      // 5. Previous container logs (crash-loop evidence)
      safeCall(incidentId, `readNamespacedPodLog/${podName}?previous=true`, () =>
        coreV1Api.readNamespacedPodLog(
          podName,
          namespace,
          undefined,  // container
          false,      // follow
          undefined,  // insecureSkipTLSVerifyBackend
          undefined,  // limitBytes
          undefined,  // pretty
          true,       // previous ← key flag
          undefined,  // sinceSeconds
          200,        // tailLines
          undefined   // timestamps
        )
      ),
    ]);

  // ── Extract pod spec & container statuses ──────────────────────────────────

  const pod = podResult as k8s.V1Pod | null;
  const podSpec: object = pod?.spec ?? {};
  const containerStatuses: object[] = pod?.status?.containerStatuses ?? [];

  // ── Extract resource limits from pod spec ──────────────────────────────────

  const resourceLimits: object = extractResourceLimits(pod);

  // ── Extract node info ──────────────────────────────────────────────────────

  let nodeInfo: object | undefined;
  const nodeName = pod?.spec?.nodeName;
  if (nodeName) {
    const nodeResult = await safeCall(incidentId, `readNode/${nodeName}`, () =>
      coreV1Api.readNode(nodeName)
    );
    if (nodeResult) {
      const node = nodeResult as k8s.V1Node;
      nodeInfo = {
        name: node.metadata?.name,
        labels: node.metadata?.labels,
        conditions: node.status?.conditions,
        capacity: node.status?.capacity,
        allocatable: node.status?.allocatable,
        nodeInfo: node.status?.nodeInfo,
      };
    }
  }

  // ── Extract controller spec (for limits/image tags) ───────────────────────

  const controller = controllerResult;

  // ── Transform events ───────────────────────────────────────────────────────

function formatEventTime(date: Date | undefined, eventTime: any): string {
  if (date) return date.toISOString();
  if (!eventTime) return '';
  if (eventTime instanceof Date) return eventTime.toISOString();
  if (typeof eventTime === 'string') {
    const parsed = new Date(eventTime);
    return isNaN(parsed.getTime()) ? eventTime : parsed.toISOString();
  }
  if (eventTime.time && typeof eventTime.time === 'string') {
    const parsed = new Date(eventTime.time);
    return isNaN(parsed.getTime()) ? eventTime.time : parsed.toISOString();
  }
  if (typeof eventTime.toISOString === 'function') return eventTime.toISOString();
  return String(eventTime);
}

  const eventList = eventsResult as k8s.CoreV1EventList | null;
  const recentEvents: KubeEvent[] = (eventList?.items ?? []).map((e) => ({
    reason: e.reason ?? '',
    message: e.message ?? '',
    count: e.count ?? 1,
    firstTime: formatEventTime(e.firstTimestamp, e.eventTime),
    lastTime: formatEventTime(e.lastTimestamp, e.eventTime),
    type: (e.type as 'Normal' | 'Warning') ?? 'Warning',
  }));

  // Sort events newest-first
  recentEvents.sort(
    (a, b) => new Date(b.lastTime).getTime() - new Date(a.lastTime).getTime()
  );

  // ── Logs ───────────────────────────────────────────────────────────────────

  const currentLogs = truncateLog(logsResult as string | null);
  const previousLogs = truncateLog(prevLogsResult as string | null);

  log('info', AGENT, 'Kubernetes fact-gathering complete', {
    incidentId,
    namespace,
    podName,
    eventsCount: recentEvents.length,
    currentLogsBytes: currentLogs.length,
    previousLogsBytes: previousLogs.length,
    hasController: controller !== null,
    hasNodeInfo: nodeInfo !== undefined,
  });

  const facts: Partial<DiagnosisContext> = {
    podSpec,
    containerStatuses,
    resourceLimits,
    nodeInfo,
    recentEvents: recentEvents.slice(0, 50),
    currentLogs,
    previousLogs,
  };

  // Attach controller facts into resourceLimits if available
  if (controller) {
    (facts as Record<string, unknown>)['controllerSpec'] = controller;
  }

  return facts;
}

// ── Private helpers ──────────────────────────────────────────────────────────

/** Fetches the managing controller object for the given resource kind. */
async function fetchController(
  namespace: string,
  resourceName: string,
  resourceKind: string,
  incidentId: string
): Promise<object | null> {
  switch (resourceKind) {
    case 'Deployment':
      return safeCall(incidentId, `readNamespacedDeployment/${resourceName}`, () =>
        appsV1Api.readNamespacedDeployment(resourceName, namespace)
      );

    case 'StatefulSet':
      return safeCall(incidentId, `readNamespacedStatefulSet/${resourceName}`, () =>
        appsV1Api.readNamespacedStatefulSet(resourceName, namespace)
      );

    case 'DaemonSet':
      return safeCall(incidentId, `readNamespacedDaemonSet/${resourceName}`, () =>
        appsV1Api.readNamespacedDaemonSet(resourceName, namespace)
      );

    case 'ReplicaSet':
      return safeCall(incidentId, `readNamespacedReplicaSet/${resourceName}`, () =>
        appsV1Api.readNamespacedReplicaSet(resourceName, namespace)
      );

    case 'Pod':
      // No higher-level controller — already got the pod spec
      return null;

    default:
      log('warn', AGENT, `Unknown resourceKind for controller fetch: ${resourceKind}`, {
        incidentId,
        resourceKind,
        resourceName,
      });
      return null;
  }
}

/** Extracts resource requests/limits from all containers in the pod spec. */
function extractResourceLimits(pod: k8s.V1Pod | null): object {
  if (!pod?.spec?.containers) return {};

  return {
    containers: pod.spec.containers.map((c) => ({
      name: c.name,
      image: c.image,
      requests: c.resources?.requests ?? {},
      limits: c.resources?.limits ?? {},
    })),
    initContainers: (pod.spec.initContainers ?? []).map((c) => ({
      name: c.name,
      image: c.image,
      requests: c.resources?.requests ?? {},
      limits: c.resources?.limits ?? {},
    })),
  };
}
