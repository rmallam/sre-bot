/**
 * Rollout phase classification — what the cluster is doing right now, not just replica counts.
 */

import type { RemediationAction } from './types.js';

export type RolloutPhase =
  | 'ready'
  | 'scheduling'
  | 'pulling_image'
  | 'creating_container'
  | 'init_containers'
  | 'probe_warming'
  | 'rolling_update'
  | 'terminal_failure'
  | 'unknown';

export interface RemediationWaitContext {
  action: RemediationAction;
  /** What kind of change was applied — drives timeout and progress copy. */
  changeKind: 'image' | 'restart' | 'config' | 'scale' | 'unknown';
}

const TRANSIENT_PHASES = new Set<RolloutPhase>([
  'scheduling',
  'pulling_image',
  'creating_container',
  'init_containers',
  'probe_warming',
  'rolling_update',
  'unknown',
]);

export function isTransientRolloutPhase(phase: RolloutPhase | undefined): boolean {
  return !!phase && TRANSIENT_PHASES.has(phase);
}

export function inferRemediationWaitContext(
  action: RemediationAction,
  opts?: { imagePatch?: boolean }
): RemediationWaitContext {
  if (action === 'restart') {
    return { action, changeKind: 'restart' };
  }
  if (action === 'git_patch' && opts?.imagePatch) {
    return { action, changeKind: 'image' };
  }
  if (action === 'git_patch') {
    return { action, changeKind: 'config' };
  }
  if (action === 'helm_deploy' || action === 'repo_apply') {
    return { action, changeKind: 'unknown' };
  }
  return { action, changeKind: 'unknown' };
}

/** Classify a pod/container detail string from investigator verify. */
export function classifyRolloutDetail(detail: string): RolloutPhase {
  const d = detail.toLowerCase();
  if (/imagepullbackoff|invalidimagename|imageinspecterror|createcontainerconfigerror|failedmount|runcontainererror/i.test(d)) {
    return 'terminal_failure';
  }
  if (/crashloopbackoff| exited \(error| exited \(crashloopbackoff/i.test(d)) {
    return 'terminal_failure';
  }
  if (/pulling image|errimagepull|back-off pulling/i.test(d)) {
    return 'pulling_image';
  }
  if (/containercreating|creating container/i.test(d)) {
    return 'creating_container';
  }
  if (/podinitializing|init:/i.test(d)) {
    return 'init_containers';
  }
  if (/readiness probe|not ready.*running|running, readiness|probe not passing/i.test(d)) {
    return 'probe_warming';
  }
  if (/pending|unschedulable|waiting for.*schedul/i.test(d)) {
    return 'scheduling';
  }
  if (/rollout in progress|updated/i.test(d)) {
    return 'rolling_update';
  }
  return 'unknown';
}

export function mergeRolloutPhases(phases: RolloutPhase[]): RolloutPhase {
  if (phases.length === 0) return 'unknown';
  if (phases.includes('terminal_failure')) return 'terminal_failure';
  if (phases.includes('ready') && phases.every((p) => p === 'ready')) return 'ready';
  const priority: RolloutPhase[] = [
    'pulling_image',
    'creating_container',
    'init_containers',
    'scheduling',
    'probe_warming',
    'rolling_update',
    'unknown',
  ];
  for (const p of priority) {
    if (phases.includes(p)) return p;
  }
  return phases[0] ?? 'unknown';
}

export function buildRolloutProgressMessage(input: {
  resourceName: string;
  phase: RolloutPhase;
  readyReplicas?: number;
  desiredReplicas?: number;
  updatedReplicas?: number;
  waitDetail?: string;
  context: RemediationWaitContext;
}): string {
  const counts =
    input.readyReplicas != null && input.desiredReplicas != null
      ? ` (${input.readyReplicas}/${input.desiredReplicas} ready` +
        (input.updatedReplicas != null ? `, ${input.updatedReplicas} updated` : '') +
        ')'
      : '';

  if (input.waitDetail?.trim()) {
    return `**${input.resourceName}**${counts}: ${input.waitDetail}`;
  }

  switch (input.phase) {
    case 'pulling_image':
      return input.context.changeKind === 'image'
        ? `**${input.resourceName}**${counts}: pulling the new container image — large images can take several minutes.`
        : `**${input.resourceName}**${counts}: pods are pulling container images.`;
    case 'creating_container':
      return `**${input.resourceName}**${counts}: containers are being created on the node.`;
    case 'init_containers':
      return `**${input.resourceName}**${counts}: init containers are still running.`;
    case 'scheduling':
      return `**${input.resourceName}**${counts}: pods are waiting to be scheduled.`;
    case 'probe_warming':
      return `**${input.resourceName}**${counts}: containers are up but readiness probes have not passed yet.`;
    case 'rolling_update':
      return `**${input.resourceName}**${counts}: Deployment rollout is still converging.`;
    default:
      if (input.context.changeKind === 'restart') {
        return `**${input.resourceName}**${counts}: waiting for pods to restart and pass health checks.`;
      }
      return `**${input.resourceName}**${counts}: still waiting for the cluster to finish applying the change.`;
  }
}

/** Poll interval tuned to what we expect to be happening. */
export function rolloutPollIntervalMs(phase: RolloutPhase, context: RemediationWaitContext): number {
  if (phase === 'pulling_image' || context.changeKind === 'image') return 8000;
  if (phase === 'probe_warming') return 6000;
  if (phase === 'scheduling') return 10000;
  return 5000;
}

/** Max wait before we stop and ask the operator (not auto-remediate again). */
export function rolloutTimeoutMs(phase: RolloutPhase, context: RemediationWaitContext): number {
  const imageMs = parseInt(process.env['REMEDIATION_IMAGE_PULL_TIMEOUT_MS'] ?? '600000', 10);
  const defaultMs = parseInt(process.env['REMEDIATION_ROLLOUT_TIMEOUT_MS'] ?? '300000', 10);
  const restartMs = parseInt(process.env['REMEDIATION_RESTART_TIMEOUT_MS'] ?? '180000', 10);

  if (context.changeKind === 'image' || phase === 'pulling_image') return imageMs;
  if (context.changeKind === 'restart') return restartMs;
  if (phase === 'probe_warming' || phase === 'init_containers') return defaultMs;
  return defaultMs;
}
