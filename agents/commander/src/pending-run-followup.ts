/**
 * Handle stuck approvals, cancel requests, and "I don't see anything" meta questions.
 */

import type { Platform } from '../../../shared/src/types.js';
import { getSession } from './sessions.js';
import { getActiveCase, updateCaseStatus } from './case-manager.js';

const ORCHESTRATOR_URL = process.env['ORCHESTRATOR_URL'] ?? 'http://orchestrator-agent:8080';
const HIL_URL = process.env['HIL_URL'] ?? 'http://hil-agent:8080';

export interface PendingRunFollowUpResult {
  reply: string;
  /** Telegram inline keyboard callback ids */
  quickActions?: Array<{ id: string; label: string }>;
}

function isCancelPendingRun(text: string): boolean {
  return (
    /^(cancel|clear|abort|stop)\b/i.test(text.trim()) ||
    /\b(cancel|clear|abort)\s+(the\s+)?(run|approval|pending|stuck)\b/i.test(text) ||
    /\bcancel\s+that\b/i.test(text)
  );
}

function isPendingStatusQuestion(text: string): boolean {
  return (
    /\b(can't see|cannot see|don't see|nothing there|not showing|where is.*approval|no approval|same again|still waiting)\b/i.test(
      text
    ) || /\bwhat('s| is) pending\b/i.test(text)
  );
}

async function fetchAwaitingRuns(limit = 30): Promise<
  Array<{ runId: string; incidentId: string; namespace?: string; resourceName?: string; status: string }>
> {
  const res = await fetch(`${ORCHESTRATOR_URL}/runs?limit=${limit}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    runs?: Array<{
      runId: string;
      incidentId: string;
      status: string;
      namespace?: string;
      resourceName?: string;
    }>;
  };
  return (data.runs ?? []).filter((r) => r.status === 'awaiting_human' || r.status === 'running');
}

async function fetchHilPending(): Promise<
  Array<{ incidentId: string; runId?: string; namespace?: string; resourceName?: string }>
> {
  const res = await fetch(`${HIL_URL}/api/approvals`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    approvals?: Array<{
      incidentId: string;
      runId?: string;
      status?: string;
      namespace?: string;
      resourceName?: string;
    }>;
  };
  return (data.approvals ?? []).filter((a) => a.status === 'PENDING');
}

async function cancelRun(runId: string): Promise<boolean> {
  const res = await fetch(`${ORCHESTRATOR_URL}/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'operator_cancelled' }),
    signal: AbortSignal.timeout(10_000),
  });
  return res.ok;
}

export async function tryPendingRunFollowUp(
  text: string,
  platform: Platform,
  channelId: string,
  userId: string
): Promise<PendingRunFollowUpResult | null> {
  const wantsCancel = isCancelPendingRun(text);
  const wantsStatus = isPendingStatusQuestion(text);
  if (!wantsCancel && !wantsStatus) return null;

  const session = await getSession(platform, channelId, userId);
  const hilPending = await fetchHilPending();
  const activeRuns = await fetchAwaitingRuns();

  if (wantsCancel) {
    const targetRunId = session?.lastRunId ?? activeRuns.find((r) => r.status === 'awaiting_human')?.runId;
    if (targetRunId) {
      await cancelRun(targetRunId);
    }
    for (const run of activeRuns.filter((r) => r.status === 'awaiting_human')) {
      if (run.runId !== targetRunId) {
        await cancelRun(run.runId);
      }
    }
    const agentCase = await getActiveCase(platform, channelId, userId);
    if (agentCase && ['awaiting_hil', 'investigating'].includes(agentCase.status)) {
      await updateCaseStatus(platform, channelId, userId, agentCase.caseId, 'open');
    }
    return {
      reply:
        '✅ Cleared pending approval locks. Send your request again (deploy, investigate, etc.).',
    };
  }

  if (hilPending.length > 0) {
    const first = hilPending[0]!;
    const label = `${first.namespace ?? '?'}/${first.resourceName ?? 'workload'}`;
    return {
      reply:
        `⏸️ Approval is open for **${label}** (\`${first.incidentId.slice(0, 8)}\`). Use the buttons below — no web console needed.`,
      quickActions: [
        { id: `hil_approve_${first.incidentId}`, label: '✅ Approve' },
        { id: `hil_reject_${first.incidentId}`, label: '❌ Reject' },
        { id: `hil_suggest_${first.incidentId}`, label: '✏️ Suggest fix' },
      ],
    };
  }

  const awaiting = activeRuns.filter((r) => r.status === 'awaiting_human');
  if (awaiting.length > 0) {
    for (const run of awaiting) {
      await cancelRun(run.runId);
    }
    return {
      reply:
        `I found ${awaiting.length} stale approval lock(s) in the run store (nothing in HIL after restart). ` +
        `Cleared them — please send your request again.`,
    };
  }

  return {
    reply:
      'No pending approvals right now. You can deploy, investigate, or ask about a workload.',
  };
}
