/**
 * pre-deploy.ts
 *
 * Pre-deploy fact gathering for DeployRequest payloads.
 *
 * Collects namespace existence, ResourceQuota, existing Deployments,
 * and locates the Kustomize/Helm/plain YAML entry point in the target repo.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import * as k8s from '@kubernetes/client-node';
import simpleGit from 'simple-git';
import type { DeployRequest, DiagnosisContext } from '../../../shared/src/types.js';
import { log } from '../../../shared/src/http.js';

const AGENT = 'investigator';

// ── Kubernetes client ─────────────────────────────────────────────────────────

function buildKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  const hasToken = existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token');
  if (hasToken) {
    try {
      kc.loadFromCluster();
      return kc;
    } catch {}
  }
  kc.loadFromDefault();
  return kc;
}

const kc = buildKubeConfig();
const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
const appsV1Api = kc.makeApiClient(k8s.AppsV1Api);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function safeCall<T>(
  incidentId: string,
  label: string,
  fn: () => Promise<{ body: T }>
): Promise<T | null> {
  try {
    const res = await fn();
    return res.body;
  } catch (err: unknown) {
    const status = (err as { response?: { statusCode?: number } })?.response
      ?.statusCode;
    log('warn', AGENT, `K8s API call failed: ${label}`, {
      incidentId,
      error: String(err),
      status,
    });
    return null;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Gathers pre-deployment facts for a given DeployRequest.
 *
 * Returns a Partial<DiagnosisContext> with:
 *  - namespaceExists
 *  - namespaceQuotas (ResourceQuota list)
 *  - existingDeployments (names of current Deployments in namespace)
 *  - gitManifestPath / gitManifestContent (entry point found in the repo)
 */
export async function gatherPreDeployFacts(
  req: DeployRequest
): Promise<Partial<DiagnosisContext>> {
  const { incidentId, namespace, githubRepo, gitRef = 'main' } = req;

  log('info', AGENT, 'Starting pre-deploy fact-gathering', {
    incidentId,
    namespace,
    githubRepo,
    gitRef,
  });

  // Run K8s checks and repo clone concurrently
  const [k8sFacts, repoFacts] = await Promise.all([
    gatherNamespaceFacts(namespace, incidentId),
    cloneAndLocateEntryPoint(githubRepo, gitRef, incidentId),
  ]);

  const result: Partial<DiagnosisContext> = {
    incidentId: req.incidentId,
    triggeredBy: req.triggeredBy,
    triggeredAt: req.triggeredAt,
    namespace: req.namespace,
    resourceKind: req.resourceKind,
    resourceName: req.resourceName,
    mode: req.mode,
    requestedBy: req.requestedBy,
    platform: req.platform,
    channelId: req.channelId,
    podSpec: {},
    containerStatuses: [],
    resourceLimits: {},
    recentEvents: [],
    currentLogs: '',
    previousLogs: '',
    // Namespace facts
    ...k8sFacts,
    // Repo facts
    ...repoFacts,
    needsHelmGeneration: repoFacts.needsHelmGeneration,
    repoEntryPointKind: repoFacts.repoEntryPointKind,
    repoSignals: repoFacts.repoSignals,
    githubRepo,
    gitRepoUrl: githubRepo,
  };

  log('info', AGENT, 'Pre-deploy fact-gathering complete', {
    incidentId,
    namespace,
    namespaceExists: k8sFacts.namespaceExists,
    hasQuotas: !!k8sFacts.namespaceQuotas,
    existingDeploymentCount: k8sFacts.existingDeployments?.length ?? 0,
    entryPointFound: !!repoFacts.gitManifestPath,
  });

  return result;
}

// ── Namespace facts ───────────────────────────────────────────────────────────

async function gatherNamespaceFacts(
  namespace: string,
  incidentId: string
): Promise<{
  namespaceExists: boolean;
  namespaceQuotas: object;
  existingDeployments: string[];
}> {
  // Check namespace existence
  const ns = await safeCall(incidentId, `readNamespace/${namespace}`, () =>
    coreV1Api.readNamespace(namespace)
  );
  const namespaceExists = ns !== null;

  if (!namespaceExists) {
    log('info', AGENT, `Namespace does not exist: ${namespace}`, { incidentId });
    return {
      namespaceExists: false,
      namespaceQuotas: {},
      existingDeployments: [],
    };
  }

  // Fetch ResourceQuotas and Deployments in parallel
  const [quotaList, deployList] = await Promise.all([
    safeCall(incidentId, `listNamespacedResourceQuota/${namespace}`, () =>
      coreV1Api.listNamespacedResourceQuota(namespace)
    ),
    safeCall(incidentId, `listNamespacedDeployment/${namespace}`, () =>
      appsV1Api.listNamespacedDeployment(namespace)
    ),
  ]);

  const quotaBody = quotaList as k8s.V1ResourceQuotaList | null;
  const namespaceQuotas: object = quotaBody?.items?.length
    ? quotaBody.items.map((q) => ({
        name: q.metadata?.name,
        hard: q.status?.hard ?? {},
        used: q.status?.used ?? {},
      }))
    : {};

  const deployBody = deployList as k8s.V1DeploymentList | null;
  const existingDeployments: string[] = (deployBody?.items ?? []).map(
    (d) => d.metadata?.name ?? 'unknown'
  );

  return {
    namespaceExists: true,
    namespaceQuotas,
    existingDeployments,
  };
}

// ── Repo clone & entry-point detection ───────────────────────────────────────

/** Detects which kind of K8s entry point the repo uses. */
type EntryPointKind = 'kustomize' | 'helm' | 'plain-yaml' | 'unknown';

interface EntryPointResult {
  gitManifestPath?: string;
  gitManifestContent?: string;
  repoEntryPointKind?: EntryPointKind;
  repoSignals?: import('../../../shared/src/types.js').RepoSignals;
  needsHelmGeneration?: boolean;
}

function detectRepoSignals(repoDir: string): import('../../../shared/src/types.js').RepoSignals {
  return {
    hasDockerfile: existsSync(join(repoDir, 'Dockerfile')),
    hasPackageJson: existsSync(join(repoDir, 'package.json')),
    hasGoMod: existsSync(join(repoDir, 'go.mod')),
    primaryLanguage: existsSync(join(repoDir, 'package.json'))
      ? 'nodejs'
      : existsSync(join(repoDir, 'go.mod'))
        ? 'go'
        : 'unknown',
    suggestedImage: undefined,
  };
}

async function cloneAndLocateEntryPoint(
  repoUrl: string,
  gitRef: string,
  incidentId: string
): Promise<EntryPointResult> {
  // Ensure the URL has a scheme for git clone
  const cloneUrl = repoUrl.startsWith('http') ? repoUrl : `https://${repoUrl}`;

  let tmpDir: string | null = null;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), 'sre-predeploy-'));
    log('info', AGENT, 'Cloning deploy target repo', {
      incidentId,
      repoUrl: cloneUrl,
      gitRef,
      tmpDir,
    });

    const git = simpleGit();
    await git.clone(cloneUrl, tmpDir, ['--depth', '1', '--branch', gitRef]);

    const result = await detectEntryPoint(tmpDir, incidentId);
    const repoSignals = detectRepoSignals(tmpDir);
    if (result.gitManifestPath) {
      result.gitManifestPath = result.gitManifestPath.replace(tmpDir + '/', '');
    }
    return {
      ...result,
      repoSignals,
      repoEntryPointKind: result.repoEntryPointKind ?? 'unknown',
      needsHelmGeneration: !result.gitManifestPath,
    };
  } catch (err) {
    log('error', AGENT, 'Failed to clone deploy target repo', {
      incidentId,
      repoUrl: cloneUrl,
      gitRef,
      error: String(err),
    });
    return {};
  } finally {
    // Always clean up the temp dir
    if (tmpDir && existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true }).catch((e) =>
        log('warn', AGENT, 'Failed to clean up temp repo dir', {
          incidentId,
          tmpDir,
          error: String(e),
        })
      );
    }
  }
}

/**
 * Searches the cloned repo directory for a known K8s entry point.
 *
 * Priority:
 *  1. kustomization.yaml / kustomization.yml  (Kustomize)
 *  2. Chart.yaml                               (Helm)
 *  3. First *.yaml / *.yml in root or deploy/  (plain YAML)
 */
async function detectEntryPoint(
  repoDir: string,
  incidentId: string
): Promise<EntryPointResult> {
  // 1. Kustomize
  for (const candidate of [
    join(repoDir, 'kustomization.yaml'),
    join(repoDir, 'kustomization.yml'),
    join(repoDir, 'base', 'kustomization.yaml'),
    join(repoDir, 'base', 'kustomization.yml'),
    join(repoDir, 'overlays', 'prod', 'kustomization.yaml'),
    join(repoDir, 'overlays', 'production', 'kustomization.yaml'),
    join(repoDir, 'k8s', 'kustomization.yaml'),
  ]) {
    if (existsSync(candidate)) {
      log('info', AGENT, 'Detected Kustomize entry point', { incidentId, path: candidate });
      return readEntryPoint(candidate, 'kustomize', incidentId);
    }
  }

  // 2. Helm
  for (const candidate of [
    join(repoDir, 'Chart.yaml'),
    join(repoDir, 'helm', 'Chart.yaml'),
    join(repoDir, 'charts', 'Chart.yaml'),
  ]) {
    if (existsSync(candidate)) {
      log('info', AGENT, 'Detected Helm chart entry point', { incidentId, path: candidate });
      return readEntryPoint(candidate, 'helm', incidentId);
    }
  }

  // 3. Plain YAML — search common directories
  const searchDirs = [
    repoDir,
    join(repoDir, 'deploy'),
    join(repoDir, 'k8s'),
    join(repoDir, 'manifests'),
    join(repoDir, 'kubernetes'),
  ];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const ext = extname(entry).toLowerCase();
      if (ext === '.yaml' || ext === '.yml') {
        const full = join(dir, entry);
        log('info', AGENT, 'Detected plain YAML entry point', { incidentId, path: full });
        return readEntryPoint(full, 'plain-yaml', incidentId);
      }
    }
  }

  log('warn', AGENT, 'Could not detect K8s entry point in repo', {
    incidentId,
    repoDir,
  });
  return {};
}

async function readEntryPoint(
  filePath: string,
  kind: EntryPointKind,
  incidentId: string
): Promise<EntryPointResult> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return {
      gitManifestPath: filePath,
      gitManifestContent: content,
      repoEntryPointKind: kind,
    };
  } catch (err) {
    log('warn', AGENT, `Failed to read entry point file`, {
      incidentId,
      kind,
      filePath,
      error: String(err),
    });
    return { gitManifestPath: filePath, repoEntryPointKind: kind };
  }
}
