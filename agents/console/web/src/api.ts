import type { Approval, AgentHealth, IgnoredResource, OverviewStats, RunListItem, ResourceRunGroup } from './types';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function fetchOverview(): Promise<OverviewStats> {
  return json('/api/overview');
}

export function fetchAgents(): Promise<{ agents: AgentHealth[] }> {
  return json('/api/agents');
}

export function fetchApprovals(): Promise<{ pending: number; approvals: Approval[] }> {
  return json('/api/approvals');
}

export function fetchIgnored(): Promise<{ resources: IgnoredResource[] }> {
  return json('/api/ignored');
}

export function fetchRuns(limit = 50): Promise<{ runs: RunListItem[] }> {
  return json(`/api/runs?limit=${limit}`);
}

export function fetchRunsGrouped(limit = 150): Promise<{ groups: ResourceRunGroup[] }> {
  return json(`/api/runs/grouped?limit=${limit}`);
}

export function exportSkillsMarkdown(limit = 150): Promise<{ markdown: string; count: number }> {
  return json(`/api/skills/export?limit=${limit}`);
}

export function fetchRun(runId: string) {
  return json<Record<string, unknown>>(`/api/runs/${encodeURIComponent(runId)}`);
}

export function fetchRunSummary(runId: string, verbose = true) {
  return json<{ text: string; status: string; incidentId: string }>(
    `/api/runs/${encodeURIComponent(runId)}/summary?verbose=${verbose}`
  );
}

export function approveIncident(incidentId: string) {
  return json(`/api/approvals/${encodeURIComponent(incidentId)}/approve`, { method: 'POST' });
}

export function rejectIncident(incidentId: string, reason?: string) {
  return json(`/api/approvals/${encodeURIComponent(incidentId)}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
}

export function ignoreIncident(incidentId: string, reason?: string) {
  return json(`/api/approvals/${encodeURIComponent(incidentId)}/ignore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
}

export function suggestFix(incidentId: string, suggestion: string, applyNow = false) {
  return json<{ ok?: boolean; summary?: string; error?: string }>(
    `/api/approvals/${encodeURIComponent(incidentId)}/suggest`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suggestion, applyNow }),
    }
  );
}

export function unignoreResource(key: string) {
  return json(`/api/ignored/${encodeURIComponent(key)}`, { method: 'DELETE' });
}

export function cancelRun(runId: string) {
  return json<{ ok: boolean; runId: string; status: string }>(
    `/api/runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST' }
  );
}

export function fetchCodingJob(jobId: string) {
  return json<Record<string, unknown>>(`/api/coding-agent/jobs/${encodeURIComponent(jobId)}`);
}

export function cancelCodingJob(jobId: string) {
  return json(`/api/coding-agent/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
  });
}

export interface ChatTurn {
  role: 'user' | 'assistant' | 'status';
  content: string;
  at: string;
  incidentId?: string;
  runId?: string;
  quickActions?: Array<{ id: string; label: string }>;
  updateKind?: string;
}

export interface ChatSessionSummary {
  channelId: string;
  sessionLabel?: string;
  preview?: string;
  updatedAt: string;
  messageCount: number;
}

export interface ChatResponse {
  reply: string;
  incidentId?: string;
  executed: boolean;
  commandType?: string;
  transcript?: ChatTurn[];
  waitingForRun?: boolean;
}

export function fetchChatSession(channelId: string): Promise<{
  transcript: ChatTurn[];
  waitingForRun: boolean;
  lastIncidentId?: string;
  lastRunId?: string;
}> {
  return json(
    `/api/chat/session?channelId=${encodeURIComponent(channelId)}&userId=${CONSOLE_USER}`
  );
}

const CONSOLE_USER = 'console';

export function listChatSessions(): Promise<{ sessions: ChatSessionSummary[] }> {
  return json(`/api/chat/sessions?userId=${CONSOLE_USER}`);
}

export function createChatSession(label?: string): Promise<{ channelId: string; sessionLabel: string }> {
  return json('/api/chat/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: CONSOLE_USER, label }),
  });
}

export function resetChatSession(channelId: string): Promise<{ ok: boolean; transcript: ChatTurn[] }> {
  return json(`/api/chat/sessions/${encodeURIComponent(channelId)}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: CONSOLE_USER }),
  });
}

export function sendChatMessage(message: string, channelId: string): Promise<ChatResponse> {
  return json('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, channelId, userId: CONSOLE_USER }),
  });
}

export function fetchChatTranscript(channelId: string): Promise<{ transcript: ChatTurn[] }> {
  return json(
    `/api/chat/transcript?channelId=${encodeURIComponent(channelId)}&userId=${CONSOLE_USER}`
  );
}
