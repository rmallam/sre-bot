import {
  cloneWithRefFallback,
  execShallowGitClone,
  gitAuthOrMissingRepoError,
  isGitCloneTarget,
  normalizeGithubRepoSlug,
  normalizeRequestedGitRef,
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

  log('info', AGENT, 'Cloning deploy target repo', {
    incidentId,
    repoUrl: cloneUrl,
    gitRef: gitRef,
    tmpDir,
  });

  const result = await cloneWithRefFallback(
    cloneUrl,
    gitRef,
    (ref, dest) => execShallowGitClone(cloneUrl, ref, dest),
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
