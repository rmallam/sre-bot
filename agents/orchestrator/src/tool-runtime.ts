/**
 * Execute validated tool calls via existing agent HTTP endpoints.
 */

import type { RemediateCommand } from '../../../shared/src/types.js';
import type { ToolCall, RuntimeToolContext } from '../../../shared/src/tool-contracts.js';
import type { ToolTranscriptEntry } from '../../../shared/src/types.js';
import type { CompiledPlan } from '../../../shared/src/tool-registry.js';
import { getToolDefinition } from '../../../shared/src/tool-registry.js';
import { log } from '../../../shared/src/http.js';

const AGENT = 'orchestrator-tool-runtime';

const EXECUTOR_URL = process.env['EXECUTOR_URL'] ?? 'http://executor-agent:8080';
const GITOPS_URL = process.env['GITOPS_URL'] ?? 'http://gitops-agent:8080';
const INVESTIGATOR_URL = process.env['INVESTIGATOR_URL'] ?? 'http://investigator-agent:8080';
const COMMANDER_URL = process.env['COMMANDER_URL'] ?? 'http://commander-agent:8080';
const REGISTRY_DRY_RUN = (process.env['REGISTRY_DRY_RUN'] ?? 'true').toLowerCase() === 'true';

export interface ToolExecuteResult {
  success: boolean;
  error?: string;
  summary?: string;
  commitUrls?: string[];
}

export interface CompiledExecutionResult {
  success: boolean;
  error?: string;
  summary?: string;
  commitUrls?: string[];
  transcript: ToolTranscriptEntry[];
  verifyHealthy?: boolean;
  pausedForToolHil?: boolean;
  pausedAtToolIndex?: number;
  pausedTool?: ToolCall['name'];
}

export type BeforeToolDecision = 'proceed' | 'pause_hil';

export interface ExecuteCompiledPlanOptions {
  startIndex?: number;
  onBeforeTool?: (call: ToolCall, index: number) => Promise<BeforeToolDecision>;
}

async function postJson<T>(url: string, payload: unknown, incidentId: string): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST ${url} failed ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

function idempotencyKey(incidentId: string, tool: string, attempt: number): string {
  return `${incidentId}:${tool}:${attempt}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildNotifyMessage(ctx: RuntimeToolContext, success: boolean, detail: string): string {
  const icon = success ? '✅' : '⚠️';
  return (
    `${icon} *${ctx.resourceName}* (${ctx.namespace})\n` +
    `Run: \`${ctx.runId}\`\n` +
    `Action: ${ctx.plan.action}\n` +
    `${detail}`
  );
}

async function executeToolCallOnce(
  call: ToolCall,
  cmd: RemediateCommand,
  ctx: RuntimeToolContext,
  priorSuccess: boolean,
  priorDetail: string
): Promise<ToolExecuteResult> {
  const def = getToolDefinition(call.name);

  if (call.name === 'investigator.repo_inspect') {
    const input = call.input as {
      githubRepo: string;
      gitRef?: string;
      namespace: string;
      resourceName: string;
      incidentId: string;
    };
    const params = new URLSearchParams({
      namespace: input.namespace,
      resourceName: input.resourceName,
      resourceKind: 'Deployment',
      incidentId: input.incidentId,
      mode: 'pre-deploy',
      githubRepo: input.githubRepo,
      gitRef: input.gitRef ?? 'main',
    });
    const res = await fetch(`${INVESTIGATOR_URL}/facts?${params}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      return { success: false, error: `Repo inspect failed HTTP ${res.status}`, summary: 'repo_inspect' };
    }
    const facts = (await res.json()) as {
      needsHelmGeneration?: boolean;
      repoEntryPointKind?: string;
      gitManifestPath?: string;
    };
    const summary = facts.needsHelmGeneration
      ? 'No manifests — Helm generation likely'
      : `Found ${facts.repoEntryPointKind ?? 'manifest'} at ${facts.gitManifestPath ?? 'repo'}`;
    return { success: true, summary };
  }

  if (call.name === 'executor.restart_workload') {
    const result = await postJson<{ success: boolean; error?: string }>(
      `${EXECUTOR_URL}/execute`,
      cmd,
      cmd.incidentId
    );
    return { success: result.success, error: result.error, summary: 'restart' };
  }

  if (call.name === 'gitops.apply_plan') {
    const cmdWithOpts: RemediateCommand = {
      ...cmd,
      executionOptions: {
        dryRun: REGISTRY_DRY_RUN && def.supportsDryRun,
      },
    };
    const result = await postJson<{
      success: boolean;
      error?: string;
      gitCommitUrl?: string;
      appRepoCommitUrl?: string;
    }>(`${GITOPS_URL}/remediate`, cmdWithOpts, cmd.incidentId);
    const urls = [result.gitCommitUrl, result.appRepoCommitUrl].filter(Boolean) as string[];
    return {
      success: result.success,
      error: result.error,
      summary: cmd.plan.action,
      commitUrls: urls,
    };
  }

  if (call.name === 'investigator.verify_health') {
    const input = call.input as { namespace: string; resourceName: string };
    const res = await fetch(
      `${INVESTIGATOR_URL}/verify?namespace=${encodeURIComponent(input.namespace)}&resourceName=${encodeURIComponent(input.resourceName)}&incidentId=${encodeURIComponent(cmd.incidentId)}`,
      { signal: AbortSignal.timeout(30_000) }
    );
    if (!res.ok) {
      return { success: false, error: `Verify HTTP ${res.status}`, summary: 'verify' };
    }
    const body = (await res.json()) as { healthy: boolean; message: string };
    return {
      success: body.healthy,
      error: body.healthy ? undefined : body.message,
      summary: body.healthy ? 'healthy' : 'degraded',
    };
  }

  if (call.name === 'argo.wait_sync') {
    const input = call.input as { appName: string; timeoutMs?: number; incidentId: string };
    const result = await postJson<{ synced: boolean; status: string }>(
      `${GITOPS_URL}/argo/wait-sync`,
      {
        appName: input.appName,
        timeoutMs: input.timeoutMs,
        incidentId: input.incidentId,
      },
      cmd.incidentId
    );
    return {
      success: result.synced,
      error: result.synced ? undefined : `Argo sync: ${result.status}`,
      summary: `argo-sync:${result.status}`,
    };
  }

  if (call.name === 'argo.rollout_promote') {
    const input = call.input as {
      namespace: string;
      rolloutName: string;
      incidentId: string;
    };
    const result = await postJson<{ success: boolean; error?: string; summary?: string }>(
      `${GITOPS_URL}/argo/rollout-promote`,
      input,
      cmd.incidentId
    );
    return {
      success: result.success,
      error: result.error,
      summary: result.summary ?? 'rollout-promote',
    };
  }

  if (call.name === 'commander.notify') {
    const input = call.input as {
      platform?: string;
      channelId?: string;
      message: string;
      runId?: string;
    };
    if (!input.platform || !input.channelId) {
      return { success: true, summary: 'notify-skipped' };
    }
    const message =
      input.message === '__RUNTIME_NOTIFY__'
        ? buildNotifyMessage(ctx, priorSuccess, priorDetail)
        : input.message;
    await postJson(
      `${COMMANDER_URL}/notify`,
      {
        platform: input.platform,
        channelId: input.channelId,
        message,
        incidentId: cmd.incidentId,
        runId: input.runId,
      },
      cmd.incidentId
    );
    return { success: true, summary: 'notify' };
  }

  return { success: false, error: `No runtime handler for ${call.name}` };
}

export async function executeToolCall(
  call: ToolCall,
  cmd: RemediateCommand,
  ctx: RuntimeToolContext,
  priorSuccess = true,
  priorDetail = ''
): Promise<ToolExecuteResult> {
  const def = getToolDefinition(call.name);
  log('info', AGENT, `Executing tool ${call.name}`, {
    incidentId: cmd.incidentId,
    risk: def.risk,
    dryRunCapable: def.supportsDryRun,
    idempotent: def.idempotent,
  });
  return executeToolCallOnce(call, cmd, ctx, priorSuccess, priorDetail);
}

export async function executeCompiledPlan(
  compiled: CompiledPlan,
  cmd: RemediateCommand,
  ctx: RuntimeToolContext,
  opts?: ExecuteCompiledPlanOptions
): Promise<CompiledExecutionResult> {
  const transcript: ToolTranscriptEntry[] = [];
  let overallSuccess = true;
  let lastError: string | undefined;
  let lastSummary = '';
  let commitUrls: string[] | undefined;
  let verifyHealthy: boolean | undefined;
  let mutateFailed = false;
  const startIndex = opts?.startIndex ?? 0;

  for (let i = startIndex; i < compiled.calls.length; i++) {
    const call = compiled.calls[i]!;

    if (opts?.onBeforeTool) {
      const decision = await opts.onBeforeTool(call, i);
      if (decision === 'pause_hil') {
        return {
          success: false,
          error: `Paused for HIL before ${call.name}`,
          summary: lastSummary,
          commitUrls,
          transcript,
          verifyHealthy,
          pausedForToolHil: true,
          pausedAtToolIndex: i,
          pausedTool: call.name,
        };
      }
    }

    if (mutateFailed && call.name !== 'commander.notify') {
      continue;
    }

    const def = getToolDefinition(call.name);
    let attempt = 0;
    let result: ToolExecuteResult = { success: false, error: 'not executed' };
    const started = Date.now();

    while (attempt < def.maxRetries) {
      attempt += 1;
      try {
        result = await executeToolCallOnce(
          call,
          cmd,
          ctx,
          overallSuccess,
          lastSummary || lastError || 'completed'
        );
        if (result.success || def.idempotent) break;
      } catch (err) {
        result = { success: false, error: String(err) };
      }
      if (attempt < def.maxRetries) await sleep(500 * attempt);
    }

    const entry: ToolTranscriptEntry = {
      at: new Date().toISOString(),
      tool: call.name,
      attempt,
      success: result.success,
      summary: result.summary,
      error: result.error,
      durationMs: Date.now() - started,
      idempotencyKey: idempotencyKey(cmd.incidentId, call.name, attempt),
    };
    transcript.push(entry);

    if (result.summary) lastSummary = result.summary;
    if (result.error) lastError = result.error;
    if (result.commitUrls) commitUrls = result.commitUrls;

    if (call.name === 'investigator.verify_health') {
      verifyHealthy = result.success;
    }

    if (!result.success) {
      overallSuccess = false;
      if (call.name === 'gitops.apply_plan' || call.name === 'executor.restart_workload') {
        mutateFailed = true;
      }
      if (call.name === 'investigator.repo_inspect') {
        log('warn', AGENT, 'Repo inspect failed — continuing', { incidentId: cmd.incidentId });
        overallSuccess = true;
      }
    }
  }

  return {
    success: overallSuccess,
    error: overallSuccess ? undefined : lastError,
    summary: lastSummary,
    commitUrls,
    transcript,
    verifyHealthy,
  };
}
