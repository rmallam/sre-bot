/**
 * Deliver orchestrator /notify payloads into web console chat (Redis transcript).
 */

import type { RunUpdateKind, RunUpdatePayload, RunUpdateQuickAction } from '../../../shared/src/run-update.js';
import { getSession, setSession } from './sessions.js';
import { trimTranscript } from './chat-transcript.js';
import type { ChatTurn } from './sessions.js';

const WEB_USER_ID = 'console';

const TERMINAL_KINDS = new Set<RunUpdateKind>([
  'run_succeeded',
  'run_failed',
  'run_escalated',
  'deploy_ready',
  'deploy_failed',
  'ci_diagnosis',
  'coding_agent_done',
  'ci_pr_verify_succeeded',
  'ci_pr_verify_failed',
]);

const STILL_WAITING_KINDS = new Set<RunUpdateKind>([
  'hil_required',
  'deploy_source_required',
  'ci_approval_rerun',
  'ci_approval_workflow_pr',
  'ci_approval_code_pr',
  'ci_approval_coding_agent',
  'coding_agent_handoff',
]);

function stripStatusForIncident(turns: ChatTurn[], incidentId: string): ChatTurn[] {
  return turns.filter((t) => !(t.role === 'status' && t.incidentId === incidentId));
}

function resolveQuickActions(
  quickActions: RunUpdateQuickAction[] | undefined,
  update: RunUpdatePayload | undefined,
  stillWaiting: boolean
): Array<{ id: string; label: string }> | undefined {
  if (quickActions?.length) {
    return quickActions.map((a) => ({ id: a.id, label: a.label }));
  }
  if (stillWaiting && update?.incidentId) {
    return [
      { id: `hil_approve_${update.incidentId}`, label: '✅ Approve' },
      { id: `hil_reject_${update.incidentId}`, label: '❌ Reject' },
    ];
  }
  return undefined;
}

/** Push narrated text into the web chat transcript (and session flags). */
export async function deliverWebChatUpdate(opts: {
  channelId: string;
  text: string;
  incidentId: string;
  update?: RunUpdatePayload;
  quickActions?: RunUpdateQuickAction[];
}): Promise<void> {
  const { channelId, text, incidentId, update, quickActions } = opts;
  const userId = WEB_USER_ID;
  const session = await getSession('web', channelId, userId);
  const prev = session?.transcript ?? [];
  const runId = update?.runId ?? session?.lastRunId;
  const kind = update?.kind;
  const body = text.trim();
  const stillWaiting = !!(kind && STILL_WAITING_KINDS.has(kind));
  const terminal = !!(kind && TERMINAL_KINDS.has(kind));
  const actions = resolveQuickActions(quickActions, update, stillWaiting);

  if (kind === 'progress' || kind === 'deploy_progress' || kind === 'coding_agent_progress' || kind === 'agent_step') {
    const step = update?.progressStep ?? body;
    const withoutOld = stripStatusForIncident(prev, incidentId);
    await setSession('web', channelId, userId, {
      transcript: [
        ...withoutOld,
        {
          role: 'status',
          content: step,
          at: new Date().toISOString(),
          incidentId,
          runId,
        },
      ],
      waitingForRun: true,
      lastIncidentId: incidentId,
      lastRunId: runId,
    });
    return;
  }

  const withoutStatus = stripStatusForIncident(prev, incidentId);
  await setSession('web', channelId, userId, {
    transcript: trimTranscript([
      ...withoutStatus,
      {
        role: 'assistant',
        content: body,
        at: new Date().toISOString(),
        incidentId,
        runId,
        quickActions: actions,
        updateKind: kind,
      },
    ]),
    waitingForRun: stillWaiting
      ? true
      : terminal || kind === 'generic'
        ? false
        : session?.waitingForRun,
    lastIncidentId: incidentId,
    lastRunId: runId,
    lastMode: update?.mode ?? session?.lastMode,
    pendingQuestion: kind === 'deploy_source_required' ? body : session?.pendingQuestion,
  });

  if (kind === 'deploy_source_required' && runId) {
    const { armDeploySourceClarification } = await import('./deploy-source-followup.js');
    await armDeploySourceClarification('web', channelId, userId, {
      kind: 'deploy-source',
      awaiting: 'deploySource',
      prompt: body,
      runId,
      namespace: update?.namespace,
      resourceName: update?.resourceName,
    });
  }
}

export async function appendWebStatusStep(
  channelId: string,
  content: string,
  incidentId?: string
): Promise<void> {
  const userId = WEB_USER_ID;
  const session = await getSession('web', channelId, userId);
  const prev = session?.transcript ?? [];
  const iid = incidentId ?? session?.lastIncidentId ?? 'pending';
  const withoutOld = stripStatusForIncident(prev, iid);
  await setSession('web', channelId, userId, {
    transcript: [
      ...withoutOld,
      {
        role: 'status',
        content,
        at: new Date().toISOString(),
        incidentId: iid,
      },
    ],
  });
}

export async function markWebRunWaiting(
  channelId: string,
  incidentId: string,
  mode?: import('../../../shared/src/types.js').IncidentMode
): Promise<void> {
  await setSession('web', channelId, WEB_USER_ID, {
    lastIncidentId: incidentId,
    waitingForRun: true,
    lastMode: mode,
  });
}

export async function clearWebStatus(channelId: string, incidentId: string): Promise<void> {
  const session = await getSession('web', channelId, WEB_USER_ID);
  if (!session?.transcript) return;
  const transcript =
    incidentId === 'pending'
      ? session.transcript.filter((t) => t.role !== 'status')
      : stripStatusForIncident(session.transcript, incidentId);
  await setSession('web', channelId, WEB_USER_ID, { transcript });
}
