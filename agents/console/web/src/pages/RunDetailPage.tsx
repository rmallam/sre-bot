import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { cancelRun, fetchRun, fetchRunSummary } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { OutcomeBadge, formatAction } from '../components/OutcomeBadge';
import { CodingAgentPanel } from '../components/CodingAgentPanel';
import { useToast } from '../components/Toast';
import type { RemediationOutcome } from '../types';

interface Props {
  live?: boolean;
}

export function RunDetailPage({ live = true }: Props) {
  const { runId } = useParams<{ runId: string }>();
  const toast = useToast();
  const [run, setRun] = useState<Record<string, unknown> | null>(null);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!runId) return;
    fetchRun(runId).then(setRun).catch(console.error);
    fetchRunSummary(runId, true)
      .then((s) => setSummary(s.text))
      .catch(() => setSummary(''));
  }, [runId]);

  useEffect(() => {
    load();
    const ms = live ? 5000 : 30000;
    const id = setInterval(load, ms);
    return () => clearInterval(id);
  }, [live, load]);

  async function handleCancel() {
    if (!runId || !window.confirm('Cancel this run? In-flight tools may still finish.')) return;
    setBusy(true);
    try {
      await cancelRun(runId);
      toast('Run cancelled');
      load();
    } catch (e) {
      toast(String(e), true);
    } finally {
      setBusy(false);
    }
  }

  if (!run) {
    return <p style={{ color: 'var(--text-muted)' }}>Loading run…</p>;
  }

  const transcript = (run.transcript as Array<Record<string, unknown>>) ?? [];
  const status = String(run.status ?? 'unknown');
  const outcome = run.outcome as RemediationOutcome | undefined;
  const canCancel = status === 'running' || status === 'awaiting_human';
  const meta = (run.metadata as Record<string, unknown> | undefined) ?? {};
  const codingAgentJobId =
    typeof meta.codingAgentJobId === 'string' ? meta.codingAgentJobId : undefined;
  const suggestedAction = outcome?.suggestedAction ?? meta.remediationPlan
    ? (meta.remediationPlan as { action?: string }).action
    : undefined;
  const showCodingPanel = !!codingAgentJobId || suggestedAction === 'coding_agent_handoff';

  return (
    <>
      <Link to="/runs" style={{ fontSize: '0.875rem' }}>
        ← Back to runs
      </Link>

      <div style={{ marginTop: '1rem', marginBottom: '1.5rem', display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <h3 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
            Run <span className="mono">{runId?.slice(0, 12)}…</span>
          </h3>
          <StatusBadge status={status} />
          <span style={{ marginLeft: 12, color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            Incident {String(run.incidentId).slice(0, 8)}…
          </span>
        </div>
        {canCancel && (
          <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={handleCancel}>
            Cancel run
          </button>
        )}
      </div>

      {outcome && (
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <div className="card-header">
            <h3>Remediation outcome</h3>
            <OutcomeBadge worked={outcome.worked} />
          </div>
          <div className="card-body">
            <div className="attempt-grid">
              <div>
                <label>Suggested fix</label>
                <p>
                  <strong>{formatAction(outcome.suggestedAction)}</strong>
                </p>
              </div>
              <div>
                <label>Root cause</label>
                <p>{outcome.rootCause ?? '—'}</p>
              </div>
            </div>
            {outcome.reasoning && (
              <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginTop: '0.75rem' }}>
                {outcome.reasoning}
              </p>
            )}
            {outcome.actionsTaken.length > 0 && (
              <div className="attempt-actions" style={{ marginTop: '1rem' }}>
                <label>What was done</label>
                <ul>
                  {outcome.actionsTaken.map((a, i) => (
                    <li key={i} className={a.success ? 'ok' : 'fail'}>
                      <span className="action-mark">{a.success ? '✓' : '✗'}</span>
                      <strong>{formatAction(a.action)}</strong>
                      <span className="muted"> — {a.summary.slice(0, 200)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {outcome.followUp && (
              <div className="attempt-followup" style={{ marginTop: '0.75rem' }}>
                <label>Follow-up</label>
                <p>{outcome.followUp}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {showCodingPanel && codingAgentJobId && (
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <div className="card-header">
            <h3>Code fixer</h3>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>Live · LLM loop</span>
          </div>
          <div className="card-body">
            <CodingAgentPanel jobId={codingAgentJobId} live={status === 'running'} />
          </div>
        </div>
      )}

      {showCodingPanel && !codingAgentJobId && suggestedAction === 'coding_agent_handoff' && (
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <div className="card-header">
            <h3>Code fixer</h3>
          </div>
          <div className="card-body">
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.875rem' }}>
              Waiting for approval — the automated fixer starts after you approve this run.
            </p>
          </div>
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h3>Summary</h3>
          </div>
          <div className="card-body">
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                fontSize: '0.8125rem',
                fontFamily: 'inherit',
              }}
            >
              {summary || 'No summary available.'}
            </pre>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3>Tool pipeline</h3>
          </div>
          <div className="card-body">
            {((run.tools as string[]) ?? []).length > 0 ? (
              <p style={{ margin: 0, fontSize: '0.875rem' }}>
                {(run.tools as string[]).join(' → ')}
              </p>
            ) : (
              <p style={{ margin: 0, color: 'var(--text-muted)' }}>Not compiled yet</p>
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: '1.25rem' }}>
        <div className="card-header">
          <h3>Action timeline</h3>
        </div>
        <div className="card-body">
          {transcript.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', margin: 0 }}>No tool executions recorded.</p>
          ) : (
            <ul className="timeline">
              {transcript.map((entry, i) => (
                <li key={i} className={entry.success ? 'ok' : 'fail'}>
                  <strong>{String(entry.tool)}</strong>
                  {entry.summary && (
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                      {String(entry.summary)}
                    </div>
                  )}
                  {entry.error && (
                    <div style={{ color: '#fca5a5', fontSize: '0.8125rem' }}>
                      {String(entry.error)}
                    </div>
                  )}
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                    {entry.durationMs != null && `${entry.durationMs}ms · `}
                    {entry.at && new Date(String(entry.at)).toLocaleTimeString()}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
