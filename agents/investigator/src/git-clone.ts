import simpleGit from 'simple-git';
import {
  cloneWithRefFallback,
  gitAuthOrMissingRepoError,
  isGitCloneTarget,
  toHttpsCloneUrl,
} from '../../../shared/src/git-ref.js';
import { log } from '../../../shared/src/http.js';

const AGENT = 'investigator';

export interface ShallowCloneResult {
  tmpDir: string;
  resolvedRef: string;
  attemptedRefs: string[];
}

/**
 * Shallow-clone a repo, falling back to the remote default branch when the requested ref is missing.
 */
export async function shallowCloneRepo(
  repoUrl: string,
  requestedRef: string,
  tmpDir: string,
  incidentId: string
): Promise<
  | { ok: true; resolvedRef: string; attemptedRefs: string[] }
  | { ok: false; error: string; attemptedRefs: string[] }
> {
  if (!isGitCloneTarget(repoUrl)) {
    return {
      ok: false,
      error: 'No Git repository to clone for this deploy',
      attemptedRefs: [],
    };
  }

  const cloneUrl = toHttpsCloneUrl(repoUrl);
  const gitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
  };

  log('info', AGENT, 'Cloning deploy target repo', {
    incidentId,
    repoUrl: cloneUrl,
    gitRef: requestedRef,
    tmpDir,
  });

  const result = await cloneWithRefFallback(
    cloneUrl,
    requestedRef,
    async (ref, dest) => {
      const git = simpleGit().env(gitEnv);
      await git.clone(cloneUrl, dest, ['--depth', '1', '--branch', ref]);
    },
    tmpDir
  );

  if (result.ok && result.resolvedRef) {
    if (result.resolvedRef !== requestedRef) {
      log('info', AGENT, 'Used fallback git ref for clone', {
        incidentId,
        requestedRef,
        resolvedRef: result.resolvedRef,
        attemptedRefs: result.attemptedRefs,
      });
    }
    return {
      ok: true,
      resolvedRef: result.resolvedRef,
      attemptedRefs: result.attemptedRefs,
    };
  }

  log('error', AGENT, 'Failed to clone deploy target repo', {
    incidentId,
    repoUrl: cloneUrl,
    gitRef: requestedRef,
    attemptedRefs: result.attemptedRefs,
    error: result.error,
  });

  const friendly = gitAuthOrMissingRepoError(result.error);
  return {
    ok: false,
    error: friendly ?? result.error ?? 'Clone failed',
    attemptedRefs: result.attemptedRefs,
  };
}
