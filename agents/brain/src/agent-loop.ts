/**
 * AGENT-4 — Agent loop types + LLM-first next-read / reflect entrypoints.
 */

import type { DiagnosisContext } from '../../../shared/src/types.js';
import type { AgentReadToolCall, AgentStepRecord } from '../../../shared/src/agent-read-tools.js';
import { resolveAgentMode } from '../../../shared/src/agent-mode.js';
import { agentNextReadLlm, agentReflectLlm } from './agent-next-read-llm.js';
import { heuristicAgentNextRead } from './agent-loop-heuristics.js';

export type { AgentStepRecord };

export interface AgentNextReadRequest {
  incidentId: string;
  goal: string;
  namespace: string;
  resourceName: string;
  resourceKind?: import('../../../shared/src/types.js').ResourceKind;
  evidence: Partial<DiagnosisContext>;
  priorSteps: AgentStepRecord[];
  fetchedTools: string[];
  userHints?: string[];
  maxSteps?: number;
}

export interface AgentNextReadResponse {
  done: boolean;
  toolCall?: AgentReadToolCall;
  summary?: string;
  reasoning?: string;
}

export async function agentNextRead(req: AgentNextReadRequest): Promise<AgentNextReadResponse> {
  const mode = resolveAgentMode();
  const useLlm = mode.llmToolSelect;

  if (useLlm) {
    return agentNextReadLlm(req);
  }
  return heuristicAgentNextRead(req);
}

export interface AgentReflectRequest {
  incidentId: string;
  verifyStatus: 'healthy' | 'degraded' | 'unknown';
  verifyMessage?: string;
  actionHistory: import('../../../shared/src/types.js').ActionRecord[];
  iteration: number;
  maxIterations: number;
  evidence?: Partial<DiagnosisContext>;
  goal?: string;
}

export type ReflectOutcome = 'succeeded' | 'retry' | 'escalate' | 'ask_user';

export interface AgentReflectResponse {
  outcome: ReflectOutcome;
  operatorMessage: string;
  focusGoal?: string;
}

export async function agentReflect(req: AgentReflectRequest): Promise<AgentReflectResponse> {
  const mode = resolveAgentMode();
  const useLlm = mode.llmReflect;

  if (useLlm) {
    return agentReflectLlm(req);
  }

  if (req.verifyStatus === 'healthy') {
    return { outcome: 'succeeded', operatorMessage: 'Workload recovered after remediation.' };
  }
  if (req.iteration >= req.maxIterations) {
    return {
      outcome: 'escalate',
      operatorMessage: req.verifyMessage ?? 'Remediation did not restore health within allowed attempts.',
    };
  }
  const lastFail = [...req.actionHistory].reverse().find((a) => !a.success);
  return {
    outcome: 'retry',
    operatorMessage: lastFail?.summary ?? req.verifyMessage ?? 'Verify failed — retrying investigation.',
    focusGoal: 'verify_failed_retry',
  };
}
