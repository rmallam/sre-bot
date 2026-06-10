/**
 * pre-deploy.ts
 *
 * Pre-deploy fact gathering for DeployRequest payloads.
 *
 * Collects namespace existence, ResourceQuota, existing Deployments,
 * and locates the Kustomize/Helm/plain YAML entry point in the target repo.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as k8s from '@kubernetes/client-node';
import { shallowCloneRepo } from './git-clone.js';
import { enrichRepoSignals } from '../../../shared/src/deploy/runtime-detect.js';
import { detectDeployEntryPoint } from '../../../shared/src/deploy/entry-point.js';
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
  const { incidentId, namespace, githubRepo, gitRef = 'main', containerImage, helmRemote } = req;

  log('info', AGENT, 'Starting pre-deploy fact-gathering', {
    incidentId,
    namespace,
    githubRepo,
    gitRef,
    containerImage,
    helmRemote: helmRemote?.chartRef,
  });

  const k8sFacts = await gatherNamespaceFacts(namespace, incidentId);

  const repoFacts = containerImage
    ? {
        needsHelmGeneration: true,
        repoEntryPointKind: 'helm' as const,
        gitManifestPath: undefined,
        gitManifestContent: undefined,
        cloneError: undefined,
        resolvedGitRef: gitRef,
      }
    : helmRemote
      ? {
          needsHelmGeneration: false,
          repoEntryPointKind: 'helm' as const,
          gitManifestPath: undefined,
          gitManifestContent: undefined,
          cloneError: undefined,
          resolvedGitRef: gitRef,
        }
      : await cloneAndLocateEntryPoint(githubRepo ?? '', gitRef, incidentId, req.resourceName);

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
    resolvedGitRef: repoFacts.resolvedGitRef,
    cloneError: repoFacts.cloneError,
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

/** Lightweight probe for commander preflight (namespace create prompt). */
export async function checkNamespaceExists(
  namespace: string,
  incidentId: string
): Promise<{ namespaceExists: boolean }> {
  const ns = await safeCall(incidentId, `readNamespace/${namespace}`, () =>
    coreV1Api.readNamespace(namespace)
  );
  return { namespaceExists: ns !== null };
}

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
type EntryPointKind = 'kustomize' | 'helm' | 'plain-yaml' | 'operator-install' | 'unknown';

interface EntryPointResult {
  gitManifestPath?: string;
  gitManifestContent?: string;
  gitReadmeContent?: string;
  repoEntryPointKind?: EntryPointKind;
  repoSignals?: import('../../../shared/src/types.js').RepoSignals;
  needsHelmGeneration?: boolean;
  resolvedGitRef?: string;
  cloneError?: string;
}

async function readRepoReadme(repoDir: string): Promise<string | undefined> {
  for (const name of ['README.md', 'Readme.md', 'readme.md']) {
    const path = join(repoDir, name);
    if (existsSync(path)) {
      return readFile(path, 'utf-8');
    }
  }
  return undefined;
}

function detectRepoSignals(repoDir: string): import('../../../shared/src/types.js').RepoSignals {
  return enrichRepoSignals(repoDir);
}

async function cloneAndLocateEntryPoint(
  repoUrl: string,
  gitRef: string,
  incidentId: string,
  appHint?: string
): Promise<EntryPointResult> {
  let tmpDir: string | null = null;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), 'sre-predeploy-'));

    const cloned = await shallowCloneRepo(repoUrl, gitRef, tmpDir, incidentId);
    if (!cloned.ok) {
      return {
        cloneError: `Could not clone ${repoUrl} (tried refs: ${cloned.attemptedRefs.join(', ')}): ${cloned.error}`,
        needsHelmGeneration: true,
        repoEntryPointKind: 'unknown',
      };
    }

    const gitReadmeContent = await readRepoReadme(tmpDir);
    const result = await detectEntryPoint(tmpDir, incidentId, appHint);
    const repoSignals = detectRepoSignals(tmpDir);
    if (result.gitManifestPath) {
      result.gitManifestPath = result.gitManifestPath.replace(tmpDir + '/', '');
    }
    return {
      ...result,
      gitReadmeContent,
      repoSignals,
      repoEntryPointKind: result.repoEntryPointKind ?? 'unknown',
      needsHelmGeneration: !result.gitManifestPath,
      resolvedGitRef: cloned.resolvedRef,
    };
  } catch (err) {
    log('error', AGENT, 'Failed to clone deploy target repo', {
      incidentId,
      repoUrl,
      gitRef,
      error: String(err),
    });
    return {
      cloneError: String(err),
      needsHelmGeneration: true,
      repoEntryPointKind: 'unknown',
    };
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
 * Priority: Kustomize → Helm (incl. nested charts) → operator install.yaml → plain YAML.
 * Skips Docker Compose files (compose.yml) at repo root.
 */
async function detectEntryPoint(
  repoDir: string,
  incidentId: string,
  appHint?: string
): Promise<EntryPointResult> {
  const found = detectDeployEntryPoint(repoDir, appHint);
  if (!found) {
    log('warn', AGENT, 'Could not detect K8s entry point in repo', {
      incidentId,
      repoDir,
    });
    return {};
  }

  log('info', AGENT, `Detected ${found.kind} entry point`, { incidentId, path: found.path });
  const kind: EntryPointKind =
    found.kind === 'operator-install' ? 'operator-install' : found.kind;
  return readEntryPoint(found.path, kind, incidentId);
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
