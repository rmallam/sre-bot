/**
 * AGENT-2 — Case open / resume / hint merge for commander.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Platform } from '../../../shared/src/types.js';
import type {
  AgentCase,
  AgentCaseStatus,
  AgentCaseSubject,
} from '../../../shared/src/agent-case.js';
import {
  emptyEvidence,
  mergeUserHint,
  subjectDedupeKey,
  combinedOperatorHints,
} from '../../../shared/src/agent-case.js';
import { shouldResumeCaseWithHint } from './case-continuation.js';
import { getCaseStore } from './case-store.js';
import { setSession } from './sessions.js';

export async function getCase(
  platform: Platform,
  channelId: string,
  userId: string,
  caseId: string
): Promise<AgentCase | undefined> {
  return getCaseStore().get({ platform, channelId, userId, caseId });
}

export async function getActiveCase(
  platform: Platform,
  channelId: string,
  userId: string
): Promise<AgentCase | undefined> {
  const caseId = await getCaseStore().getActiveCaseId(platform, channelId, userId);
  if (!caseId) return undefined;
  return getCase(platform, channelId, userId, caseId);
}

export async function openOrResumeCase(opts: {
  platform: Platform;
  channelId: string;
  userId: string;
  subject: AgentCaseSubject;
  userHint?: string;
}): Promise<AgentCase> {
  const { platform, channelId, userId, subject, userHint } = opts;
  const store = getCaseStore();
  const sk = subjectDedupeKey(subject);

  let agentCase = await store.findOpenBySubject(platform, channelId, userId, sk);
  const now = new Date().toISOString();

  if (agentCase) {
    if (userHint) {
      agentCase = {
        ...agentCase,
        evidence: mergeUserHint(agentCase.evidence, userHint),
        updatedAt: now,
      };
      await store.set({ platform, channelId, userId, caseId: agentCase.caseId }, agentCase);
    }
    await store.setActiveCase(platform, channelId, userId, agentCase.caseId);
    await setSession(platform, channelId, userId, { activeCaseId: agentCase.caseId });
    return agentCase;
  }

  agentCase = {
    caseId: uuidv4(),
    subject,
    status: 'open',
    evidence: userHint ? mergeUserHint(emptyEvidence(), userHint) : emptyEvidence(),
    platform,
    channelId,
    userId,
    createdAt: now,
    updatedAt: now,
  };

  await store.set({ platform, channelId, userId, caseId: agentCase.caseId }, agentCase);
  await store.setActiveCase(platform, channelId, userId, agentCase.caseId);
  await setSession(platform, channelId, userId, { activeCaseId: agentCase.caseId });
  return agentCase;
}

export async function appendCaseHint(
  platform: Platform,
  channelId: string,
  userId: string,
  caseId: string,
  hint: string
): Promise<AgentCase | undefined> {
  const store = getCaseStore();
  const existing = await store.get({ platform, channelId, userId, caseId });
  if (!existing) return undefined;
  const updated: AgentCase = {
    ...existing,
    evidence: mergeUserHint(existing.evidence, hint),
    updatedAt: new Date().toISOString(),
    status:
      existing.status === 'escalated' || existing.status === 'awaiting_user'
        ? 'investigating'
        : existing.status,
  };
  await store.set({ platform, channelId, userId, caseId }, updated);
  return updated;
}

export async function updateCaseStatus(
  platform: Platform,
  channelId: string,
  userId: string,
  caseId: string,
  status: AgentCaseStatus,
  patch?: Partial<Pick<AgentCase, 'activeRunId' | 'lastIncidentId' | 'evidence'>>
): Promise<void> {
  const store = getCaseStore();
  const existing = await store.get({ platform, channelId, userId, caseId });
  if (!existing) return;
  const updated: AgentCase = {
    ...existing,
    ...patch,
    status,
    updatedAt: new Date().toISOString(),
  };
  await store.set({ platform, channelId, userId, caseId }, updated);
}

/** Build operator message from case hints for StartRunRequest. */
export function operatorMessageFromCase(agentCase: AgentCase, fallback?: string): string | undefined {
  const hint = combinedOperatorHints(agentCase.evidence.userHints);
  return hint ?? fallback;
}

export async function bindRunToCase(
  platform: Platform,
  channelId: string,
  userId: string,
  caseId: string,
  incidentId: string,
  runId?: string
): Promise<void> {
  await updateCaseStatus(platform, channelId, userId, caseId, 'investigating', {
    lastIncidentId: incidentId,
    activeRunId: runId,
  });
}

export async function tryResumeCaseWithHint(
  text: string,
  platform: Platform,
  channelId: string,
  userId: string
): Promise<
  | { type: 'parsed'; parsed: import('./parser.js').InvestigateCmd; reply: string }
  | null
> {
  const agentCase = await getActiveCase(platform, channelId, userId);
  if (!agentCase) return null;
  if (!['escalated', 'awaiting_user', 'open'].includes(agentCase.status)) return null;
  if (!shouldResumeCaseWithHint(text)) return null;
  if (
    agentCase.subject.kind !== 'workload' ||
    !agentCase.subject.namespace ||
    !agentCase.subject.resourceName
  ) {
    return null;
  }
  const updated = await appendCaseHint(platform, channelId, userId, agentCase.caseId, text);
  if (!updated) return null;
  const hint = combinedOperatorHints(updated.evidence.userHints);
  return {
    type: 'parsed',
    parsed: {
      type: 'investigate',
      scope: 'workload',
      namespace: updated.subject.namespace!,
      resourceName: updated.subject.resourceName!,
      resourceKind: updated.subject.resourceKind ?? 'Deployment',
      label: updated.subject.label,
      operatorSuggestion: hint,
    },
    reply: `Continuing **${updated.subject.label}** with your update…`,
  };
}

export async function syncCaseFromRunOutcome(opts: {
  platform: Platform;
  channelId: string;
  userId: string;
  caseId: string;
  runStatus: import('../../../shared/src/types.js').RunStatus;
  incidentId: string;
  runId?: string;
}): Promise<void> {
  const statusMap: Partial<Record<import('../../../shared/src/types.js').RunStatus, AgentCaseStatus>> = {
    running: 'investigating',
    awaiting_human: 'awaiting_hil',
    succeeded: 'resolved',
    failed: 'escalated',
    escalated: 'escalated',
    cancelled: 'open',
  };
  const status = statusMap[opts.runStatus] ?? 'investigating';
  await updateCaseStatus(opts.platform, opts.channelId, opts.userId, opts.caseId, status, {
    lastIncidentId: opts.incidentId,
    activeRunId: opts.runId,
  });
}
