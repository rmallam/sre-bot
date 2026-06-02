import { useCallback, useEffect, useState } from 'react';
import { fetchApprovals } from '../api';
import type { Approval } from '../types';
import { ApprovalCard } from '../components/ApprovalCard';

interface Props {
  live: boolean;
}

export function ApprovalsPage({ live }: Props) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [loading, setLoading] = useState(true);

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
      </div>

      {loading && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}

      {!loading && shown.length === 0 && (
        <div className="empty-state">
          <h3>All clear</h3>
          <p>No {filter === 'pending' ? 'pending approvals' : 'incidents'} right now.</p>
        </div>
      )}

      {shown.map((a) => (
        <ApprovalCard key={a.incidentId} approval={a} onAction={load} />
      ))}
    </>
  );
}
