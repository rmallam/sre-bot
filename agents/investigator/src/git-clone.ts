import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import {
  cloneWithRefFallback,
  gitAuthOrMissingRepoError,
  isGitCloneTarget,
  normalizeGithubRepoSlug,
  normalizeRequestedGitRef,
  toHttpsCloneUrl,
} from '../../../shared/src/git-ref.js';
import { log } from '../../../shared/src/http.js';

const execFile = promisify(execFileCb);
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
  const normalizedRepo = normalizeGithubRepoSlug(repoUrl);
  if (!isGitCloneTarget(normalizedRepo)) {
    return {
      ok: false,
      error: 'No Git repository to clone for this deploy',
      attemptedRefs: [],
    };
  }

  const cloneUrl = toHttpsCloneUrl(normalizedRepo);
  const gitRef = normalizeRequestedGitRef(requestedRef) ?? requestedRef;
  const gitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    EDITOR: 'true',
    GIT_EDITOR: 'true',
  };

  log('info', AGENT, 'Cloning deploy target repo', {
    incidentId,
    repoUrl: cloneUrl,
    gitRef: gitRef,
    tmpDir,
  });

  const result = await cloneWithRefFallback(
    cloneUrl,
    gitRef,
    async (ref, dest) => {
      await execFile(
        'git',
        ['clone', '--depth', '1', '--branch', ref, cloneUrl, dest],
        {
          env: gitEnv,
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
        }
      );
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
