import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { cancelRun, fetchRun, fetchRunSummary } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { OutcomeBadge, formatAction, formatSuggestedFix } from '../components/OutcomeBadge';
import { CodingAgentPanel } from '../components/CodingAgentPanel';
import {
  formatRunSuccessBanner,
  formatToolDisplayLabel,
  formatToolPipelineLabel,
  formatToolSummaryDetail,
} from '../run-display';
import { useToast } from '../components/Toast';
import type { RemediationOutcome } from '../types';

interface Props {
  live?: boolean;
}

function isStaleRunning(run: Record<string, unknown>): boolean {
  if (run.isStale === true) return true;
  if (String(run.status) !== 'running') return false;
  const transcript = (run.transcript as unknown[]) ?? [];
  if (transcript.length > 0) return false;
  const updatedAt = String(run.updatedAt ?? run.startedAt ?? '');
  const updatedMs = Date.parse(updatedAt);
  if (Number.isNaN(updatedMs)) return false;
  return Date.now() - updatedMs > 2 * 60 * 60 * 1000;
}

export function RunDetailPage({ live = true }: Props) {
  const { runId: routeRunId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [run, setRun] = useState<Record<string, unknown> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [resolvedRunId, setResolvedRunId] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!routeRunId) return;
    setLoadError(null);
    fetchRun(routeRunId)
      .then((data) => {
        setRun(data);
        const fullId = String(data.runId ?? routeRunId);
        setResolvedRunId(fullId);
        if (data.resolvedFrom) {
          navigate(`/runs/${encodeURIComponent(fullId)}`, { replace: true });
        }
      })
      .catch((err) => {
        setRun(null);
        setLoadError(String(err).includes('404') ? 'Run not found — check the full run ID.' : String(err));
      });
    fetchRunSummary(routeRunId, true)
      .then((s) => setSummary(s.text))
      .catch(() => setSummary(''));
  }, [routeRunId, navigate]);

  useEffect(() => {
    setRun(null);
    setLoadError(null);
    load();
    const ms = live ? 5000 : 30000;
    const id = setInterval(load, ms);
    return () => clearInterval(id);
  }, [live, load]);

  async function handleCancel() {
    const id = resolvedRunId ?? routeRunId;
    if (!id || !window.confirm('Cancel this run? In-flight tools may still finish.')) return;
    setBusy(true);
    try {
      await cancelRun(id);
      toast('Run cancelled');
      load();
    } catch (e) {
      toast(String(e), true);
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <>
        <Link to="/runs" style={{ fontSize: '0.875rem' }}>
          ← Back to runs
        </Link>
        <div className="card" style={{ marginTop: '1rem' }}>
          <div className="card-body">
            <h3 style={{ marginTop: 0 }}>Run not found</h3>
            <p style={{ color: 'var(--text-muted)' }}>
              {loadError}
              {routeRunId && (
                <>
                  {' '}
                  Requested ID: <span className="mono">{routeRunId}</span>
                </>
              )}
            </p>
            <p style={{ fontSize: '0.8125rem', color: 'var(--text-dim)' }}>
              Run links must include the full UUID. If you copied a truncated ID, open the run from
              the Runs tab or chat **View run** button.
            </p>
          </div>
        </div>
      </>
    );
  }

  if (!run) {
    return <p style={{ color: 'var(--text-muted)' }}>Loading run…</p>;
  }

  const transcript = (run.transcript as Array<Record<string, unknown>>) ?? [];
  const status = String(run.status ?? 'unknown');
  const outcome = run.outcome as RemediationOutcome | undefined;
  const canCancel = status === 'running' || status === 'awaiting_human';
  const stale = isStaleRunning(run);
  const suggestedActionLabel =
    typeof run.suggestedActionLabel === 'string' ? run.suggestedActionLabel : undefined;
  const meta = (run.metadata as Record<string, unknown> | undefined) ?? {};
  const codingAgentJobId =
    typeof meta.codingAgentJobId === 'string' ? meta.codingAgentJobId : undefined;
  const plan = meta.remediationPlan as { action?: string } | undefined;
  const suggestedAction = outcome?.suggestedAction ?? plan?.action;
  const planAction = plan?.action;
  const successBanner = formatRunSuccessBanner(run);
  const showCodingPanel = !!codingAgentJobId || suggestedAction === 'coding_agent_handoff';
  const displayRunId = resolvedRunId ?? String(run.runId ?? routeRunId ?? '');

  return (
    <>
      <Link to="/runs" style={{ fontSize: '0.875rem' }}>
        ← Back to runs
      </Link>

      {stale && (
        <div className="cluster-health-banner cluster-health-banner-warn" style={{ marginTop: '1rem' }} role="alert">
          <p className="cluster-health-banner-summary" style={{ margin: 0 }}>
            This run looks <strong>stuck</strong> — still marked running with no tool steps recorded.
            Cancel it and start a fresh investigation from chat.
          </p>
        </div>
      )}

      <div style={{ marginTop: '1rem', marginBottom: '1.5rem', display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <h3 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
            Run <span className="mono">{displayRunId}</span>
          </h3>
          <StatusBadge status={stale ? 'stale' : status} />
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

      {successBanner && (
        <div className="run-success-banner" role="status">
          <h4>All set</h4>
          <pre className="run-success-banner-body">{successBanner}</pre>
        </div>
      )}

      {outcome && (
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <div className="card-header">
            <h3>Remediation outcome</h3>
            <OutcomeBadge
              worked={outcome.worked}
              suggestedAction={outcome.suggestedAction}
              finalStatus={outcome.finalStatus}
            />
          </div>
          <div className="card-body">
            <div className="attempt-grid">
              <div>
                <label>Suggested fix</label>
                <p>
                  <strong>
                    {suggestedActionLabel ??
                      formatSuggestedFix({
                        status,
                        toolCount: transcript.length,
                        outcome,
                      })}
                  </strong>
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
            {(outcome.actionsTaken ?? []).length > 0 && (
              <div className="attempt-actions" style={{ marginTop: '1rem' }}>
                <label>What was done</label>
                <ul>
                  {(outcome.actionsTaken ?? []).map((a, i) => (
                    <li key={i} className={a.success ? 'ok' : 'fail'}>
                      <span className="action-mark">{a.success ? '✓' : '✗'}</span>
                      <strong>{formatAction(a.action)}</strong>
                      <span className="muted"> — {(a.summary ?? '').slice(0, 200)}</span>
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
                {formatToolPipelineLabel(run.tools as string[], planAction)}
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
              {transcript.map((entry, i) => {
                const tool = String(entry.tool ?? '');
                const label = formatToolDisplayLabel(tool, planAction);
                const detail = formatToolSummaryDetail(
                  tool,
                  entry.summary ? String(entry.summary) : undefined,
                  planAction
                );
                return (
                <li key={i} className={entry.success ? 'ok' : 'fail'}>
                  <strong>{label}</strong>
                  {detail && (
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                      {detail}
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
              );
              })}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
