import { useCallback, useEffect, useState } from 'react';
import { cancelCodingJob, fetchCodingJob } from '../api';

export interface CodingJobStep {
  at: string;
  label: string;
  detail?: string;
  kind?: 'info' | 'plan' | 'test' | 'pr' | 'error';
}

export interface CodingJob {
  jobId: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  steps: CodingJobStep[];
  prUrl?: string;
  summary?: string;
  error?: string;
  githubRepo: string;
  branch: string;
}

interface Props {
  jobId: string;
  live?: boolean;
}

export function CodingAgentPanel({ jobId, live = true }: Props) {
  const [job, setJob] = useState<CodingJob | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetchCodingJob(jobId)
      .then((raw) => setJob(raw as unknown as CodingJob))
      .catch(() => setJob(null));
  }, [jobId]);

  useEffect(() => {
    load();
    if (!live) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [live, load]);

  async function handleCancel() {
    if (!window.confirm('Cancel the coding agent job?')) return;
    setBusy(true);
    try {
      await cancelCodingJob(jobId);
      load();
    } finally {
      setBusy(false);
    }
  }

  if (!job) {
    return (
      <p style={{ color: 'var(--text-muted)', margin: 0 }}>Loading code fixer job…</p>
    );
  }

  const terminal = job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled';
  const canCancel = !terminal && (job.status === 'running' || job.status === 'queued');

  return (
    <div className="coding-agent-panel">
      <div className="coding-agent-header">
        <div>
          <span className={`coding-status coding-status-${job.status}`}>{job.status}</span>
          <span style={{ marginLeft: 10, color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
            {job.githubRepo} @ {job.branch}
          </span>
        </div>
        <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
          Attempt {job.attempt}/{job.maxAttempts}
        </div>
        {canCancel && (
          <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={handleCancel}>
            Cancel fixer
          </button>
        )}
      </div>

      {job.prUrl && (
        <p style={{ margin: '0.75rem 0 0' }}>
          <a href={job.prUrl} target="_blank" rel="noreferrer">
            View pull request
          </a>
        </p>
      )}

      {job.summary && (
        <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', margin: '0.5rem 0 0' }}>
          {job.summary}
        </p>
      )}

      {job.error && job.status === 'failed' && (
        <p style={{ fontSize: '0.8125rem', color: '#fca5a5', margin: '0.5rem 0 0' }}>
          {job.error.slice(0, 500)}
        </p>
      )}

      <ul className="coding-steps">
        {job.steps.length === 0 ? (
          <li className="coding-step muted">Waiting for first step…</li>
        ) : (
          job.steps.map((step, i) => (
            <li key={`${step.at}-${i}`} className={`coding-step coding-step-${step.kind ?? 'info'}`}>
              <span className="coding-step-label">{step.label}</span>
              {step.detail && (
                <pre className="coding-step-detail">{step.detail.slice(0, 600)}</pre>
              )}
              <span className="coding-step-time">
                {new Date(step.at).toLocaleTimeString()}
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
