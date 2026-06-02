import express, { type Request, type Response } from 'express';
import type { ResumeRunRequest, StartRunRequest } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { startRun, resumeRunAfterApproval } from './graph.js';
import { listToolDefinitions } from '../../../shared/src/tool-registry.js';
import { getRun, listRuns, setRunStatus } from './run-store.js';
import {
  enrichStoredRun,
  groupRunsByResource,
  deriveOutcomeFromStoredRun,
  formatSkillMarkdown,
} from '../../../shared/src/remediation-outcome.js';
import { formatRunSummaryForUser } from '../../../shared/src/run-summary.js';
import { createRunStore, closeRunStore } from './stores/index.js';
import { findActiveDuplicateRun } from './run-dedupe.js';

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

  const dedupeLimit = parseInt(process.env['ORCHESTRATOR_DEDUPE_SCAN_LIMIT'] ?? '200', 10);
  const recent = await listRuns({ limit: dedupeLimit });
  const duplicate = findActiveDuplicateRun(body, recent);
  if (duplicate) {
    log('info', AGENT, 'Skipped duplicate run request', {
      incidentId: body.incidentId,
      existingIncidentId: duplicate.incidentId,
      existingRunId: duplicate.runId,
      mode: body.mode,
      namespace: body.namespace,
      resourceName: body.resourceName,
      githubRepo: body.githubRepo,
      status: duplicate.status,
    });
    res.status(202).json({
      accepted: false,
      deduplicated: true,
      incidentId: body.incidentId,
      existingIncidentId: duplicate.incidentId,
      existingRunId: duplicate.runId,
      existingStatus: duplicate.status,
    });
    return;
  }

  res.status(202).json({ accepted: true, incidentId: body.incidentId });

  startRun(body)
    .then(({ runId, status, lastError }) => {
      log('info', AGENT, 'Run finished', { runId, status, incidentId: body.incidentId, lastError });
    })
    .catch(async (err) => {
      const error = err instanceof Error ? err.message : String(err);
      const cause =
        err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
      log('error', AGENT, 'Run failed', {
        incidentId: body.incidentId,
        error,
        cause,
        hint: error.includes('investigator-agent')
          ? 'Ensure investigator-agent is running and healthy (docker compose ps)'
          : undefined,
      });
      if (body.platform && body.channelId) {
        const { notifyUser, buildRuntimeContext } = await import('./tools.js');
        const { humanizeOperatorError } = await import('../../../shared/src/user-outcomes.js');
        const ctx = buildRuntimeContext({
          runId: body.incidentId,
          incidentId: body.incidentId,
          request: body,
          namespace: body.namespace,
          resourceName: body.resourceName,
          resourceKind: body.resourceKind,
          mode: body.mode,
        });
        const message = error.includes('GRAPH_RECURSION_LIMIT')
          ? `❌ Run stopped: the orchestrator looped too many times (verify/deploy may not have become healthy). ` +
            `Check namespace \`${body.namespace}\` and deployment \`${body.resourceName}\`.`
          : `❌ Run failed:\n${humanizeOperatorError(cause ?? error)}`;
        await notifyUser(ctx, message).catch(() => undefined);
      }
    });
});

app.get('/runs', async (req: Request, res: Response) => {
  const incidentId = req.query.incidentId as string | undefined;
  const limit = parseInt((req.query.limit as string) ?? '50', 10);
  const runs = await listRuns({ incidentId, limit });
  res.json({
    runs: runs.map((r) => {
      const enriched = enrichStoredRun(r);
      return {
        runId: enriched.runId,
        incidentId: enriched.incidentId,
        status: enriched.status,
        startedAt: enriched.startedAt,
        updatedAt: enriched.updatedAt,
        toolCount: enriched.toolCount,
        mode: enriched.mode,
        namespace: enriched.namespace,
        resourceName: enriched.resourceName,
        githubRepo: enriched.githubRepo,
        resourceKey: enriched.resourceKey,
        displayName: enriched.displayName,
        outcome: enriched.outcome,
      };
    }),
  });
});

app.get('/runs/by-resource', async (req: Request, res: Response) => {
  const limit = parseInt((req.query.limit as string) ?? '150', 10);
  const runs = await listRuns({ limit });
  const groups = groupRunsByResource(runs.map(enrichStoredRun));
  res.json({ groups });
});

app.get('/runs/skills-export', async (req: Request, res: Response) => {
  const limit = parseInt((req.query.limit as string) ?? '150', 10);
  const runs = await listRuns({ limit });
  const groups = groupRunsByResource(runs.map(enrichStoredRun));
  const parts: string[] = [
    '# SRE Bot — Remediation skills (auto-compiled)',
    '',
    '_Generated from orchestrator run outcomes. Drop into skills/ for brain context._',
    '',
  ];
  let count = 0;
  for (const group of groups) {
    parts.push(`## ${group.displayName}`, '');
    for (const run of group.runs) {
      if (!run.outcome) continue;
      parts.push(formatSkillMarkdown(run, group.displayName));
      count += 1;
    }
  }
  res.json({ markdown: parts.join('\n'), count });
});

app.get('/runs/:runId/summary', async (req: Request, res: Response) => {
  const entry = await getRun(req.params.runId ?? '');
  if (!entry) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  const verbose = req.query.verbose === 'true';
  res.json({
    runId: entry.runId,
    incidentId: entry.incidentId,
    status: entry.status,
    text: formatRunSummaryForUser(entry, { includeLogs: true, maxLogLines: verbose ? 20 : 12 }),
  });
});

app.post('/runs/:runId/cancel', async (req: Request, res: Response) => {
  const runId = req.params.runId ?? '';
  const entry = await getRun(runId);
  if (!entry) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  await setRunStatus(runId, 'cancelled');
  log('info', AGENT, 'Run cancelled', {
    runId,
    incidentId: entry.incidentId,
    reason: (req.body as { reason?: string })?.reason,
  });
  res.json({ ok: true, runId, status: 'cancelled' });
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
    outcome: deriveOutcomeFromStoredRun(entry),
    remediationPlan: entry.metadata?.remediationPlan,
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
  const runId = body.command.runId ?? body.command.incidentId;
  // Respond immediately — remediation (act + verify) can take minutes.
  res.status(202).json({ status: 'accepted', runId });

  resumeRunAfterApproval(body.command).catch((err) => {
    log('error', AGENT, 'resumeRunAfterApproval failed', {
      runId,
      incidentId: body.command!.incidentId,
      error: String(err),
    });
  });
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
