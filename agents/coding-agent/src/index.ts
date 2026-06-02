/**
 * coding-agent — multi-attempt application-code CI fixes (CI-2).
 *
 * Endpoints:
 *   GET  /health
 *   POST /run-fix       → start async fix job (202 + jobId)
 *   GET  /jobs            → list recent jobs
 *   GET  /jobs/:id        → job status + step timeline
 *   POST /jobs/:id/cancel → cancel in-flight job
 */

import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { CiRunFacts } from '../../../shared/src/ci-types.js';
import type { Platform } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { runFixLoop } from './fix-loop.js';
import { cancelJob, createJob, getJob, listJobs } from './job-store.js';

const AGENT = 'coding-agent';
const PORT = parseInt(process.env['PORT'] ?? '8080', 10);
const ENABLED = (process.env['CODING_AGENT_ENABLED'] ?? 'true').toLowerCase() === 'true';

const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', agent: AGENT, enabled: ENABLED });
});

app.get('/jobs', (_req: Request, res: Response) => {
  const limit = parseInt(String(_req.query.limit ?? '50'), 10);
  res.json({ jobs: listJobs(limit) });
});

app.get('/jobs/:jobId', (req: Request, res: Response) => {
  const job = getJob(String(req.params.jobId ?? ''));
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json(job);
});

app.post('/jobs/:jobId/cancel', (req: Request, res: Response) => {
  const job = cancelJob(String(req.params.jobId ?? ''));
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json(job);
});

app.post('/run-fix', async (req: Request, res: Response) => {
  if (!ENABLED) {
    res.status(503).json({ error: 'Coding agent disabled (CODING_AGENT_ENABLED=false)' });
    return;
  }

  const body = req.body as {
    jobId?: string;
    incidentId?: string;
    runId?: string;
    ciRun?: CiRunFacts;
    platform?: Platform;
    channelId?: string;
    maxAttempts?: number;
  };

  if (!body.incidentId || !body.ciRun?.githubRepo || !body.ciRun.branch) {
    res.status(400).json({ error: 'incidentId and ciRun (githubRepo, branch) required' });
    return;
  }

  const jobId = body.jobId ?? randomUUID();
  const maxAttempts =
    body.maxAttempts ??
    parseInt(process.env['CODING_AGENT_MAX_ITERATIONS'] ?? process.env['CODING_AGENT_MAX_ATTEMPTS'] ?? '5', 10);

  createJob({
    jobId,
    incidentId: body.incidentId,
    runId: body.runId,
    githubRepo: body.ciRun.githubRepo,
    branch: body.ciRun.branch,
    maxAttempts,
  });

  res.status(202).json({ accepted: true, jobId });

  runFixLoop({
    jobId,
    incidentId: body.incidentId,
    runId: body.runId,
    ciRun: body.ciRun,
    platform: body.platform,
    channelId: body.channelId,
    maxAttempts,
  }).catch((err: unknown) => {
    log('error', AGENT, 'runFixLoop failed', {
      jobId,
      incidentId: body.incidentId,
      error: String(err),
    });
  });
});

app.listen(PORT, () => {
  log('info', AGENT, 'coding-agent listening', { port: PORT, enabled: ENABLED });
});
