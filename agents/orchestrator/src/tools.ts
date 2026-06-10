/**
 * HTTP tool adapters for orchestrator nodes.
 */

import type { CiRunFacts } from '../../../shared/src/ci-types.js';
import type {
  ActionRecord,
  ApprovalRequest,
  DeployRequest,
  DiagnosisContext,
  FailureAnalysisRequest,
  FailureAnalysisResult,
  RemediateCommand,
  RemediationPlan,
  RemediationAction,
  ResourceKind,
  IncidentMode,
  PlanValidationResult,
  SanitizedFacts,
  StackDeployAnalysis,
  StartRunRequest,
  PendingToolApproval,
  VerifyResult,
} from '../../../shared/src/types.js';
import type { RuntimeToolContext } from '../../../shared/src/tool-contracts.js';
import { formatFetchError, log } from '../../../shared/src/http.js';
import { internalAuthHeaders } from '../../../shared/src/internal-auth.js';
import { waitForWorkloadReady } from '../../../shared/src/workload-readiness-wait.js';
import { getToolDefinition } from '../../../shared/src/tool-registry.js';
import { isProdNamespace } from '../../../shared/src/tool-policy.js';
import type { RunUpdatePayload, RunUpdateQuickAction } from '../../../shared/src/run-update.js';
import { formatRunUpdateFallback, defaultQuickActionsForUpdate } from '../../../shared/src/run-update.js';
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
import {
  flattenDeployWorkloads,
  parseDeployReleaseTargets,
  type DeployWorkloadRef,
} from '../../../shared/src/deploy-workloads.js';

const USE_CAPABILITY_PLANNER = (process.env['USE_CAPABILITY_PLANNER'] ?? 'false').toLowerCase() === 'true';
const PER_TOOL_HIL = (process.env['PER_TOOL_HIL'] ?? 'false').toLowerCase() === 'true';
export const FAILURE_ANALYSIS_ENABLED =
  (process.env['FAILURE_ANALYSIS_ENABLED'] ?? 'true').toLowerCase() === 'true';

const INVESTIGATOR_URL = process.env['INVESTIGATOR_URL'] ?? 'http://investigator-agent:8080';
const CICD_URL = process.env['CICD_URL'] ?? 'http://cicd-agent:8080';
const SECURITY_URL = process.env['SECURITY_URL'] ?? 'http://security-agent:8080';
const BRAIN_URL = process.env['BRAIN_URL'] ?? 'http://brain-agent:8080';
const HIL_URL = process.env['HIL_URL'] ?? 'http://hil-agent:8080';
const COMMANDER_URL = process.env['COMMANDER_URL'] ?? 'http://commander-agent:8080';
const GITOPS_URL = process.env['GITOPS_URL'] ?? 'http://gitops-agent:8080';
const NARRATE = (process.env['CONVERSATIONAL_NARRATE'] ?? 'true').toLowerCase() === 'true';
const CI_CLASSIFY_LLM = (process.env['CI_CLASSIFY_LLM'] ?? 'true').toLowerCase() === 'true';

export interface OrchestratorRunContext {
  runId: string;
  incidentId: string;
  request: StartRunRequest;
  namespace: string;
  resourceName: string;
  resourceKind: StartRunRequest['resourceKind'];
  mode: StartRunRequest['mode'];
  pendingPlan?: RemediationPlan;
  ciRun?: CiRunFacts;
}

async function postJson<T>(url: string, payload: unknown, incidentId: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
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

/** Fetch latest or specific GitHub Actions run for CI failure mode. */
export async function gatherCiFacts(req: StartRunRequest): Promise<CiRunFacts> {
  const repo = req.githubRepo?.trim();
  if (!repo) {
    throw new Error('githubRepo is required for ci-failure mode');
  }
  const params = new URLSearchParams({ repo });
  if (req.workflowRunId != null) params.set('runId', String(req.workflowRunId));
  if (req.ciBranch?.trim()) params.set('branch', req.ciBranch.trim());
  if (req.workflowName?.trim()) params.set('workflowName', req.workflowName.trim());

  const res = await fetch(`${CICD_URL}/fetch-run?${params}`);
  if (!res.ok) {
    throw new Error(formatFetchError('cicd fetch-run', res.status, await res.text()));
  }
  return (await res.json()) as CiRunFacts;
}

/** Skip watcher/auto runs when resource is on the HIL ignore list. */
export async function isRunRequestIgnored(req: StartRunRequest): Promise<boolean> {
  if (req.triggeredBy === 'commander') return false;
  try {
    const params = new URLSearchParams({
      namespace: req.namespace,
      resourceName: req.resourceName,
    });
    if (req.githubRepo) params.set('githubRepo', req.githubRepo);
    const res = await fetch(`${HIL_URL}/api/ignored/check?${params}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { ignored?: boolean };
    return data.ignored === true;
  } catch {
    return false;
  }
}

/** Call brain when regex CI diagnosis confidence is low. */
export async function enhanceCiRunFacts(
  ciRun: CiRunFacts,
  incidentId: string
): Promise<CiRunFacts> {
  if (!CI_CLASSIFY_LLM || !ciRun.diagnosis || ciRun.diagnosis.confidence >= 0.8) {
    return ciRun;
  }
  try {
    const res = await fetch(`${BRAIN_URL}/classify-ci`, {
      method: 'POST',
      headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ incidentId, ciRun }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return ciRun;
    const enhanced = (await res.json()) as Partial<import('../../../shared/src/ci-types.js').CiDiagnosis> & {
      skipped?: boolean;
    };
    if (enhanced.skipped || !enhanced.fixCategory || !enhanced.summary) return ciRun;
    return {
      ...ciRun,
      diagnosis: {
        ...ciRun.diagnosis,
        ...enhanced,
        confidence: Math.max(ciRun.diagnosis.confidence, enhanced.confidence ?? 0.75),
        errorHighlight: enhanced.errorHighlight ?? ciRun.diagnosis.errorHighlight,
      },
    };
  } catch (err) {
    log('warn', 'orchestrator-tools', 'CI LLM classify failed', { incidentId, error: String(err) });
    return ciRun;
  }
}

/** UX-8: fire-and-forget progress ping to user. */
export async function notifyProgress(
  ctx: OrchestratorRunContext,
  step: string
): Promise<void> {
  await notifyUserUpdate(ctx, {
    kind: 'progress',
    incidentId: ctx.incidentId,
    runId: ctx.runId,
    mode: ctx.mode,
    progressStep: step,
  });
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
  if (req.helmRemote) params.set('helmRemote', JSON.stringify(req.helmRemote));
  if (req.gitRef) params.set('gitRef', req.gitRef);
  if (req.investigateScope) params.set('investigateScope', req.investigateScope);
  if (req.rawMessage) params.set('rawMessage', req.rawMessage);
  if (req.correlationKey) params.set('correlationKey', req.correlationKey);
  if (req.affectedWorkloads?.length) {
    params.set('affectedWorkloads', JSON.stringify(req.affectedWorkloads));
  }
  if (req.deployProvenance) {
    params.set('deployProvenance', JSON.stringify(req.deployProvenance));
  }
  if (req.allowClusterHotFix) params.set('allowClusterHotFix', 'true');

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
      headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
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
    ciRun: ctx.ciRun,
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
  if (!runtimeCtx.ciRun && stored?.metadata?.ciRun) {
    runtimeCtx.ciRun = stored.metadata.ciRun as CiRunFacts;
  }
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

export async function verifyWorkload(
  namespace: string,
  resourceName: string,
  incidentId: string,
  opts?: { workloads?: DeployWorkloadRef[]; playbookMarkdown?: string }
): Promise<VerifyResult> {
  const body = {
    namespace,
    resourceName,
    incidentId,
    workloads: opts?.workloads?.length ? opts.workloads : undefined,
    playbookMarkdown: opts?.playbookMarkdown,
  };
  const res = await fetch(`${INVESTIGATOR_URL}/verify`, {
    method: 'POST',
    headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    return { healthy: false, message: `Verify HTTP ${res.status}` };
  }
  return res.json() as Promise<VerifyResult>;
}

async function workloadsFromRun(runId?: string): Promise<DeployWorkloadRef[] | undefined> {
  if (!runId) return undefined;
  const run = await getRun(runId);
  const flat = flattenDeployWorkloads(parseDeployReleaseTargets(run?.metadata));
  return flat.length ? flat : undefined;
}

const ROLLOUT_WAIT_ACTIONS = new Set(['git_patch', 'restart', 'helm_deploy', 'repo_apply']);

export function planHasImagePatch(plan?: RemediationPlan): boolean {
  if (!plan?.proposedPatch?.length) return false;
  return plan.proposedPatch.some((p) => String(p.path ?? '').includes('/image'));
}

/** After cluster patch/restart, poll until rollout completes (image pull, probes). */
export async function verifyAfterRemediation(
  namespace: string,
  resourceName: string,
  incidentId: string,
  opts: {
    waitForRollout: boolean;
    runId?: string;
    remediationAction?: RemediationAction;
    afterImagePatch?: boolean;
    onProgress?: (message: string) => void | Promise<void>;
    playbookMarkdown?: string;
  }
): Promise<VerifyResult> {
  const workloads = await workloadsFromRun(opts.runId);
  const verifyOpts = {
    ...(workloads?.length ? { workloads } : {}),
    ...(opts.playbookMarkdown ? { playbookMarkdown: opts.playbookMarkdown } : {}),
  };

  if (!opts.waitForRollout) {
    return verifyWorkload(namespace, resourceName, incidentId, verifyOpts);
  }
  return waitForWorkloadReady({
    namespace,
    resourceName,
    incidentId,
    remediationAction: opts.remediationAction,
    afterImagePatch: opts.afterImagePatch,
    fetchVerify: (ns, name, iid) => verifyWorkload(ns, name, iid, verifyOpts),
    onProgress: opts.onProgress,
  });
}

export function actionNeedsRolloutWait(action: string | undefined): boolean {
  return !!action && ROLLOUT_WAIT_ACTIONS.has(action);
}

export async function requestHilApproval(
  ctx: OrchestratorRunContext,
  plan: RemediationPlan,
  iteration: number,
  maxIterations: number,
  pendingTool?: PendingToolApproval
): Promise<void> {
  if (await isRunRequestIgnored(ctx.request)) {
    log('info', 'orchestrator-tools', 'Skipping HIL — resource ignored', {
      incidentId: ctx.incidentId,
      namespace: ctx.namespace,
      resourceName: ctx.resourceName,
    });
    return;
  }
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
    const body: Record<string, unknown> = {
      platform: ctx.request.platform,
      channelId: ctx.request.channelId,
      message,
      incidentId: ctx.incidentId,
      runId: ctx.runId,
    };
    if (NARRATE) {
      body.update = {
        kind: 'generic',
        incidentId: ctx.incidentId,
        runId: ctx.runId,
        mode: ctx.mode,
        technicalMessage: message,
        namespace: ctx.namespace,
        resourceName: ctx.resourceName,
      };
    }
    await postJson(`${COMMANDER_URL}/notify`, body, ctx.incidentId);
  } catch (err) {
    log('warn', 'orchestrator-tools', 'Notify failed', { error: String(err) });
  }
}

export async function notifyUserUpdate(
  ctx: OrchestratorRunContext,
  update: RunUpdatePayload
): Promise<void> {
  if (!ctx.request.platform || !ctx.request.channelId) return;
  const payload: RunUpdatePayload = {
    ...update,
    incidentId: update.incidentId || ctx.incidentId,
    runId: update.runId ?? ctx.runId,
    mode: update.mode ?? ctx.mode,
  };
  const quickActions = payload.quickActions ?? defaultQuickActionsForUpdate(payload);
  try {
    await postJson(
      `${COMMANDER_URL}/notify`,
      {
        platform: ctx.request.platform,
        channelId: ctx.request.channelId,
        message: formatRunUpdateFallback(payload),
        update: NARRATE ? { ...payload, quickActions } : undefined,
        quickActions: NARRATE ? quickActions : undefined,
        incidentId: ctx.incidentId,
        runId: ctx.runId,
      },
      ctx.incidentId
    );
  } catch (err) {
    log('warn', 'orchestrator-tools', 'Notify update failed', { error: String(err) });
  }
}
