/**
 * Gather repository file snippets for CI code-fix planning.
 */

import { CI_REPO_CONTEXT_PATHS, type CiRepoContext } from '../../../shared/src/ci-repo-context.js';
import { parseOwnerRepo } from '../../../shared/src/github-repo.js';
import { resolveWorkflowFilePath } from './github.js';

async function token(): Promise<string> {
  const t =
    process.env['GITHUB_TOKEN'] ??
    process.env['DEPLOY_APP_REPO_WRITE_TOKEN'] ??
    process.env['GITHUB_PAT'] ??
    '';
  if (!t) throw new Error('GITHUB_TOKEN not configured');
  return t;
}

async function fetchFile(
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string | null> {
  const t = await token();
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${t}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { content?: string };
  if (!data.content) return null;
  return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
}

export async function gatherCiRepoContext(
  githubRepo: string,
  branch: string,
  workflowName?: string
): Promise<CiRepoContext> {
  const { owner, repo } = parseOwnerRepo(githubRepo);
  const files: CiRepoContext['files'] = [];
  const missingPaths: string[] = [];

  for (const path of CI_REPO_CONTEXT_PATHS) {
    const content = await fetchFile(owner, repo, path, branch);
    if (content) {
      files.push({ path, excerpt: content.slice(0, 8000) });
    } else {
      missingPaths.push(path);
    }
  }

  const workflowFilePath = workflowName
    ? await resolveWorkflowFilePath(githubRepo, workflowName)
    : undefined;

  if (workflowFilePath) {
    const wf = await fetchFile(owner, repo, workflowFilePath, branch);
    if (wf) {
      files.push({ path: workflowFilePath, excerpt: wf.slice(0, 8000) });
    }
  }

  return {
    githubRepo: `${owner}/${repo}`,
    branch,
    files,
    missingPaths,
    workflowFilePath,
  };
}
