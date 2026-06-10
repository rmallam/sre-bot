interface Props {
  worked: boolean | null | undefined;
  suggestedAction?: string;
  finalStatus?: string;
}

export function OutcomeBadge({ worked, suggestedAction, finalStatus }: Props) {
  if (finalStatus === 'succeeded' && suggestedAction === 'noop') {
    return <span className="outcome-badge noop">No action taken</span>;
  }
  if (worked === true) {
    return <span className="outcome-badge worked">Worked</span>;
  }
  if (worked === false) {
    return <span className="outcome-badge failed">Did not work</span>;
  }
  return <span className="outcome-badge pending">Pending</span>;
}

export function formatAction(action: string | undefined): string {
  if (!action) return '—';
  if (action === 'noop') return 'No action';
  return action.replace(/_/g, ' ');
}

export function formatSuggestedFix(
  run: { suggestedActionLabel?: string; toolCount?: number; status?: string; outcome?: { suggestedAction?: string } }
): string {
  if (run.suggestedActionLabel) return run.suggestedActionLabel;
  const action = run.outcome?.suggestedAction;
  if (action === 'noop' && run.status === 'succeeded') return 'No action';
  if (action && action !== 'unknown') return formatAction(action);
  if (run.status === 'running' && (run.toolCount ?? 0) === 0) return 'No plan yet';
  if (action === 'unknown') return 'Not determined';
  return '—';
}
