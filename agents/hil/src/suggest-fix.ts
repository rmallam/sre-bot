/**
 * Apply operator fix suggestions to pending HIL approvals.
 */

import { approvalStore } from './store.js';
import { onApproved } from './dispatcher.js';
import { log } from '../../../shared/src/http.js';
import type { ApprovalRequest, Platform, RemediationPlan } from '../../../shared/src/types.js';
interface SuggestPlanResponse {
  plan: RemediationPlan;
  source: 'rules' | 'llm';
  summary: string;
}

const AGENT = 'hil-agent';
const BRAIN_URL = process.env['BRAIN_URL'] ?? 'http://brain-agent:8080';
const INVESTIGATOR_URL = process.env['INVESTIGATOR_URL'] ?? 'http://investigator-agent:8080';

export interface SuggestFixResult {
  ok: boolean;
  error?: string;
  summary?: string;
  plan?: RemediationPlan;
  source?: 'rules' | 'llm';
  applied?: boolean;
}

async function fetchOptionalFacts(approval: ApprovalRequest): Promise<Record<string, unknown> | undefined> {
  try {
    const params = new URLSearchParams({
      namespace: approval.namespace,
      resourceName: approval.resourceName,
      resourceKind: approval.resourceKind,
      podName: approval.resourceName,
      incidentId: approval.incidentId,
      mode: approval.mode,
    });
    const res = await fetch(`${INVESTIGATOR_URL}/facts?${params}`, {
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function parseSuggestion(
  approval: ApprovalRequest,
  suggestion: string
): Promise<SuggestPlanResponse> {
  const facts = await fetchOptionalFacts(approval);
  const res = await fetch(`${BRAIN_URL}/suggest-plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      suggestion,
      approval: {
        incidentId: approval.incidentId,
        namespace: approval.namespace,
        resourceKind: approval.resourceKind,
        resourceName: approval.resourceName,
        mode: approval.mode,
        plan: approval.plan,
      },
      facts,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST /suggest-plan failed ${res.status}: ${body}`);
  }
  return (await res.json()) as SuggestPlanResponse;
}

export async function applyOperatorSuggestion(opts: {
  incidentId: string;
  suggestion: string;
  userId: string;
  platform: Platform;
  applyNow?: boolean;
}): Promise<SuggestFixResult> {
  const entry = approvalStore.get(opts.incidentId);
  if (!entry) {
    return { ok: false, error: 'not_found' };
  }
  if (entry.status !== 'PENDING') {
    return { ok: false, error: 'already_handled' };
  }
  if (!opts.suggestion.trim()) {
    return { ok: false, error: 'empty_suggestion' };
  }

  let parsed: SuggestPlanResponse;
  try {
    parsed = await parseSuggestion(entry.request, opts.suggestion.trim());
  } catch (err) {
    log('error', AGENT, 'suggest-plan failed', {
      incidentId: opts.incidentId,
      error: String(err),
    });
    return { ok: false, error: `parse_failed: ${String(err)}` };
  }

  const updated = approvalStore.updatePlan(opts.incidentId, parsed.plan, {
    humanSuggestion: opts.suggestion.trim(),
    planSource: 'human',
  });
  if (!updated) {
    return { ok: false, error: 'update_failed' };
  }

  log('info', AGENT, 'Operator suggestion merged into approval plan', {
    incidentId: opts.incidentId,
    source: parsed.source,
    action: parsed.plan.action,
    userId: opts.userId,
  });

  if (!opts.applyNow) {
    return {
      ok: true,
      summary: parsed.summary,
      plan: parsed.plan,
      source: parsed.source,
      applied: false,
    };
  }

  const approveResult = approvalStore.tryApprove(opts.incidentId, opts.userId, opts.platform);
  if (approveResult !== 'ok') {
    return { ok: false, error: approveResult, summary: parsed.summary, plan: parsed.plan };
  }

  const approvedEntry = approvalStore.get(opts.incidentId)!;
  try {
    approvalStore.updateStatus(opts.incidentId, 'EXECUTING');
    await onApproved(approvedEntry, opts.userId, opts.platform);
    return {
      ok: true,
      summary: parsed.summary,
      plan: parsed.plan,
      source: parsed.source,
      applied: true,
    };
  } catch (err) {
    approvalStore.updateStatus(opts.incidentId, 'FAILED');
    return { ok: false, error: String(err), summary: parsed.summary };
  }
}
