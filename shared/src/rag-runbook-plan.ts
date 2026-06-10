/**
 * Parse verified RAG runbook markdown into a RemediationPlan (deterministic, no LLM).
 */

import type { RemediationAction, RemediationPlan } from './types.js';
import { actionOutcomeLabel } from './user-outcomes.js';
import { isVerifiedRunbookMarkdown } from './rag-triage.js';

const LABEL_TO_ACTION = new Map<string, RemediationAction>(
  (
    [
      'restart',
      'git_patch',
      'helm_deploy',
      'repo_apply',
      'cicd_rerun',
      'cicd_open_pr',
      'cicd_code_pr',
      'coding_agent_handoff',
      'escalate_human',
      'noop',
    ] as RemediationAction[]
  ).map((action) => [actionOutcomeLabel(action).toLowerCase(), action])
);

/** Actions we can compile and execute without an extra plan LLM call. */
const DIRECT_BYPASS_ACTIONS = new Set<RemediationAction>(['restart', 'noop']);

function extractLine(markdown: string, label: string): string {
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)$`, 'im');
  const m = markdown.match(re);
  return m?.[1]?.trim() ?? '';
}

function inferActionFromFixText(text: string): RemediationAction | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;

  for (const [label, action] of LABEL_TO_ACTION) {
    if (normalized.includes(label) || label.includes(normalized)) return action;
  }

  if (/restart/i.test(normalized)) return 'restart';
  if (/patch|git/i.test(normalized)) return 'git_patch';
  if (/helm/i.test(normalized)) return 'helm_deploy';
  if (/apply.*cluster|direct apply/i.test(normalized)) return 'repo_apply';
  if (/no action|noop|none/i.test(normalized)) return 'noop';
  return null;
}

export function parseVerifiedRunbookPlan(
  markdown: string,
  ctx: {
    namespace: string;
    resourceName: string;
    githubRepo?: string;
    gitManifestPath?: string;
    errorSignature?: string;
  }
): RemediationPlan | null {
  if (!isVerifiedRunbookMarkdown(markdown)) return null;

  const primaryFix =
    extractLine(markdown, 'Primary fix') ||
    (markdown.match(/1\.\s*\*\*Primary fix:\*\*\s*(.+)/i)?.[1]?.trim() ?? '');
  const action = inferActionFromFixText(primaryFix);
  if (!action) return null;

  const rootCause =
    extractLine(markdown, 'Root cause') ||
    extractLine(markdown, 'Error signature') ||
    ctx.errorSignature ||
    'Matched verified runbook';
  const reasoning =
    extractLine(markdown, 'Reasoning') ||
    `Verified runbook match — primary fix: ${primaryFix || actionOutcomeLabel(action)}`;

  return {
    action,
    rootCause,
    reasoning: reasoning.slice(0, 800),
    severity: 'MEDIUM',
    proposedPatch: [],
    targetManifestPath: ctx.gitManifestPath ?? `deployments/${ctx.resourceName}.yaml`,
    commitMessage: `fix(sre-bot): ${ctx.errorSignature ?? action} on ${ctx.resourceName}`,
    rollbackSafe: true,
    githubRepo: ctx.githubRepo,
    gitRef: 'main',
  };
}

export function isDirectRagBypassPlan(plan: RemediationPlan): boolean {
  return DIRECT_BYPASS_ACTIONS.has(plan.action);
}
