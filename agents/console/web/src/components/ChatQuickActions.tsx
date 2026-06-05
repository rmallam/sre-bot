import { useState } from 'react';
import { approveIncident, rejectIncident } from '../api';

export interface ChatQuickAction {
  id: string;
  label: string;
}

interface Props {
  actions: ChatQuickAction[];
  incidentId?: string;
  onAction?: () => void;
}

export function ChatQuickActions({ actions, incidentId, onAction }: Props) {
  const [busy, setBusy] = useState<string | null>(null);

  if (!actions.length) return null;

  async function handle(action: ChatQuickAction) {
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
