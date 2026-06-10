import type { ChatSessionSummary } from '../api';

interface Props {
  open: boolean;
  sessions: ChatSessionSummary[];
  activeChannelId: string | null;
  onSelect: (channelId: string) => void;
  onClose: () => void;
}

interface SessionGroup {
  label: string;
  items: ChatSessionSummary[];
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function groupSessions(sessions: ChatSessionSummary[]): SessionGroup[] {
  const today = startOfDay(new Date());
  const yesterday = today - 86_400_000;
  const weekAgo = today - 7 * 86_400_000;

  const buckets: Record<string, ChatSessionSummary[]> = {
    Today: [],
    Yesterday: [],
    'Previous 7 days': [],
    Older: [],
  };

  const sorted = [...sessions].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  for (const s of sorted) {
    const t = new Date(s.updatedAt).getTime();
    if (Number.isNaN(t)) {
      buckets.Older!.push(s);
      continue;
    }
    const day = startOfDay(new Date(s.updatedAt));
    if (day >= today) buckets.Today!.push(s);
    else if (day >= yesterday) buckets.Yesterday!.push(s);
    else if (day >= weekAgo) buckets['Previous 7 days']!.push(s);
    else buckets.Older!.push(s);
  }

  return (['Today', 'Yesterday', 'Previous 7 days', 'Older'] as const)
    .filter((label) => buckets[label]!.length > 0)
    .map((label) => ({ label, items: buckets[label]! }));
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function sessionTitle(s: ChatSessionSummary): string {
  if (s.preview?.trim()) return s.preview.trim().slice(0, 72);
  return s.sessionLabel ?? `Chat ${s.channelId.slice(0, 8)}`;
}

export function ChatHistoryPanel({ open, sessions, activeChannelId, onSelect, onClose }: Props) {
  if (!open) return null;

  const groups = groupSessions(sessions);

  return (
    <>
      <button type="button" className="chat-history-backdrop" onClick={onClose} aria-label="Close history" />
      <aside className="chat-history-panel" aria-label="Chat history">
        <div className="chat-history-header">
          <h3>History</h3>
          <button type="button" className="chat-toolbar-icon-btn" onClick={onClose} aria-label="Close history">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="chat-history-body">
          {groups.length === 0 && <p className="chat-history-empty">No conversations yet</p>}
          {groups.map((g) => (
            <section key={g.label} className="chat-history-group">
              <h4>{g.label}</h4>
              <ul>
                {g.items.map((s) => (
                  <li key={s.channelId}>
                    <button
                      type="button"
                      className={`chat-history-item${s.channelId === activeChannelId ? ' active' : ''}`}
                      onClick={() => {
                        onSelect(s.channelId);
                        onClose();
                      }}
                    >
                      <span className="chat-history-item-title">{sessionTitle(s)}</span>
                      <span className="chat-history-item-meta">{formatTime(s.updatedAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </aside>
    </>
  );
}
