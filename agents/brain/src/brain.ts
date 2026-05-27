/**
 * brain.ts
 *
 * Orchestration core of the brain-agent.
 *
 * Flow for a normal attempt:
 *   1. Check circuit breaker (Kubernetes CRD)
 *   2a. If limit reached → markEscalated + send escalated ApprovalRequest to HIL
 *   2b. Otherwise → call Gemini, increment attemptCount, send ApprovalRequest to HIL
 *
 * The circuit breaker limit is configurable via CIRCUIT_BREAKER_LIMIT (default 3).
 * HIL endpoint is configurable via HIL_URL (default http://hil-agent:8080).
 */

import type { DiagnosisContext, ApprovalRequest, RemediationPlan } from '../../../shared/src/types.js';
import { postWithRetry, log } from '../../../shared/src/http.js';
import {
  getAttemptCount,
  incrementAttemptCount,
  markEscalated,
  CIRCUIT_BREAKER_LIMIT,
} from './circuit-breaker.js';
import { diagnose } from './gemini.js';

const AGENT = 'brain-agent';

const HIL_URL = process.env['HIL_URL'] ?? 'http://hil-agent:8080';

// ── Escalation plan (no Gemini call) ─────────────────────────────────────────

function buildEscalationPlan(ctx: DiagnosisContext): RemediationPlan {
  return {
    action: 'escalate_human',
    rootCause: `Circuit breaker triggered after ${CIRCUIT_BREAKER_LIMIT} failed attempts. Manual investigation required.`,
    reasoning: `The automated remediation pipeline attempted to resolve this incident ${CIRCUIT_BREAKER_LIMIT} times without success. Further automated attempts would risk cascading failures. Human operator must review and intervene.`,
    severity: 'CRITICAL',
    proposedPatch: [],
    targetManifestPath: ctx.gitManifestPath ?? `deployments/${ctx.resourceName}.yaml`,
    commitMessage: `escalate(${ctx.resourceName}): circuit breaker triggered — manual intervention required`,
    rollbackSafe: false,
  };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function runBrain(ctx: DiagnosisContext): Promise<void> {
  const { incidentId, namespace, resourceName } = ctx;

  log('info', AGENT, 'Brain orchestration started', {
    incidentId,
    namespace,
    resourceName,
    mode: ctx.mode,
  });

  // Step 1: Check circuit breaker state (persisted in K8s CRD)
  let attemptCount: number;
  try {
    attemptCount = await getAttemptCount(namespace, resourceName);
  } catch (err) {
    log('error', AGENT, 'Failed to read circuit breaker state from CRD', {
      incidentId,
      namespace,
      resourceName,
      error: String(err),
    });
    throw err;
  }

  log('info', AGENT, 'Circuit breaker state read', {
    incidentId,
    namespace,
    resourceName,
    attemptCount,
    limit: CIRCUIT_BREAKER_LIMIT,
  });

  // Step 2a: Circuit breaker fired — escalate immediately, skip Gemini
  if (attemptCount >= CIRCUIT_BREAKER_LIMIT) {
    log('warn', AGENT, 'Circuit breaker limit reached — escalating to HIL', {
      incidentId,
      namespace,
      resourceName,
      attemptCount,
      limit: CIRCUIT_BREAKER_LIMIT,
    });

    try {
      await markEscalated(namespace, resourceName);
    } catch (err) {
      log('error', AGENT, 'Failed to mark incident as escalated in CRD', {
        incidentId,
        namespace,
        resourceName,
        error: String(err),
      });
      // Continue — still send the escalated HIL request even if CRD patch fails
    }

    const escalatedRequest: ApprovalRequest = {
      // IncidentEnvelope passthrough
      incidentId: ctx.incidentId,
      triggeredBy: ctx.triggeredBy,
      triggeredAt: ctx.triggeredAt,
      namespace: ctx.namespace,
      resourceKind: ctx.resourceKind,
      resourceName: ctx.resourceName,
      mode: ctx.mode,
      // ApprovalRequest fields
      plan: buildEscalationPlan(ctx),
      attemptNumber: attemptCount,
      circuitBreakerLimit: CIRCUIT_BREAKER_LIMIT,
      escalated: true,
      requestedBy: ctx.requestedBy,
      platform: ctx.platform,
      channelId: ctx.channelId,
    };

    await postWithRetry({
      url: `${HIL_URL}/request-approval`,
      payload: escalatedRequest,
      incidentId,
      callerAgent: AGENT,
    });

    log('info', AGENT, 'Escalated ApprovalRequest sent to HIL', {
      incidentId,
      namespace,
      resourceName,
      hilUrl: `${HIL_URL}/request-approval`,
    });

    return;
  }

  // Step 2b: Within limit — call Gemini for a remediation plan
  let plan: RemediationPlan;
  try {
    plan = await diagnose(ctx);
  } catch (err) {
    // Count this as a failed attempt so the circuit breaker tracks Gemini failures too
    log('error', AGENT, 'Gemini diagnosis failed', {
      incidentId,
      namespace,
      resourceName,
      error: String(err),
    });

    try {
      await incrementAttemptCount(namespace, resourceName, incidentId);
    } catch (cbErr) {
      log('error', AGENT, 'Failed to increment attempt count after Gemini error', {
        incidentId,
        error: String(cbErr),
      });
    }

    throw err;
  }

  // Step 3: Increment attempt counter in the CRD
  let newAttemptCount: number;
  try {
    newAttemptCount = await incrementAttemptCount(namespace, resourceName, incidentId);
  } catch (err) {
    log('error', AGENT, 'Failed to increment attempt count after successful diagnosis', {
      incidentId,
      namespace,
      resourceName,
      error: String(err),
    });
    // Non-fatal: continue sending the approval request even if the CRD patch fails
    newAttemptCount = attemptCount + 1;
  }

  // Step 4: Send ApprovalRequest to HIL agent
  const approvalRequest: ApprovalRequest = {
    // IncidentEnvelope passthrough
    incidentId: ctx.incidentId,
    triggeredBy: ctx.triggeredBy,
    triggeredAt: ctx.triggeredAt,
    namespace: ctx.namespace,
    resourceKind: ctx.resourceKind,
    resourceName: ctx.resourceName,
    mode: ctx.mode,
    // ApprovalRequest fields
    plan,
    attemptNumber: newAttemptCount,
    circuitBreakerLimit: CIRCUIT_BREAKER_LIMIT,
    escalated: false,
    requestedBy: ctx.requestedBy,
    platform: ctx.platform,
    channelId: ctx.channelId,
  };

  await postWithRetry({
    url: `${HIL_URL}/request-approval`,
    payload: approvalRequest,
    incidentId,
    callerAgent: AGENT,
  });

  log('info', AGENT, 'ApprovalRequest sent to HIL', {
    incidentId,
    namespace,
    resourceName,
    severity: plan.severity,
    attemptNumber: newAttemptCount,
    hilUrl: `${HIL_URL}/request-approval`,
  });
}
