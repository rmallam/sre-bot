/**
 * UX-16 — Unified chat entry for Telegram, Slack, and web console.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Platform } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import type { ParsedCommand } from './parser.js';
import { handleCommand } from './router.js';
import { routeMessage } from './llm-router.js';
import { recordUserMessage, recordAssistantMessage, getChatTranscriptForLlm } from './chat-transcript.js';
import { syncActiveTopicFromCommand } from './active-topic.js';
import { tryResolvePendingClarification } from './clarification.js';
import { tryDeploySourceFollowUp, maybeArmDeploySourceFromRun } from './deploy-source-followup.js';
import { tryPendingRunFollowUp } from './pending-run-followup.js';
import { tryResolvePendingDeleteChoice } from './delete-choice.js';
import {
  resolveInvestigateFlow,
  storeInvestigateChoice,
  tryResolvePendingInvestigateChoice,
} from './investigate-choice.js';
import { getChannelPref } from './channel-prefs.js';
import { appendWebStatusStep, markWebRunWaiting, clearWebStatus } from './chat-web-notify.js';
import { formatDeployDispatchError } from '../../../shared/src/deploy-command.js';

const AGENT = 'commander-chat';

const ASYNC_COMMANDS = new Set<ParsedCommand['type']>([
  'deploy',
  'investigate',
  'ci-failure',
  'rollback',
]);

export interface ChatProcessResult {
  reply: string;
  incidentId?: string;
  executed: boolean;
  commandType?: ParsedCommand['type'];
  /** Web console: keep polling transcript for orchestrator updates. */
  waitingForRun?: boolean;
  quickActions?: Array<{ id: string; label: string }>;
}

function ackMessage(incidentId: string, type: ParsedCommand['type']): string {
  const id = incidentId.slice(0, 8);
  switch (type) {
    case 'deploy':
      return `🚀 Deploy started (ref \`${id}\`). I'll update you here as it progresses.`;
    case 'investigate':
      return `🔍 Investigation started (ref \`${id}\`). I'll post updates in this thread.`;
    case 'ci-failure':
      return `🔴 CI triage started (ref \`${id}\`). I'll report back here.`;
    case 'rollback':
      return `↩️ Rollback started (ref \`${id}\`).`;
    default:
      return `Started (ref \`${id}\`).`;
  }
}

async function webThinking(channelId: string, step: string): Promise<void> {
  await appendWebStatusStep(channelId, step);
}

function formatChatCommandError(err: unknown): string {
  const message = formatDeployDispatchError(err);
  if (/^I (need|could not|couldn't)/i.test(message) || message.includes('\n\n')) {
    return message;
  }
  return `Something went wrong: ${message}`;
}

export async function processChatMessage(opts: {
  text: string;
  platform: Platform;
  userId: string;
  channelId: string;
}): Promise<ChatProcessResult> {
  const { text, platform, userId, channelId } = opts;
  await recordUserMessage(platform, channelId, userId, text);

  if (platform === 'web') {
    await webThinking(channelId, 'Reading your message…');
  }

  const pendingRun = await tryPendingRunFollowUp(text, platform, channelId, userId);
  if (pendingRun) {
    await recordAssistantMessage(platform, channelId, userId, pendingRun.reply);
    return {
      reply: pendingRun.reply,
      executed: false,
      ...(pendingRun.quickActions?.length
        ? { quickActions: pendingRun.quickActions }
        : {}),
    };
  }

  const investigateChoice = tryResolvePendingInvestigateChoice(platform, channelId, userId, text);
  if (investigateChoice.status === 'cancelled') {
    const reply = 'Investigation choice cancelled.';
    await recordAssistantMessage(platform, channelId, userId, reply);
    return { reply, executed: false };
  }
  if (investigateChoice.status === 'selected' && investigateChoice.command) {
    try {
      const result = await handleCommand(investigateChoice.command, userId, platform, channelId, text);
      await syncActiveTopicFromCommand(platform, channelId, userId, investigateChoice.command);
      const waitingForRun = result.waitingForRun ?? !result.immediateReply;
      if (platform === 'web') {
        await clearWebStatus(channelId, 'pending');
        if (waitingForRun) {
          await markWebRunWaiting(channelId, result.incidentId);
          if (result.existingRunId) {
            const { setSession } = await import('./sessions.js');
            await setSession(platform, channelId, userId, { lastRunId: result.existingRunId });
          }
        }
      }
      const reply = result.immediateReply ?? ackMessage(result.incidentId, 'investigate');
      await recordAssistantMessage(platform, channelId, userId, reply, {
        incidentId: result.incidentId,
        runId: result.existingRunId,
        quickActions: result.quickActions,
      });
      return {
        reply,
        incidentId: result.incidentId,
        executed: true,
        commandType: 'investigate',
        waitingForRun,
        ...(result.quickActions?.length ? { quickActions: result.quickActions } : {}),
      };
    } catch (err) {
      const reply = formatChatCommandError(err);
      await recordAssistantMessage(platform, channelId, userId, reply);
      return { reply, executed: false };
    }
  }

  const deletePending = tryResolvePendingDeleteChoice(platform, channelId, userId, text);
  if (deletePending.status === 'cancelled') {
    const reply = 'Delete cancelled.';
    await recordAssistantMessage(platform, channelId, userId, reply);
    return { reply, executed: false };
  }
  if (deletePending.status === 'selected' && deletePending.command) {
    try {
      if (platform === 'web') {
        await webThinking(channelId, 'Removing workload…');
      }
      const result = await handleCommand(deletePending.command, userId, platform, channelId, text);
      if (platform === 'web') {
        await clearWebStatus(channelId, result.incidentId);
      }
      const reply = result.immediateReply ?? 'Done.';
      await recordAssistantMessage(platform, channelId, userId, reply);
      return {
        reply,
        incidentId: result.incidentId,
        executed: true,
        commandType: 'delete',
      };
    } catch (err) {
      const reply = formatChatCommandError(err);
      await recordAssistantMessage(platform, channelId, userId, reply);
      return { reply, executed: false };
    }
  }

  const deploySource = await tryDeploySourceFollowUp(platform, channelId, userId, text);
  if (deploySource) {
    if (deploySource.type === 'reply') {
      await recordAssistantMessage(platform, channelId, userId, deploySource.text);
      return { reply: deploySource.text, executed: false };
    }
    try {
      if (platform === 'web') await webThinking(channelId, 'Retrying with deploy source…');
      const result = await handleCommand(deploySource.parsed, userId, platform, channelId, text);
      const reply = deploySource.reply ?? result.immediateReply ?? ackMessage(result.incidentId, 'investigate');
      await recordAssistantMessage(platform, channelId, userId, reply);
      if (platform === 'web') await markWebRunWaiting(channelId, result.incidentId);
      return {
        reply,
        incidentId: result.incidentId,
        executed: true,
        commandType: 'investigate',
        waitingForRun: true,
      };
    } catch (err) {
      const reply = formatChatCommandError(err);
      await recordAssistantMessage(platform, channelId, userId, reply);
      return { reply, executed: false };
    }
  }

  const clarified = await tryResolvePendingClarification(platform, channelId, userId, text);
  if (clarified) {
    try {
      if (platform === 'web') {
        await webThinking(channelId, 'Running your command…');
      }
      const result = await handleCommand(clarified, userId, platform, channelId, text);
      await syncActiveTopicFromCommand(platform, channelId, userId, clarified);
      const asyncRun = ASYNC_COMMANDS.has(clarified.type);
      const waitingForRun = result.waitingForRun ?? (asyncRun && !result.immediateReply);
      if (platform === 'web') {
        await clearWebStatus(channelId, 'pending');
        if (waitingForRun) {
          await markWebRunWaiting(channelId, result.incidentId);
          if (result.existingRunId) {
            const { setSession } = await import('./sessions.js');
            await setSession(platform, channelId, userId, { lastRunId: result.existingRunId });
          }
        } else if (result.immediateReply) {
          await clearWebStatus(channelId, result.incidentId);
        }
      }
      const reply =
        result.immediateReply ?? ackMessage(result.incidentId, clarified.type);
      await recordAssistantMessage(platform, channelId, userId, reply, {
        incidentId: result.incidentId,
        runId: result.existingRunId,
        quickActions: result.quickActions,
      });
      return {
        reply,
        incidentId: result.incidentId,
        executed: true,
        commandType: clarified.type,
        waitingForRun,
        ...(result.quickActions?.length ? { quickActions: result.quickActions } : {}),
      };
    } catch (err) {
      const reply = formatChatCommandError(err);
      await recordAssistantMessage(platform, channelId, userId, reply);
      return { reply, executed: false };
    }
  }

  if (platform === 'web') {
    await webThinking(channelId, 'Understanding what you need…');
  }

  const routed = await routeMessage(text, platform, userId, channelId);
  let parsed = routed.parsed;

  if (parsed.type === 'unknown') {
    if (platform === 'web') {
      await clearWebStatus(channelId, 'pending');
      const session = await getSession(platform, channelId, userId);
      if (session?.lastIncidentId) {
        await clearWebStatus(channelId, session.lastIncidentId);
      }
    }
    const reply = routed.conversationalReply ?? routed.userReply ?? "I didn't understand that.";
    await recordAssistantMessage(platform, channelId, userId, reply);
    return { reply, executed: false };
  }

  if (parsed.type === 'deploy' && !parsed.deployStrategyExplicit && routed.conversationalReply) {
    if (platform === 'web') {
      await clearWebStatus(channelId, 'pending');
    }
    await recordAssistantMessage(platform, channelId, userId, routed.conversationalReply);
    return { reply: routed.conversationalReply, executed: false, commandType: 'deploy' };
  }

  if (parsed.type === 'investigate') {
    const flow = await resolveInvestigateFlow(parsed, text, {
      platform,
      verbose: getChannelPref(platform, channelId).verbose,
      incidentId: uuidv4(),
    });
    if (flow.kind === 'reply') {
      if (platform === 'web') await clearWebStatus(channelId, 'pending');
      await recordAssistantMessage(platform, channelId, userId, flow.text);
      return { reply: flow.text, executed: false, commandType: 'investigate' };
    }
    if (flow.kind === 'confirm') {
      storeInvestigateChoice(platform, channelId, userId, text, parsed, flow.candidates);
      if (platform === 'web') await clearWebStatus(channelId, 'pending');
      await recordAssistantMessage(platform, channelId, userId, flow.prompt);
      return { reply: flow.prompt, executed: false, commandType: 'investigate' };
    }
    parsed = flow.command;
  }

  try {
    if (platform === 'web') {
      const label =
        parsed.type === 'deploy'
          ? 'Starting deploy…'
          : parsed.type === 'investigate'
            ? 'Starting investigation…'
            : parsed.type === 'ci-failure'
              ? 'Triaging CI…'
              : 'Working on it…';
      await webThinking(channelId, label);
    }

    const result = await handleCommand(parsed, userId, platform, channelId, text, {
      routingConfidence: routed.confidence,
      routingSource: routed.routingSource,
      llmRawGithubRepo: routed.llmRawGithubRepo,
    });
    await syncActiveTopicFromCommand(platform, channelId, userId, parsed);

    const asyncRun = ASYNC_COMMANDS.has(parsed.type) && !result.immediateReply;
    const waitingForRun = result.waitingForRun ?? asyncRun;
    if (platform === 'web') {
      await clearWebStatus(channelId, 'pending');
      if (waitingForRun) {
        await markWebRunWaiting(channelId, result.incidentId);
        if (result.existingRunId) {
          const { setSession } = await import('./sessions.js');
          await setSession(platform, channelId, userId, { lastRunId: result.existingRunId });
        }
      } else if (result.immediateReply) {
        await clearWebStatus(channelId, result.incidentId);
      }
    }

    const reply =
      result.immediateReply ??
      routed.conversationalReply ??
      ackMessage(result.incidentId, parsed.type);

    await recordAssistantMessage(platform, channelId, userId, reply, {
      incidentId: result.incidentId,
      runId: result.existingRunId,
      quickActions: result.quickActions,
    });
    return {
      reply,
      incidentId: result.incidentId,
      executed: true,
      commandType: parsed.type,
      waitingForRun,
      ...(result.quickActions?.length ? { quickActions: result.quickActions } : {}),
    };
  } catch (err) {
    log('error', AGENT, 'Chat command failed', { error: String(err), commandType: parsed.type });
    if (platform === 'web') {
      await clearWebStatus(channelId, 'pending');
    }
    const reply = formatChatCommandError(err);
    await recordAssistantMessage(platform, channelId, userId, reply);
    return { reply, executed: false, commandType: parsed.type };
  }
}

export async function recordChatReply(
  platform: Platform,
  channelId: string,
  userId: string,
  reply: string
): Promise<void> {
  await recordAssistantMessage(platform, channelId, userId, reply);
}

export async function recordChatUserTurn(
  platform: Platform,
  channelId: string,
  userId: string,
  text: string
): Promise<void> {
  await recordUserMessage(platform, channelId, userId, text);
}

export async function getChatTranscript(
  platform: Platform,
  channelId: string,
  userId: string
) {
  const { getSession } = await import('./sessions.js');
  const session = await getSession(platform, channelId, userId);
  return session?.transcript ?? [];
}

export async function getChatSessionState(
  platform: Platform,
  channelId: string,
  userId: string
) {
  const { getSession } = await import('./sessions.js');
  const session = await getSession(platform, channelId, userId);
  return {
    transcript: session?.transcript ?? [],
    waitingForRun: session?.waitingForRun ?? false,
    lastIncidentId: session?.lastIncidentId,
    lastRunId: session?.lastRunId,
  };
}
