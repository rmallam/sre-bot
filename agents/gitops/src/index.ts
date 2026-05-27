/**
 * index.ts — Express entry point for the gitops-agent.
 *
 * Endpoints:
 *   GET  /health      → liveness probe
 *   POST /remediate   → receives RemediateCommand, triggers remediation flow
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import { log } from '../../../shared/src/http.js';
import type { RemediateCommand } from '../../../shared/src/types.js';
import { RepoMirror } from './repo-mirror.js';
import { setRepoMirror, handleRemediate } from './remediator.js';
import { handleArgoWaitSync, handleArgoRolloutPromote } from './argo-tools.js';

const AGENT = 'gitops-agent';
const PORT = parseInt(process.env['PORT'] ?? '8080', 10);

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log('info', AGENT, 'Initialising gitops-agent');

  // Initialise persistent repo mirror (clone once, pull before each mutation)
  const mirror = new RepoMirror();
  try {
    await mirror.init();
  } catch (err: unknown) {
    log('error', AGENT, 'RepoMirror init failed — agent will start but /remediate will error', {
      error: String(err),
    });
  }
  setRepoMirror(mirror);

  // ── Express app ────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // ── Health probe ───────────────────────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', agent: AGENT });
  });

  // ── POST /remediate ────────────────────────────────────────────────────────
  app.post('/remediate', (req: Request, res: Response) => {
    const cmd = req.body as RemediateCommand;

    if (!cmd?.incidentId) {
      log('warn', AGENT, 'POST /remediate — missing incidentId in request body');
      res.status(400).json({ error: 'incidentId is required' });
      return;
    }

    if (!cmd?.plan) {
      res.status(400).json({ error: 'plan is required' });
      return;
    }

    const action = cmd.plan.action ?? 'git_patch';
    if (action === 'restart') {
      res.status(400).json({ error: 'restart actions use executor-agent' });
      return;
    }

    if (action !== 'helm_deploy' && !cmd.plan.targetManifestPath) {
      res.status(400).json({ error: 'plan.targetManifestPath required' });
      return;
    }

    log('info', AGENT, 'POST /remediate received', {
      incidentId: cmd.incidentId,
      action,
      resourceName: cmd.resourceName,
    });

    handleRemediate(cmd)
      .then((result) => {
        if (!res.headersSent) {
          res.status(200).json(result);
        }
      })
      .catch((err: unknown) => {
        log('error', AGENT, 'handleRemediate failed', { incidentId: cmd.incidentId, error: String(err) });
        if (!res.headersSent) {
          res.status(500).json({ error: String(err) });
        }
      });
    return;
  });

  app.post('/argo/wait-sync', async (req: Request, res: Response) => {
    const body = req.body as { appName?: string; timeoutMs?: number; incidentId?: string };
    if (!body?.appName) {
      res.status(400).json({ error: 'appName is required' });
      return;
    }
    try {
      const result = await handleArgoWaitSync({
        appName: body.appName,
        timeoutMs: body.timeoutMs,
        incidentId: body.incidentId,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/argo/rollout-promote', async (req: Request, res: Response) => {
    const body = req.body as { namespace?: string; rolloutName?: string; incidentId?: string };
    if (!body?.namespace || !body?.rolloutName) {
      res.status(400).json({ error: 'namespace and rolloutName are required' });
      return;
    }
    try {
      const result = await handleArgoRolloutPromote({
        namespace: body.namespace,
        rolloutName: body.rolloutName,
        incidentId: body.incidentId,
      });
      res.status(result.success ? 200 : 502).json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Global error handler ───────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log('error', AGENT, 'Unhandled Express error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'internal server error' });
  });

  // ── Start listening ────────────────────────────────────────────────────────
  app.listen(PORT, () => {
    log('info', AGENT, `gitops-agent listening`, { port: PORT });
  });
}

main().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      level: 'error',
      agent: AGENT,
      msg: 'Fatal startup error',
      error: String(err),
      timestamp: new Date().toISOString(),
    }),
  );
  process.exit(1);
});
