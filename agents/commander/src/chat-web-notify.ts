/**
 * Deliver orchestrator /notify payloads into web console chat (Redis transcript).
 */

import type { RunUpdateKind, RunUpdatePayload, RunUpdateQuickAction } from '../../../shared/src/run-update.js';
import { getSession, setSession } from './sessions.js';
import { appendChatTurn } from './chat-transcript.js';
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
]);

const STILL_WAITING_KINDS = new Set<RunUpdateKind>([
  'hil_required',
  'ci_approval_rerun',
  'ci_approval_workflow_pr',
  'ci_approval_code_pr',
  'ci_approval_coding_agent',
  'coding_agent_handoff',
]);

function stripStatusForIncident(turns: ChatTurn[], incidentId: string): ChatTurn[] {
  return turns.filter((t) => !(t.role === 'status' && t.incidentId === incidentId));
}

function formatQuickActionsHint(actions?: RunUpdateQuickAction[]): string {
  if (!actions?.length) return '';
  const labels = actions.map((a) => a.label).join(' · ');
  return `\n\n${labels}`;
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
  const body = text.trim() + formatQuickActionsHint(quickActions);
  const stillWaiting = kind && STILL_WAITING_KINDS.has(kind);
  const terminal = kind && TERMINAL_KINDS.has(kind);

  if (kind === 'progress' || kind === 'deploy_progress' || kind === 'coding_agent_progress') {
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
      },
    ]),
    waitingForRun: stillWaiting ? true : terminal ? false : session?.waitingForRun,
    lastIncidentId: incidentId,
    lastRunId: runId,
    lastMode: update?.mode ?? session?.lastMode,
  });
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
  await setSession('web', channelId, WEB_USER_ID, {
    transcript: stripStatusForIncident(session.transcript, incidentId),
  });
}
