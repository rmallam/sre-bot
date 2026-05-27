import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import simpleGit from 'simple-git';
import type { RemediationPlan } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { toHttpsCloneUrl } from './app-repo.js';

const execFile = promisify(execFileCb);
const DIRECT_DRY_RUN = (process.env['DIRECT_DEPLOY_DRY_RUN'] ?? 'true').toLowerCase() === 'true';

export async function applyRepoDirect(opts: {
  incidentId: string;
  namespace: string;
  resourceName: string;
  plan: RemediationPlan;
  dryRun?: boolean;
}): Promise<void> {
  const useDryRun = opts.dryRun ?? DIRECT_DRY_RUN;
  const token = process.env['DEPLOY_APP_REPO_WRITE_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? '';
  const repoUrl = opts.plan.githubRepo;
  if (!repoUrl) {
    throw new Error('repo_apply requires githubRepo');
  }
  const gitRef = opts.plan.gitRef ?? 'main';
  const cloneUrl = toHttpsCloneUrl(repoUrl, token || undefined);
  const tmpDir = await mkdtemp(join(tmpdir(), `sre-direct-${opts.incidentId}-`));

  try {
    const git = simpleGit();
    await git.clone(cloneUrl, tmpDir, ['--depth', '1', '--branch', gitRef]);

    if (opts.plan.helmChart?.files && Object.keys(opts.plan.helmChart.files).length > 0) {
      for (const [rel, content] of Object.entries(opts.plan.helmChart.files)) {
        const abs = join(tmpDir, rel);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, 'utf-8');
      }
    }

    const relPath = opts.plan.targetManifestPath;
    const absPath = resolve(tmpDir, relPath);
    if (!absPath.startsWith(resolve(tmpDir))) {
      throw new Error('targetManifestPath escapes cloned repository');
    }

    if (/\/Chart\.ya?ml$/i.test(relPath)) {
      const chartDir = dirname(absPath);
      if (useDryRun) {
        await run(
          'helm',
          ['upgrade', '--install', opts.resourceName, chartDir, '--namespace', opts.namespace, '--create-namespace', '--dry-run'],
          opts.incidentId,
        );
      }
      await run(
        'helm',
        ['upgrade', '--install', opts.resourceName, chartDir, '--namespace', opts.namespace, '--create-namespace'],
        opts.incidentId,
      );
      return;
    }

    if (/kustomization\.ya?ml$/i.test(relPath)) {
      if (useDryRun) {
        await run('kubectl', ['apply', '-k', dirname(absPath), '--namespace', opts.namespace, '--dry-run=server'], opts.incidentId);
      }
      await run('kubectl', ['apply', '-k', dirname(absPath), '--namespace', opts.namespace], opts.incidentId);
      return;
    }

    if (!existsSync(absPath)) {
      throw new Error(`target manifest path not found in repository: ${relPath}`);
    }
    if (useDryRun) {
      await run('kubectl', ['apply', '-f', absPath, '--namespace', opts.namespace, '--dry-run=server'], opts.incidentId);
    }
    await run('kubectl', ['apply', '-f', absPath, '--namespace', opts.namespace], opts.incidentId);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function run(cmd: string, args: string[], incidentId: string): Promise<void> {
  try {
    const { stdout, stderr } = await execFile(cmd, args, { timeout: 120_000 });
    log('info', 'gitops-agent', `Direct deploy command succeeded: ${cmd}`, {
      incidentId,
      stdout: stdout?.slice(0, 4000),
      stderr: stderr?.slice(0, 2000),
    });
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    throw new Error(`${cmd} failed: ${msg}`);
  }
}
