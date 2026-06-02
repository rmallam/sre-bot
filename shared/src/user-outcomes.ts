/**
 * UX-7 — User-facing outcome language (hide internal modes/tool names).
 */

import type { IncidentMode, RemediationAction } from './types.js';

export function modeOutcomeLabel(mode: IncidentMode): string {
  switch (mode) {
    case 'ci-failure':
      return 'CI check';
    case 'pre-deploy':
      return 'deploy';
    case 'diagnose':
      return 'investigation';
    case 'rollback':
      return 'rollback';
    default:
      return 'task';
  }
}

export function actionOutcomeLabel(action: RemediationAction): string {
  switch (action) {
    case 'cicd_rerun':
      return 're-run the workflow';
    case 'cicd_open_pr':
      return 'open a workflow fix PR';
    case 'cicd_code_pr':
      return 'open a dependency/code fix PR';
    case 'coding_agent_handoff':
      return 'run an automated code fixer';
    case 'helm_deploy':
      return 'deploy with Helm';
    case 'repo_apply':
      return 'apply changes to the cluster';
    case 'restart':
      return 'restart the workload';
    case 'git_patch':
      return 'patch the deployment';
    case 'escalate_human':
      return 'escalate to a human';
    case 'noop':
      return 'take no action';
    default:
      return action.replace(/_/g, ' ');
  }
}

export function runStatusOutcomeLabel(status: string): string {
  switch (status) {
    case 'succeeded':
      return 'completed successfully';
    case 'failed':
      return 'did not complete';
    case 'awaiting_human':
      return 'waiting for your approval';
    case 'running':
      return 'still in progress';
    case 'cancelled':
      return 'was cancelled';
    default:
      return status.replace(/_/g, ' ');
  }
}

/** Strip internal jargon from free-form operator messages. */
export function sanitizeUserFacingText(text: string): string {
  return text
    .replace(/\bcicd_\w+/gi, 'CI step')
    .replace(/\bpre-deploy\b/gi, 'deploy')
    .replace(/\bci-failure\b/gi, 'CI check')
    .replace(/\bawaiting_human\b/gi, 'waiting for your approval')
    .replace(/\bdiagnose\b/gi, 'investigation')
    .replace(/\binvestigator\.\w+/gi, 'cluster check')
    .replace(/\bcicd\.\w+/gi, 'CI step');
}
