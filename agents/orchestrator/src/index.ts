import express, { type Request, type Response } from 'express';
import type { ResumeRunRequest, StartRunRequest } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { startRun, resumeRunAfterApproval } from './graph.js';
import { listToolDefinitions } from '../../../shared/src/tool-registry.js';
import { getRun, listRuns, resolveRun, setRunStatus, findActiveRunByResourceKey, mergeRunMetadata, countActiveRunsByNamespace } from './run-store.js';
import {
  enrichStoredRun,
  groupRunsByResource,
  formatSkillMarkdown,
} from '../../../shared/src/remediation-outcome.js';
import { formatRunSummaryForUser } from '../../../shared/src/run-summary.js';
import { toolCallNames } from '../../../shared/src/run-persistence.js';
import { createRunStore, closeRunStore } from './stores/index.js';
import { findActiveDuplicateRun } from './run-dedupe.js';
import { reconcileStaleActiveRun, sweepStaleRunningRuns } from './stale-run-reconcile.js';
import { persistCiVerifyOutcome } from './persist-outcome.js';
import { createInternalAuthMiddleware } from '../../../shared/src/internal-auth.js';
import {
  namespaceRunLimitExceeded,
  resolveNamespaceRunLimit,
} from '../../../shared/src/namespace-run-limit.js';
import { drainThrottledRuns, enqueueThrottledRun, startThrottledQueueDrainer } from './throttled-queue.js';

const AGENT = 'orchestrator-agent';
const PORT = parseInt(process.env['PORT'] ?? '8080', 10);
const STALE_RUN_SWEEP_MS = parseInt(process.env['STALE_RUN_SWEEP_MS'] ?? String(15 * 60 * 1000), 10);

async function cancelRunRecord(runId: string, reason: string): Promise<void> {
  await setRunStatus(runId, 'cancelled');
  await mergeRunMetadata(runId, {
    staleCancelled: true,
    staleCancelReason: reason,
    staleCancelledAt: new Date().toISOString(),
  }).catch(() => undefined);
}

function runListItem(enriched: ReturnType<typeof enrichStoredRun>) {
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
    isStale: enriched.isStale,
    suggestedActionLabel: enriched.suggestedActionLabel,
  };
}

async function startStaleRunSweeper(): Promise<void> {
  const sweep = async () => {
    const cancelled = await sweepStaleRunningRuns({
      listRuns,
      cancelRun: cancelRunRecord,
    });
    if (cancelled > 0) {
      log('info', AGENT, 'Stale run sweep completed', { cancelled });
    }
  };
  await sweep().catch((err) => {
    log('warn', AGENT, 'Initial stale run sweep failed', { error: String(err) });
  });
  setInterval(() => {
    void sweep().catch((err) => {
      log('warn', AGENT, 'Stale run sweep failed', { error: String(err) });
    });
  }, STALE_RUN_SWEEP_MS);
}

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(createInternalAuthMiddleware());

async function boot(): Promise<void> {
  await createRunStore();
  log('info', AGENT, 'Run store initialized', {
    backend: process.env['RUN_STORE_BACKEND'] ?? 'auto',
  });
  await startStaleRunSweeper();
  startThrottledQueueDrainer();
  void drainThrottledRuns().catch((err) => {
    log('warn', AGENT, 'Initial throttled queue drain failed', { error: String(err) });
  });
}

app.get('/health', (_req, res) => {
  void import('../../../shared/src/agent-mode.js').then(({ agentModeHealthPayload }) => {
    res.json({ status: 'ok', agent: AGENT, ...agentModeHealthPayload() });
  });
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
  const missing: string[] = [];
  if (!body?.incidentId?.trim()) missing.push('incidentId');
  if (!body?.namespace?.trim()) missing.push('namespace');
  if (!body?.resourceName?.trim()) missing.push('resourceName');
  if (missing.length > 0) {
    res.status(400).json({
      error: 'incidentId, namespace, resourceName required',
      missing,
      hint:
        'Deploy requests need a target namespace and app name. ' +
        'Example: namespace=frappe-operator-system, resourceName=frappe-operator',
    });
    return;
  }

  const nsLimit = resolveNamespaceRunLimit();
  if (nsLimit.enabled) {
    const activeInNs = await countActiveRunsByNamespace(body.namespace);
    if (namespaceRunLimitExceeded(activeInNs, nsLimit)) {
      const runId = await enqueueThrottledRun(body);
      log('warn', AGENT, 'Namespace run limit reached — queued for later', {
        incidentId: body.incidentId,
        namespace: body.namespace,
        resourceName: body.resourceName,
        activeInNs,
        limit: nsLimit.maxActive,
        runId,
      });
      res.status(202).json({
        accepted: true,
        queued: true,
        throttled: true,
        reason: 'namespace_run_limit',
        runId,
        incidentId: body.incidentId,
        namespace: body.namespace,
        activeRuns: activeInNs,
        limit: nsLimit.maxActive,
        hint:
          `Run queued — namespace ${body.namespace} has ${activeInNs}/${nsLimit.maxActive} active runs. ` +
          'It will start automatically when capacity is available.',
      });
      return;
    }
  }

  const dedupeLimit = parseInt(process.env['ORCHESTRATOR_DEDUPE_SCAN_LIMIT'] ?? '200', 10);
  const indexed = await findActiveRunByResourceKey(body);
  const duplicate =
    indexed &&
    (indexed.status === 'running' || indexed.status === 'awaiting_human')
      ? {
          runId: indexed.runId,
          incidentId: indexed.incidentId,
          status: indexed.status,
        }
      : findActiveDuplicateRun(body, await listRuns({ limit: dedupeLimit }));
  if (duplicate) {
    const reconciled = await reconcileStaleActiveRun(
      duplicate,
      getRun,
      async (runId) => {
        await cancelRunRecord(runId, 'dedupe_reconcile');
      }
    );
    if (reconciled !== 'cancelled_stale') {
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
  }

  res.status(202).json({ accepted: true, incidentId: body.incidentId });

  startRun(body)
    .then(({ runId, status, lastError }) => {
      log('info', AGENT, 'Run finished', { runId, status, incidentId: body.incidentId, lastError });
      return drainThrottledRuns();
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
        const { humanizeOperatorError } = await import('../../../shared/src/user-errors.js');
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
    runs: runs.map((r) => runListItem(enrichStoredRun(r))),
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
  const entry = await resolveRun(req.params.runId ?? '');
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
  const rawId = req.params.runId ?? '';
  const entry = await resolveRun(rawId);
  if (!entry) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  await cancelRunRecord(entry.runId, (req.body as { reason?: string })?.reason ?? 'manual');
  log('info', AGENT, 'Run cancelled', {
    runId: entry.runId,
    incidentId: entry.incidentId,
    reason: (req.body as { reason?: string })?.reason,
  });
  res.json({ ok: true, runId: entry.runId, status: 'cancelled' });
});

app.get('/runs/:runId', async (req: Request, res: Response) => {
  const entry = await resolveRun(req.params.runId ?? '');
  if (!entry) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  const enriched = enrichStoredRun(entry);
  res.json({
    runId: entry.runId,
    resolvedFrom: entry.runId !== req.params.runId ? req.params.runId : undefined,
    incidentId: entry.incidentId,
    status: entry.status,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    confidence: entry.compiled?.confidence,
    riskLevel: entry.compiled?.riskLevel,
    tools: toolCallNames(entry.compiled?.calls),
    capabilityToolCalls: toolCallNames(entry.capabilityToolCalls),
    resumeFromToolIndex: entry.resumeFromToolIndex,
    pendingToolApproval: entry.pendingToolApproval,
    transcript: entry.transcript,
    outcome: enriched.outcome,
    isStale: enriched.isStale,
    suggestedActionLabel: enriched.suggestedActionLabel,
    remediationPlan: entry.metadata?.remediationPlan,
  });
});

app.post('/runs/:runId/ci-verify', async (req: Request, res: Response) => {
  const runId = req.params.runId ?? '';
  const body = req.body as { worked?: boolean; message?: string };
  if (typeof body.worked !== 'boolean') {
    res.status(400).json({ error: 'worked (boolean) required' });
    return;
  }
  const entry = await getRun(runId);
  if (!entry) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  await persistCiVerifyOutcome(runId, body.worked, body.message);
  res.json({ ok: true, runId, worked: body.worked });
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
