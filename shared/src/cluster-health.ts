/** Lightweight cluster health snapshot for the console dashboard. */

export type ClusterHealthStatus = 'healthy' | 'degraded' | 'unreachable';

/** UI-facing severity for traffic-light display. */
export type ClusterHealthDisplayStatus = 'healthy' | 'degrading' | 'apps_failing' | 'unreachable';

export interface ClusterHealthNode {
  name: string;
  ready: boolean;
}

export interface ClusterHealthDeployment {
  namespace: string;
  name: string;
  ready: number;
  desired: number;
}

export interface ClusterHealthPodIssue {
  namespace: string;
  name: string;
  phase: string;
  reason: string;
}

export interface ClusterHealthEvent {
  namespace: string;
  reason: string;
  object: string;
  message: string;
  lastTime: string;
}

export interface ClusterHealthSnapshot {
  reachable: boolean;
  checkedAt: string;
  error?: string;
  status: ClusterHealthStatus;
  displayStatus: ClusterHealthDisplayStatus;
  statusSummary: string;
  nodes: {
    total: number;
    ready: number;
    notReady: number;
    items: ClusterHealthNode[];
  };
  pods: {
    total: number;
    running: number;
    pending: number;
    failed: number;
    problematic: number;
    issues: ClusterHealthPodIssue[];
  };
  deployments: {
    total: number;
    unhealthy: number;
    items: ClusterHealthDeployment[];
  };
  warningEvents: ClusterHealthEvent[];
  /** How far back warning events are considered (minutes). */
  eventWindowMinutes: number;
}

const PROBLEMATIC_WAITING = new Set([
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'ErrImagePull',
  'CreateContainerConfigError',
  'CreateContainerError',
  'InvalidImageName',
  'RunContainerError',
  'ContainerCannotRun',
  'DeadlineExceeded',
]);

export interface PodIssueInput {
  namespace: string;
  name: string;
  phase?: string;
  containerStatuses?: Array<{
    state?: {
      waiting?: { reason?: string };
      terminated?: { reason?: string; exitCode?: number };
    };
  }>;
}

export function classifyPodIssue(pod: PodIssueInput): ClusterHealthPodIssue | null {
  const namespace = pod.namespace;
  const name = pod.name;
  const phase = pod.phase ?? 'Unknown';

  for (const cs of pod.containerStatuses ?? []) {
    const waitingReason = cs.state?.waiting?.reason;
    if (waitingReason) {
      if (PROBLEMATIC_WAITING.has(waitingReason) || /backoff/i.test(waitingReason)) {
        return { namespace, name, phase, reason: waitingReason };
      }
    }
    const terminated = cs.state?.terminated;
    if (terminated?.reason && terminated.reason !== 'Completed' && (terminated.exitCode ?? 0) !== 0) {
      return { namespace, name, phase, reason: terminated.reason };
    }
  }

  if (phase === 'Failed') {
    return { namespace, name, phase, reason: 'Failed' };
  }
  return null;
}

/** Default: only warnings from the last N minutes affect health status. */
export const DEFAULT_EVENT_WINDOW_MINUTES = 15;

export function eventTimestampMs(lastTime: string | undefined): number | null {
  if (!lastTime) return null;
  const ms = Date.parse(lastTime);
  return Number.isFinite(ms) ? ms : null;
}

export function isRecentEvent(
  lastTime: string | undefined,
  nowMs: number,
  windowMinutes: number
): boolean {
  const ts = eventTimestampMs(lastTime);
  if (ts === null) return false;
  return nowMs - ts <= windowMinutes * 60_000;
}

export function filterRecentWarningEvents<T extends { lastTime: string }>(
  events: T[],
  nowMs: number,
  windowMinutes: number
): T[] {
  return events.filter((e) => isRecentEvent(e.lastTime, nowMs, windowMinutes));
}

export function deriveClusterStatus(input: {
  reachable: boolean;
  notReadyNodes: number;
  unhealthyDeployments: number;
  problematicPods: number;
  warningEvents: number;
}): ClusterHealthStatus {
  if (!input.reachable) return 'unreachable';
  if (
    input.notReadyNodes > 0 ||
    input.unhealthyDeployments > 0 ||
    input.problematicPods > 0 ||
    input.warningEvents > 0
  ) {
    return 'degraded';
  }
  return 'healthy';
}

export function deriveDisplayStatus(input: {
  reachable: boolean;
  notReadyNodes: number;
  unhealthyDeployments: number;
  problematicPods: number;
  warningEvents: number;
}): ClusterHealthDisplayStatus {
  if (!input.reachable) return 'unreachable';
  if (input.notReadyNodes > 0 || input.unhealthyDeployments > 0 || input.problematicPods > 0) {
    return 'apps_failing';
  }
  if (input.warningEvents > 0) return 'degrading';
  return 'healthy';
}

export function buildStatusSummary(
  displayStatus: ClusterHealthDisplayStatus,
  input: {
    error?: string;
    notReadyNodes: number;
    unhealthyDeployments: number;
    problematicPods: number;
    warningEvents: number;
    eventWindowMinutes?: number;
  }
): string {
  switch (displayStatus) {
    case 'unreachable':
      return input.error ?? 'Cluster API is unreachable.';
    case 'apps_failing': {
      const parts: string[] = [];
      if (input.problematicPods > 0) {
        parts.push(`${input.problematicPods} problem pod${input.problematicPods === 1 ? '' : 's'}`);
      }
      if (input.unhealthyDeployments > 0) {
        parts.push(
          `${input.unhealthyDeployments} deployment${input.unhealthyDeployments === 1 ? '' : 's'} not ready`
        );
      }
      if (input.notReadyNodes > 0) {
        parts.push(`${input.notReadyNodes} node${input.notReadyNodes === 1 ? '' : 's'} not ready`);
      }
      return `Apps failing — ${parts.join(', ')}.`;
    }
    case 'degrading':
      return `Degrading — ${input.warningEvents} recent warning event${input.warningEvents === 1 ? '' : 's'} (last ${input.eventWindowMinutes ?? DEFAULT_EVENT_WINDOW_MINUTES}m), no failing apps.`;
    case 'healthy':
      return 'Cluster is healthy — all nodes ready, no failing workloads.';
  }
}
