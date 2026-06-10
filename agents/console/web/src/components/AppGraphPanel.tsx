import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AppCatalogEntry, AppListEntry, AppReviewResult } from '../types';
import { AppGraphVisual } from './AppGraphVisual';
import { AppGraphNodeIcon, displayKindLabel, inferDisplayKind } from './AppGraphNodeIcon';

interface Props {
  review: AppReviewResult | null;
  loading: boolean;
  error: string | null;
  appId: string;
  namespace: string;
  apps: AppListEntry[];
  allApps: AppListEntry[];
  namespaces: string[];
  appsLoading: boolean;
  catalogEntry: AppCatalogEntry | null;
  onAppIdChange: (v: string) => void;
  onNamespaceChange: (v: string) => void;
  onSelectApp: (app: AppListEntry) => void;
  onRefresh: () => void;
  onSaveCatalog: (entry: AppCatalogEntry) => Promise<void>;
}

function statusLamp(status: string): 'ok' | 'warn' | 'down' {
  if (status === 'ok') return 'ok';
  if (status === 'degraded' || status === 'unknown') return 'warn';
  return 'down';
}

function sourceLabel(source: AppListEntry['source']): string {
  switch (source) {
    case 'helm-instance':
      return 'Helm release';
    case 'annotation':
      return 'Annotation';
    case 'auto':
      return 'Auto (deploy)';
    case 'user':
      return 'User catalog';
    case 'part-of':
      return 'Part-of label';
    default:
      return source;
  }
}

export function AppGraphPanel({
  review,
  loading,
  error,
  appId,
  namespace,
  apps,
  allApps,
  namespaces,
  appsLoading,
  catalogEntry,
  onAppIdChange,
  onNamespaceChange,
  onSelectApp,
  onRefresh,
  onSaveCatalog,
}: Props) {
  const overall = review?.overallStatus ?? 'unknown';
  const lamp = statusLamp(overall);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [membersText, setMembersText] = useState('');
  const [dependsOnText, setDependsOnText] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const selectedApp = useMemo(
    () => apps.find((a) => a.appId === appId && a.namespace === namespace),
    [apps, appId, namespace]
  );

  useEffect(() => {
    const members =
      catalogEntry?.members?.map((m) => m.resourceName) ??
      selectedApp?.memberNames ??
      (review ? review.graph.nodes.filter((n) => n.kind === 'deployment').map((n) => n.name) : []);
    setMembersText(members.join('\n'));
    setDependsOnText((catalogEntry?.dependsOn ?? []).join(', '));
    setDisplayName(catalogEntry?.displayName ?? '');
  }, [catalogEntry, selectedApp, review, appId, namespace]);

  const handleSave = async () => {
    if (!appId.trim() || !namespace.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const members = membersText
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((resourceName) => ({ resourceKind: 'Deployment', resourceName }));
      const dependsOn = dependsOnText
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean);
      await onSaveCatalog({
        appId: appId.trim(),
        namespace: namespace.trim(),
        displayName: displayName.trim() || undefined,
        source: 'user',
        members,
        dependsOn: dependsOn.length ? dependsOn : undefined,
        userEdited: true,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  };

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
            Namespace
            <select
              value={namespace}
              onChange={(e) => onNamespaceChange(e.target.value)}
              className="app-graph-input app-graph-select"
              disabled={appsLoading || namespaces.length === 0}
            >
              {namespaces.length === 0 && <option value="">No namespaces</option>}
              {namespaces.map((ns) => (
                <option key={ns} value={ns}>
                  {ns}
                </option>
              ))}
            </select>
          </label>
          <label>
            App
            <select
              value={appId}
              onChange={(e) => onAppIdChange(e.target.value)}
              className="app-graph-input app-graph-select"
              disabled={appsLoading || apps.length === 0}
            >
              {apps.length === 0 && <option value="">No apps in namespace</option>}
              {apps.map((a) => (
                <option key={`${a.namespace}/${a.appId}`} value={a.appId}>
                  {a.displayName ? `${a.displayName} (${a.appId})` : a.appId}
                  {a.deploymentCount > 1 ? ` · ${a.deploymentCount} workloads` : ''}
                </option>
              ))}
            </select>
          </label>
          {selectedApp && (
            <span className="cluster-health-muted app-graph-source-tag">
              {sourceLabel(selectedApp.source)}
              {selectedApp.userEdited ? ' · curated' : ''}
            </span>
          )}
        </div>

        {allApps.length > 0 && (
          <div className="app-graph-picker">
            {appsLoading ? (
              <span className="cluster-health-muted">Loading apps…</span>
            ) : (
              allApps.slice(0, 16).map((a) => (
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

        {appId && namespace && (
          <div className="app-catalog-section">
            <button
              type="button"
              className="app-catalog-toggle"
              onClick={() => setCatalogOpen((o) => !o)}
              aria-expanded={catalogOpen}
            >
              {catalogOpen ? '▾' : '▸'} Application catalog
              {catalogEntry?.userEdited && <span className="app-graph-frontier-tag">edited</span>}
            </button>
            {catalogOpen && (
              <div className="app-catalog-form">
                <p className="cluster-health-muted">
                  Auto-generated from Helm labels and deploy metadata. Save to curate workload members and
                  depends-on edges for this app.
                </p>
                <label>
                  Display name
                  <input
                    type="text"
                    className="app-graph-input"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder={appId}
                  />
                </label>
                <label>
                  Workload members (one deployment name per line)
                  <textarea
                    className="app-graph-input app-catalog-textarea"
                    rows={4}
                    value={membersText}
                    onChange={(e) => setMembersText(e.target.value)}
                  />
                </label>
                <label>
                  Depends on (comma-separated service or app names)
                  <input
                    type="text"
                    className="app-graph-input"
                    value={dependsOnText}
                    onChange={(e) => setDependsOnText(e.target.value)}
                    placeholder="postgres, redis"
                  />
                </label>
                {saveError && <p className="cluster-health-error-text">{saveError}</p>}
                <button type="button" className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving…' : 'Save catalog entry'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
