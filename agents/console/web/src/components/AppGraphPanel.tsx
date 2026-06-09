import { Link } from 'react-router-dom';
import type { AppListEntry, AppReviewResult } from '../types';
import { AppGraphVisual } from './AppGraphVisual';
import { AppGraphNodeIcon, displayKindLabel, inferDisplayKind } from './AppGraphNodeIcon';

interface Props {
  review: AppReviewResult | null;
  loading: boolean;
  error: string | null;
  appId: string;
  namespace: string;
  apps: AppListEntry[];
  appsLoading: boolean;
  onAppIdChange: (v: string) => void;
  onNamespaceChange: (v: string) => void;
  onSelectApp: (app: AppListEntry) => void;
  onRefresh: () => void;
}

function statusLamp(status: string): 'ok' | 'warn' | 'down' {
  if (status === 'ok') return 'ok';
  if (status === 'degraded' || status === 'unknown') return 'warn';
  return 'down';
}

export function AppGraphPanel({
  review,
  loading,
  error,
  appId,
  namespace,
  apps,
  appsLoading,
  onAppIdChange,
  onNamespaceChange,
  onSelectApp,
  onRefresh,
}: Props) {
  const overall = review?.overallStatus ?? 'unknown';
  const lamp = statusLamp(overall);

  return (
    <div className="card cluster-health-card app-graph-card">
      <div className="card-header">
        <h3>Application review</h3>
        <div className="cluster-health-header-actions">
          {review && <span className={`cluster-health-badge ${lamp}`}>{overall}</span>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>
      <div className="card-body cluster-health-body">
        <div className="app-graph-controls">
          <label>
            App
            <input
              type="text"
              value={appId}
              onChange={(e) => onAppIdChange(e.target.value)}
              placeholder="e.g. commander"
              className="app-graph-input"
              list="app-graph-app-list"
            />
            <datalist id="app-graph-app-list">
              {apps.map((a) => (
                <option key={`${a.namespace}/${a.appId}`} value={a.appId}>
                  {a.namespace}/{a.appId}
                </option>
              ))}
            </datalist>
          </label>
          <label>
            Namespace
            <input
              type="text"
              value={namespace}
              onChange={(e) => onNamespaceChange(e.target.value)}
              placeholder="optional"
              className="app-graph-input"
            />
          </label>
        </div>

        {apps.length > 0 && (
          <div className="app-graph-picker">
            {appsLoading ? (
              <span className="cluster-health-muted">Loading apps…</span>
            ) : (
              apps.slice(0, 10).map((a) => (
                <button
                  key={`${a.namespace}/${a.appId}`}
                  type="button"
                  className={`app-graph-chip${a.appId === appId && a.namespace === namespace ? ' active' : ''}`}
                  onClick={() => onSelectApp(a)}
                >
                  {a.namespace}/{a.appId}
                </button>
              ))
            )}
          </div>
        )}

        {loading && !review && <p className="cluster-health-muted">Building app graph…</p>}

        {error && (
          <div className="cluster-health-banner cluster-health-banner-down" role="alert">
            <p className="cluster-health-error-text">{error}</p>
          </div>
        )}

        {review && !error && (
          <>
            <div className={`cluster-health-banner cluster-health-banner-${lamp}`} role="status">
              <div className="cluster-health-lamp-wrap" aria-hidden>
                <span className={`cluster-health-lamp cluster-health-lamp-${lamp}`} />
              </div>
              <div className="cluster-health-banner-text">
                <strong className={`cluster-health-banner-title cluster-health-banner-title-${lamp}`}>
                  {review.appId} ({review.namespace})
                </strong>
                <p className="cluster-health-banner-summary">{review.narrative.replace(/\*\*/g, '')}</p>
              </div>
            </div>

            {review.graph.nodes.length > 0 && (
              <>
                <AppGraphVisual
                  graph={review.graph}
                  frontierNodeId={review.frontierNodeId}
                  appId={review.appId}
                  namespace={review.namespace}
                />
                <div className="app-graph-nodes">
                  <h4>All components</h4>
                  <ul className="cluster-health-list app-graph-component-list">
                    {review.graph.nodes.map((n) => {
                      const dk = inferDisplayKind(n);
                      const nl = statusLamp(n.status);
                      const isFrontier = n.id === review.frontierNodeId;
                      const actionable = n.status !== 'ok' || isFrontier;
                      return (
                        <li key={n.id} className={`app-graph-component-row${isFrontier ? ' app-graph-frontier' : ''}`}>
                          <span className={`app-graph-list-icon app-graph-icon-${dk}`}>
                            <AppGraphNodeIcon kind={dk} size={16} />
                          </span>
                          <div className="app-graph-component-main">
                            <span className="app-graph-component-title">
                              <span className="mono">{displayKindLabel(dk)}</span>
                              <span className="app-graph-component-sep">·</span>
                              <span>{n.namespace ? `${n.namespace}/` : ''}{n.name}</span>
                            </span>
                            <span className="cluster-health-muted">{n.detail}</span>
                          </div>
                          <span className={`cluster-health-dot ${nl}`} aria-hidden />
                          {isFrontier && <span className="app-graph-frontier-tag">frontier</span>}
                          {actionable && (
                            <Link
                              to={`/chat?q=${encodeURIComponent(
                                `investigate ${n.name} in ${n.namespace || review.namespace}`
                              )}`}
                              className="app-graph-component-link"
                            >
                              Investigate
                            </Link>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </>
            )}

            <p className="cluster-health-foot">
              <Link
                to={`/chat?q=${encodeURIComponent(`investigate app ${review.appId}${review.namespace ? ` in ${review.namespace}` : ''}`)}`}
                className="cluster-health-link"
              >
                Investigate in chat
              </Link>
              {review.overallStatus !== 'ok' && (
                <>
                  {' · '}
                  <Link
                    to={`/chat?q=${encodeURIComponent(`fix app ${review.appId}${review.namespace ? ` in ${review.namespace}` : ''}`)}`}
                    className="cluster-health-link"
                  >
                    Fix in chat
                  </Link>
                </>
              )}
              {review.checkedAt && (
                <span className="cluster-health-muted"> · checked {new Date(review.checkedAt).toLocaleTimeString()}</span>
              )}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
