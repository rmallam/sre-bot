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

export type AgentCaseSubjectKind = 'workload' | 'namespace' | 'cluster' | 'ci' | 'deploy' | 'app';

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
  scope: 'workload' | 'namespace' | 'cluster' | 'app';
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
  if (opts.scope === 'app') {
    return {
      kind: 'app',
      namespace: opts.namespace,
      resourceName: opts.resourceName,
      label: opts.label || `app ${opts.resourceName}`,
    };
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

/** AGENT-D2 — fields to seed a new run from cached case evidence. */
export function caseEvidenceSeed(evidence: AgentCaseEvidence): {
  cachedFacts?: Partial<DiagnosisContext>;
  cachedFetchedTools: string[];
} {
  return {
    cachedFacts: evidence.facts,
    cachedFetchedTools: [...(evidence.fetchedTools ?? [])],
  };
}

export function mergeCaseEvidenceTool(
  evidence: AgentCaseEvidence,
  toolName: string,
  factsPatch?: Partial<DiagnosisContext>
): AgentCaseEvidence {
  const fetchedTools = evidence.fetchedTools.includes(toolName)
    ? evidence.fetchedTools
    : [...evidence.fetchedTools, toolName];
  const facts = factsPatch
    ? { ...(evidence.facts ?? {}), ...factsPatch }
    : evidence.facts;
  return { ...evidence, fetchedTools, facts };
}

export function mergeCaseEvidenceFromDiagnosis(
  evidence: AgentCaseEvidence,
  facts: Partial<DiagnosisContext>,
  toolNames: string[] = []
): AgentCaseEvidence {
  let next = evidence;
  for (const tool of toolNames) {
    next = mergeCaseEvidenceTool(next, tool);
  }
  if (Object.keys(facts).length > 0) {
    next = { ...next, facts: { ...(next.facts ?? {}), ...facts } };
  }
  return next;
}
