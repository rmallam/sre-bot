/**
 * Human-readable labels for tool pipeline / run timeline (UX).
 */

import type { RemediationAction } from './types.js';
import { sanitizeUserFacingText } from './user-outcomes.js';

const TOOL_LABELS: Record<string, string> = {
  'investigator.repo_inspect': 'Reviewed repository for deploy instructions',
  'gitops.apply_plan': 'Applied changes to the cluster',
  'investigator.verify_health': 'Checked that workloads are healthy',
  'executor.restart_workload': 'Restarted the workload',
  'argo.wait_sync': 'Waited for Argo CD to sync',
  'argo.rollout_promote': 'Promoted the rollout',
  'commander.notify': 'Sent you an update',
  'cicd.fetch_run': 'Fetched CI run details',
  'cicd.rerun_workflow': 'Re-ran the CI workflow',
  'cicd.open_pr': 'Opened a pull request',
  'coding_agent.handoff': 'Handed off to the code fixer',
  'investigator.logs_query': 'Fetched pod logs',
  'investigator.metrics_query': 'Fetched metrics',
};

const PLAN_ACTION_LABELS: Record<RemediationAction, string> = {
  repo_apply: 'Deployed to the cluster',
  git_patch: 'Applied a configuration fix',
  helm_deploy: 'Installed via Helm / GitOps',
  restart: 'Restarted the workload',
  cicd_rerun: 'Re-ran CI',
  cicd_open_pr: 'Opened a CI fix PR',
  cicd_code_pr: 'Opened a code fix PR',
  coding_agent_handoff: 'Started automated code fix',
  escalate_human: 'Escalated for human review',
  noop: 'Completed review',
};

const PLAN_ACTION_DETAIL: Record<RemediationAction, string> = {
  repo_apply: 'Charts and manifests were applied to your cluster.',
  git_patch: 'Configuration was updated on the cluster.',
  helm_deploy: 'Helm release was registered or upgraded.',
  restart: 'Pods were rolled to pick up the change.',
  cicd_rerun: 'The workflow was triggered again.',
  cicd_open_pr: 'A pull request was opened with the CI fix.',
  cicd_code_pr: 'A pull request was opened with code changes.',
  coding_agent_handoff: 'The coding agent is working on a fix.',
  escalate_human: 'A human operator needs to take over.',
  noop: 'No cluster changes were required.',
};

const SUMMARY_OVERRIDES: Record<string, string> = {
  repo_apply: 'Deployed manifests and charts to the cluster',
  git_patch: 'Applied configuration update',
  helm_deploy: 'Helm release installed or upgraded',
  restart: 'Workload restart completed',
  healthy: 'All checked components are ready',
  degraded: 'Some components are not ready yet',
  verify: 'Health check completed',
  repo_inspect: 'Located deploy entry point in the repository',
};

/** Short headline for a timeline step. */
export function formatToolDisplayLabel(tool: string, planAction?: string): string {
  if (tool === 'gitops.apply_plan' && planAction && planAction in PLAN_ACTION_LABELS) {
    return PLAN_ACTION_LABELS[planAction as RemediationAction];
  }
  return TOOL_LABELS[tool] ?? tool.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Subtitle under the timeline step. */
export function formatToolSummaryDetail(
  tool: string,
  summary?: string,
  planAction?: string
): string | undefined {
  if (!summary?.trim()) {
    if (tool === 'gitops.apply_plan' && planAction && planAction in PLAN_ACTION_DETAIL) {
      return PLAN_ACTION_DETAIL[planAction as RemediationAction];
    }
    return undefined;
  }

  const raw = summary.trim();
  if (SUMMARY_OVERRIDES[raw]) return SUMMARY_OVERRIDES[raw];
  if (tool === 'gitops.apply_plan' && raw === planAction && planAction in PLAN_ACTION_DETAIL) {
    return PLAN_ACTION_DETAIL[planAction as RemediationAction];
  }
  if (raw.startsWith('Found ') || raw.startsWith('No manifests')) return raw;
  if (raw.startsWith('argo-sync:')) {
    const status = raw.slice('argo-sync:'.length);
    return status === 'Synced' ? 'Application synced successfully' : `Sync status: ${status}`;
  }
  if (/^Release ".+" ready —/.test(raw)) return raw;

  return sanitizeUserFacingText(raw).slice(0, 300);
}

/** Humanize a compiled tool pipeline string (tool registry names). */
export function formatToolPipelineLabel(tools: string[], planAction?: string): string {
  return tools.map((t) => formatToolDisplayLabel(t, planAction)).join(' → ');
}
