import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchActivity, type ActivityEvent } from '../api';
import { StatusBadge } from '../components/StatusBadge';

interface Props {
  live: boolean;
}

function eventIcon(kind: ActivityEvent['kind']): string {
  switch (kind) {
    case 'run':
      return '▶';
    case 'approval':
      return '✋';
    case 'approval_decision':
      return '✓';
    default:
      return '•';
  }
}

function formatWhen(at: string): string {
  const d = new Date(at);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return d.toLocaleString();
}

export function ActivityPage({ live }: Props) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    fetchActivity(80)
      .then((d) => setEvents(d.events))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, live ? 5000 : 30000);
    return () => clearInterval(id);
  }, [live, load]);

  return (
    <>
      <p style={{ fontSize: '0.8125rem', color: 'var(--text-dim)', margin: '0 0 1rem' }}>
        Unified timeline of runs and human-in-the-loop events — same data whether triggered from
        chat, Telegram, or the console.
      </p>

      <div className="filter-bar">
        <button type="button" className="btn btn-sm" onClick={load}>
          Refresh
        </button>
      </div>

      {loading && events.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>Loading activity…</p>
      )}

      {!loading && events.length === 0 && (
        <div className="empty-state">
          <h3>No activity yet</h3>
          <p>Start an investigation or deploy from the Assistant.</p>
        </div>
      )}

      <ul className="activity-feed">
        {events.map((ev) => (
          <li key={ev.id} className={`activity-item activity-${ev.kind}`}>
            <span className="activity-icon" aria-hidden>
              {eventIcon(ev.kind)}
            </span>
            <div className="activity-body">
              <div className="activity-title-row">
                <span className="activity-title">{ev.title}</span>
                {ev.status && <StatusBadge status={ev.status} />}
              </div>
              {ev.detail && <p className="activity-detail">{ev.detail}</p>}
              <div className="activity-meta">
                <span>{formatWhen(ev.at)}</span>
                {ev.source && <span> · {ev.source}</span>}
                {ev.runId && (
                  <>
                    {' · '}
                    <Link to={`/runs/${ev.runId}`}>View run</Link>
                  </>
                )}
                {ev.incidentId && !ev.runId && (
                  <>
                    {' · '}
                    <Link to="/approvals">Approvals</Link>
                  </>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
