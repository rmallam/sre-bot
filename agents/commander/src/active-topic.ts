/**
 * UX-14 — Single active conversation topic (workload, deploy, CI, etc.).
 */

import type { ParsedCommand } from './parser.js';
import { setSession } from './sessions.js';
import type { ActiveTopic } from './sessions.js';

export async function syncActiveTopicFromCommand(
  platform: string,
  channelId: string,
  userId: string,
  parsed: ParsedCommand
): Promise<void> {
  const at = new Date().toISOString();
  let topic: ActiveTopic | undefined;

  switch (parsed.type) {
    case 'workload-status':
      topic = {
        kind: 'workload-status',
        resourceName: parsed.resourceName,
        resourceKind: parsed.resourceKind,
        namespace: parsed.namespace,
        label: parsed.label,
        updatedAt: at,
      };
      break;
    case 'investigate':
      topic = {
        kind: 'investigate',
        resourceName: parsed.resourceName,
        namespace: parsed.namespace,
        label: parsed.label,
        updatedAt: at,
      };
      break;
    case 'deploy':
      topic = {
        kind: 'deploy',
        resourceName: parsed.appName ?? parsed.githubRepo?.split('/').pop(),
        namespace: parsed.namespace,
        githubRepo: parsed.githubRepo,
        label: parsed.githubRepo ?? parsed.appName,
        updatedAt: at,
      };
      break;
    case 'ci-failure':
      topic = {
        kind: 'ci',
        githubRepo: parsed.githubRepo,
        label: parsed.label,
        updatedAt: at,
      };
      break;
    case 'get':
      topic = {
        kind: 'get',
        resourceName: parsed.resource,
        namespace: parsed.namespace,
        label: parsed.label,
        updatedAt: at,
      };
      break;
    default:
      return;
  }

  if (topic) {
    await setSession(platform, channelId, userId, { activeTopic: topic });
  }
}

export function statusSubjectFromTopic(topic: ActiveTopic | undefined): {
  resourceName: string;
  resourceKind: import('../../../shared/src/types.js').ResourceKind;
  namespace?: string;
} | null {
  if (!topic || topic.kind !== 'workload-status' || !topic.resourceName) return null;
  return {
    resourceName: topic.resourceName,
    resourceKind: topic.resourceKind ?? 'Deployment',
    namespace: topic.namespace,
  };
}
