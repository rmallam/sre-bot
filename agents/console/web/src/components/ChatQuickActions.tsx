import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { approveIncident, rejectIncident, cancelRun, fetchRunSummary } from '../api';

export interface ChatQuickAction {
  id: string;
  label: string;
}

interface Props {
  actions: ChatQuickAction[];
  incidentId?: string;
  onAction?: () => void;
  onShowLogs?: (text: string, runId: string) => void;
}

export function ChatQuickActions({ actions, incidentId, onAction, onShowLogs }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const navigate = useNavigate();

  if (!actions.length) return null;

  async function handle(action: ChatQuickAction) {
    const viewRunMatch = action.id.match(/^view_run_(.+)$/);
    if (viewRunMatch?.[1]) {
      navigate(`/runs/${encodeURIComponent(viewRunMatch[1])}`);
      return;
    }

    const cancelMatch = action.id.match(/^cancel_run_(.+)$/);
    if (cancelMatch?.[1]) {
      if (!window.confirm('Cancel this run and allow a fresh investigation?')) return;
      setBusy(action.id);
      try {
        await cancelRun(cancelMatch[1]);
        onAction?.();
      } finally {
        setBusy(null);
      }
      return;
    }

    const showDetailsMatch = action.id.match(/^show_details_(.+)$/);
    if (showDetailsMatch?.[1]) {
      const runId = showDetailsMatch[1];
      setBusy(action.id);
      try {
        const data = await fetchRunSummary(runId, true);
        onShowLogs?.(data.text || 'No logs available for this run.', runId);
      } catch (err) {
        onShowLogs?.(`Could not load logs: ${String(err)}`, runId);
      } finally {
        setBusy(null);
      }
      return;
    }

    const approveMatch = action.id.match(/^hil_approve_(.+)$/);
    const rejectMatch = action.id.match(/^hil_reject_(.+)$/);
    const id = approveMatch?.[1] ?? rejectMatch?.[1] ?? incidentId;
    if (!id) return;

    setBusy(action.id);
    try {
      if (approveMatch) {
        await approveIncident(id);
      } else if (rejectMatch) {
        await rejectIncident(id);
      }
      onAction?.();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="chat-quick-actions">
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className={
            action.id.startsWith('hil_reject')
              ? 'btn btn-ghost btn-sm chat-action-reject'
              : action.id.startsWith('cancel_run_')
                ? 'btn btn-ghost btn-sm chat-action-reject'
                : action.id.startsWith('view_run_')
                  ? 'btn btn-ghost btn-sm'
                  : 'btn btn-primary btn-sm'
          }
          disabled={busy !== null}
          onClick={() => void handle(action)}
        >
          {busy === action.id ? '…' : action.label}
        </button>
      ))}
    </div>
  );
}
