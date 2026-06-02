import type { Approval } from '../types';
import { StatusBadge } from './StatusBadge';
import { useState } from 'react';
import { approveIncident, ignoreIncident, rejectIncident, suggestFix } from '../api';
import { useToast } from './Toast';

function formatCountdown(expiresAt: string): string {
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) return 'Expired';
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

interface Props {
  approval: Approval;
  onAction: () => void;
}

export function ApprovalCard({ approval, onAction }: Props) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState('');
  const { plan, incidentId } = approval;
  const isPending = approval.status === 'PENDING';

  async function act(fn: () => Promise<unknown>, okMsg: string) {
    setBusy(true);
    try {
      await fn();
      toast(okMsg);
      onAction();
    } catch (e) {
      toast(String(e), true);
    } finally {
      setBusy(false);
    }
  }

  const patchText =
    plan.proposedPatch
      ?.map((op) => {
        const val = op.value !== undefined ? ` → ${JSON.stringify(op.value)}` : '';
        return `${op.op.padEnd(7)} ${op.path}${val}`;
      })
      .join('\n') || '(no patch ops)';

  return (
    <article className={`approval-card ${approval.escalated ? 'escalated' : ''}`}>
      <div className="approval-header">
        <div>
          <div className="approval-title">
            {approval.resourceKind}/{approval.resourceName}
            <span style={{ marginLeft: 8 }}>
              <StatusBadge status={approval.status} />
            </span>
          </div>
          <div className="approval-meta">
            {approval.namespace} · {approval.mode} · attempt {approval.attemptNumber}/
            {approval.circuitBreakerLimit}
            {isPending && <> · ⏱ {formatCountdown(approval.expiresAt)}</>}
          </div>
          <div className="approval-meta mono" style={{ marginTop: 4 }}>
            {incidentId.slice(0, 8)}…
            {approval.runId && ` · run ${approval.runId.slice(0, 8)}…`}
          </div>
        </div>
        <span className={`badge badge-${plan.severity?.toLowerCase() ?? 'medium'}`}>
          {plan.severity}
        </span>
      </div>

      {approval.escalated && (
        <div
          style={{
            padding: '0.75rem 1.25rem',
            background: 'var(--danger-muted)',
            fontSize: '0.875rem',
          }}
        >
          Escalated — circuit breaker fired. Human action required.
        </div>
      )}

      <div className="approval-body">
        <div className="approval-section">
          <label>Root cause</label>
          <p style={{ margin: 0 }}>{plan.rootCause}</p>
        </div>
        <div className="approval-section">
          <label>Recommended action</label>
          <p style={{ margin: 0 }}>
            <strong>{plan.action.replace(/_/g, ' ')}</strong> — {plan.reasoning}
          </p>
        </div>
        {approval.humanSuggestion && (
          <div className="approval-section">
            <label>Your suggestion</label>
            <p style={{ margin: 0 }}>{approval.humanSuggestion}</p>
          </div>
        )}
        <div className="approval-section">
          <label>Proposed patch ({plan.targetManifestPath})</label>
          <pre className="patch-block">{patchText}</pre>
        </div>
      </div>

      {isPending && (
        <>
          <div className="approval-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => act(() => approveIncident(incidentId), 'Approved — remediation started')}
            >
              Approve
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={busy}
              onClick={() =>
                act(() => rejectIncident(incidentId), 'Rejected — no remediation')
              }
            >
              Reject
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                act(
                  () => ignoreIncident(incidentId),
                  'Ignored — future alerts suppressed for this resource'
                )
              }
            >
              Ignore
            </button>
          </div>
          <div style={{ padding: '0 1.25rem 1.25rem' }}>
            <label style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
              Suggest your own fix
            </label>
            <div className="suggest-row">
              <input
                placeholder="e.g. restart, set image to app:v2"
                value={suggestion}
                onChange={(e) => setSuggestion(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || !suggestion.trim()}
                onClick={() =>
                  act(
                    () => suggestFix(incidentId, suggestion.trim(), false),
                    'Plan updated from suggestion'
                  )
                }
              >
                Update plan
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy || !suggestion.trim()}
                onClick={() =>
                  act(
                    () => suggestFix(incidentId, suggestion.trim(), true),
                    'Applying your suggestion'
                  )
                }
              >
                Apply now
              </button>
            </div>
          </div>
        </>
      )}
    </article>
  );
}
