/**
 * Compile verified remediation outcomes into RAG runbook markdown.
 */

import type { RemediationOutcome } from './remediation-outcome.js';
import type { RemediationPlan } from './types.js';
import { actionOutcomeLabel } from './user-outcomes.js';

export interface RagLearnPayload {
  errorSignature: string;
  targetComponent: string;
  playbookMarkdown: string;
  runId: string;
  incidentId: string;
  resourceLabel?: string;
}

const VALID_COMPONENTS = new Set([
  'compute',
  'storage',
  'network',
  'gitops',
  'database',
  'security',
]);

export function normalizeTargetComponent(value: string | undefined): string {
  const v = (value ?? 'compute').trim().toLowerCase();
  return VALID_COMPONENTS.has(v) ? v : 'compute';
}

export function formatVerifiedRunbookMarkdown(params: {
  outcome: RemediationOutcome;
  plan?: RemediationPlan;
  errorSignature: string;
  targetComponent: string;
  runId: string;
  incidentId: string;
  resourceLabel?: string;
  namespace?: string;
  resourceName?: string;
}): string {
  const { outcome, plan, errorSignature, targetComponent, runId, incidentId, resourceLabel } =
    params;
  const title = resourceLabel ?? params.resourceName ?? 'workload';
  const ns = params.namespace ? ` (${params.namespace})` : '';
  const action = actionOutcomeLabel(
    (outcome.suggestedAction || plan?.action || 'noop') as RemediationPlan['action']
  );

  const lines: string[] = [
    `# ${errorSignature} — verified fix`,
    '',
    `_Proven on ${outcome.recordedAt.slice(0, 10)} · run ${runId.slice(0, 8)} · component ${targetComponent}_`,
    '',
    `## Context`,
    `- **Workload:** ${title}${ns}`,
    `- **Incident:** ${incidentId.slice(0, 8)}`,
    `- **Error signature:** ${errorSignature}`,
  ];

  if (outcome.rootCause || plan?.rootCause) {
    lines.push(`- **Root cause:** ${outcome.rootCause ?? plan?.rootCause}`);
  }
  if (outcome.severity || plan?.severity) {
    lines.push(`- **Severity:** ${outcome.severity ?? plan?.severity}`);
  }

  lines.push('', '## Remediation (verified)', `1. **Primary fix:** ${action}`);
  if (outcome.reasoning || plan?.reasoning) {
    lines.push(`2. **Reasoning:** ${(outcome.reasoning ?? plan?.reasoning ?? '').slice(0, 500)}`);
  }

  if (outcome.actionsTaken.length) {
    lines.push('', '## Actions executed');
    for (const a of outcome.actionsTaken) {
      const mark = a.success ? '✓' : '✗';
      lines.push(
        `- ${mark} ${actionOutcomeLabel(a.action as RemediationPlan['action'])}: ${a.summary.slice(0, 300)}`
      );
    }
  }

  lines.push(
    '',
    '## Verify',
    '- Workload reaches Ready / Running',
    '- Restart count stable',
    '- No recurring events for the error signature within 5m',
    ''
  );

  if (outcome.followUp) {
    lines.push('## Notes', outcome.followUp.slice(0, 500), '');
  }

  lines.push(`<!-- ragLearn runId=${runId} incidentId=${incidentId} -->`);
  return lines.join('\n');
}

export function buildRagLearnPayload(params: {
  outcome: RemediationOutcome;
  plan?: RemediationPlan;
  errorSignature: string;
  targetComponent: string;
  runId: string;
  incidentId: string;
  resourceLabel?: string;
  namespace?: string;
  resourceName?: string;
}): RagLearnPayload | null {
  const errorSignature = (params.errorSignature || '').trim();
  if (!errorSignature) return null;

  return {
    errorSignature,
    targetComponent: normalizeTargetComponent(params.targetComponent),
    playbookMarkdown: formatVerifiedRunbookMarkdown(params),
    runId: params.runId,
    incidentId: params.incidentId,
    resourceLabel: params.resourceLabel,
  };
}
