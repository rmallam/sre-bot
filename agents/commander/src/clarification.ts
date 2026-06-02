/**
 * UX-15 — Clarification loop: ask once, bind the next reply.
 */

import type { Platform } from '../../../shared/src/types.js';
import type { ParsedCommand } from './parser.js';
import { parseWorkloadStatusFollowUp } from './parser.js';
import { getSession, setSession, type PendingClarification } from './sessions.js';
import { isAllNamespacesScope, ALL_NAMESPACES } from '../../../shared/src/namespace-scope.js';

export async function setPendingClarification(
  platform: string,
  channelId: string,
  userId: string,
  pending: PendingClarification
): Promise<void> {
  await setSession(platform, channelId, userId, {
    pendingClarification: pending,
    pendingQuestion: pending.prompt,
  });
}

export async function clearPendingClarification(
  platform: string,
  channelId: string,
  userId: string
): Promise<void> {
  await setSession(platform, channelId, userId, {
    pendingClarification: undefined,
    pendingQuestion: undefined,
  });
}

function extractNamespaceAnswer(text: string): string | undefined {
  const t = text.trim();
  if (isAllNamespacesScope(t)) return ALL_NAMESPACES;
  const patterns = [
    /\b(?:in|into|for)\s+(?:the\s+)?([\w-]+)(?:\s+namespace)?\b/i,
    /\bnamespace\s+([\w-]+)\b/i,
    /^([\w-]+)$/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1] && m[1].length >= 2) return m[1];
  }
  return undefined;
}

function extractWorkloadAnswer(text: string): string | undefined {
  const t = text.trim();
  const m = t.match(/\b([\w-]+)\b/);
  return m?.[1] && m[1].length >= 2 ? m[1] : undefined;
}

export async function tryResolvePendingClarification(
  platform: Platform,
  channelId: string,
  userId: string,
  text: string
): Promise<ParsedCommand | null> {
  const session = await getSession(platform, channelId, userId);
  const pending = session?.pendingClarification;
  if (!pending) return null;

  if (/^(cancel|nevermind|never mind|stop)\b/i.test(text.trim())) {
    await clearPendingClarification(platform, channelId, userId);
    return null;
  }

  if (pending.kind === 'workload-status' && pending.resourceName) {
    const ns = extractNamespaceAnswer(text);
    if (!ns) return null;
    await clearPendingClarification(platform, channelId, userId);
    return {
      type: 'workload-status',
      resourceName: pending.resourceName,
      resourceKind: pending.resourceKind ?? 'Deployment',
      namespace: ns,
      label: ns === ALL_NAMESPACES ? `${pending.resourceName} (all namespaces)` : `${pending.resourceName} in ${ns}`,
    };
  }

  if (pending.kind === 'investigate') {
    if (pending.awaiting === 'namespace') {
      const ns = extractNamespaceAnswer(text);
      if (!ns) return null;
      await clearPendingClarification(platform, channelId, userId);
      return {
        type: 'investigate',
        scope: 'namespace',
        namespace: ns,
        resourceName: '_namespace',
        label: `${ns} namespace`,
      };
    }
    if (pending.awaiting === 'workload') {
      const name = extractWorkloadAnswer(text);
      if (!name) return null;
      await clearPendingClarification(platform, channelId, userId);
      return {
        type: 'investigate',
        scope: 'workload',
        namespace: pending.namespace ?? 'default',
        resourceName: name,
        workloadHint: name,
        label: `${name} deployment`,
      };
    }
  }

  if (pending.resourceName) {
    const followUp = parseWorkloadStatusFollowUp(text, {
      resourceName: pending.resourceName,
      resourceKind: pending.resourceKind ?? 'Deployment',
      namespace: pending.namespace,
    });
    if (followUp) {
      await clearPendingClarification(platform, channelId, userId);
      return followUp;
    }
  }

  return null;
}
