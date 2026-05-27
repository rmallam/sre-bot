/**
 * LangGraph orchestration — observe → sanitize → plan → authorize → policy → act → verify loop.
 */

import { Annotation, END, START, StateGraph, MemorySaver } from '@langchain/langgraph';
import { v4 as uuidv4 } from 'uuid';
import type {
  ActionRecord,
  AutonomyMode,
  DiagnosisContext,
  RemediateCommand,
  RemediationPlan,
  RunStatus,
  SanitizedFacts,
  SecurityFinding,
  StartRunRequest,
  VerifyStatus,
} from '../../../shared/src/types.js';
import { evaluatePolicyGate, getAutonomyMode } from '../../../shared/src/policy.js';
import { evaluateCombinedPolicy, evaluateCompiledToolPolicy } from '../../../shared/src/tool-policy.js';
import { log } from '../../../shared/src/http.js';
import { emitSecurityAudit } from '../../../shared/src/audit-siem.js';
import {
  gatherFacts,
  sanitizeFacts,
  authorizePlan,
  callPlanLlm,
  callCapabilityPlan,
  executeAction,
  buildRuntimeContext,
  compileAndValidatePlan,
  compileFromToolCalls,
  verifyWorkload,
  notifyUser,
  requestHilApproval,
  USE_CAPABILITY_PLANNER,
  type OrchestratorRunContext,
} from './tools.js';
import {
  initRun,
  setRunStatus,
  getRun,
  setRunCompiled,
  setCapabilityPlan,
} from './run-store.js';
import { buildDeployPlan } from './deploy-plan.js';

const AGENT = 'orchestrator-agent';
const MAX_ITERATIONS = parseInt(process.env['AUTONOMY_MAX_ITERATIONS'] ?? '5', 10);

const RunAnnotation = Annotation.Root({
  runId: Annotation<string>,
  incidentId: Annotation<string>,
  request: Annotation<StartRunRequest>,
  mode: Annotation<StartRunRequest['mode']>,
  namespace: Annotation<string>,
  resourceName: Annotation<string>,
  resourceKind: Annotation<StartRunRequest['resourceKind']>,
  factsRaw: Annotation<DiagnosisContext | undefined>,
  factsSanitized: Annotation<SanitizedFacts | undefined>,
  securityFindings: Annotation<SecurityFinding[]>({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
  actionHistory: Annotation<ActionRecord[]>({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
  iteration: Annotation<number>,
  maxIterations: Annotation<number>,
  pendingPlan: Annotation<RemediationPlan | undefined>,
  authorizeForceHil: Annotation<boolean>,
  autonomyMode: Annotation<AutonomyMode>,
  status: Annotation<RunStatus>,
  awaitingHuman: Annotation<boolean>,
  lastError: Annotation<string | undefined>,
});

type GraphState = typeof RunAnnotation.State;

function runCtx(state: GraphState): OrchestratorRunContext {
  return {
    runId: state.runId,
    incidentId: state.incidentId,
    request: state.request,
    namespace: state.namespace,
    resourceName: state.resourceName,
    resourceKind: state.resourceKind,
    mode: state.mode,
    pendingPlan: state.pendingPlan,
  };
}

function priorSummary(history: ActionRecord[]): string | undefined {
  if (history.length === 0) return undefined;
  return history.map((h) => `${h.action}:${h.success ? 'ok' : 'fail'}`).join('; ');
}

async function observeNode(state: GraphState): Promise<Partial<GraphState>> {
  const facts = await gatherFacts(state.request);
  return { factsRaw: facts, iteration: state.iteration + 1 };
}

async function sanitizeNode(state: GraphState): Promise<Partial<GraphState>> {
  if (!state.factsRaw) return { status: 'failed', lastError: 'No facts' };
  const { sanitized, findings, blocked } = await sanitizeFacts(state.factsRaw);
  if (blocked) {
    await emitSecurityAudit({
      eventType: 'sanitize_blocked',
      incidentId: state.incidentId,
      runId: state.runId,
      message: 'Blocked',
      timestamp: new Date().toISOString(),
    });
    return { status: 'escalated', securityFindings: findings, lastError: 'Sensitive data blocked' };
  }
  return { factsSanitized: sanitized, securityFindings: findings };
}

async function planNode(state: GraphState): Promise<Partial<GraphState>> {
  if (!state.factsSanitized) return { status: 'failed', lastError: 'No sanitized facts' };
  const ctx: DiagnosisContext = {
    ...state.factsSanitized,
    priorActionSummary: priorSummary(state.actionHistory),
    githubRepo: state.factsSanitized.githubRepo ?? state.request.githubRepo,
  };

  if (USE_CAPABILITY_PLANNER && state.mode === 'diagnose') {
    const cap = await callCapabilityPlan(ctx);
    const runtimeCtx = {
      incidentId: state.incidentId,
      runId: state.runId,
      mode: state.mode,
      namespace: state.namespace,
      resourceName: state.resourceName,
      resourceKind: state.resourceKind,
      request: state.request,
      plan: cap.remediationPlan,
    };
    const compiled = compileFromToolCalls(cap.toolCalls, runtimeCtx);
    await setCapabilityPlan(state.runId, cap.toolCalls, compiled);
    return { pendingPlan: cap.remediationPlan };
  }

  const plan =
    state.mode === 'pre-deploy'
      ? await buildDeployPlan(ctx, state.request)
      : await callPlanLlm(ctx, state.actionHistory);

  return { pendingPlan: plan };
}

async function authorizeNode(state: GraphState): Promise<Partial<GraphState>> {
  if (!state.pendingPlan) return { status: 'failed' };
  const auth = await authorizePlan(
    state.pendingPlan,
    state.namespace,
    state.resourceName,
    state.resourceKind,
    state.mode,
    state.incidentId,
    state.request.githubRepo
  );
  if (!auth.allowed) {
    return { status: 'escalated', securityFindings: auth.findings, lastError: auth.reason, authorizeForceHil: true };
  }
  return { authorizeForceHil: auth.forceHil, securityFindings: auth.findings };
}

async function policyNode(state: GraphState): Promise<Partial<GraphState>> {
  if (!state.pendingPlan) return { status: 'failed' };
  const runtimeCtx = buildRuntimeContext(runCtx(state));
  const stored = await getRun(state.runId);
  const compiled = stored?.compiled ?? compileAndValidatePlan(runtimeCtx);

  if (!compiled.validation.ok) {
    return {
      status: 'failed',
      lastError: `Compiler validation failed: ${compiled.validation.errors.join('; ')}`,
    };
  }

  await setRunCompiled(state.runId, compiled);

  const planGate = evaluatePolicyGate(state.pendingPlan, state.namespace, state.authorizeForceHil);
  const toolGate = evaluateCompiledToolPolicy(compiled, state.namespace, state.authorizeForceHil);
  const gate = evaluateCombinedPolicy(planGate, toolGate);

  if (!gate.autoExecute) {
    await requestHilApproval(runCtx(state), state.pendingPlan, state.iteration, state.maxIterations);
    return { status: 'awaiting_human', awaitingHuman: true };
  }
  return { awaitingHuman: false };
}

async function actNode(state: GraphState): Promise<Partial<GraphState>> {
  if (!state.pendingPlan) return { status: 'failed' };
  const result = await executeAction(runCtx(state), {
    iteration: state.iteration,
    maxIterations: state.maxIterations,
  });
  if (result.paused) {
    return { status: 'awaiting_human', awaitingHuman: true };
  }
  const record: ActionRecord = {
    action: state.pendingPlan.action,
    success: result.success,
    summary: result.error ?? result.summary ?? 'executed',
    commitUrls: result.commitUrls,
    toolTranscript: result.transcript,
    verifyStatus:
      result.verifyHealthy === true ? 'healthy' : result.verifyHealthy === false ? 'degraded' : undefined,
    at: new Date().toISOString(),
  };
  return { actionHistory: [record] };
}

async function verifyNode(state: GraphState): Promise<Partial<GraphState>> {
  const stored = await getRun(state.runId);
  const fromTranscript = stored?.transcript
    .filter((t) => t.tool === 'investigator.verify_health')
    .pop();

  const verify =
    fromTranscript !== undefined
      ? { healthy: fromTranscript.success, message: fromTranscript.summary ?? fromTranscript.error ?? '' }
      : await verifyWorkload(state.namespace, state.resourceName, state.incidentId);

  const history = [...state.actionHistory];
  if (history.length > 0) {
    const last = history[history.length - 1]!;
    history[history.length - 1] = { ...last, verifyStatus: verify.healthy ? 'healthy' : 'degraded' };
  }

  if (verify.healthy) {
    await notifyUser(runCtx(state), `✅ ${state.resourceName} healthy (run ${state.runId})`);
    return { status: 'succeeded', actionHistory: history };
  }

  if (state.iteration >= state.maxIterations) {
    await notifyUser(runCtx(state), `⚠️ Escalated after ${state.iteration} iterations`);
    return { status: 'escalated', actionHistory: history, lastError: verify.message };
  }

  return { actionHistory: history, pendingPlan: undefined };
}

function routeAfterSanitize(state: GraphState): string {
  return state.status === 'escalated' ? END : 'plan';
}

function routeAfterPolicy(state: GraphState): string {
  if (state.status === 'awaiting_human' || state.status === 'failed' || state.status === 'escalated') return END;
  return 'act';
}

function routeAfterAct(state: GraphState): string {
  if (state.status === 'awaiting_human') return END;
  return 'verify';
}

function routeAfterVerify(state: GraphState): string {
  if (state.status === 'succeeded' || state.status === 'escalated') return END;
  return 'observe';
}

const checkpointer = new MemorySaver();

export function buildGraph() {
  return new StateGraph(RunAnnotation)
    .addNode('observe', observeNode)
    .addNode('sanitize', sanitizeNode)
    .addNode('plan', planNode)
    .addNode('authorize', authorizeNode)
    .addNode('policy', policyNode)
    .addNode('act', actNode)
    .addNode('verify', verifyNode)
    .addEdge(START, 'observe')
    .addEdge('observe', 'sanitize')
    .addConditionalEdges('sanitize', routeAfterSanitize, { plan: 'plan', [END]: END })
    .addEdge('plan', 'authorize')
    .addEdge('authorize', 'policy')
    .addConditionalEdges('policy', routeAfterPolicy, { act: 'act', [END]: END })
    .addConditionalEdges('act', routeAfterAct, { verify: 'verify', [END]: END })
    .addConditionalEdges('verify', routeAfterVerify, { observe: 'observe', [END]: END })
    .compile({ checkpointer });
}

export async function startRun(request: StartRunRequest): Promise<{ runId: string; status: RunStatus }> {
  const runId = uuidv4();
  const initial: GraphState = {
    runId,
    incidentId: request.incidentId,
    request,
    mode: request.mode,
    namespace: request.namespace,
    resourceName: request.resourceName,
    resourceKind: request.resourceKind,
    factsRaw: undefined,
    factsSanitized: undefined,
    securityFindings: [],
    actionHistory: [],
    iteration: 0,
    maxIterations: MAX_ITERATIONS,
    pendingPlan: undefined,
    authorizeForceHil: false,
    autonomyMode: getAutonomyMode(),
    status: 'running',
    awaitingHuman: false,
    lastError: undefined,
  };

  log('info', AGENT, 'Starting run', { runId, incidentId: request.incidentId });
  await initRun(runId, request.incidentId, { mode: request.mode });
  const compiled = buildGraph();
  const final = await compiled.invoke(initial, { configurable: { thread_id: runId } });
  const status = final.status as RunStatus;
  await setRunStatus(runId, status);
  return { runId, status };
}

export async function resumeRunAfterApproval(cmd: RemediateCommand): Promise<RunStatus> {
  const runId = cmd.runId ?? cmd.incidentId;
  const existing = await getRun(runId);
  if (!existing) {
    await initRun(runId, cmd.incidentId);
  }
  const state: GraphState = {
    runId,
    incidentId: cmd.incidentId,
    request: cmd as unknown as StartRunRequest,
    namespace: cmd.namespace,
    resourceName: cmd.resourceName,
    resourceKind: cmd.resourceKind,
    mode: cmd.mode,
    pendingPlan: cmd.plan,
    actionHistory: [],
    iteration: 1,
    maxIterations: MAX_ITERATIONS,
    authorizeForceHil: false,
    autonomyMode: getAutonomyMode(),
    status: 'running',
    awaitingHuman: false,
    securityFindings: [],
    factsRaw: undefined,
    factsSanitized: undefined,
    lastError: undefined,
  };
  const actResult = await actNode(state);
  const merged = { ...state, ...actResult } as GraphState;
  if (merged.status === 'awaiting_human') {
    await setRunStatus(runId, 'awaiting_human');
    return 'awaiting_human';
  }
  const verifyResult = await verifyNode(merged);
  const status = (verifyResult.status ?? merged.status) as RunStatus;
  await setRunStatus(runId, status);
  return status;
}

export { actNode, verifyNode };
