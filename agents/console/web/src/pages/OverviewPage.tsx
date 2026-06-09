import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchAgents, fetchApprovals, fetchClusterHealth, fetchOverview, fetchRuns } from '../api';
import type { AgentHealth, Approval, ClusterHealthSnapshot, RunListItem } from '../types';
import { StatusBadge } from '../components/StatusBadge';
import { ClusterHealthPanel } from '../components/ClusterHealthPanel';

interface Props {
  live: boolean;
}

export function OverviewPage({ live }: Props) {
  const navigate = useNavigate();
  const [stats, setStats] = useState<Awaited<ReturnType<typeof fetchOverview>> | null>(null);
  const [agents, setAgents] = useState<AgentHealth[]>([]);
  const [pending, setPending] = useState<Approval[]>([]);
  const [recentRuns, setRecentRuns] = useState<RunListItem[]>([]);
  const [clusterHealth, setClusterHealth] = useState<ClusterHealthSnapshot | null>(null);
  const [clusterError, setClusterError] = useState<string | null>(null);
  const [clusterLoading, setClusterLoading] = useState(true);

  const load = useCallback(() => {
    Promise.all([
      fetchOverview().then(setStats),
      fetchAgents().then((d) => setAgents(d.agents)),
      fetchApprovals().then((d) =>
        setPending(d.approvals.filter((a) => a.status === 'PENDING').slice(0, 3))
      ),
      fetchRuns(8).then((d) => setRecentRuns(d.runs)),
    ]).catch(console.error);
  }, []);

  const loadCluster = useCallback((force = false) => {
    setClusterLoading(true);
    fetchClusterHealth(force)
      .then((data) => {
        setClusterHealth(data);
        setClusterError(null);
      })
      .catch((err) => {
        setClusterError(String(err));
      })
      .finally(() => setClusterLoading(false));
  }, []);

  useEffect(() => {
    load();
    loadCluster(true);
    const ms = live ? 5000 : 30000;
    const clusterMs = live ? 30000 : 60000;
    const id = setInterval(load, ms);
    const clusterId = setInterval(() => loadCluster(true), clusterMs);
    return () => {
      clearInterval(id);
      clearInterval(clusterId);
    };
  }, [live, load, loadCluster]);

  return (
    <>
      <div className="stats-grid stats-grid-compact">
        <div className="stat-card stat-card-action">
          <div className="label">SRE Assistant</div>
          <p className="stat-card-desc">Deploy, investigate, and triage in plain language.</p>
          <div className="stat-card-buttons">
            <Link to="/chat?new=1" className="btn btn-primary">
              New chat
            </Link>
            <Link to="/apps" className="btn btn-ghost">
              App graphs
            </Link>
          </div>
        </div>
        <div className="stat-card">
          <div className="label">Pending approvals</div>
          <div className="value warning">{stats?.pendingApprovals ?? '—'}</div>
        </div>
        <div className="stat-card">
          <div className="label">Active runs</div>
          <div className="value accent">{stats?.runsRunning ?? '—'}</div>
        </div>
        <div className="stat-card">
          <div className="label">Awaiting you</div>
          <div className="value warning">{stats?.runsAwaiting ?? '—'}</div>
        </div>
        <div className="stat-card">
          <div className="label">Succeeded</div>
          <div className="value success">{stats?.runsSucceeded ?? '—'}</div>
        </div>
        <div className="stat-card">
          <div className="label">Failed</div>
          <div className="value danger">{stats?.runsFailed ?? '—'}</div>
        </div>
      </div>

      <ClusterHealthPanel health={clusterHealth} loading={clusterLoading} error={clusterError} />

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h3>Agent health</h3>
          </div>
          <div className="card-body">
            <div className="agent-grid">
              {agents.map((a) => (
                <div key={a.name} className="agent-chip">
                  <span className={`agent-dot ${a.ok ? 'ok' : 'down'}`} />
                  {a.name}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3>Recent runs</h3>
            <Link to="/runs">All runs</Link>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            {recentRuns.length === 0 ? (
              <div className="empty-state">No runs yet</div>
            ) : (
              <table className="data-table">
                <tbody>
                  {recentRuns.map((r) => (
                    <tr
                      key={r.runId}
                      className="clickable"
                      onClick={() => navigate(`/runs/${r.runId}`)}
                    >
                      <td className="mono">{r.resourceName ?? r.runId.slice(0, 8)}</td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                        {r.mode ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {pending.length > 0 && (
        <div className="card" style={{ marginTop: '1.25rem' }}>
          <div className="card-header">
            <h3>Needs your attention</h3>
            <Link to="/approvals">Open approvals</Link>
          </div>
          <div className="card-body">
            {pending.map((a) => (
              <div key={a.incidentId} style={{ marginBottom: '0.75rem' }}>
                <strong>
                  {a.namespace}/{a.resourceName}
                </strong>
                <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
                  {a.plan?.action?.replace(/_/g, ' ') ?? 'approval pending'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
