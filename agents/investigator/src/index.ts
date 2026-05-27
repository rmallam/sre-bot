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
import { postWithRetry, log } from '../../../shared/src/http.js';
import { gatherPodFacts } from './k8s-facts.js';
import { gatherPreDeployFacts } from './pre-deploy.js';
import {
  ensureMirrorSynced,
  startMirrorSyncScheduler,
  findManifest,
  getMirrorStatus,
} from './git-mirror.js';
import { gatherFactsSync } from './facts-sync.js';
import { verifyDeployment } from './verify.js';

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
  res.json({
    status: 'ok',
    agent: AGENT,
    mirror,
    useOrchestrator: USE_ORCHESTRATOR,
  });
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
  const gitRef = req.query.gitRef ? String(req.query.gitRef) : undefined;

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
      gitRef,
    });
    res.json(facts);
  } catch (err) {
    log('error', AGENT, 'GET /facts failed', { incidentId, error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /verify — workload health check ───────────────────────────────────────

app.get('/verify', async (req: Request, res: Response) => {
  const namespace = String(req.query.namespace ?? 'default');
  const resourceName = String(req.query.resourceName ?? '');
  const incidentId = String(req.query.incidentId ?? 'unknown');

  if (!resourceName) {
    res.status(400).json({ error: 'resourceName required' });
    return;
  }

  const result = await verifyDeployment(namespace, resourceName, incidentId);
  res.json({ healthy: result.healthy, message: result.message, ...result });
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

// ── POST /pre-deploy ──────────────────────────────────────────────────────────
//
// Triggered by commander-agent for pre-deployment checks.
// Gathers namespace facts + locates repo entry point, then forwards to brain.

app.post('/pre-deploy', async (req: Request, res: Response): Promise<void> => {
  const body = req.body as DeployRequest;

  if (!body?.incidentId || !body?.githubRepo || !body?.namespace) {
    res.status(400).json({
      error: 'Missing required fields: incidentId, githubRepo, namespace',
    });
    return;
  }

  // Acknowledge immediately
  res.status(202).json({ status: 'accepted', incidentId: body.incidentId });

  setImmediate(() => runPreDeploy(body));
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
    const effectivePodName = podName ?? await resolveFirstPod(namespace, resourceName, incidentId);

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
async function resolveFirstPod(
  namespace: string,
  resourceName: string,
  incidentId: string
): Promise<string | null> {
  const { CoreV1Api, KubeConfig } = await import('@kubernetes/client-node');
  const { existsSync } = await import('node:fs');
  const kc2 = new KubeConfig();
  const hasToken = existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token');
  if (hasToken) {
    try {
      kc2.loadFromCluster();
    } catch {
      kc2.loadFromDefault();
    }
  } else {
    kc2.loadFromDefault();
  }
  const api = kc2.makeApiClient(CoreV1Api);

  try {
    const res = await api.listNamespacedPod(
      namespace,
      undefined, undefined, undefined, undefined,
      `app=${resourceName}`,
      1
    );
    const pod = (res.body as { items?: Array<{ metadata?: { name?: string } }> }).items?.[0];
    if (pod?.metadata?.name) {
      log('info', AGENT, `Resolved first pod for resource ${resourceName}`, {
        incidentId,
        podName: pod.metadata.name,
      });
      return pod.metadata.name;
    }
  } catch (err) {
    log('warn', AGENT, `Could not resolve pod for resource ${resourceName}`, {
      incidentId,
      error: String(err),
    });
  }
  return null;
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  // Bootstrap GitOps mirror if a repo URL is configured
  if (GITOPS_REPO_URL) {
    try {
      await ensureMirrorSynced(GITOPS_REPO_URL);
      startMirrorSyncScheduler(GITOPS_REPO_URL, GIT_SYNC_INTERVAL_SECONDS);
    } catch (err) {
      // Non-fatal — the agent can still gather K8s facts without the mirror
      log('warn', AGENT, 'GitOps mirror initial sync failed — continuing without mirror', {
        repoUrl: GITOPS_REPO_URL,
        error: String(err),
      });
    }
  } else {
    log('info', AGENT, 'GITOPS_REPO_URL not set — GitOps mirror disabled');
  }

  app.listen(PORT, () => {
    log('info', AGENT, `investigator-agent listening`, {
      port: PORT,
      brainUrl: BRAIN_URL,
      gitopsRepoUrl: GITOPS_REPO_URL || '(not configured)',
      gitSyncIntervalSeconds: GIT_SYNC_INTERVAL_SECONDS,
    });
  });
}

start().catch((err) => {
  log('error', AGENT, 'Fatal startup error', { error: String(err) });
  process.exit(1);
});
