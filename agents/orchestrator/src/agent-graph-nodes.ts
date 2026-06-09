/**
 * LangGraph ReAct nodes for agentic investigation (graph-driven, no while-loops).
 */

import type {
  DiagnosisContext,
  RunStatus,
  SpecialistDiagnostic,
  StartRunRequest,
} from '../../../shared/src/types.js';
import type { AgentStepRecord } from '../../../shared/src/agent-read-tools.js';
import {
  agentEvidenceToDiagnosisContext,
  buildAgentGoal,
  mergeAgentEvidence,
} from '../../../shared/src/agent-evidence.js';
import {
  enrichFactsWithPrimaryFailure,
  extractPrimaryFailure,
  formatPrimaryFailureMessage,
} from '../../../shared/src/investigation-diagnosis.js';
import { resolveRunAgentMode } from '../../../shared/src/agent-mode.js';
import { log } from '../../../shared/src/http.js';
import {
  callAgentNextRead,
  callAgentReflect,
  executeAgentReadTool,
  type AgentInvestigateSlice,
} from './agent-react-tools.js';

const AGENT = 'orchestrator-agent-react';

export type { AgentInvestigateSlice };

function maxAgentTurns(request: StartRunRequest): number {
  const mode = resolveRunAgentMode(request);
  return Math.min(mode.maxAgentTurns, mode.maxReadTools);
}

export function isAgenticDiagnose(request: StartRunRequest, mode: StartRunRequest['mode']): boolean {
  return mode === 'diagnose' && resolveRunAgentMode(request).investigateGatherMode === 'tool_loop';
}

/** LLM decides next read tool or stop (ReAct "think" node). */
export async function agentDecideNode(
  state: AgentInvestigateSlice,
  notify: {
    progress: (summary: string) => Promise<void>;
    user: (message: string) => Promise<void>;
  }
): Promise<Partial<AgentInvestigateSlice>> {
  const turns = state.agentTurns ?? 0;
  const maxTurns = maxAgentTurns(state.request);

  if (turns >= maxTurns) {
    log('warn', AGENT, 'Agent ReAct turn cap reached', {
      incidentId: state.incidentId,
      turns,
    });
    return {
      status: 'escalated' as RunStatus,
      lastError: 'Agent investigation reached maximum steps without resolution',
      pendingReadTool: undefined,
    };
  }

  const goal =
    state.agentGoal ??
    buildAgentGoal(state.request, state.agentFocusGoal);

  const next = await callAgentNextRead({
    incidentId: state.incidentId,
    goal,
    namespace: state.namespace,
    resourceName: state.resourceName,
    resourceKind: state.resourceKind,
    evidence: state.agentEvidence ?? {},
    priorSteps: state.agentSteps ?? [],
    fetchedTools: state.agentFetchedTools ?? [],
    userHints: state.request.userHints,
    maxSteps: maxTurns,
  });

  if (next.summary) {
    await notify.progress(next.summary);
  }

  if (next.done) {
    if (next.reasoning === 'llm_ask_user' || next.reasoning === 'heuristic_image_pull') {
      await notify.user(`🙋 ${next.summary ?? 'I need more information to continue.'}`);
      return {
        status: 'escalated' as RunStatus,
        lastError: next.summary ?? 'awaiting_user_input',
        pendingReadTool: undefined,
        agentGoal: goal,
        agentInvestigateComplete: true,
      };
    }
    if (next.reasoning === 'heuristic_terminal_failure') {
      await notify.user(`🔍 ${next.summary ?? 'Identified workload failure — planning fix.'}`);
      return {
        pendingReadTool: undefined,
        agentGoal: goal,
        agentInvestigateComplete: true,
      };
    }
    if (next.reasoning === 'llm_escalate') {
      await notify.user(`⚠️ ${next.summary ?? 'Escalating to human review.'}`);
      return {
        status: 'escalated' as RunStatus,
        lastError: next.summary,
        pendingReadTool: undefined,
      };
    }
    return {
      pendingReadTool: undefined,
      agentGoal: goal,
      agentInvestigateComplete: true,
    };
  }

  if (!next.toolCall?.name) {
    return {
      status: 'failed' as RunStatus,
      lastError: 'Agent returned no tool and no completion',
      pendingReadTool: undefined,
    };
  }

  return {
    pendingReadTool: next.toolCall,
    agentGoal: goal,
    agentInvestigateComplete: false,
  };
}

/** Execute one read tool (ReAct "act" node for reads). */
export async function agentReadNode(
  state: AgentInvestigateSlice,
  notify: { progress: (summary: string) => Promise<void>; user?: (message: string) => Promise<void> }
): Promise<Partial<AgentInvestigateSlice>> {
  const tool = state.pendingReadTool;
  if (!tool?.name) {
    return { status: 'failed' as RunStatus, lastError: 'No pending read tool' };
  }

  const toolName = tool.name;
  if ((state.agentFetchedTools ?? []).includes(toolName)) {
    return {
      pendingReadTool: undefined,
      agentTurns: (state.agentTurns ?? 0) + 1,
    };
  }

  let stepResult: { summary: string; data: Partial<DiagnosisContext> };
  try {
    stepResult = await executeAgentReadTool({
      request: state.request,
      runId: state.runId,
      toolCall: tool,
    });
  } catch (err) {
    log('warn', AGENT, 'Read tool failed', { tool: toolName, error: String(err) });
    return {
      pendingReadTool: undefined,
      agentTurns: (state.agentTurns ?? 0) + 1,
      lastError: String(err),
    };
  }

  await notify.progress(stepResult.summary);

  const enrichedData = enrichFactsWithPrimaryFailure(stepResult.data);
  const primary = extractPrimaryFailure(enrichedData);
  if (primary && notify.user && !(state.agentEvidence?.detectedErrorSignature)) {
    await notify.user(formatPrimaryFailureMessage(primary));
  }

  const merged = mergeAgentEvidence(state.agentEvidence ?? {}, enrichedData);
  const step: AgentStepRecord = {
    tool: toolName,
    summary: stepResult.summary,
    at: new Date().toISOString(),
  };

  return {
    agentEvidence: merged,
    agentSteps: [...(state.agentSteps ?? []), step],
    agentFetchedTools: [...(state.agentFetchedTools ?? []), toolName],
    agentTurns: (state.agentTurns ?? 0) + 1,
    pendingReadTool: undefined,
  };
}

/** Merge agent evidence into factsRaw for sanitize → plan. */
export async function agentFinalizeNode(
  state: AgentInvestigateSlice,
  deriveSpecialists: (facts: DiagnosisContext) => Promise<SpecialistDiagnostic[]>,
  batchFallback?: (request: StartRunRequest) => Promise<DiagnosisContext>
): Promise<Partial<AgentInvestigateSlice>> {
  const evidence = state.agentEvidence ?? {};
  const steps = state.agentSteps ?? [];

  let facts = enrichFactsWithPrimaryFailure(
    agentEvidenceToDiagnosisContext(state.request, evidence, steps)
  );
  const sparse =
    !facts.recentEvents?.length &&
    !facts.currentLogs?.trim() &&
    !facts.containerStatuses?.length;

  if (sparse && batchFallback) {
    log('warn', AGENT, 'ReAct evidence sparse — batch fallback', {
      incidentId: state.incidentId,
      steps: steps.length,
    });
    facts = await batchFallback(state.request);
  }

  const specialists =
    facts.specialistDiagnostics && facts.specialistDiagnostics.length > 0
      ? facts.specialistDiagnostics
      : await deriveSpecialists(facts);
  facts = { ...facts, specialistDiagnostics: specialists };

  return {
    factsRaw: facts,
    iteration: state.iteration + 1,
    agentInvestigateComplete: false,
    pendingReadTool: undefined,
  };
}

export async function applyAgentReflect(
  state: AgentInvestigateSlice,
  verify: { healthy: boolean; message?: string },
  notify: {
    progress: (summary: string) => Promise<void>;
    user: (message: string) => Promise<void>;
  }
): Promise<Partial<AgentInvestigateSlice>> {
  const mode = resolveRunAgentMode(state.request);
  if (mode.graphMode !== 'react' || state.mode !== 'diagnose') {
    return {};
  }

  const reflect = await callAgentReflect({
    incidentId: state.incidentId,
    verifyStatus: verify.healthy ? 'healthy' : 'degraded',
    verifyMessage: verify.message,
    actionHistory: state.actionHistory ?? [],
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    evidence: state.agentEvidence,
    goal: state.agentGoal ?? buildAgentGoal(state.request),
  });

  if (reflect.outcome === 'succeeded') {
    return { status: 'succeeded' as RunStatus };
  }
  if (reflect.outcome === 'escalate') {
    await notify.user(reflect.operatorMessage);
    return { status: 'escalated' as RunStatus, lastError: reflect.operatorMessage };
  }
  if (reflect.outcome === 'ask_user') {
    await notify.user(`🙋 ${reflect.operatorMessage}`);
    return { status: 'escalated' as RunStatus, lastError: reflect.operatorMessage };
  }

  await notify.progress(reflect.operatorMessage);
  return {
    agentFocusGoal: reflect.focusGoal ?? 'verify_failed_retry',
    agentInvestigateComplete: false,
    pendingReadTool: undefined,
  };
}
