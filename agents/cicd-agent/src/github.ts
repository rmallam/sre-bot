/**
 * GitHub Actions API client for CI/CD triage and remediation.
 */

import { parseOwnerRepo } from '../../../shared/src/github-repo.js';
import { diagnoseCiRun } from '../../../shared/src/ci-diagnose.js';
import { patchWorkflowYaml } from '../../../shared/src/ci-workflow-patch.js';
import type { CiJobSummary, CiRunFacts, CiWorkflowRunSummary } from '../../../shared/src/ci-types.js';
import { log } from '../../../shared/src/http.js';

const AGENT = 'cicd-agent';

function token(): string {
  return (
    process.env['GITHUB_TOKEN'] ??
    process.env['DEPLOY_APP_REPO_WRITE_TOKEN'] ??
    process.env['GITHUB_PAT'] ??
    ''
  );
}

async function ghGet<T>(path: string): Promise<T> {
  const t = token();
  if (!t) throw new Error('GITHUB_TOKEN not configured for cicd-agent');
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${t}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${path} → ${res.status}: ${body.slice(0, 400)}`);
  }
  return res.json() as Promise<T>;
}

async function ghPost<T>(path: string, body?: unknown): Promise<T> {
  const t = token();
  if (!t) throw new Error('GITHUB_TOKEN not configured for cicd-agent');
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${t}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API POST ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

async function ghPut<T>(path: string, body: unknown): Promise<T> {
  const t = token();
  if (!t) throw new Error('GITHUB_TOKEN not configured for cicd-agent');
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${t}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API PUT ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json() as Promise<T>;
}

interface GhWorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  head_branch: string;
  head_sha: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  event: string;
  path?: string;
}

interface GhJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  started_at?: string;
  completed_at?: string;
}

function mapRun(r: GhWorkflowRun): CiWorkflowRunSummary {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    branch: r.head_branch,
    headSha: r.head_sha,
    htmlUrl: r.html_url,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    event: r.event,
  };
}

function mapJob(j: GhJob): CiJobSummary {
  return {
    id: j.id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    htmlUrl: j.html_url,
    startedAt: j.started_at,
    completedAt: j.completed_at,
  };
}

export async function listWorkflows(
  githubRepo: string
): Promise<Array<{ id: number; name: string; path: string }>> {
  const { owner, repo } = parseOwnerRepo(githubRepo);
  const data = await ghGet<{ workflows: Array<{ id: number; name: string; path: string }> }>(
    `/repos/${owner}/${repo}/actions/workflows`
  );
  return data.workflows ?? [];
}

export async function resolveWorkflowFilePath(
  githubRepo: string,
  workflowName: string,
  runPath?: string
): Promise<string | undefined> {
  if (runPath?.startsWith('.github/workflows/')) return runPath;
  const workflows = await listWorkflows(githubRepo);
  const exact = workflows.find((w) => w.name === workflowName);
  if (exact) return exact.path;
  const slug = workflowName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return workflows.find((w) => w.path.toLowerCase().includes(slug))?.path;
}

export async function fetchLatestFailedRun(
  githubRepo: string,
  opts?: { branch?: string; workflowName?: string }
): Promise<CiRunFacts | null> {
  const { owner, repo } = parseOwnerRepo(githubRepo);
  let url = `/repos/${owner}/${repo}/actions/runs?status=completed&per_page=20`;
  if (opts?.branch) url += `&branch=${encodeURIComponent(opts.branch)}`;

  const data = await ghGet<{ workflow_runs: GhWorkflowRun[] }>(url);
  let runs = data.workflow_runs ?? [];
  runs = runs.filter((r) => r.conclusion === 'failure' || r.conclusion === 'cancelled');
  if (opts?.workflowName) {
    runs = runs.filter((r) => r.name.toLowerCase() === opts.workflowName!.toLowerCase());
  }
  const run = runs[0];
  if (!run) return null;
  return fetchRunById(githubRepo, run.id);
}

export async function fetchRunById(githubRepo: string, runId: number): Promise<CiRunFacts> {
  const { owner, repo } = parseOwnerRepo(githubRepo);
  const run = await ghGet<GhWorkflowRun>(`/repos/${owner}/${repo}/actions/runs/${runId}`);
  const jobsData = await ghGet<{ jobs: GhJob[] }>(
    `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=30`
  );
  const failedJobs = (jobsData.jobs ?? [])
    .filter((j) => j.conclusion === 'failure' || j.conclusion === 'cancelled')
    .map(mapJob);

  let logExcerpt = '';
  const failedJob = jobsData.jobs?.find((j) => j.conclusion === 'failure');
  if (failedJob) {
    logExcerpt = await fetchJobLogsPlain(owner, repo, failedJob.id);
  }

  const slug = `${owner}/${repo}`;
  const facts: CiRunFacts = {
    githubRepo: slug,
    workflowRunId: run.id,
    workflowName: run.name,
    branch: run.head_branch,
    headSha: run.head_sha,
    status: run.status,
    conclusion: run.conclusion,
    htmlUrl: run.html_url,
    event: run.event,
    failedJobs,
    logExcerpt: logExcerpt.slice(-6000),
  };
  facts.diagnosis = diagnoseCiRun(facts);
  const workflowPath = await resolveWorkflowFilePath(githubRepo, run.name, run.path);
  if (facts.diagnosis && workflowPath) {
    facts.diagnosis.workflowFilePath = workflowPath;
  }
  return facts;
}

async function fetchJobLogsPlain(owner: string, repo: string, jobId: number): Promise<string> {
  const t = token();
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${t}`,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return '';
  const text = await res.text();
  return text.slice(-6000);
}

export async function rerunWorkflow(githubRepo: string, runId: number): Promise<{ ok: boolean; message: string }> {
  const { owner, repo } = parseOwnerRepo(githubRepo);
  await ghPost(`/repos/${owner}/${repo}/actions/runs/${runId}/rerun`);
  log('info', AGENT, 'Workflow rerun requested', { githubRepo, runId });
  return { ok: true, message: `Re-run requested for workflow run ${runId}` };
}

interface GhContentFile {
  content: string;
  sha: string;
  encoding?: string;
}

async function getFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<{ content: string; sha: string }> {
  const data = await ghGet<GhContentFile>(
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`
  );
  const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
  return { content: decoded, sha: data.sha };
}

export async function openCiFixPr(opts: {
  githubRepo: string;
  branch: string;
  title: string;
  body: string;
  incidentId: string;
  workflowFilePath?: string;
  workflowName?: string;
  logExcerpt?: string;
}): Promise<{ ok: boolean; prUrl?: string; message: string }> {
  const { owner, repo } = parseOwnerRepo(opts.githubRepo);
  const base = opts.branch || 'main';
  const workflowPath =
    opts.workflowFilePath ??
    (opts.workflowName
      ? await resolveWorkflowFilePath(opts.githubRepo, opts.workflowName)
      : undefined);

  if (!workflowPath) {
    return openTrackingIssue(opts, owner, repo, 'Could not resolve workflow file path for PR.');
  }

  let original: { content: string; sha: string };
  try {
    original = await getFileContent(owner, repo, workflowPath, base);
  } catch (err) {
    return openTrackingIssue(
      opts,
      owner,
      repo,
      `Could not read ${workflowPath} on ${base}: ${String(err)}`
    );
  }

  const patched = patchWorkflowYaml(original.content, opts.logExcerpt ?? '');
  if (!patched.patched) {
    return openTrackingIssue(
      opts,
      owner,
      repo,
      `No safe automatic patch for ${workflowPath}. Manual workflow edit required.`
    );
  }

  const headBranch = `sre-bot/ci-fix-${opts.incidentId.slice(0, 8)}`;
  const baseRef = await ghGet<{ object: { sha: string } }>(
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(base)}`
  );
  const baseSha = baseRef.object.sha;

  try {
    await ghPost(`/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${headBranch}`,
      sha: baseSha,
    });
  } catch (err) {
    const msg = String(err);
    if (!msg.includes('422')) throw err;
  }

  const encoded = Buffer.from(patched.content, 'utf-8').toString('base64');
  await ghPut(`/repos/${owner}/${repo}/contents/${encodeURIComponent(workflowPath)}`, {
    message: opts.title,
    content: encoded,
    sha: original.sha,
    branch: headBranch,
  });

  const pr = await ghPost<{ html_url: string; number: number }>(`/repos/${owner}/${repo}/pulls`, {
    title: opts.title,
    head: headBranch,
    base,
    body: [
      opts.body,
      '',
      '### Automated workflow changes',
      patched.changes.map((c) => `- ${c}`).join('\n'),
      '',
      `File: \`${workflowPath}\``,
      '',
      `---\n_incident: ${opts.incidentId}_`,
    ].join('\n'),
  });

  log('info', AGENT, 'Opened CI workflow fix PR', {
    incidentId: opts.incidentId,
    pr: pr.html_url,
    workflowPath,
  });

  return {
    ok: true,
    prUrl: pr.html_url,
    message: `Opened PR #${pr.number} to update \`${workflowPath}\`: ${pr.html_url}`,
  };
}

async function openTrackingIssue(
  opts: {
    title: string;
    body: string;
    incidentId: string;
  },
  owner: string,
  repo: string,
  reason: string
): Promise<{ ok: boolean; prUrl?: string; message: string }> {
  const issue = await ghPost<{ html_url: string; number: number }>(`/repos/${owner}/${repo}/issues`, {
    title: opts.title,
    body: `${opts.body}\n\n---\n**Note:** ${reason}\n\n_incident: ${opts.incidentId}_`,
  });
  return {
    ok: true,
    prUrl: issue.html_url,
    message: `Could not open workflow PR (${reason}). Tracking issue #${issue.number}: ${issue.html_url}`,
  };
}

async function ensureBranch(owner: string, repo: string, base: string, headBranch: string): Promise<void> {
  const baseRef = await ghGet<{ object: { sha: string } }>(
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(base)}`
  );
  try {
    await ghPost(`/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${headBranch}`,
      sha: baseRef.object.sha,
    });
  } catch (err) {
    const msg = String(err);
    if (!msg.includes('422')) throw err;
  }
}

/** Open PR with one or more full-file patches (dependency / code fixes). */
export async function openCiCodeFixPr(opts: {
  githubRepo: string;
  branch: string;
  title: string;
  body: string;
  incidentId: string;
  patches: Array<{ path: string; content: string }>;
}): Promise<{ ok: boolean; prUrl?: string; message: string }> {
  const { owner, repo } = parseOwnerRepo(opts.githubRepo);
  const base = opts.branch || 'main';

  if (!opts.patches.length) {
    return { ok: false, message: 'No patches to apply' };
  }

  const headBranch = `sre-bot/code-fix-${opts.incidentId.slice(0, 8)}`;
  await ensureBranch(owner, repo, base, headBranch);

  const changed: string[] = [];
  for (const patch of opts.patches) {
    let sha: string | undefined;
    try {
      const existing = await getFileContent(owner, repo, patch.path, base);
      sha = existing.sha;
    } catch {
      sha = undefined;
    }
    const encoded = Buffer.from(patch.content, 'utf-8').toString('base64');
    await ghPut(`/repos/${owner}/${repo}/contents/${encodeURIComponent(patch.path)}`, {
      message: opts.title,
      content: encoded,
      ...(sha ? { sha } : {}),
      branch: headBranch,
    });
    changed.push(patch.path);
  }

  const pr = await ghPost<{ html_url: string; number: number }>(`/repos/${owner}/${repo}/pulls`, {
    title: opts.title,
    head: headBranch,
    base,
    body: [
      opts.body,
      '',
      '### Files changed',
      changed.map((p) => `- \`${p}\``).join('\n'),
      '',
      `---\n_incident: ${opts.incidentId}_`,
    ].join('\n'),
  });

  log('info', AGENT, 'Opened CI code fix PR', { incidentId: opts.incidentId, pr: pr.html_url });

  return {
    ok: true,
    prUrl: pr.html_url,
    message: `Opened PR #${pr.number} with ${changed.length} file(s): ${pr.html_url}`,
  };
}

export function githubConfigured(): boolean {
  return Boolean(token());
}
