import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { Platform } from '../../../shared/src/types.js';
import type { RemediationPlan } from '../../../shared/src/types.js';
import {
  cloneWithRefFallback,
  execShallowGitClone,
  gitAuthOrMissingRepoError,
  isGitCloneTarget,
} from '../../../shared/src/git-ref.js';
import { sendDeployProgress, type DeployNotifyTarget } from '../../../shared/src/deploy-notify.js';
import {
  deployReadyPromiseMessage,
  watchDeployReadinessAndNotify,
} from '../../../shared/src/deploy-readiness-watch.js';
import { log } from '../../../shared/src/http.js';
import { toHttpsCloneUrl } from './app-repo.js';
import { applyHelmChartWithFallbacks } from './chart-apply.js';
import { ensureNamespace } from './ensure-namespace.js';

const execFile = promisify(execFileCb);
const DIRECT_DRY_RUN = (process.env['DIRECT_DEPLOY_DRY_RUN'] ?? 'false').toLowerCase() === 'true';

export async function applyRepoDirect(opts: {
  incidentId: string;
  namespace: string;
  resourceName: string;
  plan: RemediationPlan;
  dryRun?: boolean;
  createNamespace?: boolean;
  platform?: Platform;
  channelId?: string;
  /** When set, orchestrator verify node owns readiness notifications. */
  orchestratorManaged?: boolean;
}): Promise<void> {
  const useDryRun = opts.dryRun ?? DIRECT_DRY_RUN;
  const notify: DeployNotifyTarget = {
    incidentId: opts.incidentId,
    platform: opts.platform,
    channelId: opts.channelId,
  };

  const scheduleReadinessNotify = (): void => {
    if (opts.orchestratorManaged || !notify.platform || !notify.channelId) return;
    watchDeployReadinessAndNotify({
      target: notify,
      namespace: opts.namespace,
      resourceName: opts.resourceName,
      sendPromise: false,
    });
  };

  const promiseDeployProgress = async (): Promise<void> => {
    if (notify.platform && notify.channelId) {
      await sendDeployProgress(
        notify,
        deployReadyPromiseMessage(opts.resourceName, opts.namespace)
      );
    }
    scheduleReadinessNotify();
  };

  const token = process.env['DEPLOY_APP_REPO_WRITE_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? '';
  const repoUrl = opts.plan.githubRepo;
  const gitRef = opts.plan.gitRef ?? 'main';
  const helmFiles = opts.plan.helmChart?.files;
  const hasGeneratedChart =
    !!helmFiles && Object.keys(helmFiles).length > 0;
  const catalogOnly = !isGitCloneTarget(repoUrl);

  if (catalogOnly && !hasGeneratedChart) {
    throw new Error(
      'repo_apply has no Git repository and no generated Helm chart — use a catalog app (e.g. deploy httpd) or github.com/org/repo'
    );
  }

  const tmpDir = await mkdtemp(join(tmpdir(), `sre-direct-${opts.incidentId}-`));

  try {
    if (opts.createNamespace) {
      await ensureNamespace({
        namespace: opts.namespace,
        incidentId: opts.incidentId,
        notify,
      });
    }

    if (catalogOnly) {
      await sendDeployProgress(
        notify,
        `Deploying from container image (no Git clone)…`
      );
      for (const [rel, content] of Object.entries(helmFiles!)) {
        const abs = join(tmpDir, rel);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, 'utf-8');
      }
    } else {
      const cloneUrl = toHttpsCloneUrl(repoUrl!, token || undefined);

      await sendDeployProgress(notify, `Cloning ${repoUrl} (ref: ${gitRef})…`);

      const cloneResult = await cloneWithRefFallback(
        cloneUrl.replace(/\/\/[^@]+@/, '//'),
        gitRef,
        (ref, dest) => execShallowGitClone(cloneUrl, ref, dest),
        tmpDir
      );
      if (!cloneResult.ok) {
        const hint = gitAuthOrMissingRepoError(cloneResult.error);
        throw new Error(
          hint ??
            `Clone failed (tried: ${cloneResult.attemptedRefs.join(', ')}): ${cloneResult.error}`
        );
      }
      const effectiveRef = cloneResult.resolvedRef ?? gitRef;
      if (effectiveRef !== gitRef) {
        await sendDeployProgress(
          notify,
          `Branch "${gitRef}" not found — using "${effectiveRef}" instead.`
        );
      } else {
        await sendDeployProgress(notify, `Repository cloned successfully (branch ${effectiveRef}).`);
      }

      if (hasGeneratedChart) {
        await sendDeployProgress(notify, 'No usable manifests in repo — using generated Helm chart.');
        for (const [rel, content] of Object.entries(helmFiles!)) {
          const abs = join(tmpDir, rel);
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, content, 'utf-8');
        }
      }
    }

    const relPath = opts.plan.targetManifestPath;
    const absPath = resolve(tmpDir, relPath);
    if (!absPath.startsWith(resolve(tmpDir))) {
      throw new Error('targetManifestPath escapes cloned repository');
    }

    if (/\/Chart\.ya?ml$/i.test(relPath)) {
      const chartDir = dirname(absPath);
      const method = await applyHelmChartWithFallbacks({
        chartDir,
        releaseName: opts.resourceName,
        namespace: opts.namespace,
        incidentId: opts.incidentId,
        dryRun: useDryRun,
        createNamespace: opts.createNamespace,
        notify,
      });
      log('info', 'gitops-agent', 'Helm chart deployed', {
        incidentId: opts.incidentId,
        method,
        namespace: opts.namespace,
      });
      await promiseDeployProgress();
      return;
    }

    if (/kustomization\.ya?ml$/i.test(relPath)) {
      await sendDeployProgress(notify, `Applying Kustomize overlay to namespace ${opts.namespace}…`);
      if (useDryRun) {
        await run(
          'kubectl',
          ['apply', '-k', dirname(absPath), '--namespace', opts.namespace, '--dry-run=server'],
          opts.incidentId
        );
      }
      await run('kubectl', ['apply', '-k', dirname(absPath), '--namespace', opts.namespace], opts.incidentId);
      await promiseDeployProgress();
      return;
    }

    if (!existsSync(absPath)) {
      throw new Error(`target manifest path not found in repository: ${relPath}`);
    }
    await sendDeployProgress(notify, `Applying manifest ${relPath} to namespace ${opts.namespace}…`);
    if (useDryRun) {
      await run(
        'kubectl',
        ['apply', '-f', absPath, '--namespace', opts.namespace, '--dry-run=server'],
        opts.incidentId
      );
    }
    await run('kubectl', ['apply', '-f', absPath, '--namespace', opts.namespace], opts.incidentId);
    await promiseDeployProgress();
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
