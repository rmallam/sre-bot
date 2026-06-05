/**
 * Observe pod-level rollout state for a Deployment — used by verify to drive smart waits.
 */

import * as k8s from '@kubernetes/client-node';
import type { RolloutPhase } from '../../../shared/src/rollout-phase.js';
import {
  classifyRolloutDetail,
  mergeRolloutPhases,
} from '../../../shared/src/rollout-phase.js';
import { isTerminalWorkloadFailure, isTransientImagePull } from '../../../shared/src/rollout-status.js';

export interface PodRolloutObservation {
  podName: string;
  phase: string;
  detail: string;
  rolloutPhase: RolloutPhase;
}

export interface DeploymentRolloutObservation {
  podObservations: PodRolloutObservation[];
  rolloutPhase: RolloutPhase;
  waitDetail: string;
  podPhaseSummaries: string[];
  terminal: boolean;
  transient: boolean;
}

function labelSelectorFromLabels(labels: Record<string, string> | undefined): string | undefined {
  if (!labels || Object.keys(labels).length === 0) return undefined;
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

function observeContainer(podName: string, status: k8s.V1ContainerStatus): PodRolloutObservation | null {
  const waiting = status.state?.waiting;
  if (waiting) {
    const reason = waiting.reason ?? 'Waiting';
    const msg = waiting.message ?? '';
    const detail = `${reason}${msg ? `: ${msg}` : ''}`;
    return {
      podName,
      phase: reason,
      detail,
      rolloutPhase: classifyRolloutDetail(`${reason} ${msg}`),
    };
  }

  if (status.state?.running && !status.ready) {
    return {
      podName,
      phase: 'Running',
      detail: `${status.name} running, readiness probe not passing yet`,
      rolloutPhase: 'probe_warming',
    };
  }

  if (status.ready) {
    return {
      podName,
      phase: 'Ready',
      detail: `${status.name} ready`,
      rolloutPhase: 'ready',
    };
  }

  return null;
}

function observePod(pod: k8s.V1Pod): PodRolloutObservation[] {
  const podName = pod.metadata?.name ?? 'unknown';
  const phase = pod.status?.phase ?? 'Unknown';
  const out: PodRolloutObservation[] = [];

  if (phase === 'Pending' && (pod.status?.containerStatuses ?? []).length === 0) {
    const cond = pod.status?.conditions?.find((c) => c.type === 'PodScheduled' && c.status === 'False');
    const detail = cond?.reason
      ? `Pending (${cond.reason}${cond.message ? `: ${cond.message.slice(0, 120)}` : ''})`
      : 'Pending — waiting to be scheduled';
    out.push({
      podName,
      phase,
      detail,
      rolloutPhase: 'scheduling',
    });
    return out;
  }

  for (const init of pod.status?.initContainerStatuses ?? []) {
    if (!init.ready) {
      const waiting = init.state?.waiting;
      const reason = waiting?.reason ?? 'Init';
      const msg = waiting?.message ?? '';
      out.push({
        podName,
        phase: `Init:${init.name}`,
        detail: `Init container ${init.name}: ${reason}${msg ? ` — ${msg.slice(0, 100)}` : ''}`,
        rolloutPhase: 'init_containers',
      });
    }
  }

  for (const cs of pod.status?.containerStatuses ?? []) {
    const obs = observeContainer(podName, cs);
    if (obs) out.push(obs);
  }

  if (out.length === 0 && phase === 'Running') {
    out.push({
      podName,
      phase,
      detail: 'Running',
      rolloutPhase: 'probe_warming',
    });
  }

  return out;
}

function summarizeWaitDetail(
  resourceName: string,
  observations: PodRolloutObservation[],
  rolloutPhase: RolloutPhase
): string {
  const active = observations.filter((o) => o.rolloutPhase !== 'ready');
  if (active.length === 0) {
    return `Deployment ${resourceName} pods still converging`;
  }

  const pulling = active.filter((o) => o.rolloutPhase === 'pulling_image');
  if (pulling.length > 0) {
    const sample = pulling[0]!.detail.replace(/^ContainerCreating:\s*/i, '');
    return `${pulling.length} pod(s) pulling image${sample.includes('Pulling') || sample.includes('pull') ? ` — ${sample.slice(0, 140)}` : ''}`;
  }

  const probes = active.filter((o) => o.rolloutPhase === 'probe_warming');
  if (probes.length > 0) {
    return `${probes.length} pod(s) running — waiting for readiness probes`;
  }

  const creating = active.filter((o) =>
    ['creating_container', 'init_containers', 'scheduling'].includes(o.rolloutPhase)
  );
  if (creating.length > 0) {
    return `${creating.length} pod(s): ${creating[0]!.detail.slice(0, 140)}`;
  }

  if (rolloutPhase === 'rolling_update') {
    return `Rollout in progress — ${active.length} pod(s) not ready yet`;
  }

  return active[0]!.detail.slice(0, 180);
}

export async function observeDeploymentRollout(
  kc: k8s.KubeConfig,
  namespace: string,
  resourceName: string,
  dep: k8s.V1Deployment
): Promise<DeploymentRolloutObservation> {
  const core = kc.makeApiClient(k8s.CoreV1Api);
  let items: k8s.V1Pod[] = [];

  const selector = labelSelectorFromLabels(dep.spec?.selector?.matchLabels);
  try {
    if (selector) {
      const podsRes = await core.listNamespacedPod(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        selector
      );
      items = podsRes.body.items ?? [];
    }
  } catch {
    items = [];
  }

  if (items.length === 0) {
    try {
      const prefix = `${resourceName}-`;
      const list = await core.listNamespacedPod(namespace);
      items = (list.body.items ?? []).filter((p) => p.metadata?.name?.startsWith(prefix));
    } catch {
      items = [];
    }
  }

  const podObservations = items.flatMap(observePod);
  const phases = podObservations.map((o) => o.rolloutPhase);
  let rolloutPhase = mergeRolloutPhases(phases.length > 0 ? phases : ['unknown']);

  const messages = podObservations.map((o) => o.detail);
  const terminal =
    rolloutPhase === 'terminal_failure' || messages.some((m) => isTerminalWorkloadFailure(m));

  const transient =
    !terminal &&
    (rolloutPhase === 'pulling_image' ||
      rolloutPhase === 'creating_container' ||
      rolloutPhase === 'init_containers' ||
      rolloutPhase === 'scheduling' ||
      rolloutPhase === 'probe_warming' ||
      messages.some((m) => isTransientImagePull(m)));

  if (transient && rolloutPhase === 'unknown' && messages.some((m) => isTransientImagePull(m))) {
    rolloutPhase = 'pulling_image';
  }

  const waitDetail = summarizeWaitDetail(resourceName, podObservations, rolloutPhase);

  return {
    podObservations,
    rolloutPhase,
    waitDetail,
    podPhaseSummaries: podObservations.map((o) => `${o.podName}: ${o.detail}`),
    terminal,
    transient,
  };
}
