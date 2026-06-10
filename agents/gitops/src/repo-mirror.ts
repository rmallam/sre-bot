/**
 * repo-mirror.ts — Fixes Issue #5: clone on every request.
 *
 * Maintains a persistent local mirror of the GitOps repo at a stable path
 * (default: /data/gitops-mirror, backed by a PVC in K8s). The repo is cloned
 * once on startup; subsequent operations do a pull --rebase before any mutation.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import simpleGit, { type SimpleGit } from 'simple-git';
import * as YAML from 'yaml';
import jsonpatch from 'fast-json-patch';
import type { Operation } from 'fast-json-patch';
const { applyPatch, deepClone } = jsonpatch;
import { log } from '../../../shared/src/http.js';
import type { JsonPatchOp } from '../../../shared/src/types.js';
import { dryRunValidate } from './validator.js';

const AGENT = 'gitops-agent';

export interface ApplyPatchOpts {
  incidentId: string;
  manifestPath: string;    // relative path inside the repo, e.g. "apps/myapp/deployment.yaml"
  patch: JsonPatchOp[];
  commitMessage: string;
  openPR: boolean;
}

export interface ApplyPatchResult {
  commitSha: string;
  commitUrl: string;
  prUrl?: string;
}

export class RepoMirror {
  private readonly repoUrl: string;
  private readonly repoPath: string;
  private readonly authorName: string;
  private readonly authorEmail: string;
  private git!: SimpleGit;

  constructor() {
    this.repoUrl = process.env['GITOPS_REPO_URL'] ?? '';
    this.repoPath = process.env['GITOPS_REPO_PATH'] ?? '/data/gitops-mirror';
    this.authorName = process.env['GIT_AUTHOR_NAME'] ?? 'sre-bot';
    this.authorEmail = process.env['GIT_AUTHOR_EMAIL'] ?? 'sre-bot@cluster.local';
  }

  /**
   * init() — called once at startup.
   * Clones the repo if the directory does not already contain a git repo,
   * otherwise opens the existing clone and does a pull to catch up.
   */
  async init(): Promise<void> {
    if (!this.repoUrl) {
      log('warn', AGENT, 'GITOPS_REPO_URL is not set — RepoMirror will operate in no-push mode');
    }

    await mkdir(this.repoPath, { recursive: true });

    const isGitRepo = existsSync(join(this.repoPath, '.git'));

    if (!isGitRepo) {
      log('info', AGENT, 'Cloning GitOps repo', { repoUrl: this.repoUrl, repoPath: this.repoPath });

      if (!this.repoUrl) {
        // No repo URL — create an empty local repo (useful for testing / no-push mode)
        this.git = simpleGit(this.repoPath);
        await this.git.init();
        await this.git.addConfig('user.name', this.authorName);
        await this.git.addConfig('user.email', this.authorEmail);
        log('warn', AGENT, 'Initialised empty local git repo (no GITOPS_REPO_URL configured)');
        return;
      }

      this.git = simpleGit();
      await this.git.clone(this.repoUrl, this.repoPath, ['--depth', '1']);
      this.git = simpleGit(this.repoPath);
    } else {
      log('info', AGENT, 'Using existing GitOps repo clone', { repoPath: this.repoPath });
      this.git = simpleGit(this.repoPath);
    }

    // Ensure author identity is set for all subsequent commits
    await this.git.addConfig('user.name', this.authorName);
    await this.git.addConfig('user.email', this.authorEmail);

    // Bring the clone up to date
    if (this.repoUrl) {
      await this.sync();
    }

    log('info', AGENT, 'RepoMirror ready', { repoPath: this.repoPath });
  }

  /**
   * sync() — git pull --rebase origin main.
   * Brings the local mirror up to date before each mutation.
   */
  async sync(): Promise<void> {
    if (!this.repoUrl) {
      log('debug', AGENT, 'sync() skipped — no remote configured');
      return;
    }

    log('info', AGENT, 'Syncing repo mirror (pull --rebase)');
    try {
      await this.git.pull(['--rebase', 'origin', 'HEAD']);
      log('info', AGENT, 'Repo sync complete');
    } catch (err: unknown) {
      log('warn', AGENT, 'git pull --rebase failed — proceeding with local state', {
        error: String(err),
      });
    }
  }

  /**
   * applyPatchAndPush() — core mutation method.
   *
   * 1. Syncs the local mirror.
   * 2. Reads the target YAML manifest.
   * 3. Applies the RFC 6902 JSON Patch.
   * 4. Validates via kubectl dry-run.
   * 5. Commits and pushes (to branch or main depending on openPR).
   */
  async applyPatchAndPush(opts: ApplyPatchOpts): Promise<ApplyPatchResult> {
    const { incidentId, manifestPath, patch, commitMessage, openPR } = opts;

    // ── 1. Sync ──────────────────────────────────────────────────────────────
    await this.sync();

    // ── 2. Read the manifest ─────────────────────────────────────────────────
    const absolutePath = join(this.repoPath, manifestPath);
    log('info', AGENT, 'Reading manifest', { incidentId, absolutePath });

    let parsed: unknown;
    try {
      const rawYaml = await readFile(absolutePath, 'utf8');
      try {
        parsed = YAML.parse(rawYaml);
      } catch (err: unknown) {
        throw new Error(`Failed to parse YAML at "${manifestPath}": ${String(err)}`);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        log('info', AGENT, 'Manifest does not exist. Initializing with empty object for creation.', {
          incidentId,
          manifestPath,
        });
        parsed = {};
      } else {
        throw new Error(
          `Failed to read manifest at "${absolutePath}": ${String(err)}`,
        );
      }
    }

    log('info', AGENT, 'Applying JSON Patch', { incidentId, opCount: patch.length });

    // fast-json-patch mutates a deep clone; we validate patch ops before applying
    const patchResult = applyPatch(
      deepClone(parsed),
      patch as Operation[],
      /* validate */ true,
    );
    const patched = patchResult.newDocument;

    const patchedYaml = YAML.stringify(patched, { lineWidth: 0 });

    // ── 4. Dry-run validation ────────────────────────────────────────────────
    log('info', AGENT, 'Running dry-run validation', { incidentId, manifestPath });
    const validationResult = await dryRunValidate(manifestPath, patchedYaml);
    if (!validationResult.passed) {
      throw new Error(
        `kubectl dry-run validation failed for "${manifestPath}": ${validationResult.error ?? 'unknown error'}`,
      );
    }
    log('info', AGENT, 'Dry-run validation passed', { incidentId });

    // ── 5. Determine target branch ───────────────────────────────────────────
    const targetBranch = openPR ? `sre-bot/${incidentId}` : 'main';

    if (openPR) {
      log('info', AGENT, 'Creating PR branch', { incidentId, targetBranch });
      await this.git.checkoutLocalBranch(targetBranch);
    }

    // ── 6. Write patched YAML to disk and commit ─────────────────────────────
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, patchedYaml, 'utf8');
    log('info', AGENT, 'Patched YAML written to disk', { incidentId, absolutePath });

    await this.git.add(absolutePath);
    await this.git.commit(commitMessage, {
      '--author': `"${this.authorName} <${this.authorEmail}>"`,
    });

    const logResult = await this.git.log({ n: 1 });
    const commitSha = logResult.latest?.hash ?? 'unknown';
    log('info', AGENT, 'Committed patch', { incidentId, commitSha, targetBranch });

    // ── 7. Push ──────────────────────────────────────────────────────────────
    if (this.repoUrl) {
      if (openPR) {
        await this.git.push('origin', targetBranch, ['--set-upstream']);
      } else {
        await this.git.push('origin', 'main');
      }
      log('info', AGENT, 'Push complete', { incidentId, targetBranch });
    } else {
      log('warn', AGENT, 'Push skipped — no GITOPS_REPO_URL configured', { incidentId });
    }

    // ── 8. If PR branch, switch back to main ─────────────────────────────────
    if (openPR) {
      await this.git.checkout('main');
    }

    // ── 9. Build commit URL ──────────────────────────────────────────────────
    const commitUrl = this.repoUrl
      ? `${this.repoUrl.replace(/\.git$/, '')}/commit/${commitSha}`
      : `local://${commitSha}`;

    const prUrl = openPR
      ? `${this.repoUrl.replace(/\.git$/, '')}/compare/${targetBranch}?expand=1`
      : undefined;

    return { commitSha, commitUrl, ...(prUrl ? { prUrl } : {}) };
  }

  async getHeadSha(): Promise<string | undefined> {
    try {
      await this.sync();
      const sha = await this.git.revparse(['HEAD']);
      return sha?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Revert a deploy commit (or reset to previous SHA when revert is not possible).
   */
  async revertDeployCommit(opts: {
    incidentId: string;
    deployGitCommitSha?: string;
    previousGitCommitSha?: string;
    reason: string;
  }): Promise<ApplyPatchResult> {
    await this.sync();
    const message = `sre-bot: auto-revert failed deploy (${opts.incidentId})\n\n${opts.reason.slice(0, 400)}`;

    if (opts.deployGitCommitSha) {
      try {
        await this.git.revert(opts.deployGitCommitSha, ['--no-edit']);
      } catch {
        if (opts.previousGitCommitSha) {
          await this.git.reset(['--hard', opts.previousGitCommitSha]);
        } else {
          throw new Error('git revert failed and no previousGitCommitSha provided');
        }
      }
    } else if (opts.previousGitCommitSha) {
      await this.git.reset(['--hard', opts.previousGitCommitSha]);
    } else {
      throw new Error('revert-deploy requires deployGitCommitSha or previousGitCommitSha');
    }

    const logResult = await this.git.log({ n: 1 });
    const commitSha = logResult.latest?.hash ?? 'unknown';

    if (this.repoUrl) {
      await this.git.push('origin', 'main', ['--force-with-lease']);
      log('info', AGENT, 'Revert push complete', { incidentId: opts.incidentId, commitSha });
    }

    const commitUrl = this.repoUrl
      ? `${this.repoUrl.replace(/\.git$/, '')}/commit/${commitSha}`
      : `local://${commitSha}`;

    return { commitSha, commitUrl };
  }
}
