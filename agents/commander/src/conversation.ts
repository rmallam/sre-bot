/**
 * Conversational follow-ups — e.g. user says "try master" after a failed deploy.
 */

import type { ResourceKind } from '../../../shared/src/types.js';
import type { DeployCmd, ParsedCommand } from './parser.js';
import { getSession, setSession } from './sessions.js';
import { syncActiveTopicFromCommand } from './active-topic.js';
import { tryResolveNamespaceCreateChoice } from './namespace-prompt.js';
import { fetchLatestRunSummaryByIncident } from './run-details.js';
import { modeOutcomeLabel } from '../../../shared/src/user-outcomes.js';

export async function rememberDeployDraft(
  platform: string,
  channelId: string,
  userId: string,
  deploy: DeployCmd
): Promise<void> {
  await setSession(platform, channelId, userId, { lastDeployDraft: deploy });
}

export async function clearDeployDraft(
  platform: string,
  channelId: string,
  userId: string
): Promise<void> {
  await setSession(platform, channelId, userId, { lastDeployDraft: undefined });
}

export async function rememberWorkloadStatusQuery(
  platform: string,
  channelId: string,
  userId: string,
  cmd: { resourceName: string; resourceKind?: ResourceKind; namespace: string }
): Promise<void> {
  await setSession(platform, channelId, userId, {
    lastStatusSubject: {
      resourceName: cmd.resourceName,
      resourceKind: cmd.resourceKind ?? 'Deployment',
      namespace: cmd.namespace,
    },
  });
  await syncActiveTopicFromCommand(platform, channelId, userId, {
    type: 'workload-status',
    resourceName: cmd.resourceName,
    resourceKind: cmd.resourceKind ?? 'Deployment',
    namespace: cmd.namespace,
    label:
      cmd.namespace === '_all'
        ? `${cmd.resourceName} (all namespaces)`
        : `${cmd.resourceName} in ${cmd.namespace}`,
  });
}

function extractBranchHint(text: string): string | null {
  const patterns = [
    /\b(?:use|try|switch to|checkout|on)\s+(?:the\s+)?([\w./-]+)(?:\s+branch)?\b/i,
    /\bbranch\s+([\w./-]+)\b/i,
    /^@([\w./-]+)$/,
    /^([\w./-]+)\s+branch$/i,
  ];
  for (const re of patterns) {
    const m = text.trim().match(re);
    if (m?.[1] && m[1].length >= 2) return m[1];
  }
  return null;
}

export async function tryNamespaceCreateFollowUp(
  platform: string,
  channelId: string,
  userId: string,
  text: string
): Promise<DeployCmd | null> {
  const decision = tryResolveNamespaceCreateChoice(
    platform as 'telegram' | 'slack',
    channelId,
    userId,
    text
  );
  if (decision.status === 'approved' && decision.deploy) {
    return decision.deploy;
  }
  const session = await getSession(platform, channelId, userId);
  const draft = session?.lastDeployDraft;
  if (
    draft &&
    /^(yes|y|ok|okay|sure|go ahead)\b/i.test(text.trim()) &&
    /\b(namespace|create)\b/i.test(text)
  ) {
    return { ...draft, createNamespace: true };
  }
  return null;
}

export async function tryDeployBranchFollowUp(
  platform: string,
  channelId: string,
  userId: string,
  text: string
): Promise<DeployCmd | null> {
  const session = await getSession(platform, channelId, userId);
  const draft = session?.lastDeployDraft;
  if (!draft) return null;

  const branch = extractBranchHint(text);
  if (!branch) return null;

  return {
    ...draft,
    gitRef: branch,
    deployStrategyExplicit: draft.deployStrategyExplicit,
  };
}

export async function tryStatusFollowUp(
  platform: string,
  channelId: string,
  userId: string,
  text: string
): Promise<string | null> {
  if (!/\b(status|update|progress|how(?:'?s| is) it going|what happened)\b/i.test(text)) {
    return null;
  }
  const session = await getSession(platform, channelId, userId);
  if (!session?.lastIncidentId) {
    return "I don't have a recent run for you yet. Start a deploy or investigation and I'll track it.";
  }
  const summary = await fetchLatestRunSummaryByIncident(session.lastIncidentId);
  if (summary) {
    return summary;
  }
  const label = session.lastMode ? modeOutcomeLabel(session.lastMode) : 'run';
  return (
    `Your last ${label} is still starting (incident \`${session.lastIncidentId.slice(0, 8)}\`).\n` +
    `Try again in a few seconds, or say "show logs".`
  );
}
