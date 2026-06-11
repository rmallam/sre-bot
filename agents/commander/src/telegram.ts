// ─────────────────────────────────────────────────────────────────────────────
// src/telegram.ts — Telegram integration via telegraf
//
// Handles both structured slash commands and free-form text messages.
//
// Commands:
//   /deploy <github-url> [@branch]
//   /investigate [namespace/]<resource>
//   /rollback [namespace/]<resource>
//
// Free text is run through parseCommand() for best-effort interpretation.
//
// All messages go through isAuthorized() first. The Telegram user ID is
// converted to a string for uniform treatment with Slack/Teams IDs.
// ─────────────────────────────────────────────────────────────────────────────

import { Telegraf, type Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { Markup } from 'telegraf';
import { v4 as uuidv4 } from 'uuid';
import { log } from '../../../shared/src/http.js';
import { agentFetch } from './agent-fetch.js';
import { isAuthorized } from './auth.js';
import { parseCommand, isWorkloadStatusQuery } from './parser.js';
import { handleCommand, fetchWorkloadStatusReply } from './router.js';
import { rememberWorkloadStatusQuery } from './conversation.js';
import { recordChatUserTurn, recordChatReply } from './chat-handler.js';
import { routeMessage } from './llm-router.js';
import { registerTelegramBot } from './confirm.js';
import { registerTelegramBotForNotify } from './notify.js';
import {
  buildDeployChoicePrompt,
  resolvePendingChoiceSelection,
  tryResolvePendingChoice,
} from './deploy-choice.js';
import {
  buildNamespaceCreatePrompt,
  needsNamespaceCreatePrompt,
  resolveNamespaceCreateSelection,
  storeNamespaceCreatePrompt,
  tryResolveNamespaceCreateChoice,
} from './namespace-prompt.js';
import {
  resolveInvestigateFlow,
  resolveInvestigateChoiceSelection,
  storeInvestigateChoice,
  tryResolvePendingInvestigateChoice,
} from './investigate-choice.js';
import { tryResolvePendingDeleteChoice } from './delete-choice.js';
import {
  buildSuggestFixPrompt,
  storeHilSuggestPrompt,
  tryConsumeSuggestReply,
} from './hil-suggest-pending.js';
import { fetchRunDetailsText } from './run-details.js';
import { getChannelPref } from './channel-prefs.js';
import { tryPendingRunFollowUp } from './pending-run-followup.js';
import { editMessageFormatted, replyFormatted } from './telegram-send.js';

const AGENT = 'commander-agent';
const PLATFORM = 'telegram' as const;
const HIL_URL = process.env['HIL_URL'] ?? 'http://localhost:8085';

// ── Helpers ───────────────────────────────────────────────────────────────────

function userId(ctx: Context): string {
  return String(ctx.from?.id ?? 'unknown');
}

function channelId(ctx: Context): string {
  return String(ctx.chat?.id ?? 'unknown');
}

function ackMessage(incidentId: string, type: string, parsed?: import('./parser.js').ParsedCommand): string {
  if (type === 'unknown') {
    return (
      "Sorry, I didn't understand that. Try:\n" +
      '• get all namespaces\n' +
      '• get pods in staging\n' +
      '• investigate my cluster health\n' +
      '• /deploy github.com/org/repo'
    );
  }
  if (type === 'deploy' && parsed?.type === 'deploy') {
    if (parsed.stackServices && parsed.stackServices.length > 1) {
      return (
        `🚀 Stack deploy started — tracking \`${incidentId}\`\n` +
        `Services: ${parsed.stackServices.map((s) => s.name).join(', ')}\n` +
        `Namespace: ${parsed.namespace}\n` +
        `Mode: ${parsed.deployStrategy === 'direct' ? 'Direct apply (generated Helm per service)' : 'GitOps'}\n\n` +
        `I'll infer service dependencies from code, create Helm charts per service, and deploy in dependency order.`
      );
    }
    const strategyText =
      parsed.deployStrategy === 'direct'
        ? 'Direct apply from source repo (no Git push)'
        : 'GitOps flow (push app/GitOps repos + Argo CD)';
    if (parsed.containerImage) {
      return (
        `🚀 Deploy started — tracking \`${incidentId}\`\n` +
        `Image: ${parsed.containerImage}\n` +
        `App: ${parsed.appName ?? 'app'}\n` +
        `Namespace: ${parsed.namespace}\n` +
        `Mode: direct apply (generated Helm chart)\n\n` +
        `I'll send step-by-step updates here.`
      );
    }
    if (parsed.helmRemote) {
      return (
        `🚀 Deploy started — tracking \`${incidentId}\`\n` +
        `Helm chart: ${parsed.helmRemote.chartRef}\n` +
        `App: ${parsed.appName ?? parsed.helmRemote.releaseName ?? 'app'}\n` +
        `Namespace: ${parsed.namespace}\n` +
        `Mode: direct apply (published Helm chart)\n\n` +
        `I'll send step-by-step updates here.`
      );
    }
    return (
      `🚀 Deploy started — tracking \`${incidentId}\`\n` +
      `Repo: ${parsed.githubRepo} @ ${parsed.gitRef}\n` +
      `Namespace: ${parsed.namespace}\n` +
      `Mode: ${strategyText}\n\n` +
      `I'll send step-by-step updates here (namespace, clone, apply, fallbacks).`
    );
  }
  if (type === 'delete' && parsed?.type === 'delete') {
    return `🗑️ Removing \`${parsed.resourceName}\` from namespace \`${parsed.namespace}\`…`;
  }
  if (type === 'investigate' && parsed?.type === 'investigate') {
    const detail =
      parsed.scope === 'cluster'
        ? 'Checking overall cluster health (nodes, deployments, recent warnings)...'
        : parsed.scope === 'namespace'
          ? `Checking everything in the ${parsed.namespace} namespace...`
          : `Looking into ${parsed.label}${parsed.podName ? ` (pod ${parsed.podName})` : ''}...`;
    return (
      `🔍 Investigation started — \`${incidentId}\`\n` +
      `${detail}\n\n` +
      `I'll dig through pods, events, and logs and report back.`
    );
  }
  return `Got it! I'm on it — I'll message you when done.`;
}

/** Send a formatted reply — HTML (bold/code/pre) with plain fallback. */
async function safeReply(
  ctx: Context,
  text: string,
  quickActions?: Array<{ id: string; label: string }>
): Promise<void> {
  try {
    const replyMarkup = quickActions?.length
      ? Markup.inlineKeyboard(quickActions.map((a) => [Markup.button.callback(a.label, a.id)]))
          .reply_markup
      : undefined;
    await replyFormatted(ctx, text, replyMarkup);
    const uid = userId(ctx);
    const cid = channelId(ctx);
    void recordChatReply(PLATFORM, cid, uid, text);
  } catch (err) {
    log('warn', AGENT, 'Failed to send Telegram reply', {
      incidentId: 'N/A',
      error: String(err),
    });
  }
}

/** Replace an HIL approval card — strip buttons after action. */
async function editHilApprovalCard(ctx: Context, text: string, incidentId: string): Promise<void> {
  try {
    await editMessageFormatted(ctx, text);
  } catch (err) {
    log('warn', AGENT, 'editMessageText failed for HIL approval card', {
      incidentId,
      error: String(err),
    });
    await safeReply(ctx, text).catch(() => {});
  }
}

/** Edit the choice prompt in place; fall back to a new message if Telegram rejects the edit. */
async function editOrReply(ctx: Context, text: string): Promise<void> {
  try {
    await editMessageFormatted(ctx, text);
    const uid = userId(ctx);
    const cid = channelId(ctx);
    void recordChatReply(PLATFORM, cid, uid, text);
  } catch (err) {
    log('warn', AGENT, 'editMessageText failed, sending new reply', {
      incidentId: 'N/A',
      error: String(err),
    });
    await safeReply(ctx, text);
  }
}

/** Forward approve/reject to HIL without blocking the Telegram callback handler. */
function forwardHilAction(
  ctx: Context,
  action: string,
  incidentId: string,
  userId: string
): void {
  void (async () => {
    try {
      const res = await agentFetch(`${HIL_URL}/api/${action}/${incidentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, platform: PLATFORM }),
        signal: AbortSignal.timeout(15_000),
      });

      if (res.ok) return;

      const errJson = (await res.json().catch(() => ({}))) as {
        error?: string;
        status?: string;
        currentStatus?: string;
      };
      const errMsg = errJson?.error ?? `HTTP ${res.status}`;
      if (errJson?.status === 'already_handled') {
        await safeReply(
          ctx,
          `ℹ️ Incident ${incidentId} was already handled (${errJson.currentStatus ?? 'unknown'}).`
        );
      } else if (errMsg === 'not_found') {
        await safeReply(
          ctx,
          `⚠️ Incident ${incidentId} is no longer pending — it may have expired or the bot restarted.`
        );
      } else if (errMsg === 'expired') {
        await safeReply(ctx, `⏰ Approval window expired for ${incidentId}.`);
      } else {
        await safeReply(ctx, `⚠️ HIL ${action} failed for ${incidentId}: ${errMsg}`);
      }
    } catch (err) {
      log('error', AGENT, 'Failed to forward Telegram callback query to HIL agent', {
        incidentId,
        error: String(err),
      });
      await safeReply(
        ctx,
        `⚠️ Could not reach HIL agent for ${incidentId}. Approval may still be processing — check run status.`
      );
    }
  })();
}

async function submitOperatorSuggestion(
  ctx: Context,
  incidentId: string,
  suggestion: string,
  uid: string
): Promise<void> {
  try {
    const res = await agentFetch(`${HIL_URL}/api/suggest-fix/${incidentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        suggestion,
        userId: uid,
        platform: PLATFORM,
        applyNow: false,
      }),
    });
    const body = (await res.json()) as {
      ok?: boolean;
      error?: string;
      summary?: string;
      source?: string;
    };
    if (!res.ok || !body.ok) {
      await safeReply(
        ctx,
        `Could not parse suggestion: ${body.error ?? res.statusText}\nTry again or tap Suggest fix on the incident.`
      );
      return;
    }
    const sourceLabel = body.source === 'rules' ? 'quick parse' : 'AI parse';
    await replyFormatted(
      ctx,
      `Your suggested fix (${sourceLabel}):\n\n${body.summary ?? 'Plan updated.'}\n\n` +
        `Tap **Apply my fix** to run it, or **Approve** if you are happy with the updated plan.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('Apply my fix', `hil_approve_${incidentId}`)],
        [Markup.button.callback('Reject', `hil_reject_${incidentId}`)],
      ]).reply_markup
    );
  } catch (err) {
    log('error', AGENT, 'Failed to submit operator suggestion', { incidentId, error: String(err) });
    await safeReply(ctx, 'Failed to send suggestion to HIL. Please try again.');
  }
}

async function launchDeploy(ctx: Context, deploy: import('./parser.js').DeployCmd, rawText: string): Promise<void> {
  const uid = userId(ctx);
  const cid = channelId(ctx);

  if (!deploy.createNamespace && (await needsNamespaceCreatePrompt(deploy))) {
    storeNamespaceCreatePrompt(PLATFORM, cid, uid, deploy);
    await replyFormatted(
      ctx,
      buildNamespaceCreatePrompt(deploy),
      Markup.inlineKeyboard([
        [Markup.button.callback('Yes, create namespace', 'namespace_create_yes')],
        [Markup.button.callback('Cancel', 'namespace_create_cancel')],
      ]).reply_markup
    );
    return;
  }

  const result = await handleCommand(deploy, uid, PLATFORM, cid, rawText);
  await safeReply(
    ctx,
    result.immediateReply ?? ackMessage(result.incidentId, deploy.type, deploy)
  );
}

async function processText(ctx: Context, rawText: string): Promise<void> {
  const uid = userId(ctx);
  const cid = channelId(ctx);

  if (!isAuthorized(uid, PLATFORM)) {
    await safeReply(ctx, '🚫 You are not authorized to use this bot.');
    return;
  }

  void recordChatUserTurn(PLATFORM, cid, uid, rawText);

  const pendingRun = await tryPendingRunFollowUp(rawText, PLATFORM, cid, uid);
  if (pendingRun) {
    await safeReply(ctx, pendingRun.reply, pendingRun.quickActions);
    return;
  }

  const suggestReply = tryConsumeSuggestReply(PLATFORM, cid, uid, rawText);
  if (suggestReply.status === 'ready') {
    await submitOperatorSuggestion(ctx, suggestReply.incidentId, suggestReply.suggestion, uid);
    return;
  }

  const nsDecision = tryResolveNamespaceCreateChoice(PLATFORM, cid, uid, rawText);
  if (nsDecision.status === 'cancelled') {
    await safeReply(ctx, 'Deploy cancelled — namespace will not be created.');
    return;
  }
  if (nsDecision.status === 'approved' && nsDecision.deploy) {
    await launchDeploy(ctx, nsDecision.deploy, rawText);
    return;
  }

  const decision = tryResolvePendingChoice(PLATFORM, cid, uid, rawText);
  if (decision.status === 'cancelled') {
    await safeReply(ctx, 'Deploy request cancelled.');
    return;
  }
  if (decision.status === 'selected' && decision.deploy) {
    await launchDeploy(ctx, decision.deploy, rawText);
    return;
  }

  const delDecision = tryResolvePendingDeleteChoice(PLATFORM, cid, uid, rawText);
  if (delDecision.status === 'cancelled') {
    await safeReply(ctx, 'Delete cancelled.');
    return;
  }
  if (delDecision.status === 'selected' && delDecision.command) {
    try {
      const result = await handleCommand(delDecision.command, uid, PLATFORM, cid, rawText);
      await safeReply(
        ctx,
        result.immediateReply ?? ackMessage(result.incidentId, delDecision.command.type, delDecision.command)
      );
    } catch (err) {
      await safeReply(ctx, `⚠️ ${String(err)}`);
    }
    return;
  }

  const invDecision = tryResolvePendingInvestigateChoice(PLATFORM, cid, uid, rawText);
  if (invDecision.status === 'cancelled') {
    await safeReply(ctx, 'Investigation cancelled.');
    return;
  }
  if (invDecision.status === 'selected' && invDecision.command) {
    if (invDecision.statusQuery) {
      try {
        const text = await fetchWorkloadStatusReply({
          incidentId: uuidv4(),
          namespace: invDecision.command.namespace,
          resourceName: invDecision.command.resourceName,
          resourceKind: invDecision.command.resourceKind,
          podName: invDecision.command.podName,
        });
        void rememberWorkloadStatusQuery(PLATFORM, cid, uid, {
          resourceName: invDecision.command.resourceName,
          resourceKind: invDecision.command.resourceKind,
          namespace: invDecision.command.namespace,
        });
        await safeReply(ctx, text);
      } catch (err) {
        await safeReply(ctx, `⚠️ Could not check status: ${String(err)}`);
      }
      return;
    }
    const result = await handleCommand(invDecision.command, uid, PLATFORM, cid, rawText);
    await safeReply(
      ctx,
      result.immediateReply ?? ackMessage(result.incidentId, invDecision.command.type, invDecision.command)
    );
    return;
  }

  const routed = await routeMessage(rawText, PLATFORM, uid, cid);
  let parsed = routed.parsed;

  if (parsed.type === 'unknown' && routed.conversationalReply) {
    await safeReply(ctx, routed.conversationalReply);
    return;
  }
  if (routed.conversationalReply && parsed.type === 'deploy') {
    await safeReply(ctx, routed.conversationalReply);
  }
  log('info', AGENT, 'Telegram message received', {
    incidentId: 'N/A',
    userId: uid,
    channelId: cid,
    commandType: parsed.type,
  });

  try {
    if (parsed.type === 'deploy' && !parsed.deployStrategyExplicit) {
      const prompt = await buildDeployChoicePrompt(PLATFORM, cid, uid, parsed);
      await replyFormatted(
        ctx,
        prompt,
        Markup.inlineKeyboard([
          [
            Markup.button.callback('GitOps', 'deploy_choice_gitops'),
            Markup.button.callback('Direct (No Git Push)', 'deploy_choice_direct'),
          ],
          [Markup.button.callback('Cancel', 'deploy_choice_cancel')],
        ]).reply_markup
      );
      return;
    }
    if (parsed.type === 'investigate') {
      const flow = await resolveInvestigateFlow(parsed, rawText, {
        platform: PLATFORM,
        verbose: getChannelPref(PLATFORM, cid).verbose,
        incidentId: uuidv4(),
      });
      if (flow.kind === 'reply') {
        await safeReply(ctx, flow.text);
        return;
      }
      if (flow.kind === 'confirm') {
        storeInvestigateChoice(PLATFORM, cid, uid, rawText, parsed, flow.candidates);
        const choiceButtons = flow.candidates.slice(0, 4).map((c, i) =>
          Markup.button.callback(`${i + 1}. ${c.resourceName}`, `investigate_choice_${i}`)
        );
        const rows: ReturnType<typeof Markup.button.callback>[][] = [];
        for (let i = 0; i < choiceButtons.length; i += 2) {
          rows.push(choiceButtons.slice(i, i + 2));
        }
        rows.push([Markup.button.callback('Cancel', 'investigate_choice_cancel')]);
        await replyFormatted(ctx, flow.prompt, Markup.inlineKeyboard(rows).reply_markup);
        return;
      }
      if (flow.kind === 'ready') {
        parsed = flow.command;
        if (isWorkloadStatusQuery(rawText)) {
          const text = await fetchWorkloadStatusReply({
            incidentId: uuidv4(),
            namespace: parsed.namespace,
            resourceName: parsed.resourceName,
            resourceKind: parsed.resourceKind,
            podName: parsed.podName,
          });
          void rememberWorkloadStatusQuery(PLATFORM, cid, uid, {
            resourceName: parsed.resourceName,
            resourceKind: parsed.resourceKind,
            namespace: parsed.namespace,
          });
          await safeReply(ctx, text);
          return;
        }
      }
    }
    if (parsed.type === 'deploy') {
      await launchDeploy(ctx, parsed, rawText);
      return;
    }
    const result = await handleCommand(parsed, uid, PLATFORM, cid, rawText);
    await safeReply(
      ctx,
      result.immediateReply ?? ackMessage(result.incidentId, parsed.type, parsed),
      result.quickActions
    );
  } catch (err) {
    log('error', AGENT, 'Error handling Telegram message', {
      incidentId: 'N/A',
      userId: uid,
      channelId: cid,
      error: String(err),
    });
    await safeReply(ctx, '⚠️ An internal error occurred. Please try again.');
  }
}

// ── Bot factory ───────────────────────────────────────────────────────────────

export function createTelegramBot(): Telegraf {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN must be set to enable the Telegram integration');
  }

  const bot = new Telegraf(token);

  // Register with confirm.ts so it can push result messages
  registerTelegramBot(bot);
  registerTelegramBotForNotify(bot);

  // ── /start — onboarding ────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    const uid = userId(ctx);
    if (!isAuthorized(uid, PLATFORM)) {
      await safeReply(ctx, '🚫 You are not authorized to use this bot.');
      return;
    }
    await safeReply(
      ctx,
      'Welcome to the Kube SRE Bot!\n\n' +
        'Commands:\n' +
        '/deploy <github-url> [@branch] — deploy a service\n' +
        '/deploy <github-url> --no-git-push — deploy directly from source repo\n' +
        '/get namespaces|pods|deployments — or: get all pods\n' +
        '/investigate — e.g. cluster health, frappe deployment\n' +
        '/rollback [namespace/]<resource> — roll back a deployment\n\n' +
        'You can also send free-form messages and I will try to understand.'
    );
  });

  // ── /deploy ────────────────────────────────────────────────────────────────
  bot.command('deploy', async (ctx) => {
    const rawText = ctx.message.text.replace(/^\/deploy\s*/i, '').trim();
    if (!rawText) {
      await safeReply(
        ctx,
        'Usage: /deploy github.com/org/repo [@branch] [--namespace ns] [--no-git-push]'
      );
      return;
    }
    await processText(ctx, `deploy ${rawText}`);
  });

  // ── /get ───────────────────────────────────────────────────────────────────
  bot.command('get', async (ctx) => {
    const rest = ctx.message.text.replace(/^\/get\s*/i, '').trim() || 'namespaces';
    await processText(ctx, `get ${rest}`);
  });

  // ── /investigate ───────────────────────────────────────────────────────────
  bot.command('investigate', async (ctx) => {
    const rest = ctx.message.text.replace(/^\/investigate\s*/i, '').trim();
    await processText(ctx, `investigate ${rest}`);
  });

  // ── /rollback ──────────────────────────────────────────────────────────────
  bot.command('rollback', async (ctx) => {
    const rest = ctx.message.text.replace(/^\/rollback\s*/i, '').trim();
    await processText(ctx, `rollback ${rest}`);
  });

  // ── Free-form text messages ────────────────────────────────────────────────
  bot.on(message('text'), async (ctx) => {
    // Skip if it starts with "/" (already handled by command handlers above)
    if (ctx.message.text.startsWith('/')) return;
    await processText(ctx, ctx.message.text.trim());
  });

  // ── Callback Query handler ──────────────────────────────────────────────────
  bot.on('callback_query', async (ctx) => {
    const data = (ctx.callbackQuery as { data?: string }).data ?? '';
    if (data.startsWith('investigate_choice_')) {
      const uid = String(ctx.callbackQuery.from.id);
      const cid = channelId(ctx);
      const suffix = data.replace('investigate_choice_', '');
      if (suffix === 'cancel') {
        const resolved = resolveInvestigateChoiceSelection(PLATFORM, cid, uid, 'cancel');
        await ctx.answerCbQuery('Cancelled');
        if (resolved.status === 'cancelled') {
          await ctx.editMessageText('Investigation cancelled.').catch(() => {});
        }
        return;
      }
      const index = parseInt(suffix, 10);
      if (Number.isNaN(index)) {
        await ctx.answerCbQuery('Invalid choice');
        return;
      }
      const resolved = resolveInvestigateChoiceSelection(PLATFORM, cid, uid, index);
      if (resolved.status === 'none') {
        await ctx.answerCbQuery('Choice expired. Please try again.');
        return;
      }
      if (!resolved.command) {
        await ctx.answerCbQuery('No selection');
        return;
      }
      await ctx.answerCbQuery(resolved.statusQuery ? 'Checking status…' : 'Starting investigation…');
      try {
        if (resolved.statusQuery) {
          const text = await fetchWorkloadStatusReply({
            incidentId: uuidv4(),
            namespace: resolved.command.namespace,
            resourceName: resolved.command.resourceName,
            resourceKind: resolved.command.resourceKind,
            podName: resolved.command.podName,
          });
          void rememberWorkloadStatusQuery(PLATFORM, cid, uid, {
            resourceName: resolved.command.resourceName,
            resourceKind: resolved.command.resourceKind,
            namespace: resolved.command.namespace,
          });
          await ctx.editMessageText(text).catch(() => safeReply(ctx, text));
          return;
        }
        const result = await handleCommand(
          resolved.command,
          uid,
          PLATFORM,
          cid,
          `investigate choice: ${resolved.command.label}`
        );
        const replyText =
          result.immediateReply ??
          ackMessage(result.incidentId, resolved.command.type, resolved.command);
        await editOrReply(ctx, replyText);
      } catch (err) {
        log('error', AGENT, 'Failed to start investigate after workload selection', {
          incidentId: 'N/A',
          error: String(err),
        });
        await editOrReply(ctx, '⚠️ Failed to start investigation. Please try again.');
      }
      return;
    }

    if (data.startsWith('deploy_choice_')) {
      const choice = data.replace('deploy_choice_', '') as 'gitops' | 'direct' | 'cancel';
      const uid = String(ctx.callbackQuery.from.id);
      const cid = channelId(ctx);
      const resolved = resolvePendingChoiceSelection(PLATFORM, cid, uid, choice);

      if (resolved.status === 'none') {
        await ctx.answerCbQuery('Choice expired. Please run /deploy again.');
        return;
      }
      if (resolved.status === 'cancelled') {
        await ctx.answerCbQuery('Cancelled');
        await ctx.editMessageText('Deploy request cancelled.').catch(() => {});
        return;
      }
      if (!resolved.deploy) {
        await ctx.answerCbQuery('No deploy payload found');
        return;
      }

      await ctx.answerCbQuery(`Selected: ${choice}`);
      try {
        if (!resolved.deploy.createNamespace && (await needsNamespaceCreatePrompt(resolved.deploy))) {
          storeNamespaceCreatePrompt(PLATFORM, cid, uid, resolved.deploy);
          await ctx.editMessageText(
            buildNamespaceCreatePrompt(resolved.deploy),
            Markup.inlineKeyboard([
              [Markup.button.callback('Yes, create namespace', 'namespace_create_yes')],
              [Markup.button.callback('Cancel', 'namespace_create_cancel')],
            ])
          ).catch(() => {});
          return;
        }
        const result = await handleCommand(
          resolved.deploy,
          uid,
          PLATFORM,
          cid,
          `deploy choice: ${choice}`
        );
        const replyText =
          result.immediateReply ??
          ackMessage(result.incidentId, resolved.deploy.type, resolved.deploy);
        await editOrReply(ctx, replyText);
      } catch (err) {
        log('error', AGENT, 'Failed to start deploy after strategy selection', {
          incidentId: 'N/A',
          userId: uid,
          channelId: cid,
          error: String(err),
        });
        await editOrReply(ctx, '⚠️ Failed to start deploy. Please try again.');
      }
      return;
    }

    if (data === 'namespace_create_yes' || data === 'namespace_create_cancel') {
      const uid = String(ctx.callbackQuery.from.id);
      const cid = channelId(ctx);
      const selection = data === 'namespace_create_yes' ? 'approve' : 'cancel';
      const resolved = resolveNamespaceCreateSelection(PLATFORM, cid, uid, selection);
      if (resolved.status === 'none') {
        await ctx.answerCbQuery('Prompt expired. Run deploy again.');
        return;
      }
      if (resolved.status === 'cancelled') {
        await ctx.answerCbQuery('Cancelled');
        await ctx.editMessageText('Deploy cancelled — namespace not created.').catch(() => {});
        return;
      }
      if (!resolved.deploy) {
        await ctx.answerCbQuery('No deploy context');
        return;
      }
      await ctx.answerCbQuery('Creating namespace and starting deploy…');
      try {
        const result = await handleCommand(
          resolved.deploy,
          uid,
          PLATFORM,
          cid,
          'namespace create approved'
        );
        await ctx.editMessageText(
          result.immediateReply ??
            ackMessage(result.incidentId, resolved.deploy.type, resolved.deploy)
        ).catch(() => {});
      } catch (err) {
        log('error', AGENT, 'Failed deploy after namespace approval', { error: String(err) });
        await ctx.editMessageText('⚠️ Failed to start deploy. Please try again.').catch(() => {});
      }
      return;
    }

    if (data.startsWith('show_details_')) {
      const runId = data.slice('show_details_'.length);
      await ctx.answerCbQuery('Loading logs…');
      try {
        const text = await fetchRunDetailsText(runId, { verbose: true });
        await safeReply(ctx, text);
      } catch (err) {
        log('error', AGENT, 'show_details failed', { incidentId: runId, error: String(err) });
        await safeReply(ctx, 'Could not load run details. Try again later.');
      }
      return;
    }

    if (data.startsWith('hil_suggest_')) {
      const incidentId = data.slice('hil_suggest_'.length);
      const uid = String(ctx.callbackQuery.from.id);
      const cid = channelId(ctx);
      storeHilSuggestPrompt(PLATFORM, cid, uid, incidentId);
      await ctx.answerCbQuery('Send your fix as the next message');
      await safeReply(ctx, buildSuggestFixPrompt(incidentId));
      return;
    }

    if (!data.startsWith('hil_')) {
      await ctx.answerCbQuery('Unknown action');
      return;
    }

    const [, action, ...parts] = data.split('_');
    if (!action) {
      await ctx.answerCbQuery('Unknown action');
      return;
    }
    const incidentId = parts.join('_');
    const userId = ctx.callbackQuery.from.username ?? String(ctx.callbackQuery.from.id);

    log('info', AGENT, `Telegram callback query received: ${action}`, { incidentId, userId });

    // Telegram requires answerCbQuery within a few seconds — do not await HIL first.
    const ackLabel =
      action === 'approve'
        ? '✅ Approved — applying…'
        : action === 'reject'
          ? '❌ Rejected'
          : action === 'ignore'
            ? '🔕 Ignored'
            : 'Processing…';
    try {
      await ctx.answerCbQuery(ackLabel);
    } catch (ackErr) {
      log('warn', AGENT, 'answerCbQuery failed (may be stale)', {
        incidentId,
        error: String(ackErr),
      });
    }

    const actorLabel = ctx.callbackQuery.from.username
      ? `@${ctx.callbackQuery.from.username}`
      : `user ${userId}`;
    if (action === 'approve') {
      await editHilApprovalCard(
        ctx,
        `✅ Approved by ${actorLabel} via Telegram.\nDispatching remediation for ${incidentId}…`,
        incidentId
      );
    } else if (action === 'reject') {
      await editHilApprovalCard(ctx, `❌ Rejected by ${actorLabel} via Telegram.`, incidentId);
    } else if (action === 'ignore') {
      await editHilApprovalCard(
        ctx,
        `🔕 Ignored by ${actorLabel} — I won't remediate ${incidentId} again for this resource.`,
        incidentId
      );
    }

    forwardHilAction(ctx, action, incidentId, userId);
  });

  // ── Error handler ──────────────────────────────────────────────────────────
  bot.catch((err: unknown, ctx: Context) => {
    log('error', AGENT, 'Telegraf unhandled error', {
      incidentId: 'N/A',
      userId: userId(ctx),
      error: String(err),
    });
  });

  return bot;
}
