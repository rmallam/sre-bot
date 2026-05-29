/**
 * Conversational follow-ups — e.g. user says "try master" after a failed deploy.
 */

import type { DeployCmd } from './parser.js';
import { getSession, setSession } from './sessions.js';
import { tryResolveNamespaceCreateChoice } from './namespace-prompt.js';

export function rememberDeployDraft(
  platform: string,
  channelId: string,
  userId: string,
  deploy: DeployCmd
): void {
  setSession(platform, channelId, userId, { lastDeployDraft: deploy });
}

export function clearDeployDraft(platform: string, channelId: string, userId: string): void {
  setSession(platform, channelId, userId, { lastDeployDraft: undefined });
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

/** User approved namespace creation after a prompt. */
export function tryNamespaceCreateFollowUp(
  platform: string,
  channelId: string,
  userId: string,
  text: string
): DeployCmd | null {
  const decision = tryResolveNamespaceCreateChoice(
    platform as 'telegram' | 'slack',
    channelId,
    userId,
    text
  );
  if (decision.status === 'approved' && decision.deploy) {
    return decision.deploy;
  }
  const session = getSession(platform, channelId, userId);
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

/** If user is answering a branch question, return an updated deploy command. */
export function tryDeployBranchFollowUp(
  platform: string,
  channelId: string,
  userId: string,
  text: string
): DeployCmd | null {
  const session = getSession(platform, channelId, userId);
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

export function tryStatusFollowUp(
  platform: string,
  channelId: string,
  userId: string,
  text: string
): string | null {
  if (!/\b(status|update|progress|how(?:'?s| is) it going|what happened)\b/i.test(text)) {
    return null;
  }
  const session = getSession(platform, channelId, userId);
  if (!session?.lastIncidentId) {
    return "I don't have a recent run for you yet. Start a deploy or investigation and I'll track it.";
  }
  return (
    `Your last tracked incident is \`${session.lastIncidentId}\`.\n` +
    `Ask me to investigate or deploy something new, or check the orchestrator/HIL dashboard for live status.`
  );
}
