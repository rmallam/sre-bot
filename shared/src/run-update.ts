/**
 * Structured orchestrator → user notifications.
 * Commander turns these into natural chat messages (UX-1 narration layer).
 */

import type { CiRunFacts } from './ci-types.js';
import type { IncidentMode, RemediationAction } from './types.js';
import { actionOutcomeLabel, sanitizeUserFacingText } from './user-outcomes.js';

export type RunUpdateKind =
  | 'ci_diagnosis'
  | 'ci_approval_rerun'
  | 'ci_approval_workflow_pr'
  | 'ci_approval_code_pr'
  | 'ci_approval_coding_agent'
  | 'deploy_progress'
  | 'deploy_ready'
  | 'deploy_failed'
  | 'hil_required'
  | 'run_succeeded'
  | 'run_failed'
  | 'run_escalated'
  | 'progress'
  | 'coding_agent_handoff'
  | 'coding_agent_progress'
  | 'coding_agent_done'
  | 'agent_step'
  | 'generic';

export interface RunUpdateQuickAction {
  id: string;
  label: string;
}

export interface RunUpdatePayload {
  kind: RunUpdateKind;
  incidentId: string;
  runId?: string;
  mode?: IncidentMode;
  /** Raw technical text when kind is generic or as LLM context. */
  technicalMessage?: string;
  ciRun?: CiRunFacts;
  pendingAction?: RemediationAction;
  workflowFilePath?: string;
  codeFilePaths?: string[];
  repo?: string;
  namespace?: string;
  resourceName?: string;
  progressStep?: string;
  /** UX-4: headline only; logs via Show details button. */
  detailAvailable?: boolean;
  /** UX-9: channel prefers verbose messages. */
  verbose?: boolean;
  /** UX-10 coding agent fields. */
  codingAgentAttempt?: number;
  codingAgentMaxAttempts?: number;
  codingAgentPrUrl?: string;
  /** Inline keyboard actions (UX-2). `id` is Telegram callback_data. */
  quickActions?: RunUpdateQuickAction[];
}

/** Default Approve/Reject + Show logs when applicable. */
export function defaultQuickActionsForUpdate(
  payload: RunUpdatePayload
): RunUpdateQuickAction[] | undefined {
  const actions: RunUpdateQuickAction[] = [];

  if (payload.detailAvailable && payload.runId) {
    actions.push({ id: `show_details_${payload.runId}`, label: '📋 Show logs' });
  }

  switch (payload.kind) {
    case 'ci_approval_rerun':
    case 'ci_approval_workflow_pr':
    case 'ci_approval_code_pr':
    case 'ci_approval_coding_agent':
    case 'hil_required':
      actions.push(
        { id: `hil_approve_${payload.incidentId}`, label: '✅ Approve' },
        { id: `hil_reject_${payload.incidentId}`, label: '❌ Reject' },
        { id: `hil_suggest_${payload.incidentId}`, label: '✏️ Suggest fix' },
        { id: `hil_ignore_${payload.incidentId}`, label: '🔕 Ignore' }
      );
      break;
    default:
      break;
  }

  if (payload.quickActions?.length) {
    for (const a of payload.quickActions) {
      if (!actions.some((x) => x.id === a.id)) actions.push(a);
    }
  }

  return actions.length ? actions : payload.quickActions;
}

/** Deterministic chat-friendly message (no LLM). */
export function formatRunUpdateFallback(payload: RunUpdatePayload): string {
  const verbose = payload.verbose ?? false;

  switch (payload.kind) {
    case 'ci_diagnosis':
      return formatCiDiagnosisChat(payload.ciRun, {
        includeLogs: verbose || !payload.detailAvailable,
      });
    case 'ci_approval_rerun':
      return (
        `The CI run on ${payload.repo ?? 'your repo'} can be retried.\n` +
        `Approve when prompted to re-run the workflow.`
      );
    case 'ci_approval_workflow_pr':
      return (
        `I can open a pull request to update the workflow file` +
        (payload.workflowFilePath ? ` (\`${payload.workflowFilePath}\`)` : '') +
        `.\nApprove when prompted to create the PR.`
      );
    case 'ci_approval_code_pr':
      return (
        `I can open a PR to fix dependencies or config` +
        (payload.codeFilePaths?.length
          ? ` (${payload.codeFilePaths.map((p) => `\`${p}\``).join(', ')})`
          : '') +
        `.\nApprove when prompted.`
      );
    case 'ci_approval_coding_agent':
      return (
        `I can run an automated code fixer on ${payload.repo ?? 'your repo'}` +
        (payload.codingAgentMaxAttempts
          ? ` (up to ${payload.codingAgentMaxAttempts} attempts)`
          : '') +
        `.\nApprove when prompted to start.`
      );
    case 'deploy_progress':
      return payload.progressStep ?? payload.technicalMessage ?? 'Deploy in progress…';
    case 'deploy_ready':
      return (
        `Deploy looks healthy for ${payload.resourceName ?? 'the app'}` +
        (payload.namespace ? ` in namespace ${payload.namespace}` : '') +
        '.'
      );
    case 'deploy_failed':
      return (
        `Deploy did not complete for ${payload.resourceName ?? 'the app'}` +
        (payload.namespace ? ` in ${payload.namespace}` : '') +
        '.\n' +
        sanitizeUserFacingText(payload.technicalMessage?.slice(0, 400) ?? '')
      );
    case 'hil_required':
      return (
        `I need your approval before I ${actionOutcomeLabel(payload.pendingAction ?? 'noop')}.` +
        '\nUse the buttons above or the approval card.'
      );
    case 'run_succeeded':
      return sanitizeUserFacingText(
        payload.technicalMessage ?? 'Done — everything completed successfully.'
      );
    case 'run_failed':
      return sanitizeUserFacingText(
        payload.technicalMessage ?? 'Something went wrong. Tap Show logs for details.'
      );
    case 'run_escalated':
      return sanitizeUserFacingText(
        payload.technicalMessage ?? 'I escalated this — a human should review.'
      );
    case 'progress':
      return payload.progressStep ?? 'Working on it…';
    case 'coding_agent_handoff':
      return (
        `This needs changes across several files — I'm starting an automated fixer` +
        (payload.codingAgentMaxAttempts
          ? ` (up to ${payload.codingAgentMaxAttempts} attempts)`
          : '') +
        `. I'll send a PR link when ready.`
      );
    case 'coding_agent_progress':
      return (
        `Fixer attempt ${payload.codingAgentAttempt ?? '?'}` +
        (payload.codingAgentMaxAttempts ? `/${payload.codingAgentMaxAttempts}` : '') +
        (payload.progressStep ? ` — ${payload.progressStep}` : ' — still working…')
      );
    case 'coding_agent_done':
      return payload.codingAgentPrUrl
        ? `PR ready: ${payload.codingAgentPrUrl}`
        : sanitizeUserFacingText(payload.technicalMessage ?? 'Code fixer finished.');
    case 'agent_step':
      return payload.progressStep ?? sanitizeUserFacingText(payload.technicalMessage ?? 'Investigating…');
    case 'generic':
    default:
      return sanitizeUserFacingText(payload.technicalMessage ?? 'Update from SRE bot.');
  }
}

function formatCiDiagnosisChat(
  facts?: CiRunFacts,
  opts?: { includeLogs?: boolean }
): string {
  if (!facts) return 'CI failed — no details available.';
  const includeLogs = opts?.includeLogs ?? false;
  const d = facts.diagnosis;
  const lines: string[] = [];

  lines.push(
    `CI failed on ${facts.githubRepo} — "${facts.workflowName}" (run #${facts.workflowRunId}).`
  );
  if (facts.htmlUrl) {
    lines.push(`Run: ${facts.htmlUrl}`);
  }

  if (d) {
    lines.push('');
    if (d.summary) lines.push(d.summary);
    if (d.userGuidance) lines.push('', d.userGuidance);

    if (d.suggestedAction === 'rerun') {
      lines.push('', 'I can re-run the workflow after you approve.');
    } else if (d.suggestedAction === 'open_pr') {
      lines.push('', 'I can open a workflow fix PR after you approve.');
    } else if (d.suggestedAction === 'propose_code_pr') {
      lines.push('', 'I can propose a dependency/code fix PR after you approve.');
    } else if (d.fixCategory === 'application_code') {
      lines.push(
        '',
        'I can run an automated multi-file code fixer after you approve (coding agent).'
      );
    }

    if (includeLogs) {
      const err = d.errorHighlight?.slice(-5).join('\n') ?? '';
      if (err) {
        lines.push('', 'What broke (from logs):', err.slice(0, 800));
      }
    } else {
      lines.push('', 'Tap **Show logs** for log excerpts.');
    }
  }

  return lines.join('\n');
}
