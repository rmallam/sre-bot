/**
 * Push Helm chart files to the application repository.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import simpleGit from 'simple-git';
import { log } from '../../../shared/src/http.js';

const AGENT = 'gitops-agent';

/** Normalize github.com/org/repo or full URL to an HTTPS clone URL. */
export function toHttpsCloneUrl(repo: string, token?: string): string {
  let slug = repo.trim().replace(/^https?:\/\//, '').replace(/\.git$/i, '');
  if (!slug.includes('github.com/')) {
    slug = `github.com/${slug.replace(/^github\.com\//, '')}`;
  }
  const base = `https://${slug}`;
  if (token) {
    return base.replace('https://', `https://${token}@`);
  }
  return base;
}

export interface AppRepoPushOpts {
  incidentId: string;
  githubRepo: string;
  gitRef: string;
  files: Record<string, string>;
  commitMessage: string;
}

export interface AppRepoPushResult {
  commitSha?: string;
  commitUrl?: string;
}

export async function pushHelmToAppRepo(opts: AppRepoPushOpts): Promise<AppRepoPushResult> {
  const token = process.env['DEPLOY_APP_REPO_WRITE_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? '';
  const pushEnabled = (process.env['DEPLOY_PUSH_APP_REPO'] ?? 'true').toLowerCase() === 'true';

  if (!pushEnabled) {
    log('info', AGENT, 'App repo push disabled', { incidentId: opts.incidentId });
    return {};
  }

  const cloneUrl = toHttpsCloneUrl(opts.githubRepo, token || undefined);

  const tmpDir = join('/tmp', `sre-app-repo-${opts.incidentId}`);
  await mkdir(tmpDir, { recursive: true });

  const git = simpleGit();
  try {
    if (!existsSync(join(tmpDir, '.git'))) {
      await git.clone(cloneUrl, tmpDir, ['--depth', '1', '--branch', opts.gitRef]);
    }
    const repoGit = simpleGit(tmpDir);

    for (const [relPath, content] of Object.entries(opts.files)) {
      const full = join(tmpDir, relPath);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, 'utf-8');
    }

    await repoGit.add('.');
    await repoGit.commit(opts.commitMessage);
    await repoGit.push('origin', opts.gitRef);

    const logOut = await repoGit.log(['-1']);
    const sha = logOut.latest?.hash;

    log('info', AGENT, 'Pushed Helm chart to app repo', {
      incidentId: opts.incidentId,
      sha,
      githubRepo: opts.githubRepo,
    });

    const webRepo = opts.githubRepo.replace(/^https?:\/\//, '').replace(/\.git$/i, '');
    const slug = webRepo.includes('github.com/') ? webRepo : `github.com/${webRepo}`;

    return {
      commitSha: sha,
      commitUrl: sha ? `https://${slug}/commit/${sha}` : undefined,
    };
  } catch (err) {
    log('error', AGENT, 'App repo push failed', { incidentId: opts.incidentId, error: String(err) });
    throw err;
  }
}

export function buildArgoApplicationManifest(opts: {
  appName: string;
  namespace: string;
  githubRepo: string;
  chartPath: string;
  targetRevision: string;
}): string {
  const repoSlug = opts.githubRepo.replace(/^https?:\/\//, '').replace(/\.git$/i, '');
  return `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${opts.appName}
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://${repoSlug}
    path: ${opts.chartPath}
    targetRevision: ${opts.targetRevision}
  destination:
    server: https://kubernetes.default.svc
    namespace: ${opts.namespace}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
`;
}
