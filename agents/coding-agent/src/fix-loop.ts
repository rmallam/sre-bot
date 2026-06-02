/**
 * LLM plan → clone → patch → local test → open PR loop (CI-2).
 */

import type { CiRunFacts } from '../../../shared/src/ci-types.js';
import type { CiRepoContext } from '../../../shared/src/ci-repo-context.js';
import type { Platform } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import {
  appendStep,
  getJob,
  patchJob,
  type CodingJob,
} from './job-store.js';
import { notifyCodingProgress } from './notify-progress.js';
import { applyPatches, cleanupWorkspace, cloneRepo, runTestCommand } from './repo-workspace.js';

const AGENT = 'coding-agent';
const BRAIN_URL = process.env['BRAIN_URL'] ?? 'http://brain-agent:8080';
const CICD_URL = process.env['CICD_URL'] ?? 'http://cicd-agent:8080';

export interface RunFixInput {
  jobId: string;
  incidentId: string;
  runId?: string;
  ciRun: CiRunFacts;
  platform?: Platform;
  channelId?: string;
  maxAttempts?: number;
}

async function gatherRepoContext(ciRun: CiRunFacts): Promise<CiRepoContext> {
  const params = new URLSearchParams({
    repo: ciRun.githubRepo.startsWith('github.com/')
      ? ciRun.githubRepo
      : `github.com/${ciRun.githubRepo}`,
    branch: ciRun.branch,
  });
  if (ciRun.workflowName) params.set('workflowName', ciRun.workflowName);
  const res = await fetch(`${CICD_URL}/repo-context?${params}`, {
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    throw new Error(`repo-context HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json() as Promise<CiRepoContext>;
}

async function planFix(opts: {
  incidentId: string;
  ciRun: CiRunFacts;
  repoContext: CiRepoContext;
  attempt: number;
  maxAttempts: number;
  previousError?: string;
}): Promise<{
  patches: Array<{ path: string; content: string }>;
  title: string;
  body: string;
  reasoning: string;
  testCommand?: string;
}> {
  const res = await fetch(`${BRAIN_URL}/plan-app-fix`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    throw new Error(`plan-app-fix HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  return res.json() as Promise<{
    patches: Array<{ path: string; content: string }>;
    title: string;
    body: string;
    reasoning: string;
    testCommand?: string;
  }>;
}

async function openCodePr(opts: {
  incidentId: string;
  githubRepo: string;
  branch: string;
  title: string;
  body: string;
  patches: Array<{ path: string; content: string }>;
}): Promise<{ prUrl?: string; message?: string }> {
  const res = await fetch(`${CICD_URL}/open-code-pr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repo: opts.githubRepo,
      branch: opts.branch,
      title: opts.title,
      body: opts.body,
      incidentId: opts.incidentId,
      patches: opts.patches,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    throw new Error(`open-code-pr HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  return res.json() as Promise<{ prUrl?: string; message?: string }>;
}

function cancelled(job: CodingJob | undefined): boolean {
  return job?.cancelled === true || job?.status === 'cancelled';
}

async function progress(
  input: RunFixInput,
  attempt: number,
  maxAttempts: number,
  step: string,
  kind?: 'info' | 'plan' | 'test' | 'pr' | 'error'
): Promise<void> {
  appendStep(input.jobId, { label: step, kind });
  await notifyCodingProgress({
    platform: input.platform,
    channelId: input.channelId,
    incidentId: input.incidentId,
    runId: input.runId,
    kind: 'coding_agent_progress',
    attempt,
    maxAttempts,
    progressStep: step,
  });
}

export async function runFixLoop(input: RunFixInput): Promise<void> {
  const maxAttempts =
    input.maxAttempts ??
    parseInt(process.env['CODING_AGENT_MAX_ITERATIONS'] ?? process.env['CODING_AGENT_MAX_ATTEMPTS'] ?? '5', 10);

  patchJob(input.jobId, { status: 'running', maxAttempts });

  log('info', AGENT, 'fix loop started', {
    jobId: input.jobId,
    incidentId: input.incidentId,
    repo: input.ciRun.githubRepo,
    maxAttempts,
  });

  let previousError: string | undefined;
  let repoContext: CiRepoContext | undefined;

  try {
    await progress(input, 0, maxAttempts, 'Loading repository context…');
    repoContext = await gatherRepoContext(input.ciRun);
  } catch (err) {
    const msg = String(err);
    patchJob(input.jobId, { status: 'failed', error: msg, summary: 'Could not load repo context' });
    await notifyCodingProgress({
      platform: input.platform,
      channelId: input.channelId,
      incidentId: input.incidentId,
      runId: input.runId,
      kind: 'coding_agent_done',
      technicalMessage: `Code fixer failed: ${msg.slice(0, 300)}`,
    });
    return;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (cancelled(getJob(input.jobId))) {
      patchJob(input.jobId, { status: 'cancelled', summary: 'Cancelled by user' });
      return;
    }

    patchJob(input.jobId, { attempt, status: 'running' });
    await progress(input, attempt, maxAttempts, `Planning fix (attempt ${attempt}/${maxAttempts})…`, 'plan');

    let plan: Awaited<ReturnType<typeof planFix>>;
    try {
      plan = await planFix({
        incidentId: input.incidentId,
        ciRun: input.ciRun,
        repoContext: repoContext!,
        attempt,
        maxAttempts,
        previousError,
      });
    } catch (err) {
      previousError = String(err);
      appendStep(input.jobId, { label: 'Planning failed', detail: previousError.slice(0, 500), kind: 'error' });
      continue;
    }

    if (!plan.patches.length) {
      previousError = plan.reasoning || 'LLM returned no patches';
      appendStep(input.jobId, {
        label: 'No safe patch proposed',
        detail: previousError.slice(0, 500),
        kind: 'error',
      });
      continue;
    }

    appendStep(input.jobId, {
      label: `Proposed ${plan.patches.length} file(s)`,
      detail: plan.patches.map((p) => p.path).join(', '),
      kind: 'plan',
    });

    let workspaceDir: string | undefined;
    try {
      await progress(input, attempt, maxAttempts, 'Cloning repository…');
      workspaceDir = await cloneRepo(input.ciRun.githubRepo, input.ciRun.branch, `${input.jobId}-${attempt}`);
      await applyPatches(workspaceDir, plan.patches);

      if (plan.testCommand) {
        await progress(input, attempt, maxAttempts, `Running local check: ${plan.testCommand}`, 'test');
        const test = await runTestCommand(workspaceDir, plan.testCommand);
        appendStep(input.jobId, {
          label: test.ok ? 'Local check passed' : 'Local check failed',
          detail: test.output.slice(-800),
          kind: test.ok ? 'test' : 'error',
        });
        if (!test.ok) {
          previousError = test.output;
          continue;
        }
      }

      await progress(input, attempt, maxAttempts, 'Opening pull request…', 'pr');
      const pr = await openCodePr({
        incidentId: input.incidentId,
        githubRepo: input.ciRun.githubRepo,
        branch: input.ciRun.branch,
        title: plan.title,
        body: plan.body || plan.reasoning,
        patches: plan.patches,
      });

      patchJob(input.jobId, {
        status: 'succeeded',
        prUrl: pr.prUrl,
        summary: pr.message ?? plan.reasoning,
      });
      appendStep(input.jobId, { label: 'PR opened', detail: pr.prUrl, kind: 'pr' });

      await notifyCodingProgress({
        platform: input.platform,
        channelId: input.channelId,
        incidentId: input.incidentId,
        runId: input.runId,
        kind: 'coding_agent_done',
        attempt,
        maxAttempts,
        prUrl: pr.prUrl,
        technicalMessage: pr.message ?? plan.reasoning,
      });
      return;
    } catch (err) {
      previousError = String(err);
      appendStep(input.jobId, { label: 'Attempt failed', detail: previousError.slice(0, 500), kind: 'error' });
    } finally {
      if (workspaceDir) {
        await cleanupWorkspace(`${input.jobId}-${attempt}`);
      }
    }
  }

  const failMsg = previousError?.slice(0, 400) ?? 'Max attempts reached without a passing fix';
  patchJob(input.jobId, { status: 'failed', error: failMsg, summary: 'Could not produce a fix PR' });
  await notifyCodingProgress({
    platform: input.platform,
    channelId: input.channelId,
    incidentId: input.incidentId,
    runId: input.runId,
    kind: 'coding_agent_done',
    attempt: maxAttempts,
    maxAttempts,
    technicalMessage: `Code fixer exhausted attempts. ${failMsg}`,
  });
}
