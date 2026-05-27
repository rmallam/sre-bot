/**
 * src/dispatcher.ts
 *
 * Orchestrates the full HIL approval flow:
 *   1. Receives ApprovalRequest → adds to store
 *   2. Fans out to Slack + Telegram (web dashboard auto-refreshes via polling)
 *   3. onApproved: builds RemediateCommand and POSTs to GitOps agent
 *   4. onRejected: notifies Brain to increment circuit breaker; logs everywhere
 *
 * Environment variables:
 *   GITOPS_URL   (default: http://gitops-agent:8080)
 *   BRAIN_URL    (default: http://brain-agent:8080)
 */

import { approvalStore } from './store.js';
import type { PendingApproval } from './store.js';
import { notifySlack } from './slack-notifier.js';
import { notifyTelegram } from './telegram-notifier.js';
import { postWithRetry, log } from '../../../shared/src/http.js';
import type {
  ApprovalRequest,
  Platform,
  RemediateCommand,
} from '../../../shared/src/types.js';

const AGENT = 'hil-agent';

const GITOPS_URL = process.env['GITOPS_URL'] ?? 'http://gitops-agent:8080';
const EXECUTOR_URL = process.env['EXECUTOR_URL'] ?? 'http://executor-agent:8080';
const ORCHESTRATOR_URL = process.env['ORCHESTRATOR_URL'] ?? 'http://orchestrator-agent:8080';
const BRAIN_URL  = process.env['BRAIN_URL']  ?? 'http://brain-agent:8080';

// ── Public interface ──────────────────────────────────────────────────────────

/**
 * Ingest a new ApprovalRequest, persist it, and fan out notifications.
 */
export async function dispatch(request: ApprovalRequest): Promise<void> {
  const { incidentId } = request;

  log('info', AGENT, 'Dispatching approval request', {
    incidentId,
    resourceName: request.resourceName,
    namespace: request.namespace,
    severity: request.plan.severity,
    escalated: request.escalated,
    attemptNumber: request.attemptNumber,
  });

  // 1. Add to store (idempotent)
  approvalStore.add(request);

  // 2. Fan-out to all notification platforms concurrently
  const notifications: Promise<void>[] = [
    notifySlack(request).catch((err) =>
      log('error', AGENT, 'Slack notification failed', {
        incidentId,
        error: String(err),
      })
    ),
    notifyTelegram(request).catch((err) =>
      log('error', AGENT, 'Telegram notification failed', {
        incidentId,
        error: String(err),
      })
    ),
  ];

  await Promise.allSettled(notifications);

  log('info', AGENT, 'Fan-out complete — waiting for human decision', {
    incidentId,
  });
}

/**
 * Called (from any platform) when an approval is confirmed by the store.
 * Builds a RemediateCommand and POSTs it to the GitOps agent.
 */
export async function onApproved(
  entry: PendingApproval,
  approvedBy: string,
  approvedVia: Platform
): Promise<void> {
  const { request } = entry;
  const { incidentId } = request;

  log('info', AGENT, 'Approval confirmed — dispatching to GitOps', {
    incidentId,
    approvedBy,
    approvedVia,
  });

  const command: RemediateCommand = {
    incidentId: request.incidentId,
    triggeredBy: request.triggeredBy,
    triggeredAt: request.triggeredAt,
    namespace: request.namespace,
    resourceKind: request.resourceKind,
    resourceName: request.resourceName,
    mode: request.mode,
    plan: request.plan,
    approvedBy,
    approvedAt: new Date().toISOString(),
    approvedVia,
    requestedBy: request.requestedBy,
    platform: request.platform,
    channelId: request.channelId,
    runId: request.runId,
  };

  const action = request.plan.action ?? 'git_patch';

  // Orchestrator-managed run: resume graph (act + verify) — avoid double dispatch
  if (request.runId) {
    await postWithRetry({
      url: `${ORCHESTRATOR_URL}/resume-run`,
      payload: { runId: request.runId, approved: true, approvedBy, approvedVia, command },
      incidentId,
      callerAgent: AGENT,
      maxAttempts: 5,
      initialDelayMs: 500,
    });
    log('info', AGENT, 'Orchestrator resume-run dispatched', {
      incidentId,
      runId: request.runId,
      action,
      approvedBy,
    });
    return;
  }

  const targetUrl =
    action === 'restart' ? `${EXECUTOR_URL}/execute` : `${GITOPS_URL}/remediate`;

  await postWithRetry({
    url: targetUrl,
    payload: command,
    incidentId,
    callerAgent: AGENT,
    maxAttempts: 5,
    initialDelayMs: 500,
  });

  log('info', AGENT, 'RemediateCommand dispatched (legacy)', {
    incidentId,
    targetUrl,
    action,
    approvedBy,
    approvedVia,
  });
}

/**
 * Called (from any platform) when an approval is rejected by the store.
 * Notifies the Brain agent so it can increment the circuit breaker counter
 * and decide whether to escalate or give up.
 */
export async function onRejected(
  entry: PendingApproval,
  rejectedBy: string,
  rejectedVia: Platform,
  reason: string
): Promise<void> {
  const { request } = entry;
  const { incidentId } = request;

  log('warn', AGENT, 'Approval rejected by human', {
    incidentId,
    rejectedBy,
    rejectedVia,
    reason,
  });

  // Notify Brain so it can increment the circuit breaker and decide next steps.
  // The Brain's /rejection endpoint receives a structured payload.
  const rejectionNotice = {
    incidentId,
    triggeredBy: request.triggeredBy,
    triggeredAt: request.triggeredAt,
    namespace: request.namespace,
    resourceKind: request.resourceKind,
    resourceName: request.resourceName,
    mode: request.mode,
    rejectedBy,
    rejectedVia,
    reason,
    attemptNumber: request.attemptNumber,
    circuitBreakerLimit: request.circuitBreakerLimit,
    plan: request.plan,
    requestedBy: request.requestedBy,
    platform: request.platform,
    channelId: request.channelId,
  };

  await postWithRetry({
    url: `${BRAIN_URL}/rejection`,
    payload: rejectionNotice,
    incidentId,
    callerAgent: AGENT,
    maxAttempts: 5,
    initialDelayMs: 500,
  });

  log('info', AGENT, 'Rejection notice sent to Brain agent', {
    incidentId,
    brainUrl: `${BRAIN_URL}/rejection`,
  });
}
