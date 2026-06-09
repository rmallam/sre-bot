/**
 * HIL gate for untrusted repo source builds (DEPLOY-2e).
 */

import type { SourceBuildStrategy } from './runtime-detect.js';

export interface SourceBuildPending {
  githubRepo: string;
  gitRef: string;
  appName: string;
  namespace: string;
  runtime: string;
  strategy: SourceBuildStrategy;
  targetImage: string;
}

export function sourceBuildEnabled(): boolean {
  return (process.env['SOURCE_BUILD_ENABLED'] ?? 'false').toLowerCase() === 'true';
}

export function sourceBuildRequiresHil(githubRepo?: string): boolean {
  const raw = (process.env['SOURCE_BUILD_REQUIRE_HIL'] ?? 'true').toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no') return false;

  const allowlist = (process.env['SOURCE_BUILD_TRUSTED_REPOS'] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (!githubRepo || allowlist.length === 0) return true;

  const normalizeRepo = (value: string): string =>
    value
      .replace(/^https?:\/\//, '')
      .replace(/^github\.com\//, '')
      .toLowerCase()
      .replace(/\.git$/, '');

  const repo = normalizeRepo(githubRepo);

  return !allowlist.some((entry) => {
    const normalized = normalizeRepo(entry);
    return (
      repo === normalized ||
      repo.startsWith(`${normalized}/`) ||
      normalized.startsWith(`${repo}/`)
    );
  });
}

export function shouldRunSourceBuild(opts: {
  mode?: string;
  needsImageBuild?: boolean;
  buildStrategy?: SourceBuildStrategy;
  suggestedImage?: string;
}): boolean {
  if (opts.mode !== 'pre-deploy') return false;
  if (!opts.needsImageBuild) return false;
  if (opts.buildStrategy === 'skip') return false;
  if (opts.suggestedImage) return false;
  return sourceBuildEnabled();
}
