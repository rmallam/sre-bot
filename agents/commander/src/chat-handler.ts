/**
 * UX-16 — Unified chat entry for Telegram, Slack, and web console.
 */

import type { Platform } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import type { ParsedCommand } from './parser.js';
import { handleCommand } from './router.js';
import { routeMessage } from './llm-router.js';
import { recordUserMessage, recordAssistantMessage, getChatTranscriptForLlm } from './chat-transcript.js';
import { syncActiveTopicFromCommand } from './active-topic.js';
import { tryResolvePendingClarification } from './clarification.js';
import { tryResolvePendingDeleteChoice } from './delete-choice.js';
import { appendWebStatusStep, markWebRunWaiting, clearWebStatus } from './chat-web-notify.js';

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
      const reply = `⚠️ ${String(err)}`;
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
      if (platform === 'web' && asyncRun) {
        await markWebRunWaiting(channelId, result.incidentId);
      } else if (platform === 'web') {
        await clearWebStatus(channelId, result.incidentId);
      }
      const reply =
        result.immediateReply ?? ackMessage(result.incidentId, clarified.type);
      await recordAssistantMessage(platform, channelId, userId, reply);
      return {
        reply,
        incidentId: result.incidentId,
        executed: true,
        commandType: clarified.type,
        waitingForRun: asyncRun && !result.immediateReply,
      };
    } catch (err) {
      const reply = `⚠️ ${String(err)}`;
      await recordAssistantMessage(platform, channelId, userId, reply);
      return { reply, executed: false };
    }
  }

  if (platform === 'web') {
    await webThinking(channelId, 'Understanding what you need…');
  }

  const routed = await routeMessage(text, platform, userId, channelId);
  const parsed = routed.parsed;

  if (parsed.type === 'unknown') {
    if (platform === 'web') {
      await clearWebStatus(channelId, 'pending');
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

  if (routed.conversationalReply && parsed.type === 'deploy') {
    await recordAssistantMessage(platform, channelId, userId, routed.conversationalReply);
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

    const result = await handleCommand(parsed, userId, platform, channelId, text);
    await syncActiveTopicFromCommand(platform, channelId, userId, parsed);

    const asyncRun = ASYNC_COMMANDS.has(parsed.type) && !result.immediateReply;
    if (platform === 'web' && asyncRun) {
      await markWebRunWaiting(channelId, result.incidentId);
    } else if (platform === 'web') {
      await clearWebStatus(channelId, result.incidentId);
    }

    const reply =
      result.immediateReply ??
      routed.conversationalReply ??
      ackMessage(result.incidentId, parsed.type);

    await recordAssistantMessage(platform, channelId, userId, reply);
    return {
      reply,
      incidentId: result.incidentId,
      executed: true,
      commandType: parsed.type,
      waitingForRun: asyncRun,
    };
  } catch (err) {
    log('error', AGENT, 'Chat command failed', { error: String(err), commandType: parsed.type });
    if (platform === 'web') {
      await clearWebStatus(channelId, 'pending');
    }
    const reply = `⚠️ An error occurred: ${String(err)}`;
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
