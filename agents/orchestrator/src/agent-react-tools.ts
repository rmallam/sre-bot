/**
 * HTTP helpers for agentic ReAct loop (brain decides, investigator executes).
 */

import type { DiagnosisContext, StartRunRequest } from '../../../shared/src/types.js';
import type { AgentReadToolCall, AgentStepRecord } from '../../../shared/src/agent-read-tools.js';
import { mergeAgentEvidence } from '../../../shared/src/agent-evidence.js';
import { sanitizeFacts } from './tools.js';
import { internalAuthHeaders } from '../../../shared/src/internal-auth.js';

const INVESTIGATOR_URL = process.env['INVESTIGATOR_URL'] ?? 'http://investigator-agent:8080';
const BRAIN_URL = process.env['BRAIN_URL'] ?? 'http://brain-agent:8080';

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`POST ${url} failed ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export interface AgentInvestigateSlice {
  runId: string;
  incidentId: string;
  request: StartRunRequest;
  mode: StartRunRequest['mode'];
  namespace: string;
  resourceName: string;
  resourceKind: StartRunRequest['resourceKind'];
  iteration: number;
  maxIterations: number;
  status: import('../../../shared/src/types.js').RunStatus;
  lastError?: string;
  actionHistory: import('../../../shared/src/types.js').ActionRecord[];
  agentEvidence?: Partial<DiagnosisContext>;
  agentSteps?: AgentStepRecord[];
  agentFetchedTools?: string[];
  agentTurns?: number;
  pendingReadTool?: AgentReadToolCall;
  agentGoal?: string;
  agentFocusGoal?: string;
  agentInvestigateComplete?: boolean;
  factsRaw?: DiagnosisContext;
}

export async function callAgentNextRead(opts: {
  incidentId: string;
  goal: string;
  namespace: string;
  resourceName: string;
  resourceKind?: StartRunRequest['resourceKind'];
  evidence: Partial<DiagnosisContext>;
  priorSteps: AgentStepRecord[];
  fetchedTools: string[];
  userHints?: string[];
  maxSteps: number;
}): Promise<{
  done: boolean;
  toolCall?: AgentReadToolCall;
  summary?: string;
  reasoning?: string;
}> {
  return postJson(`${BRAIN_URL}/agent-next-read`, opts);
}

export async function callAgentReflect(opts: {
  incidentId: string;
  verifyStatus: 'healthy' | 'degraded' | 'unknown';
  verifyMessage?: string;
  actionHistory: import('../../../shared/src/types.js').ActionRecord[];
  iteration: number;
  maxIterations: number;
  evidence?: Partial<DiagnosisContext>;
  goal?: string;
}): Promise<{
  outcome: 'succeeded' | 'retry' | 'escalate' | 'ask_user';
  operatorMessage: string;
  focusGoal?: string;
}> {
  return postJson(`${BRAIN_URL}/agent-reflect`, opts);
}

export async function executeAgentReadTool(opts: {
  request: StartRunRequest;
  runId: string;
  toolCall: AgentReadToolCall;
}): Promise<{ summary: string; data: Partial<DiagnosisContext> }> {
  const { request, runId, toolCall } = opts;
  const stepResult = await postJson<{ summary: string; data: Partial<DiagnosisContext> }>(
    `${INVESTIGATOR_URL}/agent-step`,
    {
      incidentId: request.incidentId,
      runId,
      caseId: request.caseId,
      namespace: request.namespace,
      resourceName: request.resourceName,
      resourceKind: request.resourceKind,
      toolCall,
    }
  );

  const { sanitized } = await sanitizeFacts({
    incidentId: request.incidentId,
    triggeredBy: request.triggeredBy,
    triggeredAt: request.triggeredAt,
    mode: request.mode,
    namespace: request.namespace,
    resourceName: request.resourceName,
    resourceKind: request.resourceKind,
    recentEvents: [],
    currentLogs: '',
    previousLogs: '',
    podSpec: {},
    containerStatuses: [],
    resourceLimits: {},
    ...(stepResult.data as Partial<DiagnosisContext>),
  });

  return {
    summary: stepResult.summary,
    data: mergeAgentEvidence({}, sanitized ?? stepResult.data),
  };
}
