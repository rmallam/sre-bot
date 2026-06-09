/**
 * Classify inbound SRE chat text into coded vs RAG task scenarios.
 */

import type { SreTaskProfile, SreTaskScenario } from './sre-task-scenarios.js';
import { profileForScenario, SRE_TASK_MATRIX } from './sre-task-scenarios.js';

export type SreParsedCommandType =
  | 'get'
  | 'workload-status'
  | 'investigate'
  | 'deploy'
  | 'rollback'
  | 'delete'
  | 'ci-failure'
  | 'unknown';

export interface SreParsedCommandShape {
  type: SreParsedCommandType;
  scope?: 'workload' | 'namespace' | 'cluster' | 'event' | 'app';
}

export interface SreTaskClassification {
  scenario: SreTaskScenario;
  handler: SreTaskProfile['handler'];
  confidence: number;
  /** When handler=rag and no cluster action — return playbook as chat reply */
  advisoryOnly: boolean;
  ragSignature?: string;
  ragComponent?: string;
}

const ADVISORY_PATTERNS: Array<{ scenario: SreTaskScenario; re: RegExp }> = [
  { scenario: 'rag-disaster-recovery', re: /\b(disaster\s+recover(?:y|)|dr\s+plan|failover\s+procedure)\b/i },
  { scenario: 'rag-capacity-planning', re: /\b(capacity\s+plan|right\s*siz|autoscaling\s+review)\b/i },
  { scenario: 'rag-security-incident', re: /\b(security\s+incident|breach\s+response|compromised)\b/i },
  { scenario: 'rag-certificate-rotation', re: /\b(cert(ificate)?\s+(rotat|expir|renew)|tls\s+renew)\b/i },
  { scenario: 'rag-database-failover', re: /\b(database|db|postgres|mysql)\s+(failover|replica|primary)\b/i },
  { scenario: 'rag-network-policy', re: /\b(network\s*polic|connectivity\s+debug|can't\s+reach\s+service)\b/i },
  { scenario: 'rag-postmortem', re: /\b(postmortem|post\s*-?\s*mortem|blameless\s+review)\b/i },
  { scenario: 'rag-slo-burn-rate', re: /\b(slo|error\s+budget|burn\s+rate)\b/i },
  { scenario: 'rag-incident-command', re: /\b(incident\s+command|severity\s+[123]|war\s+room)\b/i },
  { scenario: 'rag-node-drain', re: /\b(drain\s+node|cord(on)?\s+node|node\s+maintenance)\b/i },
  { scenario: 'rag-etcd-backup', re: /\b(etcd\s+(backup|restore|snapshot))\b/i },
];

const ERROR_PATTERNS: Array<{ scenario: SreTaskScenario; re: RegExp }> = [
  { scenario: 'rag-crash-loop', re: /\bCrashLoopBackOff\b/i },
  { scenario: 'rag-oom-killed', re: /\bOOMKilled\b/i },
  { scenario: 'rag-image-pull', re: /\b(ImagePullBackOff|ErrImagePull)\b/i },
  { scenario: 'rag-failed-mount', re: /\bFailedMount\b/i },
  { scenario: 'rag-failed-scheduling', re: /\bFailedScheduling\b/i },
  { scenario: 'rag-evicted', re: /\bEvicted\b/i },
  { scenario: 'rag-config-error', re: /\bCreateContainerConfigError\b/i },
];

function fromProfile(scenario: SreTaskScenario, confidence: number, advisoryOnly: boolean): SreTaskClassification {
  const profile = profileForScenario(scenario)!;
  return {
    scenario,
    handler: profile.handler,
    confidence,
    advisoryOnly,
    ragSignature: profile.ragSignature,
    ragComponent: profile.ragComponent,
  };
}

/** Map an already-parsed commander command to an SRE task scenario. */
export function classifyFromParsedCommand(parsed: SreParsedCommandShape): SreTaskClassification | null {
  switch (parsed.type) {
    case 'get':
      return fromProfile('get-resources', 0.95, false);
    case 'workload-status':
      return fromProfile('workload-status', 0.95, false);
    case 'investigate':
      if (parsed.scope === 'cluster') return fromProfile('cluster-health', 0.9, false);
      if (parsed.scope === 'namespace') return fromProfile('namespace-health', 0.9, false);
      if (parsed.scope === 'event') return fromProfile('investigate-event', 0.9, false);
      if (parsed.scope === 'app') return fromProfile('investigate-app', 0.9, false);
      return fromProfile('investigate-workload', 0.9, false);
    case 'deploy':
      return fromProfile('deploy-app', 0.95, false);
    case 'rollback':
      return fromProfile('rollback-release', 0.95, false);
    case 'delete':
      return fromProfile('delete-workload', 0.95, false);
    case 'ci-failure':
      return fromProfile('ci-failure', 0.95, false);
    default:
      return null;
  }
}

/** Classify free-form text — advisory RAG, error signatures, or null to fall through. */
export function classifySreTaskText(text: string): SreTaskClassification | null {
  const normalised = text.trim();
  if (!normalised) return null;

  for (const { scenario, re } of ADVISORY_PATTERNS) {
    if (re.test(normalised)) {
      return fromProfile(scenario, 0.82, true);
    }
  }

  for (const { scenario, re } of ERROR_PATTERNS) {
    if (re.test(normalised)) {
      const investigate = /\b(investigate|fix|remediat|why|diagnos)\b/i.test(normalised);
      return fromProfile(scenario, 0.88, !investigate);
    }
  }

  if (/\b(restart|rollout\s+restart)\b/i.test(normalised)) {
    return fromProfile('restart-rollout', 0.85, false);
  }
  if (/\bscale\s+(up|down|to)\b/i.test(normalised)) {
    return fromProfile('scale-workload', 0.8, false);
  }
  if (/\bcluster\s+health\b/i.test(normalised)) {
    return fromProfile('cluster-health', 0.85, false);
  }

  return null;
}

export function listRagSeedSignatures(): string[] {
  return SRE_TASK_MATRIX.filter((t) => t.handler === 'rag' && t.ragSignature).map(
    (t) => t.ragSignature!
  );
}
