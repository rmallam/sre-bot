import type { ChatSessionSummary } from '../api';

interface Props {
  tabs: string[];
  activeChannelId: string | null;
  sessions: ChatSessionSummary[];
  onSelect: (channelId: string) => void;
  onClose: (channelId: string) => void;
}

function tabLabel(channelId: string, sessions: ChatSessionSummary[]): string {
  const s = sessions.find((x) => x.channelId === channelId);
  if (s?.preview?.trim()) return s.preview.trim().slice(0, 48);
  if (s?.sessionLabel) return s.sessionLabel;
  return `Chat ${channelId.slice(0, 6)}`;
}

export function ChatSessionTabs({ tabs, activeChannelId, sessions, onSelect, onClose }: Props) {
  if (tabs.length === 0) return null;

  return (
    <div className="chat-tabs" role="tablist" aria-label="Open conversations">
      <div className="chat-tabs-scroll">
        {tabs.map((id) => {
          const active = id === activeChannelId;
          const label = tabLabel(id, sessions);
          return (
            <div
              key={id}
              role="tab"
              aria-selected={active}
              className={`chat-tab${active ? ' active' : ''}`}
            >
              <button type="button" className="chat-tab-select" onClick={() => onSelect(id)} title={label}>
                <span className="chat-tab-label">{label}</span>
              </button>
              {tabs.length > 1 && (
                <button
                  type="button"
                  className="chat-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(id);
                  }}
                  aria-label={`Close ${label}`}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
