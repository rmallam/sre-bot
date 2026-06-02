/**
 * src/slack-notifier.ts
 *
 * Sends HIL approval requests to Slack using @slack/bolt.
 * Posts interactive messages with Approve/Reject buttons.
 * Handles button actions atomically via ApprovalStore.
 *
 * Required environment variables:
 *   SLACK_BOT_TOKEN      — xoxb-...
 *   SLACK_SIGNING_SECRET — from Slack app settings
 *   SLACK_ALERT_CHANNEL  — #channel-name or channel ID
 */

import pkg from '@slack/bolt';
import type { App, BlockAction, ButtonAction } from '@slack/bolt';
import { approvalStore } from './store.js';
import { onApproved, onRejected, onIgnored } from './dispatcher.js';
import { log } from '../../../shared/src/http.js';
import type { ApprovalRequest } from '../../../shared/src/types.js';

const AGENT = 'hil-agent';

const SLACK_BOT_TOKEN     = process.env['SLACK_BOT_TOKEN'] ?? '';
const SLACK_SIGNING_SECRET = process.env['SLACK_SIGNING_SECRET'] ?? '';
const SLACK_ALERT_CHANNEL  = process.env['SLACK_ALERT_CHANNEL'] ?? '#sre-alerts';

/** Lazily-initialised Slack app — only started if token is configured. */
let slackApp: App | null = null;

function getSlackApp(): App | null {
  if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET) return null;
  if (slackApp) return slackApp;

  slackApp = new pkg.App({
    token: SLACK_BOT_TOKEN,
    signingSecret: SLACK_SIGNING_SECRET,
    // We register actions manually below, no listener needed for basic setup
  });

  // ── Action: Approve ───────────────────────────────────────────────────────
  slackApp.action<BlockAction<ButtonAction>>(
    /^hil_approve_/,
    async ({ action, ack, respond, body }) => {
      await ack();

      const actionId: string = action.action_id;
      const incidentId = actionId.replace('hil_approve_', '');
      const userId = body.user.id;
      const username = body.user.name ?? body.user.id;

      log('info', AGENT, 'Slack approve button clicked', { incidentId, userId });

      const result = approvalStore.tryApprove(incidentId, username, 'slack');

      if (result === 'ok') {
        const entry = approvalStore.get(incidentId)!;
        await onApproved(entry, username, 'slack');
        await respond({
          replace_original: true,
          text: `✅ *Approved* by <@${userId}> via Slack.\nDispatching remediation for \`${incidentId}\`…`,
        });
      } else if (result === 'already_handled') {
        const entry = approvalStore.get(incidentId);
        await respond({
          replace_original: false,
          text: `ℹ️ This incident has already been handled (${entry?.status ?? 'unknown'}).`,
        });
      } else if (result === 'expired') {
        await respond({
          replace_original: true,
          text: `⏰ Approval window expired for \`${incidentId}\`. No action taken.`,
        });
      } else {
        await respond({
          replace_original: false,
          text: `❓ Unknown incident \`${incidentId}\`.`,
        });
      }
    }
  );

  // ── Action: Suggest fix (instructions — text capture via Telegram or web UI) ─
  slackApp.action<BlockAction<ButtonAction>>(
    /^hil_suggest_/,
    async ({ action, ack, respond }) => {
      await ack();
      const incidentId = action.action_id.replace('hil_suggest_', '');
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text:
          `✏️ Suggest a fix for \`${incidentId}\`:\n` +
          `• Use the HIL web dashboard (Suggest fix form), or\n` +
          `• Use Telegram and tap *Suggest fix*, then reply with your fix.\n\n` +
          `Examples: \`restart\`, \`add imagePullSecrets ghcr-creds\`, \`set image to nginx:1.25\``,
      });
    }
  );

  // ── Action: Reject ────────────────────────────────────────────────────────
  slackApp.action<BlockAction<ButtonAction>>(
    /^hil_reject_/,
    async ({ action, ack, respond, body }) => {
      await ack();

      const actionId: string = action.action_id;
      const incidentId = actionId.replace('hil_reject_', '');
      const userId = body.user.id;
      const username = body.user.name ?? body.user.id;

      log('info', AGENT, 'Slack reject button clicked', { incidentId, userId });

      const result = approvalStore.tryReject(
        incidentId,
        username,
        'slack',
        'Rejected via Slack'
      );

      if (result === 'ok') {
        const entry = approvalStore.get(incidentId)!;
        await onRejected(entry, username, 'slack', 'Rejected via Slack');
        await respond({
          replace_original: true,
          text: `❌ *Rejected* by <@${userId}> via Slack.`,
        });
      } else if (result === 'already_handled') {
        const entry = approvalStore.get(incidentId);
        await respond({
          replace_original: false,
          text: `ℹ️ This incident has already been handled (${entry?.status ?? 'unknown'}).`,
        });
      } else {
        await respond({
          replace_original: false,
          text: `❓ Unknown incident \`${incidentId}\`.`,
        });
      }
    }
  );

  // ── Action: Ignore ────────────────────────────────────────────────────────
  slackApp.action<BlockAction<ButtonAction>>(
    /^hil_ignore_/,
    async ({ action, ack, respond, body }) => {
      await ack();

      const incidentId = action.action_id.replace('hil_ignore_', '');
      const userId = body.user.id;
      const username = body.user.name ?? body.user.id;

      log('info', AGENT, 'Slack ignore button clicked', { incidentId, userId });

      const result = approvalStore.tryIgnore(
        incidentId,
        username,
        'slack',
        'Ignored via Slack'
      );

      if (result === 'ok') {
        const entry = approvalStore.get(incidentId)!;
        await onIgnored(entry, username, 'slack', 'Ignored via Slack');
        await respond({
          replace_original: true,
          text: `🔕 *Ignored* by <@${userId}> — this resource won't be remediated again.`,
        });
      } else if (result === 'already_handled') {
        const entry = approvalStore.get(incidentId);
        await respond({
          replace_original: false,
          text: `ℹ️ This incident has already been handled (${entry?.status ?? 'unknown'}).`,
        });
      } else {
        await respond({
          replace_original: false,
          text: `❓ Unknown incident \`${incidentId}\`.`,
        });
      }
    }
  );

  return slackApp;
}

/**
 * Initialise the Slack app and start listening for interactions.
 * Must be called once at startup. Returns the port it is listening on,
 * or null if Slack is not configured.
 */
export async function startSlack(socketPort = 3001): Promise<number | null> {
  const app = getSlackApp();
  if (!app) {
    log('warn', AGENT, 'Slack not configured — SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET missing');
    return null;
  }

  await app.start(socketPort);
  log('info', AGENT, `Slack bolt app listening`, { port: socketPort });
  return socketPort;
}

/**
 * Post an approval request message to the configured Slack channel.
 */
export async function notifySlack(request: ApprovalRequest): Promise<void> {
  const app = getSlackApp();
  if (!app) {
    log('warn', AGENT, 'Slack not configured — skipping notification', {
      incidentId: request.incidentId,
    });
    return;
  }

  const { plan, incidentId, resourceKind, resourceName, namespace, escalated } = request;

  const patchText = plan.proposedPatch
    .map((op) => {
      const val = op.value !== undefined ? ` → ${JSON.stringify(op.value)}` : '';
      return `${op.op.padEnd(7)} ${op.path}${val}`;
    })
    .join('\n');

  const escalationHeader = escalated
    ? [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '⚠️ *ESCALATED* — Circuit breaker fired. Human action required.',
          },
        },
        { type: 'divider' },
      ]
    : [];

  try {
    await app.client.chat.postMessage({
      channel: SLACK_ALERT_CHANNEL,
      text: `[HIL] Approval required for ${resourceKind}/${resourceName} (${incidentId})`,
      blocks: [
        ...escalationHeader,
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `🛡️ Approval Required — ${resourceKind}/${resourceName}`,
            emoji: true,
          },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Incident ID*\n\`${incidentId}\`` },
            { type: 'mrkdwn', text: `*Namespace*\n\`${namespace}\`` },
            { type: 'mrkdwn', text: `*Severity*\n${plan.severity}` },
            { type: 'mrkdwn', text: `*Attempt*\n#${request.attemptNumber} / ${request.circuitBreakerLimit}` },
          ],
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Root Cause*\n${plan.rootCause}`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Reasoning*\n${plan.reasoning}`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Proposed Patch* — \`${plan.targetManifestPath}\`\n\`\`\`${patchText}\`\`\``,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Commit* \`${plan.commitMessage}\`\n*Rollback Safe:* ${plan.rollbackSafe ? '✅ Yes' : '❌ No'}`,
          },
        },
        { type: 'divider' },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅ Approve', emoji: true },
              style: 'primary',
              action_id: `hil_approve_${incidentId}`,
              value: incidentId,
              confirm: {
                title: { type: 'plain_text', text: 'Confirm Approval' },
                text: {
                  type: 'mrkdwn',
                  text: `Approve remediation for *${resourceKind}/${resourceName}*? This will trigger a GitOps commit.`,
                },
                confirm: { type: 'plain_text', text: 'Yes, Approve' },
                deny: { type: 'plain_text', text: 'Cancel' },
              },
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '❌ Reject', emoji: true },
              style: 'danger',
              action_id: `hil_reject_${incidentId}`,
              value: incidentId,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '🔕 Ignore', emoji: true },
              action_id: `hil_ignore_${incidentId}`,
              value: incidentId,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '✏️ Suggest fix', emoji: true },
              action_id: `hil_suggest_${incidentId}`,
              value: incidentId,
            },
          ],
        },
      ],
    });

    log('info', AGENT, 'Slack notification sent', {
      incidentId,
      channel: SLACK_ALERT_CHANNEL,
    });
  } catch (err) {
    log('error', AGENT, 'Failed to send Slack notification', {
      incidentId,
      error: String(err),
    });
  }
}
