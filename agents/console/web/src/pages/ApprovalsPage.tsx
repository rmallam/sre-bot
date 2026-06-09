import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchApprovals, approveIncident, rejectIncident, ignoreIncident } from '../api';
import type { Approval } from '../types';
import { ApprovalCard } from '../components/ApprovalCard';
import { useToast } from '../components/Toast';

interface Props {
  live: boolean;
}

export function ApprovalsPage({ live }: Props) {
  const toast = useToast();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [loading, setLoading] = useState(true);
  const [focusIndex, setFocusIndex] = useState(0);
  const cardRefs = useRef<Array<HTMLElement | null>>([]);

  const load = useCallback(() => {
    fetchApprovals()
      .then((d) => setApprovals(d.approvals))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, live ? 5000 : 30000);
    return () => clearInterval(id);
  }, [live, load]);

  const shown =
    filter === 'pending' ? approvals.filter((a) => a.status === 'PENDING') : approvals;

  const pendingShown = shown.filter((a) => a.status === 'PENDING');

  useEffect(() => {
    setFocusIndex(0);
  }, [filter, approvals.length]);

  useEffect(() => {
    cardRefs.current[focusIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focusIndex]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (pendingShown.length === 0) return;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusIndex((i) => Math.min(i + 1, pendingShown.length - 1));
        return;
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusIndex((i) => Math.max(i - 1, 0));
        return;
      }

      const focused = pendingShown[focusIndex];
      if (!focused) return;

      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        void approveIncident(focused.incidentId)
          .then(() => {
            toast(`Approved ${focused.resourceName}`);
            load();
          })
          .catch((err) => toast(String(err), true));
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        void rejectIncident(focused.incidentId)
          .then(() => {
            toast(`Rejected ${focused.resourceName}`);
            load();
          })
          .catch((err) => toast(String(err), true));
      } else if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        void ignoreIncident(focused.incidentId)
          .then(() => {
            toast(`Ignored ${focused.resourceName}`);
            load();
          })
          .catch((err) => toast(String(err), true));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusIndex, pendingShown, load, toast]);

  return (
    <>
      <div className="filter-bar">
        <select value={filter} onChange={(e) => setFilter(e.target.value as 'pending' | 'all')}>
          <option value="pending">Pending only</option>
          <option value="all">All incidents</option>
        </select>
        <button type="button" className="btn btn-sm" onClick={load}>
          Refresh
        </button>
        {pendingShown.length > 0 && (
          <span className="keyboard-hint">
            <kbd>A</kbd> approve · <kbd>R</kbd> reject · <kbd>I</kbd> ignore · <kbd>J</kbd>/<kbd>K</kbd>{' '}
            navigate
          </span>
        )}
      </div>

      {loading && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}

      {!loading && shown.length === 0 && (
        <div className="empty-state">
          <h3>All clear</h3>
          <p>No {filter === 'pending' ? 'pending approvals' : 'incidents'} right now.</p>
        </div>
      )}

      {shown.map((a, i) => {
        const pendingIdx = pendingShown.findIndex((p) => p.incidentId === a.incidentId);
        const isFocused = a.status === 'PENDING' && pendingIdx === focusIndex;
        return (
          <div
            key={a.incidentId}
            ref={(el) => {
              if (a.status === 'PENDING' && pendingIdx >= 0) {
                cardRefs.current[pendingIdx] = el;
              }
            }}
            className={isFocused ? 'approval-card-focused' : undefined}
          >
            <ApprovalCard approval={a} onAction={load} />
          </div>
        );
      })}
    </>
  );
}
