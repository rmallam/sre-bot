/**
 * Reusable approval prompts for creating missing resources before deploy.
 *
 * Current executable action: namespace creation.
 * Other resource kinds can still be prompted and tracked for future handlers.
 */

import type { DeployCmd } from './parser.js';
import { rememberDeployDraft } from './conversation.js';

const INVESTIGATOR_URL = process.env['INVESTIGATOR_URL'] ?? 'http://investigator-agent:8080';
const CHOICE_TTL_MS = parseInt(process.env['NAMESPACE_PROMPT_TTL_MS'] ?? '300000', 10);

export type CreateResourceKind =
  | 'namespace'
  | 'configmap'
  | 'secret'
  | 'serviceaccount'
  | 'crd'
  | 'other';

export interface CreateResourceRequest {
  kind: CreateResourceKind;
  name: string;
  namespace?: string;
  reason?: string;
}

interface PendingResourceChoice {
  platform: 'telegram' | 'slack';
  channelId: string;
  userId: string;
  deploy: DeployCmd;
  resource: CreateResourceRequest;
  expiresAt: number;
}

const pending = new Map<string, PendingResourceChoice>();

function key(platform: string, channelId: string, userId: string): string {
  return `${platform}:${channelId}:${userId}`;
}

export async function namespaceExists(namespace: string): Promise<boolean> {
  const params = new URLSearchParams({
    namespace,
    incidentId: `ns-check-${Date.now()}`,
  });
  const res = await fetch(`${INVESTIGATOR_URL}/namespace-check?${params}`, {
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res?.ok) return true;
  const body = (await res.json()) as { exists?: boolean };
  return body.exists === true;
}

/** Returns true if user must confirm namespace creation before deploy proceeds. */
export async function needsNamespaceCreatePrompt(deploy: DeployCmd): Promise<boolean> {
  if (deploy.createNamespace) return false;
  const exists = await namespaceExists(deploy.namespace);
  return !exists;
}

export function storeResourceCreatePrompt(
  platform: 'telegram' | 'slack',
  channelId: string,
  userId: string,
  deploy: DeployCmd,
  resource: CreateResourceRequest
): void {
  const k = key(platform, channelId, userId);
  pending.set(k, {
    platform,
    channelId,
    userId,
    deploy,
    resource,
    expiresAt: Date.now() + CHOICE_TTL_MS,
  });
  void rememberDeployDraft(platform, channelId, userId, deploy);
}

export function buildResourceCreatePrompt(resource: CreateResourceRequest): string {
  const scoped =
    resource.namespace && resource.kind !== 'namespace'
      ? `${resource.kind} \`${resource.name}\` in namespace \`${resource.namespace}\``
      : `${resource.kind} \`${resource.name}\``;
  return [
    `Required resource is missing: ${scoped}.`,
    resource.reason ? `Reason: ${resource.reason}` : '',
    '',
    `Should I create this ${resource.kind} and continue?`,
    '',
    'Reply `yes` / `create` or use the buttons below.',
    '`cancel` to abort.',
  ]
    .filter(Boolean)
    .join('\n');
}

function applyApprovedResourceToDeploy(
  deploy: DeployCmd,
  resource: CreateResourceRequest
): DeployCmd {
  if (resource.kind === 'namespace') {
    return { ...deploy, createNamespace: true };
  }
  return deploy;
}

export function tryResolveResourceCreateChoice(
  platform: 'telegram' | 'slack',
  channelId: string,
  userId: string,
  text: string
): { status: 'none' | 'cancelled' | 'approved'; deploy?: DeployCmd; resource?: CreateResourceRequest } {
  const normalized = text.trim().toLowerCase();
  const k = key(platform, channelId, userId);
  const entry = pending.get(k);
  if (!entry) return { status: 'none' };

  if (['cancel', 'stop', 'abort', 'no', 'nope'].includes(normalized)) {
    return resolveResourceCreateSelection(platform, channelId, userId, 'cancel');
  }

  const createKind = new RegExp(`create (the )?${entry.resource.kind}\\b`, 'i');
  if (
    ['yes', 'y', 'ok', 'okay', 'sure', 'go ahead', 'create', 'create it', 'proceed', 'do it'].includes(
      normalized
    ) ||
    /^yes\b/i.test(text.trim()) ||
    createKind.test(text)
  ) {
    return resolveResourceCreateSelection(platform, channelId, userId, 'approve');
  }
  return { status: 'none' };
}

export function resolveResourceCreateSelection(
  platform: 'telegram' | 'slack',
  channelId: string,
  userId: string,
  selection: 'approve' | 'cancel'
): { status: 'none' | 'cancelled' | 'approved'; deploy?: DeployCmd; resource?: CreateResourceRequest } {
  const k = key(platform, channelId, userId);
  const entry = pending.get(k);
  if (!entry) return { status: 'none' };
  if (Date.now() > entry.expiresAt) {
    pending.delete(k);
    return { status: 'none' };
  }
  pending.delete(k);
  if (selection === 'cancel') {
    return { status: 'cancelled' };
  }
  return {
    status: 'approved',
    deploy: applyApprovedResourceToDeploy(entry.deploy, entry.resource),
    resource: entry.resource,
  };
}

// Backward-compatible namespace-specific wrappers.
export function storeNamespaceCreatePrompt(
  platform: 'telegram' | 'slack',
  channelId: string,
  userId: string,
  deploy: DeployCmd
): void {
  storeResourceCreatePrompt(platform, channelId, userId, deploy, {
    kind: 'namespace',
    name: deploy.namespace,
    reason: `Namespace \`${deploy.namespace}\` is not in your cluster yet.`,
  });
}

export function buildNamespaceCreatePrompt(deploy: DeployCmd): string {
  return buildResourceCreatePrompt({
    kind: 'namespace',
    name: deploy.namespace,
    reason: `Namespace \`${deploy.namespace}\` is not in your cluster yet.`,
  });
}

export function tryResolveNamespaceCreateChoice(
  platform: 'telegram' | 'slack',
  channelId: string,
  userId: string,
  text: string
): { status: 'none' | 'cancelled' | 'approved'; deploy?: DeployCmd } {
  const resolved = tryResolveResourceCreateChoice(platform, channelId, userId, text);
  return {
    status: resolved.status,
    deploy: resolved.deploy,
  };
}

export function resolveNamespaceCreateSelection(
  platform: 'telegram' | 'slack',
  channelId: string,
  userId: string,
  selection: 'approve' | 'cancel'
): { status: 'none' | 'cancelled' | 'approved'; deploy?: DeployCmd } {
  const resolved = resolveResourceCreateSelection(platform, channelId, userId, selection);
  return {
    status: resolved.status,
    deploy: resolved.deploy,
  };
}
