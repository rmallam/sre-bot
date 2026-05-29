/**
 * HTTP tool adapters for orchestrator nodes.
 */

import type {
  ActionRecord,
  ApprovalRequest,
  DeployRequest,
  DiagnosisContext,
  FailureAnalysisRequest,
  FailureAnalysisResult,
  RemediateCommand,
  RemediationPlan,
  ResourceKind,
  IncidentMode,
  PlanValidationResult,
  SanitizedFacts,
  StackDeployAnalysis,
  StartRunRequest,
} from '../../../shared/src/types.js';
import type { RuntimeToolContext } from '../../../shared/src/tool-contracts.js';
import { formatFetchError, log } from '../../../shared/src/http.js';
import { getToolDefinition } from '../../../shared/src/tool-registry.js';
import { isProdNamespace } from '../../../shared/src/tool-policy.js';
import type { PendingToolApproval } from '../../../shared/src/types.js';
import { compileAndValidatePlan, compileFromToolCalls } from './tool-compiler.js';
import { executeCompiledPlan } from './tool-runtime.js';
import {
  appendRunTranscript,
  setRunCompiled,
  getRun,
  setResumeFromToolIndex,
  setPendingToolApproval,
  setRunStatus,
} from './run-store.js';

const USE_CAPABILITY_PLANNER = (process.env['USE_CAPABILITY_PLANNER'] ?? 'false').toLowerCase() === 'true';
const PER_TOOL_HIL = (process.env['PER_TOOL_HIL'] ?? 'false').toLowerCase() === 'true';
export const FAILURE_ANALYSIS_ENABLED =
  (process.env['FAILURE_ANALYSIS_ENABLED'] ?? 'true').toLowerCase() === 'true';

const INVESTIGATOR_URL = process.env['INVESTIGATOR_URL'] ?? 'http://investigator-agent:8080';
const SECURITY_URL = process.env['SECURITY_URL'] ?? 'http://security-agent:8080';
const BRAIN_URL = process.env['BRAIN_URL'] ?? 'http://brain-agent:8080';
const HIL_URL = process.env['HIL_URL'] ?? 'http://hil-agent:8080';
const COMMANDER_URL = process.env['COMMANDER_URL'] ?? 'http://commander-agent:8080';
const GITOPS_URL = process.env['GITOPS_URL'] ?? 'http://gitops-agent:8080';

export interface OrchestratorRunContext {
  runId: string;
  incidentId: string;
  request: StartRunRequest;
  namespace: string;
  resourceName: string;
  resourceKind: StartRunRequest['resourceKind'];
  mode: StartRunRequest['mode'];
  pendingPlan?: RemediationPlan;
}

async function postJson<T>(url: string, payload: unknown, incidentId: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw formatFetchError(err, url);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST ${url} failed ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export function buildApprovalRequest(
  ctx: OrchestratorRunContext,
  plan: RemediationPlan,
  iteration: number,
  maxIterations: number,
  opts?: { pendingTool?: PendingToolApproval }
): ApprovalRequest {
  return {
    incidentId: ctx.incidentId,
    triggeredBy: ctx.request.triggeredBy,
    triggeredAt: ctx.request.triggeredAt,
    namespace: ctx.namespace,
    resourceKind: ctx.resourceKind,
    resourceName: ctx.resourceName,
    mode: ctx.mode,
    plan,
    attemptNumber: iteration,
    circuitBreakerLimit: maxIterations,
    escalated: plan.action === 'escalate_human',
    requestedBy: ctx.request.requestedBy,
    platform: ctx.request.platform,
    channelId: ctx.request.channelId,
    runId: ctx.runId,
    approvalKind: opts?.pendingTool ? 'tool' : 'plan',
    pendingToolApproval: opts?.pendingTool,
  };
}

export async function gatherFacts(req: StartRunRequest): Promise<DiagnosisContext> {
  const params = new URLSearchParams({
    namespace: req.namespace,
    resourceName: req.resourceName,
    resourceKind: req.resourceKind,
    podName: req.podName ?? req.resourceName,
    incidentId: req.incidentId,
    mode: req.mode,
  });
  if (req.githubRepo) params.set('githubRepo', req.githubRepo);
  if (req.containerImage) params.set('containerImage', req.containerImage);
  if (req.gitRef) params.set('gitRef', req.gitRef);
  if (req.investigateScope) params.set('investigateScope', req.investigateScope);
  if (req.rawMessage) params.set('rawMessage', req.rawMessage);

  const url = `${INVESTIGATOR_URL}/facts?${params}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    throw formatFetchError(err, url);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to gather facts: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<DiagnosisContext>;
}

export async function gatherStackFacts(req: StartRunRequest): Promise<StackDeployAnalysis> {
  const payload: DeployRequest = {
    incidentId: req.incidentId,
    triggeredBy: req.triggeredBy,
    triggeredAt: req.triggeredAt,
    namespace: req.namespace,
    resourceKind: req.resourceKind,
    resourceName: req.resourceName,
    mode: req.mode,
    githubRepo: req.githubRepo,
    gitRef: req.gitRef,
    deployStrategy: req.deployStrategy,
    requestedBy: req.requestedBy ?? 'unknown',
    platform: req.platform ?? 'web',
    channelId: req.channelId ?? 'unknown',
    rawMessage: req.rawMessage ?? '',
    stackServices: req.stackServices,
  };
  return postJson<StackDeployAnalysis>(
    `${INVESTIGATOR_URL}/stack-facts`,
    payload,
    req.incidentId
  );
}

export async function sanitizeFacts(context: DiagnosisContext) {
  return postJson<{
    sanitized: SanitizedFacts;
    findings: import('../../../shared/src/types.js').SecurityFinding[];
    blocked: boolean;
  }>(`${SECURITY_URL}/sanitize-for-llm`, { context, incidentId: context.incidentId }, context.incidentId);
}

export async function authorizePlan(
  plan: RemediationPlan,
  namespace: string,
  resourceName: string,
  resourceKind: ResourceKind,
  mode: IncidentMode,
  incidentId: string,
  githubRepo?: string
) {
  return postJson<import('../../../shared/src/types.js').AuthorizeActionResult>(
    `${SECURITY_URL}/authorize-action`,
    { plan, namespace, resourceName, resourceKind, mode, incidentId, githubRepo },
    incidentId
  );
}

export async function callPlanLlm(
  ctx: DiagnosisContext,
  actionHistory: ActionRecord[]
): Promise<RemediationPlan> {
  if (actionHistory.some((a) => a.action === 'restart' && !a.success)) {
    ctx.priorActionSummary = (ctx.priorActionSummary ?? '') + '; restart_failed';
  }
  return postJson<RemediationPlan>(`${BRAIN_URL}/plan-only`, ctx, ctx.incidentId);
}

export interface CapabilityPlanResponse {
  toolCalls: import('../../../shared/src/tool-contracts.js').ToolCall[];
  remediationPlan: RemediationPlan;
  reasoning: string;
  confidence: number;
}

export async function callCapabilityPlan(ctx: DiagnosisContext): Promise<CapabilityPlanResponse> {
  return postJson<CapabilityPlanResponse>(`${BRAIN_URL}/plan-capability`, ctx, ctx.incidentId);
}

export async function sanitizeTextForLlm(text: string, incidentId: string): Promise<string> {
  try {
    const res = await fetch(`${SECURITY_URL}/sanitize-for-llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, incidentId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return text.slice(0, 4000);
    const data = (await res.json()) as { sanitizedText?: string; blocked?: boolean };
    if (data.blocked) return '[redacted error]';
    return data.sanitizedText ?? text.slice(0, 4000);
  } catch {
    return text.slice(0, 4000);
  }
}

export async function callAnalyzeFailure(
  payload: FailureAnalysisRequest
): Promise<FailureAnalysisResult> {
  return postJson<FailureAnalysisResult>(`${BRAIN_URL}/analyze-failure`, payload, payload.incidentId);
}

export async function validatePlanBeforeExecution(input: {
  incidentId: string;
  namespace: string;
  mode: IncidentMode;
  resourceKind: ResourceKind;
  resourceName: string;
  plan: RemediationPlan;
  facts?: Partial<DiagnosisContext>;
}): Promise<PlanValidationResult> {
  return postJson<PlanValidationResult>(`${BRAIN_URL}/validate-plan`, input, input.incidentId);
}

export function buildRuntimeContext(ctx: OrchestratorRunContext): RuntimeToolContext {
  return {
    incidentId: ctx.incidentId,
    runId: ctx.runId,
    mode: ctx.mode,
    namespace: ctx.namespace,
    resourceName: ctx.resourceName,
    resourceKind: ctx.resourceKind,
    request: ctx.request,
    plan: ctx.pendingPlan!,
  };
}

export async function executeAction(
  ctx: OrchestratorRunContext,
  opts?: { iteration?: number; maxIterations?: number }
): Promise<{
  success: boolean;
  error?: string;
  summary?: string;
  commitUrls?: string[];
  transcript?: import('../../../shared/src/types.js').ToolTranscriptEntry[];
  verifyHealthy?: boolean;
  paused?: boolean;
}> {
  const plan = ctx.pendingPlan!;
  const cmd: RemediateCommand = {
    incidentId: ctx.incidentId,
    triggeredBy: ctx.request.triggeredBy,
    triggeredAt: ctx.request.triggeredAt,
    namespace: ctx.namespace,
    resourceKind: ctx.resourceKind,
    resourceName: ctx.resourceName,
    mode: ctx.mode,
    plan,
    approvedBy: 'orchestrator-auto',
    approvedAt: new Date().toISOString(),
    approvedVia: 'web',
    runId: ctx.runId,
    requestedBy: ctx.request.requestedBy,
    platform: ctx.request.platform,
    channelId: ctx.request.channelId,
  };
  if (ctx.request.createNamespace) {
    cmd.executionOptions = { ...cmd.executionOptions, createNamespace: true };
  }

  const runtimeCtx = buildRuntimeContext(ctx);
  const stored = await getRun(ctx.runId);
  const compiled =
    stored?.compiled?.calls?.length
      ? stored.compiled
      : compileAndValidatePlan(runtimeCtx);

  if (!stored?.compiled?.calls?.length) {
    await setRunCompiled(ctx.runId, compiled);
  }

  if (!compiled.validation.ok) {
    log('warn', 'orchestrator-tools', 'Compiled plan failed validation', {
      incidentId: ctx.incidentId,
      errors: compiled.validation.errors,
      confidence: compiled.confidence,
    });
    return {
      success: false,
      error: `Tool validation failed: ${compiled.validation.errors.join('; ')}`,
    };
  }
  if (compiled.calls.length === 0) {
    return {
      success: false,
      error: compiled.fallbackReason ?? `Unsupported action ${plan.action}`,
    };
  }

  const startIndex = stored?.resumeFromToolIndex ?? 0;

  log('info', 'orchestrator-tools', 'Executing compiled plan', {
    incidentId: ctx.incidentId,
    tools: compiled.calls.map((c) => c.name),
    confidence: compiled.confidence,
    riskLevel: compiled.riskLevel,
    startIndex,
  });

  const result = await executeCompiledPlan(compiled, cmd, runtimeCtx, {
    startIndex,
    onBeforeTool: async (call, index) => {
      if (!PER_TOOL_HIL) return 'proceed';
      const def = getToolDefinition(call.name);
      if (!def.requiresHilInProd || !isProdNamespace(ctx.namespace)) return 'proceed';
      const pending: PendingToolApproval = {
        toolIndex: index,
        tool: call.name,
        requestedAt: new Date().toISOString(),
      };
      await setResumeFromToolIndex(ctx.runId, index);
      await setPendingToolApproval(ctx.runId, pending);
      return 'pause_hil';
    },
  });

  if (result.transcript.length > 0) {
    await appendRunTranscript(ctx.runId, result.transcript);
  }

  if (result.pausedForToolHil && result.pausedAtToolIndex !== undefined) {
    await setRunStatus(ctx.runId, 'awaiting_human');
    const pending: PendingToolApproval = {
      toolIndex: result.pausedAtToolIndex,
      tool: result.pausedTool ?? 'unknown',
      requestedAt: new Date().toISOString(),
    };
    await requestHilApproval(
      ctx,
      plan,
      opts?.iteration ?? 1,
      opts?.maxIterations ?? 5,
      pending
    );
    return { success: false, paused: true, error: result.error };
  }

  if (result.success) {
    await setResumeFromToolIndex(ctx.runId, null);
    await setPendingToolApproval(ctx.runId, undefined);
  }

  return {
    success: result.success,
    error: result.error,
    summary: result.summary,
    commitUrls: result.commitUrls,
    transcript: result.transcript,
    verifyHealthy: result.verifyHealthy,
  };
}

export { compileAndValidatePlan };

export async function verifyWorkload(namespace: string, resourceName: string, incidentId: string) {
  const res = await fetch(
    `${INVESTIGATOR_URL}/verify?namespace=${encodeURIComponent(namespace)}&resourceName=${encodeURIComponent(resourceName)}&incidentId=${encodeURIComponent(incidentId)}`,
    { signal: AbortSignal.timeout(30_000) }
  );
  if (!res.ok) {
    return { healthy: false, message: `Verify HTTP ${res.status}` };
  }
  return res.json() as Promise<{ healthy: boolean; message: string }>;
}

export async function requestHilApproval(
  ctx: OrchestratorRunContext,
  plan: RemediationPlan,
  iteration: number,
  maxIterations: number,
  pendingTool?: PendingToolApproval
): Promise<void> {
  const approval = buildApprovalRequest(ctx, plan, iteration, maxIterations, {
    pendingTool,
  });
  await postJson(`${HIL_URL}/request-approval`, approval, ctx.incidentId);
}

export async function runRemediationCommand(
  cmd: RemediateCommand
): Promise<import('../../../shared/src/types.js').RemediationResult> {
  return postJson<import('../../../shared/src/types.js').RemediationResult>(
    `${GITOPS_URL}/remediate`,
    cmd,
    cmd.incidentId
  );
}

export { USE_CAPABILITY_PLANNER, compileFromToolCalls };

export async function notifyUser(ctx: OrchestratorRunContext, message: string): Promise<void> {
  if (!ctx.request.platform || !ctx.request.channelId) return;
  try {
    await postJson(`${COMMANDER_URL}/notify`, {
      platform: ctx.request.platform,
      channelId: ctx.request.channelId,
      message,
      incidentId: ctx.incidentId,
      runId: ctx.runId,
    }, ctx.incidentId);
  } catch (err) {
    log('warn', 'orchestrator-tools', 'Notify failed', { error: String(err) });
  }
}
