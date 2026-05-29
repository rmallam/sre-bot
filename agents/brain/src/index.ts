/**
 * index.ts — brain-agent Express server
 *
 * Endpoints:
 *   GET  /health    → liveness probe
 *   POST /diagnose  → receives DiagnosisContext (watcher-originated incidents)
 *   POST /plan      → receives DiagnosisContext (commander-originated deploy/rollback)
 *
 * Both /diagnose and /plan funnel into the same runBrain() orchestrator.
 * The IncidentEnvelope.mode field distinguishes the two cases downstream.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import type { DiagnosisContext } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';
import { llmConfigSummary } from '../../../shared/src/llm-config.js';
import { runBrain } from './brain.js';

const AGENT = 'brain-agent';
const PORT = parseInt(process.env['PORT'] ?? '8080', 10);

const app = express();
app.use(express.json({ limit: '4mb' }));

// ── Structured request logging middleware ────────────────────────────────────

app.use((req: Request, _res: Response, next: NextFunction) => {
  log('info', AGENT, `${req.method} ${req.path}`, {
    method: req.method,
    path: req.path,
    contentLength: req.headers['content-length'] ?? 0,
  });
  next();
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  const llm = llmConfigSummary();
  res.json({
    status: 'ok',
    agent: AGENT,
    llm: {
      provider: llm.provider,
      brain: llm.brain
        ? { backend: llm.brain.backend, model: llm.brain.model }
        : null,
    },
  });
});

// ── Handler factory ───────────────────────────────────────────────────────────

/**
 * Common handler for both /diagnose and /plan.
 * Validates the body is a DiagnosisContext, then delegates to runBrain().
 * Returns 202 Accepted immediately; runBrain posts its own results to HIL.
 */
async function handleDiagnosisRequest(req: Request, res: Response): Promise<void> {
  const body = req.body as Partial<DiagnosisContext>;

  // Minimal envelope validation
  if (
    !body.incidentId ||
    !body.namespace ||
    !body.resourceName ||
    !body.resourceKind ||
    !body.mode
  ) {
    log('warn', AGENT, 'Received malformed DiagnosisContext — missing required fields', {
      incidentId: body.incidentId ?? 'unknown',
      missingFields: (['incidentId', 'namespace', 'resourceName', 'resourceKind', 'mode'] as const)
        .filter((f) => !body[f])
        .join(', '),
    });
    res.status(400).json({
      error: 'Missing required fields: incidentId, namespace, resourceName, resourceKind, mode',
    });
    return;
  }

  // Respond immediately so the caller doesn't wait for Gemini (~seconds)
  res.status(202).json({ accepted: true, incidentId: body.incidentId });

  // Run asynchronously — errors are logged but do not crash the server
  runBrain(body as DiagnosisContext).catch((err: unknown) => {
    log('error', AGENT, 'runBrain threw an unhandled error', {
      incidentId: body.incidentId ?? 'unknown',
      error: String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.post('/diagnose', (req: Request, res: Response) => {
  handleDiagnosisRequest(req, res).catch((err: unknown) => {
    log('error', AGENT, 'Unexpected error in /diagnose handler', {
      error: String(err),
    });
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });
});

app.post('/plan', (req: Request, res: Response) => {
  handleDiagnosisRequest(req, res).catch((err: unknown) => {
    log('error', AGENT, 'Unexpected error in /plan handler', {
      error: String(err),
    });
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });
});

/** Capability-first plan — tool pipeline + derived remediation plan. */
app.post('/plan-capability', async (req: Request, res: Response) => {
  const body = req.body as Partial<import('../../../shared/src/types.js').DiagnosisContext>;
  if (!body.incidentId || !body.namespace || !body.resourceName) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }
  try {
    const { planCapability } = await import('./capability-planner.js');
    const result = await planCapability(body as import('../../../shared/src/types.js').DiagnosisContext);
    res.json(result);
  } catch (err) {
    log('error', AGENT, 'plan-capability failed', { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

/** Failure analyst for orchestrator — structured retry vs escalate after act failure. */
app.post('/analyze-failure', async (req: Request, res: Response) => {
  const body = req.body as Partial<import('../../../shared/src/types.js').FailureAnalysisRequest>;
  if (
    !body.incidentId ||
    !body.mode ||
    !body.namespace ||
    !body.resourceName ||
    !body.failedAction ||
    !body.errorMessage ||
    !body.facts
  ) {
    res.status(400).json({
      error:
        'Missing required fields: incidentId, mode, namespace, resourceName, failedAction, errorMessage, facts',
    });
    return;
  }
  try {
    const { analyzeFailure } = await import('./failure-analyst.js');
    const result = await analyzeFailure(body as import('../../../shared/src/types.js').FailureAnalysisRequest);
    res.json(result);
  } catch (err) {
    log('error', AGENT, 'analyze-failure failed', { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

/** Operator override: natural-language fix → RemediationPlan. */
app.post('/suggest-plan', async (req: Request, res: Response) => {
  const body = req.body as {
    suggestion?: string;
    approval?: {
      incidentId: string;
      namespace: string;
      resourceKind: string;
      resourceName: string;
      mode: string;
      plan: import('../../../shared/src/types.js').RemediationPlan;
    };
    facts?: Record<string, unknown>;
  };
  if (!body?.suggestion?.trim() || !body?.approval?.incidentId) {
    res.status(400).json({ error: 'suggestion and approval.incidentId required' });
    return;
  }
  try {
    const { planFromSuggestion } = await import('./suggest-plan.js');
    const result = await planFromSuggestion({
      suggestion: body.suggestion.trim(),
      approval: body.approval as import('./suggest-plan.js').SuggestPlanRequest['approval'],
      facts: body.facts as import('../../../shared/src/types.js').DiagnosisContext | undefined,
    });
    res.json(result);
  } catch (err) {
    log('error', AGENT, 'suggest-plan failed', { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

/** Synchronous plan for orchestrator — no HIL dispatch. */
app.post('/plan-only', async (req: Request, res: Response) => {
  const body = req.body as Partial<DiagnosisContext>;
  if (!body.incidentId || !body.namespace || !body.resourceName) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }
  try {
    const { diagnose } = await import('./gemini.js');
    const plan = await diagnose(body as DiagnosisContext);
    res.json(plan);
  } catch (err) {
    log('error', AGENT, 'plan-only failed', { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

/** Pre-flight safety validation before authorize/act. */
app.post('/validate-plan', async (req: Request, res: Response) => {
  const body = req.body as Partial<import('../../../shared/src/types.js').PlanValidationRequest>;
  if (!body.incidentId || !body.namespace || !body.mode || !body.resourceName || !body.resourceKind || !body.plan) {
    res.status(400).json({
      error: 'Missing required fields: incidentId, namespace, mode, resourceKind, resourceName, plan',
    });
    return;
  }
  try {
    const { validatePlanPreflight } = await import('./plan-validator.js');
    const result = await validatePlanPreflight(
      body as import('../../../shared/src/types.js').PlanValidationRequest
    );
    res.json(result);
  } catch (err) {
    log('error', AGENT, 'validate-plan failed', { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// ── 404 catch-all ─────────────────────────────────────────────────────────────

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `No route: ${req.method} ${req.path}` });
});

// ── Global error handler ──────────────────────────────────────────────────────

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log('error', AGENT, 'Unhandled Express error', {
    error: String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  log('info', AGENT, `brain-agent listening`, {
    port: PORT,
    hilUrl: process.env['HIL_URL'] ?? 'http://hil-agent:8080',
    llm: llmConfigSummary(),
    circuitBreakerLimit: process.env['CIRCUIT_BREAKER_LIMIT'] ?? '3',
  });
});
