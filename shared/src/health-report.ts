/**
 * Format investigator facts as a read-only health report for chat (cluster / namespace scope).
 */

import type { DiagnosisContext } from './types.js';
import { formatRcaPointersForPlan } from './rca-pointers.js';

const MAX_EVENTS = 6;
const MAX_DEPLOYMENTS = 12;

export function formatHealthInvestigationReport(
  facts: Pick<
    DiagnosisContext,
    | 'currentLogs'
    | 'recentEvents'
    | 'existingDeployments'
    | 'namespace'
    | 'rcaPointers'
    | 'observabilitySummary'
    | 'clusterReachable'
  >,
  label: string
): string {
  if (facts.clusterReachable === false) {
    const reason =
      facts.currentLogs?.trim() ??
      'The Kubernetes API is unreachable or returned no nodes.';
    return [
      `⚠️ ${label}`,
      '',
      reason,
      '',
      'Start or reconnect the cluster, then ask again.',
    ].join('\n');
  }

  const lines: string[] = [`📊 ${label}`, ''];

  const summary = facts.currentLogs?.trim();
  if (summary) {
    lines.push(summary);
    lines.push('');
  }

  const warnings = (facts.recentEvents ?? []).filter((e) => e.type === 'Warning').slice(0, MAX_EVENTS);
  if (warnings.length > 0) {
    lines.push('Recent warnings:');
    for (const e of warnings) {
      lines.push(`• ${e.reason}: ${e.message.slice(0, 160)}`);
    }
    lines.push('');
  }

  const deploys = facts.existingDeployments ?? [];
  if (deploys.length > 0 && deploys.length <= MAX_DEPLOYMENTS) {
    lines.push(`Deployments seen (${deploys.length}): ${deploys.slice(0, MAX_DEPLOYMENTS).join(', ')}`);
    lines.push('');
  }

  const rcaSummary = facts.observabilitySummary?.trim() || formatRcaPointersForPlan(facts.rcaPointers ?? []);
  if (rcaSummary && !summary?.includes(rcaSummary.slice(0, 40))) {
    lines.push('Evidence:');
    lines.push(rcaSummary.slice(0, 1200));
    lines.push('');
  }

  if (lines.length <= 2) {
    lines.push('No issues detected in the quick scan, or the cluster API returned limited data.');
  }

  lines.push('Reply with a deployment name to dig deeper, e.g. investigate payment-api in default.');

  return lines.join('\n').slice(0, 3900);
}
