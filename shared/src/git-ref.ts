/**
 * Git ref resolution — detect default branch and build fallback lists for clone.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** True when deploy should clone a real Git remote (not catalog/image-only). */
export function isGitCloneTarget(repo: string | undefined | null): boolean {
  const t = repo?.trim() ?? '';
  if (!t) return false;
  const lower = t.toLowerCase();
  if (lower === 'catalog/local' || lower === '__catalog__' || lower === 'local') return false;
  return true;
}

export function gitAuthOrMissingRepoError(err: unknown): string | null {
  const msg = String(err);
  if (/could not read Username for/i.test(msg)) {
    return (
      'Git could not access the repository (private repo needs GITHUB_TOKEN, or the repo URL may be wrong). ' +
      'Public repos should use https://github.com/org/repo — catalog apps like httpd need no Git URL.'
    );
  }
  if (/Repository not found|not found/i.test(msg) && /github/i.test(msg)) {
    return 'GitHub repository not found — check org/repo name and that the repo is public (or set GITHUB_TOKEN).';
  }
  return null;
}

/** Normalize github.com/org/repo or full URL to an HTTPS clone URL (no token). */
export function toHttpsCloneUrl(repo: string): string {
  let slug = repo.trim().replace(/^https?:\/\//, '').replace(/\.git$/i, '');
  if (!slug.includes('github.com/')) {
    slug = `github.com/${slug.replace(/^github\.com\//, '')}`;
  }
  return `https://${slug}`;
}

export function branchNotFoundError(err: unknown): boolean {
  const msg = String(err);
  return (
    /Remote branch .+ not found/i.test(msg) ||
    /couldn't find remote ref/i.test(msg) ||
    /not found in upstream origin/i.test(msg) ||
    /invalid reference/i.test(msg)
  );
}

/** Query remote HEAD symref for the repository default branch. */
export async function detectDefaultBranch(cloneUrl: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-remote', '--symref', cloneUrl, 'HEAD'],
      { timeout: 45_000, maxBuffer: 1024 * 1024 }
    );
    const symref = stdout.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/);
    if (symref?.[1]) return symref[1];
    const headSha = stdout.match(/^([0-9a-f]{40})\s+HEAD/m);
    if (headSha) {
      const { stdout: heads } = await execFileAsync(
        'git',
        ['ls-remote', '--heads', cloneUrl],
        { timeout: 45_000, maxBuffer: 1024 * 1024 }
      );
      for (const line of heads.split('\n')) {
        const m = line.match(/^([0-9a-f]{40})\s+refs\/heads\/(\S+)/);
        if (m?.[1] === headSha[1]) return m[2] ?? null;
      }
    }
  } catch {
    /* network / git unavailable */
  }
  return null;
}

/** Ordered unique refs to try when cloning (requested ref first, then remote default, then common names). */
export async function buildCloneRefCandidates(
  requestedRef: string | undefined,
  cloneUrl: string
): Promise<string[]> {
  const refs: string[] = [];
  const add = (r: string | undefined | null) => {
    const t = r?.trim();
    if (t && !refs.includes(t)) refs.push(t);
  };

  add(requestedRef || 'main');
  add(await detectDefaultBranch(cloneUrl));
  for (const fb of ['main', 'master', 'develop', 'trunk']) add(fb);

  return refs;
}

export interface CloneRefResult {
  ok: boolean;
  resolvedRef?: string;
  attemptedRefs: string[];
  error?: string;
}

/** Try shallow clone with ref fallbacks; caller supplies clone(ref, dest) implementation. */
export async function cloneWithRefFallback(
  cloneUrl: string,
  requestedRef: string | undefined,
  cloneFn: (ref: string, dest: string) => Promise<void>,
  dest: string
): Promise<CloneRefResult> {
  const attemptedRefs = await buildCloneRefCandidates(requestedRef, cloneUrl);
  let lastError: unknown;

  for (const ref of attemptedRefs) {
    try {
      await cloneFn(ref, dest);
      return { ok: true, resolvedRef: ref, attemptedRefs };
    } catch (err) {
      lastError = err;
      if (!branchNotFoundError(err)) break;
    }
  }

  return {
    ok: false,
    attemptedRefs,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}
