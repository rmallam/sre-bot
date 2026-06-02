/**
 * UX-5 — Session-linked CI/deploy follow-ups ("retry", "did it pass?", "show logs").
 */

import type { Platform } from '../../../shared/src/types.js';
import type { ParsedCommand } from './parser.js';
import { parseWorkloadStatusFollowUp } from './parser.js';
import { getSession } from './sessions.js';
import { statusSubjectFromTopic } from './active-topic.js';
import { fetchLatestRunSummaryByIncident, fetchRunDetailsText } from './run-details.js';
import { getChannelPref } from './channel-prefs.js';

const CICD_URL = process.env['CICD_URL'] ?? 'http://cicd-agent:8080';

export type SessionFollowUp =
  | { type: 'reply'; text: string }
  | { type: 'parsed'; parsed: ParsedCommand; reply?: string };

export async function trySessionFollowUp(
  text: string,
  platform: Platform,
  channelId: string,
  userId: string
): Promise<SessionFollowUp | null> {
  const session = await getSession(platform, channelId, userId);
  const verbose = getChannelPref(platform, channelId).verbose;
  const t = text.trim();

  if (session?.lastStatusSubject || session?.activeTopic) {
    const subject =
      session.lastStatusSubject ??
      statusSubjectFromTopic(session.activeTopic);
    if (subject) {
      const followUp = parseWorkloadStatusFollowUp(t, subject);
      if (followUp) {
        return { type: 'parsed', parsed: followUp };
      }
    }
  }

  if (/\b(show logs|show details|log excerpt|more logs)\b/i.test(t)) {
    if (session?.lastRunId) {
      const details = await fetchRunDetailsText(session.lastRunId, { verbose });
      return { type: 'reply', text: details };
    }
    if (session?.lastIncidentId) {
      const details = await fetchLatestRunSummaryByIncident(session.lastIncidentId, { verbose });
      if (details) return { type: 'reply', text: details };
    }
    return { type: 'reply', text: "I don't have a recent run to show logs for." };
  }

  if (/\b(open the pr|pr link|where is the pr|show pr)\b/i.test(t)) {
    if (session?.lastPrUrl) {
      return { type: 'reply', text: `Latest PR: ${session.lastPrUrl}` };
    }
    if (session?.lastIncidentId) {
      const details = await fetchLatestRunSummaryByIncident(session.lastIncidentId, { verbose: true });
      if (details?.includes('github.com') && details.includes('/pull/')) {
        return { type: 'reply', text: details };
      }
    }
    return {
      type: 'reply',
      text: "No PR link yet — approve a fix when prompted, or wait for the run to finish.",
    };
  }

  if (
    session?.lastMode === 'ci-failure' &&
    session.lastRepo &&
    /\b(retry|re-?run|run again|try again)\b/i.test(t)
  ) {
    const parsed: ParsedCommand = {
      type: 'ci-failure',
      githubRepo: session.lastRepo.startsWith('github.com/')
        ? session.lastRepo
        : `github.com/${session.lastRepo}`,
      workflowRunId: session.lastWorkflowRunId,
      label: `CI retry on ${session.lastRepo}`,
    };
    return {
      type: 'parsed',
      parsed,
      reply: `Re-triaging CI on ${parsed.githubRepo}…`,
    };
  }

  if (
    session?.lastMode === 'ci-failure' &&
    session.lastRepo &&
    /\b(did it pass|still failing|check ci|ci status|did the build pass)\b/i.test(t)
  ) {
    const status = await fetchCiRunStatus(session.lastRepo, session.lastWorkflowRunId);
    if (status) return { type: 'reply', text: status };
    if (session.lastIncidentId) {
      const summary = await fetchLatestRunSummaryByIncident(session.lastIncidentId, { verbose });
      if (summary) return { type: 'reply', text: summary };
    }
    return {
      type: 'reply',
      text: `I couldn't fetch live CI status for ${session.lastRepo}. Try asking about the failure again.`,
    };
  }

  return null;
}

async function fetchCiRunStatus(
  githubRepo: string,
  workflowRunId?: number
): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      repo: githubRepo.startsWith('github.com/') ? githubRepo : `github.com/${githubRepo}`,
    });
    if (workflowRunId != null) params.set('runId', String(workflowRunId));
    const res = await fetch(`${CICD_URL}/fetch-run?${params}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const run = (await res.json()) as {
      workflowName?: string;
      workflowRunId?: number;
      conclusion?: string | null;
      status?: string;
      htmlUrl?: string;
    };
    const conclusion = run.conclusion ?? run.status ?? 'unknown';
    const emoji = conclusion === 'success' ? '✅' : conclusion === 'failure' ? '🔴' : '⏳';
    return (
      `${emoji} ${run.workflowName ?? 'Workflow'} run #${run.workflowRunId ?? '?'}: **${conclusion}**` +
      (run.htmlUrl ? `\n${run.htmlUrl}` : '')
    );
  } catch {
    return null;
  }
}
