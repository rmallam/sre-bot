import type { RunListItem } from './types';

function formatAction(action: string): string {
  return action.replace(/_/g, ' ');
}

/** Client-side skill snippet (mirrors shared formatSkillMarkdown). */
export function formatSkillSnippet(run: RunListItem, resourceLabel?: string): string {
  const o = run.outcome;
  if (!o) return '';

  const title = resourceLabel ?? run.displayName ?? run.runId.slice(0, 8);
  const lines: string[] = [
    `### ${title} — ${new Date(run.updatedAt).toISOString().slice(0, 10)}`,
    '',
    `**Trigger:** ${run.mode?.replace(/-/g, ' ') ?? 'task'} (${run.incidentId.slice(0, 8)})`,
  ];

  if (o.rootCause) lines.push(`**Root cause:** ${o.rootCause}`);
  lines.push(`**Suggested fix:** ${formatAction(o.suggestedAction)}`);
  if (o.reasoning) lines.push(`**Reasoning:** ${o.reasoning}`);

  const workedLabel =
    o.finalStatus === 'succeeded' && o.suggestedAction === 'noop'
      ? 'No action taken'
      : o.worked === true
        ? 'Yes — verified / succeeded'
        : o.worked === false
          ? 'No'
          : 'Pending / unknown';
  lines.push(`**Outcome:** ${workedLabel}`);

  if (o.actionsTaken.length) {
    lines.push('', '**Actions taken:**');
    for (const a of o.actionsTaken) {
      const mark = a.success ? '✓' : '✗';
      lines.push(`- ${mark} ${formatAction(a.action)}: ${a.summary.slice(0, 240)}`);
    }
  }

  if (o.followUp) lines.push('', `**Follow-up:** ${o.followUp.slice(0, 500)}`);
  lines.push('', `<!-- runId: ${run.runId} -->`, '');
  return lines.join('\n');
}
