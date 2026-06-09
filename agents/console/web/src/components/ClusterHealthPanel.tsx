import { Link } from 'react-router-dom';
import type { ClusterHealthDisplayStatus, ClusterHealthSnapshot } from '../types';

interface Props {
  health: ClusterHealthSnapshot | null;
  loading?: boolean;
  error?: string | null;
}

function investigateHref(prompt: string): string {
  return `/chat?new=1&prompt=${encodeURIComponent(prompt)}`;
}

function displayLabel(status: ClusterHealthDisplayStatus): string {
  switch (status) {
    case 'healthy':
      return 'Healthy';
    case 'degrading':
      return 'Degrading';
    case 'apps_failing':
      return 'Apps failing';
    case 'unreachable':
      return 'Unreachable';
  }
}

function lampClass(status: ClusterHealthDisplayStatus): string {
  switch (status) {
    case 'healthy':
      return 'ok';
    case 'degrading':
      return 'warn';
    case 'apps_failing':
    case 'unreachable':
      return 'down';
  }
}

function resolveDisplayStatus(health: ClusterHealthSnapshot): ClusterHealthDisplayStatus {
  if (health.displayStatus) return health.displayStatus;
  if (health.status === 'healthy') return 'healthy';
  if (health.status === 'unreachable') return 'unreachable';
  if (health.pods.problematic > 0 || health.deployments.unhealthy > 0 || health.nodes.notReady > 0) {
    return 'apps_failing';
  }
  return 'degrading';
}

function StatusBanner({ health }: { health: ClusterHealthSnapshot }) {
  const display = resolveDisplayStatus(health);
  const lamp = lampClass(display);
  const summary =
    health.statusSummary ??
    (health.reachable ? 'Cluster status unknown.' : health.error ?? 'Cluster API unreachable.');

  return (
    <div className={`cluster-health-banner cluster-health-banner-${lamp}`} role="status">
      <div className="cluster-health-lamp-wrap" aria-hidden>
        <span className={`cluster-health-lamp cluster-health-lamp-${lamp}`} />
        <span className={`cluster-health-lamp-glow cluster-health-lamp-glow-${lamp}`} />
      </div>
      <div className="cluster-health-banner-text">
        <strong className={`cluster-health-banner-title cluster-health-banner-title-${lamp}`}>
          {displayLabel(display)}
        </strong>
        <p
          className={`cluster-health-banner-summary ${lamp === 'down' ? 'cluster-health-error-text' : ''}`}
        >
          {summary}
        </p>
      </div>
    </div>
  );
}

export function ClusterHealthPanel({ health, loading, error }: Props) {
  if (loading && !health) {
    return (
      <div className="card cluster-health-card">
        <div className="card-header">
          <h3>Cluster health</h3>
        </div>
        <div className="card-body">
          <p className="cluster-health-muted">Checking cluster…</p>
        </div>
      </div>
    );
  }

  if (error && !health) {
    return (
      <div className="card cluster-health-card">
        <div className="card-header">
          <h3>Cluster health</h3>
          <Link to={investigateHref('investigate cluster health')} className="btn btn-ghost btn-sm">
            Investigate
          </Link>
        </div>
        <div className="card-body cluster-health-body">
          <div className="cluster-health-banner cluster-health-banner-down" role="status">
            <div className="cluster-health-lamp-wrap" aria-hidden>
              <span className="cluster-health-lamp cluster-health-lamp-down" />
              <span className="cluster-health-lamp-glow cluster-health-lamp-glow-down" />
            </div>
            <div className="cluster-health-banner-text">
              <strong className="cluster-health-banner-title cluster-health-banner-title-down">
                Unreachable
              </strong>
              <p className="cluster-health-banner-summary cluster-health-error-text">{error}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!health) return null;

  const display = resolveDisplayStatus(health);
  const lamp = lampClass(display);
  const hasFailures = display === 'apps_failing' || display === 'unreachable';

  return (
    <div className="card cluster-health-card">
      <div className="card-header">
        <h3>Cluster health</h3>
        <div className="cluster-health-header-actions">
          <span className={`cluster-health-badge ${lamp}`}>{displayLabel(display)}</span>
          <Link
            to={investigateHref('investigate cluster health')}
            className="btn btn-ghost btn-sm"
          >
            Investigate
          </Link>
        </div>
      </div>
      <div className="card-body cluster-health-body">
        <StatusBanner health={health} />

        {!health.reachable ? null : (
          <>
            <div className="cluster-health-stats">
              <div className="cluster-health-stat">
                <span className="cluster-health-stat-value">{health.nodes.ready}</span>
                <span className="cluster-health-stat-label">
                  nodes ready
                  {health.nodes.notReady > 0 && (
                    <span className="cluster-health-stat-danger">
                      {' '}
                      · {health.nodes.notReady} not ready
                    </span>
                  )}
                </span>
              </div>
              <div className="cluster-health-stat">
                <span className="cluster-health-stat-value">{health.pods.running}</span>
                <span className="cluster-health-stat-label">pods running</span>
              </div>
              <div className="cluster-health-stat">
                <span
                  className={`cluster-health-stat-value ${health.pods.problematic > 0 ? 'danger' : ''}`}
                >
                  {health.pods.problematic}
                </span>
                <span className="cluster-health-stat-label">problem pods</span>
              </div>
              <div className="cluster-health-stat">
                <span
                  className={`cluster-health-stat-value ${health.deployments.unhealthy > 0 ? 'danger' : ''}`}
                >
                  {health.deployments.unhealthy}
                </span>
                <span className="cluster-health-stat-label">deployments not ready</span>
              </div>
            </div>

            {health.nodes.items.some((n) => !n.ready) && (
              <div className="cluster-health-section cluster-health-section-danger">
                <h4>Nodes not ready</h4>
                <ul className="cluster-health-list">
                  {health.nodes.items
                    .filter((n) => !n.ready)
                    .map((n) => (
                      <li key={n.name} className="cluster-health-list-danger">
                        <span className="cluster-health-dot down" aria-hidden />
                        <span className="mono">{n.name}</span>
                        <span className="cluster-health-error-text">NotReady</span>
                      </li>
                    ))}
                </ul>
              </div>
            )}

            {health.deployments.items.length > 0 && (
              <div className="cluster-health-section cluster-health-section-danger">
                <h4>Deployments not ready</h4>
                <ul className="cluster-health-list">
                  {health.deployments.items.map((d) => (
                    <li key={`${d.namespace}/${d.name}`} className="cluster-health-list-danger">
                      <span className="mono">
                        {d.namespace}/{d.name}
                      </span>
                      <span className="cluster-health-error-text">
                        {d.ready}/{d.desired} ready
                      </span>
                      <Link
                        to={`/apps?app=${encodeURIComponent(d.name)}&ns=${encodeURIComponent(d.namespace)}`}
                        className="cluster-health-link"
                      >
                        App graph
                      </Link>
                      <Link
                        to={investigateHref(`investigate ${d.name} in ${d.namespace}`)}
                        className="cluster-health-link"
                      >
                        Investigate
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {health.pods.issues.length > 0 && (
              <div className="cluster-health-section cluster-health-section-danger">
                <h4>Problem pods</h4>
                <ul className="cluster-health-list">
                  {health.pods.issues.map((p) => (
                    <li key={`${p.namespace}/${p.name}`} className="cluster-health-list-danger">
                      <span className="mono">
                        {p.namespace}/{p.name}
                      </span>
                      <span className="cluster-health-error-text">{p.reason}</span>
                      <Link
                        to={investigateHref(`investigate pod ${p.name} in ${p.namespace}`)}
                        className="cluster-health-link"
                      >
                        Investigate
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {health.warningEvents.length > 0 && (
              <div
                className={`cluster-health-section ${hasFailures ? '' : 'cluster-health-section-warn'}`}
              >
                <h4>Recent warnings (last {health.eventWindowMinutes ?? 15}m)</h4>
                <ul className="cluster-health-events">
                  {health.warningEvents.map((e, i) => (
                    <li
                      key={`${e.namespace}-${e.reason}-${i}`}
                      className={hasFailures ? '' : 'cluster-health-event-warn'}
                    >
                      <span className="cluster-health-event-reason">{e.reason}</span>
                      <span className="cluster-health-muted">
                        {e.namespace}/{e.object}
                      </span>
                      <p>{e.message}</p>
                      <Link
                        to={investigateHref(`investigate this • ${e.reason}: ${e.message}`)}
                        className="cluster-health-link cluster-health-link-block"
                      >
                        Investigate this warning
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {display === 'healthy' && (
              <p className="cluster-health-muted cluster-health-all-clear">
                All nodes ready, no failing workloads detected.
              </p>
            )}
          </>
        )}
        <p className="cluster-health-foot">
          Investigated at {new Date(health.checkedAt).toLocaleString()} · warnings from last{' '}
          {health.eventWindowMinutes ?? 15} minutes
        </p>
      </div>
    </div>
  );
}
