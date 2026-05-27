import express, { type Request, type Response } from 'express';
import type { ResumeRunRequest, StartRunRequest } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { startRun, resumeRunAfterApproval } from './graph.js';
import { listToolDefinitions } from '../../../shared/src/tool-registry.js';
import { getRun, listRuns } from './run-store.js';
import { createRunStore, closeRunStore } from './stores/index.js';

const AGENT = 'orchestrator-agent';
const PORT = parseInt(process.env['PORT'] ?? '8080', 10);

const app = express();
app.use(express.json({ limit: '4mb' }));

async function boot(): Promise<void> {
  await createRunStore();
  log('info', AGENT, 'Run store initialized', {
    backend: process.env['RUN_STORE_BACKEND'] ?? 'auto',
  });
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agent: AGENT });
});

app.get('/tools', (_req, res) => {
  res.json({
    tools: listToolDefinitions().map((t) => ({
      name: t.name,
      description: t.description,
      risk: t.risk,
      requiresHilInProd: t.requiresHilInProd,
      supportsDryRun: t.supportsDryRun,
      idempotent: t.idempotent,
      maxRetries: t.maxRetries,
      requiredFields: t.requiredFields,
      allowedModes: t.allowedModes,
    })),
  });
});

app.post('/runs', async (req: Request, res: Response) => {
  const body = req.body as StartRunRequest;
  if (!body?.incidentId || !body.namespace || !body.resourceName) {
    res.status(400).json({ error: 'incidentId, namespace, resourceName required' });
    return;
  }

  res.status(202).json({ accepted: true, incidentId: body.incidentId });

  startRun(body)
    .then(({ runId, status }) => {
      log('info', AGENT, 'Run finished', { runId, status, incidentId: body.incidentId });
    })
    .catch((err) => {
      log('error', AGENT, 'Run failed', { incidentId: body.incidentId, error: String(err) });
    });
});

app.get('/runs', async (req: Request, res: Response) => {
  const incidentId = req.query.incidentId as string | undefined;
  const limit = parseInt((req.query.limit as string) ?? '50', 10);
  const runs = await listRuns({ incidentId, limit });
  res.json({
    runs: runs.map((r) => ({
      runId: r.runId,
      incidentId: r.incidentId,
      status: r.status,
      startedAt: r.startedAt,
      updatedAt: r.updatedAt,
      toolCount: r.transcript.length,
    })),
  });
});

app.get('/runs/:runId', async (req: Request, res: Response) => {
  const entry = await getRun(req.params.runId ?? '');
  if (!entry) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  res.json({
    runId: entry.runId,
    incidentId: entry.incidentId,
    status: entry.status,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    confidence: entry.compiled?.confidence,
    riskLevel: entry.compiled?.riskLevel,
    tools: entry.compiled?.calls.map((c) => c.name),
    capabilityToolCalls: entry.capabilityToolCalls?.map((c) => c.name),
    resumeFromToolIndex: entry.resumeFromToolIndex,
    pendingToolApproval: entry.pendingToolApproval,
    transcript: entry.transcript,
  });
});

app.post('/resume-run', async (req: Request, res: Response) => {
  const body = req.body as ResumeRunRequest & {
    command?: import('../../../shared/src/types.js').RemediateCommand;
  };
  if (!body.approved || !body.command) {
    res.status(400).json({ error: 'approved command required' });
    return;
  }
  const status = await resumeRunAfterApproval(body.command);
  res.json({ status });
});

boot()
  .then(() => {
    app.listen(PORT, () => {
      log('info', AGENT, 'orchestrator-agent listening', {
        port: PORT,
        autonomyMode: process.env['AUTONOMY_MODE'] ?? 'low_risk_only',
        runStoreBackend: process.env['RUN_STORE_BACKEND'] ?? 'auto',
        capabilityPlanner: process.env['USE_CAPABILITY_PLANNER'] ?? 'false',
        perToolHil: process.env['PER_TOOL_HIL'] ?? 'false',
      });
    });
  })
  .catch((err) => {
    log('error', AGENT, 'Failed to start', { error: String(err) });
    process.exit(1);
  });

process.on('SIGTERM', () => {
  closeRunStore().catch(() => undefined);
});
