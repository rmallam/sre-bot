/**
 * cicd-agent — CI/CD triage and remediation (GitHub Actions first).
 *
 * Endpoints:
 *   GET  /health
 *   GET  /workflows?repo=
 *   GET  /fetch-run?repo=&runId= | &branch= | &workflowName=
 *   POST /diagnose
 *   POST /rerun
 *   POST /open-pr
 *   POST /open-code-pr
 *   GET  /repo-context?repo=&branch=
 */

import express, { type Request, type Response } from 'express';
import { formatCiReport } from '../../../shared/src/ci-diagnose.js';
import { log } from '../../../shared/src/http.js';
import {
  fetchLatestFailedRun,
  fetchRunById,
  githubConfigured,
  listWorkflows,
  openCiFixPr,
  openCiCodeFixPr,
  rerunWorkflow,
} from './github.js';
import { gatherCiRepoContext } from './repo-context.js';

const AGENT = 'cicd-agent';
const PORT = parseInt(process.env['PORT'] ?? '8080', 10);

const app = express();
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', agent: AGENT, githubConfigured: githubConfigured() });
});

app.get('/workflows', async (req: Request, res: Response) => {
  const repo = String(req.query.repo ?? '');
  if (!repo) {
    res.status(400).json({ error: 'repo query param required' });
    return;
  }
  try {
    const workflows = await listWorkflows(repo);
    res.json({ workflows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/fetch-run', async (req: Request, res: Response) => {
  const repo = String(req.query.repo ?? '');
  const runId = req.query.runId ? parseInt(String(req.query.runId), 10) : undefined;
  const branch = req.query.branch ? String(req.query.branch) : undefined;
  const workflowName = req.query.workflowName ? String(req.query.workflowName) : undefined;

  if (!repo) {
    res.status(400).json({ error: 'repo required' });
    return;
  }

  try {
    const facts = runId
      ? await fetchRunById(repo, runId)
      : await fetchLatestFailedRun(repo, { branch, workflowName });
    if (!facts) {
      res.status(404).json({ error: 'No failed workflow run found' });
      return;
    }
    res.json(facts);
  } catch (err) {
    log('error', AGENT, 'fetch-run failed', { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

app.post('/diagnose', async (req: Request, res: Response) => {
  const { repo, runId, branch, workflowName } = req.body as {
    repo?: string;
    runId?: number;
    branch?: string;
    workflowName?: string;
  };
  if (!repo) {
    res.status(400).json({ error: 'repo required' });
    return;
  }
  try {
    const facts = runId
      ? await fetchRunById(repo, runId)
      : await fetchLatestFailedRun(repo, { branch, workflowName });
    if (!facts) {
      res.status(404).json({ error: 'No failed workflow run found' });
      return;
    }
    res.json({ facts, report: formatCiReport(facts) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/rerun', async (req: Request, res: Response) => {
  const { repo, runId, incidentId } = req.body as {
    repo?: string;
    runId?: number;
    incidentId?: string;
  };
  if (!repo || !runId) {
    res.status(400).json({ error: 'repo and runId required' });
    return;
  }
  try {
    const result = await rerunWorkflow(repo, runId);
    log('info', AGENT, 'rerun ok', { incidentId, runId });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/open-pr', async (req: Request, res: Response) => {
  const { repo, branch, title, body, incidentId, workflowFilePath, workflowName, logExcerpt } =
    req.body as {
      repo?: string;
      branch?: string;
      title?: string;
      body?: string;
      incidentId?: string;
      workflowFilePath?: string;
      workflowName?: string;
      logExcerpt?: string;
    };
  if (!repo || !title) {
    res.status(400).json({ error: 'repo and title required' });
    return;
  }
  try {
    const result = await openCiFixPr({
      githubRepo: repo,
      branch: branch ?? 'main',
      title,
      body: body ?? '',
      incidentId: incidentId ?? 'N/A',
      workflowFilePath,
      workflowName,
      logExcerpt,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/repo-context', async (req: Request, res: Response) => {
  const repo = String(req.query.repo ?? '');
  const branch = String(req.query.branch ?? 'main');
  const workflowName = req.query.workflowName ? String(req.query.workflowName) : undefined;
  if (!repo) {
    res.status(400).json({ error: 'repo required' });
    return;
  }
  try {
    const ctx = await gatherCiRepoContext(repo, branch, workflowName);
    res.json(ctx);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/open-code-pr', async (req: Request, res: Response) => {
  const { repo, branch, title, body, incidentId, patches } = req.body as {
    repo?: string;
    branch?: string;
    title?: string;
    body?: string;
    incidentId?: string;
    patches?: Array<{ path: string; content: string }>;
  };
  if (!repo || !title || !patches?.length) {
    res.status(400).json({ error: 'repo, title, patches required' });
    return;
  }
  try {
    const result = await openCiCodeFixPr({
      githubRepo: repo,
      branch: branch ?? 'main',
      title,
      body: body ?? '',
      incidentId: incidentId ?? 'N/A',
      patches,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  log('info', AGENT, 'cicd-agent listening', {
    port: PORT,
    githubConfigured: githubConfigured(),
  });
});
