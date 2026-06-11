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
import { extractContainerImageViaLlm } from './image-hint-llm.js';
import { agentFetch } from './agent-fetch.js';
import { isClusterListExpandFollowUp } from './cluster-get-followup.js';
import { replyClusterGet } from './router.js';
import {
  extractContainerImageHint,
  looksLikeImageRemediation,
  resolveOperatorSuggestion,
} from './investigate-target.js';

const CICD_URL = process.env['CICD_URL'] ?? 'http://cicd-agent:8080';
const INVESTIGATOR_URL = process.env['INVESTIGATOR_URL'] ?? 'http://investigator-agent:8080';

/** Build a container image ref from natural-language follow-ups after ImagePullBackOff, etc. */
export { extractContainerImageHint as extractImageRefFromText } from './investigate-target.js';

function isImageRemediationFollowUp(text: string): boolean {
  return looksLikeImageRemediation(text);
}

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

  if (session?.activeTopic?.kind === 'get' && isClusterListExpandFollowUp(t)) {
    const topic = session.activeTopic;
    const resource = topic.resourceName ?? 'pods';
    const text = await replyClusterGet({
      resource,
      namespace: topic.namespace,
      platform,
      channelId,
      verbose: true,
    });
    return { type: 'reply', text };
  }

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

  if (
    session?.lastAppReview &&
    /\b(fix( it)?|remediate|repair|patch it|make it work)\b/i.test(t) &&
    !/\b(fix|remediate)\s+(the\s+)?(cluster|namespace)\b/i.test(t)
  ) {
    const ar = session.lastAppReview;
    const targetNs = ar.frontierNamespace ?? ar.namespace;
    const targetName =
      ar.frontierKind === 'pod' || ar.frontierKind === 'deployment'
        ? (ar.frontierName ?? ar.appId)
        : ar.appId;
    const targetKind = ar.frontierKind === 'pod' ? ('Pod' as const) : ('Deployment' as const);
    const parsed: ParsedCommand = {
      type: 'investigate',
      scope: 'app',
      namespace: targetNs,
      resourceName: ar.appId,
      resourceKind: targetKind,
      label: `app ${ar.appId}`,
      operatorSuggestion: `remediate frontier ${targetNs}/${targetName}`,
    };
    return {
      type: 'parsed',
      parsed,
      reply: `On it — remediating **${targetNs}/${targetName}** (frontier from app **${ar.appId}** review).`,
    };
  }

  if (
    session?.activeTopic?.kind === 'investigate' &&
    session.activeTopic.resourceName &&
    session.activeTopic.namespace &&
    isImageRemediationFollowUp(t)
  ) {
    const topic = session.activeTopic;
    const imageRef =
      resolveOperatorSuggestion({ text: t, workloadHint: topic.resourceName })?.replace(
        /^set image to /i,
        ''
      ) ??
      (await extractContainerImageViaLlm(t, userId, {
        workloadHint: topic.resourceName,
        namespace: topic.namespace,
      }));
    if (imageRef) {
      const parsed: ParsedCommand = {
        type: 'investigate',
        scope: 'workload',
        namespace: topic.namespace!,
        resourceName: topic.resourceName!,
        resourceKind: 'Deployment',
        label: topic.label ?? topic.resourceName!,
        operatorSuggestion: `set image to ${imageRef}`,
      };
      return {
        type: 'parsed',
        parsed,
        reply: `Got it — I'll update the image to \`${imageRef}\` on **${topic.namespace}/${topic.resourceName}** and retry the fix.`,
      };
    }
  }

  if (/\b(is it done|done yet|is it deployed|deploy(ed)? yet|finished deploying|all good|is it complete)\b/i.test(t)) {
    const topic = session?.activeTopic;
    const draft = session?.lastDeployDraft;
    const namespace =
      topic?.kind === 'deploy' ? topic.namespace : draft?.namespace;
    const resourceName =
      topic?.kind === 'deploy'
        ? topic.resourceName
        : draft?.appName ?? draft?.githubRepo?.split('/').pop();
    if (namespace && resourceName) {
      const status = await fetchDeployVerifyStatus(namespace, resourceName);
      if (status) return { type: 'reply', text: status };
    }
    if (session?.lastRunId) {
      const details = await fetchRunDetailsText(session.lastRunId, { verbose: true });
      return { type: 'reply', text: details };
    }
    if (session?.lastIncidentId) {
      const details = await fetchLatestRunSummaryByIncident(session.lastIncidentId, { verbose: true });
      if (details) return { type: 'reply', text: details };
    }
    return {
      type: 'reply',
      text: "I don't have an active deploy to check. Try asking about a specific namespace or workload.",
    };
  }

  if (/\b(what'?s happening|show progress|run status|what are you doing|status update)\b/i.test(t)) {
    if (session?.lastRunId) {
      const details = await fetchRunDetailsText(session.lastRunId, { verbose: true });
      return { type: 'reply', text: details };
    }
    if (session?.lastIncidentId) {
      const details = await fetchLatestRunSummaryByIncident(session.lastIncidentId, { verbose: true });
      if (details) return { type: 'reply', text: details };
    }
    return {
      type: 'reply',
      text: "I don't have an active run to report on. Start an investigation or deploy first.",
    };
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

async function fetchDeployVerifyStatus(namespace: string, resourceName: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      namespace,
      resourceName,
      incidentId: 'deploy-status-check',
    });
    const res = await agentFetch(`${INVESTIGATOR_URL}/verify?${params}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const verify = (await res.json()) as {
      healthy?: boolean;
      message?: string;
      readyReplicas?: number;
      desiredReplicas?: number;
    };
    if (verify.healthy) {
      const replicas =
        verify.readyReplicas != null && verify.desiredReplicas != null
          ? ` (${verify.readyReplicas}/${verify.desiredReplicas} ready)`
          : '';
      return `✅ Yes — deploy looks healthy${replicas}.\n${verify.message ?? ''}`.trim();
    }
    return `⏳ Not fully ready yet.\n${verify.message ?? 'Workloads are still starting.'}`;
  } catch {
    return null;
  }
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
    const res = await agentFetch(`${CICD_URL}/fetch-run?${params}`, {
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
