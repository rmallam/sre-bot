/**
 * Ignore keys for suppressed incidents — same resource won't be re-remediated.
 */

import type { ApprovalRequest } from './types.js';

export interface IgnoredResource {
  key: string;
  namespace: string;
  resourceName: string;
  resourceKind?: string;
  githubRepo?: string;
  ignoredAt: string;
  ignoredBy: string;
  ignoredVia: string;
  sourceIncidentId: string;
  reason?: string;
}

export function resourceIgnoreKey(namespace: string, resourceName: string): string {
  return `${namespace}/${resourceName}`;
}

export function ciIgnoreKey(githubRepo: string): string {
  const slug = githubRepo.replace(/^github\.com\//i, '').replace(/\.git$/i, '');
  return `ci/${slug}`;
}

/** All ignore keys that apply to an approval / run request. */
export function ignoreKeysForApproval(request: ApprovalRequest): string[] {
  const keys = new Set<string>();
  keys.add(resourceIgnoreKey(request.namespace, request.resourceName));
  const repo = request.plan.githubRepo?.trim();
  if (repo) {
    keys.add(ciIgnoreKey(repo));
  }
  if (request.mode === 'ci-failure' && request.namespace === 'ci') {
    keys.add(resourceIgnoreKey('ci', request.resourceName));
  }
  return [...keys];
}

export function ignoreKeysForRun(opts: {
  namespace: string;
  resourceName: string;
  githubRepo?: string;
  mode?: string;
}): string[] {
  const keys = new Set<string>();
  keys.add(resourceIgnoreKey(opts.namespace, opts.resourceName));
  if (opts.githubRepo?.trim()) {
    keys.add(ciIgnoreKey(opts.githubRepo));
  }
  return [...keys];
}
