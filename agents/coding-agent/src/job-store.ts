/**
 * In-memory coding job store (CI-2). Console polls GET /jobs/:id.
 */

export type CodingJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface CodingJobStep {
  at: string;
  label: string;
  detail?: string;
  kind?: 'info' | 'plan' | 'test' | 'pr' | 'error';
}

export interface CodingJob {
  jobId: string;
  incidentId: string;
  runId?: string;
  githubRepo: string;
  branch: string;
  status: CodingJobStatus;
  attempt: number;
  maxAttempts: number;
  steps: CodingJobStep[];
  prUrl?: string;
  summary?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  cancelled?: boolean;
}

const jobs = new Map<string, CodingJob>();

export function createJob(input: Omit<CodingJob, 'status' | 'attempt' | 'steps' | 'createdAt' | 'updatedAt'>): CodingJob {
  const now = new Date().toISOString();
  const job: CodingJob = {
    ...input,
    status: 'queued',
    attempt: 0,
    steps: [],
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.jobId, job);
  return job;
}

export function getJob(jobId: string): CodingJob | undefined {
  return jobs.get(jobId);
}

export function listJobs(limit = 50): CodingJob[] {
  return [...jobs.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

export function appendStep(jobId: string, step: Omit<CodingJobStep, 'at'>): CodingJob | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  job.steps.push({ ...step, at: new Date().toISOString() });
  job.updatedAt = new Date().toISOString();
  return job;
}

export function patchJob(jobId: string, patch: Partial<CodingJob>): CodingJob | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  return job;
}

export function cancelJob(jobId: string): CodingJob | undefined {
  const job = jobs.get(jobId);
  if (!job || job.status === 'succeeded' || job.status === 'failed') return job;
  job.status = 'cancelled';
  job.cancelled = true;
  job.updatedAt = new Date().toISOString();
  return job;
}
