/**
 * Normalize and validate deploy commands before POST /runs.
 */

import type { StartRunRequest } from './types.js';
import type { RemoteHelmInstall } from './deploy/readme-install-hints.js';
import { normalizeGithubRepoSlug } from './git-ref.js';

/** Minimal deploy fields — mirrors commander DeployCmd without importing commander. */
export interface DeployCommandInput {
  type: 'deploy';
  githubRepo: string;
  gitRef: string;
  namespace: string;
  deployStrategy: 'gitops' | 'direct';
  deployStrategyExplicit: boolean;
  createNamespace?: boolean;
  containerImage?: string;
  /** Published Helm chart from the built-in catalog (no Git clone). */
  helmRemote?: RemoteHelmInstall;
  appName?: string;
  stackServices?: Array<{ name: string; githubRepo: string; gitRef?: string }>;
}

export interface DeployValidationResult {
  ok: true;
  deploy: DeployCommandInput;
  appName: string;
}

export interface DeployValidationError {
  ok: false;
  userMessage: string;
  missing: Array<'githubRepo' | 'namespace' | 'appName'>;
}

/** App / Deployment name for a Git-based deploy. */
export function deriveDeployAppName(
  deploy: Pick<DeployCommandInput, 'githubRepo' | 'appName' | 'containerImage' | 'helmRemote'>
): string {
  const explicit = deploy.appName?.trim();
  if (explicit) return explicit;

  const helmRelease = deploy.helmRemote?.releaseName?.trim();
  if (helmRelease) return helmRelease;

  const repoSlug = deploy.githubRepo
    ?.replace(/^https?:\/\//, '')
    .replace(/^github\.com\//, '')
    .split('/')
    .pop()
    ?.replace(/\.git$/, '')
    .trim();
  if (repoSlug) return repoSlug;

  const image = deploy.containerImage?.trim();
  if (image) {
    const tail = image.split('/').pop()?.split(':')[0]?.trim();
    if (tail) return tail;
  }

  return 'app';
}

/** Default namespace when the user did not specify one. */
export function defaultDeployNamespace(appName: string): string {
  const name = appName.trim();
  if (!name || name === 'app') return 'default';
  if (name.endsWith('-operator')) return `${name}-system`;
  return 'default';
}

export function normalizeDeployCommand(deploy: DeployCommandInput): DeployCommandInput {
  const githubRepo = deploy.githubRepo?.trim()
    ? normalizeGithubRepoSlug(deploy.githubRepo.trim())
    : '';
  const appName = deriveDeployAppName(deploy);
  const namespaceRaw = deploy.namespace?.trim();
  const namespace =
    namespaceRaw && namespaceRaw.length > 0
      ? namespaceRaw
      : defaultDeployNamespace(appName);

  return {
    ...deploy,
    githubRepo,
    appName,
    namespace,
    gitRef: deploy.gitRef?.trim() || 'main',
  };
}

export function validateDeployCommand(
  deploy: DeployCommandInput
): DeployValidationResult | DeployValidationError {
  const normalized = normalizeDeployCommand(deploy);
  const missing: DeployValidationError['missing'] = [];

  if (!normalized.containerImage && !normalized.githubRepo && !normalized.helmRemote) {
    missing.push('githubRepo');
  }
  if (!normalized.namespace?.trim()) {
    missing.push('namespace');
  }
  const appName = deriveDeployAppName(normalized);
  if (!appName.trim()) {
    missing.push('appName');
  }

  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      userMessage: buildDeployMissingFieldsMessage(missing, normalized),
    };
  }

  return { ok: true, deploy: normalized, appName };
}

export function buildDeployMissingFieldsMessage(
  missing: DeployValidationError['missing'],
  deploy: Partial<DeployCommandInput>
): string {
  if (missing.includes('githubRepo')) {
    return (
      'I need a **GitHub repository** or a **built-in tool name** to deploy.\n\n' +
      'Try:\n' +
      '• `deploy argocd` or `deploy redis in my-ns namespace`\n' +
      '• `deploy github.com/org/my-app to staging namespace`\n' +
      '• `deploy https://github.com/org/my-app on branch main`'
    );
  }

  if (missing.includes('namespace')) {
    const repo = deploy.githubRepo?.replace(/^github\.com\//, '') ?? 'org/app';
    return (
      'Which **namespace** should I deploy into?\n\n' +
      `Example: \`deploy ${repo} to frappe-operator-system namespace\`\n` +
      'Or add `--namespace my-ns`.'
    );
  }

  return (
    'I could not figure out the **app name** for this deploy.\n\n' +
    'Include a GitHub URL or catalog app, e.g. `deploy github.com/org/frappe-operator to default namespace`.'
  );
}

export function validateStartRunRequest(
  req: Partial<StartRunRequest>
): { ok: true } | { ok: false; userMessage: string; missing: string[] } {
  const missing: string[] = [];
  if (!req.incidentId?.trim()) missing.push('incidentId');
  if (!req.namespace?.trim()) missing.push('namespace');
  if (!req.resourceName?.trim()) missing.push('resourceName');

  if (missing.length === 0) return { ok: true };

  const userMessage =
    missing.includes('namespace') || missing.includes('resourceName')
      ? buildDeployMissingFieldsMessage(
          [
            ...(missing.includes('namespace') ? (['namespace'] as const) : []),
            ...(missing.includes('resourceName') ? (['appName'] as const) : []),
          ],
          {
            githubRepo: req.githubRepo,
            namespace: req.namespace,
          }
        )
      : `Internal error: missing ${missing.join(', ')} for this run. Please try again.`;

  return { ok: false, userMessage, missing };
}

/** Map raw orchestrator/API errors to user-facing deploy messages. */
export function formatDeployDispatchError(
  err: unknown,
  context?: Partial<StartRunRequest>
): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/incidentId, namespace, resourceName required/i.test(raw)) {
    const check = validateStartRunRequest(context ?? {});
    if (!check.ok) return check.userMessage;
    return (
      'I could not start the deploy — the request was incomplete.\n\n' +
      'Include a GitHub URL and target namespace, e.g.:\n' +
      '`deploy github.com/vyogotech/frappe-operator to frappe-operator-system namespace`'
    );
  }
  if (/Orchestrator rejected run/i.test(raw)) {
    return raw.replace(/^Error:\s*/i, '').replace(/Orchestrator rejected run \(\d+\)/, 'Deploy failed');
  }
  return raw.replace(/^Error:\s*/i, '');
}
