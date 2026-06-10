/**
 * Parse and explain specific Kubernetes warning events from chat prompts.
 */

import type { ClusterHealthSnapshot } from './cluster-health.js';

export interface KnownK8sEvent {
  severity: 'benign' | 'warning' | 'critical';
  title: string;
  explanation: string;
  benignWhenHealthy: string;
  actionWhenUnhealthy?: string;
}

export const KNOWN_K8S_EVENTS: Record<string, KnownK8sEvent> = {
  FailedNodeAllocatableEnforcement: {
    severity: 'benign',
    title: 'Node allocatable limits (cgroup)',
    explanation:
      'The kubelet could not update cgroup allocatable limits for kubelet/kubepods slices. This is common on kind, Podman Desktop, and other local clusters where cgroup layout differs from production nodes.',
    benignWhenHealthy:
      'No action needed — nodes are Ready and workloads are running. This warning does not indicate failing applications.',
    actionWhenUnhealthy:
      'Check node NotReady status and kubelet logs; cgroup warnings may coincide with real node pressure.',
  },
  FailedScheduling: {
    severity: 'warning',
    title: 'Pod scheduling failed',
    explanation: 'A pod could not be scheduled onto any node (resources, taints, affinity, or volume constraints).',
    benignWhenHealthy:
      'If no pods are stuck Pending now, this was likely transient. Watch for new Pending pods.',
    actionWhenUnhealthy: 'Inspect Pending pods and describe them for scheduler events.',
  },
  BackOff: {
    severity: 'warning',
    title: 'Container restart backoff',
    explanation: 'A container is crash-looping and Kubernetes is backing off restart attempts.',
    benignWhenHealthy: 'If problem pods are clear now, the crash may have self-resolved.',
    actionWhenUnhealthy: 'Check logs for the crashing pod and fix the root cause.',
  },
};

export interface EventInvestigationOutcome {
  reason: string;
  message: string;
  severity: 'benign' | 'warning' | 'critical';
  title: string;
  explanation: string;
  recommendation: string;
  clusterHealthy: boolean;
  currentNotes: string[];
}

export function extractEventFromInvestigateText(text: string): {
  reason: string;
  message: string;
} | null {
  const normalised = text.trim();
  if (!/\binvestigate\b/i.test(normalised)) return null;

  const patterns = [
    /investigate\s+this\s*[•·\-–—:]\s*([A-Z][a-zA-Z0-9]+)\s*:\s*(.+)/i,
    /investigate\s+(?:this\s+)?(?:event|warning)\s+([A-Z][a-zA-Z0-9]+)\b(?:[:\s-]+(.+))?/i,
    /investigate\s+this\s+([A-Z][a-zA-Z0-9]+)\s+(.{8,})/i,
    /investigate\b[^:]{0,80}?([A-Z][a-zA-Z]{4,})\s*:\s*(.{15,})/,
  ];

  for (const pattern of patterns) {
    const m = normalised.match(pattern);
    if (!m?.[1]) continue;
    const reason = m[1].trim();
    if (/^(Cluster|Namespace|Deployment|Pod|Node)$/i.test(reason)) continue;
    const message = (m[2] ?? '').trim();
    return { reason, message };
  }

  return null;
}

function isClusterCurrentlyHealthy(snapshot: ClusterHealthSnapshot | null | undefined): boolean {
  if (!snapshot?.reachable) return false;
  if (snapshot.displayStatus === 'healthy') return true;
  return (
    snapshot.nodes.notReady === 0 &&
    snapshot.pods.problematic === 0 &&
    snapshot.deployments.unhealthy === 0
  );
}

function buildCurrentNotes(snapshot: ClusterHealthSnapshot | null | undefined): string[] {
  if (!snapshot?.reachable) {
    return ['Cluster API was unreachable at investigation time.'];
  }
  const notes: string[] = [
    `${snapshot.nodes.ready}/${snapshot.nodes.total} nodes Ready`,
    `${snapshot.pods.running} pods Running`,
  ];
  if (snapshot.pods.problematic > 0) {
    notes.push(`${snapshot.pods.problematic} problem pod(s) right now`);
  }
  if (snapshot.deployments.unhealthy > 0) {
    notes.push(`${snapshot.deployments.unhealthy} deployment(s) not fully ready`);
  }
  return notes;
}

export function buildEventInvestigation(input: {
  reason: string;
  message: string;
  snapshot?: ClusterHealthSnapshot | null;
}): EventInvestigationOutcome {
  const known = KNOWN_K8S_EVENTS[input.reason];
  const clusterHealthy = isClusterCurrentlyHealthy(input.snapshot);
  const currentNotes = buildCurrentNotes(input.snapshot);

  if (known) {
    return {
      reason: input.reason,
      message: input.message,
      severity: clusterHealthy && known.severity === 'benign' ? 'benign' : known.severity,
      title: known.title,
      explanation: known.explanation,
      recommendation: clusterHealthy
        ? known.benignWhenHealthy
        : (known.actionWhenUnhealthy ?? known.benignWhenHealthy),
      clusterHealthy,
      currentNotes,
    };
  }

  return {
    reason: input.reason,
    message: input.message,
    severity: clusterHealthy ? 'warning' : 'critical',
    title: `Kubernetes warning: ${input.reason}`,
    explanation: input.message.trim() || 'No additional message text was provided.',
    recommendation: clusterHealthy
      ? 'Workloads look healthy now — this may be a stale or one-time warning. No immediate action unless it repeats.'
      : 'Workloads or nodes are unhealthy — investigate the affected resources shown below.',
    clusterHealthy,
    currentNotes,
  };
}
