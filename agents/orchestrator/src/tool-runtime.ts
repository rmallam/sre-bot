/**
 * Execute validated tool calls via existing agent HTTP endpoints.
 */

import type { RemediateCommand } from '../../../shared/src/types.js';
import type { ToolCall, RuntimeToolContext } from '../../../shared/src/tool-contracts.js';
import type { ToolTranscriptEntry } from '../../../shared/src/types.js';
import type { CompiledPlan } from '../../../shared/src/tool-registry.js';
import { getToolDefinition } from '../../../shared/src/tool-registry.js';
import { log } from '../../../shared/src/http.js';
import { humanizeOperatorError } from '../../../shared/src/user-errors.js';
import { mergeRunMetadata } from './run-store.js';

const AGENT = 'orchestrator-tool-runtime';

const EXECUTOR_URL = process.env['EXECUTOR_URL'] ?? 'http://executor-agent:8080';
const GITOPS_URL = process.env['GITOPS_URL'] ?? 'http://gitops-agent:8080';
const INVESTIGATOR_URL = process.env['INVESTIGATOR_URL'] ?? 'http://investigator-agent:8080';
const COMMANDER_URL = process.env['COMMANDER_URL'] ?? 'http://commander-agent:8080';
const CICD_URL = process.env['CICD_URL'] ?? 'http://cicd-agent:8080';
const CODING_AGENT_URL = process.env['CODING_AGENT_URL'] ?? 'http://coding-agent:8080';
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
  if (success) {
    return `✅ ${ctx.resourceName} (${ctx.namespace}): step OK — ${detail}`;
  }
  const why = humanizeOperatorError(detail);
  return (
    `⚠️ ${ctx.resourceName} (${ctx.namespace}): deploy step failed\n` +
    `${why}\n` +
    `(No pods will appear in ${ctx.namespace} until this succeeds.)`
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
        createNamespace: cmd.executionOptions?.createNamespace,
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

  if (call.name === 'cicd.rerun_workflow') {
    const input = call.input as {
      repo?: string;
      githubRepo?: string;
      runId?: number;
      workflowRunId?: number;
    };
    const repo = input.githubRepo ?? input.repo ?? '';
    const runId = input.workflowRunId ?? input.runId;
    if (!repo || runId == null) {
      return { success: false, error: 'repo and runId required for cicd rerun' };
    }
    try {
      const res = await fetch(`${CICD_URL}/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, runId, incidentId: cmd.incidentId }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const body = await res.text();
        return { success: false, error: `cicd rerun HTTP ${res.status}: ${body.slice(0, 400)}` };
      }
      const result = (await res.json()) as { ok?: boolean; message?: string };
      return { success: result.ok !== false, summary: result.message ?? 'workflow rerun requested' };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  if (call.name === 'cicd.open_pr') {
    const input = call.input as {
      repo?: string;
      githubRepo?: string;
      branch?: string;
      title?: string;
      body?: string;
      workflowFilePath?: string;
      workflowName?: string;
      logExcerpt?: string;
    };
    const repo = input.githubRepo ?? input.repo ?? '';
    if (!repo || !input.title) {
      return { success: false, error: 'repo and title required for cicd open-pr' };
    }
    try {
      const res = await fetch(`${CICD_URL}/open-pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo,
          branch: input.branch ?? 'main',
          title: input.title,
          body: input.body ?? '',
          incidentId: cmd.incidentId,
          workflowFilePath: input.workflowFilePath,
          workflowName: input.workflowName,
          logExcerpt: input.logExcerpt,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const body = await res.text();
        return { success: false, error: `cicd open-pr HTTP ${res.status}: ${body.slice(0, 400)}` };
      }
      const result = (await res.json()) as { ok?: boolean; message?: string; prUrl?: string };
      const urls = result.prUrl ? [result.prUrl] : undefined;
      return {
        success: result.ok !== false,
        summary: result.message ?? 'CI fix issue opened',
        commitUrls: urls,
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  if (call.name === 'cicd.open_code_pr') {
    const input = call.input as {
      repo?: string;
      githubRepo?: string;
      branch?: string;
      title?: string;
      body?: string;
      patches?: Array<{ path: string; content: string }>;
    };
    const repo = input.githubRepo ?? input.repo ?? '';
    if (!repo || !input.title || !input.patches?.length) {
      return { success: false, error: 'repo, title, and patches required for cicd open-code-pr' };
    }
    try {
      const res = await fetch(`${CICD_URL}/open-code-pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo,
          branch: input.branch ?? 'main',
          title: input.title,
          body: input.body ?? '',
          incidentId: cmd.incidentId,
          patches: input.patches,
        }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) {
        const body = await res.text();
        return { success: false, error: `cicd open-code-pr HTTP ${res.status}: ${body.slice(0, 400)}` };
      }
      const result = (await res.json()) as { ok?: boolean; message?: string; prUrl?: string };
      const urls = result.prUrl ? [result.prUrl] : undefined;
      return {
        success: result.ok !== false,
        summary: result.message ?? 'CI code fix PR opened',
        commitUrls: urls,
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  if (call.name === 'coding_agent.run_fix') {
    const input = call.input as {
      incidentId?: string;
      runId?: string;
      ciRun?: import('../../../shared/src/ci-types.js').CiRunFacts;
      platform?: string;
      channelId?: string;
      maxAttempts?: number;
    };
    if (!input.incidentId || !input.runId || !input.ciRun) {
      return { success: false, error: 'incidentId, runId, and ciRun required for coding_agent.run_fix' };
    }
    try {
      const startRes = await fetch(`${CODING_AGENT_URL}/run-fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incidentId: input.incidentId,
          runId: input.runId,
          ciRun: input.ciRun,
          platform: input.platform,
          channelId: input.channelId,
          maxAttempts: input.maxAttempts,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!startRes.ok) {
        const body = await startRes.text();
        return {
          success: false,
          error: `coding-agent run-fix HTTP ${startRes.status}: ${body.slice(0, 400)}`,
        };
      }
      const started = (await startRes.json()) as { jobId?: string };
      const jobId = started.jobId;
      if (!jobId) {
        return { success: false, error: 'coding-agent did not return jobId' };
      }
      await mergeRunMetadata(input.runId, { codingAgentJobId: jobId, ciRun: input.ciRun });

      const pollMs = parseInt(process.env['CODING_AGENT_POLL_MS'] ?? '4000', 10);
      const timeoutMs = parseInt(process.env['CODING_AGENT_POLL_TIMEOUT_MS'] ?? '900000', 10);
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        const jobRes = await fetch(`${CODING_AGENT_URL}/jobs/${encodeURIComponent(jobId)}`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!jobRes.ok) continue;
        const job = (await jobRes.json()) as {
          status?: string;
          prUrl?: string;
          summary?: string;
          error?: string;
        };
        if (job.status === 'succeeded') {
          const urls = job.prUrl ? [job.prUrl] : undefined;
          return {
            success: true,
            summary: job.summary ?? 'Coding agent opened fix PR',
            commitUrls: urls,
          };
        }
        if (job.status === 'failed' || job.status === 'cancelled') {
          return {
            success: false,
            error: job.error ?? job.summary ?? `Coding agent job ${job.status}`,
          };
        }
      }
      return { success: false, error: 'Coding agent job timed out while polling' };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  if (call.name === 'cicd.fetch_run') {
    const input = call.input as {
      repo?: string;
      githubRepo?: string;
      runId?: number;
      branch?: string;
      workflowName?: string;
    };
    const params = new URLSearchParams();
    const repo = input.repo ?? input.githubRepo;
    if (repo) params.set('repo', repo);
    if (input.runId != null) params.set('runId', String(input.runId));
    if (input.branch) params.set('branch', input.branch);
    if (input.workflowName) params.set('workflowName', input.workflowName);
    try {
      const res = await fetch(`${CICD_URL}/fetch-run?${params}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) {
        const body = await res.text();
        return { success: false, error: `cicd fetch-run HTTP ${res.status}: ${body.slice(0, 400)}` };
      }
      return { success: true, summary: 'ci run fetched' };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  if (call.name === 'investigator.logs_query') {
    const input = call.input as Record<string, unknown>;
    try {
      const res = await fetch(`${INVESTIGATOR_URL}/observability/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        return { success: false, error: `logs query HTTP ${res.status}` };
      }
      const body = (await res.json()) as { lines?: string[] };
      return { success: true, summary: `${body.lines?.length ?? 0} log lines` };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  if (call.name === 'investigator.metrics_query') {
    const input = call.input as Record<string, unknown>;
    try {
      const res = await fetch(`${INVESTIGATOR_URL}/observability/metrics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        return { success: false, error: `metrics query HTTP ${res.status}` };
      }
      const body = (await res.json()) as { summary?: string };
      return { success: true, summary: body.summary ?? 'metrics queried' };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  return { success: false, error: `No runtime handler for ${call.name}` };
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
