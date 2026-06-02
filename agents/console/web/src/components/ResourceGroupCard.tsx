import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ResourceRunGroup, RunListItem } from '../types';
import { StatusBadge } from './StatusBadge';
import { OutcomeBadge, formatAction } from './OutcomeBadge';
import { formatSkillSnippet } from '../skill-format';

interface Props {
  group: ResourceRunGroup;
}

function AttemptRow({ run, onCopySkill }: { run: RunListItem; onCopySkill: (md: string) => void }) {
  const navigate = useNavigate();
  const o = run.outcome;

  return (
    <div className="attempt-row">
      <div className="attempt-header">
        <button type="button" className="link-btn mono" onClick={() => navigate(`/runs/${run.runId}`)}>
          {run.runId.slice(0, 8)}…
        </button>
        <StatusBadge status={run.status} />
        <OutcomeBadge worked={o?.worked} />
        <span className="attempt-time">{new Date(run.updatedAt).toLocaleString()}</span>
      </div>

      {o && (
        <div className="attempt-body">
          <div className="attempt-grid">
            <div>
              <label>Suggested fix</label>
              <p>
                <strong>{formatAction(o.suggestedAction)}</strong>
                {o.planSource === 'human' && (
                  <span className="tag-human" style={{ marginLeft: 8 }}>
                    human
                  </span>
                )}
              </p>
              {o.rootCause && (
                <p className="muted" style={{ margin: '0.35rem 0 0', fontSize: '0.8125rem' }}>
                  {o.rootCause}
                </p>
              )}
            </div>
            <div>
              <label>Mode</label>
              <p>{run.mode?.replace(/-/g, ' ') ?? '—'}</p>
            </div>
          </div>

          {o.actionsTaken.length > 0 && (
            <div className="attempt-actions">
              <label>What was done</label>
              <ul>
                {o.actionsTaken.map((a, i) => (
                  <li key={i} className={a.success ? 'ok' : 'fail'}>
                    <span className="action-mark">{a.success ? '✓' : '✗'}</span>
                    <strong>{formatAction(a.action)}</strong>
                    <span className="muted"> — {a.summary.slice(0, 180)}</span>
                    {a.verifyStatus && (
                      <span className="verify-tag"> verify: {a.verifyStatus}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {o.followUp && (
            <div className="attempt-followup">
              <label>Follow-up</label>
              <p>{o.followUp}</p>
            </div>
          )}

          <div className="attempt-footer">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onCopySkill(formatSkillSnippet(run, run.displayName))}
            >
              Copy skill snippet
            </button>
          </div>
        </div>
      )}

      {!o && (
        <p className="muted" style={{ margin: '0.5rem 0 0', fontSize: '0.8125rem' }}>
          No structured outcome yet — open run for timeline.
        </p>
      )}
    </div>
  );
}

export function ResourceGroupCard({ group, onCopySkill }: Props & { onCopySkill: (md: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const latest = group.runs[0];
  const latestOutcome = latest?.outcome;

  return (
    <article className="resource-group-card">
      <header
        className="resource-group-header"
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => e.key === 'Enter' && setExpanded((v) => !v)}
        role="button"
        tabIndex={0}
      >
        <div className="resource-group-title">
          <span className={`resource-kind ${group.kind}`}>{group.kind === 'ci' ? 'CI' : 'K8s'}</span>
          <h3>{group.displayName}</h3>
        </div>
        <div className="resource-group-meta">
          <StatusBadge status={group.latestStatus} />
          {latestOutcome && <OutcomeBadge worked={latestOutcome.worked} />}
          <span className="attempt-count">
            {group.attemptCount} attempt{group.attemptCount !== 1 ? 's' : ''}
            {group.successCount > 0 && ` · ${group.successCount} worked`}
          </span>
          <span className="chevron">{expanded ? '▾' : '▸'}</span>
        </div>
      </header>

      {expanded && (
        <div className="resource-group-body">
          {group.runs.map((run) => (
            <AttemptRow key={run.runId} run={run} onCopySkill={onCopySkill} />
          ))}
        </div>
      )}
    </article>
  );
}
