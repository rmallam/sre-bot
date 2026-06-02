/**
 * Workload running-status reports for chat (is X running in namespace Y?).
 */

import type { ResourceKind } from './types.js';

export interface WorkloadPodStatus {
  name: string;
  phase: string;
  ready: string;
  detail?: string;
}

export interface WorkloadStatusMatch {
  namespace: string;
  resourceKind: ResourceKind;
  resourceName: string;
  healthy: boolean;
  readyReplicas?: number;
  desiredReplicas?: number;
  pods: WorkloadPodStatus[];
  summary: string;
}

export interface WorkloadStatusFacts {
  namespace: string;
  resourceKind: ResourceKind;
  resourceName: string;
  healthy: boolean;
  readyReplicas?: number;
  desiredReplicas?: number;
  pods: WorkloadPodStatus[];
  summary: string;
  /** Set when searching all namespaces. */
  scope?: 'namespace' | 'cluster';
  matches?: WorkloadStatusMatch[];
}

export function formatWorkloadStatusReport(facts: WorkloadStatusFacts): string {
  if (facts.scope === 'cluster' && facts.matches) {
    return formatClusterWorkloadStatusReport(facts);
  }

  const target = `${facts.namespace}/${facts.resourceName}`;
  const lines: string[] = [];

  if (facts.resourceKind === 'Pod') {
    const pod = facts.pods[0];
    if (!pod) {
      lines.push(`❌ Pod \`${facts.resourceName}\` was not found in namespace \`${facts.namespace}\`.`);
    } else if (pod.phase === 'Running' && (pod.ready.startsWith('1/') || pod.ready === '1/1')) {
      lines.push(`✅ Pod \`${pod.name}\` is **Running** (${pod.ready} ready) in \`${facts.namespace}\`.`);
    } else {
      lines.push(
        `⚠️ Pod \`${pod.name}\` is **${pod.phase}** (${pod.ready} ready) in \`${facts.namespace}\`.`
      );
      if (pod.detail) lines.push(pod.detail);
    }
    return lines.join('\n');
  }

  if (facts.healthy) {
    lines.push(
      `✅ **${target}** is running — ${facts.readyReplicas}/${facts.desiredReplicas} replicas ready.`
    );
  } else if (facts.desiredReplicas === 0) {
    lines.push(`⚠️ Deployment \`${facts.resourceName}\` exists in \`${facts.namespace}\` but has 0 desired replicas.`);
  } else {
    lines.push(
      `⚠️ **${target}** is not fully healthy — ${facts.readyReplicas ?? 0}/${facts.desiredReplicas ?? '?'} replicas ready.`
    );
  }

  if (facts.pods.length > 0) {
    lines.push('');
    lines.push('Pods:');
    for (const p of facts.pods.slice(0, 5)) {
      const icon = p.phase === 'Running' && !p.ready.startsWith('0/') ? '✅' : '⚠️';
      lines.push(`${icon} \`${p.name}\` — ${p.phase}, ${p.ready} ready${p.detail ? ` (${p.detail})` : ''}`);
    }
  }

  if (facts.summary && !lines.some((l) => l.includes(facts.summary.slice(0, 20)))) {
    lines.push('');
    lines.push(facts.summary);
  }

  return lines.join('\n').slice(0, 3900);
}

function formatClusterWorkloadStatusReport(facts: WorkloadStatusFacts): string {
  const matches = facts.matches ?? [];
  const lines: string[] = [`🔍 **${facts.resourceName}** across all namespaces`, ''];

  if (matches.length === 0) {
    lines.push(`No deployment or workload named \`${facts.resourceName}\` was found in any namespace.`);
    return lines.join('\n');
  }

  const running = matches.filter((m) => m.healthy);
  if (running.length === 0) {
    lines.push(
      `Found ${matches.length} match(es), but none are fully healthy right now.`
    );
  } else if (running.length === 1) {
    const m = running[0]!;
    lines.push(
      `✅ **Yes** — \`${m.namespace}/${m.resourceName}\` is running (${m.readyReplicas ?? '?'}/${m.desiredReplicas ?? '?'} ready).`
    );
  } else {
    lines.push(
      `✅ **Yes** — \`${facts.resourceName}\` is running in **${running.length}** namespace(s):`
    );
    for (const m of running) {
      lines.push(
        `• \`${m.namespace}/${m.resourceName}\` — ${m.readyReplicas ?? '?'}/${m.desiredReplicas ?? '?'} ready`
      );
    }
  }

  const unhealthy = matches.filter((m) => !m.healthy);
  if (unhealthy.length > 0) {
    lines.push('');
    lines.push('Not healthy:');
    for (const m of unhealthy.slice(0, 5)) {
      lines.push(
        `⚠️ \`${m.namespace}/${m.resourceName}\` — ${m.readyReplicas ?? 0}/${m.desiredReplicas ?? '?'} ready`
      );
    }
  }

  return lines.join('\n').slice(0, 3900);
}
