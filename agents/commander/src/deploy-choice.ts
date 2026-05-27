import { v4 as uuidv4 } from 'uuid';
import type { DeployCmd } from './parser.js';

const INVESTIGATOR_URL = process.env['INVESTIGATOR_URL'] ?? 'http://investigator-agent:8080';
const CHOICE_TTL_MS = parseInt(process.env['DEPLOY_CHOICE_TTL_MS'] ?? '180000', 10);

interface DeployFindings {
  needsHelmGeneration?: boolean;
  repoEntryPointKind?: 'helm' | 'kustomize' | 'plain-yaml' | 'unknown';
  gitManifestPath?: string;
}

interface PendingChoice {
  platform: 'telegram' | 'slack';
  channelId: string;
  userId: string;
  deploy: DeployCmd;
  findings?: DeployFindings;
  expiresAt: number;
}

const pending = new Map<string, PendingChoice>();

function key(platform: string, channelId: string, userId: string): string {
  return `${platform}:${channelId}:${userId}`;
}

export async function buildDeployChoicePrompt(
  platform: 'telegram' | 'slack',
  channelId: string,
  userId: string,
  deploy: DeployCmd
): Promise<string> {
  const findings = await fetchRepoFindings(deploy);
  const k = key(platform, channelId, userId);
  pending.set(k, {
    platform,
    channelId,
    userId,
    deploy,
    findings,
    expiresAt: Date.now() + CHOICE_TTL_MS,
  });

  const discovered = findings
    ? findings.needsHelmGeneration
      ? 'No K8s manifests found; Helm chart generation is needed.'
      : `Found ${findings.repoEntryPointKind ?? 'manifest'} entrypoint at ${findings.gitManifestPath ?? 'repo root'}.`
    : 'Could not fully inspect repo; deploy options are still available.';

  const recommendation = findings?.needsHelmGeneration
    ? 'Recommended: GitOps (creates chart + Argo CD app with audit trail).'
    : 'You can choose GitOps (managed/audited) or Direct apply (fast, no Git push).';

  return [
    `I checked \`${deploy.githubRepo}\` @ \`${deploy.gitRef}\` for namespace \`${deploy.namespace}\`.`,
    discovered,
    recommendation,
    '',
    'Reply with one option:',
    '1 or `gitops`  → push to Git/Argo CD',
    '2 or `direct`  → apply directly (no Git push)',
    '`cancel`       → abort deploy',
  ].join('\n');
}

export function tryResolvePendingChoice(
  platform: 'telegram' | 'slack',
  channelId: string,
  userId: string,
  text: string
): { status: 'none' | 'cancelled' | 'selected'; deploy?: DeployCmd } {
  const normalized = text.trim().toLowerCase();
  if (['cancel', 'stop', 'abort', 'no'].includes(normalized)) {
    return resolvePendingChoiceSelection(platform, channelId, userId, 'cancel');
  }
  if (normalized === '1' || normalized === 'gitops') {
    return resolvePendingChoiceSelection(platform, channelId, userId, 'gitops');
  }
  if (normalized === '2' || normalized === 'direct') {
    return resolvePendingChoiceSelection(platform, channelId, userId, 'direct');
  }
  return { status: 'none' };
}

export function resolvePendingChoiceSelection(
  platform: 'telegram' | 'slack',
  channelId: string,
  userId: string,
  selection: 'gitops' | 'direct' | 'cancel'
): { status: 'none' | 'cancelled' | 'selected'; deploy?: DeployCmd } {
  const k = key(platform, channelId, userId);
  const entry = pending.get(k);
  if (!entry) return { status: 'none' };
  if (Date.now() > entry.expiresAt) {
    pending.delete(k);
    return { status: 'none' };
  }
  if (selection === 'cancel') {
    pending.delete(k);
    return { status: 'cancelled' };
  }

  pending.delete(k);
  return {
    status: 'selected',
    deploy: {
      ...entry.deploy,
      deployStrategy: selection,
      deployStrategyExplicit: true,
    },
  };
}

async function fetchRepoFindings(deploy: DeployCmd): Promise<DeployFindings | undefined> {
  const params = new URLSearchParams({
    namespace: deploy.namespace,
    resourceName: deploy.githubRepo.split('/').pop() ?? 'app',
    resourceKind: 'Deployment',
    incidentId: `choice-${uuidv4()}`,
    mode: 'pre-deploy',
    githubRepo: deploy.githubRepo,
    gitRef: deploy.gitRef,
  });

  const res = await fetch(`${INVESTIGATOR_URL}/facts?${params.toString()}`, {
    signal: AbortSignal.timeout(45_000),
  }).catch(() => null);
  if (!res || !res.ok) return undefined;

  const body = (await res.json()) as {
    needsHelmGeneration?: boolean;
    repoEntryPointKind?: 'helm' | 'kustomize' | 'plain-yaml' | 'unknown';
    gitManifestPath?: string;
  };
  return {
    needsHelmGeneration: body.needsHelmGeneration,
    repoEntryPointKind: body.repoEntryPointKind,
    gitManifestPath: body.gitManifestPath,
  };
}
