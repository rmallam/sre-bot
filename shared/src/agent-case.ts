/**
 * AGENT-1 — Case model for durable investigation/remediation threads.
 */

import type {
  ActionRecord,
  DiagnosisContext,
  Platform,
  ResourceKind,
} from './types.js';
import type { RcaPointer } from './rca-pointers.js';

export type AgentCaseSubjectKind = 'workload' | 'namespace' | 'cluster' | 'ci' | 'deploy';

export type AgentCaseStatus =
  | 'open'
  | 'investigating'
  | 'awaiting_user'
  | 'awaiting_hil'
  | 'remediating'
  | 'resolved'
  | 'escalated';

export interface AgentCaseSubject {
  kind: AgentCaseSubjectKind;
  namespace?: string;
  resourceName?: string;
  resourceKind?: ResourceKind;
  githubRepo?: string;
  label: string;
}

export interface AgentCaseEvidence {
  facts?: Partial<DiagnosisContext>;
  rcaPointers?: RcaPointer[];
  userHints: string[];
  actionAttempts: ActionRecord[];
  /** Tool names already executed — skip duplicate fetches (Phase D cache). */
  fetchedTools: string[];
}

export interface AgentCase {
  caseId: string;
  subject: AgentCaseSubject;
  status: AgentCaseStatus;
  activeRunId?: string;
  lastIncidentId?: string;
  evidence: AgentCaseEvidence;
  platform: Platform;
  channelId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export function emptyEvidence(): AgentCaseEvidence {
  return { userHints: [], actionAttempts: [], fetchedTools: [] };
}

export function subjectDedupeKey(subject: AgentCaseSubject): string {
  const parts = [
    subject.kind,
    subject.namespace ?? '',
    subject.resourceName ?? '',
    subject.githubRepo ?? '',
  ];
  return parts.join('|').toLowerCase();
}

export function subjectFromInvestigate(opts: {
  scope: 'workload' | 'namespace' | 'cluster';
  namespace: string;
  resourceName: string;
  resourceKind?: ResourceKind;
  label: string;
}): AgentCaseSubject {
  if (opts.scope === 'cluster') {
    return { kind: 'cluster', label: opts.label || 'cluster health' };
  }
  if (opts.scope === 'namespace') {
    return { kind: 'namespace', namespace: opts.namespace, label: opts.label || opts.namespace };
  }
  return {
    kind: 'workload',
    namespace: opts.namespace,
    resourceName: opts.resourceName,
    resourceKind: opts.resourceKind ?? 'Deployment',
    label: opts.label || `${opts.namespace}/${opts.resourceName}`,
  };
}

export function subjectFromDeploy(opts: {
  namespace: string;
  appName: string;
  githubRepo?: string;
  label?: string;
}): AgentCaseSubject {
  return {
    kind: 'deploy',
    namespace: opts.namespace,
    resourceName: opts.appName,
    resourceKind: 'Deployment',
    githubRepo: opts.githubRepo,
    label: opts.label ?? `deploy ${opts.appName}`,
  };
}

export function mergeUserHint(evidence: AgentCaseEvidence, hint: string): AgentCaseEvidence {
  const t = hint.trim();
  if (!t) return evidence;
  if (evidence.userHints.includes(t)) return evidence;
  return { ...evidence, userHints: [...evidence.userHints, t] };
}

export function combinedOperatorHints(hints: string[]): string | undefined {
  if (!hints.length) return undefined;
  return hints[hints.length - 1];
}
