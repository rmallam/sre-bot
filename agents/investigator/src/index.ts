/**
 * investigator-agent — src/index.ts
 *
 * Express HTTP server exposing:
 *   GET  /health       — liveness probe
 *   POST /analyze      — watcher-triggered anomaly investigation
 *   POST /pre-deploy   — commander-triggered pre-deploy checks
 *   POST /investigate  — manual investigation request from commander
 *
 * After collecting facts the agent POSTs a DiagnosisContext to brain-agent
 * using the shared postWithRetry utility.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import type {
  AnomalyDetected,
  DeployRequest,
  DiagnosisContext,
  IncidentEnvelope,
} from '../../../shared/src/types.js';
import type { DeployProvenance } from '../../../shared/src/deploy-provenance.js';
import { postWithRetry, log } from '../../../shared/src/http.js';
import { createInternalAuthMiddleware } from '../../../shared/src/internal-auth.js';
import { gatherPodFacts } from './k8s-facts.js';
import { gatherPreDeployFacts, checkNamespaceExists } from './pre-deploy.js';
import { buildFromSource, type BuildFromSourceRequest } from './source-build-runner.js';
import { gatherStackPreDeployFacts } from './stack-predeploy.js';
import {
  ensureMirrorSynced,
  startMirrorSyncScheduler,
  findManifest,
  getMirrorStatus,
} from './git-mirror.js';
import { gatherFactsSync } from './facts-sync.js';
import { verifyDeployment, verifyWithPlaybooks } from './verify.js';
import { discoverReleaseWorkloads } from './release-workloads.js';
import type { DeployWorkloadRef } from '../../../shared/src/deploy-workloads.js';
import { queryLogs, queryMetrics } from './observability.js';
import { clusterGet, type ClusterGetResource } from './cluster-get.js';
import {
  resolveWorkloadCandidates,
  needsUserConfirmation,
  AUTO_CONFIRM_SCORE,
} from './workload-resolve.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const BRAIN_URL = process.env.BRAIN_URL ?? 'http://brain-agent:8080';
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? 'http://orchestrator-agent:8080';
const USE_ORCHESTRATOR = (process.env.USE_ORCHESTRATOR ?? 'true').toLowerCase() === 'true';
const GITOPS_REPO_URL = process.env.GITOPS_REPO_URL ?? '';
const GIT_SYNC_INTERVAL_SECONDS = parseInt(
  process.env.GIT_SYNC_INTERVAL_SECONDS ?? '60',
  10
);
const AGENT = 'investigator';

// ── App setup ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(createInternalAuthMiddleware());

// ── Middleware: structured request logging ─────────────────────────────────────

app.use((req: Request, _res: Response, next: NextFunction) => {
  log('info', AGENT, `${req.method} ${req.path}`, {
    ip: req.ip,
    contentLength: req.headers['content-length'],
  });
  next();
});

// ── GET /health ───────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  const mirror = getMirrorStatus();
  void import('../../../shared/src/agent-mode.js').then(({ agentModeHealthPayload }) => {
    res.json({
      status: 'ok',
      agent: AGENT,
      mirror,
      useOrchestrator: USE_ORCHESTRATOR,
      ...agentModeHealthPayload(),
    });
  });
});

app.post('/alert-correlation/bindings', async (req: Request, res: Response) => {
  const body = req.body as {
    workloads?: Array<{ namespace: string; resourceKind: string; resourceName: string }>;
  };
  const workloads = (body.workloads ?? []).map((w) => ({
    namespace: w.namespace,
    resourceKind: w.resourceKind as import('../../../shared/src/types.js').ResourceKind,
    resourceName: w.resourceName,
  }));
  try {
    const { resolveGraphBindingsForWorkloads } = await import('./alert-graph-bindings.js');
    const bindings = await resolveGraphBindingsForWorkloads(workloads);
    res.json({ bindings: Object.fromEntries(bindings) });
  } catch (err) {
    log('error', AGENT, 'alert-correlation bindings failed', { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

app.post('/agent-step', async (req: Request, res: Response) => {
  const body = req.body as import('./agent-step.js').AgentStepRequest;
  if (!body?.incidentId || !body.namespace || !body.resourceName || !body.toolCall?.name) {
    res.status(400).json({ error: 'incidentId, namespace, resourceName, toolCall.name required' });
    return;
  }
  try {
    const { executeAgentReadTool } = await import('./agent-step.js');
    const result = await executeAgentReadTool(body);
    res.json(result);
  } catch (err) {
    log('error', AGENT, 'agent-step failed', { error: String(err), incidentId: body.incidentId });
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /namespace-check — lightweight exists probe for commander preflight ───

app.get('/namespace-check', async (req: Request, res: Response) => {
  const namespace = String(req.query.namespace ?? '').trim();
  const incidentId = String(req.query.incidentId ?? 'namespace-check');
  if (!namespace) {
    res.status(400).json({ error: 'namespace query parameter required' });
    return;
  }
  try {
    const { namespaceExists } = await checkNamespaceExists(namespace, incidentId);
    res.json({ namespace, exists: namespaceExists });
  } catch (err) {
    log('warn', AGENT, 'namespace-check failed', { namespace, error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /facts — synchronous facts for orchestrator ───────────────────────────

app.get('/facts', async (req: Request, res: Response) => {
  const namespace = String(req.query.namespace ?? 'default');
  const resourceName = String(req.query.resourceName ?? '');
  const resourceKind = (String(req.query.resourceKind ?? 'Deployment')) as DiagnosisContext['resourceKind'];
  const podName = String(req.query.podName ?? resourceName);
  const incidentId = String(req.query.incidentId ?? 'unknown');
  const mode = (String(req.query.mode ?? 'diagnose')) as DiagnosisContext['mode'];
  const githubRepo = req.query.githubRepo ? String(req.query.githubRepo) : undefined;
  const containerImage = req.query.containerImage ? String(req.query.containerImage) : undefined;
  let helmRemote: DeployRequest['helmRemote'];
  if (req.query.helmRemote) {
    try {
      helmRemote = JSON.parse(String(req.query.helmRemote)) as DeployRequest['helmRemote'];
    } catch {
      helmRemote = undefined;
    }
  }
  const gitRef = req.query.gitRef ? String(req.query.gitRef) : undefined;
  const investigateScope = req.query.investigateScope
    ? (String(req.query.investigateScope) as import('../../../shared/src/types.js').InvestigateScope)
    : undefined;
  const rawMessage = req.query.rawMessage ? String(req.query.rawMessage) : undefined;
  let deployProvenance: Partial<DeployProvenance> | undefined;
  if (req.query.deployProvenance) {
    try {
      deployProvenance = JSON.parse(String(req.query.deployProvenance)) as Partial<DeployProvenance>;
    } catch {
      deployProvenance = undefined;
    }
  }
  let affectedWorkloads: import('../../../shared/src/alert-correlation.js').CorrelatedWorkloadRef[] | undefined;
  if (req.query.affectedWorkloads) {
    try {
      affectedWorkloads = JSON.parse(String(req.query.affectedWorkloads)) as typeof affectedWorkloads;
    } catch {
      affectedWorkloads = undefined;
    }
  }
  const correlationKey = req.query.correlationKey ? String(req.query.correlationKey) : undefined;

  if (!resourceName) {
    res.status(400).json({ error: 'resourceName required' });
    return;
  }

  try {
    const facts = await gatherFactsSync({
      incidentId,
      namespace,
      resourceName,
      resourceKind,
      podName,
      mode,
      githubRepo,
      containerImage,
      helmRemote,
      gitRef,
      investigateScope,
      rawMessage,
      deployProvenance,
      correlationKey,
      affectedWorkloads,
    });
    res.json(facts);
  } catch (err) {
    log('error', AGENT, 'GET /facts failed', { incidentId, error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /workload-status — is workload running? (commander sync reply) ───────

app.get('/workload-status', async (req: Request, res: Response) => {
  const namespace = String(req.query.namespace ?? 'default');
  const resourceName = String(req.query.resourceName ?? '');
  const resourceKind = (String(req.query.resourceKind ?? 'Deployment')) as import('../../../shared/src/types.js').ResourceKind;
  const podName = req.query.podName ? String(req.query.podName) : undefined;
  const incidentId = String(req.query.incidentId ?? 'status');

  if (!resourceName) {
    res.status(400).json({ error: 'resourceName required' });
    return;
  }

  try {
    const { gatherWorkloadStatus } = await import('./workload-status.js');
    const facts = await gatherWorkloadStatus({
      incidentId,
      namespace,
      resourceName,
      resourceKind,
      podName,
    });
    res.json(facts);
  } catch (err) {
    log('error', AGENT, 'GET /workload-status failed', { incidentId, error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /resolve-workload — match vague hints to workloads (commander confirmation) ─

app.get('/resolve-workload', async (req: Request, res: Response) => {
  const hint = String(req.query.hint ?? '');
  const namespace = req.query.namespace ? String(req.query.namespace) : undefined;
  const incidentId = String(req.query.incidentId ?? 'resolve');

  try {
    const candidates = await resolveWorkloadCandidates(
      hint,
      namespace,
      incidentId,
      5
    );
    const confirm = needsUserConfirmation(candidates);
    const auto =
      candidates.length === 1 && candidates[0]!.score >= AUTO_CONFIRM_SCORE
        ? candidates[0]
        : undefined;

    res.json({
      hint,
      needsConfirmation: confirm,
      autoConfirm: !confirm && auto ? auto : undefined,
      candidates,
    });
  } catch (err) {
    log('error', AGENT, 'GET /resolve-workload failed', { incidentId, error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

app.get('/cluster-health', async (req: Request, res: Response) => {
  const force = req.query.force === 'true';
  try {
    const { getClusterHealthSnapshot } = await import('./cluster-health-snapshot.js');
    const snapshot = await getClusterHealthSnapshot(force);
    res.json(snapshot);
  } catch (err) {
    log('error', AGENT, 'GET /cluster-health failed', { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

app.get('/app-graph', async (req: Request, res: Response) => {
  const appId = String(req.query.appId ?? '').trim();
  const namespace = req.query.namespace ? String(req.query.namespace) : undefined;
  const force = req.query.force === 'true';
  if (!appId) {
    res.status(400).json({ error: 'appId required' });
    return;
  }
  try {
    const { getAppReviewSnapshot } = await import('./app-graph-snapshot.js');
    const review = await getAppReviewSnapshot(appId, namespace, force);
    res.json(review.graph);
  } catch (err) {
    log('error', AGENT, 'GET /app-graph failed', { appId, error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

app.get('/app-review', async (req: Request, res: Response) => {
  const appId = String(req.query.appId ?? '').trim();
  const namespace = req.query.namespace ? String(req.query.namespace) : undefined;
  const force = req.query.force === 'true';
  if (!appId) {
    res.status(400).json({ error: 'appId required' });
    return;
  }
  try {
    const { getAppReviewSnapshot } = await import('./app-graph-snapshot.js');
    const review = await getAppReviewSnapshot(appId, namespace, force);
    res.json(review);
  } catch (err) {
    log('error', AGENT, 'GET /app-review failed', { appId, error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

app.get('/apps', async (req: Request, res: Response) => {
  const namespace = req.query.namespace ? String(req.query.namespace) : undefined;
  try {
    const { listApps } = await import('./app-list.js');
    const result = await listApps(namespace);
    res.json(result);
  } catch (err) {
    log('error', AGENT, 'GET /apps failed', { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

app.get('/apps/catalog', async (_req: Request, res: Response) => {
  try {
    const { listCatalogEntries } = await import('./app-catalog-store.js');
    const entries = await listCatalogEntries();
    res.json({ entries });
  } catch (err) {
    log('error', AGENT, 'GET /apps/catalog failed', { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

app.put('/apps/catalog', async (req: Request, res: Response) => {
  const body = req.body as import('../../../shared/src/app-catalog.js').AppCatalogEntry;
  if (!body?.appId?.trim() || !body?.namespace?.trim()) {
    res.status(400).json({ error: 'appId and namespace required' });
    return;
  }
  try {
    const { upsertCatalogEntry } = await import('./app-catalog-store.js');
    const entry = await upsertCatalogEntry({
      ...body,
      appId: body.appId.trim(),
      namespace: body.namespace.trim(),
      members: body.members ?? [],
      source: 'user',
      userEdited: true,
      updatedAt: new Date().toISOString(),
    });
    res.json(entry);
  } catch (err) {
    log('error', AGENT, 'PUT /apps/catalog failed', { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

app.delete('/apps/catalog', async (req: Request, res: Response) => {
  const namespace = String(req.query.namespace ?? '').trim();
  const appId = String(req.query.appId ?? '').trim();
  if (!namespace || !appId) {
    res.status(400).json({ error: 'namespace and appId required' });
    return;
  }
  try {
    const { deleteCatalogEntry } = await import('./app-catalog-store.js');
    const deleted = await deleteCatalogEntry(namespace, appId);
    res.json({ deleted });
  } catch (err) {
    log('error', AGENT, 'DELETE /apps/catalog failed', { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

app.post('/apps/catalog/upsert-auto', async (req: Request, res: Response) => {
  const body = req.body as {
    appId?: string;
    namespace?: string;
    members?: import('../../../shared/src/app-catalog.js').AppCatalogMember[];
    dependsOn?: string[];
  };
  if (!body?.appId?.trim() || !body?.namespace?.trim()) {
    res.status(400).json({ error: 'appId and namespace required' });
    return;
  }
  try {
    const { upsertAutoCatalogEntry } = await import('./app-catalog-store.js');
    const entry = await upsertAutoCatalogEntry({
      appId: body.appId.trim(),
      namespace: body.namespace.trim(),
      members: body.members ?? [],
      dependsOn: body.dependsOn,
    });
    res.json(entry);
  } catch (err) {
    log('error', AGENT, 'POST /apps/catalog/upsert-auto failed', { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /get — list cluster resources (read-only, for commander chat) ─────────

const GET_RESOURCES = new Set<ClusterGetResource>([
  'namespaces',
  'pods',
  'deployments',
  'nodes',
  'services',
  'events',
]);

app.get('/get', async (req: Request, res: Response) => {
  const resource = String(req.query.resource ?? '') as ClusterGetResource;
  const namespace = req.query.namespace ? String(req.query.namespace) : undefined;
  const incidentId = String(req.query.incidentId ?? 'get');

  if (!GET_RESOURCES.has(resource)) {
    res.status(400).json({
      error: 'resource required: namespaces|pods|deployments|nodes|services|events',
    });
    return;
  }

  try {
    const result = await clusterGet(resource, namespace, incidentId);
    res.json(result);
  } catch (err) {
    log('error', AGENT, 'GET /get failed', { incidentId, resource, error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

app.get('/verify', async (req: Request, res: Response) => {
  const namespace = String(req.query.namespace ?? 'default');
  const resourceName = String(req.query.resourceName ?? '');
  const incidentId = String(req.query.incidentId ?? 'unknown');
  let workloads: DeployWorkloadRef[] | undefined;
  const workloadsRaw = req.query.workloads;
  if (typeof workloadsRaw === 'string' && workloadsRaw.trim()) {
    try {
      workloads = JSON.parse(workloadsRaw) as DeployWorkloadRef[];
    } catch {
      res.status(400).json({ error: 'invalid workloads JSON' });
      return;
    }
  }

  const playbookMarkdown =
    typeof req.query.playbookMarkdown === 'string' ? req.query.playbookMarkdown : undefined;

  if (!resourceName) {
    res.status(400).json({ error: 'resourceName required' });
    return;
  }

  const result = await verifyWithPlaybooks(namespace, resourceName, incidentId, {
    workloads,
    playbookMarkdown,
  });
  res.json(result);
});

app.post('/verify', async (req: Request, res: Response) => {
  const body = req.body as {
    namespace?: string;
    resourceName?: string;
    incidentId?: string;
    workloads?: DeployWorkloadRef[];
    playbookMarkdown?: string;
  };
  const namespace = body.namespace ?? 'default';
  const resourceName = body.resourceName ?? '';
  const incidentId = body.incidentId ?? 'unknown';

  if (!resourceName) {
    res.status(400).json({ error: 'resourceName required' });
    return;
  }

  const result = await verifyWithPlaybooks(namespace, resourceName, incidentId, {
    workloads: body.workloads,
    playbookMarkdown: body.playbookMarkdown,
  });
  res.json(result);
});

app.get('/discover-workloads', async (req: Request, res: Response) => {
  const namespace = String(req.query.namespace ?? 'default');
  const releaseName = String(req.query.releaseName ?? req.query.resourceName ?? '');
  const incidentId = String(req.query.incidentId ?? 'unknown');

  if (!releaseName) {
    res.status(400).json({ error: 'releaseName required' });
    return;
  }

  try {
    const result = await discoverReleaseWorkloads(namespace, releaseName, incidentId);
    res.json(result);
  } catch (err) {
    log('error', AGENT, 'GET /discover-workloads failed', { incidentId, error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

app.post('/observability/logs', async (req: Request, res: Response) => {
  const body = req.body as {
    namespace?: string;
    podName?: string;
    labelSelector?: string;
    sinceMinutes?: number;
    limit?: number;
    incidentId?: string;
  };
  const incidentId = body.incidentId ?? 'observability';
  try {
    const result = await queryLogs({
      namespace: body.namespace,
      podName: body.podName,
      labelSelector: body.labelSelector,
      sinceMinutes: body.sinceMinutes,
      limit: body.limit,
      incidentId,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/observability/metrics', async (req: Request, res: Response) => {
  const body = req.body as {
    namespace?: string;
    deployment?: string;
    incidentId?: string;
  };
  const incidentId = body.incidentId ?? 'observability';
  try {
    const result = await queryMetrics({
      namespace: body.namespace,
      deployment: body.deployment,
      incidentId,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /analyze ─────────────────────────────────────────────────────────────
//
// Triggered by watcher-agent when it detects an anomaly (CrashLoopBackOff,
// OOMKilling, FailedMount, etc.).
// Gathers K8s facts + GitOps manifest, then forwards DiagnosisContext to brain.

app.post('/analyze', async (req: Request, res: Response): Promise<void> => {
  const body = req.body as AnomalyDetected;

  if (!body?.incidentId || !body?.podName || !body?.namespace) {
    res.status(400).json({ error: 'Missing required fields: incidentId, podName, namespace' });
    return;
  }

  // Acknowledge immediately — fact-gathering is async
  res.status(202).json({ status: 'accepted', incidentId: body.incidentId });

  // Run fact-gathering in the background
  setImmediate(() => runAnalysis(body));
});

async function runAnalysis(body: AnomalyDetected): Promise<void> {
  const { incidentId, namespace, podName, resourceName, resourceKind } = body;

  log('info', AGENT, 'Starting anomaly analysis', {
    incidentId,
    namespace,
    podName,
    resourceName,
    resourceKind,
  });

  try {
    // Gather K8s facts and GitOps manifest concurrently
    const [k8sFacts, manifestResult] = await Promise.all([
      gatherPodFacts(namespace, podName, resourceName, resourceKind, incidentId),
      GITOPS_REPO_URL
        ? findManifest(resourceName, resourceKind, namespace)
        : Promise.resolve(null),
    ]);

    const context: DiagnosisContext = {
      // Base envelope passthrough
      incidentId,
      triggeredBy: body.triggeredBy,
      triggeredAt: body.triggeredAt,
      namespace,
      resourceKind: body.resourceKind,
      resourceName,
      mode: body.mode,
      // K8s facts
      podSpec: k8sFacts.podSpec ?? {},
      containerStatuses: k8sFacts.containerStatuses ?? [],
      resourceLimits: k8sFacts.resourceLimits ?? {},
      nodeInfo: k8sFacts.nodeInfo,
      recentEvents: k8sFacts.recentEvents ?? [],
      currentLogs: k8sFacts.currentLogs ?? '',
      previousLogs: k8sFacts.previousLogs ?? '',
      // GitOps context
      gitRepoUrl: GITOPS_REPO_URL || undefined,
      gitManifestPath: manifestResult?.path,
      gitManifestContent: manifestResult?.content,
    };

    await postWithRetry({
      url: `${BRAIN_URL}/diagnose`,
      payload: context,
      incidentId,
      callerAgent: AGENT,
    });

    log('info', AGENT, 'Analysis complete — DiagnosisContext forwarded to brain', {
      incidentId,
    });
  } catch (err) {
    log('error', AGENT, 'Unhandled error during anomaly analysis', {
      incidentId,
      error: String(err),
    });
  }
}

app.post('/build/from-source', async (req: Request, res: Response): Promise<void> => {
  const body = req.body as BuildFromSourceRequest;
  if (!body?.incidentId || !body?.appName || !body?.namespace || !body?.githubRepo) {
    res.status(400).json({
      error: 'Missing required fields: incidentId, appName, namespace, githubRepo',
    });
    return;
  }

  const buildEnabled = (process.env['SOURCE_BUILD_ENABLED'] ?? 'false').toLowerCase() === 'true';
  if (!buildEnabled) {
    res.status(503).json({
      error: 'SOURCE_BUILD_ENABLED is false — enable to execute in-cluster builds',
    });
    return;
  }

  try {
    const result = await buildFromSource({
      ...body,
      gitRef: body.gitRef ?? 'main',
    });
    res.status(result.success ? 200 : 422).json(result);
  } catch (err) {
    log('error', AGENT, 'POST /build/from-source failed', {
      incidentId: body.incidentId,
      error: String(err),
    });
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /pre-deploy ──────────────────────────────────────────────────────────
//
// Triggered by commander-agent for pre-deployment checks.
// Gathers namespace facts + locates repo entry point, then forwards to brain.

app.post('/pre-deploy', async (req: Request, res: Response): Promise<void> => {
  const body = req.body as DeployRequest;

  if (!body?.incidentId || !body?.namespace) {
    res.status(400).json({
      error: 'Missing required fields: incidentId, namespace',
    });
    return;
  }
  if (!body.githubRepo && !body.containerImage && !body.helmRemote) {
    res.status(400).json({
      error: 'Either githubRepo, containerImage, or helmRemote is required for pre-deploy',
    });
    return;
  }

  // Acknowledge immediately
  res.status(202).json({ status: 'accepted', incidentId: body.incidentId });

  setImmediate(() => runPreDeploy(body));
});

app.post('/stack-facts', async (req: Request, res: Response): Promise<void> => {
  const body = req.body as DeployRequest;
  if (!body?.incidentId || !body?.namespace || !body?.stackServices?.length) {
    res.status(400).json({
      error: 'Missing required fields: incidentId, namespace, stackServices',
    });
    return;
  }
  try {
    const analysis = await gatherStackPreDeployFacts(body);
    res.json(analysis);
  } catch (err) {
    log('error', AGENT, 'POST /stack-facts failed', {
      incidentId: body.incidentId,
      error: String(err),
    });
    res.status(500).json({ error: String(err) });
  }
});

async function runPreDeploy(body: DeployRequest): Promise<void> {
  const { incidentId, namespace, githubRepo, requestedBy, platform, channelId } = body;

  log('info', AGENT, 'Starting pre-deploy fact-gathering', {
    incidentId,
    namespace,
    githubRepo,
  });

  try {
    const deployFacts = await gatherPreDeployFacts(body);

    const context: DiagnosisContext = {
      // Base envelope
      incidentId,
      triggeredBy: body.triggeredBy,
      triggeredAt: body.triggeredAt,
      namespace,
      resourceKind: body.resourceKind,
      resourceName: body.resourceName,
      mode: body.mode,
      // Pre-deploy facts
      podSpec: deployFacts.podSpec ?? {},
      containerStatuses: deployFacts.containerStatuses ?? [],
      resourceLimits: deployFacts.resourceLimits ?? {},
      recentEvents: deployFacts.recentEvents ?? [],
      currentLogs: deployFacts.currentLogs ?? '',
      previousLogs: deployFacts.previousLogs ?? '',
      namespaceExists: deployFacts.namespaceExists,
      namespaceQuotas: deployFacts.namespaceQuotas,
      existingDeployments: deployFacts.existingDeployments,
      // Repo / GitOps
      gitRepoUrl: githubRepo,
      gitManifestPath: deployFacts.gitManifestPath,
      gitManifestContent: deployFacts.gitManifestContent,
      // Commander passthrough for reply routing
      requestedBy,
      platform,
      channelId,
      githubRepo,
    };

    await postWithRetry({
      url: `${BRAIN_URL}/diagnose`,
      payload: context,
      incidentId,
      callerAgent: AGENT,
    });

    log('info', AGENT, 'Pre-deploy facts forwarded to brain', { incidentId });
  } catch (err) {
    log('error', AGENT, 'Unhandled error during pre-deploy fact-gathering', {
      incidentId,
      error: String(err),
    });
  }
}

// ── POST /investigate ─────────────────────────────────────────────────────────
//
// Manual investigation request from commander (human SRE asking "what's wrong
// with <deployment> in <namespace>?"). Uses the same K8s fact-gathering path
// as /analyze but mode is 'diagnose' and there may be no specific podName.

app.post('/investigate', async (req: Request, res: Response): Promise<void> => {
  const body = req.body as IncidentEnvelope & {
    podName?: string;
    requestedBy?: string;
    platform?: string;
    channelId?: string;
    rawMessage?: string;
  };

  if (!body?.incidentId || !body?.namespace || !body?.resourceName) {
    res.status(400).json({
      error: 'Missing required fields: incidentId, namespace, resourceName',
    });
    return;
  }

  res.status(202).json({ status: 'accepted', incidentId: body.incidentId });

  setImmediate(() => runManualInvestigation(body));
});

async function runManualInvestigation(
  body: IncidentEnvelope & {
    podName?: string;
    requestedBy?: string;
    platform?: string;
    channelId?: string;
    rawMessage?: string;
  }
): Promise<void> {
  const {
    incidentId,
    namespace,
    resourceName,
    resourceKind,
    podName,
    requestedBy,
    platform,
    channelId,
  } = body;

  log('info', AGENT, 'Starting manual investigation', {
    incidentId,
    namespace,
    resourceName,
    resourceKind,
    podName,
  });

  try {
    // If a podName was specified use it; otherwise try to find the first pod
    // for the given resource (best-effort — may be unavailable for some kinds)
    const { resolvePodForWorkload } = await import('./workload-resolve.js');
    const effectivePodName =
      podName ??
      (await resolvePodForWorkload(namespace, resourceName, resourceKind, incidentId));

    const [k8sFacts, manifestResult] = await Promise.all([
      effectivePodName
        ? gatherPodFacts(namespace, effectivePodName, resourceName, resourceKind, incidentId)
        : Promise.resolve<Partial<DiagnosisContext>>({}),
      GITOPS_REPO_URL
        ? findManifest(resourceName, resourceKind, namespace)
        : Promise.resolve(null),
    ]);

    const context: DiagnosisContext = {
      incidentId,
      triggeredBy: body.triggeredBy ?? 'commander',
      triggeredAt: body.triggeredAt ?? new Date().toISOString(),
      namespace,
      resourceKind: body.resourceKind,
      resourceName,
      mode: body.mode ?? 'diagnose',
      podSpec: k8sFacts.podSpec ?? {},
      containerStatuses: k8sFacts.containerStatuses ?? [],
      resourceLimits: k8sFacts.resourceLimits ?? {},
      nodeInfo: k8sFacts.nodeInfo,
      recentEvents: k8sFacts.recentEvents ?? [],
      currentLogs: k8sFacts.currentLogs ?? '',
      previousLogs: k8sFacts.previousLogs ?? '',
      gitRepoUrl: GITOPS_REPO_URL || undefined,
      gitManifestPath: manifestResult?.path,
      gitManifestContent: manifestResult?.content,
      requestedBy,
      platform: platform as DiagnosisContext['platform'],
      channelId,
    };

    await postWithRetry({
      url: `${BRAIN_URL}/diagnose`,
      payload: context,
      incidentId,
      callerAgent: AGENT,
    });

    log('info', AGENT, 'Manual investigation complete — DiagnosisContext forwarded to brain', {
      incidentId,
    });
  } catch (err) {
    log('error', AGENT, 'Unhandled error during manual investigation', {
      incidentId,
      error: String(err),
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Tries to find the first running pod for a given resource by listing pods
 * with the app label selector derived from the resource name.
 * Returns null if no pod can be found — fact-gathering will proceed
 * without pod-level data.
 */
// ── Startup ───────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  // Listen immediately so orchestrator /health and GET /facts are not blocked by git clone.
  app.listen(PORT, () => {
    log('info', AGENT, `investigator-agent listening`, {
      port: PORT,
      brainUrl: BRAIN_URL,
      gitopsRepoUrl: GITOPS_REPO_URL || '(not configured)',
      gitSyncIntervalSeconds: GIT_SYNC_INTERVAL_SECONDS,
    });
  });

  if (GITOPS_REPO_URL) {
    setImmediate(() => {
      void (async () => {
        try {
          await ensureMirrorSynced(GITOPS_REPO_URL);
          startMirrorSyncScheduler(GITOPS_REPO_URL, GIT_SYNC_INTERVAL_SECONDS);
        } catch (err) {
          log('warn', AGENT, 'GitOps mirror initial sync failed — continuing without mirror', {
            repoUrl: GITOPS_REPO_URL,
            error: String(err),
          });
        }
      })();
    });
  } else {
    log('info', AGENT, 'GITOPS_REPO_URL not set — GitOps mirror disabled');
  }
}

start().catch((err) => {
  log('error', AGENT, 'Fatal startup error', { error: String(err) });
  process.exit(1);
});
