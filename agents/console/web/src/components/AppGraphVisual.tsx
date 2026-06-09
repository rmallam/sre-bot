import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AppGraph, AppGraphNode } from '../types';
import { computeGraphLayout, edgePath, NODE_H, NODE_W } from './app-graph-layout';
import {
  AppGraphNodeIcon,
  displayKindLabel,
  inferDisplayKind,
  type GraphDisplayKind,
} from './AppGraphNodeIcon';

interface Props {
  graph: AppGraph;
  frontierNodeId?: string;
  appId: string;
  namespace: string;
}

function statusColor(status: AppGraphNode['status']): string {
  switch (status) {
    case 'ok':
      return 'var(--success, #22c55e)';
    case 'degraded':
      return 'var(--warning, #eab308)';
    case 'down':
      return 'var(--danger, #ef4444)';
    default:
      return 'var(--text-dim, #94a3b8)';
  }
}

function isActionable(node: AppGraphNode, frontierNodeId?: string): boolean {
  if (node.id === frontierNodeId) return true;
  return node.status === 'down' || node.status === 'degraded';
}

function investigateHref(node: AppGraphNode, appId: string, namespace: string): string {
  const dk = inferDisplayKind(node);
  const target =
    dk === 'deployment' || dk === 'pod'
      ? `investigate ${node.name} in ${node.namespace || namespace}`
      : `investigate app ${appId} in ${namespace}`;
  return `/chat?q=${encodeURIComponent(target)}`;
}

function fixHref(appId: string, namespace: string): string {
  return `/chat?q=${encodeURIComponent(`fix app ${appId} in ${namespace}`)}`;
}

function NodeTooltip({
  node,
  displayKind,
  frontierNodeId,
  appId,
  namespace,
  onClose,
}: {
  node: AppGraphNode;
  displayKind: GraphDisplayKind;
  frontierNodeId?: string;
  appId: string;
  namespace: string;
  onClose: () => void;
}) {
  const isFrontier = node.id === frontierNodeId;
  const actionable = isActionable(node, frontierNodeId);
  return (
    <div className="app-graph-tooltip" role="tooltip">
      <div className="app-graph-tooltip-header">
        <span className={`app-graph-tooltip-icon app-graph-icon-${displayKind}`}>
          <AppGraphNodeIcon kind={displayKind} size={18} />
        </span>
        <div>
          <div className="app-graph-tooltip-kind">{displayKindLabel(displayKind)}</div>
          <div className="app-graph-tooltip-name">{node.name}</div>
        </div>
        <button type="button" className="app-graph-tooltip-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {node.namespace && (
        <div className="app-graph-tooltip-row">
          <span className="app-graph-tooltip-label">Namespace</span>
          <span className="mono">{node.namespace}</span>
        </div>
      )}
      <div className="app-graph-tooltip-row">
        <span className="app-graph-tooltip-label">Status</span>
        <span className={`app-graph-status-pill status-${node.status}`}>{node.status}</span>
      </div>
      {node.ready != null && node.desired != null && (
        <div className="app-graph-tooltip-row">
          <span className="app-graph-tooltip-label">Replicas</span>
          <span>
            {node.ready}/{node.desired} ready
          </span>
        </div>
      )}
      <div className="app-graph-tooltip-detail">{node.detail}</div>
      {isFrontier && <div className="app-graph-tooltip-frontier">Failure frontier — root cause path stops here</div>}
      {actionable && (
        <div className="app-graph-tooltip-actions">
          <Link to={investigateHref(node, appId, namespace)} className="btn btn-primary btn-sm">
            Investigate
          </Link>
          <Link to={fixHref(appId, namespace)} className="btn btn-ghost btn-sm">
            Fix app
          </Link>
        </div>
      )}
    </div>
  );
}

export function AppGraphVisual({ graph, frontierNodeId, appId, namespace }: Props) {
  const layout = useMemo(() => computeGraphLayout(graph), [graph]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);

  const activeId = pinnedId ?? hoveredId;
  const activeNode = activeId ? graph.nodes.find((n) => n.id === activeId) : undefined;

  if (graph.nodes.length === 0) {
    return <p className="cluster-health-muted">No graph nodes to display.</p>;
  }

  return (
    <div className="app-graph-visual-wrap">
      <div className="app-graph-legend">
        <span className="app-graph-legend-item">
          <span className="app-graph-legend-dot ok" /> Healthy
        </span>
        <span className="app-graph-legend-item">
          <span className="app-graph-legend-dot warn" /> Degraded / unknown
        </span>
        <span className="app-graph-legend-item">
          <span className="app-graph-legend-dot down" /> Down
        </span>
        <span className="app-graph-legend-hint">Hover for details · click unhealthy nodes to investigate</span>
      </div>

      <svg
        className="app-graph-visual"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={`Application graph for ${graph.appId}`}
      >
        <defs>
          <pattern id="app-graph-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M24 0H0V24" fill="none" stroke="var(--border-subtle)" strokeWidth="0.5" opacity="0.35" />
          </pattern>
          <marker id="app-graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
            <path d="M0,0 L7,3 L0,6 Z" fill="var(--text-dim)" />
          </marker>
          <filter id="app-graph-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity="0.15" />
          </filter>
        </defs>

        <rect x="0" y="0" width={layout.width} height={layout.height} fill="url(#app-graph-grid)" />

        {graph.edges.map((e) => {
          const from = layout.positions.get(e.from);
          const to = layout.positions.get(e.to);
          if (!from || !to) return null;
          const highlighted =
            activeId && (e.from === activeId || e.to === activeId || e.from === hoveredId || e.to === hoveredId);
          return (
            <path
              key={`${e.from}-${e.to}-${e.kind}`}
              d={edgePath(from, to)}
              fill="none"
              stroke={highlighted ? 'var(--accent)' : 'var(--border)'}
              strokeWidth={highlighted ? 2 : 1.25}
              markerEnd="url(#app-graph-arrow)"
              opacity={highlighted ? 1 : 0.65}
            />
          );
        })}

        {graph.nodes.map((n) => {
          const pos = layout.positions.get(n.id);
          if (!pos) return null;
          const displayKind = inferDisplayKind(n);
          const isFrontier = n.id === frontierNodeId;
          const isActive = activeId === n.id;
          const actionable = isActionable(n, frontierNodeId);
          const stroke = isFrontier ? 'var(--danger)' : statusColor(n.status);
          const x = pos.x - NODE_W / 2;
          const y = pos.y - NODE_H / 2;

          return (
            <g
              key={n.id}
              transform={`translate(${x}, ${y})`}
              className={`app-graph-node${isActive ? ' active' : ''}${actionable ? ' actionable' : ''}`}
              onMouseEnter={() => setHoveredId(n.id)}
              onMouseLeave={() => setHoveredId((cur) => (cur === n.id && !pinnedId ? null : cur))}
              onClick={() => setPinnedId((cur) => (cur === n.id ? null : n.id))}
              style={{ cursor: actionable ? 'pointer' : 'default' }}
              filter={isActive ? 'url(#app-graph-shadow)' : undefined}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={10}
                className="app-graph-node-bg"
                stroke={stroke}
                strokeWidth={isFrontier ? 2.5 : isActive ? 2 : 1.25}
              />
              {isFrontier && (
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={10}
                  className="app-graph-node-frontier-ring"
                  fill="none"
                  stroke="var(--danger)"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                />
              )}
              <foreignObject x={10} y={10} width={28} height={28}>
                <span className={`app-graph-node-icon-wrap app-graph-icon-${displayKind}`}>
                  <AppGraphNodeIcon kind={displayKind} size={22} />
                </span>
              </foreignObject>
              <text x={44} y={22} className="app-graph-node-kind">
                {displayKindLabel(displayKind)}
              </text>
              <text x={44} y={40} className="app-graph-node-name">
                {n.name.length > 16 ? `${n.name.slice(0, 15)}…` : n.name}
              </text>
              <text x={44} y={56} className="app-graph-node-ns">
                {n.namespace || 'cluster'}
              </text>
              <circle cx={NODE_W - 14} cy={14} r={5} fill={statusColor(n.status)} />
              {actionable && (
                <text x={NODE_W - 14} y={58} textAnchor="middle" className="app-graph-node-action-hint">
                  ↗
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {activeNode && (
        <NodeTooltip
          node={activeNode}
          displayKind={inferDisplayKind(activeNode)}
          frontierNodeId={frontierNodeId}
          appId={appId}
          namespace={namespace}
          onClose={() => {
            setPinnedId(null);
            setHoveredId(null);
          }}
        />
      )}
    </div>
  );
}
