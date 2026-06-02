/**
 * Chat session state — transcript, topic, CI/deploy follow-ups.
 * Backed by memory or Redis via session-store.ts.
 */

import type { IncidentMode, ResourceKind } from '../../../shared/src/types.js';
import { getSessionStore, type WebSessionSummary } from './session-store.js';
import { v4 as uuidv4 } from 'uuid';

/** UX-13 — one turn in rolling chat transcript. */
export interface ChatTurn {
  role: 'user' | 'assistant' | 'status';
  content: string;
  at: string;
  incidentId?: string;
  runId?: string;
}

export interface StatusSubject {
  resourceName: string;
  resourceKind: ResourceKind;
  namespace?: string;
}

export type ActiveTopicKind = 'workload-status' | 'investigate' | 'deploy' | 'ci' | 'get';

export interface ActiveTopic {
  kind: ActiveTopicKind;
  resourceName?: string;
  resourceKind?: ResourceKind;
  namespace?: string;
  githubRepo?: string;
  label?: string;
  updatedAt: string;
}

export interface PendingClarification {
  kind: 'workload-status' | 'investigate' | 'deploy';
  awaiting: 'namespace' | 'workload' | 'githubRepo';
  resourceName?: string;
  resourceKind?: ResourceKind;
  namespace?: string;
  prompt: string;
  askedAt: string;
}

export interface ChatSession {
  activeRunId?: string;
  pendingQuestion?: string;
  pendingClarification?: PendingClarification;
  lastIncidentId?: string;
  lastRunId?: string;
  lastMode?: IncidentMode;
  lastRepo?: string;
  lastWorkflowRunId?: number;
  lastPrUrl?: string;
  lastDeployDraft?: import('./parser.js').DeployCmd;
  lastStatusSubject?: StatusSubject;
  activeTopic?: ActiveTopic;
  transcript?: ChatTurn[];
  /** Console: orchestrator run still in progress — UI should poll for updates. */
  waitingForRun?: boolean;
  sessionLabel?: string;
  preview?: string;
  updatedAt: string;
}

function sessionKey(platform: string, channelId: string, userId: string) {
  return { platform, channelId, userId };
}

export async function getSession(
  platform: string,
  channelId: string,
  userId: string
): Promise<ChatSession | undefined> {
  return getSessionStore().get(sessionKey(platform, channelId, userId));
}

export async function setSession(
  platform: string,
  channelId: string,
  userId: string,
  patch: Partial<ChatSession>
): Promise<ChatSession> {
  const k = sessionKey(platform, channelId, userId);
  const existing = (await getSessionStore().get(k)) ?? { updatedAt: new Date().toISOString() };
  const lastUser = patch.transcript
    ? [...patch.transcript].reverse().find((t) => t.role === 'user')
    : undefined;
  const next: ChatSession = {
    ...existing,
    ...patch,
    preview: patch.preview ?? lastUser?.content.slice(0, 120) ?? existing.preview,
    updatedAt: new Date().toISOString(),
  };
  await getSessionStore().set(k, next);
  return next;
}

export async function deleteSession(
  platform: string,
  channelId: string,
  userId: string
): Promise<void> {
  await getSessionStore().delete(sessionKey(platform, channelId, userId));
}

export async function listWebChatSessions(userId: string): Promise<WebSessionSummary[]> {
  return getSessionStore().listWebSessions(userId);
}

export async function createWebChatSession(userId: string, label?: string): Promise<{
  channelId: string;
  sessionLabel: string;
}> {
  const channelId = uuidv4();
  const sessionLabel = label ?? `Chat ${new Date().toLocaleString()}`;
  await setSession('web', channelId, userId, {
    sessionLabel,
    transcript: [],
    preview: undefined,
  });
  return { channelId, sessionLabel };
}

/** Clear transcript/topic but keep the same channel id. */
export async function resetWebChatSession(channelId: string, userId: string): Promise<void> {
  const existing = await getSession('web', channelId, userId);
  await setSession('web', channelId, userId, {
    sessionLabel: existing?.sessionLabel ?? `Chat ${new Date().toLocaleString()}`,
    transcript: [],
    preview: undefined,
    activeTopic: undefined,
    pendingClarification: undefined,
    pendingQuestion: undefined,
    lastStatusSubject: undefined,
  });
}

export async function linkRunToSession(
  platform: string,
  channelId: string,
  userId: string,
  incidentId: string
): Promise<void> {
  const ORCHESTRATOR_URL = process.env['ORCHESTRATOR_URL'] ?? 'http://orchestrator-agent:8080';
  try {
    const res = await fetch(
      `${ORCHESTRATOR_URL}/runs?incidentId=${encodeURIComponent(incidentId)}&limit=1`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return;
    const data = (await res.json()) as { runs?: Array<{ runId: string }> };
    const runId = data.runs?.[0]?.runId;
    if (runId) {
      await setSession(platform, channelId, userId, { lastRunId: runId, lastIncidentId: incidentId });
    }
  } catch {
    // best-effort
  }
}
