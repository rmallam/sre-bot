/**
 * AGENT-5 — Runtime mode resolution: classic vs agentic dual pipeline.
 */

export type SreAgentMode = 'classic' | 'agentic';
export type CommanderRoutingMode = 'hybrid' | 'llm_only' | 'regex_only';
export type InvestigateGatherMode = 'batch' | 'tool_loop';
export type OrchestratorGraphMode = 'fixed' | 'react';
export type BrainPlanMode = 'single_shot' | 'per_turn';

export interface ResolvedAgentMode {
  agentMode: SreAgentMode;
  routingMode: CommanderRoutingMode;
  investigateGatherMode: InvestigateGatherMode;
  graphMode: OrchestratorGraphMode;
  brainPlanMode: BrainPlanMode;
  useCapabilityPlanner: boolean;
  llmToolSelect: boolean;
  llmReflect: boolean;
  maxAgentTurns: number;
  maxReadTools: number;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  return v.toLowerCase() === 'true' || v === '1';
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Treat unset or blank compose env entries as undefined (so agentic defaults apply). */
function envOptional(key: string): string | undefined {
  const v = process.env[key];
  if (v == null || v.trim() === '') return undefined;
  return v;
}

export function resolveAgentMode(overrides?: {
  agentMode?: SreAgentMode;
  routingMode?: CommanderRoutingMode;
  investigateGatherMode?: InvestigateGatherMode;
  graphMode?: OrchestratorGraphMode;
}): ResolvedAgentMode {
  const master = (overrides?.agentMode ??
    envOptional('SRE_AGENT_MODE') ??
    'classic') as SreAgentMode;
  const agentic = master === 'agentic';

  const routingMode = (overrides?.routingMode ??
    envOptional('COMMANDER_ROUTING_MODE') ??
    (agentic ? 'llm_only' : 'hybrid')) as CommanderRoutingMode;

  const investigateGatherMode = (overrides?.investigateGatherMode ??
    envOptional('INVESTIGATE_GATHER_MODE') ??
    (agentic ? 'tool_loop' : 'batch')) as InvestigateGatherMode;

  const graphMode = (overrides?.graphMode ??
    envOptional('ORCHESTRATOR_GRAPH_MODE') ??
    (agentic ? 'react' : 'fixed')) as OrchestratorGraphMode;

  const brainPlanMode = (envOptional('BRAIN_PLAN_MODE') ??
    (agentic ? 'per_turn' : 'single_shot')) as BrainPlanMode;

  const capabilityEnv = envOptional('USE_CAPABILITY_PLANNER');
  const useCapabilityPlanner =
    capabilityEnv != null ? envBool('USE_CAPABILITY_PLANNER', false) : agentic;

  const toolSelectEnv = envOptional('AGENTIC_LLM_TOOL_SELECT');
  const reflectEnv = envOptional('AGENTIC_LLM_REFLECT');

  return {
    agentMode: master,
    routingMode,
    investigateGatherMode,
    graphMode,
    brainPlanMode,
    useCapabilityPlanner,
    llmToolSelect: toolSelectEnv != null ? envBool('AGENTIC_LLM_TOOL_SELECT', false) : agentic,
    llmReflect: reflectEnv != null ? envBool('AGENTIC_LLM_REFLECT', false) : agentic,
    maxAgentTurns: envInt('AGENTIC_MAX_TURNS', 12),
    maxReadTools: envInt('AGENTIC_MAX_READ_TOOLS', 20),
  };
}

export function agentModeHealthPayload(): Record<string, unknown> {
  const m = resolveAgentMode();
  return {
    agentMode: m.agentMode,
    routingMode: m.routingMode,
    investigateGatherMode: m.investigateGatherMode,
    graphMode: m.graphMode,
    brainPlanMode: m.brainPlanMode,
    useCapabilityPlanner: m.useCapabilityPlanner,
    llmToolSelect: m.llmToolSelect,
    llmReflect: m.llmReflect,
  };
}

/** Resolve mode for a run: request override > channel pref > env default. */
export function resolveRunAgentMode(request?: {
  agentMode?: SreAgentMode;
}): ResolvedAgentMode {
  return resolveAgentMode(
    request?.agentMode ? { agentMode: request.agentMode } : undefined
  );
}
